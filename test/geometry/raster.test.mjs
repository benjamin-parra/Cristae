// Decodificador de tiles de altura (geometry/raster.js). Las referencias no salen del decodificador: el
// tile real se compara contra PIL (los siete píxeles y el hash de los 196 608 bytes RGB, que las alturas
// Terrarium devuelven sin pérdida), los sintéticos contra las alturas que dan por la fórmula de su
// codificación los bytes que se codificaron —con los filtros de ida escritos con la fórmula de la
// especificación PNG, que no comparte aritmética con el desfiltrado— y el WebP, sin decodificador en Node,
// con `createImageBitmap` y `OffscreenCanvas` de mentira que sólo cuentan y devuelven píxeles fijos.
// Corre con: node --test test/geometry/raster.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { decodeTile } from '../../src/geometry/raster.js'

const FIXTURE = readFileSync(new URL('../fixtures/terrarium-12-1217-2501.png', import.meta.url))
const SHA256  = bytes => createHash('sha256').update(bytes).digest('hex')

const NO_PNG  = '[terrain] este entorno no decodifica PNG: le falta DecompressionStream'
const NO_WEBP = '[terrain] este entorno no decodifica WebP: usa una fuente PNG, como terrainPresets.aws'
const ALTERED = '[terrain] este navegador altera los píxeles que lee (protección anti-fingerprinting): usa una fuente PNG, como terrainPresets.aws'

// ── Codificador de PNG del test ───────────────────────────────────────────────────────────────

const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n

  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

