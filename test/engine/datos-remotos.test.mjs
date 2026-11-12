// Capas por `url` en el motor: la carga, el error sin lanzar, `refresh` con su piso y su pausa, `reload` que descarta
// la respuesta vieja y `fields`. Corre con: node --test test/engine/datos-remotos.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { makeIconSet } from '../../test-helpers/engine-stub.mjs'
import { conNavegador, crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import { coleccion, cuadrado, fetchFalso, hasta, motor, punto, retenida, traza } from '../../test-helpers/datos-remotos.mjs'
import { after, mock, test } from 'node:test'
import assert from 'node:assert/strict'

after(conNavegador(crearNavegador()))

const FLOTA = coleccion([punto(-70, -33, { n: 'a' }), punto(-71, -34, { n: 'b' }), { type: 'Feature', properties: {}, geometry: null }])
const set = makeIconSet()

const escuchar = (engine, evento) => {
  const vistos = []
  engine.on(evento, d => vistos.push(d))
  return vistos
}

test('una capa de puntos con url carga, pone los ítems en su Source y emite dataload', async () => {
  const engine = motor()
  const cargas = escuchar(engine, 'dataload')
  const fetch  = fetchFalso({ 'flota.geojson': FLOTA })
  const h = engine.addPointLayer({ id: 'flota', url: 'flota.geojson', fetch, iconSet: set })
  await hasta(() => cargas.length)

  assert.deepEqual(cargas[0], { layerId: 'flota', url: 'flota.geojson', count: 2, skipped: 1 })
  const items = h.source.getSnapshot()
  assert.deepEqual(items.map(i => i.n), ['a', 'b'])
  assert.deepEqual(h.source.accessors.positionOf(items[0]), { lat: -33, lng: -70 })
  assert.equal(h.source.accessors.idOf(items[1]), 1)
  engine.destroy()
})

test('un 404 emite dataerror, no lanza y deja la Source vacía', async () => {
  const engine = motor()
  const errores = escuchar(engine, 'dataerror')
  const h = engine.addPointLayer({ id: 'flota', url: 'falta.geojson', fetch: fetchFalso({}), iconSet: set })
  await hasta(() => errores.length)

  assert.deepEqual(errores[0], { layerId: 'flota', url: 'falta.geojson', code: 'network', message: 'falta.geojson: HTTP 404', status: 404 })
  assert.equal(h.source.getSnapshot().length, 0)
  engine.destroy()
})

test('sin oyentes de dataerror el fallo va a la consola, una sola vez por capa', async () => {
  const engine = motor()
  const consola = mock.method(console, 'error', () => {})
  try {
    const h = engine.addPointLayer({ id: 'flota', url: 'falta.geojson', fetch: fetchFalso({}), iconSet: set })
    await hasta(() => consola.mock.callCount() === 1)
    await h.reload()
    await h.reload()
    assert.equal(consola.mock.callCount(), 1)
  } finally { consola.mock.restore() }
  engine.destroy()
})

test('el contenido que no es de ningún formato da dataerror con code format', async () => {
  const engine = motor()
  const errores = escuchar(engine, 'dataerror')
  engine.addPointLayer({ id: 'flota', url: 'flota.geojson', fetch: fetchFalso({ 'flota.geojson': '{ no es json' }), iconSet: set })
  await hasta(() => errores.length)
  assert.equal(errores[0].code, 'format')
  engine.destroy()
})

test('polígonos y líneas con url cargan por su geometría, y fields.id manda sobre el índice', async () => {
  const engine = motor()
  const cargas = escuchar(engine, 'dataload')
  const fetch  = fetchFalso({
    'predios.geojson': coleccion([cuadrado(-70, -33, 1, { rol: 'p1' }), cuadrado(-72, -35, 1, { rol: 'p2' })]),
    'rutas.geojson'  : coleccion([traza([[-70, -33], [-71, -34]], { ruta: 'r1' })]),
  })
  const pol = engine.addPolygonLayer({ id: 'predios', url: 'predios.geojson', fetch, fields: { id: 'rol' } })
  const lin = engine.addLineLayer({ id: 'rutas', url: 'rutas.geojson', fetch })
  await hasta(() => cargas.length === 2)

  assert.deepEqual(pol.source.getSnapshot().map(i => pol.source.accessors.idOf(i)), ['p1', 'p2'])
  const [ruta] = lin.source.getSnapshot()
  assert.deepEqual(lin.source.accessors.pathOf(ruta), [[[-33, -70], [-34, -71]]])
  engine.destroy()
})

test('url junto con source o geometry es TypeError y no deja capa', () => {
  const engine = motor()
  const source = { accessors: {}, getSnapshot: () => [], subscribe: () => () => {} }
  assert.throws(() => engine.addPointLayer({ id: 'x', url: 'a.geojson', source, iconSet: set }), TypeError)
  assert.throws(() => engine.addPolygonLayer({ id: 'y', url: 'a.geojson', geometry: {} }), TypeError)
  assert.equal(engine.getLayer('x'), null)
  assert.equal(engine.getLayer('y'), null)
  engine.destroy()
})

test('reload cambia la url, aborta la carga en vuelo y descarta su respuesta', async () => {
  const engine = motor()
  const vieja = retenida()
  const fetch = fetchFalso({
    'a.geojson': vieja.rutaDe(),
    'b.geojson': coleccion([punto(0, 0, { n: 'de-b' })]),
  })
  const h = engine.addPointLayer({ id: 'flota', url: 'a.geojson', fetch, iconSet: set })
  await hasta(() => fetch.pedidos.length === 1)

  await h.reload({ url: 'b.geojson' })
  assert.equal(fetch.pedidos[0].signal.aborted, true)
  assert.deepEqual(h.source.getSnapshot().map(i => i.n), ['de-b'])

  vieja.soltar(coleccion([punto(9, 9, { n: 'de-a' })]))
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  assert.deepEqual(h.source.getSnapshot().map(i => i.n), ['de-b'], 'la respuesta vieja no pisa a la nueva')
  engine.destroy()
})

test('reload en una capa que no nació con url es TypeError; sin url es un no-op', async () => {
  const engine = motor()
  const h = engine.addPointLayer({
    id: 'flota', iconSet: set, accessors: { idOf: i => i.id, positionOf: i => ({ lat: i.lat, lng: i.lng }) },
  })
  assert.throws(() => h.reload({ url: 'a.geojson' }), /no nació con url/)
  await h.reload()
  engine.destroy()
})

test('fields resuelve idOf y positionOf de datos propios, y una función de accessors gana con aviso', () => {
  const engine = motor()
  const aviso = mock.method(console, 'warn', () => {})
  try {
    const h = engine.addPointLayer({
      id: 'flota', iconSet: set,
      fields: { id: 'patente', position: ['lat', 'lng'] },
      accessors: { idOf: i => `x-${i.patente}` },
      data: [{ patente: 'AB12', lat: 1, lng: 2 }],
    })
    const [item] = h.source.getSnapshot()
    assert.equal(h.source.accessors.idOf(item), 'x-AB12')
    assert.deepEqual(h.source.accessors.positionOf(item), { lat: 1, lng: 2 })
    assert.equal(aviso.mock.callCount(), 1)
  } finally { aviso.mock.restore() }
  engine.destroy()
})

test('removeLayer aborta la carga en vuelo y no deja timers', async () => {
  const engine = motor()
  const vieja = retenida()
  const fetch = fetchFalso({ 'a.geojson': vieja.rutaDe() })
  const cargas = escuchar(engine, 'dataload')
  engine.addPointLayer({ id: 'flota', url: 'a.geojson', fetch, refresh: 5000, iconSet: set })
  await hasta(() => fetch.pedidos.length === 1)
  engine.removeLayer('flota')
  assert.equal(fetch.pedidos[0].signal.aborted, true)
  vieja.soltar(FLOTA)
  await new Promise(r => setImmediate(r))
  assert.equal(cargas.length, 0)
  engine.destroy()
})

test('refresh recarga cada período, se pausa con la pestaña oculta y cobra al volver', async t => {
  const engine = motor()
  const escuchas = new Set()
  const { addEventListener, removeEventListener } = document
  document.addEventListener    = (tipo, cb) => tipo === 'visibilitychange' && escuchas.add(cb)
  document.removeEventListener = (tipo, cb) => escuchas.delete(cb)
  document.visibilityState = 'visible'
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const fetch = fetchFalso({ 'flota.geojson': FLOTA })
    engine.addPointLayer({ id: 'flota', url: 'flota.geojson', fetch, refresh: 2000, iconSet: set })
    await hasta(() => fetch.pedidos.length === 1 && escuchas.size === 1)
    await hasta(() => engine.getLayer('flota').remote.timer !== null)

    t.mock.timers.tick(2000)
    await hasta(() => fetch.pedidos.length === 2)

    await hasta(() => engine.getLayer('flota').remote.timer !== null)
    document.visibilityState = 'hidden'
    t.mock.timers.tick(2000)
    await new Promise(r => setImmediate(r))
    assert.equal(fetch.pedidos.length, 2, 'oculta no recarga')

    document.visibilityState = 'visible'
    escuchas.forEach(cb => cb())
    await hasta(() => fetch.pedidos.length === 3)

    engine.destroy()
    assert.equal(escuchas.size, 0, 'destroy suelta la suscripción')
  } finally {
    document.addEventListener = addEventListener
    document.removeEventListener = removeEventListener
    delete document.visibilityState
  }
})

