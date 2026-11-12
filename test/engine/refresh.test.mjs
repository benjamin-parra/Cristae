// Refresco por diferencia de id e interpolación de la posición, con Source real y reloj falso.
// Corre con: node --test test/engine/refresh.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import v8 from 'node:v8'
import vm from 'node:vm'
import { readGeoJson } from '../../src/geojson/geojson.js'
import { createSource } from '../../src/data/Source.js'
import { itemsOf, URL_ACCESSORS } from '../../src/engine/features.js'
import { createRefresher, REFRESH_TWEEN_MS, MIN_REFRESH_MS, MAX_REFRESH_MS } from '../../src/engine/refresh.js'

const punto = (id, lng, lat, props = {}) => ({ type: 'Feature', id, properties: props, geometry: { type: 'Point', coordinates: [lng, lat] } })
const linea = (id, coords) => ({ type: 'Feature', id, properties: {}, geometry: { type: 'LineString', coordinates: coords } })
const leer = (features, kind = 'point') =>
  itemsOf(readGeoJson(JSON.stringify({ type: 'FeatureCollection', features })), kind).items

// Reloj y cuadros falsos: un solo cuadro pendiente, que el test dispara a mano.
const armar = (kind = 'point') => {
  const source = createSource(URL_ACCESSORS[kind])
  const reloj = { t: 0, cb: null, cancelados: 0, pedidos: 0 }
  const refresher = createRefresher({
    source, kind,
    now: () => reloj.t,
    frame: cb => { reloj.cb = cb; reloj.pedidos++; return reloj.pedidos },
    cancelFrame: () => { reloj.cb = null; reloj.cancelados++ },
  })
  const cuadro = ms => { reloj.t = ms; const cb = reloj.cb; reloj.cb = null; cb?.() }
  const pos = id => { const p = source.accessors.positionOf(source.itemById(id)); return [p.lat, p.lng] }
  const cierra = async () => { await new Promise(r => setTimeout(r, 5)) }
  return { source, reloj, refresher, cuadro, pos, cierra, fin: () => { refresher.stop(); source.destroy() } }
}

// Va primero: el cuadro es un solo código para todos los refrescos, y los tests siguientes le llenarían de
// destinos distintos la llamada a `move`, que el motor ya no inlinaría; eso no es una asignación del cuadro.
test('0 asignaciones por cuadro', () => {
  const N = 500
  const fuente = {
    accessors: URL_ACCESSORS.point,
    set() {},
    move() {},
  }
  let llamadas = 0
  const ultimo = new Float64Array(1)   // un número suelto en una clausura se encajona: sería asignación del test
  fuente.move = (id, lat, lng) => { llamadas++; ultimo[0] = lat + lng }
  const reloj = { t: 0, cb: null }
  const r = createRefresher({ source: fuente, kind: 'point', now: () => reloj.t, frame: cb => { reloj.cb = cb; return 1 }, cancelFrame() {} })
  const filas = d => Array.from({ length: N }, (_, i) => punto('v' + i, i * 0.1 + d, i * 0.1 + d))
  r.apply(leer(filas(0)))
  r.apply(leer(filas(1)))
  const cb = reloj.cb
  v8.setFlagsFromString('--expose-gc')
  const gc = vm.runInNewContext('gc')
  for (let i = 0; i < 400; i++) { reloj.t = 1 + i / 4; cb() }   // calentar hasta que el motor optimiza el cuadro
  // El mínimo de varias rondas deja fuera lo que asigna el compilador del motor mientras optimiza el cuadro.
  const ronda = () => {
    gc()
    const antes = process.memoryUsage().heapUsed
    for (let i = 0; i < 200; i++) { reloj.t = 200 + i / 4; cb() }
    return process.memoryUsage().heapUsed - antes
  }
  const cuadro = Math.min(ronda(), ronda(), ronda(), ronda(), ronda(), ronda())
  assert.ok(llamadas >= 250 * N)
  assert.ok(ultimo[0] !== 0)
  assert.ok(cuadro < 50_000, `${cuadro} B en 200 cuadros de ${N} puntos`)
})

