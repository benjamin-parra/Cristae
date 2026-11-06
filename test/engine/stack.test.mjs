// Orden de declaración de `createStack`: declaradas por orden de documento (pre-orden, shadow root por su host),
// imperativas encima por orden de alta, rangos densos. El documento es un jsdom propio: `stack.js` no lee globales.
import { JSDOM } from 'jsdom'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStack } from '../../src/engine/stack.js'

const documento = html => new JSDOM(`<!doctype html><body>${html}</body>`).window.document

// [id, rango] de forEachFrom(desde)
const orden = (stack, desde = 0) => {
  const visto = []
  stack.forEachFrom(desde, (id, rank) => visto.push([id, rank]))
  return visto
}

// Cuenta las llamadas a compareDocumentPosition de cada nodo.
const espiar = nodos => {
  const cuenta = new Map(nodos.map(n => [n, 0]))
  nodos.forEach(n => {
    const original = n.compareDocumentPosition.bind(n)
    n.compareDocumentPosition = otro => {
      cuenta.set(n, cuenta.get(n) + 1)
      return original(otro)
    }
  })
  return cuenta
}

test('pre-orden con modificadores anidados: el orden de alta no importa', () => {
  const doc       = documento('<m><c><a></a><b></b></c><d></d></m>')
  const [a, b, d] = ['a', 'b', 'd'].map(t => doc.querySelector(t))
  const stack     = createStack()
  assert.equal(stack.insert('d', d), 0)
  assert.equal(stack.insert('b', b), 0)
  assert.equal(stack.insert('a', a), 0)
  assert.deepEqual(orden(stack), [['a', 0], ['b', 1], ['d', 2]])
})

test('montar en orden cuesta una comparación, contra la última', () => {
  const doc   = documento('<a></a><b></b><c></c><d></d>')
  const nodos = ['a', 'b', 'c', 'd'].map(t => doc.querySelector(t))
  const stack = createStack()
  nodos.slice(0, 3).forEach(n => stack.insert(n.localName, n))
  const cuenta = espiar(nodos)
  assert.equal(stack.insert('d', nodos[3]), 3)
  assert.deepEqual([...cuenta.values()], [0, 0, 1, 0])
})

test('shadow root contra light: el contenido de sombra cae donde está su host', () => {
  const doc       = documento('<i id="x"></i><span id="h"></span><i id="y"></i>')
  const [x, h, y] = ['x', 'h', 'y'].map(id => doc.getElementById(id))
  const raiz      = h.attachShadow({ mode: 'open' })
  const dentro    = raiz.appendChild(doc.createElement('i'))
  const anidada   = raiz.appendChild(doc.createElement('span')).attachShadow({ mode: 'open' })
  const hondo     = anidada.appendChild(doc.createElement('i'))
  const stack     = createStack()
  stack.insert('y', y)
  stack.insert('hondo', hondo)
  stack.insert('dentro', dentro)
  stack.insert('x', x)
  stack.insert('h', h)
  assert.deepEqual(orden(stack).map(([id]) => id), ['x', 'h', 'dentro', 'hondo', 'y'], 'el host precede a su sombra')

  const ajeno = documento('<i></i>').querySelector('i')
  assert.equal(stack.insert('ajeno', ajeno), 5, 'sin raíz común cuenta como posterior')
})

test('sin compareDocumentPosition o desconectado es imperativa, encima de las declaradas y en orden de alta', () => {
  const doc    = documento('<a></a><b></b>')
  const [a, b] = ['a', 'b'].map(t => doc.querySelector(t))
  const stack  = createStack()
  assert.equal(stack.insert('plano', {}), 0)
  assert.equal(stack.insert('stub', new (class {})()), 1)
  assert.equal(stack.insert('suelto', doc.createElement('c')), 2)
  assert.equal(stack.insert('sin-at'), 3)
  assert.equal(stack.insert('b', b), 0)
  assert.equal(stack.insert('a', a), 0)
  assert.deepEqual(orden(stack), [['a', 0], ['b', 1], ['plano', 2], ['stub', 3], ['suelto', 4], ['sin-at', 5]])
})

test('una entrada desconectada en medio se salta sin compararla', () => {
  const doc       = documento('<a></a><b></b><c></c>')
  const [a, b, c] = ['a', 'b', 'c'].map(t => doc.querySelector(t))
  const stack     = createStack()
  stack.insert('a', a)
  stack.insert('b', b)
  stack.insert('c', c)
  const nuevo = doc.createElement('n')
  b.replaceWith(nuevo)
  const cuenta = espiar([a, b, c])
  assert.equal(stack.insert('n', nuevo), 1)
  assert.equal(cuenta.get(b), 0, 'el nodo desconectado no se compara')
  assert.equal(stack.remove('b'), 2)
  assert.deepEqual(orden(stack), [['a', 0], ['n', 1], ['c', 2]])
})

test('insert de un id presente lo reubica sin duplicar', () => {
  const doc       = documento('<a></a><b></b><c></c>')
  const [a, b, c] = ['a', 'b', 'c'].map(t => doc.querySelector(t))
  const stack     = createStack()
  stack.insert('p', a)
  stack.insert('q', b)
  stack.insert('i')
  assert.equal(stack.insert('p', c), 1)
  assert.deepEqual(orden(stack), [['q', 0], ['p', 1], ['i', 2]])
  assert.equal(stack.insert('q'), 2, 'de declarada a imperativa')
  assert.deepEqual(orden(stack), [['p', 0], ['i', 1], ['q', 2]])
})

test('remove devuelve el rango que tenía y compacta; un id ausente da -1', () => {
  const doc   = documento('<a></a><b></b><c></c>')
  const nodos = ['a', 'b', 'c'].map(t => doc.querySelector(t))
  const stack = createStack()
  nodos.forEach(n => stack.insert(n.localName, n))
  stack.insert('x')
  stack.insert('y')
  assert.equal(stack.remove('b'), 1)
  assert.deepEqual(orden(stack), [['a', 0], ['c', 1], ['x', 2], ['y', 3]])
  assert.equal(stack.remove('x'), 2)
  assert.deepEqual(orden(stack), [['a', 0], ['c', 1], ['y', 2]])
  assert.equal(stack.remove('nada'), -1)
  assert.equal(stack.remove('x'), -1)
})

test('forEachFrom arranca en el rango pedido y cruza a las imperativas', () => {
  const doc   = documento('<a></a><b></b>')
  const stack = createStack()
  stack.insert('x')
  doc.querySelectorAll('a, b').forEach(n => stack.insert(n.localName, n))
  stack.insert('y')
  assert.deepEqual(orden(stack, 1), [['b', 1], ['x', 2], ['y', 3]])
  assert.deepEqual(orden(stack, 3), [['y', 3]])
  assert.deepEqual(orden(stack, 4), [])
})

test('la re-alta de una imperativa la pone arriba de las demás', () => {
  const stack = createStack()
  ;['x', 'y', 'z'].forEach(id => stack.insert(id))
  assert.equal(stack.insert('x'), 2)
  assert.deepEqual(orden(stack), [['y', 0], ['z', 1], ['x', 2]])
  stack.remove('y')
  assert.equal(stack.insert('y'), 2)
  assert.deepEqual(orden(stack), [['z', 0], ['x', 1], ['y', 2]])
})
