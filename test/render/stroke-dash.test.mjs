// Dash y tapa del trazo GPU. El patrón se dibuja en el fragment shader, que acá no corre: lo que se
// puede congelar sin un navegador es el CONTRATO con la GPU —qué se sube, en qué unidad, con qué
// normalización y cuántos draws cuesta—. El dibujo en sí se midió contra una GPU real.

import { makeGl } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { RingStore } from '../../src/render/RingStore.js'
import { StrokePass } from '../../src/render/StrokePass.js'

const SIZE = { x: 800, y: 600 }

// Con proyector identidad, `xy` en [lng, lat] son directamente los world0 px.
const project = (lat, lng, out) => {
  out[0] = lng
  out[1] = lat
}

// Los dos anillos del banco: un quebrado de largo 5 + 6 y un tramo recto de 10. Los largos son
// pitagóricos (3-4-5) para que float32 los guarde exactos.
const RINGS = {
  xy        : Float64Array.of(0, 0, 3, 4, 3, 10, 20, 20, 20, 30),
  vertexAt  : Uint32Array.of(0, 3, 5),
  closed    : Uint8Array.of(0, 0),
  ringCount : 2,
}

// Doble de gl que retiene lo observable: uniformes por nombre, subidas de textura, ligaduras por
// unidad y cada draw.
const glEspia = () => {
  const log = { uniform: {}, subidas: [], unidades: [], draws: 0, borradas: 0 }
  let unidad = 0
  const propio = {
    log,
    getUniformLocation : (_programa, nombre) => ({ nombre }),
    uniform1i          : (loc, v) => (log.uniform[loc.nombre] = v),
    uniform1f          : (loc, v) => (log.uniform[loc.nombre] = v),
    uniform1fv         : (loc, v) => (log.uniform[loc.nombre] = [...v]),
    texImage2D         : (_t, _l, formato, ancho, alto, _b, _f, _tipo, datos) => log.subidas.push({ formato, ancho, alto, datos }),
    activeTexture      : u => (unidad = u),
    bindTexture        : (_t, textura) => log.unidades.push({ unidad, textura }),
    deleteTexture      : () => log.borradas++,
    drawArrays         : () => log.draws++,
  }
  return new Proxy(makeGl(), { get: (t, p) => propio[p] ?? t[p] })
}

const montar = (estilo = {}, closed = false) => {
  const gl    = glEspia()
  const store = new RingStore({ gl, project, rings: RINGS })
  const pase  = new StrokePass({ gl, closed, ...estilo })
  const vista = { zoom: 3, center: { x: 10, y: 15 }, size: SIZE }
  const pintar = () => [0, 1].forEach(r => pase.draw([{ arena: store.viewOf(r) }], vista))
  return { gl, store, pase, pintar, log: gl.log }
}

/* ── El largo acumulado que viaja a la GPU ── */

test('arcTexture: largo acumulado por vértice, R32F, y cada anillo arranca en cero', () => {
  const { gl, store } = montar()
  const antes = gl.log.subidas.length
  assert.ok(store.arcTexture)
  const subida = gl.log.subidas.at(-1)
  assert.equal(gl.log.subidas.length, antes + 1)
  assert.equal(subida.formato, gl.R32F)
  assert.deepEqual([...subida.datos.subarray(0, 5)], [0, 5, 11, 0, 10], 'anillo 1: 0, 5, 5+6; anillo 2 vuelve a 0')
})

test('arcTexture se arma al primer pedido, una sola vez, y destroy() la suelta con la de posiciones', () => {
  const { gl, store } = montar()
  assert.equal(gl.log.subidas.length, 1, 'sólo las posiciones: un trazo sólido nunca la pide')
  const primera = store.arcTexture
  assert.equal(store.arcTexture, primera)
  assert.equal(gl.log.subidas.length, 2)
  store.destroy()
  assert.equal(gl.log.borradas, 2)
  assert.equal(store.arcTexture, null)
})

