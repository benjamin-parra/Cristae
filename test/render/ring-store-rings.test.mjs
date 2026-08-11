// `RingStore` alimentado con la geometría tipada del lector: N anillos en UNA textura. El contrato
// que se fija acá es el de la vista por anillo (`viewOf`): un rango propio que cierra contra su
// primer vértice, caja y ancla propias, sobre la textura compartida del store.
import test from 'node:test'
import assert from 'node:assert/strict'
import { RingStore } from '../../src/render/RingStore.js'
import { ROLE } from '../../src/geometry/ChunkedPath.js'
import { projX0 } from '../../src/render/project.js'

const W0 = 256 / 360

const project = (lat, lng, out) => {
  out[0] = (lng + 180) * W0
  out[1] = (90 - lat) * W0
}

const glDoble = () => {
  const subidas = []
  return {
    subidas,
    createTexture : () => ({}),
    bindTexture   : () => {},
    texParameteri : () => {},
    deleteTexture : () => {},
    texImage2D    : (_t, _l, _i, width, height, _b, _f, _tipo, datos) => subidas.push({ width, height, datos }),
  }
}

// Dos anillos cerrados (último = primero) y uno abierto, en [lng, lat, …] como los entrega el lector.
const ANILLOS = [
  [[-70.68, -33.42], [-70.63, -33.40], [-70.61, -33.44], [-70.68, -33.42]],
  [[-70.66, -33.43], [-70.64, -33.42], [-70.65, -33.45], [-70.66, -33.43]],
  [[-70.70, -33.50], [-70.60, -33.50], [-70.60, -33.46]],
]

const tablas = () => {
  const xy = [], vertexAt = [0], closed = []
  ANILLOS.forEach(anillo => {
    anillo.forEach(([lng, lat]) => xy.push(lng, lat))
    vertexAt.push(xy.length / 2)
    const [a, b] = [anillo[0], anillo[anillo.length - 1]]
    closed.push(a[0] === b[0] && a[1] === b[1] ? 1 : 0)
  })
  return {
    xy        : Float64Array.from(xy),
    vertexAt  : Uint32Array.from(vertexAt),
    closed    : Uint8Array.from(closed),
    ringCount : ANILLOS.length,
  }
}

const proyectado = anillo => anillo.map(([lng, lat]) => {
  const out = new Float64Array(2)
  project(lat, lng, out)
  return out
})

const cajaDe = tramo => tramo.reduce(
  (c, [x, y]) => [Math.min(c[0], x), Math.min(c[1], y), Math.max(c[2], x), Math.max(c[3], y)],
  [Infinity, Infinity, -Infinity, -Infinity])

const alta = (rings = tablas()) => {
  const gl    = glDoble()
  const store = new RingStore({ gl, rings, project })
  return { gl, store, rel: gl.subidas[0].datos, rings }
}

test('una sola textura para todos los anillos', () => {
  const { gl, store } = alta()
  assert.equal(gl.subidas.length, 1)
  assert.equal(store.ringCount, 3)
})

test('el bit de cierre descarta el vértice repetido', () => {
  const { store } = alta()
  const rangos    = []
  assert.equal(store.vertexCount, 3 + 3 + 3)          // 4+4+3 en el documento, menos dos cierres
  store.eachRange((ordinal, first, count) => rangos.push([ordinal, first, count]))
  assert.deepEqual(rangos, [[0, 0, 3], [1, 3, 3], [2, 6, 3]])
})

test('cada anillo se guarda relativo a SU ancla', () => {
  const { store, rel } = alta()
  const cerrados = tablas().closed
  let first = 0
  ANILLOS.forEach((anillo, r) => {
    const tramo = proyectado(anillo.slice(0, anillo.length - (cerrados[r] ? 1 : 0)))
    const caja  = cajaDe(tramo)
    const ax    = (caja[0] + caja[2]) / 2
    const ay    = (caja[1] + caja[3]) / 2
    assert.deepEqual(store.viewOf(r).anchor, { x: ax, y: ay }, `ancla del anillo ${r}`)
    tramo.forEach(([x, y], i) => {
      assert.equal(rel[(first + i) * 2], Math.fround(x - ax), `x del vértice ${first + i}`)
      assert.equal(rel[(first + i) * 2 + 1], Math.fround(y - ay), `y del vértice ${first + i}`)
    })
    first += tramo.length
  })
})

// Un ancla común para todos los anillos hace crecer el rel con la extensión del conjunto, y con él el
// error de float32 al proyectar en zoom profundo. Anillos separados por medio mundo, mismo store.
test('el rel no crece con la extensión del conjunto', () => {
  const lejos = [[[-179, -80], [-178, -80], [-178, -79], [-179, -80]], [[178, 80], [179, 80], [179, 81], [178, 80]]]
  const xy = [], vertexAt = [0]
  lejos.forEach(a => { a.forEach(([lng, lat]) => xy.push(lng, lat)); vertexAt.push(xy.length / 2) })
  const { rel } = alta({
    xy        : Float64Array.from(xy),
    vertexAt  : Uint32Array.from(vertexAt),
    closed    : Uint8Array.of(1, 1),
    ringCount : 2,
  })
  const mayor = rel.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  const mundo = Math.abs(projX0(180) - projX0(-180))
  assert.ok(mayor < mundo / 100, `el rel mayor (${mayor}) debería ser chico frente al mundo (${mundo})`)
})

