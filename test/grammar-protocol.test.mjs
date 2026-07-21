// GOLDEN del protocolo duck-typed que el reductor EXIGE a los nodos del árbol:
// `cristaeMount(engine)` (obligatorio), `cristaeUnits()` y `cristaeConfig()` (opcionales)
// y `_handle` (la capa ya montada). El reductor no importa element/engine: si el refactor
// cambia cualquiera de estos cuatro nombres —o convierte `suppressed` en un valor plano en
// vez de un getter vivo— el acoplamiento se rompe EN SILENCIO. Estos tests lo hacen ruidoso.
// Corre con: node --test test/grammar-protocol.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  defineGrammar, reduceModifier, leafUnits, buildUnit, validate, GrammarError,
} from '../src/grammar/index.js'

/* ══════════════ Gramática de prueba (las firmas reales + una sin passThrough) ══════════════ */

const g = defineGrammar({ kinds: ['point', 'label', 'bubble', 'overlay'] })
g.register('CRISTAE-POINT-LAYER', { consumes: [], produces: ['point'], combine: null, arity: 'leaf' })
g.register('CRISTAE-LABEL-LAYER', { consumes: [], produces: ['label'], combine: null, arity: 'leaf', bindsTo: 'point' })
g.register('CRISTAE-CLUSTER',
  { consumes: ['point'], produces: ['point', 'bubble'], combine: 'fold', arity: 'wrapper' },
  { apply: (engine, targets, cfg) => engine.aplicar('fold', targets, cfg) })
g.register('CRISTAE-OVERLAY',
  { consumes: ['point'], produces: ['overlay'], combine: 'map', arity: 'wrapper', bindsTo: 'point' },
  { apply: (engine, targets, cfg) => engine.aplicar('map', targets, cfg) })
// Wrapper que NO re-emite lo que consume (passThrough: false) y wrapper sin apply.
g.register('CRISTAE-ABSORBE',
  { consumes: ['point'], produces: ['bubble'], combine: 'fold', arity: 'wrapper', passThrough: false },
  { apply: (engine, targets, cfg) => engine.aplicar('fold', targets, cfg) })
g.register('CRISTAE-INERTE', { consumes: ['point'], produces: ['bubble'], combine: 'fold', arity: 'wrapper' })
// Hoja que declara DOS produces: el único fixture donde produces[0] ≠ produces[length-1].
g.register('CRISTAE-DOBLE', { consumes: [], produces: ['point', 'label'], combine: null, arity: 'leaf' })

const ctx = { signatureFor: g.signatureFor, applyFor: g.applyFor, isRegistered: g.isRegistered }
const vctx = { signatureFor: g.signatureFor, isRegistered: g.isRegistered, mode: 'throw' }
const capturar = (fn) => { try { fn(); return null } catch (e) { return e } }

/* ══════════════ Motor fake: registro de llamadas + capas con `suppressed` mutable ══════════════ */

const motor = ({ conGetLayer = true, retorno = 'unit' } = {}) => {
  const capas = new Map()      // id → { suppressed }
  const llamadas = []          // ['fold'|'map', ids, cfg]
  let n = 0
  const e = {
    capas,
    llamadas,
    aplicar(modo, targets, cfg) {
      llamadas.push([modo, targets.map(t => t.id), cfg])
      if (retorno === 'nada') return null
      if (retorno === 'vacio') return []
      const id = `${modo}-${++n}`
      capas.set(id, { suppressed: null })
      return [{ kind: modo === 'fold' ? 'bubble' : 'overlay', id, handle: { id } }]
    },
  }
  if (conGetLayer) e.getLayer = (id) => capas.get(id)
  return e
}

/* ══════════════ Nodos fake: implementan el protocolo pieza por pieza ══════════════ */

