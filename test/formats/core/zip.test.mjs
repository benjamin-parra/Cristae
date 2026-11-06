// Zip del núcleo (DISENO-INTEROP §2.7 y §5-7). Dos fixtures hex escritos a mano campo por campo validan al
// generador del test (§5-3bis); el generador arma los casos adversarios.

import test from 'node:test'
import assert from 'node:assert/strict'
import { crc32 as zlibCrc } from 'node:zlib'
import { listZip, unzipEntry } from '../../../src/formats/core/zip.js'
import { fallaCon, fuzz } from '../comun.mjs'

const hex = texto => Uint8Array.from(texto.replace(/#.*$/gm, '').match(/[0-9a-f]{2}/gi), h => parseInt(h, 16))
const enc = new TextEncoder()

// APPNOTE §4.3.7, §4.3.12 y §4.3.16: un archivo `a.txt` con «hi», guardado (método 0).
const STORED = hex(`
  50 4b 03 04   # encabezado local
  14 00         # versión necesaria 2.0
  00 00         # banderas
  00 00         # método 0, stored
  00 00 00 00   # hora y fecha
  ac 2a 93 d8   # CRC-32 de «hi»
  02 00 00 00   # comprimido
  02 00 00 00   # sin comprimir
  05 00 00 00   # largo de nombre 5, extra 0
  61 2e 74 78 74  68 69          # «a.txt», «hi»
  50 4b 01 02   # directorio central, offset 37
  14 00 14 00   # versión hecha por, necesaria
  00 00 00 00   # banderas, método
  00 00 00 00   # hora y fecha
  ac 2a 93 d8  02 00 00 00  02 00 00 00
  05 00 00 00 00 00   # nombre 5, extra 0, comentario 0
  00 00 00 00 00 00 00 00   # disco, atributos internos y externos
  00 00 00 00   # offset del encabezado local
  61 2e 74 78 74
  50 4b 05 06   # EOCD, offset 88
  00 00 00 00   # disco, disco del directorio
  01 00 01 00   # entradas en este disco, total
  33 00 00 00   # tamaño del directorio, 51
  25 00 00 00   # offset del directorio, 37
  00 00         # comentario
`)

// El mismo archivo con método 8 y un bloque deflate «stored» (RFC 1951 §3.2.4): BFINAL=1 BTYPE=00,
// LEN=2, NLEN=~2, «hi».
const DEFLATE = hex(`
  50 4b 03 04  14 00  00 00  08 00  00 00 00 00
  ac 2a 93 d8  07 00 00 00  02 00 00 00  05 00 00 00
  61 2e 74 78 74
  01 02 00 fd ff 68 69           # el flujo deflate crudo
  50 4b 01 02  14 00 14 00  00 00 08 00  00 00 00 00
  ac 2a 93 d8  07 00 00 00  02 00 00 00
  05 00 00 00 00 00  00 00 00 00 00 00 00 00  00 00 00 00
  61 2e 74 78 74
  50 4b 05 06  00 00 00 00  01 00 01 00
  33 00 00 00  2a 00 00 00  00 00
`)

// ── Generador ─────────────────────────────────────────────────────────────────────────────────────

const deflate = async data => new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())

const u16 = v => [v & 0xFF, v >>> 8 & 0xFF]
const u32 = v => [v & 0xFF, v >>> 8 & 0xFF, v >>> 16 & 0xFF, v >>> 24 & 0xFF]

// Cada entrada: { name, data, method = 8, flags = 0, crc?, size?, localExtra?, centralExtra?, zeroLocal? }.
// `eocd` sobrescribe campos del EOCD; `comment` va al final.
const armarZip = async (entradas, { comment = new Uint8Array(0), eocd = {}, prefijo = [] } = {}) => {
  const locales = [], centrales = []
  let offset = prefijo.length
  for (const e of entradas) {
    const method  = e.method ?? 8
    const packed  = e.packed ?? (method === 8 ? await deflate(e.data) : e.data)
    const name    = enc.encode(e.name)
    const crc     = e.crc ?? zlibCrc(e.data)
    const size    = e.size ?? e.data.length
    const lExtra  = e.localExtra ?? []
    const cExtra  = e.centralExtra ?? []
    const flags   = e.flags ?? 0
    const enLocal = v => e.zeroLocal ? 0 : v
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(flags), ...u16(method), ...u32(0),
      ...u32(enLocal(crc)), ...u32(enLocal(packed.length)), ...u32(enLocal(size)),
      ...u16(name.length), ...u16(lExtra.length), ...name, ...lExtra, ...packed,
    ]
    centrales.push(
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(flags), ...u16(method), ...u32(0),
      ...u32(crc), ...u32(packed.length), ...u32(size),
      ...u16(name.length), ...u16(cExtra.length), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(offset), ...name, ...cExtra,
    )
    locales.push(...local)
    offset += local.length
  }
  const f = { disk: 0, cdDisk: 0, onDisk: entradas.length, total: entradas.length, size: centrales.length, start: offset, ...eocd }
  return Uint8Array.from([
    ...prefijo, ...locales, ...centrales,
    ...u32(0x06054b50), ...u16(f.disk), ...u16(f.cdDisk), ...u16(f.onDisk), ...u16(f.total),
    ...u32(f.size), ...u32(f.start), ...u16(comment.length), ...comment,
  ])
}

