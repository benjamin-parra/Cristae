// Contrato de las dos funciones que deciden QUÉ nodos ve la gramática:
//   · grammarChildren  — hijos que participan (filtra slot="bubble" y lo no registrado)
//   · enclosingModifier — wrapper que gobierna el montaje de un hijo, parando en <cristae-map>
// Ambas esconden una CONSTANTE DE DOMINIO ('bubble' y 'CRISTAE-MAP') que el reductor da por
// sentada: parametrizarlas sin estos tests cambiaría el default sin que nadie se entere.
// Corre con: node --test test/grammar-children.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  defineGrammar, grammarChildren, enclosingModifier, tagName, validate, GrammarError,
} from '../src/grammar/index.js'

/* ══════════════ Gramática de prueba ══════════════ */

const g = defineGrammar({ kinds: ['point', 'label', 'bubble', 'overlay'] })
g.register('CRISTAE-POINT-LAYER', { consumes: [], produces: ['point'], combine: null, arity: 'leaf' })
g.register('CRISTAE-LABEL-LAYER', { consumes: [], produces: ['label'], combine: null, arity: 'leaf', bindsTo: 'point' })
g.register('CRISTAE-CLUSTER',
  { consumes: ['point'], produces: ['point', 'bubble'], combine: 'fold', arity: 'wrapper' })
g.register('CRISTAE-OVERLAY',
  { consumes: ['point'], produces: ['overlay'], combine: 'map', arity: 'wrapper', bindsTo: 'point' })

const vctx = { signatureFor: g.signatureFor, isRegistered: g.isRegistered, mode: 'throw' }
const capturar = (fn) => { try { fn(); return null } catch (e) { return e } }

/* ══════════════ Nodos fake (interfaz mínima de Element) ══════════════ */

// `attrs` alimenta getAttribute; `parentElement` se cablea al armar el árbol.
const nodo = (tag, { attrs = null, hijos = [], sinGetAttribute = false } = {}) => {
  const el = { tagName: tag == null ? tag : tag.toUpperCase(), children: hijos, parentElement: null }
  if (!sinGetAttribute) el.getAttribute = (n) => (attrs ? (attrs[n] ?? null) : null)
  for (const h of hijos) h.parentElement = el
  return el
}
const P = (o) => nodo('cristae-point-layer', o)
const L = (o) => nodo('cristae-label-layer', o)
const CL = (hijos) => nodo('cristae-cluster', { hijos })
const OV = (hijos) => nodo('cristae-overlay', { hijos })
const DIV = (hijos = []) => nodo('div', { hijos })
const MAP = (hijos) => nodo('cristae-map', { hijos })

const hijos = (el) => grammarChildren(el, g.isRegistered)
const tags = (els) => els.map(e => e.tagName)

/* ════════════════ grammarChildren · qué entra ════════════════ */

test('devuelve los hijos registrados, por identidad y en orden de documento', () => {
  const a = P(), b = L(), c = P()
  const out = hijos(CL([a, b, c]))
  assert.deepEqual(out, [a, b, c])
  assert.equal(out[0], a, 'son las MISMAS referencias, no copias')
})

test('un elemento sin hijos aporta una lista vacía', () => {
  assert.deepEqual(hijos(CL([])), [])
})

test('la lista devuelta es propia: mutarla no toca el DOM', () => {
  const padre = CL([P(), P()])
  const out = hijos(padre)
  out.pop()
  assert.equal(padre.children.length, 2)
})

test('sólo mira hijos DIRECTOS: los nietos son problema del recorrido, no del filtro', () => {
  const nieto = P()
  const out = hijos(CL([OV([nieto])]))
  assert.deepEqual(tags(out), ['CRISTAE-OVERLAY'])
})

/* ════════════════ grammarChildren · constante de dominio #1: slot="bubble" ════════════════ */

