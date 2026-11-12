// Sets de íconos por imagen: variante → imagen, carga única por src, errores clasificados y re-rasterizado
// al decodificar. fetch, Image y URL.createObjectURL son dobles; el canvas de trabajo registra drawImage.
import '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DROP_ICONS, imageIconSet, SET_ICONS } from '../../src/atlas/image-icons.js'

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)) }

const entorno = ({ falla = {}, decodeFalla = new Set(), retener = new Set(), location } = {}) => {
  const g = globalThis
  const orig = { fetch: g.fetch, Image: g.Image, createObjectURL: URL.createObjectURL, revoke: URL.revokeObjectURL, createElement: g.document.createElement, location: Object.getOwnPropertyDescriptor(g, 'location') }
  const pedidos = [], dibujos = [], senales = {}
  g.fetch = async (url, init) => {
    pedidos.push(url)
    senales[url] = init?.signal
    if (retener.has(url)) {          // una descarga colgada: sólo termina si la cancelan
      await new Promise((_r, rechazar) => init?.signal?.addEventListener('abort', () => rechazar(Object.assign(new Error('abortado'), { name: 'AbortError' }))))
    }
    if (falla[url] === 'rechazo') throw new TypeError('Failed to fetch')
    if (falla[url]) return { ok: false, status: falla[url] }
    return { ok: true, status: 200, headers: new Map([['content-type', 'image/png']]), arrayBuffer: async () => new Uint8Array([url.length]).buffer }
  }
  let n = 0
  URL.createObjectURL = () => `blob:${n++}`
  URL.revokeObjectURL = () => {}
  g.Image = class { set src(v) { this._src = v } decode() { return decodeFalla.size ? Promise.reject(new Error('bad')) : Promise.resolve() } get naturalWidth() { return 64 } get naturalHeight() { return 32 } }
  const ctx = { reset() {}, drawImage: (...a) => dibujos.push(a), getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }
  g.document.createElement = tag => (tag === 'canvas' ? { width: 0, height: 0, getContext: () => ctx } : {})
  if (location) Object.defineProperty(g, 'location', { value: location, configurable: true })
  return {
    pedidos, dibujos, senales,
    restaurar() {
      g.fetch = orig.fetch; g.Image = orig.Image; URL.createObjectURL = orig.createObjectURL; URL.revokeObjectURL = orig.revoke
      g.document.createElement = orig.createElement
      if (location) orig.location ? Object.defineProperty(g, 'location', orig.location) : delete g.location
    },
  }
}

const conEntorno = (opts, fn) => async () => {
  const e = entorno(opts)
  try { await fn(e) } finally { e.restaurar() }
}

test('la variante elige el ícono; una desconocida usa el primero con un solo aviso', conEntorno({}, async e => {
  const avisos = []
  const w = console.warn; console.warn = m => avisos.push(m)
  try {
    const set = imageIconSet({ icons: { camion: '/a.png', grua: { src: '/b.png' }, ignorado: {} } })
    await set.ready
    assert.deepEqual(e.pedidos.sort(), ['/a.png', '/b.png'])
    set.resolve('grua'); set.resolve('raro'); set.resolve('raro'); set.resolve('default'); set.resolve('')
    set.resolve('otro')
    assert.equal(avisos.length, 2, 'una vez por variante desconocida; null/default/vacío no avisan')
    assert.equal(e.dibujos.length, 5, "una por variante distinta resuelta")
    // contain: 64x32 en 128 → ancho completo, alto 64, centrado en y
    assert.deepEqual(e.dibujos[0].slice(1), [0, 32, 128, 64])
  } finally { console.warn = w }
}))

test('sin icons o sin entradas válidas lanza TypeError', () => {
  assert.throws(() => imageIconSet({}), TypeError)
  assert.throws(() => imageIconSet({ icons: {} }), TypeError)
  assert.throws(() => imageIconSet({ icons: { a: {} } }), TypeError)
})