test('refresh bajo el piso se acota a 1000 ms y avisa una vez; sin url se ignora con aviso', async t => {
  const engine = motor()
  const aviso = mock.method(console, 'warn', () => {})
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const fetch = fetchFalso({ 'flota.geojson': FLOTA })
    engine.addPointLayer({ id: 'flota', url: 'flota.geojson', fetch, refresh: 100, iconSet: set })
    await hasta(() => engine.getLayer('flota').remote.timer !== null)
    assert.equal(engine.getLayer('flota').remote.refresh, 1000)

    t.mock.timers.tick(999)
    await new Promise(r => setImmediate(r))
    assert.equal(fetch.pedidos.length, 1)
    t.mock.timers.tick(1)
    await hasta(() => fetch.pedidos.length === 2)

    engine.addLineLayer({ id: 'suelta', refresh: 5000, accessors: { idOf: i => i.id, pathOf: i => i.path } })
    assert.equal(aviso.mock.callCount(), 2)
    assert.match(aviso.mock.calls[0].arguments[0], /se acota a 1000/)
    assert.match(aviso.mock.calls[1].arguments[0], /refresh sin url/)
  } finally { aviso.mock.restore() }
  engine.destroy()
})

const textos = (engine, id) => {
  const out = []
  engine.getLayer(id).labels.links[0].member.forEach((acc, _item, _id, text) => acc.push(text), out)
  return out
}

