// T1.1 en elementos REALES (Lit + custom elements en jsdom): una `<cristae-point-layer>` con `source` toma UN
// contexto en cada uno de los cuatro caminos por los que un elemento llega a montarse (ciclo-de-vida.md §1.3).
// En todos, el primer `updated()` entrega al `syncLayer` el `changed` con la `source` que el montaje ya usó, y esa
// identidad no puede costar una capa nueva. Cuenta los contextos un navegador falso con el techo de Chromium.
//
//   1. Conexión con el motor presente y la config ya asignada.
//   2. Capa encolada antes de que el motor exista; el mapa se la entrega al nacer.
//   3. Config que llega después del motor: el propio `updated()` monta.
//   4. Hijo de un modificador (cluster): lo monta el reductor, y su `updated()` llega después.
//
// Corre con: node --test test/element/montaje-source.test.mjs
import { window } from '../../test-helpers/jsdom-elementos.mjs'
import { instalarNavegador } from '../../test-helpers/navegador-falso.mjs'
import { makeIconSet } from '../../test-helpers/engine-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import '../../src/index.js'
import { createSource } from '../../src/data/index.js'

const ACC     = { idOf: v => v.id, positionOf: v => ({ lat: v.lat, lng: v.lng }) }
const iconSet = makeIconSet()

const esperar = ms => new Promise(r => setTimeout(r, ms))
const fuente  = n => {
  const source = createSource(ACC)
  source.set(Array.from({ length: n }, (_, i) => ({ id: i + 1, lat: i * 1e-4, lng: i * 1e-4 })))
  return source
}

const mapa = () => {
  document.body.replaceChildren()
  const map = document.createElement('cristae-map')
  map.style.cssText = 'display:block;width:800px;height:600px'
  return map
}

const capa = (props = { id: 'p', source: fuente(3), iconSet }) => Object.assign(document.createElement('cristae-point-layer'), props)

after(() => document.body.replaceChildren())

// Los contextos de la capa: ninguno creado de más ni devuelto al instante, y ninguna capa usó un recurso ajeno.
const sinCreacionesDeMas = (navegador, vivos) => {
  const estado = navegador.stat()
  const dobles = navegador.contextos.filter(c => c.causa === 'liberado').map(c => c.pane)
  assert.ok(estado.vivos >= 1, `la capa montó: ${navegador.resumen()}`)
  vivos !== undefined && assert.equal(estado.vivos, vivos, navegador.resumen())
  assert.equal(estado.creados, estado.vivos, `creaciones espurias: ${navegador.resumen()}; liberados al instante en: ${dobles.join(', ')}`)
  assert.equal(estado.liberados, 0)
  assert.deepEqual(navegador.violaciones, [])
}

test('T1.1 camino 1: conexión con el motor presente y la config previa', async t => {
  const navegador = instalarNavegador(window)
  const map = mapa()
  document.body.appendChild(map)
  await esperar(40)                                   // el motor nace en firstUpdated del mapa
  t.after(() => map.remove())

  map.appendChild(capa())                             // las props ya están: monta al conectar
  await esperar(40)
  sinCreacionesDeMas(navegador, 1)
})

test('T1.1 camino 2: capa encolada antes de que exista el motor', async t => {
  const navegador = instalarNavegador(window)
  const map = mapa()
  t.after(() => map.remove())

  map.appendChild(capa())                             // el mapa aún no está conectado: no hay motor
  document.body.appendChild(map)
  await esperar(80)
  sinCreacionesDeMas(navegador, 1)
})

test('T1.1 camino 3: la config llega después del motor y el `updated()` monta', async t => {
  const navegador = instalarNavegador(window)
  const map = mapa()
  document.body.appendChild(map)
  await esperar(40)
  t.after(() => map.remove())

  const el = capa({})                                 // conectada sin config: mountReady() es falso
  map.appendChild(el)
  await esperar(20)
  assert.equal(navegador.creados, 0, 'sin source ni accessors no monta')

  Object.assign(el, { id: 'p', source: fuente(3), iconSet })
  await esperar(40)
  sinCreacionesDeMas(navegador, 1)
})

test('T1.1 camino 4: hijo de un modificador, que monta el reductor', async t => {
  const navegador = instalarNavegador(window)
  const map = mapa()
  document.body.appendChild(map)
  await esperar(40)
  t.after(() => map.remove())

  const cluster = document.createElement('cristae-cluster')
  cluster.appendChild(capa())
  map.appendChild(cluster)
  await esperar(80)
  sinCreacionesDeMas(navegador)
})

test('T1.1 una source distinta asignada después sí reemplaza la capa: el recambio legítimo sigue andando', async t => {
  const navegador = instalarNavegador(window)
  const map = mapa()
  document.body.appendChild(map)
  await esperar(40)
  t.after(() => map.remove())

  const el = capa()
  map.appendChild(el)
  await esperar(40)
  const antes = navegador.stat()

  const vieja = map.engine.getLayer('p').layer
  el.source = fuente(4)
  await esperar(20)
  const despues = navegador.stat()
  const nueva   = map.engine.getLayer('p').layer
  assert.notEqual(nueva, vieja, 'una capa nueva')
  assert.equal(nueva.surface.state, 'live', 'que ya tiene contexto')
  // El recambio es en la misma tarea: la capa nueva entra al tramo de la vieja, que lo conserva (antes, uno creado y uno
  // devuelto).
  assert.equal(despues.creados - antes.creados, 0, 'sin getContext')
  assert.equal(despues.liberados - antes.liberados, 0, 'ni contexto devuelto')
  assert.equal(despues.vivos, antes.vivos)
})
