// El alcance del decorador en el segmento de gramática: el reductor y la validación toman lo que cada hijo
// directo produce como propio (`produces − consumes`), y un wrapper sin kinds propios consumidos es
// transparente. El cluster y la geodésica toman el subárbol y reducen como antes; el overlay, decorador,
// da lo mismo que cuando tomaba el subárbol. Elementos falsos con el protocolo
// del reductor y un motor que anota cada apply, como test/grammar.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defineGrammar, GrammarError, leafUnits, reduceModifier, validate } from '../src/grammar/index.js'
import { reachedKinds } from '../src/grammar/validate.js'

const g = defineGrammar({ kinds: ['point', 'label', 'polygon', 'line', 'bubble', 'overlay', 'geodesic', 'heat'] })

// El motor falso anota cada apply como [modificador, ids de los targets].
const calls = []
const anotar = (quien, out) => (_engine, targets) => {
  calls.push([quien, targets.map(t => t.id)])
  return targets.length ? out(targets) : []
}

g.register('point', { role: 'leaf', produces: ['point'] })
g.register('line', { role: 'leaf', produces: ['line'] })
g.register('heat', { role: 'leaf', produces: ['heat'] })
g.register('cluster', { role: 'aggregate', consumes: ['point'], produces: ['point', 'bubble'] },
  { apply: anotar('cluster', ts => [{ kind: 'bubble', id: `${ts[0].id}:clusters` }]) })
g.register('overlay', { role: 'decorate', consumes: ['point'], produces: ['overlay'] },
  { apply: anotar('overlay', ([t]) => [{ kind: 'overlay', id: `${t.id}:overlay` }]) })
g.register('geodesic', { role: 'transform', consumes: ['line', 'polygon'], produces: ['geodesic'] },
  { apply: anotar('geodesic', ([t]) => [{ kind: 'geodesic', id: `${t.id}:geodesic` }]) })
g.register('labeled', { role: 'decorate', consumes: ['point', 'line', 'polygon', 'bubble'], produces: ['label'] },
  { apply: anotar('labeled', ([t]) => [{ kind: 'label', id: `${t.id}:label` }]) })
// Un cluster que no emite burbujas, como uno con `enabled="false"`.
g.register('cluster-off', { role: 'aggregate', consumes: ['point'], produces: ['point', 'bubble'] },
  { apply: anotar('cluster-off', () => []) })

const ctx  = { signatureFor: g.signatureFor, applyFor: g.applyFor, isRegistered: g.isRegistered }
const vctx = { ...ctx, mode: 'throw' }

const nodo = (tag, ...children) => {
  const n = { tagName: tag.toUpperCase(), children, getAttribute: () => null, _handle: null, _engine: null, _units: null }
  n.cristaeMount = engine => {
    n._engine = engine
    if (g.isLeaf(tag)) n._handle = { id: n.id }
    else n._units = reduceModifier(n, engine, ctx)
  }
  n.cristaeUnits = () => (g.isLeaf(tag) ? leafUnits(n, n._engine, ctx) : n._units ?? [])
  return n
}
const hoja = (tag, id) => Object.assign(nodo(tag), { id })
const motor = { getLayer: () => null }

// Monta el árbol y devuelve los applies en orden de montaje.
const reducir = raiz => {
  calls.length = 0
  validate(raiz, vctx)
  raiz.cristaeMount(motor)
  return calls.slice()
}

test('labeled > puntos rotula los puntos', () => {
  assert.deepEqual(reducir(nodo('labeled', hoja('point', 'flota'))), [['labeled', ['flota']]])
})

test('labeled > geodesic > line: la geodésica es transparente', () => {
  assert.deepEqual(reducir(nodo('labeled', nodo('geodesic', hoja('line', 'rutas')))),
    [['geodesic', ['rutas']], ['labeled', ['rutas']]])
})

test('labeled > overlay > puntos rotula los puntos y no los badges', () => {
  assert.deepEqual(reducir(nodo('labeled', nodo('overlay', hoja('point', 'flota')))),
    [['overlay', ['flota']], ['labeled', ['flota']]])
})

