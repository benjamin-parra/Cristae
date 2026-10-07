// Terreno y relieve (geometry/terrain.js), sin red: el `fetch` es un stub que arma cada tile pedido con
// una altura conocida, evaluada en el centro de cada píxel con la Mercator escrita acá (la forma
// ln tan, no la atanh sen del código) y codificada en Terrarium o Mapbox. Las referencias son rampas en
// metros de pendiente conocida, el área de la base, fracciones de celdas contadas a mano, la geographiclib
// para el elipsoide y el tile real de AWS con los valores de PIL.
// Corre con: node --test test/geometry/terrain.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { build } from 'esbuild'
import geodesic from 'geographiclib-geodesic'
import { terrain, terrainPresets, relief, elevation } from '../../src/geometry/terrain.js'
import { area, perimeter, diameter } from '../../src/geometry/measure.js'
import { sphere, distance } from '../../src/geometry/geodesic.js'
import { boundsOf } from '../../src/geometry/bounds.js'
import { WGS84, ellipsoid } from '../../src/geometry/ellipsoid.js'
import { ring, arc } from '../../src/geometry/shape.js'

const R         = 6371008.8             // radio medio IUGG R1 (m)
const RAD       = Math.PI / 180
const MODEL     = Symbol.for('cristae.geometry.model')
const AREA      = Symbol.for('cristae.geometry.area')
const ELEVATION = Symbol.for('cristae.geometry.elevation')
const RELIEF    = Symbol.for('cristae.geometry.relief')
const raiz      = fileURLToPath(new URL('../../', import.meta.url))

const cerca = (real, ref, tol, msg) =>
  assert.ok(Math.abs(real - ref) <= tol * Math.abs(ref), `${msg}: ${real} vs ${ref}`)
const esNaN = (valor, msg) => assert.ok(Number.isNaN(valor), `${msg}: ${valor}`)
const suma  = valores => valores.reduce((a, b) => a + b, 0)

// ── La grilla del test: tiles de 64 a z14, 2^20 píxeles por vuelta, celdas de ~30 m ─────────────

const FUENTE = { url: 'https://t.test/{z}/{x}/{y}.png', encoding: 'terrarium', zoom: 14, tileSize: 64 }

const lngDe = (x, n = 2 ** 20) => x / n * 360 - 180
const latDe = (y, n = 2 ** 20) => (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * y / n))) - Math.PI / 2) / RAD

// El píxel de referencia, cerca de (−37, −73): columna 20 y fila 20 del tile (4869, 10007).
const PX   = 4869 * 64 + 20
const PY   = 10007 * 64 + 20
const LAT0 = latDe(PY + 0.5)
const LNG0 = lngDe(PX + 0.5)

// Una caja de 12 tiles: oeste en x = 64·4869 + 1,5 (el margen baja a 4868), este en 64·4871 + 40,2;
// norte en y = 64·10007 + 1,2 (el margen sube a 10006), sur en 64·10008 + 30,6.
const CAJA = {
  south : latDe(64 * 10008 + 30.6),
  west  : lngDe(64 * 4869 + 1.5),
  north : latDe(64 * 10007 + 1.2),
  east  : lngDe(64 * 4871 + 40.2),
}

// Un rectángulo de esquinas en grados, como anillo.
const rect = (south, west, north, east) => [[south, west], [south, east], [north, east], [north, west]]
// El rectángulo de los píxeles [x0, x1) × [y0, y1), con las esquinas en esquinas de píxel.
const celdas = (x0, y0, x1, y1) => rect(latDe(y1), lngDe(x0), latDe(y0), lngDe(x1))
// El rectángulo centrado en el centro del píxel (x, y), de medio lado `m` metros en la esfera.
const centrado = (x, y, m) => {
  const lat = latDe(y + 0.5)
  const lng = lngDe(x + 0.5)
  const dLat = m / R / RAD
  const dLng = m / (R * Math.cos(lat * RAD)) / RAD
  return rect(lat - dLat, lng - dLng, lat + dLat, lng + dLng)
}

// ── PNG y stub de fetch ──────────────────────────────────────────────────────────────────────

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

