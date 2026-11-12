// La capa GPU del terreno en planta, sobre un doble de GL que anota cada llamada y un mundo de teselas sin red.
// Lo que se fija:
//   · las texturas del mosaico (R32F de alturas, RG32F de pasos por fila) con el centinela en lugar de NaN;
//   · la secuencia del stencil con y sin recorte, con pendiente y con el recorte pendiente;
//   · el dibujo no asigna, con y sin recorte;
//   · dropGl, buildGl y la pérdida de contexto resuben desde las copias de CPU, sin volver a la red;
//   · destroy durante una carga aborta el fetch y no sube nada;
//   · un paneo dentro del margen no recarga, uno que sale de él sí, y la vista general enciende uOverview;
//   · measure es relief() de las mismas teselas, sin fetch de más gracias a la caché; elevationAt es elevation();
//   · un 403 llega a onError y un mosaico sin ningún dato es sin dato.
// Corre con: node --test test/render/terrain-layer.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TerrainLayer, MOSAIC_MAX_SIDE } from '../../src/render/TerrainLayer.js'
import { tablesFromRings } from '../../src/render/PolygonGpuLayer.js'
import { terrainPrograms, NO_DATA } from '../../src/render/terrain-shaders.js'
import { createHeightTileCache } from '../../src/geometry/height-tiles.js'
import { byDefault } from '../../src/geometry/geodesic.js'
import { elevation, relief, terrain } from '../../src/geometry/terrain.js'
import { boundsOf } from '../../src/geometry/bounds.js'
import { projX0 } from '../../src/render/project.js'
import { bytesPorLlamada } from '../../test-helpers/asignaciones.mjs'
import { latDe, lngDe, mundo, terrarium } from '../../test-helpers/terreno.mjs'

/* ── Dobles: un contexto que anota, una cámara con eventos y una superficie que toma y pierde contextos ── */

// Las constantes de GL valen su nombre, y cada método anota [nombre, ...args]. Con `grabar: false` el doble es un
// objeto plano de no-ops: un Proxy asigna en cada acceso, y quien mide asignaciones no puede medir al doble.
const NOOP = () => undefined

const METODOS_PLANOS = ['shaderSource', 'compileShader', 'attachShader', 'linkProgram', 'deleteShader', 'useProgram',
  'uniform1i', 'uniform1f', 'uniform2f', 'uniform2i', 'uniform1fv', 'uniform2fv', 'uniform4fv', 'uniform3fv', 'uniformMatrix4fv',
  'bindTexture', 'texParameteri', 'texImage2D', 'activeTexture', 'bindVertexArray', 'enable', 'disable', 'colorMask',
  'stencilMask', 'stencilFunc', 'stencilOp', 'blendFuncSeparate', 'clearColor', 'clear', 'drawArrays', 'scissor',
  'deleteTexture', 'deleteVertexArray', 'getShaderInfoLog', 'getProgramInfoLog', 'pixelStorei', 'viewport']

const CONSTANTES_PLANAS = ['TEXTURE_2D', 'TEXTURE_MIN_FILTER', 'TEXTURE_MAG_FILTER', 'TEXTURE_WRAP_S', 'TEXTURE_WRAP_T',
  'NEAREST', 'CLAMP_TO_EDGE', 'R32F', 'RG32F', 'RED', 'RG', 'FLOAT', 'TEXTURE0', 'TEXTURE1', 'TRIANGLES', 'COLOR_BUFFER_BIT',
  'STENCIL_BUFFER_BIT', 'STENCIL_TEST', 'SCISSOR_TEST', 'NOTEQUAL', 'ALWAYS', 'KEEP', 'ZERO', 'INVERT', 'BLEND',
  'SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA', 'ONE', 'VERTEX_SHADER', 'FRAGMENT_SHADER', 'COMPILE_STATUS', 'LINK_STATUS',
  'MAX_TEXTURE_SIZE']

