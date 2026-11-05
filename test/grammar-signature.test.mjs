// Contrato de validateSignature — la puerta de entrada del registro (R4). Congela LAS SIETE
// ramas de rechazo, el orden en que se evalúan (una firma que viola dos reglas reporta
// siempre la primera) y la forma del error, más el golden de las 19 firmas reales. Una firma
// declara { role, consumes?, produces }; lo demás sale del rol (test/grammar-roles.test.mjs).
// Corre con: node --test test/grammar-signature.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { defineGrammar, validateSignature, GrammarError } from '../src/grammar/index.js'

/* ── Universo de kinds del entry `map` (src/element/composite.js) ── */
const KINDS = new Set(['point', 'label', 'polygon', 'shape', 'line', 'html', 'bubble', 'overlay', 'geodesic', 'edit', 'image', 'heat'])

// Todo rechazo de firma es R4, sin nodo (la firma no cuelga de ningún elemento).
// `rama` discrimina QUÉ chequeo disparó: sin eso cualquier throw pasaría el test.
const capturar = (fn) => { try { fn(); return null } catch (e) { return e } }
const rechaza = (sig, rama, tag = 'cristae-x') => {
  const e = capturar(() => validateSignature(tag, sig, KINDS))
  assert.ok(e instanceof GrammarError, `esperaba GrammarError, hubo: ${e}`)
  assert.equal(e.code, 'R4')
  assert.equal(e.name, 'GrammarError')
  assert.equal(e.node, null)
  assert.match(e.message.toLowerCase(), rama)
  return e
}
const acepta = (sig, tag = 'cristae-x') =>
  assert.doesNotThrow(() => validateSignature(tag, sig, KINDS))

// 🔴 Cada regex matchea SÓLO el mensaje de SU rama: si una rama reporta el diagnóstico de otra
// (mismo code R4, mensaje equivocado), el test tiene que fallar.
const RE_FIRMA    = /firma inválida para/
const RE_ROL      = /rol inválido/
const RE_AJENO    = /que no es parte de la firma/
const RE_PRODUCES = /debe declarar produces/
const RE_KIND     = /referencia kind desconocido/
const RE_HOJA     = /es una hoja: no consume/
const RE_CONSUMES = /debe declarar consumes/

const ROLES_WRAPPER = [['transform', 'un transformador'], ['aggregate', 'un agregador'], ['decorate', 'un decorador']]

// Ninguna rama puede quedar tapada por otra: los siete mensajes son mutuamente excluyentes.
test('cada rama de rechazo tiene un mensaje propio: ninguna regex matchea el mensaje de otra', () => {
  const RAMAS = [
    [RE_FIRMA, null],
    [RE_ROL, { role: 'wrapper', produces: ['point'] }],
    [RE_AJENO, { role: 'leaf', produces: ['point'], combine: null }],
    [RE_PRODUCES, { role: 'leaf', produces: [] }],
    [RE_KIND, { role: 'leaf', produces: ['punto'] }],
    [RE_HOJA, { role: 'leaf', consumes: ['point'], produces: ['label'] }],
    [RE_CONSUMES, { role: 'decorate', produces: ['overlay'] }],
  ]
  for (const [propia, sig] of RAMAS) {
    const msg = capturar(() => validateSignature('cristae-x', sig, KINDS)).message.toLowerCase()
    for (const [otra] of RAMAS)
      assert.equal(otra.test(msg), otra === propia, `${otra} vs ${JSON.stringify(sig)}`)
  }
})

/* ════════════════ Rama 1 · la firma tiene que ser un objeto ════════════════ */

test('una firma que no es objeto se rechaza antes de mirar su contenido', () => {
  for (const sig of [undefined, null, 'leaf', 42, true, Symbol('s'), () => {}])
    rechaza(sig, RE_FIRMA)
})

test('el rechazo de firma nombra el tag en minúscula aunque se registre en mayúscula', () => {
  const e = rechaza(null, RE_FIRMA, 'CRISTAE-POINT-LAYER')
  assert.match(e.message, /<cristae-point-layer>/)
})