let seq = 0
// Hoja: al montar crea su capa en el motor y expone units vía leafUnits (igual que base.js).
const hoja = (tag, { omitirUnits = false, omitirHandle = false, suppressed = null, slot = null } = {}) => {
  const nodo = {
    tagName: tag.toUpperCase(), children: [], getAttribute: (n) => (n === 'slot' ? slot : null),
    _handle: null, _engine: null, traza: [],
    cristaeMount(engine) {
      nodo.traza.push('mount')
      nodo._engine = engine
      if (omitirHandle) return
      const id = `${tag}-${++seq}`
      nodo._handle = { id, source: { tag } }
      engine.capas?.set(id, { suppressed })
    },
  }
  if (!omitirUnits) nodo.cristaeUnits = () => { nodo.traza.push('units'); return leafUnits(nodo, nodo._engine, ctx) }
  return nodo
}
// Wrapper: reduce a sus hijos al montar (igual que CristaeCluster/CristaeOverlay).
const envoltorio = (tag, hijos, { config = undefined } = {}) => {
  const nodo = {
    tagName: tag.toUpperCase(), children: hijos, getAttribute: () => null,
    _handle: null, _units: null, traza: [],
    cristaeMount(engine) {
      nodo.traza.push('mount')
      nodo._units = reduceModifier(nodo, engine, ctx)
      nodo._handle = { id: `${tag}-${++seq}` }
    },
    cristaeUnits: () => nodo._units ?? [],
  }
  if (config !== undefined) { nodo.vecesConfig = 0; nodo.cristaeConfig = () => { nodo.vecesConfig++; return config } }
  return nodo
}
const P = (o) => hoja('cristae-point-layer', o)
const L = () => hoja('cristae-label-layer')
const D = () => hoja('cristae-doble')
const Cl = (hijos, o) => envoltorio('cristae-cluster', hijos, o)
const Ov = (hijos, o) => envoltorio('cristae-overlay', hijos, o)
const kinds = (units) => units.map(u => u.kind).sort()
// DOM plano: NO implementa el protocolo (ni cristaeMount). Si el reductor lo tocara, TypeError.
const DIV = () => ({ tagName: 'DIV', children: [], getAttribute: () => null })

/* ════════════════ Seam reduce ↔ grammarChildren: qué hijos ve el reductor ════════════════ */

test('el reductor reduce SOLO los hijos de gramática: la plantilla slot="bubble" y el DOM plano no se montan', () => {
  // Es el cruce de los dos módulos: si reduce.js recorriera `el.children` en vez de
  // grammarChildren, montaría la plantilla de la burbuja como capa real y llamaría
  // cristaeMount sobre un <div> → TypeError en producción.
  const plantilla = P({ slot: 'bubble' })
  const real = P()
  const e = motor()
  const units = reduceModifier(Cl([plantilla, DIV(), real]), e, ctx)

  assert.deepEqual(plantilla.traza, [], 'la plantilla de la burbuja no se monta ni aporta units')
  assert.equal(plantilla._handle, null)
  assert.deepEqual(real.traza, ['mount', 'units'])
  assert.deepEqual([...e.capas.keys()], [real._handle.id, 'fold-1'], 'sólo se creó la capa del hijo real')
  assert.equal(e.llamadas.length, 1)
  assert.deepEqual(e.llamadas[0][1], [real._handle.id], 'sólo el hijo de gramática es target del fold')
  assert.deepEqual(units.map(u => u.kind), ['point', 'bubble'])
})

/* ════════════════ cristaeMount: obligatorio, una vez por hijo, en orden ════════════════ */

test('el reductor monta cada hijo de gramática exactamente una vez y en orden de documento', () => {
  const a = P(), b = P(), c = L()
  const e = motor()
  reduceModifier(Cl([a, b, c]), e, ctx)
  for (const n of [a, b, c]) assert.deepEqual(n.traza, ['mount', 'units'])
  // Las capas se crean en el orden en que se montaron los hijos (la 4ª es la del fold).
  assert.deepEqual([...e.capas.keys()].slice(0, 3), [a._handle.id, b._handle.id, c._handle.id])
})

test('el motor llega intacto a cada hijo: cristaeMount recibe la misma referencia', () => {
  const a = P(), b = P()
  const e = motor()
  reduceModifier(Cl([a, b]), e, ctx)
  assert.equal(a._engine, e)
  assert.equal(b._engine, e)
})

