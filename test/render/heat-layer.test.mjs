// Contrato de HeatLayer, la capa GPU del calor como miembro de tramo, sobre un doble de GL que anota cada llamada y una
// superficie falsa con `begin`/`end`. Lo que se fija:
//   · el orden de las pasadas: el FBO de acumulación antes del splat, `begin` antes de la rampa y `end` con la vista;
//   · las instancias son los puntos válidos, con el peso normalizado por el máximo;
//   · `intensity` sólo cambia el uniforme; un paneo corto no re-ancla y uno lejano a zoom alto sí;
//   · la paleta se muestrea 256 veces al construir, en `colorRamp=` y en `refresh`, y una rampa que lanza no deja el pane;
//   · radius/blur negativos valen 0 y R = 0 no emite splat;
//   · oculta no dibuja; `zoomstart` pinta vacío; `destroy` cancela el rAF;
//   · `dropGl` + `buildGl` resube desde el espejo; sin extensiones usa RGBA8 con `over`; suelta, la rampa va al framebuffer
//     por defecto; y `redraw()` con la cámara sola no asigna.
//   · la agregación: por debajo de AGGREGATE_MIN_POINTS la capa hace las mismas llamadas GL que en ef39ddd, llamada por llamada
//     (test/fixtures/calor-llamadas-ef39ddd.json); desde el umbral dibuja celdas con su programa; las celdas se rehacen sólo
//     con un flush, un move, un cambio de nivel entero, de tamaño de celda, de `intensity` o un `refresh`, y nunca en un
//     paneo, oculta ni en pleno zoom animado; y el redibujo con celdas no asigna.
// Corre con: node --test test/render/heat-layer.test.mjs
//
// El registro de ef39ddd se regenera, sólo si cambia a propósito el camino sin agregar, con el src de esa versión:
//   git archive ef39ddd src | tar x -C <dir> && CALOR_GRABAR=<dir>/src/render/HeatLayer.js node --test test/render/heat-layer.test.mjs
import { makeMap } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { HeatLayer } from '../../src/render/HeatLayer.js'
import { GRAD_STEPS } from '../../src/render/heat-math.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { createSource } from '../../src/data/Source.js'
import { bytesPorLlamada } from '../../test-helpers/asignaciones.mjs'
import { HeatCells, AGGREGATE_MIN_POINTS, CELL_FLOATS, CELL_PX, CELL_PER_RADIUS } from '../../src/render/heat-cells.js'
import { readFileSync, writeFileSync } from 'node:fs'

/* ── Dobles: un contexto que anota, una cámara con eventos y una superficie que toma contextos ── */

const NOOP = () => undefined

const METODOS = ['getExtension', 'getParameter', 'checkFramebufferStatus', 'getProgramParameter', 'getProgramInfoLog',
  'getUniformLocation', 'createProgram', 'createShader', 'createBuffer', 'createVertexArray', 'createFramebuffer',
  'createTexture', 'shaderSource', 'compileShader', 'attachShader', 'linkProgram', 'deleteShader', 'useProgram', 'uniform1i',
  'uniform1f', 'uniform1fv', 'uniform2fv', 'uniformMatrix4fv', 'bindVertexArray', 'bindBuffer', 'bufferData',
  'enableVertexAttribArray', 'vertexAttribPointer', 'vertexAttribDivisor', 'bindTexture', 'texParameteri', 'texImage2D',
  'texSubImage2D', 'activeTexture', 'bindFramebuffer', 'framebufferTexture2D', 'deleteFramebuffer', 'deleteTexture',
  'deleteBuffer', 'deleteVertexArray', 'viewport', 'enable', 'disable', 'colorMask', 'clearColor', 'clear', 'blendFunc',
  'blendFuncSeparate', 'drawArrays', 'drawArraysInstanced']

const CONSTANTES = ['ARRAY_BUFFER', 'DYNAMIC_DRAW', 'FLOAT', 'TEXTURE_2D', 'TEXTURE_MIN_FILTER', 'TEXTURE_MAG_FILTER',
  'TEXTURE_WRAP_S', 'TEXTURE_WRAP_T', 'NEAREST', 'CLAMP_TO_EDGE', 'TEXTURE0', 'TEXTURE1', 'FRAMEBUFFER', 'COLOR_ATTACHMENT0',
  'FRAMEBUFFER_COMPLETE', 'FRAMEBUFFER_BINDING', 'TEXTURE_BINDING_2D', 'R16F', 'RGBA8', 'RED', 'RGBA', 'HALF_FLOAT',
  'UNSIGNED_BYTE', 'ONE', 'ZERO', 'ONE_MINUS_SRC_ALPHA', 'SRC_ALPHA', 'BLEND', 'DEPTH_TEST', 'STENCIL_TEST', 'SCISSOR_TEST',
  'CULL_FACE', 'COLOR_BUFFER_BIT', 'TRIANGLE_STRIP', 'TRIANGLES', 'VERTEX_SHADER', 'FRAGMENT_SHADER', 'LINK_STATUS']