const glDoble = ({ grabar = true } = {}) => {
  const calls    = []
  const textures = []
  const returns  = {
    createTexture       : () => { const t = { id: textures.length }; textures.push(t); return t },
    createShader        : () => ({}),
    createProgram       : () => ({}),
    createVertexArray   : () => ({}),
    getShaderParameter  : () => true,
    getProgramParameter : () => true,
    getUniformLocation  : (_p, name) => ({ name }),
    getParameter        : () => 2048,
  }
  const target = {
    calls, textures,
    drawingBufferWidth  : 800,
    drawingBufferHeight : 600,
    isContextLost       : () => false,
  }
  if (!grabar) {
    const plano = { ...target, ...returns }
    METODOS_PLANOS.forEach(name => (plano[name] ??= NOOP))
    CONSTANTES_PLANAS.forEach((name, k) => (plano[name] = k + 1))      // números: `|` sobre strings convierte y asigna
    return Object.assign(plano, { createTexture: returns.createTexture })
  }
  return new Proxy(target, {
    get: (t, p) => {
      if (p in t) return t[p]
      if (typeof p === 'symbol') return undefined
      if (/^[A-Z][A-Z0-9_]*$/.test(p)) return p
      const fn = returns[p]
      return (...args) => {
        calls.push([p, ...args])
        return fn?.(...args)
      }
    },
  })
}

const nombres = (gl, ...names) => gl.calls.filter(c => names.includes(c[0]))
const sube    = (gl, internal) => gl.calls.filter(c => c[0] === 'texImage2D' && c[3] === internal)

// Una cámara de Leaflet reducida a lo que la capa lee. Los objetos que devuelve se reusan: es la forma en que el
// dibujo no asigna.
const camara = ({ zoom, lat, lng, w = 800, h = 600 }) => {
  const estado  = { zoom, lat, lng, w, h }
  const centro  = { lat, lng }
  const tam     = { x: w, y: h }
  const oyentes = new Map()
  return {
    estado,
    zoom   : () => estado.zoom,
    center : () => { centro.lat = estado.lat; centro.lng = estado.lng; return centro },
    size   : () => { tam.x = estado.w; tam.y = estado.h; return tam },
    on     : (types, fn) => {
      const tipos = types.split(' ')
      tipos.forEach(t => (oyentes.get(t) ?? oyentes.set(t, new Set()).get(t)).add(fn))
      return () => tipos.forEach(t => oyentes.get(t).delete(fn))
    },
    fire   : type => oyentes.get(type)?.forEach(fn => fn()),
    oyentes: type => oyentes.get(type)?.size ?? 0,
  }
}

// La ranura de un tramo, reducida: toma el contexto con `open(true)` o `need()`, anota el protocolo y deja perder y
// recuperar contextos como la superficie real.
const superficie = (gls, log) => {
  let siguiente = 0
  const s = {
    gl: null, owner: null, destroyed: false,
    open() { log.push('open'); return null },
    need() { log.push('need'); return !s.gl && !!s.acquire() },
    acquire() {
      s.gl = gls[siguiente++]
      s.owner.buildGl(s.gl)
      return s.gl
    },
    perder() { s.owner.dropGl(); s.gl = null },
    recuperar() { return s.acquire() },
    resetCanvasReference() {},
    begin() { s.cuadros++ },
    end(view) { s.vista = view },
    cuadros: 0,
    setVisible() {},
    destroy() { s.destroyed = true },
    canvas: {},
  }
  return s
}

/* ── El mundo: tesela de 64 px al zoom 14, un punto de la Mercator de los tiles en el centro ── */

const FUENTE = { url: 'https://t.test/{z}/{x}/{y}.png', encoding: 'terrarium', zoom: 14, tileSize: 64 }
const PX     = 4869 * 64 + 20
const PY     = 10007 * 64 + 20
const LAT    = latDe(PY)
const LNG    = lngDe(PX)
const ZOOM   = 17     // un viewport de 800 × 600 px abarca unas 25 × 19 celdas del dem
const COLINA = (lat, lng) => 500 + 4000 * (lat - LAT) + 3000 * (lng - LNG)

const esperar = ms => new Promise(resolve => setTimeout(resolve, ms))

// Una capa sobre el doble, con la carga ya resuelta si `cargada`. `eventos` junta lo que avisó.
const montar = async ({
  config = {}, vista = {}, gls = [glDoble(), glDoble()], world = mundo({ h: COLINA }), cache = createHeightTileCache(),
  esperaCarga = true, model = byDefault,
} = {}) => {
  const log     = []
  const eventos = { load: [], error: [] }
  const cam     = camara({ zoom: ZOOM, lat: LAT, lng: LNG, ...vista })
  const surf    = superficie(gls, log)
  let siguienteCarga
  const nueva   = () => new Promise(resolve => (siguienteCarga = resolve))
  let carga     = nueva()
  const final   = {
    id: 't', dem: FUENTE, hillshade: true, colorBy: 'none', slopeBreaks: [], contours: 0, opacity: 1, fetch: world.fetch,
    onLoad: d => { eventos.load.push(d); siguienteCarga(d) },
    onError: d => { eventos.error.push(d); siguienteCarga(d) },
    ...config,
  }
  const layer = new TerrainLayer({
    host: { camera: cam }, pane: 'gpu', config: final, model, cache,
    surface: opts => { surf.owner = opts.owner; return surf },
  })
  if (esperaCarga) await carga
  return { layer, cam, surf, gls, log, eventos, world, cache, config: final, otraCarga: () => { carga = nueva(); return carga } }
}