test('constantes: el tween nace del piso del refresh', () => {
  assert.equal(REFRESH_TWEEN_MS, MIN_REFRESH_MS)
  assert.equal(MAX_REFRESH_MS, 2 ** 31 - 1)
})

test('ids estables con otra posición reescriben el slot (el hash ya no es el id)', async () => {
  const a = armar()
  a.refresher.apply(leer([punto('a', 10, 20), punto('b', 1, 2)]))
  await a.cierra()
  a.refresher.apply(leer([punto('a', 11, 21), punto('b', 1, 2)]))
  assert.deepEqual([...a.source.dirtyIds()], ['a'])
  a.fin()
})

test('un ítem igual conserva su objeto y no queda sucio', async () => {
  const a = armar()
  const primero = leer([punto('a', 10, 20, { n: 1 }), punto('b', 1, 2)])
  a.refresher.apply(primero)
  await a.cierra()
  a.refresher.apply(leer([punto('a', 10, 20, { n: 1 }), punto('b', 1, 2)]))
  assert.equal(a.source.itemById('a'), primero[0])
  assert.equal(a.source.itemById('b'), primero[1])
  assert.equal(a.source.dirtyIds().size, 0)
  a.fin()
})

test('una propiedad distinta cuenta como cambio', async () => {
  const a = armar()
  a.refresher.apply(leer([punto('a', 10, 20, { n: 1 })]))
  await a.cierra()
  a.refresher.apply(leer([punto('a', 10, 20, { n: 2 })]))
  assert.deepEqual([...a.source.dirtyIds()], ['a'])
  a.fin()
})

test('una alta y una baja hacen un solo set con cambio de miembros', async () => {
  const a = armar()
  a.refresher.apply(leer([punto('a', 10, 20), punto('b', 1, 2)]))
  await a.cierra()
  let sets = 0
  const set = a.source.set
  a.source.set = items => { sets++; set(items) }
  a.refresher.apply(leer([punto('b', 1, 2), punto('c', 5, 6)]))
  assert.equal(sets, 1)
  assert.deepEqual(a.source.getSnapshot().map(i => i[Object.getOwnPropertySymbols(i)[0]]).sort(), ['b', 'c'])
  assert.ok(a.source.dirtyIds().has('c'))
  assert.ok(!a.source.dirtyIds().has('b'))
  a.fin()
})

test('un archivo reordenado no cambia de dueño', async () => {
  const a = armar()
  a.refresher.apply(leer([punto('a', 10, 20), punto('b', 1, 2)]))
  const b = a.source.itemById('b')
  await a.cierra()
  a.refresher.apply(leer([punto('b', 1, 2), punto('a', 10, 20)]))
  assert.equal(a.source.itemById('b'), b)
  assert.equal(a.source.dirtyIds().size, 0)
  a.fin()
})

test('la interpolación pasa por el punto medio y termina exacta', () => {
  const a = armar()
  a.refresher.apply(leer([punto('a', 10, 20)]))
  a.refresher.apply(leer([punto('a', 14, 28)]))
  assert.deepEqual(a.pos('a'), [20, 10], 'sin un cuadro en la posición nueva')
  a.cuadro(REFRESH_TWEEN_MS / 2)
  assert.deepEqual(a.pos('a'), [24, 12])
  assert.ok(a.reloj.cb, 'sigue pidiendo cuadros')
  a.cuadro(REFRESH_TWEEN_MS)
  assert.deepEqual(a.pos('a'), [28, 14])
  assert.equal(a.reloj.cb, null, 'termina sin cuadro pendiente')
  a.fin()
})

test('con la pestaña oculta el siguiente cuadro salta al destino', () => {
  const a = armar()
  a.refresher.apply(leer([punto('a', 0, 0)]))
  a.refresher.apply(leer([punto('a', 4, 8)]))
  a.cuadro(REFRESH_TWEEN_MS * 50)
  assert.deepEqual(a.pos('a'), [8, 4])
  a.fin()
})

