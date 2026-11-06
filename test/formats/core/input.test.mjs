// Entrada y error del núcleo (DISENO-INTEROP §1.4, §2.1 y §7).

import test from 'node:test'
import assert from 'node:assert/strict'
import { FormatError } from '../../../src/formats/core/error.js'
import { asBytes, bomSkip, hexBytes } from '../../../src/formats/core/input.js'
import { esFormatError, fallaCon, formasBinarias, vistaEnvenenada } from '../comun.mjs'

test('FormatError: name, format, code, at, hint y el mensaje con el lector que falló', () => {
  const e = new FormatError('kml', 'dtd', 12, 'gpx')
  assert.ok(e instanceof Error)
  assert.deepEqual([e.name, e.format, e.code, e.at, e.hint], ['FormatError', 'kml', 'dtd', 12, 'gpx'])
  assert.equal(e.message, 'kml: dtd (byte 12)')
  assert.equal(new FormatError('zip', 'entorno').message, 'zip: entorno')
  assert.equal(new FormatError('zip', 'entorno').at, -1)
  assert.equal(new FormatError('zip', 'entorno').hint, null)
  // `detail` alarga el mensaje y no toca `hint`: lo leído que no sirve, para quien diagnostica.
  const d = new FormatError('shapefile', 'crs', 0, null, 'PROJCS["x"]')
  assert.deepEqual([d.message, d.hint], ['shapefile: crs (byte 0): PROJCS["x"]', null])
  assert.ok(esFormatError(e, 'kml'))
  assert.ok(!esFormatError(e, 'gpx'))
})

test('asBytes: por tipo explícito y respetando byteOffset (SPECS §17.3-6)', () => {
  const datos = Uint8Array.of(1, 2, 3, 250)
  for (const [nombre, entrada] of formasBinarias(datos)) {
    const b = asBytes(entrada)
    assert.ok(b instanceof Uint8Array, nombre)
    assert.deepEqual([...b], [1, 2, 3, 250], nombre)
  }
  assert.deepEqual([...asBytes('ñ')], [0xC3, 0xB1])
  ;[null, undefined, 12, {}, [1, 2], new Blob([])].forEach(x => assert.equal(asBytes(x), null))
  // Comparte memoria: no copia.
  const v = vistaEnvenenada(datos)
  assert.equal(asBytes(v).buffer, v.buffer)
})

test('bomSkip: 3 con BOM UTF-8, 0 sin él o con menos de 3 bytes', () => {
  assert.equal(bomSkip(Uint8Array.of(0xEF, 0xBB, 0xBF, 0x3C)), 3)
  assert.equal(bomSkip(Uint8Array.of(0xEF, 0xBB)), 0)
  assert.equal(bomSkip(Uint8Array.of(0x3C)), 0)
  assert.equal(bomSkip(new Uint8Array(0)), 0)
})

test('hexBytes: mayúsculas y minúsculas; impar o carácter no hex es entrada con el índice', async () => {
  assert.deepEqual([...hexBytes('0101000000000000000000F03F', 'wkb')], [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xF0, 0x3F])
  assert.deepEqual([...hexBytes('', 'wkb')], [])
  assert.equal((await fallaCon(() => hexBytes('010', 'wkb'), 'entrada', 'wkb')).at, 3)
  assert.equal((await fallaCon(() => hexBytes('01zz', 'wkb'), 'entrada', 'wkb')).at, 2)
  assert.equal((await fallaCon(() => hexBytes('0g', 'wkb'), 'entrada', 'wkb')).at, 1)
  assert.equal((await fallaCon(() => hexBytes('01ñ1', 'wkb'), 'entrada', 'wkb')).at, 2)
  await fallaCon(() => hexBytes(null, 'wkb'), 'entrada', 'wkb')
})