test('la vista de un anillo da la misma textura de arcos que el store', () => {
  const { store } = montar()
  assert.equal(store.viewOf(1).arcTexture, store.arcTexture)
})

/* ── El patrón se normaliza una vez y llega en píxeles de pantalla ── */

test('un patrón par llega tal cual, con su período, la escala del zoom y los arcos en la unidad 1', () => {
  const { pintar, log, gl, store } = montar({ dash: [6, 4] })
  pintar()
  assert.equal(log.uniform.dashCount, 2)
  assert.equal(log.uniform.period, 10)
  assert.deepEqual(log.uniform.dash.slice(0, 2), [6, 4])
  assert.equal(log.uniform.scale, 8, 'px de pantalla por world0 px: 2^zoom')
  const ligadura = log.unidades.find(l => l.unidad === gl.TEXTURE1 && l.textura)
  assert.equal(ligadura.textura, store.arcTexture)
})

test('un patrón impar se repite: [a, b, c] es [a, b, c, a, b, c]', () => {
  const { pintar, log } = montar({ dash: [5, 3, 2] })
  pintar()
  assert.equal(log.uniform.dashCount, 6)
  assert.equal(log.uniform.period, 20)
  assert.deepEqual(log.uniform.dash.slice(0, 6), [5, 3, 2, 5, 3, 2])
})

test('lo que no es un patrón se dibuja continuo y no arma la textura de arcos', () => {
  for (const dash of [null, [], [0, 0], [-1, 2], [NaN, 1], [1, Infinity], 'x', 7]) {
    const { pintar, log } = montar({ dash })
    pintar()
    assert.equal(log.uniform.dashCount, 0, `dash ${String(dash)}`)
    assert.equal(log.subidas.length, 1, `dash ${String(dash)}: sólo las posiciones`)
  }
})

test('un patrón que no cabe en el uniform es un error, no un recorte', () => {
  assert.throws(() => montar({ dash: Array(18).fill(1) }), /hasta 16 valores/)
  assert.throws(() => montar({ dash: Array(9).fill(1) }), /hasta 16 valores/, 'nueve valores son dieciocho al repetirse')
  assert.doesNotThrow(() => montar({ dash: Array(16).fill(1) }))
  assert.doesNotThrow(() => montar({ dash: Array(7).fill(1) }))
})

test('un patrón rechazado deja el estilo anterior intacto', () => {
  const { pase, pintar, log } = montar({ dash: [6, 4] })
  assert.throws(() => pase.style({ dash: Array(18).fill(1) }))
  pintar()
  assert.equal(log.uniform.dashCount, 2)
  assert.equal(log.uniform.period, 10)
})

/* ── Tapa, y qué conserva style() entre llamadas ── */

test('cap: butt, round y square son 0, 1 y 2; cualquier otro valor es butt', () => {
  const codigo = cap => {
    const { pintar, log } = montar({ cap })
    pintar()
    return log.uniform.cap
  }
  assert.deepEqual(['butt', 'round', 'square', 'redonda', undefined].map(codigo), [0, 1, 2, 0, 0])
})

test('style() conserva lo que no se le dice y null devuelve el trazo a continuo', () => {
  const { pase, pintar, log } = montar({ dash: [6, 4], cap: 'round' })
  pase.style({ width: 8 })
  pintar()
  assert.deepEqual([log.uniform.dashCount, log.uniform.cap], [2, 1], 'cambiar el grosor no toca el patrón ni la tapa')
  pase.style({ dash: null, cap: 'butt' })
  pintar()
  assert.deepEqual([log.uniform.dashCount, log.uniform.cap], [0, 0])
})

/* ── El costo no cambia ── */

test('el dash no agrega draws: sigue siendo UNO por anillo, con o sin patrón', () => {
  const continuo = montar({ cap: 'round' })
  const punteado = montar({ dash: [1, 6], cap: 'round' })
  continuo.pintar()
  punteado.pintar()
  assert.deepEqual([continuo.log.draws, punteado.log.draws], [2, 2])
})