const crc32 = bytes => {
  let c = 0xFFFFFFFF

  for (const v of bytes) c = CRC[(c ^ v) & 255] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length)

  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  out.set(data, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

const header = ({ width, height, depth = 8, color, compression = 0, filter = 0, interlace = 0 }) => {
  const out = Buffer.alloc(13)

  out.writeUInt32BE(width, 0)
  out.writeUInt32BE(height, 4)
  out.set([depth, color, compression, filter, interlace], 8)
  return out
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
const END       = chunk('IEND', Buffer.alloc(0))

// Un PNG con las filas ya filtradas en `raw`; `pieces` parte el flujo zlib en varios IDAT.
const encode = ({ raw, pieces = 1, ihdr, extra = [], end = true }) => {
  const z    = deflateSync(raw)
  const step = Math.ceil(z.length / pieces)
  const idat = Array.from({ length: pieces }, (_, i) => chunk('IDAT', z.subarray(i * step, (i + 1) * step)))

  return Buffer.concat([SIGNATURE, ...(ihdr ? [chunk('IHDR', header(ihdr))] : []), ...extra, ...idat, ...(end ? [END] : [])])
}

// Los filtros de ida, con la fórmula de la especificación: el predictor se calcula sobre los píxeles
// originales, y el predictor de Paeth con p = a + b − c.
const paeth = (a, b, c) => {
  const p  = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)

  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

const filtered = (px, width, height, bpp, filterOf) => {
  const row = width * bpp
  const out = Buffer.alloc(height * (row + 1))

  for (let y = 0; y < height; y++) {
    const f = filterOf(y)

    out[y * (row + 1)] = f

    for (let i = 0; i < row; i++) {
      const x          = px[y * row + i]
      const a          = i >= bpp ? px[y * row + i - bpp] : 0
      const b          = y ? px[(y - 1) * row + i] : 0
      const c          = i >= bpp && y ? px[(y - 1) * row + i - bpp] : 0
      const prediction = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f]

      out[y * (row + 1) + 1 + i] = (x - prediction) & 255
    }
  }

  return out
}

// Bytes de pixel pseudoaleatorios de todo el rango, para que los desfiltrados envuelvan.
const noise = n => {
  let s = 12345

  return Uint8Array.from({ length: n }, () => (s = (s * 1103515245 + 12345) & 0x7FFFFFFF) >>> 16 & 255)
}

// Las alturas de unos píxeles por la fórmula de su codificación, y NaN con alfa 0.
const heightsOf = (px, bpp, encoding = 'terrarium') =>
  Float32Array.from({ length: px.length / bpp }, (_, k) => {
    const [r, g, b, a] = px.subarray(k * bpp, k * bpp + bpp)

    return bpp === 4 && a === 0 ? NaN
      : encoding === 'mapbox' ? -10000 + (r * 65536 + g * 256 + b) * 0.1
      : r * 256 + g + b / 256 - 32768
  })

// Los bytes RGB de unas alturas Terrarium: el Float32 guarda sus 24 bits sin pérdida.
const terrariumBytes = heights =>
  Uint8Array.from({ length: heights.length * 3 }, (_, k) => {
    const v = heights[Math.floor(k / 3)] + 32768

    return [Math.floor(v / 256), Math.floor(v) % 256, v % 1 * 256][k % 3]
  })

// ── El tile real de AWS ───────────────────────────────────────────────────────────────────────

test('el fixture es el tile 12/1217/2501 de AWS, intacto', () => {
  assert.equal(SHA256(FIXTURE), '9a3fc0644593481ef798b949db387098aa00d74f45a72767a65452ae096afa69')
})

test('el tile real (filtros 1, 2 y 4) da lo mismo que PIL', async () => {
  const bytes = new Uint8Array(FIXTURE)
  const tile  = await decodeTile(bytes, 'terrarium')

  assert.deepEqual([tile.width, tile.height, tile.heights.length], [256, 256, 65536])

  const at = (x, y) => Array.from(terrariumBytes(tile.heights.subarray(y * 256 + x, y * 256 + x + 1)))

  assert.deepEqual(at(0, 0),     [128, 13, 0])
  assert.deepEqual(at(255, 0),   [128, 184, 0])
  assert.deepEqual(at(0, 255),   [128, 241, 0])
  assert.deepEqual(at(255, 255), [128, 191, 0])
  assert.deepEqual(at(128, 127), [128, 170, 0])
  assert.deepEqual(at(128, 128), [128, 166, 0])
  assert.deepEqual(at(17, 200),  [128, 152, 0])
  assert.equal(SHA256(terrariumBytes(tile.heights)), '191dbe3774021d8d68d6f94849e47ef016784210c21c34271663d6aaf42b710e')
  assert.equal(SHA256(bytes), SHA256(FIXTURE), 'los bytes de entrada no se tocan')
})

test('una vista con byteOffset decodifica igual que el buffer propio', async () => {
  const wide = new Uint8Array(FIXTURE.length + 7)

  wide.set(FIXTURE, 5)

  const tile = await decodeTile(wide.subarray(5, 5 + FIXTURE.length), 'terrarium')

  assert.equal(SHA256(terrariumBytes(tile.heights)), '191dbe3774021d8d68d6f94849e47ef016784210c21c34271663d6aaf42b710e')
})

// ── PNG sintético: los cinco filtros, RGB y RGBA ──────────────────────────────────────────────

for (const [name, color, bpp] of [['RGB', 2, 3], ['RGBA', 6, 4]])
  for (let shift = 0; shift < 5; shift++)
    test(`PNG ${name} de 7 × 5 con los filtros 0-4 desde el ${shift}: las alturas de los bytes que se codificaron`, async () => {
      const width  = 7
      const height = 5
      const px     = noise(width * height * bpp)
      const raw    = filtered(px, width, height, bpp, y => (y + shift) % 5)
      const tile   = await decodeTile(new Uint8Array(encode({ raw, ihdr: { width, height, color } })), 'terrarium')

      assert.deepEqual([tile.width, tile.height], [width, height])
      assert.deepEqual(tile.heights, heightsOf(px, bpp))
    })

for (const filter of [1, 3, 4])
  test(`PNG de una columna con el filtro ${filter}: sin vecino a la izquierda`, async () => {
    const px   = noise(6 * 3)
    const raw  = filtered(px, 1, 6, 3, () => filter)
    const tile = await decodeTile(new Uint8Array(encode({ raw, ihdr: { width: 1, height: 6, color: 2 } })), 'terrarium')

    assert.deepEqual(tile.heights, heightsOf(px, 3))
  })

test('varios IDAT, chunks auxiliares y bytes después de IEND', async () => {
  const px    = noise(7 * 5 * 3)
  const raw   = filtered(px, 7, 5, 3, y => y % 5)
  const bytes = encode({ raw, pieces: 4, ihdr: { width: 7, height: 5, color: 2 }, extra: [chunk('tEXt', Buffer.from('Software\0test'))] })
  const tile  = await decodeTile(new Uint8Array(Buffer.concat([bytes, Buffer.from('basura tras IEND')])), 'terrarium')

  assert.deepEqual(tile.heights, heightsOf(px, 3))
})

test('Terrain-RGB con encoding mapbox, y NaN donde el alfa es 0', async () => {
  const px     = noise(7 * 5 * 3)
  const mapbox = await decodeTile(new Uint8Array(encode({ raw: filtered(px, 7, 5, 3, () => 0), ihdr: { width: 7, height: 5, color: 2 } })), 'mapbox')

  assert.deepEqual(mapbox.heights, heightsOf(px, 3, 'mapbox'))

  const rgba = Uint8Array.from([200, 1, 2, 0, 128, 3, 64, 1, 128, 3, 64, 255])
  const tile = await decodeTile(new Uint8Array(encode({ raw: filtered(rgba, 3, 1, 4, () => 0), ihdr: { width: 3, height: 1, color: 6 } })), 'terrarium')

  assert.deepEqual(Array.from(tile.heights), [NaN, 3.25, 3.25])
})

// ── PNG que se rechaza, con su motivo ─────────────────────────────────────────────────────────

test('lo que no se puede leer rechaza con su motivo', async () => {
  const raw   = filtered(noise(7 * 5 * 3), 7, 5, 3, () => 0)
  const ihdr  = { width: 7, height: 5, color: 2 }
  const valid = encode({ raw, ihdr })
  const z     = deflateSync(raw)
  const cases = [
    ['bytes basura',            Buffer.from('esto no es una imagen, ni de lejos'),                                 'no es PNG ni WebP'],
    ['vacío',                   Buffer.alloc(0),                                                                   'no es PNG ni WebP'],
    ['RIFF que no es WebP',     Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]),    'no es PNG ni WebP'],
    ['sólo la firma',           SIGNATURE,                                                                         'PNG truncado'],
    ['IDAT cortado a la mitad', valid.subarray(0, valid.length - 40),                                              'PNG truncado'],
    ['sin IEND',                encode({ raw, ihdr, end: false }),                                                 'PNG truncado'],
    ['sin IHDR',                encode({ raw }),                                                                   'PNG sin IHDR'],
    ['IHDR de 12 bytes',        encode({ raw, extra: [chunk('IHDR', header(ihdr).subarray(0, 12))] }),             'PNG sin IHDR'],
    ['16 bits',                 encode({ raw, ihdr: { ...ihdr, depth: 16 } }),                                     'PNG de 16 bits: solo se lee 8'],
    ['color 3 (paleta)',        encode({ raw, ihdr: { ...ihdr, color: 3 } }),                                      'PNG de tipo de color 3: solo RGB (2) y RGBA (6)'],
    ['color 0 (gris)',          encode({ raw, ihdr: { ...ihdr, color: 0 } }),                                      'PNG de tipo de color 0: solo RGB (2) y RGBA (6)'],
    ['entrelazado',             encode({ raw, ihdr: { ...ihdr, interlace: 1 } }),                                  'PNG entrelazado'],
    ['método de compresión',    encode({ raw, ihdr: { ...ihdr, compression: 1 } }),                                'PNG con método de compresión o de filtro desconocido'],
    ['método de filtro',        encode({ raw, ihdr: { ...ihdr, filter: 1 } }),                                     'PNG con método de compresión o de filtro desconocido'],
    ['filtro 5 en la fila 2',   encode({ raw: filtered(noise(7 * 5 * 3), 7, 5, 3, y => y === 2 ? 5 : 0), ihdr }),  'PNG con el filtro 5 en la fila 2'],
    ['flujo zlib truncado',     Buffer.concat([SIGNATURE, chunk('IHDR', header(ihdr)), chunk('IDAT', z.subarray(0, z.length - 6)), END]), 'PNG con datos corruptos'],
    ['sin IDAT',                Buffer.concat([SIGNATURE, chunk('IHDR', header(ihdr)), END]),                      'PNG con datos corruptos'],
    ['más filas que datos',     encode({ raw, ihdr: { ...ihdr, height: 6 } }),                                     'PNG con 110 bytes de datos; 132 esperados'],
    ['más datos que filas',     encode({ raw, ihdr: { ...ihdr, height: 4 } }),                                     'PNG con más datos que los 88 bytes esperados'],
  ]

  for (const [name, bytes, message] of cases)
    await assert.rejects(decodeTile(new Uint8Array(bytes)), { message }, name)
})

