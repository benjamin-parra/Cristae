// El indicador del estado de dibujo de <cristae-map>: nace con la base al entrar al estado, se va entero
// al salir, y `drawingIndicator` lo altera una vez por indicador nuevo. El estado lo dan las señales del
// motor REAL con un editor REAL; sin DOM, el ciclo de Lit corre a mano y lo que se mira es el nodo que el
// render pone. Corre con:
//   node --test test/element/map-indicador-de-dibujo.test.mjs
// El harness va PRIMERO: window/document y lo que Lit toca al evaluar.
import { montarMapa } from '../../test-helpers/element-stub.mjs'
import { conGlDeEdicion, decorarElementos, makeEditGl } from '../../test-helpers/engine-stub.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { CristaeMap } from '../../src/element/CristaeMap.js'

// Los <div> con los atributos y los hijos que el elemento y las funciones de los tests les ponen.
const sinNodos = decorarElementos((el, tag) => tag === 'div' ? Object.assign(el, {
  attrs    : {},
  children : [],
  setAttribute(k, v) { this.attrs[k] = String(v) },
  append(...hijos) { this.children.push(...hijos) },
  replaceChildren(...hijos) { this.children = hijos },
}) : el)
const sinGl = conGlDeEdicion(() => makeEditGl())
after(() => { sinGl(); sinNodos() })

// Lo que hace el navegador al definir el elemento: las propiedades pasan a ser accessors que avisan.
void CristaeMap.observedAttributes

// El mapa con un editor de polígono y el ciclo de Lit a mano: cada cambio se anota con su valor de antes,
// una vez por update como en Lit, y `actualizar` corre willUpdate, el render y updated, y devuelve el
// indicador que el render pone, que `puesto()` da desde antes de updated. `hijo`, si viene, es el
// `cristaeMount` de un editor que se encola antes del montaje.
const montar = async hijo => {
  const cambios = new Map()
  let puesto    = null
  const { el } = await montarMapa({ noZoomControl: true }, undefined, el => {
    el.requestUpdate = (name, antes) =>
      name === undefined || Object.is(el[name], antes) || cambios.has(name) || cambios.set(name, antes)
    hijo && el.requestMount({ cristaeMount: hijo })
  })
  const actualizar = () => {
    const changed = new Map(cambios)
    cambios.clear()
    el.willUpdate(changed)
    puesto = el.render().values.find(v => v?.attrs?.part === 'drawing-indicator') ?? null
    el.updated(changed)
    return puesto
  }
  const editor = el.engine.addEditableLayer({ id: 'geo', kind: 'polygon', mode: 'edit' })
  return { el, editor, actualizar, puesto: () => puesto }
}

const esBase = nodo => nodo.attrs['aria-hidden'] === 'true'

test('la prop no tiene atributo, el indicador no toma el puntero y la base pinta en currentColor', () => {
  assert.equal(CristaeMap.elementProperties.get('drawingIndicator').attribute, false, 'en React, null va por propiedad')
  const css = [CristaeMap.styles].flat(Infinity).map(s => s.cssText).join('')
  assert.match(css, /\.drawing-indicator\s*\{[^}]*pointer-events:\s*none/, 'la pulsación es del editor')
  assert.match(css, /\.drawing-indicator > \.base\s*\{[^}]*currentColor/, '::part(drawing-indicator) { color } la tiñe')
})

test('al entrar al estado aparece el indicador con la base, y al salir se va entero', async () => {
  const { el, editor, actualizar } = await montar()
  assert.equal(actualizar(), null, 'en edit no hay estado')

  editor.setMode('draw')
  const indicador = actualizar()
  assert.equal(indicador.attrs.part, 'drawing-indicator')
  assert.deepEqual(indicador.children.map(esBase), [true], 'la base es su único hijo')

  editor.setMode('freehand')
  assert.equal(actualizar(), indicador, 'draw y freehand son el mismo estado')
  el.engine.removeLayer('geo')
  assert.equal(actualizar(), null)
  el.disconnectedCallback()
})

