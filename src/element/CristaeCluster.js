import { CristaeLayerElement } from './base.js'

// <cristae-cluster> — envuelve la capa de puntos que se va a clusterizar (hijo host) y, opcional,
// una capa hija slot="bubble" (point o label) que define cómo se ven las burbujas. Sin hija
// bubble → icon-set de cluster por defecto. radius/max-zoom/min-points son reactivos.
//
//   <cristae-cluster radius="88" min-points="2">
//     <cristae-point-layer id="fleet" interactive></cristae-point-layer>   <!-- host -->
//     <cristae-point-layer slot="bubble" icon-set="clusters"></cristae-point-layer>  <!-- opcional -->
//   </cristae-cluster>
export class CristaeCluster extends CristaeLayerElement {

  static properties = {
    radius: { type: Number },
    maxZoom: { type: Number, attribute: 'max-zoom' },
    minPoints: { type: Number, attribute: 'min-points' },
  }

  // Listo cuando el host existe y tiene su config (source/accessors). Si no, difiere: el host avisará
  // al cluster (base.updated) cuando su config llegue tarde.
  mountReady() { const h = this.#hostChild(); return !!h && h.mountReady() }

  mountLayer(engine) {
    const hostEl = this.#hostChild()
    hostEl.cristaeMount(engine)                       // monta el host sincrónicamente (mountReady ya verificado)
    const hostId = hostEl._handle?.id
    if (hostId == null) return null

    engine.addCluster({
      hostId,
      radius: this.radius,
      maxZoom: this.maxZoom,
      minPoints: this.minPoints,
      bubble: this.#bubbleConfig(),
    })
    return { id: hostId }                              // remover el host arrastra su cluster (dispose)
  }

  syncLayer(changed) {
    if (changed.has('radius') || changed.has('maxZoom') || changed.has('minPoints')) {
      this._engine.getLayer(this._handle.id)?.cluster?.setConfig({
        radius: this.radius, maxZoom: this.maxZoom, minPoints: this.minPoints,
      })
    }
  }

  #hostChild() {
    return [...this.children].find(el =>
      el.getAttribute?.('slot') !== 'bubble' && typeof el.cristaeMount === 'function')
  }

  #bubbleConfig() {
    const b = [...this.children].find(el => el.getAttribute?.('slot') === 'bubble')
    if (!b) return undefined
    if (b.tagName === 'CRISTAE-LABEL-LAYER') return { kind: 'label', textOf: b.textOf, paint: b.paint, style: b.style }
    return { kind: 'point', iconSet: b.iconSet, sizeOf: b.sizeOf }
  }
}
