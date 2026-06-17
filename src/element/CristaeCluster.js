import { CristaeLayerElement } from './base.js'
import { grammar } from './composite.js'
import { reduceModifier, validate } from '../grammar/index.js'

let clSeq = 0

// <cristae-cluster> — MODIFICADOR de la gramática de composición (combine: 'fold').
// Clusteriza el/los hijo(s) de puntos: los agrupa en UN supercluster (si hay varios, sobre
// la unión) y los suprime, emitiendo burbujas. Como modificador, compone con `<cristae-overlay>`
// en CUALQUIER orden de anidación — el orden declarativo es la semántica, sin métodos de control:
//
//   <cristae-cluster radius="88" min-points="2">
//     <cristae-overlay><cristae-point-layer id="fleet"/></cristae-overlay>   <!-- badges se ocultan al clusterizar -->
//   </cristae-cluster>
//
// Hija opcional `slot="bubble"` (point o label) = cómo se ven las burbujas. Sin ella → default.
export class CristaeCluster extends CristaeLayerElement {

  // Modificador `fold`: consume `point`, produce `point` (pass-through, suprimido) + `bubble`.
  static cristaeSignature = { consumes: ['point'], produces: ['point', 'bubble'], combine: 'fold', arity: 'wrapper' }

  // apply del reductor: fold → clusteriza TODOS los targets juntos; devuelve la unit de burbuja.
  static cristaeApply(engine, targets, cfg) {
    const bubble = engine.addClusterFold(targets, cfg)
    return bubble ? [bubble] : []
  }

  static properties = {
    radius: { type: Number },
    maxZoom: { type: Number, attribute: 'max-zoom' },
    minPoints: { type: Number, attribute: 'min-points' },
  }

  // Listo cuando todos los hijos de gramática (host(s), no la burbuja) tienen su config.
  mountReady() {
    return [...this.children]
      .filter(el => el.getAttribute?.('slot') !== 'bubble' && typeof el.cristaeMount === 'function')
      .every(el => el.mountReady())
  }

  mountLayer(engine) {
    if (!this._enclosingModifier())
      validate(this, { signatureFor: grammar.signatureFor, isRegistered: grammar.isRegistered, mode: grammar.mode })

    const ctx = { signatureFor: grammar.signatureFor, applyFor: grammar.applyFor, isRegistered: grammar.isRegistered }
    this._units = reduceModifier(this, engine, ctx)

    // El control del cluster viaja en el handle de la unit de burbuja (setConfig/dispose). El
    // teardown del clustering lo dispara el quitado de los hosts (cada host comparte un dispose
    // idempotente), así que el _handle del cluster es un marcador (no una capa) → removeLayer no-op.
    const bubble = this._units.find(u => u.kind === 'bubble')
    return { id: `cluster-marker-${++clSeq}`, units: this._units, control: bubble?.handle?.control ?? null }
  }

  cristaeUnits() { return this._units ?? [] }

  cristaeConfig() {
    return { radius: this.radius, maxZoom: this.maxZoom, minPoints: this.minPoints, bubble: this.#bubbleConfig() }
  }

  syncLayer(changed) {
    if (changed.has('radius') || changed.has('maxZoom') || changed.has('minPoints')) {
      this._handle?.control?.setConfig({ radius: this.radius, maxZoom: this.maxZoom, minPoints: this.minPoints })
    }
  }

  #bubbleConfig() {
    const b = [...this.children].find(el => el.getAttribute?.('slot') === 'bubble')
    if (!b) return undefined
    if (b.tagName === 'CRISTAE-LABEL-LAYER') return { kind: 'label', textOf: b.textOf, paint: b.paint, style: b.style }
    return { kind: 'point', iconSet: b.iconSet, sizeOf: b.sizeOf }
  }
}