test('un hijo sin cristaeMount rompe el reductor: montar es parte obligatoria del protocolo', () => {
  const mudo = { tagName: 'CRISTAE-POINT-LAYER', children: [], getAttribute: () => null }
  assert.throws(() => reduceModifier(Cl([mudo]), motor(), ctx), TypeError)
})

/* ════════════════ cristaeUnits: opcional; se consulta DESPUÉS de montar ════════════════ */

test('un hijo sin cristaeUnits no rompe la reducción: aporta cero units', () => {
  const sinUnits = hoja('cristae-point-layer', { omitirUnits: true })
  const e = motor()
  const units = reduceModifier(Cl([sinUnits, P()]), e, ctx)
  // Sólo el hijo que sí implementa cristaeUnits llega como target del fold.
  assert.equal(units.filter(u => u.kind === 'point').length, 1)
  assert.equal(e.llamadas.length, 1)
  assert.deepEqual(e.llamadas[0][1].length, 1)
})

test('units se consulta después del montaje (antes no existe el handle)', () => {
  const a = P()
  reduceModifier(Cl([a]), motor(), ctx)
  assert.deepEqual(a.traza, ['mount', 'units'])
})

test('una hoja sin _handle aporta [] aunque implemente cristaeUnits', () => {
  // Caso real: el elemento se conectó pero su capa todavía no se creó.
  const sinHandle = hoja('cristae-point-layer', { omitirHandle: true })
  const e = motor()
  const units = reduceModifier(Cl([sinHandle]), e, ctx)
  assert.deepEqual(units, [])
  assert.equal(e.llamadas.length, 0, 'sin targets no se llama al apply')
})

test('leafUnits deriva el kind de produces[0] y arrastra id/handle/source del handle', () => {
  const p = P()
  const e = motor()
  p.cristaeMount(e)
  const [u] = leafUnits(p, e, ctx)
  assert.equal(u.kind, 'point')
  assert.equal(u.id, p._handle.id)
  assert.equal(u.handle, p._handle)
  assert.equal(u.source, p._handle.source)
})

test('con varios produces la unit toma el PRIMERO, no el último ni otro cualquiera', () => {
  // Único fixture con produces.length > 1: con una sola entrada, produces[0] es
  // indistinguible de produces[length-1] y el índice queda sin congelar.
  const d = D()
  const e = motor()
  d.cristaeMount(e)
  const us = leafUnits(d, e, ctx)
  assert.equal(us.length, 1, 'una hoja aporta UNA unit aunque declare varios produces')
  assert.equal(us[0].kind, 'point')
  assert.notEqual(us[0].kind, 'label')
})

/* ════════════════ cristaeConfig: opcional, se consulta UNA vez por reducción ════════════════ */

test('un wrapper sin cristaeConfig entrega {} al apply', () => {
  const e = motor()
  reduceModifier(Cl([P()]), e, ctx)
  assert.deepEqual(e.llamadas[0][2], {})
})

test('la config se lee una sola vez y el MISMO objeto llega a todos los applies del map', () => {
  const cfg = { radio: 80 }
  const nodo = Ov([P(), P(), P()], { config: cfg })
  const e = motor()
  reduceModifier(nodo, e, ctx)
  assert.equal(nodo.vecesConfig, 1)
  assert.equal(e.llamadas.length, 3, 'combine map → un apply por target')
  for (const [, , recibida] of e.llamadas) assert.equal(recibida, cfg)
})

/* ════════════════ apply: firma (engine, targets, config) y dispatch fold/map ════════════════ */

test('fold aplica UNA vez sobre todos los targets; map una vez por target', () => {
  const eFold = motor()
  reduceModifier(Cl([P(), P(), P()]), eFold, ctx)
  assert.equal(eFold.llamadas.length, 1)
  assert.equal(eFold.llamadas[0][1].length, 3)

  const eMap = motor()
  reduceModifier(Ov([P(), P(), P()]), eMap, ctx)
  assert.equal(eMap.llamadas.length, 3)
  for (const [, ids] of eMap.llamadas) assert.equal(ids.length, 1)
})

