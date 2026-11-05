// <cristae-overlay>: decorador, el badge va sobre el productor más cercano. Con las firmas REALES registradas por
// el entry: sobre una capa de puntos monta lo mismo que antes del rol, y envolviendo un cluster decora sus
// burbujas. Los hijos son nodos falsos con el protocolo del reductor, o el cluster real; el motor anota las altas.
import '../../test-helpers/element-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../../src/index.js'
import { CristaeOverlay } from '../../src/element/CristaeOverlay.js'
import { CristaeCluster } from '../../src/element/CristaeCluster.js'
import { grammar } from '../../src/element/composite.js'
import { GrammarError, leafUnits } from '../../src/grammar/index.js'

const hoja = (tag, id = tag) => {
  const el = {
    tagName: tag.toUpperCase(), children: [], getAttribute: () => null, _handle: null,
    mountReady: () => true,
    cristaeMount(engine) { el._engine = engine; el._handle = { id } },
    cristaeUnits: () => leafUnits(el, el._engine, grammar),
  }
  return el
}
const puntos = id => hoja('cristae-point-layer', id)

const modificador = (Clase, tag) => (...hijos) => Object.assign(new Clase(), {
  tagName: tag, children: hijos, getAttribute: () => null, _enclosingModifier: () => null,
})
const cluster = modificador(CristaeCluster, 'CRISTAE-CLUSTER')
const overlay = (...hijos) => Object.assign(modificador(CristaeOverlay, 'CRISTAE-OVERLAY')(...hijos), { iconSet: 'badges' })

// Motor falso: anota los hosts de cada badge y de cada fold.
const motor = () => {
  const e = {
    badges: [], folds: [],
    addOverlay: ({ id, hostId }) => (e.badges.push(hostId), { id }),
    addClusterFold: targets => {
      e.folds.push(targets.map(t => t.id))
      const id = `${targets[0].id}:clusters`
      return { kind: 'bubble', id, handle: { id }, suppressed: null }
    },
    getLayer: () => null,
    removeLayer: () => false,
  }
  return e
}

const montar = raiz => {
  const e      = motor()
  const handle = raiz.mountLayer(e)
  return { e, handle, kinds: raiz.cristaeUnits().map(u => u.kind) }
}

test('sobre capas de puntos monta lo mismo que antes del rol', () => {
  const casos = [
    ['overlay > puntos', () => overlay(puntos('flota')), ['flota']],
    ['overlay > puntos, puntos', () => overlay(puntos('camiones'), puntos('gruas')), ['camiones', 'gruas']],
    ['overlay > overlay > puntos', () => overlay(overlay(puntos('flota'))), ['flota', 'flota']],
  ]
  casos.forEach(([arbol, armar, esperado]) => assert.deepEqual(montar(armar()).e.badges, esperado, arbol))

  const { handle, kinds } = montar(overlay(puntos('flota')))
  assert.equal(handle.id, 'flota', 'el handle es el del punto que pasa por debajo')
  assert.deepEqual(kinds, ['point', 'overlay'])
})

test('un cluster que envuelve al overlay clusteriza los puntos, y los badges quedan sobre los puntos', () => {
  const { e, kinds } = montar(cluster(overlay(puntos('flota'))))
  assert.deepEqual(e.badges, ['flota'])
  assert.deepEqual(e.folds, [['flota']])
  assert.deepEqual(kinds, ['point', 'overlay', 'bubble'])
})

test('un overlay que envuelve un cluster decora las burbujas, no los puntos', () => {
  const { e, handle, kinds } = montar(overlay(cluster(puntos('flota'))))
  assert.deepEqual(e.folds, [['flota']])
  assert.deepEqual(e.badges, ['flota:clusters'])
  assert.equal(handle.id, 'flota', 'el handle sigue siendo el del punto')
  assert.deepEqual(kinds, ['point', 'bubble', 'overlay'])
})

test('sin capa de puntos ni burbujas que decorar, R2 antes de tocar el motor', () => {
  const e = motor()
  assert.throws(() => overlay(hoja('cristae-polygon-layer', 'predios')).mountLayer(e),
    err => err instanceof GrammarError && err.code === 'R2')
  assert.deepEqual(e.badges, [])
})