// Un PNG de `lado` × `lado`, RGB o RGBA según lo que devuelva `pixel(x, y)`, sin filtro.
const png = (lado, pixel) => {
  const bpp = pixel(0, 0).length
  const raw = Buffer.alloc(lado * (1 + lado * bpp))
  for (let y = 0; y < lado; y++)
    for (let x = 0; x < lado; x++) raw.set(pixel(x, y), y * (1 + lado * bpp) + 1 + x * bpp)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(lado, 0)
  ihdr.writeUInt32BE(lado, 4)
  ihdr.set([8, bpp === 4 ? 6 : 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// Las dos codificaciones, escritas desde su definición; `terrariumDe` es la altura que decodifica el tile.
const terrarium   = h => {
  const v = h + 32768
  return [Math.floor(v / 256), Math.floor(v) % 256, Math.floor((v - Math.floor(v)) * 256)]
}
const mapbox      = h => (c => [c >> 16 & 255, c >> 8 & 255, c & 255])(Math.round((h + 10000) * 10))
const terrariumDe = h => (([r, g, b]) => r * 256 + g + b / 256 - 32768)(terrarium(h))

const respuesta = (status, bytes) => ({
  ok          : status >= 200 && status < 300,
  status,
  arrayBuffer : async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
})

// Un mundo de alturas `h(lat, lng)` servido como tiles, plano a 500 m si no se da: `estados` responde un
// código a esas URLs, `pixel` reemplaza la codificación y `lado` el tamaño del PNG. Registra las URLs, las
// señales y los receptores.
const mundo = ({ h = () => 500, lado = 64, codificar = terrarium, pixel, estados = {}, bytes = {} } = {}) => {
  const urls      = []
  const senales   = []
  const receptores = []
  const fetch = function (url, { signal }) {
    urls.push(url)
    senales.push(signal)
    receptores.push(this)
    if (estados[url]) return Promise.resolve(respuesta(estados[url], new Uint8Array(0)))
    if (bytes[url]) return Promise.resolve(respuesta(200, bytes[url]))
    const [z, tx, ty] = url.match(/(\d+)\/(\d+)\/(\d+)/).slice(1).map(Number)
    const n           = lado * 2 ** z
    return Promise.resolve(respuesta(200, png(lado, pixel ?? ((x, y) =>
      codificar(h(latDe(ty * lado + y + 0.5, n), lngDe(tx * lado + x + 0.5, n)))))))
  }
  return { fetch, urls, senales, receptores }
}

// Rampa norte–sur de pendiente s: h lineal en los metros al norte, exacta en la esfera.
const rampa = (s, opciones = {}) => mundo({ h: lat => 1000 + s * R * (lat - LAT0) * RAD, ...opciones })

// La caja de un anillo, con un poco de holgura.
const cajaDe = (anillo, holgura = 0.002) => {
  const lats = anillo.map(p => p[0])
  const lngs = anillo.map(p => p[1])
  return { south: Math.min(...lats) - holgura, west: Math.min(...lngs) - holgura, north: Math.max(...lats) + holgura, east: Math.max(...lngs) + holgura }
}

// El terreno de la caja de un anillo, servido por el mundo `m`, sobre la esfera o sobre `base`.
const cargar = (m, anillo, base = sphere()) => terrain(base, FUENTE, cajaDe(anillo), { fetch: m.fetch })

// ── Qué se pide ──────────────────────────────────────────────────────────────────────────────

test('pide exactamente los tiles de la caja con su margen de 2 celdas, con fetch suelto', async () => {
  const m = mundo()
  await terrain(FUENTE, CAJA, { fetch: m.fetch })
  const esperadas = []
  for (const y of [10006, 10007, 10008])
    for (const x of [4868, 4869, 4870, 4871]) esperadas.push(`https://t.test/14/${x}/${y}.png`)
  assert.deepEqual([...m.urls].sort(), esperadas.sort())
  assert.ok(m.receptores.every(r => r === undefined), 'fetch se llama sin receptor')
})

test('una caja sobre el antimeridiano pide x = 2^z − 1 y x = 0', async () => {
  const m = mundo()
  await terrain(FUENTE, { south: -37.01, west: 179.99, north: -37, east: 180.01 }, { fetch: m.fetch })
  assert.deepEqual([...new Set(m.urls.map(u => u.split('/')[4]))].sort(), ['0', '16383'])
})

test('la plantilla admite cualquier lugar para {z}, {x} e {y}', async () => {
  const m = mundo()
  const fuente = { ...FUENTE, url: 'https://t.test/{z}/{x}/{y}.png?key=abc&z={z}' }
  await terrain(fuente, cajaDe(centrado(PX, PY, 5)), { fetch: m.fetch })
  assert.ok(m.urls.every(u => u.endsWith('?key=abc&z=14')), m.urls[0])
})

test('maxTiles excedido rechaza con RangeError sin llamar a fetch', async () => {
  const m = mundo()
  await assert.rejects(terrain(FUENTE, cajaDe(centrado(PX, PY, 5000)), { fetch: m.fetch, maxTiles: 2 }),
    { name: 'RangeError', message: /la caja pide \d+ tiles a z=14; el tope es 2/ })
  assert.equal(m.urls.length, 0)
})

test('una fuente, una caja o un tope inválido rechaza sin llamar a fetch', async () => {
  const m    = mundo()
  const caja = cajaDe(centrado(PX, PY, 50))
  const casos = [
    [{ ...FUENTE, zoom: 16, maxZoom: 15 }, caja, RangeError, /zoom tiene que ser un entero en \[0, 15\]: 16/],
    [{ ...FUENTE, zoom: 14.5 }, caja, RangeError, /zoom/],
    [{ ...FUENTE, zoom: 25 }, caja, RangeError, /zoom/],
    [{ ...FUENTE, maxZoom: 25 }, caja, RangeError, /maxZoom/],
    [{ ...FUENTE, tileSize: 0 }, caja, RangeError, /tileSize tiene que ser un entero ≥ 1: 0/],
    [{ ...FUENTE, encoding: 'x' }, caja, RangeError, /encoding desconocido: x/],
    [{ ...FUENTE, url: 'https://t.test/{z}/{x}.png' }, caja, TypeError, /source.url tiene que llevar/],
    [{ ...FUENTE, attribution: 42 }, caja, TypeError, /attribution/],
    [null, caja, TypeError, /source.url/],
    [FUENTE, { south: 1, west: 2, north: 0, east: 3 }, TypeError, /bounds no es una caja/],
    [FUENTE, null, TypeError, /bounds no es una caja/],
    [FUENTE, { south: 85, west: 0, north: 86, east: 1 }, RangeError, /más allá de ±85,0511°/],
    [FUENTE, { south: -86, west: 0, north: -85, east: 1 }, RangeError, /más allá/],
  ]
  for (const [fuente, b, tipo, mensaje] of casos)
    await assert.rejects(terrain(fuente, b, { fetch: m.fetch }), { name: tipo.name, message: mensaje }, String(mensaje))
  await assert.rejects(terrain(FUENTE, caja, { fetch: m.fetch, maxTiles: 0 }), { name: 'RangeError', message: /maxTiles/ })
  assert.equal(m.urls.length, 0)
})

test('la base tiene que ser un modelo construido que mide áreas, y no un terreno', async () => {
  const m    = mundo()
  const zona = centrado(PX, PY, 50)
  const t    = await cargar(m, zona)
  const sinArea = { [MODEL]: () => 0 }
  for (const base of [sinArea, t])
    await assert.rejects(terrain(base, FUENTE, cajaDe(zona), { fetch: m.fetch }),
      { name: 'TypeError', message: '[terrain] el modelo base tiene que medir áreas y no ser un terreno' })
  await assert.rejects(terrain(sphere, FUENTE, cajaDe(zona), { fetch: m.fetch }), { name: 'TypeError' })
})

// ── Fallos y cancelación ─────────────────────────────────────────────────────────────────────

// Un pedido que sólo termina si lo abortan, como el `fetch` real. Los tests que lo usan llevan tope de
// tiempo: si el terreno no aborta lo que está en vuelo, se quedan esperando.
const PENDIENTE = (url, { signal }) => new Promise((_, rechazar) =>
  signal.addEventListener('abort', () => rechazar(signal.reason), { once: true }))

test('todos los tiles 404 o 204 rechaza con «ningún tile»', async () => {
  const caja = cajaDe(centrado(PX, PY, 50))
  const fetch = url => Promise.resolve(respuesta(url.endsWith('10007.png') ? 404 : 204, new Uint8Array(0)))
  await assert.rejects(terrain(FUENTE, caja, { fetch }), { message: '[terrain] ningún tile de la caja trae datos a z=14' })
})

test('un 403 rechaza, y aborta los pedidos que estaban en vuelo', { timeout: 5000 }, async () => {
  const senales = []
  const fetch = (url, init) => {
    senales.push(init.signal)
    return senales.length === 3 ? Promise.resolve(respuesta(403, new Uint8Array(0))) : PENDIENTE(url, init)
  }
  await assert.rejects(terrain(FUENTE, cajaDe(centrado(PX, PY, 1500)), { fetch }), { message: /^\[terrain\] https:\/\/t\.test\/14\/\d+\/\d+\.png respondió 403$/ })
  assert.ok(senales.length >= 3 && senales.every(s => s.aborted))
})

test('seis pedidos en vuelo, ni uno más', { timeout: 5000 }, async () => {
  const control = new AbortController()
  const motivo  = new Error('basta')
  const senales = []
  const fetch   = (url, init) => {
    senales.push(init.signal)
    return PENDIENTE(url, init)
  }
  const carga = terrain(FUENTE, CAJA, { fetch, signal: control.signal })
  await new Promise(setImmediate)
  assert.equal(senales.length, 6, 'la caja pide 12 tiles y ninguno termina')
  control.abort(motivo)
  await assert.rejects(carga, e => e === motivo)
})

test('si fetch rechaza sin abort, rechaza «no respondió» con la causa', async () => {
  const causa = new TypeError('fallo de red')
  const fetch = () => Promise.reject(causa)
  await assert.rejects(terrain(FUENTE, cajaDe(centrado(PX, PY, 50)), { fetch }), error => {
    assert.match(error.message, /^\[terrain\] https:\/\/t\.test\/14\/\d+\/\d+\.png no respondió$/)
    assert.equal(error.cause, causa)
    return true
  })
})

test('una señal abortada antes rechaza con su reason sin llamar a fetch', async () => {
  const m      = mundo()
  const motivo = new Error('ya no')
  await assert.rejects(terrain(FUENTE, cajaDe(centrado(PX, PY, 50)), { fetch: m.fetch, signal: AbortSignal.abort(motivo) }), e => e === motivo)
  assert.equal(m.urls.length, 0)
})

test('abortar a la mitad rechaza con la reason y aborta lo que el stub recibió', { timeout: 5000 }, async () => {
  const control = new AbortController()
  const motivo  = new Error('cancelado')
  const senales = []
  const fetch   = (url, init) => {
    senales.push(init.signal)
    senales.length === 2 && queueMicrotask(() => control.abort(motivo))
    return PENDIENTE(url, init)
  }
  await assert.rejects(terrain(FUENTE, cajaDe(centrado(PX, PY, 1500)), { fetch, signal: control.signal }), e => e === motivo)
  assert.ok(senales.length >= 2 && senales.every(s => s.aborted))
})

test('abortar a la mitad rechaza con la reason aunque el fetch ignore la señal y responda', async () => {
  // El mundo responde sin mirar la señal. Cuando se aborta, en el pedido 8 de 12, ya hay tiles servidos:
  // sin mirar la señal al final, la carga terminaría con un terreno.
  const m       = mundo()
  const control = new AbortController()
  const motivo  = new Error('cancelado')
  let pedidos   = 0
  const fetch   = (url, init) => {
    ++pedidos === 8 && control.abort(motivo)
    return m.fetch(url, init)
  }
  await assert.rejects(terrain(FUENTE, CAJA, { fetch, signal: control.signal }), e => e === motivo)
})

test('un tile de otro tamaño, o ilegible, rechaza con la URL; el entorno, con su propio mensaje', async () => {
  const caja = cajaDe(centrado(PX, PY, 50))
  await assert.rejects(terrain(FUENTE, caja, { fetch: mundo({ lado: 32 }).fetch }),
    { message: /^\[terrain\] https:\/\/t\.test\/14\/\d+\/\d+\.png mide 32×32; se esperaban 64×64$/ })
  const basura = () => Promise.resolve(respuesta(200, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])))
  await assert.rejects(terrain(FUENTE, caja, { fetch: basura }),
    { message: /^\[terrain\] https:\/\/t\.test\/14\/\d+\/\d+\.png no es un tile legible: no es PNG ni WebP$/ })
  const webp = new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')])
  await assert.rejects(terrain(FUENTE, caja, { fetch: () => Promise.resolve(respuesta(200, webp)) }),
    { message: '[terrain] este entorno no decodifica WebP: usa una fuente PNG, como terrainPresets.aws' })
  const Inflate = globalThis.DecompressionStream
  delete globalThis.DecompressionStream
  try { await assert.rejects(terrain(FUENTE, caja, { fetch: mundo().fetch }), { message: '[terrain] este entorno no decodifica PNG: le falta DecompressionStream' }) }
  finally { globalThis.DecompressionStream = Inflate }
})

// ── El terreno que devuelve ──────────────────────────────────────────────────────────────────

test('bounds, zoom, cellSize y attribution', async () => {
  const t = await terrain(FUENTE, CAJA, { fetch: mundo().fetch })
  assert.deepEqual(t.bounds, CAJA)
  assert.notEqual(t.bounds, CAJA)
  assert.ok(Object.isFrozen(t) && Object.isFrozen(t.bounds))
  assert.equal(t.zoom, 14)
  assert.equal(t.attribution, '')
  // Filas de 64·10007 − 1 a 64·10008 + 32: H = 98, y la del medio es la 49.
  const fila = 64 * 10007 - 1 + 49
  cerca(t.cellSize, R * Math.cos(latDe(fila + 0.5) * RAD) * 2 * Math.PI / 2 ** 20, 1e-6, 'cellSize')
  const conCredito = await terrain({ ...FUENTE, attribution: '© alguien' }, CAJA, { fetch: mundo().fetch })
  assert.equal(conCredito.attribution, '© alguien')
})

test('terrainPresets: dos proveedores públicos de la misma grilla', () => {
  const { aws, mapterhorn } = terrainPresets
  assert.equal(aws.tileSize * 2 ** aws.zoom, 2 ** 20)
  assert.equal(mapterhorn.tileSize * 2 ** mapterhorn.zoom, 2 ** 20)
  for (const p of [aws, mapterhorn]) {
    assert.equal(p.encoding, 'terrarium')
    assert.ok(p.zoom <= p.maxZoom && p.attribution.length > 0)
    for (const k of ['{z}', '{x}', '{y}']) assert.ok(p.url.includes(k))
  }
})

// ── Pendiente ────────────────────────────────────────────────────────────────────────────────

// Terrarium cuantiza a 1/256 m y Terrain-RGB a 0,1 m: sobre los 61 m de Horn, ±0,002 de banda.
test('rampa norte–sur de 0,3: la pendiente es 0,3 en toda la zona, en las dos codificaciones', async () => {
  const zona = centrado(PX, PY, 500)
  for (const [encoding, codificar, tol] of [['terrarium', terrarium, 1e-3], ['mapbox', mapbox, 1e-2]]) {
    const r = relief(await terrain({ ...FUENTE, encoding }, cajaDe(zona), { fetch: rampa(0.3, { codificar }).fetch }), zona)
    cerca(r.slope.mean, 0.3, 1e-3, `${encoding}, media`)
    cerca(r.slope.min, 0.3, tol, `${encoding}, mínimo`)
    cerca(r.slope.max, 0.3, tol, `${encoding}, máximo`)
  }
})

// Con celdas de ~300 km, la latitud del centro de la fila importa: el alto de dos celdas tomado entre
// bordes en vez de centros se corre ~2 %.
test('rampa norte–sur sobre celdas grandes: los pasos se miden entre centros de fila', async () => {
  const n      = 16 * 2 ** 3
  const fuente = { ...FUENTE, zoom: 3, tileSize: 16 }
  const lat0   = latDe(78.5, n)
  const fetch  = mundo({ lado: 16, h: lat => 1000 + 0.01 * R * (lat - lat0) * RAD }).fetch
  const zona   = rect(latDe(79, n), lngDe(40, n), latDe(78, n), lngDe(41, n))
  const r      = relief(await terrain(fuente, cajaDe(zona, 0.1), { fetch }), zona)
  assert.equal(r.cells, 1)
  cerca(r.slope.mean, 0.01, 1e-5, 'pendiente')
})

// La pendiente es √(0,2² + 0,15²) = 0,25. En la esfera la Mercator es conforme y el ancho y el alto de
// una celda casi coinciden; en un elipsoide achatado difieren un 26 %, y cruzarlos ya no pasa.
test('rampa diagonal de 0,2 al este y 0,15 al norte: pendiente 0,25, también sobre un elipsoide achatado', async () => {
  const zona = centrado(PX, PY, 500)
  const h    = (lat, lng) => 1000 + 0.2 * R * Math.cos(lat * RAD) * (lng - LNG0) * RAD + 0.15 * R * (lat - LAT0) * RAD
  const r    = relief(await cargar(mundo({ h }), zona), zona)
  cerca(r.slope.mean, 0.25, 1e-3, 'esfera, media')
  cerca(r.slope.min, 0.25, 1e-3, 'esfera, mínimo')
  cerca(r.slope.max, 0.25, 1e-3, 'esfera, máximo')

  const a   = 6371008.8
  const f   = 0.2
  const e2  = f * (2 - f)
  const ref = new geodesic.Geodesic.Geodesic(a, f)
  const hE  = (lat, lng) => 1000
    + 0.2 * a / Math.sqrt(1 - e2 * Math.sin(lat * RAD) ** 2) * Math.cos(lat * RAD) * (lng - LNG0) * RAD
    + 0.15 * Math.sign(lat - LAT0) * ref.Inverse(LAT0, LNG0, lat, LNG0).s12
  const rE  = relief(await cargar(mundo({ h: hE }), zona, ellipsoid(a, f)), zona)
  cerca(rE.slope.mean, 0.25, 1e-3, 'elipsoide, media')
  cerca(rE.slope.max, 0.25, 1e-3, 'elipsoide, máximo')
})

// ── Áreas por clase ──────────────────────────────────────────────────────────────────────────

test('rampa de 0,3: cada m² horizontal aporta √1,09 m² de superficie a su clase', async () => {
  const zona = centrado(PX, PY, 500)
  const A    = area(zona)
  const S    = A * Math.sqrt(1.09)
  const t    = await cargar(rampa(0.3), zona)
  const casos = [[[0.25, 0.35], [0, S, 0]], [[0.2], [0, S]], [[0.4], [S, 0]], [[], [S]], [undefined, [S]]]
  for (const [cortes, esperado] of casos) {
    const r = relief(t, zona, cortes)
    assert.equal(r.slope.areas.length, esperado.length)
    r.slope.areas.forEach((v, k) => (esperado[k] ? cerca(v, esperado[k], 1e-6, `${cortes} clase ${k}`) : assert.equal(v, 0)))
    assert.equal(r.noData, 0)
  }
})

test('terreno plano, cortes [0]: la pendiente 0 cae en la clase de arriba', async () => {
  const zona = centrado(PX, PY, 500)
  const r    = relief(await cargar(mundo(), zona), zona, [0])
  assert.equal(r.slope.areas[0], 0)
  cerca(r.slope.areas[1], area(zona), 1e-12, 'clase de arriba')
  assert.deepEqual([r.slope.min, r.slope.max, r.slope.mean], [0, 0, 0])
})

// ── Alturas ──────────────────────────────────────────────────────────────────────────────────

test('una zona dentro de una sola celda hereda su altura', async () => {
  const zona  = centrado(PX, PY, 1)
  const valor = Math.fround(terrariumDe(1234.567))
  const r     = relief(await cargar(mundo({ h: () => 1234.567 }), zona), zona)
  assert.equal(r.cells, 1)
  assert.equal(r.elevation.min, valor)
  assert.equal(r.elevation.max, valor)
  cerca(r.elevation.mean, valor, 1e-12, 'media')
  assert.notEqual(valor, Math.round(valor), 'la altura no es entera')
})

test('el tile real de AWS: la celda que contiene (−36,985, −72,993) vale 170,0 m', async () => {
  const fixture = new Uint8Array(readFileSync(new URL('../fixtures/terrarium-12-1217-2501.png', import.meta.url)))
  const url     = 'https://t.test/12/1217/2501.png'
  const fuente  = { ...FUENTE, zoom: 12, tileSize: 256 }
  const n       = 256 * 2 ** 12
  // El píxel (128, 127) del tile, con PIL (128, 170, 0).
  const x       = 1217 * 256 + 128
  const y       = 2501 * 256 + 127
  const zona    = rect(latDe(y + 0.6, n), lngDe(x + 0.4, n), latDe(y + 0.4, n), lngDe(x + 0.6, n))
  const t       = await terrain(fuente, cajaDe(zona, 0.001), { fetch: mundo({ bytes: { [url]: fixture } }).fetch })
  const r       = relief(t, zona)
  assert.equal(r.cells, 1)
  assert.equal(r.elevation.min, 170)
  assert.equal(r.elevation.max, 170)
  assert.ok(r.slope.mean >= 0 && r.slope.mean < 1)
})

test('rectángulo de 1 km centrado sobre la rampa: la altura media es la de su centro', async () => {
  const zona = centrado(PX, PY, 500)
  const r    = relief(await cargar(rampa(0.3), zona), zona)
  assert.ok(Math.abs(r.elevation.mean - 1000) <= 0.01, `${r.elevation.mean}`)
  assert.ok(r.elevation.min < 1000 - 140 && r.elevation.max > 1000 + 140)
})

// El hueco va al norte del centro: restarlo baja la media, sumarlo la subiría.
test('polígono con hueco sobre la rampa: el hueco se resta, en altura y en superficie', async () => {
  const exterior = centrado(PX, PY, 500)
  const hueco    = centrado(PX, PY - 8, 120).reverse()
  const zona     = [exterior, hueco]
  const r        = relief(await cargar(rampa(0.3), exterior), zona)
  const aE       = area(exterior)
  const aH       = area(hueco)
  const hH       = 1000 + 0.3 * R * (latDe(PY - 8 + 0.5) - LAT0) * RAD
  assert.ok(Math.abs(r.elevation.mean - (aE * 1000 - aH * hH) / (aE - aH)) <= 0.01, `${r.elevation.mean}`)
  cerca(suma(r.slope.areas), area(zona) * Math.sqrt(1.09), 1e-6, 'superficie')
  assert.equal(r.noData, 0)
})

// ── Sin dato ─────────────────────────────────────────────────────────────────────────────────

// La zona va de la columna 64·4869 + 54 a la 64·4870 + 10: 20 columnas, y el tile del este responde
// 404. Quedan sin dato sus 10 columnas y la pegada a él, que pierde una vecina de Horn: 11 de 20. Las
// filas pesan lo mismo en cada columna, así que la fracción es exacta.
test('un tile 404 al este: noData es la fracción de celdas sin dato, contando la pegada al 404', async () => {
  const x0     = 64 * 4870 - 10
  const zona   = [celdas(x0, PY, x0 + 20, PY + 10), celdas(x0 + 4, PY + 3, x0 + 8, PY + 6)]
  const m      = mundo({ estados: { 'https://t.test/14/4870/10007.png': 404 } })
  const t      = await cargar(m, zona[0])
  const r      = relief(t, zona, [0.1])
  // El hueco cae en el oeste, con dato: no cambia lo que falta.
  cerca(r.noData, area(zona[0]) * 11 / 20, 1e-6, 'noData')
  cerca(suma(r.slope.areas) + r.noData, area(zona), 1e-12, 'Σ areas + noData')
  assert.equal(r.slope.areas[1], 0)
  assert.equal(r.cells, 9 * 10 - 4 * 3)
  assert.ok(m.urls.includes('https://t.test/14/4870/10007.png'))
})

// Las aristas oblicuas pasan por celdas parciales de todas las formas: la parte sin dato se recorta en
// el plano de los píxeles, a mano, y se mide con el área de la base.
test('un triángulo que cruza el 404: noData es el área de la parte sin dato', async () => {
  const xc       = 64 * 4870 - 1                                         // la pegada al 404 tampoco tiene dato
  const pixeles  = [[xc - 13.6, PY - 7.3], [xc + 9.1, PY + 11.8], [xc - 4.4, PY + 15.2]]
  const aGrados  = puntos => puntos.map(([x, y]) => [latDe(y), lngDe(x)])
  const parte    = pixeles.flatMap(([x, y], i) => {
    const [xq, yq] = pixeles[(i + 1) % 3]
    const cruce    = (x >= xc) !== (xq >= xc) ? [[xc, y + (xc - x) / (xq - x) * (yq - y)]] : []
    return [...(x >= xc ? [[x, y]] : []), ...cruce]
  })
  const triangulo = aGrados(pixeles)
  const m         = mundo({ estados: { 'https://t.test/14/4870/10007.png': 404 } })
  const r         = relief(await cargar(m, triangulo), triangulo)
  cerca(r.noData, area(aGrados(parte)), 1e-4, 'noData')
  cerca(r.slope.areas[0] + r.noData, area(triangulo), 1e-12, 'Σ areas + noData')
})

test('un píxel de alfa 0 no tiene dato', async () => {
  const zona  = centrado(PX, PY, 1)
  const pixel = (x, y) => [...terrarium(500), x === 20 && y === 20 ? 0 : 255]
  const r     = relief(await cargar(mundo({ pixel }), zona), zona)
  assert.equal(r.cells, 0)
  esNaN(r.elevation.mean, 'altura')
  cerca(r.noData, area(zona), 1e-12, 'noData')
})

test('el área que relief reparte se compone como la de area: huecos que restan, partes que suman, anillos de 2 vértices en 0', async () => {
  const exterior = centrado(PX, PY, 200)
  const zona     = [[exterior, centrado(PX, PY, 60), exterior.slice(0, 2)], [centrado(PX + 30, PY, 50)]]
  const pixel    = () => [...terrarium(500), 0]
  const r        = relief(await cargar(mundo({ pixel }), zona.flat(2)), zona)
  assert.equal(r.cells, 0)
  assert.equal(r.noData, area(zona), 'sin dato, noData es el área de la base, bit a bit')
})

// ── Bordes ───────────────────────────────────────────────────────────────────────────────────

test('relief: las zonas vacías, inválidas o fuera de la caja', async () => {
  const zona  = centrado(PX, PY, 50)
  const t     = await cargar(mundo(), zona)
  const vacia = { cells: 0, elevation: { min: NaN, max: NaN, mean: NaN }, slope: { min: NaN, max: NaN, mean: NaN, areas: [0, 0] }, noData: 0 }
  const nula  = { cells: 0, elevation: { min: NaN, max: NaN, mean: NaN }, slope: { min: NaN, max: NaN, mean: NaN, areas: [NaN, NaN] }, noData: NaN }
  const lejos = [zona[3][0], zona[3][1] - 1]
  for (const z of [null, undefined, [], [[]], [null], [zona[0]], [zona[0], zona[1]], [lejos], [zona[0], lejos]])
    assert.deepEqual(relief(t, z, [0.1]), vacia, JSON.stringify(z))
  for (const z of [[...zona, null], { lat: 0, lng: 0 }, 42, [...zona.slice(0, 3), lejos]])
    assert.deepEqual(relief(t, z, [0.1]), nula, JSON.stringify(z))
  assert.deepEqual(relief(t, [zona, [zona[0], lejos]], [0.1]), relief(t, zona, [0.1]), 'un hueco de 2 vértices fuera de la caja no cuenta')
  assert.deepEqual(relief(t, [...zona, zona[0]], [0.1]), relief(t, zona, [0.1]), 'el cierre repetido no cambia nada')
  // La longitud se lleva a [west, west + 360): la zona escrita una vuelta más al este es la misma,
  // salvo el redondeo de llevarla.
  const otraVuelta = relief(t, zona.map(([lat, lng]) => [lat, lng + 360]), [0.1])
  assert.equal(otraVuelta.cells, 25)
  cerca(otraVuelta.slope.areas[0], relief(t, zona, [0.1]).slope.areas[0], 1e-9, 'una vuelta más')
})

test('relief con la caja exacta de la zona: los vértices del borde siguen en la caja', async () => {
  // Llevada por el módulo a [west, west + 360), la longitud del borde este sale un ulp al este en cerca
  // de 4 de cada 10 cajas: con la caja de `boundsOf`, sin holgura, la zona entera daría NaN.
  const m = mundo()
  for (let i = 0; i < 10; i++) {
    const zona = centrado(PX + i, PY + i, 40 + 7 * i)
    const r    = relief(await terrain(FUENTE, boundsOf(zona), { fetch: m.fetch }), zona)
    assert.ok(r.cells > 0 && r.noData === 0, `zona ${i}: ${JSON.stringify(r)}`)
  }
})

test('relief con la caja exacta de la zona desenvuelta: la zona escrita envuelta sigue en la caja', async () => {
  // La caja de la zona sin envolver, que pasa de 180; la zona, escrita con la longitud envuelta. Al
  // llevarla a [west, west + 360) por el módulo, el borde este sale un ulp al este en cerca de 1 de cada 4
  // cajas (aquí, en 4 de las 12): la zona entera daría NaN. Los lados no son simétricos respecto de un
  // meridiano de la grilla, porque entonces west y east redondean igual y el ulp no aparece.
  const m = mundo()
  for (let i = 0; i < 12; i++) {
    const envuelta = rect(-37.01 - i / 1000, 180 - 0.0003 * (i + 1) / 1.7, -37 - i / 1000, -180 + 0.0002 * (i + 2) / 1.3)
    const suelta   = envuelta.map(([lat, lng]) => [lat, lng < 0 ? lng + 360 : lng])
    const t        = await terrain(FUENTE, boundsOf(suelta), { fetch: m.fetch })
    const r        = relief(t, envuelta)
    assert.ok(r.cells > 0 && r.noData === 0, `zona ${i}: ${JSON.stringify(r)}`)
    assert.equal(r.cells, relief(t, suelta).cells, `zona ${i}`)
  }
})

test('relief, elevation y distance: una longitud un ulp por debajo de west + 360 queda al oeste de la caja', async () => {
  // El double más alto con lng − 360 < west: está en [west, west + 360) y fuera de la caja, pero
  // (lng − west) / 360 redondea a 1.
  const zona = centrado(PX, PY, 50)
  const t    = await cargar(mundo(), zona)
  const west = t.bounds.west
  const lng  = new Float64Array([west + 360])
  const bits = new BigInt64Array(lng.buffer)
  while (lng[0] - 360 >= west) bits[0]--
  assert.equal(Math.floor((lng[0] - west) / 360), 1, 'la división redondea a una vuelta entera')
  const r = relief(t, [...zona.slice(0, 3), [zona[3][0], lng[0]]])
  assert.equal(r.cells, 0)
  esNaN(r.noData, 'noData')
  esNaN(elevation(t, [zona[3][0], lng[0]]), 'elevation')
  esNaN(distance(t, zona[0], [zona[3][0], lng[0]]), 'distance, extremo')
  esNaN(distance(t, [zona[3][0], lng[0]], zona[0]), 'distance, origen')
})

test('relief: el primer argumento es un terreno y los cortes son finitos, ≥ 0 y crecientes', async () => {
  const zona = centrado(PX, PY, 50)
  const t    = await cargar(mundo(), zona)
  for (const malo of [sphere(), WGS84, null, {}])
    assert.throws(() => relief(malo, zona), { name: 'TypeError', message: '[relief] el primer argumento tiene que ser un terreno: await terrain(…)' })
  for (const cortes of [null, 0.3, '0.3', { length: 1, 0: 0.3 }])
    assert.throws(() => relief(t, zona, cortes), { name: 'TypeError', message: '[relief] breaks tiene que ser un array de cortes' })
  // eslint-disable-next-line no-sparse-arrays
  for (const cortes of [[0.3, 0.2], [0.2, 0.2], [NaN], [-0.1], [Infinity], ['0.3'], [0.1, , 0.3]])
    assert.throws(() => relief(t, zona, cortes), { name: 'RangeError', message: '[relief] breaks: números finitos ≥ 0, en orden estrictamente creciente' }, String(cortes))
})

// ── El terreno como modelo ──────────────────────────────────────────────────────────────────

const S03  = Math.sqrt(1.09)                        // √(1 + s²) de una rampa de 0,3
const S01  = Math.sqrt(1.01)                        // y de las dos partes de un quiebre
const S04  = Math.sqrt(1.16)
const LATN = n => latDe(PY + 0.5 - n)               // n celdas al norte del píxel de referencia
const LNGE = n => lngDe(PX + 0.5 + n)               // n celdas al este
const ESF  = new geodesic.Geodesic.Geodesic(R, 0)   // la esfera de la base, por la geographiclib
const geo  = (a, b) => ESF.Inverse(a[0], a[1], b[0], b[1]).s12

// Un quiebre de pendiente en el centro del píxel de referencia, en metros sobre la esfera: 0,1 al sur y
// 0,4 al norte (`ns`), o 0,1 al oeste y 0,4 al este (`eo`). Con el quiebre en un centro de celda, la
// bilineal de la grilla es la misma quebrada, así que un tramo que lo cruza mide la suma de sus dos
// partes por su √(1 + s²); un muestreo más grueso que media celda o la grilla corrida no.
const quiebre = {
  ns : lat => 1000 + (lat > LAT0 ? 0.4 : 0.1) * R * (lat - LAT0) * RAD,
  eo : (lat, lng) => 1000 + (lng > LNG0 ? 0.4 : 0.1) * R * Math.cos(LAT0 * RAD) * (lng - LNG0) * RAD,
}

test('el terreno es un modelo congelado con las cuatro marcas, y no es una base', async () => {
  const t = await cargar(mundo(), centrado(PX, PY, 100))
  assert.ok(Object.isFrozen(t))
  for (const marca of [MODEL, AREA, ELEVATION, RELIEF]) assert.equal(typeof t[marca], 'function', String(marca))
  for (const marca of ['destination', 'heading'])
    assert.equal(t[Symbol.for(`cristae.geometry.${marca}`)], undefined, `sin ${marca}: mide sobre el relieve`)
  await assert.rejects(terrain(t, FUENTE, cajaDe(centrado(PX, PY, 100)), { fetch: mundo().fetch }),
    { name: 'TypeError', message: '[terrain] el modelo base tiene que medir áreas y no ser un terreno' })
})

test('un terreno no coloca formas, pero la forma colocada sobre su base se mide sobre el relieve', async () => {
  const zona  = centrado(PX, PY, 500)
  const forma = { center: [LAT0, LNG0], radius: 200, heading: 30, sweep: 120 }
  const t     = await cargar(mundo(), zona)
  assert.throws(() => ring(t, forma), { name: 'TypeError', message: '[ring] coloca la forma en horizontal: pasa el modelo base, no el terreno' })
  assert.throws(() => arc(t, forma), { name: 'TypeError', message: '[arc] coloca la forma en horizontal: pasa el modelo base, no el terreno' })
  assert.throws(() => ring(t, null), { name: 'TypeError' }, 'también con una forma ausente')
  const colocada = ring(sphere(), forma)
  assert.equal(area(t, colocada), area(sphere(), colocada), 'terreno plano: el área es la de la base')
  cerca(perimeter(t, colocada), perimeter(sphere(), colocada), 1e-12, 'perímetro')
})

test('terreno plano: el área es la de la base bit a bit; la distancia y el perímetro, a 1e-12', async () => {
  const zona = centrado(PX, PY, 500)
  for (const base of [sphere(), WGS84]) {
    const t = await cargar(mundo(), zona, base)
    assert.equal(area(t, zona), area(base, zona))
    const a = [LATN(-9), LNGE(-7)]
    const b = [LATN(11), LNGE(10)]
    cerca(distance(t, a, b), distance(base, a, b), 1e-12, 'distance')
    cerca(perimeter(t, zona), perimeter(base, zona), 1e-12, 'perimeter')
  }
})

test('rampa N–S de 0,3: el área es la de la base por √(1 + s²), también en una zona menor que una celda', async () => {
  const zona = centrado(PX, PY, 500)
  const t    = await cargar(rampa(0.3), zona)
  cerca(area(t, zona), area(zona) * S03, 1e-4, 'área')
  const chica = centrado(PX, PY, 8)
  cerca(area(t, chica), area(chica) * S03, 1e-4, 'menor que una celda')
})

test('rampa: la distancia por un meridiano es H·√(1 + s²) y por un paralelo es H', async () => {
  const zona = centrado(PX, PY, 500)
  const t    = await cargar(rampa(0.3), zona)
  const H    = distance([LATN(-12), LNG0], [LATN(12), LNG0])
  cerca(distance(t, [LATN(-12), LNG0], [LATN(12), LNG0]), H * S03, 1e-5, 'meridiano')
  cerca(distance(t, [LATN(12), LNG0], [LATN(-12), LNG0]), H * S03, 1e-5, 'meridiano al revés')
  cerca(distance(t, [LAT0, LNGE(-12)], [LAT0, LNGE(12)]), distance([LAT0, LNGE(-12)], [LAT0, LNGE(12)]), 1e-5, 'paralelo')
  assert.equal(distance(t, [LAT0, LNG0], [LAT0, LNG0]), 0)
})

test('rampa: el perímetro suma los dos lados N–S sobre el relieve y los dos E–O planos', async () => {
  const zona = centrado(PX, PY, 500)
  const t    = await cargar(rampa(0.3), zona)
  const P    = perimeter(t, zona)
  cerca(P, 1000 * (2 * S03 + 2), 1e-5, 'perímetro')
  assert.ok(P >= perimeter(zona))
})

test('un quiebre de 0,1 a 0,4: distance y perimeter suman cada parte del tramo por su √(1 + s²)', async () => {
  const zona = centrado(PX, PY, 500)
  const ns   = await cargar(mundo({ h: quiebre.ns }), zona)
  const eo   = await cargar(mundo({ h: quiebre.eo }), zona)
  const sur  = [LATN(-12), LNG0]
  const nor  = [LATN(9.5), LNG0]
  const cen  = [LAT0, LNG0]
  const oes  = [LAT0, LNGE(-12)]
  const est  = [LAT0, LNGE(9.5)]
  const mer  = geo(sur, cen) * S01 + geo(cen, nor) * S04
  // 21,5 celdas con el quiebre a 12 de un extremo: sólo los 43 pasos de media celda caen en él; con
  // menos pasos queda dentro de uno y el error es ≥ 2,7·10⁻⁵ del largo en cada sentido. Media celda
  // de corrimiento de la grilla pasa media celda de una pendiente a la otra (1,6·10⁻³).
  cerca(distance(ns, sur, nor), mer, 1e-5, 'meridiano')
  cerca(distance(ns, nor, sur), mer, 1e-5, 'meridiano al revés')
  cerca(distance(eo, oes, est), geo(oes, cen) * S01 + geo(cen, est) * S04, 1e-5, 'paralelo')
  // Los lados N–S del rectángulo cruzan el quiebre; los E–O siguen una curva de nivel.
  const so = [LATN(-12), LNGE(-5)]
  const se = [LATN(-12), LNGE(5)]
  const no = [LATN(9.5), LNGE(-5)]
  const ne = [LATN(9.5), LNGE(5)]
  cerca(perimeter(ns, [so, se, ne, no]), 2 * mer + geo(so, se) + geo(no, ne), 1e-5, 'perímetro')
})

test('un quiebre de 0,1 a 0,4: el área pondera el factor de cada celda por su peso, cobertura·área', async () => {
  // Diez columnas de las filas PY − 2 a PY + 5, con un décimo de la PY − 2: el peso de cada fila es su
  // cobertura por R²·Δλ·(sen φ₁ − sen φ₂), y su pendiente, la de Horn a mano sobre las alturas que
  // decodifica el tile (0,4 al norte del quiebre, 0,1 al sur y la media en su fila).
  const zona  = rect(latDe(PY + 6), lngDe(PX - 5), latDe(PY - 1.1), lngDe(PX + 5))
  const t     = await cargar(mundo({ h: quiebre.ns }), zona)
  const alto  = k => terrariumDe(quiebre.ns(latDe(k + 0.5)))
  const base  = ESF.Polygon(false)
  let pesos   = 0
  let factor  = 0
  for (let r = PY - 2; r < PY + 6; r++) {
    const w = (r === PY - 2 ? 0.1 : 1) * R * R * 360 / 2 ** 20 * RAD
      * (Math.sin(latDe(r) * RAD) - Math.sin(latDe(r + 1) * RAD))
    const p = (alto(r - 1) - alto(r + 1)) / (R * (latDe(r - 0.5) - latDe(r + 1.5)) * RAD)
    pesos  += w
    factor += w * Math.sqrt(1 + p * p)
  }
  zona.forEach(([lat, lng]) => base.AddPoint(lat, lng))
  cerca(area(t, zona), Math.abs(base.Compute(false, true).area) * factor / pesos, 1e-9, 'área')
  cerca(suma(relief(t, zona).slope.areas), area(t, zona), 1e-12, 'las clases suman el área')
})

test('con noData = 0, las áreas de relief suman area(t, zona): a 1e-12 con un anillo y a 1e-6 con huecos', async () => {
  const exterior = centrado(PX, PY, 500)
  const t        = await cargar(rampa(0.3), exterior)
  const lejos    = [exterior[0][0], exterior[0][1] - 1]
  const casos    = [
    [exterior, 1e-12],
    [[exterior, centrado(PX, PY - 8, 120).reverse()], 1e-6],
    [[exterior, [exterior[0], lejos]], 1e-12],
  ]
  for (const [zona, tol] of casos) {
    const r = relief(t, zona, [0.25, 0.35])
    assert.equal(r.noData, 0)
    cerca(suma(r.slope.areas), area(t, zona), tol, `invariante a ${tol}`)
  }
})

test('base elipsoidal achatada (f = 0,2) sobre su propia rampa: el factor de superficie no cambia y el área escala con la base', async () => {
  const a   = 6371008.8
  const f   = 0.2
  const e2  = f * (2 - f)
  const ref = new geodesic.Geodesic.Geodesic(a, f)
  const hE  = (lat, lng) => 1000
    + 0.2 * a / Math.sqrt(1 - e2 * Math.sin(lat * RAD) ** 2) * Math.cos(lat * RAD) * (lng - LNG0) * RAD
    + 0.15 * Math.sign(lat - LAT0) * ref.Inverse(LAT0, LNG0, lat, LNG0).s12
  const zona = centrado(PX, PY, 500)
  const base = ellipsoid(a, f)
  const t    = await cargar(mundo({ h: hE }), zona, base)
  cerca(area(t, zona), area(base, zona) * Math.sqrt(1 + 0.25 ** 2), 1e-4, 'área con el elipsoide')
  assert.ok(Math.abs(area(base, zona) / area(zona) - 1) > 1e-3, 'la base cambia el área')
})

test('un extremo fuera de la caja o una celda sin dato bajo la zona dan NaN', async () => {
  const zona  = centrado(PX, PY, 200)
  const t     = await cargar(rampa(0.3), zona)
  const fuera = [LATN(0), LNGE(300)]
  esNaN(distance(t, [LATN(0), LNGE(0)], fuera), 'extremo fuera')
  esNaN(distance(t, fuera, [LATN(0), LNGE(0)]), 'origen fuera')
  esNaN(distance(t, [LATN(0), LNGE(0)], [LATN(2000), LNGE(0)]), 'al norte')
  // A menos de una celda de cada lado de la caja: fuera de ella, pero dentro del mosaico, donde la
  // grilla tiene alturas.
  const { south, west, north, east } = t.bounds
  const lados = { norte: [north + 2e-4, LNG0], sur: [south - 2e-4, LNG0], oeste: [LAT0, west - 2e-4], este: [LAT0, east + 2e-4] }
  for (const [lado, punto] of Object.entries(lados)) {
    esNaN(elevation(t, punto), `elevation al ${lado}`)
    esNaN(distance(t, [LAT0, LNG0], punto), `extremo al ${lado}`)
    esNaN(distance(t, punto, [LAT0, LNG0]), `origen al ${lado}`)
  }
  esNaN(area(t, centrado(PX, PY, 3000)), 'anillo con vértices fuera')
  esNaN(perimeter(t, centrado(PX, PY, 3000)), 'perímetro con vértices fuera')
  assert.equal(area(t, [[LATN(0), LNGE(0)], fuera]), 0, 'un anillo de 2 vértices no encierra nada ni consulta el terreno')
  esNaN(perimeter(t, [[LATN(0), LNGE(0)], fuera]), 'pero sus aristas sí se miden')

  const x0 = 64 * 4870 - 10
  const z2 = celdas(x0, PY, x0 + 20, PY + 10)
  const m  = rampa(0.3, { estados: { 'https://t.test/14/4870/10007.png': 404 } })
  const t2 = await cargar(m, z2)
  esNaN(area(t2, z2), 'celda 404 bajo la zona')
  esNaN(distance(t2, [latDe(PY + 5), lngDe(x0)], [latDe(PY + 5), lngDe(x0 + 15)]), 'tramo que cruza el 404')
  // Sin celdas a la vista, la distancia entre dos puntos con dato sigue siendo finita.
  assert.ok(Number.isFinite(distance(t2, [latDe(PY + 5), lngDe(x0 - 4)], [latDe(PY + 5), lngDe(x0 + 1)])))
})

test('diameter no mide un terreno: lanza TypeError', async () => {
  const zona = centrado(PX, PY, 100)
  const t    = await cargar(mundo(), zona)
  assert.throws(() => diameter(t, zona), { name: 'TypeError' })
})

// ── elevation ────────────────────────────────────────────────────────────────────────────────

test('elevation lee la grilla bilineal, con el centro del píxel en el centro de la celda', async () => {
  const zona = centrado(PX, PY, 500)
  // Rampa diagonal de 0,2 al este y 0,15 al norte: medio píxel de corrimiento en una columna da
  // 0,2·15 m = 3 m de error, y en una fila, 0,15·15 m = 2,3 m.
  const h    = (lat, lng) => 1000 + 0.2 * R * Math.cos(lat * RAD) * (lng - LNG0) * RAD + 0.15 * R * (lat - LAT0) * RAD
  const t    = await cargar(mundo({ h }), zona)
  for (const [dx, dy] of [[0, 0], [0.5, 0], [0.25, 0.75], [-3.3, 4.6], [7, -2]]) {
    const lat = latDe(PY + 0.5 + dy)
    const lng = lngDe(PX + 0.5 + dx)
    assert.ok(Math.abs(elevation(t, [lat, lng]) - h(lat, lng)) < 0.02, `${dx},${dy}: ${elevation(t, [lat, lng])} vs ${h(lat, lng)}`)
  }
  // En el centro exacto de la celda vale el dato de esa celda.
  cerca(elevation(t, [LAT0, LNG0]), 1000, 1e-12, 'centro de la celda')
  cerca(elevation(t, { lat: LAT0, lng: LNG0 }), 1000, 1e-12, 'objeto')
  // Los puntos que no son un punto, o que caen fuera de la caja, son NaN.
  for (const malo of [null, undefined, [NaN, 0], [91, 0], 5, 'a']) esNaN(elevation(t, malo), String(malo))
  esNaN(elevation(t, [LATN(0), LNGE(300)]), 'fuera al este')
  esNaN(elevation(t, [LATN(300), LNGE(0)]), 'fuera al norte')
  esNaN(elevation(t, [LATN(0), LNGE(0) + 360 + 5]), 'una vuelta más al este')
})

test('elevation: un vecino sin dato da NaN aun en el centro de la celda, y lo que no es un terreno lanza', async () => {
  const x0   = 64 * 4870
  const zona = celdas(x0 - 10, PY, x0 + 5, PY + 10)
  const t    = await cargar(mundo({ estados: { 'https://t.test/14/4870/10007.png': 404 } }), zona)
  esNaN(elevation(t, [latDe(PY + 5.5), lngDe(x0 - 0.5)]), 'centro de la celda pegada al 404')
  esNaN(elevation(t, [latDe(PY + 5.5), lngDe(x0 + 2.5)]), 'celda sin dato')
  assert.equal(elevation(t, [latDe(PY + 5.5), lngDe(x0 - 5.5)]), 500)
  for (const malo of [sphere(), WGS84, null, {}])
    assert.throws(() => elevation(malo, [LAT0, LNG0]), { name: 'TypeError', message: '[elevation] el primer argumento tiene que ser un terreno: await terrain(…)' })
})

// ── Segunda copia ────────────────────────────────────────────────────────────────────────────

test('una segunda copia empaquetada describe el relieve de un terreno de la primera igual que la primera', async () => {
  const [salida] = (await build({
    entryPoints : [`${raiz}src/geometry/index.js`],
    bundle      : true,
    write       : false,
    format      : 'esm',
    platform    : 'browser',
    logLevel    : 'silent',
  })).outputFiles
  const copia = await import(`data:text/javascript;base64,${Buffer.from(salida.text).toString('base64')}`)
  assert.notEqual(copia.relief, relief)
  const zona = [centrado(PX, PY, 500), centrado(PX, PY - 8, 120)]
  const t    = await cargar(rampa(0.3), zona[0])
  assert.equal(typeof t[RELIEF], 'function')
  assert.deepEqual(copia.relief(t, zona, [0.25, 0.35]), relief(t, zona, [0.25, 0.35]))
  const tB = await copia.terrain(sphere(), FUENTE, cajaDe(zona[0]), { fetch: rampa(0.3).fetch })
  assert.deepEqual(relief(tB, zona, [0.25, 0.35]), relief(t, zona, [0.25, 0.35]))
  // El terreno de una copia mide en la otra, y la bilineal también se lee por la marca.
  const a = [LATN(-12), LNG0]
  const b = [LATN(12), LNGE(5)]
  assert.equal(copia.area(t, zona[0]), area(t, zona[0]))
  assert.equal(copia.distance(t, a, b), distance(t, a, b))
  assert.equal(copia.perimeter(t, zona[0]), perimeter(t, zona[0]))
  assert.equal(area(tB, zona[0]), copia.area(tB, zona[0]))
  assert.equal(distance(tB, a, b), copia.distance(tB, a, b))
  assert.equal(copia.elevation(t, [LATN(3), LNGE(2)]), elevation(t, [LATN(3), LNGE(2)]))
  assert.throws(() => copia.diameter(t, zona[0]), { name: 'TypeError' })
})