test('sólo llegan al apply las units cuyo kind está en consumes', () => {
  const e = motor()
  const units = reduceModifier(Cl([P(), L()]), e, ctx)
  assert.equal(e.llamadas.length, 1)
  assert.equal(e.llamadas[0][1].length, 1, 'la label no es target del cluster')
  assert.deepEqual(kinds(units), ['bubble', 'label', 'point'], 'pero la label pasa hacia arriba')
})

test('un apply que devuelve null o [] no aporta units, y el pass-through se conserva', () => {
  for (const retorno of ['nada', 'vacio']) {
    const e = motor({ retorno })
    const units = reduceModifier(Cl([P(), P()]), e, ctx)
    assert.equal(e.llamadas.length, 1)
    assert.deepEqual(kinds(units), ['point', 'point'], `retorno ${retorno}`)
  }
})

test('un wrapper registrado SIN apply reduce a sus hijos sin producir nada', () => {
  const e = motor()
  const units = reduceModifier(envoltorio('cristae-inerte', [P(), L()]), e, ctx)
  assert.equal(e.llamadas.length, 0)
  assert.deepEqual(kinds(units), ['label', 'point'])
})

test('passThrough:false descarta lo consumido y conserva el resto', () => {
  const e = motor()
  const units = reduceModifier(envoltorio('cristae-absorbe', [P(), L()]), e, ctx)
  assert.deepEqual(kinds(units), ['bubble', 'label'], 'el point consumido no se re-emite')
})

test('el orden de salida es [hijos que pasan, ...producidas]', () => {
  const e = motor()
  const units = reduceModifier(Cl([P(), L()]), e, ctx)
  assert.deepEqual(units.map(u => u.kind), ['point', 'label', 'bubble'])
})

test('la lista devuelta es PROPIA de cada reducción: ni acumulador compartido ni alias de los hijos', () => {
  // El reductor devuelve `[...carried, ...produced]`: una lista nueva. Si devolviera su
  // acumulador interno (o un portador reusado entre llamadas), el llamador podría
  // contaminar las units del hijo y dos reducciones se pisarían entre sí.
  const hijo = Ov([P()])
  const e = motor()
  const a = reduceModifier(Cl([hijo]), e, ctx)
  const unitsDelHijo = hijo.cristaeUnits()
  assert.notEqual(a, unitsDelHijo, 'no es un alias de la lista del hijo')

  const antes = unitsDelHijo.length
  a.push({ kind: 'intruso' })
  assert.equal(hijo.cristaeUnits().length, antes, 'mutar el resultado no toca las units del hijo')

  // Segunda reducción del MISMO árbol: lista distinta y sin arrastre de la anterior.
  const b = reduceModifier(Cl([Ov([P()])]), motor(), ctx)
  assert.notEqual(b, a)
  assert.deepEqual(b.map(u => u.kind), ['point', 'overlay', 'bubble'])
})

/* ════════════════ `suppressed`: GETTER VIVO, nunca una copia ════════════════ */

test('suppressed es un accessor, no un valor plano', () => {
  const e = motor()
  e.capas.set('p1', { suppressed: null })
  const u = buildUnit('point', { id: 'p1' }, e)
  const d = Object.getOwnPropertyDescriptor(u, 'suppressed')
  assert.equal(typeof d.get, 'function', 'suppressed debe ser un getter')
  assert.equal(d.value, undefined, 'no puede materializarse como valor')
})

test('suppressed refleja la mutación del layer POSTERIOR a construir la unit', () => {
  const e = motor()
  const capa = { suppressed: null }
  e.capas.set('p1', capa)
  const u = buildUnit('point', { id: 'p1' }, e)
  assert.equal(u.suppressed, null)

  // El cluster instala el set de supresión DESPUÉS de que la unit ya circuló.
  const set = new Set()
  capa.suppressed = set
  assert.equal(u.suppressed, set, 'la unit debe ver el set nuevo, no la foto vieja')

  // Y lo sigue viendo mutar in place (el cluster hace add/delete, no reasigna).
  set.add(7)
  assert.equal(u.suppressed.size, 1)
  assert.equal(u.suppressed.has(7), true)
})

