// Contrato de validateSignature — la puerta de entrada del registro (R4). Congela LAS SEIS
// ramas de rechazo, el orden en que se evalúan (una firma que viola dos reglas reporta
// siempre la primera) y la forma del error. La rama "kind desconocido" ya la cubre
// test/grammar.test.mjs; acá están las otras cinco, más el golden de las 7 firmas reales.
// Corre con: node --test test/grammar-signature.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { defineGrammar, validateSignature, GrammarError } from '../src/grammar/index.js'

/* ── Universo de kinds del entry `map` (src/element/composite.js) ── */
const KINDS = new Set(['point', 'label', 'polygon', 'line', 'html', 'bubble', 'overlay'])

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
// (mismo code R4, mensaje equivocado), el test tiene que fallar. Por eso no alcanza con /wrapper/
// ni con /hoja/ — el mensaje de arity dice literalmente '(leaf|wrapper)' y matchearía igual.
const RE_FIRMA = /firma inválida para/
const RE_ARITY = /arity inválida/
const RE_PRODUCES = /debe declarar produces/
const RE_KIND = /referencia kind desconocido/
const RE_HOJA = /es hoja: consumes/
const RE_WRAPPER = /es wrapper: combine/

// Ninguna rama puede quedar tapada por otra: los seis mensajes son mutuamente excluyentes.
test('cada rama de rechazo tiene un mensaje propio: ninguna regex matchea el mensaje de otra', () => {
  const RAMAS = [
    [RE_FIRMA, null],
    [RE_ARITY, { consumes: [], produces: ['point'], combine: null, arity: 'branch' }],
    [RE_PRODUCES, { consumes: [], produces: [], combine: null, arity: 'leaf' }],
    [RE_KIND, { consumes: [], produces: ['punto'], combine: null, arity: 'leaf' }],
    [RE_HOJA, { consumes: ['point'], produces: ['label'], combine: null, arity: 'leaf' }],
    [RE_WRAPPER, { consumes: ['point'], produces: ['overlay'], combine: 'reduce', arity: 'wrapper' }],
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

/* ════════════════ Rama 2 · arity ∈ {leaf, wrapper}, comparación exacta ════════════════ */

test('arity fuera de {leaf,wrapper} se rechaza', () => {
  for (const arity of [undefined, null, '', 'branch', 'node', 'LEAF', 'Wrapper'])
    rechaza({ consumes: [], produces: ['point'], combine: null, arity }, RE_ARITY)
})

test('arity se compara sensible a mayúsculas aunque el tag no lo sea', () => {
  // El tag se normaliza (key() lo pasa a MAYÚSCULA); el arity NO se normaliza.
  acepta({ consumes: [], produces: ['point'], combine: null, arity: 'leaf' }, 'CRISTAE-POINT-LAYER')
  rechaza({ consumes: [], produces: ['point'], combine: null, arity: 'LEAF' }, RE_ARITY)
})

/* ════════════════ Rama 3 · produces con ≥1 kind ════════════════ */

test('produces ausente, no-array o vacío se rechaza', () => {
  for (const produces of [undefined, null, [], 'point', new Set(['point']), {}])
    rechaza({ consumes: [], produces, combine: null, arity: 'leaf' }, RE_PRODUCES)
})

test('produces se valida DESPUÉS de arity: una firma que viola ambas reporta arity', () => {
  rechaza({ consumes: [], produces: [], combine: null, arity: 'branch' }, RE_ARITY)
})

/* ════════════════ Rama 4 · kinds del universo (consumes ∪ produces) ════════════════ */

test('un kind fuera del universo se rechaza venga de produces o de consumes', () => {
  rechaza({ consumes: [], produces: ['punto'], combine: null, arity: 'leaf' }, RE_KIND)
  rechaza({ consumes: ['pont'], produces: ['overlay'], combine: 'map', arity: 'wrapper' }, RE_KIND)
})

test('consumes ausente equivale a [] y no dispara el chequeo de kinds', () => {
  acepta({ produces: ['point'], combine: null, arity: 'leaf' })
})

test('con universo vacío ningún produces sobrevive', () => {
  const e = capturar(
    () => validateSignature('cristae-x', { consumes: [], produces: ['point'], combine: null, arity: 'leaf' }, new Set()))
  assert.ok(e instanceof GrammarError)
  assert.equal(e.code, 'R4')
  assert.match(e.message, RE_KIND)
})

/* ════════════════ Rama 5 · hoja ⇒ consumes [] y combine falsy ════════════════ */

test('una hoja con consumes o con combine se rechaza', () => {
  rechaza({ consumes: ['point'], produces: ['label'], combine: null, arity: 'leaf' }, RE_HOJA)
  rechaza({ consumes: [], produces: ['label'], combine: 'fold', arity: 'leaf' }, RE_HOJA)
  rechaza({ consumes: [], produces: ['label'], combine: 'map', arity: 'leaf' }, RE_HOJA)
})

test('una hoja acepta combine null o ausente (el chequeo es por valor falsy)', () => {
  acepta({ consumes: [], produces: ['label'], combine: null, arity: 'leaf' })
  acepta({ consumes: [], produces: ['label'], arity: 'leaf' })
  acepta({ consumes: [], produces: ['label'], combine: '', arity: 'leaf' })
})

test('el chequeo de kinds precede al de hoja: consumes desconocido en hoja reporta kind', () => {
  rechaza({ consumes: ['pont'], produces: ['label'], combine: null, arity: 'leaf' }, RE_KIND)
})

/* ════════════════ Rama 6 · wrapper ⇒ combine ∈ {fold, map} ════════════════ */

test('un wrapper sin combine fold|map se rechaza', () => {
  for (const combine of [undefined, null, '', 'reduce', 'FOLD', 'Map', true])
    rechaza({ consumes: ['point'], produces: ['overlay'], combine, arity: 'wrapper' }, RE_WRAPPER)
})

test('un wrapper puede no consumir nada: consumes [] no es rechazo de firma', () => {
  // La exigencia de tener hijos que produzcan lo consumido es R2/R3 (juicio de árbol), no R4.
  acepta({ consumes: [], produces: ['overlay'], combine: 'map', arity: 'wrapper' })
})

/* ════════════════ Golden · las 7 firmas reales del entry `map` ════════════════ */

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

test('las 7 firmas del entry map son EXACTAMENTE las esperadas (golden leído de la fuente)', () => {
  const FIRMAS = [
    ['cristae-point-layer', { consumes: [], produces: ['point'], combine: null, arity: 'leaf' }],
    ['cristae-polygon-layer', { consumes: [], produces: ['polygon'], combine: null, arity: 'leaf' }],
    ['cristae-line-layer', { consumes: [], produces: ['line'], combine: null, arity: 'leaf' }],
    ['cristae-html-layer', { consumes: [], produces: ['html'], combine: null, arity: 'leaf' }],
    ['cristae-label-layer', { consumes: [], produces: ['label'], combine: null, arity: 'leaf', bindsTo: 'point' }],
    ['cristae-cluster', { consumes: ['point'], produces: ['point', 'bubble'], combine: 'fold', arity: 'wrapper' }],
    ['cristae-overlay', { consumes: ['point'], produces: ['overlay'], combine: 'map', arity: 'wrapper', bindsTo: 'point' }],
  ]
  assert.deepEqual(firmasDeclaradas(), FIRMAS, 'firma real ≠ golden (tag, orden de registro o campos)')
})

test('el universo de kinds del entry map es el que declara composite.js', () => {
  const kinds = literal(/defineGrammar\(\{\s*kinds:\s*(\[[^\]]*\])/, fuente('../src/element/composite.js'), 'los kinds')
  assert.deepEqual(kinds, [...KINDS])
})

test('las 7 firmas reales pasan la validación y entran al registro con su arity', () => {
  const FIRMAS = firmasDeclaradas()
  assert.equal(FIRMAS.length, 7)
  for (const [tag, sig] of FIRMAS) acepta(sig, tag)

  // El dispatch leaf/wrapper del reductor depende de esto.
  const g = defineGrammar({ kinds: [...KINDS] })
  for (const [tag, sig] of FIRMAS) g.register(tag, sig)
  assert.equal(g.isWrapper('CRISTAE-CLUSTER'), true)
  assert.equal(g.isWrapper('CRISTAE-OVERLAY'), true)
  assert.equal(g.isLeaf('CRISTAE-POINT-LAYER'), true)
  assert.equal(g.isWrapper('CRISTAE-POINT-LAYER'), false)
})

/* ════════════════ register() · la firma se valida ANTES de mutar el registro ════════════════ */

test('un register que falla deja el tag SIN registrar', () => {
  const g = defineGrammar({ kinds: [...KINDS] })
  assert.throws(() => g.register('cristae-roto', { consumes: [], produces: [], combine: null, arity: 'leaf' }), GrammarError)
  assert.equal(g.isRegistered('cristae-roto'), false)
  assert.equal(g.signatureFor('cristae-roto'), null)
  assert.equal(g.applyFor('cristae-roto'), null)
})

test('register normaliza el tag: se consulta en cualquier caso', () => {
  const g = defineGrammar({ kinds: [...KINDS] })
  g.register('cristae-point-layer', { consumes: [], produces: ['point'], combine: null, arity: 'leaf' })
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

test('el registro guarda la MISMA referencia de la firma y del apply, nunca una copia', () => {
  // El reductor compara `sig.combine`/`sig.consumes` en caliente; una copia shallow congelaría
  // la firma en el momento del register y desacoplaría el registro de su declarante.
  const g = defineGrammar({ kinds: [...KINDS] })
  const sig = { consumes: [], produces: ['point'], combine: null, arity: 'leaf' }
  g.register('cristae-point-layer', sig)
  assert.equal(g.signatureFor('cristae-point-layer'), sig, 'signatureFor devuelve la firma registrada, por identidad')

  const apply = () => []
  const sigW = { consumes: ['point'], produces: ['point', 'bubble'], combine: 'fold', arity: 'wrapper' }
  g.register('cristae-cluster', sigW, { apply })
  assert.equal(g.signatureFor('CRISTAE-CLUSTER'), sigW)
  assert.equal(g.applyFor('CRISTAE-CLUSTER'), apply, 'applyFor devuelve la función registrada, por identidad')

  // Y dos consultas devuelven la misma referencia (el registro no clona por lectura).
  assert.equal(g.signatureFor('cristae-point-layer'), g.signatureFor('CRISTAE-POINT-LAYER'))
})

test('register sin opts deja apply en null (una hoja no aplica nada)', () => {
  const g = defineGrammar({ kinds: [...KINDS] })
  g.register('cristae-point-layer', { consumes: [], produces: ['point'], combine: null, arity: 'leaf' })
  assert.equal(g.applyFor('cristae-point-layer'), null)
})

test('defineGrammar expone el universo de kinds y el mode por defecto', () => {
  const g = defineGrammar({ kinds: [...KINDS] })
  assert.deepEqual([...g.kinds].sort(), [...KINDS].sort())
  assert.equal(g.mode, 'throw')
  assert.equal(defineGrammar({ kinds: ['point'], mode: 'warn' }).mode, 'warn')
})