test('addTextLayer toma id, posición y texto de fields; con textOf gana la función y avisa una vez', () => {
  const engine = motor()
  const aviso = mock.method(console, 'warn', () => {})
  try {
    const data = [{ k: 'scl', ciudad: 'Santiago', lat: 0, lng: 0 }]
    engine.addTextLayer({ id: 'a', data, fields: { id: 'k', position: ['lat', 'lng'], text: 'ciudad' } })
    assert.deepEqual(textos(engine, 'a'), ['Santiago'])

    engine.addTextLayer({ id: 'b', data, fields: { id: 'k', position: ['lat', 'lng'], text: 'ciudad' }, textOf: i => i.k })
    assert.deepEqual(textos(engine, 'b'), ['scl'])
    assert.equal(aviso.mock.callCount(), 1)
  } finally { aviso.mock.restore() }
  engine.destroy()
})

test('addLabels acepta fields.text sobre una capa de puntos cuando no hay textOf', () => {
  const engine = motor()
  engine.addPointLayer({ id: 'flota', iconSet: set, fields: { id: 'p', position: ['lat', 'lng'] }, data: [{ p: 1, lat: 0, lng: 0, nombre: 'Camión 1' }] })
  engine.addLabels({ hostId: 'flota', fields: { text: 'nombre' } })
  assert.deepEqual(textos(engine, 'flota'), ['Camión 1'])
  engine.destroy()
})

test('refresh sobre el techo de setTimeout se acota a 2^31-1 ms y avisa una vez', async () => {
  const engine = motor()
  const aviso = mock.method(console, 'warn', () => {})
  try {
    const fetch = fetchFalso({ 'flota.geojson': FLOTA })
    engine.addPointLayer({ id: 'flota', url: 'flota.geojson', fetch, refresh: 1e10, iconSet: set })
    await hasta(() => engine.getLayer('flota').remote.timer !== null)
    assert.equal(engine.getLayer('flota').remote.refresh, 2 ** 31 - 1)
    assert.equal(aviso.mock.callCount(), 1)
    assert.match(aviso.mock.calls[0].arguments[0], /se acota a 2147483647/)
  } finally { aviso.mock.restore() }
  engine.destroy()
})

test('el id del feature manda sobre el índice: un refresh que reordena no cambia de dueño a los ítems', async () => {
  const engine = motor()
  const conId = (id, n) => ({ ...punto(-70, -33, { n }), id })
  let cuerpo = coleccion([conId('a', 'A'), conId('b', 'B'), punto(-71, -34, { n: 'sin-id' })])
  const fetch = fetchFalso({ 'flota.geojson': () => cuerpo })
  const h = engine.addPointLayer({ id: 'flota', url: 'flota.geojson', fetch, iconSet: set })
  const ids = () => h.source.getSnapshot().map(i => h.source.accessors.idOf(i))
  await hasta(() => h.source.getSnapshot().length === 3)
  assert.deepEqual(ids(), ['a', 'b', 2], 'el índice sólo para el feature sin id')

  cuerpo = coleccion([punto(-71, -34, { n: 'sin-id' }), conId('b', 'B2'), conId('a', 'A2')])
  await h.reload()
  assert.deepEqual(ids(), [0, 'b', 'a'])
  assert.equal(h.source.itemById('a').n, 'A2')
  assert.equal(h.source.itemById('b').n, 'B2')
  engine.destroy()
})