test('la carga re-rasteriza lo resuelto antes y avisa onLoad con count', conEntorno({}, async e => {
  const cargas = []
  const set = imageIconSet({ icons: { a: '/a.png', b: '/b.png' }, onLoad: d => cargas.push(d) })
  set.resolve('a')                            // antes de decodificar: tile transparente
  let avisos = 0
  set.onAtlasRefresh(() => avisos++)
  assert.equal(e.dibujos.length, 0)
  await set.ready; await flush()
  assert.ok(avisos >= 1)
  assert.ok(e.dibujos.length >= 1, 'la variante resuelta se dibujó con la imagen ya decodificada')
  assert.deepEqual(cargas, [{ set: null, count: 2 }])
}))

test('404 da network, rechazo de otro origen da cors', conEntorno({ falla: { '/x.png': 404, 'https://otro.test/y.png': 'rechazo' }, location: { origin: 'https://app.test', href: 'https://app.test/' } }, async () => {
  const errores = []
  const set = imageIconSet({ icons: { x: '/x.png', y: 'https://otro.test/y.png' }, onError: d => errores.push(d) })
  await set.ready
  const por = Object.fromEntries(errores.map(d => [d.icon, d]))
  assert.equal(por.x.code, 'network'); assert.equal(por.x.url, '/x.png'); assert.equal(por.x.set, null)
  assert.equal(por.y.code, 'cors')
  assert.equal(typeof por.y.message, 'string')
}))

test('decode que rechaza da format y no publica onLoad', conEntorno({ decodeFalla: new Set([1]) }, async () => {
  const errores = []; let cargado = 0
  const set = imageIconSet({ icons: { a: '/a.svg' }, onError: d => errores.push(d), onLoad: () => cargado++ })
  await set.ready
  assert.equal(errores.length, 1); assert.equal(errores[0].code, 'format'); assert.equal(cargado, 0)
  assert.doesNotThrow(() => set.resolve('a'))
}))

test('SET_ICONS agrega y quita íconos sin cambiar la identidad ni repetir una src cargada', conEntorno({}, async e => {
  const set = imageIconSet({ icons: { a: '/a.png' } })
  await set.ready
  assert.deepEqual(e.pedidos, ['/a.png'])
  set[SET_ICONS]({ a: '/a.png', b: '/b.png' }, { rotates: true, size: 40 })
  await flush()
  assert.deepEqual(e.pedidos, ['/a.png', '/b.png'], 'sólo la src nueva')
  assert.equal(set.rotates, true); assert.equal(set.defaultSize, 40)
  set.resolve('b'); await flush()
  assert.ok(e.dibujos.length >= 1)
  set[SET_ICONS]({ b: '/b.png' })
  await flush()
  assert.deepEqual(e.pedidos, ['/a.png', '/b.png'])
  assert.throws(() => set[SET_ICONS]({}), TypeError)
}))

test('quitar una src del catálogo cancela su descarga en vuelo y no publica un error', conEntorno({ retener: new Set(['/a.png']) }, async e => {
  const errores = []
  const set = imageIconSet({ icons: { a: '/a.png', b: '/b.png' }, onError: d => errores.push(d) })
  set.ready
  await flush()
  assert.equal(e.senales['/a.png'].aborted, false)
  set[SET_ICONS]({ b: '/b.png' })
  await flush()
  assert.equal(e.senales['/a.png'].aborted, true)
  assert.deepEqual(errores, [], 'una cancelación no es un error')
}))

test('DROP_ICONS cancela lo que sigue en vuelo', conEntorno({ retener: new Set(['/a.png']) }, async e => {
  const errores = []
  const set = imageIconSet({ icons: { a: '/a.png' }, onError: d => errores.push(d) })
  set.ready
  await flush()
  set[DROP_ICONS]()
  await flush()
  assert.equal(e.senales['/a.png'].aborted, true)
  assert.deepEqual(errores, [])
}))

test('una src que falló se reintenta cuando cambia el catálogo', conEntorno({ falla: { '/x.png': 404 } }, async e => {
  const errores = []
  const set = imageIconSet({ icons: { x: '/x.png' }, onError: d => errores.push(d.code) })
  set.ready
  await flush()
  assert.deepEqual(e.pedidos, ['/x.png'])
  set[SET_ICONS]({ x: '/x.png', y: '/y.png' })
  await flush()
  assert.deepEqual(e.pedidos, ['/x.png', '/x.png', '/y.png'], 'x se pide de nuevo; y es nueva')
  assert.deepEqual(errores, ['network', 'network'])
}))
