// El camino rápido de `RingStore`. Una entrada tipada plana [lat, lng, …] tiene que producir
// EXACTAMENTE el mismo anillo que los pares —mismo `rel`, misma caja, misma ancla, byte a byte— y no
// dispararse con una entrada que sólo se le parece. La comparación va por bytes y no por tolerancia:
// las dos formas hacen la misma aritmética sobre los mismos dobles, así que cualquier diferencia es
// un cambio de resultado, no de precisión.

import test from 'node:test'
import assert from 'node:assert/strict'
import { RingStore } from '../../src/render/RingStore.js'

const W0 = 256 / 360

const project = (lat, lng, out) => {
  out[0] = (lng + 180) * W0
  out[1] = (90 - lat) * W0
}

// Anillo irregular: cada extremo de la caja lo aporta un vértice DISTINTO, así que un ancla mal
// calculada no se disimula con la simetría de un cuadrado.
const ANILLO = [
  [-33.4210, -70.6812], [-33.4008, -70.6390], [-33.4455, -70.6105],
  [-33.4702, -70.6533], [-33.4531, -70.7010], [-33.4290, -70.6944],
]

const pares   = () => ANILLO.map(([lat, lng]) => [lat, lng])
const objetos = () => ANILLO.map(([lat, lng]) => ({ lat, lng }))
const plano   = () => Float64Array.from(ANILLO.flat())

/* ── Doble de gl: sólo hace falta retener lo que se sube, que es el `rel` con las filas completas ── */

const glDoble = () => {
  const subidas = []
  return {
    subidas,
    createTexture : () => ({}),
    bindTexture   : () => {},
    texParameteri : () => {},
    deleteTexture : () => {},
    texImage2D    : (_target, _level, _internal, width, height, _borde, _formato, _tipo, datos) =>
      subidas.push({ width, height, datos }),
  }
}

// Todo lo observable del anillo, listo para comparar. La caja va a un buffer propio: `boxOfChunk`
// devuelve el suyo reusado por default.
const alta = points => {
  const gl     = glDoble()
  const store  = new RingStore({ gl, points, project })
  const rangos = []
  store.eachRange((ordinal, first, count, chunk) => rangos.push([ordinal, first, count, chunk]))
  return {
    store,
    rangos,
    rel   : gl.subidas[0].datos,
    ancho : gl.subidas[0].width,
    alto  : gl.subidas[0].height,
    ancla : store.anchor,
    caja  : store.boxOfChunk(0, new Float64Array(4)),
  }
}

const bytes   = ta => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength)
const iguales = (a, b) => Buffer.compare(bytes(a), bytes(b)) === 0

// Lo que leen los consumidores del contrato, no sólo lo que viajó a la textura.
const relLeido = store => Float32Array.from(ANILLO.flatMap((_, i) => [store.relX(i), store.relY(i)]))

// Las dos entradas producen el mismo anillo, y con él las mismas dimensiones de textura y el mismo
// rango: el camino rápido no toca el resto del contrato.
const mismoAnillo = (a, b, nota) => {
  assert.ok(iguales(a.rel, b.rel), `${nota}: el rel subido a la textura difiere`)
  assert.ok(iguales(a.caja, b.caja), `${nota}: la caja difiere`)
  assert.deepEqual(b.ancla, a.ancla, `${nota}: el ancla difiere`)
  assert.deepEqual([b.ancho, b.alto, b.rangos], [a.ancho, a.alto, a.rangos], `${nota}: la textura difiere`)
}

/* ── 1. Las dos entradas dan lo mismo ── */

test('un Float64Array plano produce el MISMO anillo que los pares [lat, lng]', () => {
  const a = alta(pares())
  const b = alta(plano())

  mismoAnillo(a, b, 'plano vs pares')
  assert.ok(iguales(relLeido(a.store), relLeido(b.store)), 'los accessors leen lo mismo que se subió')
  assert.ok(a.rangos[0][2] > 0 && a.ancla.x !== 0, 'el anillo tiene que traer algo, o no se comparó nada')
})

test('y lo mismo contra los objetos {lat, lng}: el camino genérico quedó intacto', () => {
  mismoAnillo(alta(objetos()), alta(plano()), 'plano vs objetos')
})

// Un Float32Array redondea lat/lng, así que la comparación honesta es contra los pares que salen de
// ESE redondeo: contra los originales se mediría la precisión de la entrada, no el camino.
test('un Float32Array plano también entra por el camino rápido', () => {
  const f32 = Float32Array.from(ANILLO.flat())
  mismoAnillo(alta(ANILLO.map((_, i) => [f32[i * 2], f32[i * 2 + 1]])), alta(f32), 'f32 vs sus pares')
})

// Un anillo que vive DENTRO de un buffer más grande: la vista indexa desde su propio cero.
test('el camino rápido respeta una vista con offset: el anillo es el de la vista, no el del buffer', () => {
  const buffer = new Float64Array(ANILLO.length * 2 + 6).fill(999)
  const vista  = buffer.subarray(4, 4 + ANILLO.length * 2)
  vista.set(ANILLO.flat())

  mismoAnillo(alta(pares()), alta(vista), 'vista con offset')
})

/* ── 2. El camino rápido no se dispara de más ── */

// La marca observable es el conteo: por el camino rápido un largo de 12 son 6 vértices; por el
// genérico, 12 entradas.
const vertices = entrada => alta(entrada).rangos[0][2]

test('el camino rápido no se dispara con lo que sólo se le parece', () => {
  assert.equal(vertices(plano()), ANILLO.length, 'un Float64Array plano SÍ es el camino rápido')
  assert.equal(vertices(pares()), ANILLO.length)
  assert.equal(vertices(ANILLO.flat()), ANILLO.length * 2,
    'un Array de números planos no es una entrada tipada: sigue siendo una entrada por vértice')
  assert.equal(vertices(Int32Array.from(ANILLO.flat())), ANILLO.length * 2,
    'un tipado de enteros tampoco: lat/lng truncados no serían las coordenadas que le pasaron')
})

/* ── 3. Degenerados ── */

test('el anillo vacío y el de un solo vértice coinciden en las dos entradas', () => {
  const vacio = alta(new Float64Array(0))
  mismoAnillo(alta([]), vacio, 'vacío')
  assert.deepEqual(vacio.rangos, [], 'un anillo sin vértices no abre ningún rango')

  const uno = alta(Float64Array.from(ANILLO[0]))
  mismoAnillo(alta([ANILLO[0]]), uno, 'un vértice')
  assert.deepEqual([uno.store.relX(0), uno.store.relY(0)], [0, 0], 'el único vértice queda en su ancla')
})