// Con `grabar` cada método anota [nombre, ...args] y las constantes valen su nombre; sin él es un objeto plano de no-ops
// con constantes numéricas, porque un rest o un acceso de Proxy asigna y quien mide asignaciones no puede medir al doble.
const glDoble = ({ grabar = true, ext = true, calls = [] } = {}) => {
  let ids = 0
  const gl = {
    calls,
    drawingBufferWidth  : 800,
    drawingBufferHeight : 600,
    isContextLost       : () => false,
  }
  CONSTANTES.forEach((name, k) => (gl[name] = grabar ? name : k + 1))
  const devuelve = {
    getExtension           : name => (ext && name === 'EXT_color_buffer_float' ? {} : null),
    checkFramebufferStatus : () => gl.FRAMEBUFFER_COMPLETE,
    getParameter           : () => null,
    getProgramParameter    : () => true,
    getProgramInfoLog      : () => '',
    getUniformLocation     : (_p, name) => ({ name }),
    createProgram          : () => ({}),
    createShader           : () => ({}),
    createBuffer           : () => ({ id: ids++ }),
    createVertexArray      : () => ({ id: ids++ }),
    createFramebuffer      : () => ({ id: ids++ }),
    createTexture          : () => ({ id: ids++ }),
  }
  METODOS.forEach(name => {
    const fn = devuelve[name] ?? NOOP
    gl[name] = grabar ? (...args) => (calls.push([name, ...args]), fn(...args)) : fn
  })
  return gl
}

const llamadas = (calls, ...names) => calls.filter(c => names.includes(c[0]))
const indice   = (calls, name, desde = 0) => calls.findIndex((c, i) => i >= desde && c[0] === name)

// Una cámara reducida a lo que la capa lee. Los objetos que devuelve se reusan: así el dibujo no asigna.
const camara = ({ zoom = 3, lat = 0, lng = 0, w = 800, h = 600 } = {}) => {
  const estado  = { zoom, lat, lng, w, h }
  const centro  = { lat, lng }
  const tam     = { x: w, y: h }
  const oyentes = new Map()
  return {
    estado,
    hasView : () => true,
    zoom    : () => estado.zoom,
    center  : () => { centro.lat = estado.lat; centro.lng = estado.lng; return centro },
    size    : () => { tam.x = estado.w; tam.y = estado.h; return tam },
    on      : (types, fn) => {
      const tipos = types.split(' ')
      tipos.forEach(t => (oyentes.get(t) ?? oyentes.set(t, new Set()).get(t)).add(fn))
      return () => tipos.forEach(t => oyentes.get(t).delete(fn))
    },
    fire    : type => oyentes.get(type)?.forEach(fn => fn()),
    oyentes : type => oyentes.get(type)?.size ?? 0,
  }
}

// La ranura de un tramo, reducida: toma el contexto con `open(true)` o `need()` y anota el protocolo en el mismo registro
// que el contexto. `enTramo` hace que `begin()` devuelva un destino, como la ranura real; sin él, como una superficie propia.
// El destino que enlaza `begin` en un tramo: uno solo, porque un objeto nuevo por llamada asignaría.
const DESTINO = {}

const superficie = (gls, calls, { enTramo = true } = {}) => {
  let siguiente = 0
  const s = {
    gl: null, owner: null, destroyed: false, vistas: [], visible: [],
    open(contenido) { calls.push(['SURFACE_OPEN', contenido]); return contenido ? s.acquire() : null },
    need() { calls.push(['SURFACE_NEED']); return !s.gl && !!s.acquire() },
    acquire() {
      s.gl = gls[siguiente++]
      s.owner.buildGl(s.gl)
      return s.gl
    },
    perder() { s.owner.dropGl(); s.gl = null },
    recuperar() { return s.acquire() },
    resetCanvasReference() {},
    begin() { calls.push(['SURFACE_BEGIN']); return enTramo ? DESTINO : undefined },
    end(view) { calls.push(['SURFACE_END', view.zoom, view.center.x, view.center.y]); s.vistas.push(view.zoom) },
    setVisible(v) { s.visible.push(v) },
    destroy() { calls.push(['SURFACE_DESTROY']); s.destroyed = true },
    canvas: {},
  }
  return s
}

const idOf       = it => it.id
const positionOf = it => it.pos
const weightOf   = it => it.w

const puntos = [
  { id: 1, pos: { lat: 1, lng: 1 }, w: 1 },
  { id: 2, pos: { lat: 2, lng: 3 }, w: 5 },
  { id: 3, pos: { lat: 1.5, lng: 4 }, w: 3 },
]

const montar = (items, { opts = {}, accessors = { idOf, positionOf, weightOf }, vista = {}, ext = true, enTramo = true, cam = camara(vista),
  gls = [glDoble({ ext })], Clase = HeatLayer } = {}) => {
  const calls  = gls[0].calls
  const source = createSource(accessors)
  source.set(items)
  const surf = superficie(gls, calls, { enTramo })
  let altas  = 0
  const layer = new Clase({
    host: { camera: cam }, pane: 'heat', source, ...opts,
    surface: o => { altas++; surf.owner = o.owner; return surf },
  })
  return { layer, source, cam, surf, gls, gl: gls[0], calls, altas: () => altas }
}