test('componer agrega y la base queda; replaceChildren la reemplaza', async () => {
  const { el, editor, actualizar } = await montar()
  const label = { part: 'label' }
  const tint  = { part: 'tint' }
  el.drawingIndicator = indicator => indicator.append(label)
  editor.setMode('draw')
  const compuesto = actualizar()
  assert.deepEqual(compuesto.children.map(hijo => hijo === label || esBase(hijo)), [true, true])

  el.drawingIndicator = indicator => indicator.replaceChildren(tint)
  const reemplazado = actualizar()
  assert.deepEqual(reemplazado.children, [tint])
  assert.equal(compuesto.children.length, 2, 'el indicador anterior no se vacía: se reemplaza por otro')
  el.disconnectedCallback()
})

test('null no muestra nada con el estado activo, y undefined repone la base', async () => {
  const { el, editor, actualizar } = await montar()
  editor.setMode('draw')
  actualizar()

  el.drawingIndicator = null
  assert.equal(actualizar(), null)
  assert.equal(el._drawing, true, 'el estado sigue')
  el.drawingIndicator = undefined
  assert.deepEqual(actualizar().children.map(esBase), [true])
  el.disconnectedCallback()
})

test('la función corre una vez por entrada y otra al reasignarla, siempre sobre un indicador nuevo y ya puesto', async () => {
  const { el, editor, actualizar, puesto } = await montar()
  const vistos = []
  const anotar = indicator => vistos.push(indicator === puesto() ? indicator : 'antes del render')
  el.drawingIndicator = anotar
  actualizar()
  assert.equal(vistos.length, 0, 'fuera del estado no corre')

  editor.setMode('draw')
  const primero = actualizar()
  actualizar()
  editor.setMode('edit')
  editor.setMode('draw')
  assert.equal(actualizar(), primero, 'draw→edit→draw en el mismo tick no rehace nada')
  assert.deepEqual(vistos, [primero])

  el.drawingIndicator = indicator => anotar(indicator)
  const segundo = actualizar()
  editor.setMode('edit')
  actualizar()
  editor.setMode('draw')
  const tercero = actualizar()
  assert.deepEqual(vistos, [primero, segundo, tercero])
  assert.equal(new Set(vistos).size, 3)
  el.disconnectedCallback()
})

test('una función que lanza no rompe el mapa: el error va a la consola y la base queda', async t => {
  const { el, editor, actualizar } = await montar()
  const errores = []
  const original = console.error
  console.error = (...a) => errores.push(a)
  t.after(() => { console.error = original })
  const roto = new Error('roto')
  el.drawingIndicator = () => { throw roto }

  editor.setMode('draw')
  const indicador = actualizar()
  assert.deepEqual(indicador.children.map(esBase), [true])
  assert.deepEqual(errores, [['[cristae-map] drawingIndicator', roto]])
  el.disconnectedCallback()
})

test('desconectar el mapa retira el indicador, aunque el motor muere sin drawingend', async () => {
  const { el, editor, actualizar } = await montar()
  editor.setMode('draw')
  actualizar()

  el.disconnectedCallback()
  assert.equal(actualizar(), null)
})

test('reconectar el mapa con un editor en draw estrena el indicador, aunque sea en el mismo tick', async () => {
  const { el, editor, actualizar } = await montar()
  const vistos = []
  el.drawingIndicator = indicator => vistos.push(indicator)
  editor.setMode('draw')
  const viejo = actualizar()

  el.disconnectedCallback()
  el._drawing = true   // el editor del motor nuevo nace en draw antes del update
  const nuevo = actualizar()
  assert.notEqual(nuevo, null)
  assert.notEqual(nuevo, viejo)
  assert.deepEqual(vistos, [viejo, nuevo])
  el.disconnectedCallback()
})

test('el hijo que nace en draw enciende el indicador: el mapa oye al motor antes de montar a sus hijos', async () => {
  const hijo = engine => engine.addEditableLayer({ id: 'hijo', kind: 'polygon', mode: 'draw' })
  const { el, actualizar } = await montar(hijo)
  assert.equal(el._drawing, true)
  assert.deepEqual(actualizar().children.map(esBase), [true])
  el.disconnectedCallback()
})