const leerTodo = async (bytes, maxBytes) => {
  const salida = []
  for (const e of listZip(bytes, 'kmz')) salida.push(await unzipEntry(bytes, e, 'kmz', maxBytes))
  return salida
}

const texto = b => new TextDecoder().decode(b)

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────────

test('los fixtures a mano: stored y deflate dan «hi» con los campos del directorio central', async () => {
  for (const [bytes, method, packed, data] of [[STORED, 0, 2, 35], [DEFLATE, 8, 7, 35]]) {
    const [e] = listZip(bytes, 'kmz')
    assert.deepEqual(e, { name: 'a.txt', method, flags: 0, crc: 0xd8932aac, size: 2, packed, data })
    assert.equal(texto(await unzipEntry(bytes, e, 'kmz')), 'hi')
  }
})

test('el generador reproduce byte a byte el fixture stored escrito a mano', async () => {
  assert.deepEqual(await armarZip([{ name: 'a.txt', data: enc.encode('hi'), method: 0 }]), STORED)
})

test('varias entradas, stored y deflate, con nombre UTF-8 (bit 11)', async () => {
  const grande = enc.encode('<kml>'.repeat(5000))
  const bytes  = await armarZip([
    { name: 'doc.kml', data: grande },
    { name: 'ícono.png', data: Uint8Array.of(1, 2, 3), method: 0, flags: 0x800 },
  ])
  const entradas = listZip(bytes, 'kmz')
  assert.deepEqual(entradas.map(e => e.name), ['doc.kml', 'ícono.png'])
  const [kml, png] = await leerTodo(bytes)
  assert.equal(kml.length, grande.length)
  assert.equal(texto(kml.subarray(0, 10)), '<kml><kml>')
  assert.deepEqual([...png], [1, 2, 3])
})

test('CRC alterado es compresion, en stored y en deflate', async () => {
  for (const method of [0, 8]) {
    const bytes = await armarZip([{ name: 'a', data: enc.encode('hola'), method, crc: 1234 }])
    await fallaCon(() => leerTodo(bytes), 'compresion', 'kmz')
  }
})

test('cifrado y método desconocido son compresion', async () => {
  await fallaCon(async () => leerTodo(await armarZip([{ name: 'a', data: enc.encode('x'), flags: 1 }])), 'compresion')
  await fallaCon(async () => leerTodo(await armarZip([{ name: 'a', data: enc.encode('x'), method: 12, packed: enc.encode('BZh') }])), 'compresion')
})

test('bomba: infla de más que lo declarado es compresion; declarar de más también', async () => {
  const datos = new Uint8Array(1 << 20)
  await fallaCon(async () => leerTodo(await armarZip([{ name: 'a', data: datos, size: 1000 }])), 'compresion')
  await fallaCon(async () => leerTodo(await armarZip([{ name: 'a', data: enc.encode('corto'), size: 5000 }])), 'compresion')
  await fallaCon(async () => leerTodo(await armarZip([{ name: 'a', data: enc.encode('corto'), method: 0, size: 7 }])), 'compresion')
})

test('tamaño declarado sobre maxBytes es tope, antes de inflar', async () => {
  const bytes = await armarZip([{ name: 'a', data: new Uint8Array(4096) }])
  const e = await fallaCon(() => leerTodo(bytes, 4095), 'tope', 'kmz')
  assert.equal(e.at, listZip(bytes, 'kmz')[0].data)
  assert.equal((await leerTodo(bytes, 4096))[0].length, 4096)
})

test('flujo deflate corrupto es compresion', async () => {
  const bytes = await armarZip([{ name: 'a', data: enc.encode('hola'), packed: Uint8Array.of(0xFF, 0xFF, 0xFF, 0xFF) }])
  await fallaCon(() => leerTodo(bytes), 'compresion')
})