test('suppressed sigue al layer aunque el motor reemplace la capa entera', () => {
  const e = motor()
  e.capas.set('p1', { suppressed: new Set(['a']) })
  const u = buildUnit('point', { id: 'p1' }, e)
  e.capas.set('p1', { suppressed: new Set(['b', 'c']) })
  assert.deepEqual([...u.suppressed], ['b', 'c'])
})

test('la unit de una hoja reducida también trae el getter vivo', () => {
  // Recorrido completo: la unit llega al apply del cluster con `suppressed` todavía vivo.
  const e = motor()
  const p = P()
  reduceModifier(Cl([p]), e, ctx)
  const capa = e.capas.get(p._handle.id)
  const u = leafUnits(p, e, ctx)[0]
  assert.equal(u.suppressed, null)
  capa.suppressed = new Set([1, 2])
  assert.equal(u.suppressed.size, 2)
})

test('sin capa, sin getLayer o con suppressed indefinido, suppressed es null (nunca undefined)', () => {
  const e = motor()
  assert.equal(buildUnit('point', { id: 'inexistente' }, e).suppressed, null)
  e.capas.set('p1', {})
  assert.equal(buildUnit('point', { id: 'p1' }, e).suppressed, null)
  const sinGetLayer = motor({ conGetLayer: false })
  assert.equal(buildUnit('point', { id: 'p1' }, sinGetLayer).suppressed, null)
})

test('buildUnit copia id/handle/source del handle recibido', () => {
  const e = motor()
  const handle = { id: 'x9', source: { marca: 'src' } }
  const u = buildUnit('bubble', handle, e)
  assert.equal(u.kind, 'bubble')
  assert.equal(u.id, 'x9')
  assert.equal(u.handle, handle)
  assert.equal(u.source, handle.source)
})

/* ════════════════ validate no toca el protocolo de montaje ════════════════ */

test('validar un árbol NO monta nada: sólo lee tagName/children/slot', () => {
  const explota = () => { throw new Error('validate no debe montar') }
  const p = P()
  p.cristaeMount = explota
  const w = Cl([p])
  w.cristaeMount = explota
  assert.equal(validate(w, vctx), true)
})

test('un wrapper propaga hacia arriba lo que consume y deja de propagarlo con passThrough:false', () => {
  // El juicio de tipos es bottom-up: el cluster de afuera sólo es válido si el overlay de
  // adentro RE-EMITE el point que consumió. Si la propagación se corta, el cluster se queda
  // sin nada que consumir → R2.
  assert.equal(validate(Cl([Ov([P()])]), vctx), true, 'Cluster(Overlay(Point)) es válido')

  const absorbe = envoltorio('cristae-absorbe', [P()])
  const e = capturar(() => validate(Cl([absorbe]), vctx))
  assert.ok(e instanceof GrammarError, 'un wrapper passThrough:false no alimenta al de afuera')
  assert.equal(e.code, 'R2')
})

test('un wrapper cuyos hijos no producen NADA de lo que consume es R2', () => {
  const e = capturar(() => validate(Cl([L()]), vctx))
  assert.ok(e instanceof GrammarError)
  assert.equal(e.code, 'R2')
  assert.match(e.message, /ningún hijo lo produce/)
})

/* ════════════════ mode 'warn': degrada el juicio, NO se traga otros errores ════════════════ */

// Captura console.error sin globals sucios: restaura siempre y devuelve lo escrito.
const conConsola = (fn) => {
  const original = console.error
  const logs = []
  console.error = (...a) => logs.push(String(a[0]))
  let resultado, error = null
  try { resultado = fn() } catch (e) { error = e } finally { console.error = original }
  return { resultado, error, logs }
}