// Un rAF que anota en vez de correr: los redibujos coalescidos se disparan a mano.
const conRaf = fn => {
  const cola       = []
  const canceladas = []
  let id           = 0
  const orig      = [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame]
  globalThis.requestAnimationFrame = cb => { cola.push(cb); return ++id }
  globalThis.cancelAnimationFrame  = id => canceladas.push(id)
  const correr = () => cola.splice(0).forEach(cb => cb(0))
  const restaurar = () => { ;[globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = orig }
  let resultado
  try {
    resultado = fn({ cola, canceladas, correr })
  } catch (e) {
    restaurar()
    throw e
  }
  if (!resultado?.then) {
    restaurar()
    return resultado
  }
  return resultado.finally(restaurar)    // una prueba async conserva el rAF falso hasta terminar
}

/* ── Las pasadas ── */

test('el FBO de acumulación se enlaza antes del splat, y begin viene antes de la rampa, con end(view) al final', () => {
  const { layer, calls } = montar(puntos)
  calls.length = 0
  layer.redraw()
  const iFbo  = indice(calls, 'bindFramebuffer')
  const iSplat = indice(calls, 'drawArraysInstanced')
  const iBegin = indice(calls, 'SURFACE_BEGIN')
  const iRampa = indice(calls, 'drawArrays')
  const iEnd   = indice(calls, 'SURFACE_END')
  assert.ok(iFbo >= 0 && iFbo < iSplat, 'el FBO de acumulación va antes del splat')
  assert.ok(iSplat < iBegin, 'la ranura se enlaza después de acumular')
  assert.ok(iBegin < iRampa && iRampa < iEnd, 'la rampa va entre begin y end')
  assert.deepEqual(calls[iRampa].slice(1), ['TRIANGLES', 0, 3])
  assert.equal(calls[iEnd][1], 3, 'end recibe la vista con que pintó')
  assert.equal(llamadas(calls, 'SURFACE_BEGIN').length, 1)
  assert.equal(llamadas(calls, 'SURFACE_END').length, 1)
  layer.destroy()
})

test('las instancias son los puntos válidos, con el peso normalizado por el máximo', () => {
  const items = [...puntos, { id: 4, pos: { lat: NaN, lng: 0 }, w: 9 }, { id: 5, pos: null, w: 2 }, { id: 6, pos: { lat: 1, lng: Infinity }, w: 1 }]
  const { layer, calls } = montar(items)
  const [datos] = llamadas(calls, 'bufferData').map(c => c[2])
  const [draw]  = llamadas(calls, 'drawArraysInstanced')
  assert.equal(draw[4], 3, 'sólo los 3 puntos finitos')
  assert.equal(datos.length, 9)
  assert.deepEqual([datos[2], datos[5], datos[8]].map(v => +v.toFixed(4)), [0.1111, 0.5556, 0.3333], 'peso / máximo del snapshot (9)')
  layer.destroy()
})

test('sin weightOf el peso es 1 por punto', () => {
  const { layer, calls } = montar(puntos, { accessors: { idOf, positionOf } })
  const [datos] = llamadas(calls, 'bufferData').map(c => c[2])
  assert.deepEqual([datos[2], datos[5], datos[8]], [1, 1, 1])
  layer.destroy()
})

test('intensity cambia sólo el uniforme: no resube el búfer', () => conRaf(({ correr }) => {
  const { layer, calls } = montar(puntos)
  const subidas = llamadas(calls, 'bufferData').length
  calls.length  = 0
  layer.intensity = 3
  correr()
  assert.equal(llamadas(calls, 'bufferData').length, 0)
  assert.equal(subidas, 1)
  const u = llamadas(calls, 'uniform1fv').find(c => c[1].name === 'uIntensity')
  assert.deepEqual(Array.from(u[2]), [3])
  layer.destroy()
}))

test('un paneo corto no re-ancla y uno lejano a zoom alto sí', () => {
  let lecturas = 0
  const { layer, cam, calls } = montar(puntos, { vista: { zoom: 22 }, accessors: { idOf, positionOf: it => (lecturas++, it.pos), weightOf } })
  const base = lecturas
  assert.equal(base, puntos.length, 'el primer dibujo lee cada punto una vez')
  cam.estado.lng = 0.0001
  layer.redraw()
  assert.equal(lecturas, base, 'un paneo corto no relee los accessors')
  cam.estado.lng = 3
  const subidas = llamadas(calls, 'bufferData').length
  layer.redraw()
  assert.equal(lecturas, base + puntos.length, 'uno lejano a zoom alto reasienta el ancla')
  assert.equal(llamadas(calls, 'bufferData').length, subidas + 1, 'y resube')
  layer.destroy()
})

test('un paneo lejano a zoom bajo no re-ancla: el redondeo float32 sigue bajo la tolerancia', () => {
  let lecturas = 0
  const { layer, cam } = montar(puntos, { vista: { zoom: 3 }, accessors: { idOf, positionOf: it => (lecturas++, it.pos), weightOf } })
  const base = lecturas
  cam.estado.lng = 100
  layer.redraw()
  assert.equal(lecturas, base)
  layer.destroy()
})

/* ── La paleta ── */

test('la paleta se muestrea 256 veces al construir, en colorRamp= y en refresh', () => {
  let n = 0
  const rampa = t => { n++; return [t, 0, 1 - t, 1] }
  const { layer, calls } = montar(puntos, { opts: { colorRamp: rampa } })
  assert.equal(GRAD_STEPS, 256)
  assert.equal(n, GRAD_STEPS, 'al construir')
  const subidas = llamadas(calls, 'texSubImage2D').length
  layer.colorRamp = t => { n++; return [0, t, 0, 1] }
  assert.equal(n, 2 * GRAD_STEPS, 'en colorRamp=')
  layer.refresh()
  assert.equal(n, 3 * GRAD_STEPS, 'en refresh')
  assert.equal(llamadas(calls, 'texSubImage2D').length, subidas + 2, 'cada muestreo actualiza la textura')
  const sub = llamadas(calls, 'texSubImage2D').at(-1)
  assert.deepEqual(sub.slice(2, 9), [0, 0, 0, GRAD_STEPS, 1, 'RGBA', 'UNSIGNED_BYTE'])
  assert.equal(sub[9].length, GRAD_STEPS * 4)
  layer.destroy()
})

test('la paleta sube con la textura al construir el contexto, con el color exacto de la rampa', () => {
  const { layer, calls } = montar(puntos, { opts: { colorRamp: t => [t, t * 0.5, 1 - t, 1] } })
  const tex = llamadas(calls, 'texImage2D').find(c => c[3] === 'RGBA8' && c[4] === GRAD_STEPS && c[5] === 1)
  assert.ok(tex, 'una textura de 256 × 1 RGBA8')
  const pal = tex[9]
  const k = 128
  assert.deepEqual(Array.from(pal.subarray(k * 4, k * 4 + 4)), [128, 64, 127, 255], 'índice y canales en su lugar')
  assert.equal(pal[255 * 4 + 3], 255)
  layer.destroy()
})

test('una rampa que lanza al construir no deja el pane: la superficie ni se toma', () => {
  const calls = []
  const cam   = camara()
  const source = createSource({ idOf, positionOf, weightOf })
  source.set(puntos)
  let altas = 0
  assert.throws(() => new HeatLayer({
    host: { camera: cam }, pane: 'heat', source, colorRamp: () => { throw new Error('rampa rota') },
    surface: () => { altas++; return superficie([glDoble({ calls })], calls) },
  }), /rampa rota/)
  assert.equal(altas, 0)
  assert.equal(cam.oyentes('moveend'), 0, 'tampoco suscribió la vista')
})

/* ── Radio y desenfoque ── */

test('radius y blur negativos valen 0, y R = 0 no emite splat', () => conRaf(({ correr }) => {
  const { layer, calls } = montar(puntos)
  assert.equal(llamadas(calls, 'drawArraysInstanced').length, 1)
  calls.length = 0
  layer.radius = -30
  correr()
  const R = llamadas(calls, 'uniform1fv').find(c => c[1].name === 'uRadius')
  assert.deepEqual(Array.from(R[2]), [15], 'radius −30 vale 0 y R = blur por defecto')
  assert.equal(llamadas(calls, 'drawArraysInstanced').length, 1)
  calls.length = 0
  layer.blur = -2
  correr()
  assert.equal(llamadas(calls, 'drawArraysInstanced').length, 0, 'R = 0: sin splat')
  assert.equal(llamadas(calls, 'drawArrays').length, 1, 'la rampa pinta igual el campo vacío')
  assert.equal(llamadas(calls, 'SURFACE_END').length, 1)
  layer.destroy()
}))

/* ── Visibilidad, zoom y destrucción ── */

test('oculta no dibuja ante un flush ni un evento de mapa; setVisible(true) dibuja', async () => conRaf(async ({ correr }) => {
  const { layer, calls, source, cam, surf } = montar(puntos, { opts: { visible: false } })
  assert.equal(llamadas(calls, 'SURFACE_BEGIN').length, 0, 'oculta desde el alta no pinta')
  source.set([...puntos, { id: 9, pos: { lat: 1, lng: 2 }, w: 1 }])
  await new Promise(r => setTimeout(r, 5))
  cam.fire('moveend')
  correr()
  layer.redraw()
  assert.equal(llamadas(calls, 'SURFACE_BEGIN').length, 0)
  assert.equal(llamadas(calls, 'drawArraysInstanced').length, 0)

  assert.equal(layer.setVisible(true), true)
  assert.deepEqual(surf.visible, [true])
  assert.equal(llamadas(calls, 'SURFACE_BEGIN').length, 1, 'al volver pinta una vez, en el acto')
  assert.equal(llamadas(calls, 'drawArraysInstanced')[0][4], 4, 'con el punto que llegó oculta')
  assert.equal(layer.setVisible(true), false, 'visible y al día no repinta')
  layer.destroy()
}))

test('zoomstart pinta vacío; el campo vuelve en el zoomend', () => conRaf(({ correr }) => {
  const { layer, calls, cam } = montar(puntos)
  calls.length = 0
  cam.fire('zoomstart')
  assert.deepEqual(calls.map(c => c[0]).filter(n => n.startsWith('SURFACE')), ['SURFACE_BEGIN', 'SURFACE_END'])
  assert.equal(llamadas(calls, 'drawArraysInstanced').length, 0)
  assert.equal(llamadas(calls, 'drawArrays').length, 0)
  assert.equal(llamadas(calls, 'clear').length, 1)
  cam.fire('zoomstart')
  assert.equal(llamadas(calls, 'SURFACE_BEGIN').length, 1, 'un segundo zoomstart sin dibujo de por medio no repite el vacío')
  cam.fire('zoomend')
  correr()
  assert.equal(llamadas(calls, 'drawArraysInstanced').length, 1, 'el zoomend repinta el campo')
  cam.fire('zoomstart')
  assert.equal(llamadas(calls, 'SURFACE_BEGIN').length, 3, 'tras un dibujo lleno el vacío vuelve a pintarse')
  layer.destroy()
}))

test('un flush de la Source en pleno zoom animado no pinta el campo: lo pinta el zoomend', async () => conRaf(async ({ correr }) => {
  const { layer, source, calls, cam } = montar(puntos)
  cam.fire('zoomstart')
  calls.length = 0
  source.set([...puntos, { id: 9, pos: { lat: 2, lng: 2 }, w: 2 }])
  await new Promise(r => setTimeout(r, 5))    // el flush de la Source llega en pleno zoom
  layer.redraw()
  cam.fire('resize')
  correr()
  assert.equal(llamadas(calls, 'drawArraysInstanced').length, 0, 'ni el flush, ni redraw, ni un evento de mapa pintan splats')
  assert.equal(llamadas(calls, 'drawArrays').length, 0)
  cam.fire('zoomend')
  correr()
  const [splat] = llamadas(calls, 'drawArraysInstanced')
  assert.equal(splat[4], 4, 'al asentar pinta con los datos nuevos')
  layer.destroy()
}))

test('tras destroy, los setters no programan un rAF', () => conRaf(({ cola }) => {
  const { layer } = montar(puntos)
  layer.destroy()
  layer.radius = 5
  layer.intensity = 2
  assert.equal(cola.length, 0)
}))

test('los eventos de mapa se coalescen a un rAF, y destroy lo cancela', () => conRaf(({ cola, canceladas, correr }) => {
  const { layer, calls, cam } = montar(puntos)
  calls.length = 0
  cam.fire('moveend')
  cam.fire('resize')
  cam.fire('zoomend')
  assert.equal(cola.length, 1, 'una ráfaga agenda un solo rAF')
  assert.equal(llamadas(calls, 'SURFACE_BEGIN').length, 0, 'no dibuja hasta el frame')
  correr()
  assert.equal(llamadas(calls, 'SURFACE_BEGIN').length, 1)

  cam.fire('moveend')
  assert.equal(cola.length, 1)
  layer.destroy()
  assert.deepEqual(canceladas.slice(-1), [2], 'destroy cancela el rAF pendiente con su id')
  assert.equal(cam.oyentes('moveend') + cam.oyentes('zoomstart'), 0, 'y suelta los eventos de la vista')
  layer.destroy()
  assert.equal(llamadas(calls, 'SURFACE_DESTROY').length, 1, 'destroy es idempotente')
}))

test('la ruta del Source dibuja síncrona, sin rAF propio', async () => conRaf(async ({ cola }) => {
  const { layer, source, calls } = montar(puntos)
  await new Promise(r => setTimeout(r, 5))
  calls.length = 0
  cola.length  = 0
  source.set([...puntos, { id: 9, pos: { lat: 1, lng: 2 }, w: 1 }])
  await new Promise(r => setTimeout(r, 5))
  assert.equal(cola.length, 0)
  assert.equal(llamadas(calls, 'SURFACE_BEGIN').length, 1)
  assert.equal(llamadas(calls, 'drawArraysInstanced')[0][4], 4)
  layer.destroy()
}))

test('con un mapa adoptado, zoomstart y moveend llegan por la cámara del anfitrión', () => conRaf(({ correr }) => {
  const map  = makeMap()
  const calls = []
  const gl   = glDoble({ calls })
  const surf = superficie([gl], calls)
  const source = createSource({ idOf, positionOf, weightOf })
  source.set(puntos)
  const layer = new HeatLayer({ host: adoptLeafletHost(map), pane: 'heat', source, surface: o => { surf.owner = o.owner; return surf } })
  calls.length = 0
  map.fire('zoomstart')
  assert.equal(llamadas(calls, 'SURFACE_END').length, 1)
  map.fire('zoomend')
  map.fire('moveend')
  correr()
  assert.equal(llamadas(calls, 'drawArraysInstanced').length, 1)
  layer.destroy()
}))

/* ── El contexto ── */

test('dropGl seguido de buildGl resube desde el espejo, sin llamar a positionOf', () => {
  let lecturas = 0
  const gls = [glDoble(), glDoble()]
  const { layer, surf } = montar(puntos, { gls, accessors: { idOf, positionOf: it => (lecturas++, it.pos), weightOf } })
  const base = lecturas
  surf.perder()
  surf.recuperar()
  assert.equal(lecturas, base, 'el espejo de CPU basta')
  const [datos] = llamadas(gls[1].calls, 'bufferData').map(c => c[2])
  assert.equal(datos.length, 9)
  assert.equal(llamadas(gls[1].calls, 'drawArraysInstanced')[0][4], 3, 'y pinta en el acto')
  assert.equal(llamadas(gls[1].calls, 'texImage2D').filter(c => c[3] === 'RGBA8' && c[5] === 1).length, 1, 'con su paleta')
  layer.destroy()
})

test('destroy devuelve lo GL a un contexto vivo y no a uno perdido', () => {
  const { layer, calls } = montar(puntos)
  calls.length = 0
  layer.destroy()
  assert.deepEqual(llamadas(calls, 'deleteTexture', 'deleteFramebuffer', 'deleteBuffer', 'deleteVertexArray').map(c => c[0]).sort(),
    ['deleteBuffer', 'deleteFramebuffer', 'deleteTexture', 'deleteTexture', 'deleteVertexArray'])

  const perdido = glDoble()
  perdido.isContextLost = () => true
  const otra = montar(puntos, { gls: [perdido] })
  otra.calls.length = 0
  otra.layer.destroy()
  assert.equal(llamadas(otra.calls, 'deleteTexture').length, 0)
})

test('sin extensiones usa la mezcla over y el acumulador RGBA8; con ellas, la suma en R16F', () => {
  const sin = montar(puntos, { ext: false })
  assert.deepEqual(llamadas(sin.calls, 'blendFunc').at(-1).slice(1), ['ONE', 'ONE_MINUS_SRC_ALPHA'])
  const accSin = llamadas(sin.calls, 'texImage2D').find(c => c[4] === 800)
  assert.deepEqual([accSin[3], accSin[7], accSin[8]], ['RGBA8', 'RGBA', 'UNSIGNED_BYTE'])
  sin.layer.destroy()

  const con = montar(puntos, { ext: true })
  assert.deepEqual(llamadas(con.calls, 'blendFunc').at(-1).slice(1), ['ONE', 'ONE'])
  const accCon = llamadas(con.calls, 'texImage2D').find(c => c[4] === 800)
  assert.deepEqual([accCon[3], accCon[7], accCon[8]], ['R16F', 'RED', 'HALF_FLOAT'])
  assert.equal(llamadas(con.calls, 'texImage2D').filter(c => c[4] === 800).length, 1, 'el acumulador se aloca una vez')
  con.layer.redraw()
  assert.equal(llamadas(con.calls, 'texImage2D').filter(c => c[4] === 800).length, 1, 'y con la misma vista no se realoca')
  con.cam.estado.w = 640
  con.layer.redraw()
  assert.equal(llamadas(con.calls, 'texImage2D').filter(c => c[4] === 640).length, 1, 'al cambiar el tamaño sí')
  con.layer.destroy()
})

test('suelta, la rampa va al framebuffer por defecto; en un tramo, el que enlazó begin', () => {
  const suelta = montar(puntos, { enTramo: false })
  suelta.calls.length = 0
  suelta.layer.redraw()
  const iBegin = indice(suelta.calls, 'SURFACE_BEGIN')
  const defecto = suelta.calls.findIndex((c, i) => i > iBegin && c[0] === 'bindFramebuffer' && c[2] === null)
  assert.ok(defecto > iBegin && defecto < indice(suelta.calls, 'drawArrays'), 'bindFramebuffer(null) tras begin y antes de la rampa')
  assert.deepEqual(suelta.calls[defecto + 1].slice(1), [0, 0, 800, 600], 'con el viewport del drawing buffer')
  suelta.layer.destroy()

  const tramo = montar(puntos, { enTramo: true })
  tramo.calls.length = 0
  tramo.layer.redraw()
  const b = indice(tramo.calls, 'SURFACE_BEGIN')
  assert.equal(tramo.calls.some((c, i) => i > b && c[0] === 'bindFramebuffer'), false, 'el destino del tramo no se pisa')
  tramo.layer.destroy()
})

test('el estado del acumulador queda neutro para sus vecinas: sin profundidad, stencil ni scissor', () => {
  const { layer, calls } = montar(puntos)
  calls.length = 0
  layer.redraw()
  const desactivados = llamadas(calls, 'disable').map(c => c[1])
  ;['DEPTH_TEST', 'STENCIL_TEST', 'SCISSOR_TEST', 'CULL_FACE'].forEach(c => assert.ok(desactivados.includes(c), c))
  layer.destroy()
})

test('redraw() con la cámara sola asigna 0 bytes', () => {
  const quieto = glDoble({ grabar: false })
  const cam    = camara()
  const source = createSource({ idOf, positionOf, weightOf })
  source.set(puntos)
  const surf = superficie([quieto], [])
  surf.begin = () => DESTINO
  surf.end   = () => {}
  const layer = new HeatLayer({ host: { camera: cam }, pane: 'heat', source, surface: o => { surf.owner = o.owner; return surf } })
  const medir = () => bytesPorLlamada(() => layer.redraw(), 20_000, { calentar: 100_000 })
  const b = medir()
  assert.ok(b < 1, `redraw con la cámara sola: ${b} bytes por llamada`)
  layer.destroy()
})

/* ── La agregación ── */

const FIXTURE = new URL('../fixtures/calor-llamadas-ef39ddd.json', import.meta.url)

// Veinte puntos con pesos distintos, y otros tantos para un flush.
const veinte = Array.from({ length: 20 }, (_, i) => ({ id: i, pos: { lat: -33 + (i % 5) * 0.01, lng: -70 + Math.floor(i / 5) * 0.013 }, w: 1 + (i % 4) }))
const otros  = veinte.map(p => ({ ...p, pos: { lat: p.pos.lat + 0.002, lng: p.pos.lng } }))

// Las llamadas GL de un recorrido completo: alta, paneo, zoom animado que cambia de nivel, flush, intensity, radius, refresh,
// pérdida y vuelta del contexto, y destroy. Los arreglos tipados se guardan como listas.
const recorrido = Clase => conRaf(async ({ correr }) => {
  const calls = []
  const gls   = [glDoble({ calls }), glDoble({ calls })]
  const { layer, cam, source, surf } = montar(veinte, { Clase, gls, vista: { zoom: 10.4, lat: -33, lng: -70 } })
  layer.redraw()
  cam.estado.lng = -69.99
  layer.redraw()
  cam.fire('zoomstart')
  cam.estado.zoom = 11.6
  cam.fire('zoomend')
  correr()
  source.set(otros)
  await new Promise(r => setTimeout(r, 5))
  layer.intensity = 2
  correr()
  layer.radius = 5
  correr()
  layer.refresh()
  surf.perder()
  surf.recuperar()
  layer.destroy()
  return JSON.parse(JSON.stringify(calls, (_k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)))
})

test('por debajo del umbral la capa hace las mismas llamadas GL que en ef39ddd', async () => {
  if (process.env.CALOR_GRABAR) {
    const { HeatLayer: Vieja } = await import(process.env.CALOR_GRABAR)
    writeFileSync(FIXTURE, JSON.stringify(await recorrido(Vieja)) + '\n')
  }
  assert.ok(veinte.length < AGGREGATE_MIN_POINTS)
  const esperado = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  const actual   = await recorrido(HeatLayer)
  const i = actual.findIndex((c, k) => JSON.stringify(c) !== JSON.stringify(esperado[k]))
  assert.equal(i === -1 && actual.length === esperado.length, true,
    `primera llamada distinta en ${i}: ${JSON.stringify(actual[i])} contra ${JSON.stringify(esperado[i])}`)
})

// Una nube de `n` puntos en un cuadrado de 0,2° alrededor de (lat, lng): a zoom 10 entran varios por celda de 8 px.
const nube = (n, { lat = -33, lng = -70, lado = 0.2 } = {}) =>
  Array.from({ length: n }, (_, i) => ({ id: i, pos: { lat: lat + ((i * 7919) % 1000) / 1000 * lado, lng: lng + ((i * 104729) % 997) / 997 * lado }, w: 1 }))

// Cuenta las pasadas de HeatCells.build mientras corre `fn`.
const contandoPasadas = async fn => {
  const build = HeatCells.prototype.build
  const pasadas = []
  HeatCells.prototype.build = function (...a) { const r = build.apply(this, a); pasadas.push({ celdas: r, nivel: a[4], px: a[5] }); return r }
  try { await fn(pasadas) } finally { HeatCells.prototype.build = build }
  return pasadas
}

test('con un punto menos que el umbral dibuja un splat por punto; con el umbral, celdas con su programa', () => {
  const debajo = montar(nube(AGGREGATE_MIN_POINTS - 1), { vista: { zoom: 10, lat: -32.9, lng: -69.9 } })
  const [splat] = llamadas(debajo.calls, 'drawArraysInstanced')
  assert.equal(splat[4], AGGREGATE_MIN_POINTS - 1)
  assert.equal(llamadas(debajo.calls, 'linkProgram').length, 2, 'sólo el splat y la rampa')
  assert.equal(llamadas(debajo.calls, 'vertexAttribPointer').length, 2, 'un VAO de puntos')
  debajo.layer.destroy()

  const encima = montar(nube(AGGREGATE_MIN_POINTS), { vista: { zoom: 10, lat: -32.9, lng: -69.9 } })
  const [celdas] = llamadas(encima.calls, 'drawArraysInstanced')
  assert.ok(celdas[4] > 0 && celdas[4] < AGGREGATE_MIN_POINTS / 2, `${celdas[4]} celdas`)
  assert.equal(llamadas(encima.calls, 'linkProgram').length, 3, 'el programa de celdas se enlaza al agregar')
  const subida = llamadas(encima.calls, 'bufferData').at(-1)[2]
  assert.equal(subida.length, celdas[4] * CELL_FLOATS, 'el búfer de celdas: cuatro floats por celda')
  let suma = 0
  for (let k = 0; k < celdas[4]; k++) suma += subida[k * CELL_FLOATS + 3]
  assert.equal(suma, AGGREGATE_MIN_POINTS, 'las multiplicidades suman los puntos')
  const usados = llamadas(encima.calls, 'uniform1fv').map(c => c[1].name)
  assert.equal(usados.includes('uIntensity'), false, 'en las celdas el aporte ya lleva la intensidad')
  encima.layer.destroy()
  assert.equal(llamadas(encima.calls, 'deleteBuffer').length, 2, 'destroy borra también el búfer de celdas')
})

test('las celdas se rehacen con un flush, un move, el nivel, la celda, intensity y refresh; no en un paneo', async () => conRaf(async ({ correr }) => {
  const pasadas = await contandoPasadas(async pasadas => {
    const { layer, cam, source } = montar(nube(AGGREGATE_MIN_POINTS), { vista: { zoom: 10.2, lat: -32.9, lng: -69.9 } })
    assert.equal(pasadas.length, 1, 'el primer dibujo')
    assert.equal(pasadas[0].nivel, 11, 'nivel ⌈10,2⌉')
    cam.estado.lng = -69.85
    layer.redraw()
    cam.fire('moveend')
    correr()
    assert.equal(pasadas.length, 1, 'un paneo no rehace')
    cam.estado.zoom = 10.9
    layer.redraw()
    assert.equal(pasadas.length, 1, 'un zoom dentro del mismo nivel no rehace')
    cam.estado.zoom = 11.3
    layer.redraw()
    assert.equal(pasadas.length, 2, 'cruzar un nivel entero sí')
    layer.radius = 5
    correr()
    assert.equal(pasadas.length, 3, 'un radio que cambia la celda rehace')
    layer.radius = CELL_PX / CELL_PER_RADIUS
    correr()
    assert.equal(pasadas.length, 4, 'otro, hasta el tope de la celda')
    layer.radius = CELL_PX / CELL_PER_RADIUS + 50
    correr()
    assert.equal(pasadas.length, 4, 'un radio que deja la celda igual no rehace')
    layer.intensity = 2
    correr()
    assert.equal(pasadas.length, 5, 'intensity')
    layer.refresh()
    assert.equal(pasadas.length, 6, 'refresh')
    source.set(nube(AGGREGATE_MIN_POINTS, { lat: -32.95 }))
    await new Promise(r => setTimeout(r, 5))
    assert.equal(pasadas.length, 7, 'un flush')
    source.move(3, -32.91, -69.91)
    await new Promise(r => setTimeout(r, 5))
    assert.equal(pasadas.length, 8, 'un move')
    layer.destroy()
  })
  assert.equal(pasadas.length, 8)
}))

test('oculta y en pleno zoom animado no rehace las celdas: lo hace el dibujo que vuelve', async () => conRaf(async ({ correr }) => {
  await contandoPasadas(async pasadas => {
    const { layer, cam, source } = montar(nube(AGGREGATE_MIN_POINTS), { vista: { zoom: 10, lat: -32.9, lng: -69.9 } })
    layer.setVisible(false)
    source.set(nube(AGGREGATE_MIN_POINTS, { lat: -32.95 }))
    await new Promise(r => setTimeout(r, 5))
    layer.intensity = 3
    correr()
    assert.equal(pasadas.length, 1, 'oculta no rehace')
    layer.setVisible(true)
    assert.equal(pasadas.length, 2, 'al volver, una sola pasada')
    cam.fire('zoomstart')
    cam.estado.zoom = 12
    layer.redraw()
    correr()
    assert.equal(pasadas.length, 2, 'en pleno zoom animado no')
    cam.fire('zoomend')
    correr()
    assert.equal(pasadas.length, 3, 'el zoomend sí')
    layer.destroy()
  })
}))

test('dropGl seguido de buildGl resube las celdas sin rehacerlas', () => conRaf(async () => {
  await contandoPasadas(async pasadas => {
    const gls = [glDoble(), glDoble()]
    const { layer, surf } = montar(nube(AGGREGATE_MIN_POINTS), { gls, vista: { zoom: 10, lat: -32.9, lng: -69.9 } })
    const [antes] = llamadas(gls[0].calls, 'drawArraysInstanced')
    surf.perder()
    surf.recuperar()
    assert.equal(pasadas.length, 1, 'las celdas siguen en CPU')
    const [despues] = llamadas(gls[1].calls, 'drawArraysInstanced')
    assert.equal(despues[4], antes[4], 'y el contexto nuevo dibuja las mismas')
    assert.equal(llamadas(gls[1].calls, 'linkProgram').length, 3, 'con su programa de celdas')
    layer.destroy()
  })
}))

test('si las celdas no pagan, dibuja un splat por punto', () => {
  const lejos = Array.from({ length: AGGREGATE_MIN_POINTS }, (_, i) => ({ id: i, pos: { lat: -60 + (i % 200) * 0.6, lng: -170 + Math.floor(i / 200) * 3.4 }, w: 1 }))
  const { layer, calls } = montar(lejos, { vista: { zoom: 10 } })
  assert.equal(llamadas(calls, 'drawArraysInstanced')[0][4], AGGREGATE_MIN_POINTS)
  assert.equal(llamadas(calls, 'linkProgram').length, 2)
  layer.destroy()
})

test('redraw() con celdas y la cámara sola asigna 0 bytes', () => {
  const quieto = glDoble({ grabar: false })
  const cam    = camara({ zoom: 10, lat: -32.9, lng: -69.9 })
  const source = createSource({ idOf, positionOf, weightOf })
  source.set(nube(AGGREGATE_MIN_POINTS))
  const surf = superficie([quieto], [])
  surf.begin = () => DESTINO
  surf.end   = () => {}
  let pasadas = 0
  const build = HeatCells.prototype.build
  HeatCells.prototype.build = function (...a) { pasadas++; return build.apply(this, a) }
  try {
    const layer = new HeatLayer({ host: { camera: cam }, pane: 'heat', source, surface: o => { surf.owner = o.owner; return surf } })
    assert.equal(pasadas, 1)
    const b = bytesPorLlamada(() => layer.redraw(), 20_000, { calentar: 100_000 })
    assert.equal(pasadas, 1, 'el redibujo no rehizo las celdas')
    assert.ok(b < 1, `redraw con celdas: ${b} bytes por llamada`)
    layer.destroy()
  } finally {
    HeatCells.prototype.build = build
  }
})
