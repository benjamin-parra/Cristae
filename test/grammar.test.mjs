// Tests del segmento cristae/grammar (validación + reducción). Sin DOM ni WebGL:
// elementos fake que reproducen el flujo de montaje de los custom-elements reales
// (entidad = handle de hoja; modificador = reduceModifier), y un motor fake que
// registra las llamadas. node test/grammar.test.mjs  (o npm test)
import {
  defineGrammar, validate, GrammarError, reduceModifier, leafUnits,
} from '../src/grammar/index.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗', m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`)

// ── Gramática real (las 5 firmas) ──
const g = defineGrammar({ kinds: ['point', 'label', 'polygon', 'bubble', 'overlay'] })
g.register('CRISTAE-POINT-LAYER', { consumes: [], produces: ['point'], combine: null, arity: 'leaf' })
g.register('CRISTAE-LABEL-LAYER', { consumes: [], produces: ['label'], combine: null, arity: 'leaf', bindsTo: 'point' })
g.register('CRISTAE-POLYGON-LAYER', { consumes: [], produces: ['polygon'], combine: null, arity: 'leaf' })
g.register('CRISTAE-OVERLAY',
  { consumes: ['point'], produces: ['overlay'], combine: 'map', arity: 'wrapper', bindsTo: 'point' },
  { apply: (engine, targets) => targets.map(t => engine.addOverlay(t)) })
g.register('CRISTAE-CLUSTER',
  { consumes: ['point'], produces: ['point', 'bubble'], combine: 'fold', arity: 'wrapper' },
  { apply: (engine, targets) => { const b = engine.addClusterFold(targets); return b ? [b] : [] } })

const ctx = { signatureFor: g.signatureFor, applyFor: g.applyFor, isRegistered: g.isRegistered }
const vctx = { signatureFor: g.signatureFor, isRegistered: g.isRegistered, mode: 'throw' }

// ── Fakes que replican el flujo real de mountLayer ──
let seq = 0
function el(tag, ...children) {
  const node = {
    tagName: tag.toUpperCase(), children, getAttribute: () => null,
    _handle: null, _engine: null, _units: null,
  }
  node.cristaeMount = (engine) => {
    if (node._handle) return
    node._engine = engine
    const sig = g.signatureFor(node.tagName)
    if (sig.arity === 'leaf') {
      node._handle = { id: `${tag.toLowerCase()}-${++seq}`, source: { tag } }
    } else {
      node._units = reduceModifier(node, engine, ctx)
      // overlay → id del punto; cluster → marcador (igual que los elementos reales)
      const point = node._units.find(u => u.kind === 'point')
      node._handle = { id: tag === 'cristae-cluster' ? `cl-${++seq}` : (point?.id ?? `${tag}-${++seq}`) }
    }
  }
  node.cristaeUnits = () => {
    const sig = g.signatureFor(node.tagName)
    return sig.arity === 'leaf' ? leafUnits(node, node._engine, ctx) : (node._units ?? [])
  }
  node.cristaeConfig = () => ({})
  return node
}
const P = () => el('cristae-point-layer')
const L = () => el('cristae-label-layer')
const Poly = () => el('cristae-polygon-layer')
const Ov = (...k) => el('cristae-overlay', ...k)
const Cl = (...k) => el('cristae-cluster', ...k)

function fakeEngine() {
  const calls = []
  return {
    calls,
    getLayer: () => ({ suppressed: null }),
    addClusterFold: (targets) => { calls.push(['fold', targets.map(t => t.id)]); return { kind: 'bubble', id: `bubble-${++seq}`, handle: {} } },
    addOverlay: (t) => { calls.push(['overlay', t.id]); return { kind: 'overlay', id: `ovl-${++seq}`, handle: {}, hostId: t.id } },
  }
}
function run(root) { const e = fakeEngine(); root.cristaeMount(e); return { units: root.cristaeUnits(), calls: e.calls } }
const kinds = (units) => units.map(u => u.kind).sort()

// ════════════════ VALIDATE ════════════════
console.log('validate')
ok(validate(Cl(Ov(P())), vctx), 'Cluster(Overlay(Point)) válido')
ok(validate(Ov(Cl(P())), vctx), 'Overlay(Cluster(Point)) válido')
ok(validate(Ov(Ov(P())), vctx), 'Overlay(Overlay(Point)) válido')
ok(validate(Ov(P(), P()), vctx), 'Overlay(P,P) válido')
ok(validate(Cl(P(), P()), vctx), 'Cluster(P,P) válido')
ok(validate(Cl(Ov(P()), Ov(P())), vctx), 'Cluster(Overlay(P),Overlay(P)) válido')
const expectErr = (fn, code, m) => {
  try { fn(); fail++; console.error('  ✗', m, '(no lanzó)') }
  catch (e) { ok(e instanceof GrammarError && e.code === code, `${m} → ${code} (fue ${e.code ?? e.message})`) }
}
expectErr(() => validate(el('cristae-point-layer', P()), vctx), 'R1', 'Point(Point)')
expectErr(() => validate(Cl(L()), vctx), 'R2', 'Cluster(Label)')
expectErr(() => validate(Cl(Poly()), vctx), 'R2', 'Cluster(Polygon)')
expectErr(() => validate(Cl(), vctx), 'R3', 'Cluster() vacío')
expectErr(() => g.register('X', { consumes: ['pont'], produces: ['point'], combine: 'fold', arity: 'wrapper' }), 'R4', 'kind desconocido')
// warn mode no lanza
ok(validate(Cl(L()), { ...vctx, mode: 'warn' }) === false, 'mode warn → false sin lanzar')

// ════════════════ REDUCE: protocolo de llamadas ════════════════
console.log('reduce')
{
  const { units, calls } = run(Cl(Ov(P())))
  eq(kinds(units), ['bubble', 'overlay', 'point'], 'Cluster(Overlay(Point)) units')
  ok(calls.filter(c => c[0] === 'fold').length === 1, 'fold ×1')
  ok(calls.filter(c => c[0] === 'overlay').length === 1, 'overlay ×1')
  // el overlay se monta ANTES del fold (post-orden): el badge existe y luego el cluster suprime
  ok(calls.findIndex(c => c[0] === 'overlay') < calls.findIndex(c => c[0] === 'fold'), 'overlay antes que fold (post-orden)')
}
{
  const { units, calls } = run(Ov(Cl(P())))
  eq(kinds(units), ['bubble', 'overlay', 'point'], 'Overlay(Cluster(Point)) units')
  ok(calls.filter(c => c[0] === 'fold').length === 1 && calls.filter(c => c[0] === 'overlay').length === 1, 'Overlay(Cluster(P)): 1 fold + 1 overlay')
  ok(calls.findIndex(c => c[0] === 'fold') < calls.findIndex(c => c[0] === 'overlay'), 'fold antes que overlay (badge sobre puntos solo)')
}
{
  const { units, calls } = run(Ov(P(), P()))
  ok(units.filter(u => u.kind === 'overlay').length === 2, 'Overlay(P,P) → 2 overlays')
  ok(calls.filter(c => c[0] === 'overlay').length === 2, 'map: 2 applies')
}
{
  const { calls } = run(Cl(P(), P()))
  const folds = calls.filter(c => c[0] === 'fold')
  ok(folds.length === 1 && folds[0][1].length === 2, 'Cluster(P,P) → 1 fold sobre 2 targets (fold)')
}
{
  const { units, calls } = run(Ov(Ov(P())))
  ok(units.filter(u => u.kind === 'overlay').length === 2, 'Overlay(Overlay(P)) → 2 overlays sobre 1 point')
  ok(calls.filter(c => c[0] === 'overlay').length === 2, '2 applies de overlay')
}
{
  const { units, calls } = run(Cl(Ov(P()), Ov(P())))
  ok(units.filter(u => u.kind === 'overlay').length === 2, 'Cluster(Overlay(P),Overlay(P)) → 2 overlays')
  const folds = calls.filter(c => c[0] === 'fold')
  ok(folds.length === 1 && folds[0][1].length === 2, '1 fold sobre los 2 puntos (clusterizados juntos)')
}

// ════════════════ DETERMINISMO ════════════════
console.log('determinismo')
{
  const a = run(Cl(Ov(P()))).calls.map(c => c[0])
  const b = run(Cl(Ov(P()))).calls.map(c => c[0])
  eq(a, b, 'mismo árbol → misma secuencia de llamadas')
}

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