test('un flujo zlib corrupto trae la causa', async () => {
  const raw        = filtered(noise(7 * 5 * 3), 7, 5, 3, () => 0)
  const bytes      = encode({ raw, ihdr: { width: 7, height: 5, color: 2 } })
  const zlibHeader = bytes.indexOf('IDAT') + 4

  bytes[zlibHeader] ^= 0xFF
  await assert.rejects(decodeTile(new Uint8Array(bytes)), error => error.message === 'PNG con datos corruptos' && error.cause instanceof Error)
})

// Un DecompressionStream que cuenta lo que entrega: el inflado de un tile de 7 × 5 que declara 110 bytes y
// trae 16 MiB se corta en la primera parte que pasa del tope, sin inflar el resto.
test('un flujo que infla de más se corta sin inflarlo entero', async () => {
  const Inflate = globalThis.DecompressionStream
  let delivered = 0

  globalThis.DecompressionStream = class {
    constructor(format) {
      const inflate = new Inflate(format)

      this.writable = inflate.writable
      this.readable = inflate.readable.pipeThrough(new TransformStream({ transform: (part, out) => { delivered += part.length; out.enqueue(part) } }))
    }
  }

  try {
    const bytes = Buffer.concat([SIGNATURE, chunk('IHDR', header({ width: 7, height: 5, color: 2 })), chunk('IDAT', deflateSync(Buffer.alloc(16 << 20))), END])

    await assert.rejects(decodeTile(new Uint8Array(bytes)), { message: 'PNG con más datos que los 110 bytes esperados' })
    assert.ok(delivered < 1 << 20, `inflados ${delivered} bytes`)
  } finally { globalThis.DecompressionStream = Inflate }
})