test('el hijo con slot="bubble" queda EXCLUIDO aunque su tag esté registrado', () => {
  // Es configuración del cluster (la plantilla de la burbuja), no un operando de la gramática.
  const burbuja = P({ attrs: { slot: 'bubble' } })
  const real = P()
  assert.deepEqual(hijos(CL([burbuja, real])), [real])
})

test('la exclusión es por igualdad exacta con "bubble": ningún otro slot se descarta', () => {
  for (const slot of ['bubbles', 'BUBBLE', ' bubble', '', 'popup'])
    assert.equal(hijos(CL([P({ attrs: { slot } })])).length, 1, `slot=${JSON.stringify(slot)}`)
})

test('sin atributo slot el hijo participa normalmente', () => {
  assert.equal(hijos(CL([P({ attrs: {} }), P()])).length, 2)
})

test('un hijo sin getAttribute no rompe el filtro (interfaz mínima de Element)', () => {
  const raro = nodo('cristae-point-layer', { sinGetAttribute: true })
  assert.deepEqual(hijos(CL([raro])), [raro])
})

/* ════════════════ grammarChildren · constante de dominio #2: registro = filtro ════════════════ */

test('los tags no registrados se descartan EN SILENCIO', () => {
  const p = P()
  const out = hijos(CL([DIV(), nodo('cristae-inventado'), nodo('span'), p]))
  assert.deepEqual(out, [p])
})

test('el DOM plano se ignora, incluidos nodos sin tagName', () => {
  const out = hijos(CL([DIV([P()]), nodo(null), nodo(undefined), P()]))
  assert.deepEqual(tags(out), ['CRISTAE-POINT-LAYER'])
})

test('isRegistered se consulta con el tagName tal cual lo entrega el DOM (MAYÚSCULA)', () => {
  const vistos = []
  grammarChildren(CL([P(), DIV()]), (t) => { vistos.push(t); return g.isRegistered(t) })
  assert.deepEqual(vistos, ['CRISTAE-POINT-LAYER', 'DIV'])
})

// COMPORTAMIENTO DE HOY (el `{ todo }` de abajo es la spec pendiente que lo cambiaría). Va
// aparte para que la spec pendiente no desactive también esta cobertura: un `{ todo }` apaga
// el test ENTERO, incluidos los asertos que hoy pasan.
test('hoy un hijo desconocido junto a uno válido se descarta en silencio y el árbol valida', () => {
  const p = P()
  const cl = CL([DIV(), p])
  assert.equal(validate(cl, vctx), true, 'el <div> no invalida el cluster')
  assert.deepEqual(hijos(cl), [p], 'y no llega al reductor')
})

test('R5 — un hijo desconocido dentro de un wrapper DEBERÍA ser un error de gramática',
  { todo: 'R5 — hoy el hijo desconocido se descarta en silencio; ver plan del eje de gramática' }, () => {
    // Propuesta: <cristae-cluster><div>…</div><cristae-point-layer/></cristae-cluster>
    // debería avisar en vez de ignorar el <div> (típico typo de tag).
    // node:test NO falla cuando un {todo} empieza a pasar (lo reporta 'ok # TODO'): buscar
    // "R5" en este archivo al implementar la regla.
    const e = capturar(() => validate(CL([DIV(), P()]), vctx))
    assert.ok(e instanceof GrammarError, 'no reportó nada')
    assert.equal(e.code, 'R5')
  })

test('descartar en silencio puede volver INVÁLIDO a un wrapper que "tiene" hijos', () => {
  // Un cluster cuyo único hijo es desconocido queda sin hijos de gramática → R3.
  const e = capturar(() => validate(CL([DIV()]), vctx))
  assert.ok(e instanceof GrammarError)
  assert.equal(e.code, 'R3')
})

/* ════════════════ tagName (mensajes de error) ════════════════ */

test('tagName baja a minúscula y tolera nodos sin tagName', () => {
  assert.equal(tagName(P()), 'cristae-point-layer')
  assert.equal(tagName(null), 'null')
  assert.equal(tagName(undefined), 'undefined')
  assert.equal(tagName({}), '[object Object]')
})