test('un refresh a mitad de camino continúa desde la posición interpolada', () => {
  const a = armar()
  a.refresher.apply(leer([punto('a', 0, 0)]))
  a.refresher.apply(leer([punto('a', 10, 10)]))
  a.cuadro(REFRESH_TWEEN_MS / 2)
  assert.deepEqual(a.pos('a'), [5, 5])
  a.refresher.apply(leer([punto('a', 20, 20)]))
  assert.deepEqual(a.pos('a'), [5, 5], 'no salta al destino nuevo')
  a.cuadro(a.reloj.t + REFRESH_TWEEN_MS / 2)
  assert.deepEqual(a.pos('a'), [12.5, 12.5])
  a.cuadro(a.reloj.t + REFRESH_TWEEN_MS)
  assert.deepEqual(a.pos('a'), [20, 20])
  a.fin()
})

test('un ítem igual a mitad de camino sigue hacia su destino', () => {
  const a = armar()
  a.refresher.apply(leer([punto('a', 0, 0)]))
  a.refresher.apply(leer([punto('a', 10, 10)]))
  a.cuadro(REFRESH_TWEEN_MS / 2)
  a.refresher.apply(leer([punto('a', 10, 10)]))
  assert.deepEqual(a.pos('a'), [5, 5])
  a.cuadro(a.reloj.t + REFRESH_TWEEN_MS)
  assert.deepEqual(a.pos('a'), [10, 10])
  a.fin()
})

test('el antimeridiano va por el arco corto', () => {
  const a = armar()
  a.refresher.apply(leer([punto('a', 170, 0)]))
  a.refresher.apply(leer([punto('a', -170, 0)]))
  a.cuadro(REFRESH_TWEEN_MS / 2)
  assert.equal(Math.abs(a.pos('a')[1]), 180)
  a.cuadro(REFRESH_TWEEN_MS * 0.75)
  assert.ok(Math.abs(a.pos('a')[1] + 175) < 1e-9)
  a.cuadro(REFRESH_TWEEN_MS)
  assert.deepEqual(a.pos('a'), [0, -170])
  a.fin()
})

test('una baja a mitad de camino no deja su interpolación', () => {
  const a = armar()
  a.refresher.apply(leer([punto('a', 0, 0), punto('b', 0, 0)]))
  a.refresher.apply(leer([punto('a', 10, 10), punto('b', 10, 10)]))
  a.refresher.apply(leer([punto('b', 10, 10)]))
  a.cuadro(REFRESH_TWEEN_MS)
  assert.equal(a.source.itemById('a'), undefined)
  a.fin()
})

test('stop corta y no deja cuadros', () => {
  const a = armar()
  a.refresher.apply(leer([punto('a', 0, 0)]))
  a.refresher.apply(leer([punto('a', 10, 10)]))
  assert.ok(a.reloj.cb)
  a.refresher.stop()
  assert.equal(a.reloj.cb, null)
  assert.equal(a.reloj.cancelados, 1)
  a.cuadro(REFRESH_TWEEN_MS)
  assert.deepEqual(a.pos('a'), [0, 0], 'nada se movió tras stop')
  a.source.destroy()
})

test('líneas: sólo la diferencia, sin interpolar ni cuadros', async () => {
  const a = armar('line')
  const l0 = leer([linea('x', [[0, 0], [1, 1]]), linea('y', [[2, 2], [3, 3]])], 'line')
  a.refresher.apply(l0)
  await a.cierra()
  a.refresher.apply(leer([linea('x', [[0, 0], [1, 1]]), linea('y', [[2, 2], [4, 4]])], 'line'))
  assert.equal(a.source.itemById('x'), l0[0])
  assert.deepEqual([...a.source.dirtyIds()], ['y'])
  assert.equal(a.reloj.pedidos, 0)
  a.fin()
})