test('cada vista emite UN rango y cierra contra su propio primer vértice', () => {
  const { store } = alta()
  const inicios   = [0, 3, 6]
  inicios.forEach((first, r) => {
    const vista  = store.viewOf(r)
    const rangos = []
    vista.eachRange((ordinal, desde, count, chunk) => rangos.push([ordinal, desde, count, chunk]))
    assert.deepEqual(rangos, [[0, first, 3, r]], `anillo ${r}`)
    assert.equal(vista.nextVertex(first + 2), first, `el cierre del anillo ${r} vuelve a su primero`)
    assert.equal(vista.prevVertex(first), first + 2)
  })
})

test('la vista comparte textura, y no comparte ancla ni caja', () => {
  const { store } = alta()
  const vistas    = [0, 1, 2].map(r => store.viewOf(r))
  assert.equal(vistas[0].texture, vistas[1].texture)
  assert.equal(vistas[0].texture, store.texture)
  assert.equal(store.viewOf(0), vistas[0], 'las vistas son estables entre llamadas')
  assert.notDeepEqual(vistas[0].anchor, vistas[2].anchor, 'cada anillo tiene su propia ancla')
  // La caja se consulta con el `chunk` que emite la propia vista, no con un 0 local.
  const cajaDe = v => {
    let caja = null
    v.eachRange((_o, _f, _c, chunk) => (caja = [...v.boxOfChunk(chunk, new Float64Array(4))]))
    return caja
  }
  const cajas = vistas.map(cajaDe)
  assert.notDeepEqual(cajas[0], cajas[2])
  assert.deepEqual(cajas, [0, 1, 2].map(r => [...store.boxOfChunk(r, new Float64Array(4))]))
})

test('un anillo fuera del rango de otro: roleAt distingue de quién es cada vértice', () => {
  const { store } = alta()
  const vista     = store.viewOf(1)
  assert.equal(vista.roleAt(3), ROLE.vertex)
  assert.equal(vista.roleAt(5), ROLE.vertex)
  assert.equal(vista.roleAt(2), ROLE.free, 'el vértice 2 es del anillo 0, no de esta vista')
  assert.equal(vista.roleAt(6), ROLE.free)
})

test('sin anillos no se cae: textura vacía y ningún rango', () => {
  const { store } = alta({ xy: new Float64Array(0), vertexAt: Uint32Array.of(0), closed: new Uint8Array(0), ringCount: 0 })
  assert.equal(store.ringCount, 0)
  assert.equal(store.vertexCount, 0)
  assert.deepEqual(store.anchor, { x: 0, y: 0 })
  let visto = 0
  store.eachRange(() => visto++)
  assert.equal(visto, 0)
})

test('un anillo degenerado —todos los vértices iguales— no rompe el ancla', () => {
  const punto = [[-70.6, -33.4], [-70.6, -33.4], [-70.6, -33.4]]
  const xy    = Float64Array.from(punto.flat())
  const { store } = alta({ xy, vertexAt: Uint32Array.of(0, 3), closed: Uint8Array.of(0), ringCount: 1 })
  const out = new Float64Array(2)
  project(-33.4, -70.6, out)
  assert.deepEqual(store.anchor, { x: out[0], y: out[1] })
  assert.deepEqual([...store.boxOfChunk(0, new Float64Array(4))], [0, 0, 0, 0])
})

/* ── Tope de textura: sale del contexto, no de una constante ── */

// El doble declara su propio tope, que es lo que hace un contexto real.
const glConTope = tope => {
  const gl = glDoble()
  gl.MAX_TEXTURE_SIZE = 0x0D33
  gl.getParameter = p => (p === 0x0D33 ? tope : undefined)
  return gl
}

const planos = n => Float64Array.from({ length: n * 2 }, (_, i) => (i % 2 ? -33.4 : -70.6) + i * 1e-6)

test('el ancho respeta el tope declarado por el contexto', () => {
  const gl = glConTope(64)
  new RingStore({ gl, points: planos(1000), project })
  const { width, height } = gl.subidas[0]
  assert.equal(width, 64)
  assert.equal(height, Math.ceil(1000 / 64))
})

test('un contexto que declara más ancho usa menos filas', () => {
  const angosto = glConTope(64)
  const ancho   = glConTope(2048)
  new RingStore({ gl: angosto, points: planos(4000), project })
  new RingStore({ gl: ancho,   points: planos(4000), project })
  assert.ok(ancho.subidas[0].height < angosto.subidas[0].height)
  assert.equal(ancho.subidas[0].width * ancho.subidas[0].height >= 4000, true)
})

test('un conteo que no entra en tope×tope falla ruidoso, no con una textura corta', () => {
  assert.throws(() => new RingStore({ gl: glConTope(4), points: planos(100), project }),
    /no entran en una textura de 4×4/)
})

test('un contexto que no declara el tope cae al mínimo garantizado por WebGL2', () => {
  const gl = glDoble()
  new RingStore({ gl, points: planos(5000), project })
  assert.equal(gl.subidas[0].width, 2048)
})
