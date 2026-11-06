import { CristaeLayerElement } from './base.js'
import { makeAutoId } from './autoId.js'
import { deprecated, RETIRO } from '../engine/deprecated.js'
import { DEFAULT_STYLE, drawLabel } from '../render/LabelLayer.js'
import { STACK } from '../engine/stack.js'

// <cristae-label-layer> — deprecada y sin implementación propia: cada uso se traduce a su reemplazo.
//   - `bind-to="<id>"`: los rótulos de <cristae-labeled> sobre el host (`addLabels`). Se resuelve por nombre y
//     en cualquier orden: si el host todavía no existe, se reintenta en el cuadro siguiente.
//   - `source` propio: una <cristae-text-layer> (`addTextLayer`) con el id de esta capa.
//   - hija slot="bubble" de un cluster: no se monta. El cluster la lee como configuración de burbuja y el motor
//     rotula las burbujas como lo haría un <cristae-labeled> por fuera del cluster (`addClusterFold`).
// Se ve como siempre: la píldora (`drawLabel` o el `paint` declarado) con su `style`, y el hover que marca el
// handle. Avisa su retiro una vez por página, al montarse como capa, con la misma clave que `addLabelLayer`.
/** @deprecated Se retira en v0.47.0: con `bind-to` la reemplaza `<cristae-labeled>` sobre la capa de puntos
 *  (docs/labeled.md); con `source` propio, `<cristae-text-layer>`. */
export class CristaeLabelLayer extends CristaeLayerElement {

  // Gramática de composición: hoja que produce `label`. El ligado a un host lo da el atributo `bind-to`, no
  // la firma.
  static cristaeSignature = { role: 'leaf', produces: ['label'] }

  static properties = {
    bindTo    : { attribute: 'bind-to' },
    source    : { type: Object },
    accessors : { type: Object },
    textOf    : { attribute: false },
    paint     : { attribute: false },
    style     : { type: Object },
    visible   : { type: Boolean },
  }

  // Sin campos `#`: los tests prestan los métodos del prototipo a un objeto sin constructor.
  _labels  = null                 // { update, setVisible, remove } de los rótulos; null mientras no hay host
  _frame   = 0                    // el reintento del ligado, pendiente
  _hovered = null                 // los ids que marcó `setHovered`
  _shown   = true                 // la visibilidad pedida, que se aplica también al ligar tarde

  constructor() {
    super()
    this.visible = true
  }

  layerId() { return this.id || (this._auto ??= makeAutoId('label')) }

  // Atada a un host (`bind-to`, atributo) o con Source propia. Sin ninguna, diferir el montaje.
  mountReady() { return !!(this.bindTo || this.source) }

  // El handle de siempre, sin `setLabels`: los rótulos salen del host o de la Source. Sin `source`, así el
  // mapa no la cuenta entre las capas de datos.
  mountLayer(engine) {
    deprecated('label-layer', `[cristae-label-layer] se retira en ${RETIRO}: con bind-to la reemplaza <cristae-labeled> ` +
      'sobre la capa de puntos (docs/labeled.md); con source propio, <cristae-text-layer>.')
    this._shown = !!this.visible
    this._attach(engine)
    return {
      id         : this.layerId(),
      setVisible : visible => {
        this._shown = !!visible
        this._labels?.setVisible(this._shown)
      },
      setHovered : ids => {
        const hovered = this._hovered ??= new Set()
        hovered.clear()
        for (const id of ids) hovered.add(id)
        this._labels?.update({ paint: this._pill() })
      },
    }
  }

  // Con lo declarado al montar. `bind-to`, `source` y `accessors` no cambian en caliente, como antes; el resto
  // viaja por el handle de los rótulos.
  syncLayer(changed) {
    changed.has('visible') && this._handle.setVisible(this.visible)
    const patch = {}
    changed.has('textOf') && (patch.textOf = this.textOf ?? null)
    ;(changed.has('paint') || changed.has('style')) && (patch.paint = this._pill())
    Object.keys(patch).length && this._labels?.update(patch)
  }

  cristaeUnmount() {
    cancelAnimationFrame(this._frame)
    this._frame = 0
    this._labels?.remove()
    this._labels = null
    super.cristaeUnmount()
  }

  // Liga los rótulos con lo declarado en este momento. Con `bind-to` y sin host, reintenta en el cuadro siguiente
  // mientras la capa siga conectada y montada en este motor.
  _attach(engine) {
    this._frame   = 0
    const options = { textOf: this.textOf ?? null, paint: this._pill() }
    if (!this.bindTo) {
      const text = engine.addTextLayer({ [STACK]: this, id: this.layerId(), source: this.source, accessors: this.accessors, visible: this._shown, ...options })
      this._labels = { update: text.update, setVisible: text.setVisible, remove: () => engine.removeLayer(text.id) }
      return
    }
    if (!engine.getLayer(this.bindTo)) {
      this._engine === engine && this.isConnected && (this._frame = requestAnimationFrame(() => this._attach(engine)))
      return
    }
    const labels = engine.addLabels({ hostId: this.bindTo, visible: this._shown, ...options })
    this._labels = labels && { update: labels.update, setVisible: visible => labels.update({ visible }), remove: labels.remove }
  }

  // La píldora: el `paint` declarado o `drawLabel`, con su `style` y el hover de `setHovered`. Cada llamada da
  // una función nueva, que hace repintar.
  _pill() {
    const paint   = this.paint ?? drawLabel
    const style   = this.style ?? DEFAULT_STYLE
    const hovered = this._hovered ??= new Set()
    return (ctx, point, label) => paint(ctx, point, label, hovered.has(label.id), style)
  }
}
