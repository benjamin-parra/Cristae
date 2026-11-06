// El rol de una firma y lo que se deriva de él: cómo se reduce cada rol (`deriveSignature`, la firma que leen
// reduce.js y validate.js; `signatureFor` devuelve sólo lo declarado) y cómo lo nombran los errores del juicio
// de árbol. Golden literal de los mensajes: es lo único
// que ve quien arma un árbol inválido. Sin DOM: nodos con la interfaz mínima de Element.
// Corre con: node --test test/grammar-roles.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { defineGrammar, validate, reduceModifier, GrammarError } from '../src/grammar/index.js'
import { deriveSignature } from '../src/grammar/grammar.js'

const g = defineGrammar({ kinds: ['point', 'label', 'line', 'polygon', 'shape', 'html', 'bubble', 'overlay', 'geodesic', 'heat'] })
g.register('cristae-point-layer', { role: 'leaf', produces: ['point'] })
g.register('cristae-line-layer', { role: 'leaf', produces: ['line'] })
g.register('cristae-heat-layer', { role: 'leaf', produces: ['heat'] })
g.register('cristae-label-layer', { role: 'leaf', produces: ['label'] })
g.register('cristae-geodesic', { role: 'transform', consumes: ['line', 'polygon'], produces: ['geodesic'] })
g.register('cristae-cluster', { role: 'aggregate', consumes: ['point'], produces: ['point', 'bubble'] })
g.register('cristae-absorbe', { role: 'aggregate', consumes: ['point'], produces: ['bubble'] })
g.register('cristae-overlay', { role: 'decorate', consumes: ['point'], produces: ['overlay'] })
g.register('cristae-labeled', { role: 'decorate', consumes: ['point', 'line', 'polygon', 'shape', 'html', 'bubble'], produces: ['label'] })

const vctx  = { signatureFor: g.signatureFor, isRegistered: g.isRegistered, mode: 'throw' }
const nodo  = (tag, ...children) => ({ tagName: tag.toUpperCase(), children, getAttribute: () => null })
const error = raiz => { try { validate(raiz, vctx) } catch (e) { return e } assert.fail('el árbol debía ser inválido') }

/* ════════════════ Un rol, una forma de reducir ════════════════ */

const derivada = tag => deriveSignature(g.signatureFor(tag))

test('signatureFor devuelve sólo lo declarado: role, consumes y produces', () => {
  assert.deepEqual(g.signatureFor('cristae-point-layer'), { role: 'leaf', consumes: [], produces: ['point'] })
  assert.deepEqual(g.signatureFor('cristae-overlay'), { role: 'decorate', consumes: ['point'], produces: ['overlay'] })
  assert.equal(derivada('cristae-cluster'), derivada('cristae-cluster'), 'la derivada se arma una vez por firma')
})

test('leaf: hoja sin combine ni consumes', () => {
  assert.deepEqual(derivada('cristae-point-layer'),
    { role: 'leaf', consumes: [], produces: ['point'], combine: null, arity: 'leaf', reach: 'all', passThrough: true })
  assert.equal(g.isLeaf('cristae-point-layer'), true)
})

test('transform: un apply por capa consumida del subárbol, y lo consumido sube', () => {
  assert.deepEqual(derivada('cristae-geodesic'),
    { role: 'transform', consumes: ['line', 'polygon'], produces: ['geodesic'], combine: 'map', arity: 'wrapper', reach: 'all', passThrough: true })
})

test('aggregate: un apply sobre todo el subárbol; re-emite lo consumido sólo si vuelve a producirlo', () => {
  assert.deepEqual(derivada('cristae-cluster'),
    { role: 'aggregate', consumes: ['point'], produces: ['point', 'bubble'], combine: 'fold', arity: 'wrapper', reach: 'all', passThrough: true })
  assert.equal(derivada('cristae-absorbe').passThrough, false)
})

test('decorate: un apply por productor más cercano, y lo decorado sube', () => {
  assert.deepEqual(derivada('cristae-overlay'),
    { role: 'decorate', consumes: ['point'], produces: ['overlay'], combine: 'map', arity: 'wrapper', reach: 'nearest', passThrough: true })
  assert.equal(g.isWrapper('cristae-labeled'), true)
})

