// Las labels ligadas (`bindTo`) heredan la MEMBRESÍA del host: no etiquetan lo que el host no dibuja.
// El cluster ya estaba cubierto (`suppressed`); faltaba el `where` por-capa, que dejaba etiquetas
// flotando sobre vehículos ocultos.

import '../../test-helpers/engine-stub.mjs'
import { makeGlify, makeMap, makeLeaflet, makeIconSet } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'

const flushRaf = () => new Promise(r => setTimeout(r, 5))
const items = [
  { id: 1, lat: 0, lng: 0, activo: true },
  { id: 2, lat: 1, lng: 1, activo: false },
  { id: 3, lat: 2, lng: 2, activo: true },
]
const accessors = { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }) }

const montar = async where => {
  const engine = new MapEngine({ leaflet: makeLeaflet(), glify: makeGlify(), map: makeMap() })
  const flota  = engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: items, where })
  engine.addLabelLayer({ id: 'rotulos', bindTo: 'flota', textOf: it => `v${it.id}` })
  await flushRaf()
  return { engine, flota }
}

// Intercepta lo que el bind le entrega a la capa de labels (`#labels` es privado). Devuelve un
// `leer()` con lo último capturado y restaura el método al terminar.
const espiarRotulos = engine => {
  const rec  = engine.getLayer('rotulos')
  const real = rec.layer.setLabels.bind(rec.layer)
  const capturas = []
  rec.layer.setLabels = labels => { capturas.push(labels.map(l => l.id).sort((a, b) => a - b)); return real(labels) }
  return { capturas, resync: () => rec.resync(), restaurar: () => { rec.layer.setLabels = real } }
}

test('sin `where`, la label etiqueta todo el snapshot del host', async () => {
  const { engine } = await montar(undefined)
  const espia = espiarRotulos(engine)
  espia.resync()
  assert.deepEqual(espia.capturas.at(-1), [1, 2, 3], 'los tres vehículos rotulados')
  espia.restaurar(); engine.destroy()
})

test('con `where`, NO etiqueta los ítems que el host no dibuja', async () => {
  const { engine } = await montar(it => it.activo)
  const espia = espiarRotulos(engine)
  espia.resync()
  assert.deepEqual(espia.capturas.at(-1), [1, 3], 'el inactivo no lleva etiqueta')
  espia.restaurar(); engine.destroy()
})

// Sin resync explícito: el propio setWhere debe disparar la re-sincronización (la Source no emite
// por un cambio de membresía por-capa).
test('cambiar `where` en caliente resincroniza las labels ligadas', async () => {
  const { engine, flota } = await montar(undefined)
  const espia = espiarRotulos(engine)

  flota.setWhere(it => it.activo)

  assert.ok(espia.capturas.length, 'setWhere resincronizó los ligados por su cuenta')
  assert.deepEqual(espia.capturas.at(-1), [1, 3], 'y ya sin el ítem fuera de membresía')
  espia.restaurar(); engine.destroy()
})