const programas = gl => terrainPrograms(gl)

// El centro de un viewport desplazado `k` viewports hacia el este, en grados.
const lngDesplazado = k => LNG + k * (800 / 2 ** ZOOM) / 256 * 360

/* ── La carga y las texturas ── */

test('el primer mosaico sube R32F y RG32F, avisa y toma el contexto', async () => {
  const { layer, surf, gls, log, eventos, world } = await montar()
  assert.equal(log[0], 'open', 'nace vacía: open(false) antes de cualquier dibujo')
  assert.ok(log.includes('need'), 'el primer mosaico avisa con need()')
  assert.equal(surf.gl, gls[0])
  assert.equal(layer.hasContent, true)
  const [h] = sube(gls[0], 'R32F')
  const [r] = sube(gls[0], 'RG32F')
  assert.ok(h && r)
  assert.deepEqual([h[1], h[6], h[7], h[8], h[9]], ['TEXTURE_2D', 0, 'RED', 'FLOAT', h[9]])
  assert.ok(h[9] instanceof Float32Array && h[9].length === h[4] * h[5])
  assert.deepEqual([r[4], r[5], r[7], r[8]], [1, h[5], 'RG', 'FLOAT'])
  assert.equal(r[9].length, 2 * h[5])
  assert.equal(eventos.load.length, 1)
  assert.equal(eventos.load[0].url, FUENTE.url)
  assert.equal(eventos.load[0].count, new Set(world.urls).size, 'count son las teselas servidas')
  assert.ok(eventos.load[0].count > 0)
  assert.ok(nombres(gls[0], 'drawArrays').length > 0, 'pinta al llegar')
  layer.destroy()
})

test('el NaN de la grilla sube como el centinela, en una copia', async () => {
  const sinDato = mundo({ pixel: (x, y) => (x < 8 ? [0, 0, 0, 0] : [...terrarium(500 + y), 255]) })
  const { layer, gls } = await montar({ world: sinDato })
  const [h] = sube(gls[0], 'R32F')
  const data = h[9]
  assert.ok(!data.some(Number.isNaN))
  assert.ok(data.some(v => v === NO_DATA), 'las celdas sin dato valen NO_DATA')
  assert.ok(data.some(v => v > 0), 'y las demás conservan su altura')
  layer.destroy()
})

test('los pasos de Horn de cada fila suben en float32 con ew y ns de la grilla', async () => {
  const { layer, gls } = await montar()
  const [h] = sube(gls[0], 'R32F')
  const [r] = sube(gls[0], 'RG32F')
  for (let j = 0; j < h[5]; j++) assert.ok(r[9][2 * j] > 0 && r[9][2 * j + 1] > 0)
  layer.destroy()
})

/* ── El stencil, el recorte y la pendiente ── */

const CUADRO = [[LAT - 0.0002, LNG - 0.0002], [LAT - 0.0002, LNG + 0.0002], [LAT + 0.0002, LNG + 0.0002], [LAT + 0.0002, LNG - 0.0002], [LAT - 0.0002, LNG - 0.0002]]
const tablas = () => tablesFromRings([CUADRO], ring => ring)

const sinStencil = gl => nombres(gl, 'stencilFunc', 'stencilOp').length === 0
  && !gl.calls.some(c => c[0] === 'enable' && c[1] === 'STENCIL_TEST')

test('sin recorte, el color no toca el stencil', async () => {
  const { layer, gls } = await montar({ config: { hillshade: false, colorBy: 'elevation' } })
  gls[0].calls.length = 0
  layer.refresh()
  assert.ok(sinStencil(gls[0]))
  assert.equal(nombres(gls[0], 'drawArrays').length, 1)
  layer.destroy()
})