/* ════════════════ Los errores nombran el rol ════════════════ */

test('R1: una hoja con hijos', () => {
  const e = error(nodo('cristae-point-layer', nodo('cristae-point-layer')))
  assert.equal(e.code, 'R1')
  assert.equal(e.message,
    "[cristae-grammar] <cristae-point-layer> es una hoja (kind 'point') y no puede envolver hijos; encontró <cristae-point-layer>.")
})

test('R3: un decorador vacío', () => {
  const e = error(nodo('cristae-labeled'))
  assert.ok(e instanceof GrammarError)
  assert.equal(e.code, 'R3')
  assert.equal(e.message,
    '[cristae-grammar] <cristae-labeled> es un decorador y no envuelve ninguna capa que produzca (point, line, polygon, shape, html, bubble).')
})

test('R2: un decorador que sólo envuelve lo que no consume', () => {
  const e = error(nodo('cristae-labeled', nodo('cristae-heat-layer')))
  assert.equal(e.code, 'R2')
  assert.equal(e.message,
    '[cristae-grammar] <cristae-labeled> es un decorador y no envuelve ninguna capa que produzca (point, line, polygon, shape, html, bubble) (los hijos producen: [heat]).')
})

test('R3: un agregador vacío', () => {
  const e = error(nodo('cristae-cluster'))
  assert.equal(e.code, 'R3')
  assert.equal(e.message, "[cristae-grammar] <cristae-cluster> es un agregador: consume 'point' y no hay capas de 'point' adentro.")
})

test('R2: un agregador sin capas de lo que consume', () => {
  const e = error(nodo('cristae-cluster', nodo('cristae-label-layer')))
  assert.equal(e.code, 'R2')
  assert.equal(e.message,
    "[cristae-grammar] <cristae-cluster> es un agregador: consume 'point' y no hay capas de 'point' adentro (los hijos producen: [label]).")
})

test('R2: un transformador sin capas de lo que consume', () => {
  const e = error(nodo('cristae-geodesic', nodo('cristae-point-layer')))
  assert.equal(e.code, 'R2')
  assert.equal(e.message,
    "[cristae-grammar] <cristae-geodesic> es un transformador: consume 'line' o 'polygon' y no hay capas de 'line' o 'polygon' adentro (los hijos producen: [point]).")
})

test('el overlay como decorador valida igual que cuando tomaba el subárbol', () => {
  for (const raiz of [
    nodo('cristae-overlay', nodo('cristae-point-layer')),
    nodo('cristae-overlay', nodo('cristae-cluster', nodo('cristae-point-layer'))),
    nodo('cristae-overlay', nodo('cristae-overlay', nodo('cristae-point-layer'))),
    nodo('cristae-cluster', nodo('cristae-overlay', nodo('cristae-point-layer'))),
  ]) assert.equal(validate(raiz, vctx), true)
  assert.equal(error(nodo('cristae-overlay', nodo('cristae-label-layer'))).code, 'R2')
})

test('validate y reduceModifier aceptan un ctx propio que devuelve firmas { role, consumes, produces }', () => {
  const firmas = {
    'CRISTAE-POINT-LAYER': { role: 'leaf', produces: ['point'] },
    'CRISTAE-OVERLAY'    : { role: 'decorate', consumes: ['point'], produces: ['overlay'] },
  }
  const propio = { signatureFor: tag => firmas[tag] ?? null, isRegistered: tag => tag in firmas, applyFor: () => null, mode: 'throw' }
  const hoja   = Object.assign(nodo('cristae-point-layer'), { cristaeMount: () => {}, cristaeUnits: () => [{ kind: 'point', id: 'p' }] })
  const raiz   = nodo('cristae-overlay', hoja)

  assert.equal(validate(raiz, propio), true)
  assert.deepEqual(reduceModifier(raiz, {}, propio).map(u => u.id), ['p'])
})