test('zip64 y multidisco son version', async () => {
  const datos = [{ name: 'a', data: enc.encode('x') }]
  await fallaCon(async () => listZip(await armarZip(datos, { eocd: { total: 0xFFFF, onDisk: 0xFFFF } }), 'kmz'), 'version')
  await fallaCon(async () => listZip(await armarZip(datos, { eocd: { start: 0xFFFFFFFF } }), 'kmz'), 'version')
  await fallaCon(async () => listZip(await armarZip(datos, { eocd: { disk: 1 } }), 'kmz'), 'version')
  const conLocalizador = await armarZip(datos)
  const fin = conLocalizador.length - 22
  const conLoc = Uint8Array.from([...conLocalizador.subarray(0, fin), ...u32(0x07064b50), ...new Array(16).fill(0), ...conLocalizador.subarray(fin)])
  await fallaCon(() => listZip(conLoc, 'kmz'), 'version')
})

test('EOCD: comentario de 65535 bytes con una firma falsa adentro', async () => {
  const comment = new Uint8Array(65535).fill(0x20)
  // Una firma EOCD falsa a 100 bytes del final, con un largo de comentario que no llega al final.
  comment.set([0x50, 0x4b, 0x05, 0x06], 65535 - 100)
  const bytes = await armarZip([{ name: 'doc.kml', data: enc.encode('<kml/>') }], { comment })
  assert.equal(texto((await leerTodo(bytes))[0]), '<kml/>')
})

test('sin EOCD, o con menos de 22 bytes, es formato', async () => {
  await fallaCon(() => listZip(enc.encode('no soy un zip, pero tengo más de veintidós bytes'), 'kmz'), 'formato')
  await fallaCon(() => listZip(new Uint8Array(3), 'kmz'), 'formato')
})

test('el comienzo de los datos sale del encabezado LOCAL, aunque su extra difiera del central', async () => {
  const bytes = await armarZip([{ name: 'a.kml', data: enc.encode('<kml/>'), localExtra: [1, 2, 3, 4, 5, 6, 7, 8], centralExtra: [] }])
  assert.equal(texto((await leerTodo(bytes))[0]), '<kml/>')
})

test('bit 3: ceros en el encabezado local, el directorio central manda', async () => {
  const bytes = await armarZip([{ name: 'a.kml', data: enc.encode('<kml>bit3</kml>'), flags: 8, zeroLocal: true }])
  assert.equal(texto((await leerTodo(bytes))[0]), '<kml>bit3</kml>')
})

test('truncados: directorio o datos que no caben; firmas que no son', async () => {
  const bueno = await armarZip([{ name: 'a', data: enc.encode('hola mundo') }])
  await fallaCon(async () => listZip(await armarZip([{ name: 'a', data: enc.encode('x') }], { eocd: { size: 4000 } }), 'kmz'), 'truncado')
  await fallaCon(async () => listZip(await armarZip([{ name: 'a', data: enc.encode('x') }], { eocd: { total: 300, onDisk: 300 } }), 'kmz'), 'truncado')
  // Encabezado local con firma rota.
  const roto = bueno.slice()
  roto[0] = 0
  await fallaCon(() => listZip(roto, 'kmz'), 'estructura')
  // Directorio central con firma rota.
  const central = bueno.slice()
  central[bueno.length - 22 - 46 - 1] = 0
  await fallaCon(() => listZip(central, 'kmz'), 'estructura')
  // `packed` que no cabe: se recorta el archivo pero se deja el EOCD.
  const e = listZip(bueno, 'kmz')[0]
  const mentiroso = await armarZip([{ name: 'a', data: enc.encode('hola mundo'), packed: new Uint8Array(0) }])
  const v = new DataView(mentiroso.buffer)
  v.setUint32(mentiroso.length - 22 - 46 - 1 + 20, 1 << 20, true)
  await fallaCon(() => listZip(mentiroso, 'kmz'), 'truncado')
  assert.equal(e.size, 10)
})

test('sin DecompressionStream es entorno', async () => {
  const original = globalThis.DecompressionStream
  try {
    globalThis.DecompressionStream = undefined
    await fallaCon(() => leerTodo(DEFLATE), 'entorno')
    globalThis.DecompressionStream = class { constructor() { throw new TypeError('deflate-raw no') } }
    await fallaCon(() => leerTodo(DEFLATE), 'entorno')
  } finally { globalThis.DecompressionStream = original }
  // Stored no necesita el stream.
  assert.equal(texto((await leerTodo(STORED))[0]), 'hi')
})

test('fuzz de mutación: sólo FormatError y la vista envenenada no cambia nada', { timeout: 60000 }, async () => {
  const semillas = [
    ['stored', STORED],
    ['deflate', DEFLATE],
    ['dos', await armarZip([{ name: 'doc.kml', data: enc.encode('<kml>'.repeat(40)) }, { name: 'b', data: enc.encode('xy'), method: 0 }])],
  ]
  const { leidos, rechazados } = await fuzz(b => leerTodo(b), semillas, {
    casos: 150, formato: 'kmz', comparar: (a, b) => assert.deepEqual(a.map(x => [...x]), b.map(x => [...x])),
  })
  assert.ok(rechazados > 0 && leidos + rechazados === 450)
})