test('sin DecompressionStream el PNG rechaza con el mensaje de entorno, no con el del tile', async () => {
  const Inflate = globalThis.DecompressionStream

  delete globalThis.DecompressionStream

  try { await assert.rejects(decodeTile(new Uint8Array(FIXTURE)), { message: NO_PNG }) }
  finally { globalThis.DecompressionStream = Inflate }
})

// ── WebP: la plataforma, con canario ──────────────────────────────────────────────────────────

const WEBP_HEAD = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(20)])
const TILE_WEBP = new Uint8Array(Buffer.concat([WEBP_HEAD, Buffer.alloc(8)]))

// Los píxeles fijos del tile de 3 × 2 que entrega la plataforma de mentira.
const TILE_PIXELS = Uint8ClampedArray.from({ length: 24 }, (_, i) => i * 10)

// sha256 de los 238 B del canario WebP de raster.js (64 × 64, sin pérdida), cuyos 4 096 píxeles se
// verificaron con PIL: la plataforma de mentira lo reconoce por sus bytes, así que un canario corrupto en
// raster.js no se decodifica como íntegro.
const CANARY_SHA256 = '457e68d8fcd21f0ae83da35619dba6b211ed6795c9ab49462d30daed6fe60f19'

// Instala createImageBitmap y OffscreenCanvas de mentira (o los quita, con `null`) y devuelve el registro de
// llamadas. El canario sale con el patrón de la doc, del tamaño `size` (64 × 64 si falta) y con un bit del
// canal c del píxel (x, y) invertido si `altered` es [x, y, c]; cualquier otro WebP es un tile de 3 × 2 de
// píxeles fijos. Con `canvasThrows`, el OffscreenCanvas del tile lanza al construirse.
const withPlatform = async (config, run) => {
  const saved = [globalThis.createImageBitmap, globalThis.OffscreenCanvas]
  const log   = { calls: [], bitmaps: [], canvases: [], order: [] }

  if (config === null) {
    delete globalThis.createImageBitmap
    delete globalThis.OffscreenCanvas
  } else {
    globalThis.createImageBitmap = async (blob, options) => {
      log.calls.push({ size: blob.size, type: blob.type, options })

      const canary = SHA256(new Uint8Array(await blob.arrayBuffer())) === CANARY_SHA256

      if (config.reject === 'all' || config.reject === 'tile' && !canary) throw new Error('imagen rota')

      const [width, height] = canary ? config.size ?? [64, 64] : [3, 2]
      const bitmap          = { width, height, canary, closed: false, close() { this.closed = true; log.order.push('close') } }

      log.bitmaps.push(bitmap)
      return bitmap
    }
    globalThis.OffscreenCanvas = class {
      constructor(width, height) {
        if (config.canvasThrows && !log.bitmaps.at(-1).canary) throw new Error('canvas roto')
        log.canvases.push([width, height])
      }

      getContext(kind, options) {
        log.canvases.at(-1).push(kind, options.willReadFrequently)
        let canary = false

        return {
          drawImage: bitmap => { assert.equal(bitmap.closed, false); canary = bitmap.canary; log.order.push('draw') },
          getImageData: (x, y, width, height) => {
            log.order.push('read')
            assert.deepEqual([x, y], [0, 0])
            if (!canary) return { data: TILE_PIXELS }

            const data = new Uint8ClampedArray(width * height * 4)

            for (let j = 0; j < height; j++)
              for (let i = 0; i < width; i++)
                data.set([(37 * i + 11 * j) % 256, (13 * i + 71 * j + 128) % 256, (7 * i * j + 3) % 256, 255], (j * width + i) * 4)
            if (config.altered) {
              const [ax, ay, channel] = config.altered

              data[(ay * width + ax) * 4 + channel] ^= 1
            }
            return { data }
          },
        }
      }
    }
  }

  try { return await run(log) }
  finally {
    globalThis.createImageBitmap = saved[0]
    globalThis.OffscreenCanvas   = saved[1]
    saved[0] === undefined && delete globalThis.createImageBitmap
    saved[1] === undefined && delete globalThis.OffscreenCanvas
  }
}

