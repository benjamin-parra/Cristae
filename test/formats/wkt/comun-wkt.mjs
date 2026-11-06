// Ayudas de las pruebas de WKT y WKB. La integración puede mudarlas a `test/formats/comun.mjs`, que es
// del núcleo; viven acá para que esta pieza se pruebe sin esperarlo.
import assert from 'node:assert/strict'
import { oraculo, comparar } from '../../geojson/oraculo.mjs'

// Forma del error (§1.4) y no `instanceof`: la clase es del núcleo, que se escribe en paralelo.
export const esFormatError = e =>
  e instanceof Error && e.name === 'FormatError' && typeof e.code === 'string' && Number.isInteger(e.at)

export const lanza = (fn, code, at) => {
  let error = null
  try { fn() } catch (e) { error = e }
  assert.ok(error, `se esperaba FormatError('${code}') y no lanzó`)
  assert.ok(esFormatError(error), `excepción cruda: ${error?.stack ?? error}`)
  assert.equal(error.code, code, `código: ${error.message}`)
  at === undefined || assert.equal(error.at, at, `offset: ${error.message}`)
  return error
}

// Compara contra el oráculo de GeoJSON sobre la misma geometría descrita como GeoJSON.
export const igualAlOraculo = (leido, geojson, nombre = '') => {
  const diferencias = comparar(leido, oraculo(geojson))
  assert.deepEqual(diferencias, [], `${nombre}\n${diferencias.join('\n')}`)
}

export const coleccion = geometrias => ({
  type     : 'FeatureCollection',
  features : geometrias.map(geometry => ({ type: 'Feature', properties: null, geometry })),
})

// §5-5: `string` (o hex), `ArrayBuffer`, `Uint8Array` y un `Buffer` de un pool compartido.
export const cuatroFormas = (bytes, texto) => [
  texto,
  bytes.slice().buffer,
  bytes.slice(),
  Buffer.concat([Buffer.from('basura'), Buffer.from(bytes), Buffer.from('cola')]).subarray(6, 6 + bytes.length),
]

// Fuzz de mutación con presupuesto de tiempo (§5-6): sólo `FormatError` y siempre termina.
export const fuzz = (corpus, leer, ms = 1500, semilla = 7) => {
  let s = semilla
  const azar = n => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s % n
  }
  const fin = Date.now() + ms
  let vueltas = 0
  while (Date.now() < fin) {
    const base  = corpus[azar(corpus.length)]
    const bytes = base.slice()
    const veces = 1 + azar(4)
    for (let k = 0; k < veces && bytes.length; k++) bytes[azar(bytes.length)] = azar(256)
    const cortado = azar(5) === 0 ? bytes.subarray(0, azar(bytes.length + 1)) : bytes
    try { leer(cortado) } catch (e) {
      esFormatError(e) || assert.fail(`excepción cruda con ${Buffer.from(cortado).toString('hex')}: ${e?.stack ?? e}`)
    }
    vueltas++
  }
  return vueltas
}
