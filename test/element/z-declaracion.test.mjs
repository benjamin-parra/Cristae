// El z por defecto sigue el orden de declaración en el documento, con elementos REALES (Lit + custom elements en jsdom):
//
// - Una capa declarada antes y montada después (sus accessors llegan tarde) queda debajo de la que montó primero.
// - Mover un elemento con `insertBefore` lo reapila en su lugar nuevo; `_placement` lleva el propio elemento; quitar el
//   atributo `z` vuelve al derivado, no al z con que montó.
//
// Sólo se fija el ORDEN entre derivadas: su número es una posición y cambia cuando monta o se desmonta una capa anterior.
//
// El harness va PRIMERO: window, customElements y lo que Lit toca al evaluar.
import { ACC, armarVacio, esperar, iconSet, items } from '../../test-helpers/modelo-capas.mjs'
import { STACK } from '../../src/engine/stack.js'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

after(() => document.body.replaceChildren())

// La baja compacta en una microtarea; el montaje diferido corre en el ciclo de Lit. Se esperan los dos.
const asentar  = () => esperar(20)
const zDe      = (engine, id) => engine.surfaces().find(s => s.layerId === id)?.z
const capa     = (id, props = {}) => Object.assign(document.createElement('cristae-point-layer'), { id, iconSet, ...props })
const conDatos = { accessors: ACC, data: items(2) }

test('declarada antes y montada después queda debajo de la que ya estaba', async t => {
  const { map } = await armarVacio()
  t.after(() => map.remove())
  const [a, b] = [capa('a'), capa('b', conDatos)]
  map.append(a, b)
  await asentar()
  const { engine } = map
  assert.equal(zDe(engine, 'a'), undefined, 'sin accessors, `a` todavía no monta')
  const zSolo = zDe(engine, 'b')
  assert.ok(zSolo != null, '`b` montó')

  Object.assign(a, conDatos)
  await asentar()
  const [za, zb] = [zDe(engine, 'a'), zDe(engine, 'b')]
  assert.ok(za != null, '`a` montó con sus accessors')
  assert.ok(za < zb, `a (${za}) bajo b (${zb}): manda el documento, no el orden de alta`)
  assert.equal(za, zSolo, '`a` ocupa el lugar que tenía `b` al estar sola; `b` sube un lugar y sigue encima')
})

test('insertBefore reapila por el orden nuevo', async t => {
  const { map } = await armarVacio()
  t.after(() => map.remove())
  const [a, b] = [capa('a', conDatos), capa('b', conDatos)]
  map.append(a, b)
  await asentar()
  const { engine } = map
  assert.ok(zDe(engine, 'a') < zDe(engine, 'b'), 'en orden de documento: a bajo b')

  map.insertBefore(b, a)
  await asentar()
  const [za, zb] = [zDe(engine, 'a'), zDe(engine, 'b')]
  assert.ok(za != null && zb != null, 'las dos volvieron a montar')
  assert.ok(zb < za, `tras mover b antes de a: b (${zb}) bajo a (${za})`)
})

test('`_placement` lleva el propio elemento bajo STACK', () => {
  const el = capa('suelta')
  assert.equal(el._placement[STACK], el)
})

test('quitar el atributo `z` vuelve al derivado, no al z con que montó', async t => {
  const { map } = await armarVacio()
  t.after(() => map.remove())
  const [a, c] = [capa('a', conDatos), capa('c', conDatos)]
  c.setAttribute('z', '620')
  map.append(a, c)
  await asentar()
  const { engine } = map
  assert.equal(zDe(engine, 'c'), 620, 'el z explícito gana')

  c.removeAttribute('z')
  await asentar()
  const [za, zc] = [zDe(engine, 'a'), zDe(engine, 'c')]
  assert.notEqual(zc, 620, 'sin `z` no se queda en el del alta')
  assert.ok(za < zc, `vuelve a su lugar por declaración: sobre a (${za}), en ${zc}`)
  assert.ok(zc < 600, `y en el plano base, bajo el de rótulos (${zc})`)
})