let fresh = 0
const importRaster = () => import(`../../src/geometry/raster.js?realm=${++fresh}`)

test('WebP en un entorno sin createImageBitmap ni OffscreenCanvas: el mensaje de entorno, siempre', async () => {
  await withPlatform(null, async () => {
    const { decodeTile: decode } = await importRaster()

    await assert.rejects(decode(TILE_WEBP), { message: NO_WEBP })
    await assert.rejects(decode(TILE_WEBP), { message: NO_WEBP })
  })
})

test('sin createImageBitmap pero con OffscreenCanvas, tampoco', async () => {
  await withPlatform({}, async () => {
    delete globalThis.createImageBitmap

    const { decodeTile: decode } = await importRaster()

    await assert.rejects(decode(TILE_WEBP), { message: NO_WEBP })
  })
})

test('el canario es perezoso: importar o decodificar un PNG no toca la plataforma', async () => {
  await withPlatform({}, async log => {
    const { decodeTile: decode } = await importRaster()

    assert.equal(log.calls.length, 0, 'importar')
    await decode(new Uint8Array(FIXTURE))
    assert.equal(log.calls.length, 0, 'un PNG')
  })
})

test('WebP con la plataforma íntegra: pasa el canario una sola vez y entrega las alturas de sus RGBA 8 bits', async () => {
  await withPlatform({}, async log => {
    const { decodeTile: decode } = await importRaster()
    const tile = await decode(TILE_WEBP, 'terrarium')

    assert.deepEqual([tile.width, tile.height], [3, 2])
    assert.deepEqual(tile.heights, heightsOf(TILE_PIXELS, 4))
    assert.equal(log.calls.length, 2, 'canario y tile')
    assert.equal(log.calls[0].size, 238)
    assert.equal(log.calls[1].size, 40)

    for (const call of log.calls) {
      assert.equal(call.type, 'image/webp')
      assert.deepEqual(call.options, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
    }

    assert.deepEqual(log.canvases, [[64, 64, '2d', true], [3, 2, '2d', true]])
    assert.ok(log.bitmaps.every(bitmap => bitmap.closed), 'los bitmaps se cierran')
    assert.deepEqual(log.order, ['draw', 'close', 'read', 'draw', 'close', 'read'])

    await decode(TILE_WEBP)
    assert.equal(log.calls.length, 3, 'el segundo tile no repite el canario')
  })
})

for (const [what, config] of [
  ['R del píxel (0, 0)',   { altered: [0, 0, 0] }],
  ['G del píxel (17, 40)', { altered: [17, 40, 1] }],
  ['B del píxel (63, 63)', { altered: [63, 63, 2] }],
  ['A del píxel (30, 5)',  { altered: [30, 5, 3] }],
  ['64 × 65',              { size: [64, 65] }],
])
  test(`el canario alterado (${what}) rechaza todo WebP del realm sin leer el tile`, async () => {
    await withPlatform(config, async log => {
      const { decodeTile: decode } = await importRaster()

      await assert.rejects(decode(TILE_WEBP), { message: ALTERED })
      await assert.rejects(decode(TILE_WEBP), { message: ALTERED })
      assert.equal(log.calls.length, 1, 'el veredicto queda en la promesa del módulo')
    })
  })

test('un canario que la plataforma no puede decodificar cuenta como falta de WebP', async () => {
  await withPlatform({ reject: 'all' }, async () => {
    const { decodeTile: decode } = await importRaster()

    await assert.rejects(decode(TILE_WEBP), { message: NO_WEBP })
  })
})

test('un WebP roto con el canario íntegro rechaza con su motivo y la causa', async () => {
  await withPlatform({ reject: 'tile' }, async () => {
    const { decodeTile: decode } = await importRaster()

    await assert.rejects(decode(TILE_WEBP), error => error.message === 'WebP ilegible' && error.cause.message === 'imagen rota')
  })
})

test('si el canvas del tile falla, el bitmap se cierra igual', async () => {
  await withPlatform({ canvasThrows: true }, async log => {
    const { decodeTile: decode } = await importRaster()

    await assert.rejects(decode(TILE_WEBP), error => error.message === 'WebP ilegible' && error.cause.message === 'canvas roto')
    assert.equal(log.bitmaps.length, 2, 'canario y tile')
    assert.ok(log.bitmaps.every(bitmap => bitmap.closed), 'los bitmaps se cierran')
  })
})

test('el canario es de cada realm: dos copias del módulo hacen cada una el suyo', async () => {
  await withPlatform({}, async log => {
    const first  = await importRaster()
    const second = await importRaster()

    await first.decodeTile(TILE_WEBP)
    await second.decodeTile(TILE_WEBP)
    assert.equal(log.calls.length, 4)
  })
})
