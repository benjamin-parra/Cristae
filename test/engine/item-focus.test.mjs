// Eje `focus` por ÍTEM (setLayerFocus): mientras alguna capa lo declare, TODAS las capas se atenúan
// (por opacidad de pane — el basemap no es una capa, así que queda encendido) y los ítems enfocados se
// reponen brillantes en un pase encima. Polimórfico: iterable | falsy (todo atenuado) | undefined (retiro).

import '../../test-helpers/engine-stub.mjs'
import { makeGlify, makeMap, makeLeaflet, makeIconSet } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'

const flushRaf = () => new Promise(r => setTimeout(r, 5))
const items = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, lat: i * 0.1, lng: i * 0.2, size: 24 }))
const accessors = { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }), sizeOf: it => it.size }
const newEngine = () => new MapEngine({ leaflet: makeLeaflet(), glify: makeGlify(), map: makeMap() })

// Opacidad efectiva del pane de una capa ('' = plena).
const opacidad = (engine, paneName) => engine.getLeafletMap().getPane(paneName)?.style.opacity ?? ''

const conDosCapas = async () => {
  const engine = newEngine()
  engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: items })
  engine.addPointLayer({ id: 'otra', accessors, iconSet: makeIconSet(), data: items })
  await flushRaf()
  return engine
}

test('declarar foco en UNA capa atenúa TODAS (cross-layer automático)', async () => {
  const engine = await conDosCapas()
  assert.equal(opacidad(engine, 'cristae-point-flota'), '', 'sin foco: plena')

  engine.setLayerFocus('flota', [2, 5])
  assert.notEqual(opacidad(engine, 'cristae-point-flota'), '', 'la capa que declara el foco se atenúa')
  assert.notEqual(opacidad(engine, 'cristae-point-otra'), '', 'la OTRA capa también (sin declararlo)')

  engine.setLayerFocus('flota', undefined)                 // retiro del eje
  assert.equal(opacidad(engine, 'cristae-point-flota'), '', 'al retirarse, restaura')
  assert.equal(opacidad(engine, 'cristae-point-otra'), '', 'restaura también la otra capa')
  engine.destroy()
})

test('falsy → todo atenuado y ningún ítem brillante; iterable → repone los suyos', async () => {
  const engine = await conDosCapas()

  engine.setLayerFocus('flota', null)                      // falsy: nada enfocado
  assert.notEqual(opacidad(engine, 'cristae-point-flota'), '', 'falsy atenúa igual')
  await flushRaf()
  const panePase = engine.getLeafletMap().getPane('cristae-highlight-focus-flota')
  assert.ok(panePase, 'el pase brillante existe (aunque no dibuje nada)')

  engine.setLayerFocus('flota', [1, 3])
  await flushRaf()
  assert.notEqual(opacidad(engine, 'cristae-point-flota'), '', 'sigue atenuada; lo brillante va en el pase')
  engine.destroy()
})

test('el pase brillante RE-DIBUJA el sprite del ítem enfocado (tile del atlas, tamaño y rumbo)', async () => {
  const engine = newEngine()
  const dibujos = []
  const iconSet = makeIconSet()
  iconSet.atlas.tileAt = () => ({ _tile: true })                 // canvas del atlas (drawImage lo consume)
  engine.addPointLayer({ id: 'flota', accessors, iconSet, data: items })
  await flushRaf()

  // El pase dibuja sobre el ctx del overlay; interceptamos drawImage del canvas que monta el motor.
  const pane = engine.getLeafletMap().getPane('cristae-point-flota')
  assert.ok(pane, 'la capa montó su pane')

  engine.setLayerFocus('flota', [2])
  await flushRaf()
  const panePase = engine.getLeafletMap().getPane('cristae-highlight-focus-flota')
  assert.ok(panePase, 'monta un pane propio para el pase (no se atenúa con las capas)')
  assert.equal(dibujos.length, 0, 'el ctx stub es no-op: acá sólo se caracteriza el cableado')
  engine.destroy()
})

test('CRUZADO: varias capas declaran foco a la vez, cada una con sus propios ids', async () => {
  const engine = await conDosCapas()

  engine.setLayerFocus('flota', [2, 5])
  engine.setLayerFocus('otra', [1])
  await flushRaf()

  assert.notEqual(opacidad(engine, 'cristae-point-flota'), '', 'ambas atenuadas')
  assert.notEqual(opacidad(engine, 'cristae-point-otra'), '', 'ambas atenuadas')
  assert.ok(engine.getLeafletMap().getPane('cristae-highlight-focus-flota'), 'pase propio de la capa A')
  assert.ok(engine.getLeafletMap().getPane('cristae-highlight-focus-otra'), 'pase propio de la capa B')

  engine.setLayerFocus('flota', undefined)                 // se retira UNA; la otra sostiene el eje
  assert.notEqual(opacidad(engine, 'cristae-point-otra'), '', 'sigue atenuado mientras quede un declarante')

  engine.setLayerFocus('otra', undefined)                  // se retira la última
  assert.equal(opacidad(engine, 'cristae-point-flota'), '', 'sin declarantes, restaura')
  assert.equal(opacidad(engine, 'cristae-point-otra'), '', 'sin declarantes, restaura')
  engine.destroy()
})

test('una capa nativa atenúa por FEATURE: su pane queda pleno y no necesita pase brillante', async () => {
  const engine = await conDosCapas()
  engine.addPolygonLayer({
    id: 'zonas',
    accessors: { idOf: it => it.id, ringsOf: () => [[[0, 0], [0, 1], [1, 1]]] },
    data: [{ id: 'z1' }, { id: 'z2' }],
  })
  await flushRaf()

  engine.setLayerFocus('zonas', ['z1'])
  assert.equal(opacidad(engine, 'cristae-polygon-zonas'), '',
    'el pane NO se atenúa: la capa lo resolvió por feature (exacto)')
  assert.notEqual(opacidad(engine, 'cristae-point-flota'), '',
    'la capa GL sí atenúa su pane (no tiene identidad por feature)')
  assert.equal(engine.getLeafletMap().getPane('cristae-highlight-focus-zonas'), null,
    'sin pase brillante: no le hace falta')
  engine.destroy()
})

test('removeLayer limpia el eje: la capa restante vuelve a opacidad plena', async () => {
  const engine = await conDosCapas()
  engine.setLayerFocus('flota', [2])
  assert.notEqual(opacidad(engine, 'cristae-point-otra'), '', 'atenuada por el foco de la otra capa')

  engine.removeLayer('flota')                              // se va la única capa que declaraba foco
  assert.equal(opacidad(engine, 'cristae-point-otra'), '', 'sin declarantes, se restaura sola')
  engine.destroy()
})

test('el foco por ítem gana sobre el foco por CAPA (un solo resolutor de opacidad)', async () => {
  const engine = await conDosCapas()
  engine.focus(['flota'])                                  // eje por capa: 'flota' plena, resto atenuado
  assert.equal(opacidad(engine, 'cristae-point-flota'), '', 'por capa: la enfocada queda plena')

  engine.setLayerFocus('flota', [2])                       // entra el eje por ítem
  assert.notEqual(opacidad(engine, 'cristae-point-flota'), '', 'por ítem: TODAS se atenúan, incluida ésa')

  engine.setLayerFocus('flota', undefined)                 // se retira → vuelve a mandar el eje por capa
  assert.equal(opacidad(engine, 'cristae-point-flota'), '', 'restaura la resolución por capa')
  assert.notEqual(opacidad(engine, 'cristae-point-otra'), '', 'y el resto sigue atenuado por focus()')
  engine.destroy()
})