test('en mode warn un árbol inválido reporta por consola y devuelve false, sin lanzar', () => {
  const { resultado, error, logs } = conConsola(() => validate(Cl([L()]), { ...vctx, mode: 'warn' }))
  assert.equal(error, null, 'no debe lanzar')
  assert.equal(resultado, false)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /^\[cristae-grammar\] /)
})

test('en mode warn un error que NO es GrammarError se propaga: el catch no es un tragador', () => {
  // Quitar el `e instanceof GrammarError` convertiría cualquier TypeError/ReferenceError del
  // recorrido en un `false` silencioso — un bug del refactor se vería como "árbol inválido".
  const roto = { signatureFor: () => { throw new TypeError('boom') }, isRegistered: g.isRegistered, mode: 'warn' }
  const { error, logs } = conConsola(() => validate(P(), roto))
  assert.ok(error instanceof TypeError, `esperaba el TypeError original, hubo: ${error}`)
  assert.equal(error.message, 'boom')
  assert.deepEqual(logs, [], 'y no lo reporta como violación de gramática')
})

test('en mode throw el GrammarError se propaga y nada se reporta por consola', () => {
  const { error, logs } = conConsola(() => validate(Cl([L()]), vctx))
  assert.ok(error instanceof GrammarError)
  assert.deepEqual(logs, [])
})

/* ════════════════ Forma de GrammarError ════════════════ */

test('GrammarError expone {name, code, node} y es un Error', () => {
  const hijoIlegal = P()
  // Una hoja con hijos viola R1: el nodo del error debe ser esa hoja.
  const arbol = { tagName: 'CRISTAE-POINT-LAYER', children: [hijoIlegal], getAttribute: () => null }
  let e
  try { validate(arbol, vctx) } catch (err) { e = err }
  assert.ok(e instanceof GrammarError)
  assert.ok(e instanceof Error)
  assert.equal(e.name, 'GrammarError')
  assert.equal(e.code, 'R1')
  assert.equal(e.node, arbol, 'node apunta al elemento ofensor, por identidad')
  // El mensaje lleva el prefijo del segmento y NOMBRA al ofensor y al hijo encontrado:
  // es lo único que ve el desarrollador cuando el árbol es inválido.
  assert.match(e.message, /^\[cristae-grammar\] /)
  assert.match(e.message, /<cristae-point-layer>/)
  assert.match(e.message, /kind 'point'/)
})

test('el node de un GrammarError sin elemento asociado es null, nunca undefined', () => {
  assert.equal(new GrammarError('R4', undefined, 'x').node, null)
  assert.equal(new GrammarError('R2', null, 'x').node, null)
})

/* ════════════════ Determinismo del recorrido ════════════════ */

test('un árbol anidado produce ESTA secuencia de llamadas al motor (post-orden), y siempre la misma', () => {
  // GOLDEN literal, no `secuencia() vs secuencia()`: comparar el módulo consigo mismo sólo
  // detectaría no-determinismo (que el reductor no tiene) y no congela ni el orden ni la
  // aridad. Cl(Ov(P,P), L): el overlay aplica 1 vez POR punto (map) y ANTES que el cluster;
  // el fold del cluster recibe los 2 puntos juntos; la label nunca es target.
  const construir = () => Cl([Ov([P(), P()]), L()])
  const secuencia = () => {
    const e = motor()
    reduceModifier(construir(), e, ctx)
    return e.llamadas.map(([modo, ids]) => [modo, ids.length])
  }
  const esperada = [['map', 1], ['map', 1], ['fold', 2]]
  assert.deepEqual(secuencia(), esperada)
  assert.deepEqual(secuencia(), esperada, 'y el recorrido es determinista')
})

test('el árbol anidado produce ESTAS units, en este orden', () => {
  const e = motor()
  const units = reduceModifier(Cl([Ov([P(), P()]), L()]), e, ctx)
  // [units de los hijos en orden de documento, ...producidas]: el overlay pasa sus 2 puntos
  // y sus 2 badges, la label pasa entera, y la burbuja del fold cierra la lista.
  assert.deepEqual(units.map(u => u.kind),
    ['point', 'point', 'overlay', 'overlay', 'label', 'bubble'])
})