test('labeled > cluster > puntos rotula las burbujas y no las hojas sueltas', () => {
  const raiz = nodo('labeled', nodo('cluster', hoja('point', 'flota')))
  assert.deepEqual(reducir(raiz), [['cluster', ['flota']], ['labeled', ['flota:clusters']]])
  assert.deepEqual(raiz.cristaeUnits().map(u => [u.kind, u.id]),
    [['point', 'flota'], ['bubble', 'flota:clusters'], ['label', 'flota:clusters:label']], 'todo sube intacto')
})

test('cluster > labeled > puntos: el cluster sigue viendo los puntos', () => {
  assert.deepEqual(reducir(nodo('cluster', nodo('labeled', hoja('point', 'flota')))),
    [['labeled', ['flota']], ['cluster', ['flota']]])
})

test('labeled > cluster > labeled > puntos: cada uno lo suyo', () => {
  assert.deepEqual(reducir(nodo('labeled', nodo('cluster', nodo('labeled', hoja('point', 'flota'))))),
    [['labeled', ['flota']], ['cluster', ['flota']], ['labeled', ['flota:clusters']]])
})

test('labeled > labeled > line: el de adentro es transparente y la línea se rotula dos veces', () => {
  assert.deepEqual(reducir(nodo('labeled', nodo('labeled', hoja('line', 'rutas')))),
    [['labeled', ['rutas']], ['labeled', ['rutas']]])
})

test('decide por la firma: un cluster sin burbujas no deja ver sus puntos', () => {
  assert.deepEqual(reducir(nodo('labeled', nodo('cluster-off', hoja('point', 'flota')))),
    [['cluster-off', ['flota']]], 'el labeled no rotula nada')
})

test('reachedKinds sigue la misma regla, sin montar', () => {
  const kinds = raiz => [...reachedKinds(raiz, ctx)].sort()
  assert.deepEqual(kinds(nodo('labeled', hoja('point', 'a'), nodo('geodesic', hoja('line', 'b')))), ['line', 'point'])
  assert.deepEqual(kinds(nodo('labeled', nodo('cluster', hoja('point', 'a')))), ['bubble'])
  assert.deepEqual(kinds(nodo('labeled', nodo('overlay', hoja('point', 'a')), hoja('heat', 'c'))), ['point'])
  assert.deepEqual(kinds(nodo('cluster', nodo('overlay', hoja('point', 'a')))), ['point'], 'agregador: el subárbol')
})

test('R2 con reach: envolver sólo lo que no se consume', () => {
  const r2 = raiz => assert.throws(() => validate(raiz, vctx), e => e instanceof GrammarError && e.code === 'R2')
  r2(nodo('labeled', hoja('heat', 'calor')))
  r2(nodo('labeled', hoja('heat', 'calor'), hoja('heat', 'otro')))
  assert.equal(validate(nodo('labeled', hoja('heat', 'calor'), hoja('point', 'flota')), vctx), true, 'un hermano rotulable alcanza')
})

test('un hermano que no se consume pasa intacto', () => {
  const raiz = nodo('labeled', hoja('heat', 'calor'), hoja('point', 'flota'))
  assert.deepEqual(reducir(raiz), [['labeled', ['flota']]])
  assert.deepEqual(raiz.cristaeUnits().map(u => u.id), ['calor', 'flota', 'flota:label'])
})

test('cluster, overlay y geodésica reducen como antes', () => {
  assert.deepEqual(reducir(nodo('cluster', nodo('overlay', hoja('point', 'a')), hoja('point', 'b'))),
    [['overlay', ['a']], ['cluster', ['a', 'b']]])
  assert.deepEqual(reducir(nodo('overlay', nodo('cluster', hoja('point', 'a')))),
    [['cluster', ['a']], ['overlay', ['a']]], 'el cluster no produce puntos propios: el overlay lo atraviesa')
  assert.deepEqual(reducir(nodo('geodesic', nodo('geodesic', hoja('line', 'r')))),
    [['geodesic', ['r']], ['geodesic', ['r']]])
})