test('con recorte, la paridad va primero y el color cae con NOTEQUAL/ZERO y deja todo en neutro', async () => {
  const { layer, gls } = await montar({ config: { hillshade: false, colorBy: 'elevation' } })
  layer.setClip(tablas())
  gls[0].calls.length = 0
  layer.refresh()
  const seq = gls[0].calls.map(c => c[0])
  const parity = seq.indexOf('drawArrays')
  const cover  = seq.lastIndexOf('drawArrays')
  assert.ok(cover > parity, 'la paridad del polígono se marca antes del color')
  const func = nombres(gls[0], 'stencilFunc').at(-1)
  const op   = nombres(gls[0], 'stencilOp').at(-1)
  assert.deepEqual(func.slice(1), ['NOTEQUAL', 0, 1])
  assert.deepEqual(op.slice(1), ['KEEP', 'KEEP', 'ZERO'])
  assert.ok(gls[0].calls.indexOf(func) < cover && gls[0].calls.indexOf(op) < cover)
  assert.deepEqual(gls[0].calls[cover].slice(1), ['TRIANGLES', 0, 6])
  const final = gls[0].calls.slice(cover + 1).map(c => c.join(','))
  assert.ok(final.includes('disable,STENCIL_TEST') && final.includes('disable,SCISSOR_TEST') && final.includes('stencilMask,255'))
  layer.destroy()
})

test('con pendiente, el programa de color corre en modo 2 con los cortes y los colores', async () => {
  const { layer, gls } = await montar({
    config: { hillshade: false, colorBy: 'slope', slopeBreaks: [0.15, 0.3], slopeColors: ['#00ff00', 'rgb(255, 255, 0)', '#ff0000'] },
  })
  gls[0].calls.length = 0
  layer.refresh()
  const uni = name => gls[0].calls.filter(c => c[1]?.name === name)
  assert.equal(uni('uMode').at(-1)[2], 2)
  assert.equal(uni('uBreakCount').at(-1)[2], 2)
  assert.deepEqual([...uni('uBreaks').at(-1)[2].slice(0, 3)].map(v => +v.toFixed(2)), [0.15, 0.3, 0])
  assert.deepEqual([...uni('uColors').at(-1)[2].slice(0, 12)], [0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 0, 1])
  assert.equal(uni('uColorCount').at(-1)[2], 3)
  layer.destroy()
})

test('sin cortes ni colores usa la rampa continua por defecto', async () => {
  const { layer, gls } = await montar({ config: { hillshade: false, colorBy: 'slope' } })
  gls[0].calls.length = 0
  layer.refresh()
  const uni = name => gls[0].calls.filter(c => c[1]?.name === name)
  assert.equal(uni('uBreakCount').at(-1)[2], 0)
  assert.equal(uni('uColorCount').at(-1)[2], 3)
  layer.destroy()
})

test('el recorte pendiente no dibuja color ni curvas y sí el sombreado', async () => {
  const { layer, gls } = await montar({ config: { hillshade: true, colorBy: 'elevation', contours: 10 } })
  const { hillshade, color } = programas(gls[0])
  gls[0].calls.length = 0
  layer.refresh()
  const usados = () => nombres(gls[0], 'useProgram').map(c => c[1])
  assert.ok(usados().includes(hillshade.program) && usados().includes(color.program), 'sin recorte dibuja los dos')

  layer.setClip('pending')
  gls[0].calls.length = 0
  layer.refresh()
  assert.ok(usados().includes(hillshade.program))
  assert.ok(!usados().includes(color.program))
  assert.ok(sinStencil(gls[0]))

  layer.setClip(null)
  gls[0].calls.length = 0
  layer.refresh()
  assert.ok(usados().includes(color.program), 'sin recorte vuelve el color')
  layer.destroy()
})

test('con el polígono fuera del viewport no hay nada que cubrir', async () => {
  const { layer, gls } = await montar({ config: { hillshade: false, colorBy: 'elevation' } })
  layer.setClip(tablesFromRings([CUADRO.map(([lat, lng]) => [lat + 5, lng])], ring => ring))
  gls[0].calls.length = 0
  assert.equal(layer.redraw(), false)
  assert.equal(nombres(gls[0], 'drawArrays').length, 0)
  layer.destroy()
})

/* ── Rendimiento ── */