/* ════════════════ Rama 2 · role ∈ {leaf, transform, aggregate, decorate}, comparación exacta ════════════════ */

test('un rol fuera de los cuatro se rechaza, también los nombres viejos y los del prototipo', () => {
  for (const role of [undefined, null, '', 'wrapper', 'map', 'fold', 'LEAF', 'Decorate', 'toString', '__proto__', Symbol('r')])
    rechaza({ role, produces: ['point'] }, RE_ROL)
})

test('una firma vieja sin rol reporta el rol, no los campos que sobran', () => {
  rechaza({ consumes: [], produces: ['point'], combine: null, arity: 'leaf' }, RE_ROL)
})

test('el rol se compara sensible a mayúsculas aunque el tag no lo sea', () => {
  acepta({ role: 'leaf', produces: ['point'] }, 'CRISTAE-POINT-LAYER')
  rechaza({ role: 'Leaf', produces: ['point'] }, RE_ROL)
})

/* ════════════════ Rama 3 · sólo role, consumes y produces ════════════════ */

test('combine, arity, reach, passThrough y bindsTo no son de la firma: declararlos es R4 y el mensaje nombra el campo', () => {
  for (const campo of ['combine', 'arity', 'reach', 'passThrough', 'bindsTo', 'otro']) {
    const e = rechaza({ role: 'transform', consumes: ['line'], produces: ['geodesic'], [campo]: 'x' }, RE_AJENO)
    assert.match(e.message, new RegExp(`'${campo}'`))
  }
})

test('bindsTo tampoco va en una hoja: el ligado lo da el elemento', () =>
  rechaza({ role: 'leaf', produces: ['label'], bindsTo: 'point' }, RE_AJENO))

/* ════════════════ Rama 4 · produces con ≥1 kind ════════════════ */

test('produces ausente, no-array o vacío se rechaza', () => {
  for (const produces of [undefined, null, [], 'point', new Set(['point']), {}])
    rechaza({ role: 'leaf', produces }, RE_PRODUCES)
})

test('produces se valida DESPUÉS del rol: una firma que viola ambas reporta el rol', () => {
  rechaza({ role: 'branch', produces: [] }, RE_ROL)
})

/* ════════════════ Rama 5 · kinds del universo (consumes ∪ produces) ════════════════ */

test('un kind fuera del universo se rechaza venga de produces o de consumes', () => {
  rechaza({ role: 'leaf', produces: ['punto'] }, RE_KIND)
  rechaza({ role: 'decorate', consumes: ['pont'], produces: ['overlay'] }, RE_KIND)
})

test('con universo vacío ningún produces sobrevive', () => {
  const e = capturar(() => validateSignature('cristae-x', { role: 'leaf', produces: ['point'] }, new Set()))
  assert.ok(e instanceof GrammarError)
  assert.equal(e.code, 'R4')
  assert.match(e.message, RE_KIND)
})

/* ════════════════ Rama 6 · una hoja no consume ════════════════ */

test('una hoja con consumes se rechaza; con [] u omitido se acepta', () => {
  rechaza({ role: 'leaf', consumes: ['point'], produces: ['label'] }, RE_HOJA)
  acepta({ role: 'leaf', consumes: [], produces: ['label'] })
  acepta({ role: 'leaf', produces: ['label'] })
})

test('el chequeo de kinds precede al de hoja: consumes desconocido en hoja reporta kind', () => {
  rechaza({ role: 'leaf', consumes: ['pont'], produces: ['label'] }, RE_KIND)
})

/* ════════════════ Rama 7 · un modificador consume ≥1 kind ════════════════ */

test('transformador, agregador y decorador sin consumes se rechazan, y el mensaje nombra el rol', () => {
  for (const [role, nombre] of ROLES_WRAPPER)
    for (const consumes of [undefined, []]) {
      const e = rechaza({ role, consumes, produces: ['overlay'] }, RE_CONSUMES)
      assert.match(e.message, new RegExp(`<cristae-x> es ${nombre}:`))
    }
})