/* ════════════════ enclosingModifier · quién gobierna el montaje ════════════════ */

const isWrapper = g.isWrapper

test('sin padre no hay modificador', () => {
  assert.equal(enclosingModifier(P(), isWrapper), null)
})

test('devuelve el wrapper que envuelve al elemento', () => {
  const p = P()
  const cl = CL([p])
  MAP([cl])
  assert.equal(enclosingModifier(p, isWrapper), cl)
})

test('devuelve el wrapper MÁS CERCANO hacia arriba', () => {
  const p = P()
  const ov = OV([p])
  const cl = CL([ov])
  MAP([cl])
  assert.equal(enclosingModifier(p, isWrapper), ov)
  assert.equal(enclosingModifier(ov, isWrapper), cl, 'y el wrapper de en medio ve al de afuera')
})

test('se excluye a sí mismo: un wrapper suelto bajo el mapa no se devuelve a sí mismo', () => {
  const cl = CL([P()])
  MAP([cl])
  assert.equal(enclosingModifier(cl, isWrapper), null)
})

test('atraviesa DOM plano y hojas hasta encontrar el wrapper', () => {
  const p = P()
  const cl = CL([DIV([DIV([p])])])
  MAP([cl])
  assert.equal(enclosingModifier(p, isWrapper), cl)
})

test('sin ningún wrapper entre el elemento y el mapa devuelve null', () => {
  const p = P()
  MAP([DIV([p])])
  assert.equal(enclosingModifier(p, isWrapper), null)
})

test('<cristae-map> es la parada dura: un wrapper POR ENCIMA del mapa no cuenta', () => {
  // Sin el corte, un mapa anidado en un cluster de otro mapa se robaría el montaje.
  const p = P()
  const mapa = MAP([p])
  const cl = CL([mapa])
  MAP([cl])
  assert.equal(enclosingModifier(p, isWrapper), null)
})

test('el mapa nunca se devuelve a sí mismo, ni siquiera si fuera wrapper', () => {
  const p = P()
  MAP([p])
  assert.equal(enclosingModifier(p, () => true), null)
})

test('la parada se compara con el tagName en MAYÚSCULA (contrato del DOM)', () => {
  const p = P()
  const falso = { tagName: 'cristae-map', children: [p], parentElement: null }
  p.parentElement = falso
  const cl = CL([])
  falso.parentElement = cl
  assert.equal(enclosingModifier(p, isWrapper), cl, 'un tagName minúscula no corta el ascenso')
})

test('isWrapper se consulta con el tagName de cada ancestro, de adentro hacia afuera', () => {
  const p = P()
  const div = DIV([p])
  const cl = CL([div])
  MAP([cl])
  const vistos = []
  enclosingModifier(p, (t) => { vistos.push(t); return isWrapper(t) })
  assert.deepEqual(vistos, ['DIV', 'CRISTAE-CLUSTER'])
})

test('el ascenso sólo usa parentElement: no necesita `children` ni saber qué hijo es', () => {
  // Reemplaza a un aserto que no podía fallar ("no depende de la posición entre hermanos":
  // la posición es inalcanzable para una función que sólo camina hacia arriba). Esto SÍ puede
  // fallar: si el recorrido se reescribiera leyendo `children`/indexOf del padre, rompe.
  const p = P()
  const cl = { tagName: 'CRISTAE-CLUSTER', parentElement: null } // sin children ni getAttribute
  p.parentElement = cl
  assert.equal(enclosingModifier(p, isWrapper), cl)
})

test('el ascenso se detiene en el PRIMER wrapper: no sigue subiendo ni consulta de más', () => {
  const p = P()
  const ov = OV([p])
  const cl = CL([ov])
  MAP([cl])
  const vistos = []
  const encontrado = enclosingModifier(p, (t) => { vistos.push(t); return isWrapper(t) })
  assert.equal(encontrado, ov)
  assert.deepEqual(vistos, ['CRISTAE-OVERLAY'], 'el cluster de afuera ni se consulta')
})