test('redraw no asigna, con y sin recorte', async () => {
  const quieto = glDoble({ grabar: false })
  const { layer } = await montar({ gls: [quieto], config: { hillshade: true, colorBy: 'slope', contours: 20 } })
  // Tanda larga y calentamiento largo, como el resto de las pruebas de [0-alloc]: con el código frío V8 boxea.
  const medir = () => bytesPorLlamada(() => layer.redraw(), 20_000, { calentar: 100_000 })
  const b0 = medir(); assert.ok(b0 < 1, `sin recorte: ${b0}`)
  layer.setClip(tablas())
  const b1 = medir(); assert.ok(b1 < 1, `con recorte: ${b1}`)
  layer.destroy()
})

/* ── El ciclo del contexto ── */

test('dropGl, buildGl y una pérdida de contexto resuben desde la copia de CPU, sin red', async () => {
  const { layer, surf, gls, world } = await montar({ config: { hillshade: false, colorBy: 'elevation' } })
  layer.setClip(tablas())
  const pedidos = world.urls.length
  surf.perder()
  assert.equal(layer.redraw(), false, 'sin contexto no dibuja')
  surf.recuperar()
  assert.equal(surf.gl, gls[1])
  assert.equal(sube(gls[1], 'R32F').length, 1)
  assert.equal(sube(gls[1], 'RG32F').length, 2, 'los pasos por fila y el store del recorte')
  assert.equal(world.urls.length, pedidos, 'no vuelve a la red')
  assert.deepEqual(sube(gls[1], 'R32F')[0][9], sube(gls[0], 'R32F')[0][9])
  assert.ok(nombres(gls[1], 'drawArrays').length > 0, 'pinta en el acto, recorte incluido')
  assert.ok(nombres(gls[1], 'stencilFunc').some(c => c[1] === 'NOTEQUAL'))
  layer.destroy()
})

test('un mosaico que llega sin contexto lo pide con need(), y buildGl lo sube y lo pinta', async () => {
  const { layer, gls, surf, log, cam, otraCarga } = await montar()
  surf.perder()
  const carga = otraCarga()
  cam.estado.lng = lngDesplazado(3)
  cam.fire('moveend')
  await carga
  assert.equal(log.filter(x => x === 'need').length, 2)
  assert.equal(surf.gl, gls[1])
  assert.equal(sube(gls[1], 'R32F').length, 1)
  assert.ok(nombres(gls[1], 'drawArrays').length > 0)
  assert.equal(layer.configure({ ...{ dem: FUENTE, fetch: () => {} }, opacity: 0.5 }), true, 'con contexto, configure repinta')
  layer.destroy()
})