/* ════════════════ Golden · las 19 firmas reales del entry `map` ════════════════ */

// El golden se LEE de la fuente, no se copia a mano: importar las clases arrastraría lit +
// leaflet + un DOM, así que se parsea el texto de src/index.js (qué tag registra qué clase) y
// el `static cristaeSignature` de cada src/element/*.js. Sin esto el literal de abajo queda
// desconectado y cambiar una firma real no rompe nada acá.
const fuente = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const literal = (re, texto, que) => {
  const m = re.exec(texto)
  assert.ok(m, `no se pudo leer ${que} de la fuente (¿cambió el formato?)`)
  return Function(`return (${m[1]})`)()
}

const firmasDeclaradas = () => {
  const entry = fuente('../src/index.js')
  const archivoDe = new Map(
    [...entry.matchAll(/import \{ (\w+) \} from '\.\/element\/([\w.]+)'/g)].map(([, c, f]) => [c, f]))
  return [...entry.matchAll(/grammar\.register\('([\w-]+)',\s*(\w+)\.cristaeSignature/g)]
    .map(([, tag, clase]) => {
      assert.ok(archivoDe.has(clase), `${clase} no se importa desde ./element/`)
      const src = fuente(`../src/element/${archivoDe.get(clase)}`)
      return [tag, literal(/static cristaeSignature\s*=\s*(\{.*\})/, src, `la firma de ${clase}`)]
    })
}

test('las 19 firmas del entry map son EXACTAMENTE las esperadas (golden leído de la fuente)', () => {
  const FIRMAS = [
    ['cristae-point-layer', { role: 'leaf', produces: ['point'] }],
    ['cristae-polygon-layer', { role: 'leaf', produces: ['polygon'] }],
    ['cristae-shape-layer', { role: 'leaf', produces: ['shape'] }],
    ['cristae-line-layer', { role: 'leaf', produces: ['line'] }],
    ['cristae-html-layer', { role: 'leaf', produces: ['html'] }],
    ['cristae-label-layer', { role: 'leaf', produces: ['label'] }],
    ['cristae-image-layer', { role: 'leaf', produces: ['image'] }],
    ['cristae-heat-layer', { role: 'leaf', produces: ['heat'] }],
    ['cristae-editable-polygon', { role: 'leaf', produces: ['polygon'] }],
    ['cristae-editable-polyline', { role: 'leaf', produces: ['line'] }],
    ['cristae-editable-point', { role: 'leaf', produces: ['edit'] }],
    ['cristae-editable-rectangle', { role: 'leaf', produces: ['edit'] }],
    ['cristae-editable-circle', { role: 'leaf', produces: ['edit'] }],
    ['cristae-editable-ellipse', { role: 'leaf', produces: ['edit'] }],
    ['cristae-editable-sector', { role: 'leaf', produces: ['edit'] }],
    ['cristae-cluster', { role: 'aggregate', consumes: ['point'], produces: ['point', 'bubble'] }],
    ['cristae-overlay', { role: 'decorate', consumes: ['point'], produces: ['overlay'] }],
    ['cristae-geodesic', { role: 'transform', consumes: ['line', 'polygon'], produces: ['geodesic'] }],
    ['cristae-labeled', { role: 'decorate', consumes: ['point', 'line', 'polygon', 'shape', 'html', 'bubble'], produces: ['label'] }],
  ]
  assert.deepEqual(firmasDeclaradas(), FIRMAS, 'firma real ≠ golden (tag, orden de registro o campos)')
})

test('el universo de kinds del entry map es el que declara composite.js', () => {
  const kinds = literal(/defineGrammar\(\{\s*kinds:\s*(\[[^\]]*\])/, fuente('../src/element/composite.js'), 'los kinds')
  assert.deepEqual(kinds, [...KINDS])
})

test('las 19 firmas reales pasan la validación y entran al registro como hoja o modificador', () => {
  const FIRMAS = firmasDeclaradas()
  assert.equal(FIRMAS.length, 19)
  for (const [tag, sig] of FIRMAS) acepta(sig, tag)

  // El montaje (enclosingModifier) y el reductor dependen de esto.
  const g = defineGrammar({ kinds: [...KINDS] })
  for (const [tag, sig] of FIRMAS) g.register(tag, sig)
  assert.equal(g.isWrapper('CRISTAE-CLUSTER'), true)
  assert.equal(g.isWrapper('CRISTAE-OVERLAY'), true)
  assert.equal(g.isWrapper('CRISTAE-GEODESIC'), true)
  assert.equal(g.isWrapper('CRISTAE-LABELED'), true)
  assert.equal(g.isLeaf('CRISTAE-POINT-LAYER'), true)
  assert.equal(g.isWrapper('CRISTAE-POINT-LAYER'), false)
})

/* ════════════════ register() · la firma se valida ANTES de mutar el registro ════════════════ */

test('un register que falla deja el tag SIN registrar', () => {
  const g = defineGrammar({ kinds: [...KINDS] })
  assert.throws(() => g.register('cristae-roto', { role: 'leaf', produces: [] }), GrammarError)
  assert.equal(g.isRegistered('cristae-roto'), false)
  assert.equal(g.signatureFor('cristae-roto'), null)
  assert.equal(g.applyFor('cristae-roto'), null)
})

test('register normaliza el tag: se consulta en cualquier caso', () => {
  const g = defineGrammar({ kinds: [...KINDS] })
  g.register('cristae-point-layer', { role: 'leaf', produces: ['point'] })
  for (const tag of ['cristae-point-layer', 'CRISTAE-POINT-LAYER', 'Cristae-Point-Layer'])
    assert.equal(g.isRegistered(tag), true, tag)
})

test('un tag no registrado responde null/false en todo el registro', () => {
  const g = defineGrammar({ kinds: [...KINDS] })
  for (const tag of ['div', null, undefined, '']) {
    assert.equal(g.isRegistered(tag), false)
    assert.equal(g.signatureFor(tag), null)
    assert.equal(g.applyFor(tag), null)
    assert.equal(g.isWrapper(tag), false)
    assert.equal(g.isLeaf(tag), false)
  }
})

test('el registro no muta la firma declarada y devuelve siempre la MISMA copia', () => {
  // La copia se arma una vez al registrar, y su derivada una vez por firma: el reductor relee las dos sin asignar.
  const g = defineGrammar({ kinds: [...KINDS] })
  const sig = { role: 'leaf', produces: ['point'] }
  g.register('cristae-point-layer', sig)
  assert.deepEqual(sig, { role: 'leaf', produces: ['point'] }, 'la firma del elemento queda como se declaró')
  assert.notEqual(g.signatureFor('cristae-point-layer'), sig)
  assert.equal(g.signatureFor('cristae-point-layer'), g.signatureFor('CRISTAE-POINT-LAYER'), 'por identidad')

  const apply = () => []
  g.register('cristae-cluster', { role: 'aggregate', consumes: ['point'], produces: ['point', 'bubble'] }, { apply })
  assert.equal(g.applyFor('CRISTAE-CLUSTER'), apply, 'applyFor devuelve la función registrada, por identidad')
})

test('register sin opts deja apply en null (una hoja no aplica nada)', () => {
  const g = defineGrammar({ kinds: [...KINDS] })
  g.register('cristae-point-layer', { role: 'leaf', produces: ['point'] })
  assert.equal(g.applyFor('cristae-point-layer'), null)
})

test('defineGrammar expone el universo de kinds y el mode por defecto', () => {
  const g = defineGrammar({ kinds: [...KINDS] })
  assert.deepEqual([...g.kinds].sort(), [...KINDS].sort())
  assert.equal(g.mode, 'throw')
  assert.equal(defineGrammar({ kinds: ['point'], mode: 'warn' }).mode, 'warn')
})
