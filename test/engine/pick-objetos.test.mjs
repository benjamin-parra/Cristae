// Identidad de OBJETO del pase de picking: el motor la asigna sobre el MISMO registro de capas de pick
// que recorre la sesión, con free-list, y la resuelve al revés para el decodificador. El id 0 significa
// «nada» y no se asigna nunca.

import '../../test-helpers/engine-stub.mjs'
import { makeGlify, makeMap, makeLeaflet, makeIconSet } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { createSource } from '../../src/data/index.js'

const items = [{ id: 1, lat: 0, lng: 0 }]
const accessors = { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }) }
const newEngine = () => new MapEngine({ leaflet: makeLeaflet(), glify: makeGlify(), map: makeMap() })
const addCapa = (engine, id, cfg) => engine.addPointLayer({ id, accessors, iconSet: makeIconSet(), data: items, ...cfg })

test('sólo las capas INTERACTIVAS consumen id de objeto, y cada una el suyo', () => {
  const engine = newEngine()
  addCapa(engine, 'contexto')
  addCapa(engine, 'flota', { interactive: true })
  addCapa(engine, 'badges', { interactive: true })

  const flota  = engine.getLayer('flota').layer
  const badges = engine.getLayer('badges').layer
  assert.ok(flota.pickObject >= 1, 'la interactiva recibe un id asignable (el 0 es «nada»)')
  assert.notEqual(flota.pickObject, badges.pickObject, 'dos capas del pase no comparten identidad')
  assert.equal(engine.getLayer('contexto').layer.pickObject, 0, 'la no interactiva no entra al pase')
})

test('pickLayerOf resuelve el objeto de vuelta a su capa', () => {
  const engine = newEngine()
  addCapa(engine, 'flota', { interactive: true })
  const layer = engine.getLayer('flota').layer

  const entrada = engine.pickLayerOf(layer.pickObject)
  assert.equal(entrada.layerId, 'flota')
  assert.equal(entrada.layer, layer, 'la entrada apunta a la capa viva')
  assert.equal(engine.pickLayerOf(0), null, 'el 0 no está asignado')
  assert.equal(engine.pickLayerOf(9999), null, 'un id nunca entregado tampoco')
})

test('la baja devuelve el id a la free-list y el alta siguiente lo reusa', () => {
  const engine = newEngine()
  addCapa(engine, 'a', { interactive: true })
  addCapa(engine, 'b', { interactive: true })
  const libre = engine.getLayer('a').layer.pickObject

  engine.removeLayer('a')
  assert.equal(engine.pickLayerOf(libre), null, 'el id deja de resolver a la capa dada de baja')

  addCapa(engine, 'c', { interactive: true })
  assert.equal(engine.getLayer('c').layer.pickObject, libre, 'el alta siguiente reusa el id liberado')
  assert.equal(engine.pickLayerOf(libre).layerId, 'c')
})

test('attachSource CONSERVA la identidad de objeto (misma capa del pase, otra fuente)', () => {
  const engine = newEngine()
  addCapa(engine, 'flota', { interactive: true })
  const antes = engine.getLayer('flota').layer.pickObject

  engine.attachSource('flota', createSource(accessors))
  const layer = engine.getLayer('flota').layer
  assert.equal(layer.pickObject, antes, 'el id no se recicla en el swap')
  assert.equal(engine.pickLayerOf(antes).layer, layer, 'y el mapa inverso apunta a la capa nueva')
})