test('destroy durante una carga aborta el fetch y no sube nada', async () => {
  let senal
  const colgado = (url, { signal }) => {
    senal = signal
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  const gls = [glDoble()]
  const { layer, eventos } = await montar({ esperaCarga: false, gls, config: { fetch: colgado } })
  await esperar(30)
  assert.ok(senal, 'la carga pidió su primera tesela')
  assert.equal(senal.aborted, false)
  layer.destroy()
  assert.equal(senal.aborted, true)
  await esperar(30)
  assert.equal(sube(gls[0], 'R32F').length, 0)
  assert.deepEqual([eventos.load.length, eventos.error.length], [0, 0])
})

test('destroy es seguro a medio construir y repetido', async () => {
  const camaraRota = camara({ zoom: ZOOM, lat: LAT, lng: LNG })
  const surf = superficie([glDoble()], [])
  surf.open = () => { throw new Error('sin contexto') }
  assert.throws(() => new TerrainLayer({
    host: { camera: camaraRota }, pane: 'gpu', model: byDefault,
    config: { dem: FUENTE }, surface: opts => { surf.owner = opts.owner; return surf },
  }), /sin contexto/)
  assert.equal(surf.destroyed, true)
  assert.equal(camaraRota.oyentes('moveend'), 0)

  const { layer } = await montar()
  layer.destroy()
  layer.destroy()
  assert.equal(layer.elevationAt([LAT, LNG]), NaN)
  await assert.rejects(layer.measure(CUADRO), { name: 'AbortError' })
})

test('una configuración sin dem lanza antes de tocar la superficie', () => {
  const surf = superficie([glDoble()], [])
  assert.throws(() => new TerrainLayer({
    host: { camera: camara({ zoom: ZOOM, lat: LAT, lng: LNG }) }, pane: 'gpu', model: byDefault, config: {},
    surface: () => surf,
  }), TypeError)
})

/* ── El mosaico: margen, recarga y vista general ── */

test('un paneo dentro del margen no recarga, y uno que sale de él sí', async () => {
  const { layer, cam, world, otraCarga } = await montar()
  const pedidos = world.urls.length

  cam.estado.lng = lngDesplazado(0.3)
  cam.fire('moveend')
  await esperar(40)
  assert.equal(world.urls.length, pedidos, 'medio viewport de margen: 0,3 no recarga')

  const carga = otraCarga()
  cam.estado.lng = lngDesplazado(1.6)
  cam.fire('moveend')
  const { count } = await carga
  assert.ok(world.urls.length > pedidos, 'fuera del margen pide teselas nuevas')
  assert.ok(count > 0)
  layer.destroy()
})

test('mientras llega el mosaico nuevo, el anterior sigue pintado', async () => {
  const { layer, cam, gls } = await montar()
  const texturas = gls[0].textures.length
  cam.estado.lng = lngDesplazado(3)
  cam.fire('moveend')
  gls[0].calls.length = 0
  assert.equal(layer.redraw(), true, 'sigue dibujando la imagen vieja')
  assert.ok(gls[0].textures.length === texturas)
  layer.destroy()
})

test('la vista que no entra al tope cambia al mayor zoom menor que entre y enciende uOverview', async () => {
  const lado = mundo({ h: COLINA, lado: 256 })
  const demGrande = { ...FUENTE, tileSize: 256, zoom: 12 }
  const { layer, gls, world } = await montar({
    world: lado, vista: { zoom: 9, w: 300, h: 200 }, config: { dem: demGrande, hillshade: false, colorBy: 'elevation', contours: 10 },
  })
  const zooms = new Set(world.urls.map(u => +u.match(/\/(\d+)\/\d+\/\d+/)[1]))
  assert.deepEqual([...zooms], [11], 'el mayor zoom menor que el del dem que entra')
  const [h] = sube(gls[0], 'R32F')
  assert.ok(h[4] <= MOSAIC_MAX_SIDE && h[5] <= MOSAIC_MAX_SIDE)
  gls[0].calls.length = 0
  layer.refresh()
  const overview = gls[0].calls.filter(c => c[1]?.name === 'uOverview')
  assert.equal(overview.at(-1)[2], 1)
  layer.destroy()
}, { timeout: 60_000 })

test('con el viewport dentro del tope, uOverview queda apagado y se pide el zoom del dem', async () => {
  const { layer, gls, world } = await montar({ config: { hillshade: false, colorBy: 'slope' } })
  assert.ok(world.urls.every(u => u.includes('/14/')))
  gls[0].calls.length = 0
  layer.refresh()
  assert.equal(gls[0].calls.filter(c => c[1]?.name === 'uOverview').at(-1)[2], 0)
  layer.destroy()
})

test('el rango de altura se calcula al asentar y queda fijo si se declara', async () => {
  const auto = await montar({ config: { hillshade: false, colorBy: 'elevation' } })
  auto.gls[0].calls.length = 0
  auto.layer.refresh()
  const [lo, hi] = auto.gls[0].calls.filter(c => c[1]?.name === 'uRange').at(-1)[2]
  assert.ok(lo < hi && lo > 400 && hi < 600, `rango ${lo}..${hi} del viewport`)
  auto.layer.destroy()

  const fijo = await montar({ config: { hillshade: false, colorBy: 'elevation', elevationRange: [200, 600] } })
  fijo.gls[0].calls.length = 0
  fijo.layer.refresh()
  assert.deepEqual([...fijo.gls[0].calls.filter(c => c[1]?.name === 'uRange').at(-1)[2]], [200, 600])
  fijo.layer.destroy()
})

/* ── Medida y altura ── */

const ZONA = [[LAT - 0.0001, LNG - 0.0001], [LAT - 0.0001, LNG + 0.0001], [LAT + 0.0001, LNG + 0.0001], [LAT + 0.0001, LNG - 0.0001]]

test('measure es relief() de las mismas teselas, sin fetch de más gracias a la caché', async () => {
  const cortes = [0.1, 0.3]
  const { layer, world } = await montar({ config: { slopeBreaks: cortes } })
  const pedidos = world.urls.length
  const medido  = await layer.measure(ZONA)
  assert.equal(world.urls.length, pedidos, 'las teselas del viewport ya estaban en la caché')

  const solo = mundo({ h: COLINA })
  const base = await terrain(byDefault, FUENTE, boundsOf(ZONA), { fetch: solo.fetch })
  assert.deepEqual(medido, relief(base, ZONA, cortes))
  assert.ok(medido.cells > 0)
  layer.destroy()
})

test('measure lee un multipolígono y rechaza una zona sin vértices', async () => {
  const { layer } = await montar()
  const multi  = [[ZONA], [ZONA.map(([lat, lng]) => [lat, lng + 0.0001])]]
  assert.ok((await layer.measure(multi)).cells > 0)
  await assert.rejects(layer.measure([]), TypeError)
  layer.destroy()
})

test('destroy aborta las medidas pendientes con AbortError, y una señal abortada rechaza', async () => {
  const { layer } = await montar()
  const lejos = ZONA.map(([lat, lng]) => [lat + 0.05, lng])
  const medida = layer.measure(lejos)
  layer.destroy()
  await assert.rejects(medida, { name: 'AbortError' })

  const otra = await montar()
  const control = new AbortController()
  const pendiente = otra.layer.measure(lejos, { signal: control.signal })
  control.abort(new DOMException('cancelada', 'AbortError'))
  await assert.rejects(pendiente, { name: 'AbortError' })
  otra.layer.destroy()
})

test('elevationAt es elevation() del mosaico vigente, y NaN sin mosaico o fuera de él', async () => {
  const sinCargar = await montar({ esperaCarga: false })
  assert.equal(sinCargar.layer.elevationAt([LAT, LNG]), NaN)
  sinCargar.layer.destroy()

  const { layer } = await montar()
  const punto = [LAT + 0.00005, LNG - 0.00003]
  const base  = await terrain(byDefault, FUENTE, boundsOf(ZONA), { fetch: mundo({ h: COLINA }).fetch })
  assert.ok(Number.isFinite(layer.elevationAt(punto)))
  assert.equal(layer.elevationAt(punto), elevation(base, punto))
  assert.equal(layer.elevationAt({ lat: LAT, lng: LNG }), layer.elevationAt([LAT, LNG]))
  assert.equal(layer.elevationAt([LAT + 5, LNG]), NaN)
  assert.equal(layer.elevationAt('no'), NaN)
  layer.destroy()
})

/* ── Eventos ── */

test('un 403 llega a onError con su url y su status, y no es sin dato', async () => {
  const todas = new Proxy({}, { get: () => 403, has: () => true })
  const { layer, eventos, gls } = await montar({ world: mundo({ estados: todas }) })
  assert.equal(eventos.load.length, 0)
  assert.equal(eventos.error.length, 1)
  const [e] = eventos.error
  assert.deepEqual([e.code, e.status], ['forbidden', 403])
  assert.match(e.url, /^https:\/\/t\.test\/14\/\d+\/\d+\.png$/)
  assert.match(e.message, /403/)
  assert.equal(layer.hasContent, false)
  assert.equal(sube(gls[0], 'R32F').length, 0)
  layer.destroy()
})

test('un 401 se distingue del 403 y un 500 es http', async () => {
  const con = status => montar({ world: mundo({ estados: new Proxy({}, { get: () => status, has: () => true }) }) })
  const a = await con(401)
  const b = await con(500)
  assert.equal(a.eventos.error[0].code, 'unauthorized')
  assert.equal(b.eventos.error[0].code, 'http')
  a.layer.destroy()
  b.layer.destroy()
})

test('un mosaico donde ninguna tesela tiene datos (404) es sin dato: carga vacío con count 0', async () => {
  const { layer, eventos } = await montar({ world: mundo({ estados: new Proxy({}, { get: () => 404, has: () => true }) }) })
  assert.deepEqual(eventos.error, [])
  assert.deepEqual(eventos.load, [{ url: FUENTE.url, count: 0 }])
  assert.equal(layer.hasContent, false)
  layer.destroy()
})

test('un mosaico fallido se reintenta en la próxima vista asentada', async () => {
  let falla = true
  const world = mundo({ h: COLINA })
  const fetch = function (url, init) { return falla ? Promise.reject(new Error('sin red')) : world.fetch.call(this, url, init) }
  const { layer, cam, eventos, otraCarga } = await montar({ config: { fetch } })
  assert.equal(eventos.error[0].code, 'network')
  falla = false
  const carga = otraCarga()
  cam.fire('moveend')
  assert.deepEqual(Object.keys(await carga), ['url', 'count'])
  assert.equal(layer.hasContent, true)
  layer.destroy()
})

test('un callback que lanza no rompe la carga ni el estado de la capa', async () => {
  const errores = []
  const previo  = process.listeners('uncaughtException')
  process.removeAllListeners('uncaughtException')
  process.on('uncaughtException', e => errores.push(e))
  try {
    const { layer } = await montar({ config: { onLoad() { throw new Error('del consumidor') } }, esperaCarga: false })
    await esperar(150)
    assert.equal(layer.hasContent, true)
    assert.equal(errores[0]?.message, 'del consumidor')
    layer.destroy()
  } finally {
    process.removeAllListeners('uncaughtException')
    previo.forEach(fn => process.on('uncaughtException', fn))
  }
})

/* ── Configuración en vivo ── */

test('configure con otro estilo repinta sin recargar, y con otro dem pide el mosaico y conserva el anterior', async () => {
  const { layer, world, gls, otraCarga, config } = await montar()
  const pedidos = world.urls.length
  layer.configure({ ...config, hillshade: false, colorBy: 'elevation', opacity: 0.4 })
  await esperar(30)
  assert.equal(world.urls.length, pedidos, 'el estilo no recarga')
  const opacidades = gls[0].calls.filter(c => c[1]?.name === 'uOpacity')
  assert.deepEqual([...opacidades.at(-1)[2]], [Math.fround(0.4)])

  const carga = otraCarga()
  layer.configure({ ...config, dem: { ...FUENTE, url: 'https://otro.test/{z}/{x}/{y}.png' }, colorBy: 'elevation' })
  assert.equal(layer.hasContent, true, 'el mosaico viejo sigue hasta que llegue el nuevo')
  await carga
  assert.ok(world.urls.some(u => u.startsWith('https://otro.test/')))
  layer.destroy()
})

test('configure inválido lanza sin cambiar nada', async () => {
  const { layer, gls } = await montar()
  gls[0].calls.length = 0
  assert.throws(() => layer.configure({ dem: FUENTE, slopeBreaks: Array.from({ length: 16 }, (_, k) => k / 20) }), RangeError)
  assert.throws(() => layer.configure({}), TypeError)
  assert.equal(gls[0].calls.length, 0)
  layer.destroy()
})

test('oculta no carga ni dibuja, y al mostrarla pide el mosaico que falte y pinta', async () => {
  const { layer, cam, world, surf, otraCarga } = await montar()
  layer.setVisible(false)
  const pedidos = world.urls.length
  cam.estado.lng = lngDesplazado(4)
  cam.fire('moveend')
  await esperar(40)
  assert.equal(world.urls.length, pedidos, 'oculta no pide red')
  assert.equal(layer.redraw(), false)
  const carga = otraCarga()
  layer.setVisible(true)
  await carga
  assert.ok(world.urls.length > pedidos)
  assert.ok(surf.vista)
  layer.destroy()
})

test('la vista que se anima repinta por cuadro sin recargar', async () => {
  const { layer, cam, gls, world } = await montar()
  const pedidos = world.urls.length
  gls[0].calls.length = 0
  cam.fire('zoomframe')
  assert.ok(nombres(gls[0], 'drawArrays').length > 0)
  assert.equal(world.urls.length, pedidos)
  assert.equal(cam.oyentes('zoomframe'), 1)
  layer.destroy()
  assert.deepEqual(['moveend', 'zoomend', 'resize', 'zoomframe'].map(t => cam.oyentes(t)), [0, 0, 0, 0])
})

test('el ancla del mosaico es la esquina de su primera celda dibujada y la matriz es la del cuadro', async () => {
  const { layer, gls, cam } = await montar({ config: { hillshade: true } })
  gls[0].calls.length = 0
  layer.refresh()
  const matriz = gls[0].calls.find(c => c[0] === 'uniformMatrix4fv' && c[1]?.name === 'uMatrix')
  assert.equal(matriz[2], false)
  const m = matriz[3]
  const sx = 2 * 2 ** cam.estado.zoom / cam.estado.w
  assert.ok(Math.abs(m[0] - sx) < 1e-6 * sx)
  const tam = gls[0].calls.find(c => c[0] === 'uniform2fv' && c[1]?.name === 'uSize')
  assert.ok(tam[2][0] > 0 && tam[2][1] > 0)
  assert.ok(projX0(LNG) > 0)
  layer.destroy()
})
