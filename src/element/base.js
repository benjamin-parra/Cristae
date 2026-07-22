import { LitElement, nothing } from 'lit'
import { grammar } from './composite.js'
import { enclosingModifier, leafUnits } from '../grammar/index.js'

// Base de las capas declarativas. No renderan nada visible (viven en light DOM como portadores de
// config + reactividad). El montaje es una FUNCIÓN REACTIVA de (motor ⊗ config): no ocurre en un
// instante fijo, sino en el ciclo `updated()` de Lit, que corre tanto cuando el contenedor entrega
// el motor como cuando el consumidor asigna las props (objetos/funciones, seteadas por JS tras
// conectar el elemento → pueden llegar antes o después del motor, en el orden que sea). La base
// orquesta ese ciclo; cada subclase solo declara su contrato: mountReady / mountLayer / syncLayer.
export class CristaeLayerElement extends LitElement {

  _handle = null
  _engine = null

  render() { return nothing }                 // shadow vacío; los hijos light-DOM quedan intactos

  // Handle imperativo de la capa (lo que devolvió el engine al montar): set/move/patch/filtros/
  // visibilidad. Público para quien declaró la capa pero necesita control imperativo — sin
  // perforar el campo privado. null hasta que la capa monta.
  get controls() { return this._handle }

  connectedCallback() {
    super.connectedCallback()
    if (this._enclosingModifier()) return       // el modificador gestiona a sus hijos
    this.closest('cristae-map')?.requestMount(this)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this.cristaeUnmount()
  }

  // El contenedor entrega el motor e intenta montar de inmediato (sincrónico: el cluster monta su
  // host así y lee su handle al toque). Si falta config, queda pendiente para updated().
  cristaeMount(engine) {
    if (this._engine) return
    this._engine = engine
    if (this.mountReady()) this._handle = this.mountLayer(engine)   // _handle null acá; montar si hay config
  }

  cristaeUnmount() {
    if (this._handle && this._engine) this._engine.removeLayer(this._handle.id)
    this._handle = null
    this._engine = null
  }

  // Único punto del ciclo: monta cuando coinciden motor + config (independiente del orden), o reenvía
  // si ya está montada. Un hijo de cluster recibe el motor del cluster (no del map): si su config llega
  // tarde y sigue sin montar, le pide al cluster que reintente (reevalúa mountReady y monta host+cluster).
  updated(changed) {
    if (this._handle) { this.syncLayer(changed); return }
    if (this._engine && this.mountReady()) this._handle = this.mountLayer(this._engine)
    if (!this._handle) this._enclosingModifier()?.requestUpdate()
  }

  /* ── Contrato de subclase ── */
  mountReady() { return true }                  // ¿hay config mínima para montar? (override si requiere props JS)
  mountLayer(_engine) { return null }           // crea la capa en el motor y devuelve su handle
  syncLayer(_changed) {}                        // reenvía cambios de props al handle ya montado

  // RenderUnits que aporta este nodo a su modificador padre (gramática de composición).
  // Default = HOJA (una unit del kind que produce la firma). Los modificadores (cluster/
  // overlay) lo sobreescriben para devolver el conjunto que reduce su subárbol.
  cristaeUnits() {
    if (!this._handle || !this._engine) return []
    return leafUnits(this, this._engine, { signatureFor: grammar.signatureFor })
  }

  // Modificador de la gramática que envuelve a este elemento (cluster/overlay/…). Sus
  // hijos NO se auto-montan: los monta el modificador (su reductor).
  _enclosingModifier() {
    return enclosingModifier(this, grammar.isWrapper)
  }
}
