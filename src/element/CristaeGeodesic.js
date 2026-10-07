import { CristaeModifierElement } from './base.js'
import { boolDefaultOn, boolOff } from './attrs.js'
import { makeAutoId } from './autoId.js'
import { grammar } from './composite.js'
import { buildUnit, grammarChildren } from '../grammar/index.js'

// <cristae-geodesic> — MODIFICADOR de la gramática de composición (combine: 'map').
// Curva sobre la geodésica los tramos largos de la capa de líneas, la de polígonos o el editor de polilínea
// o de polígono que envuelve; un track GPS no cambia. Dibujo, picking y encuadre salen de esa curva. No
// aplica al rectángulo, a las formas, ni a puntos, labels o html: envolver sólo uno de ésos da R2,
// y un hermano que no consume pasa intacto.
//
//   <cristae-geodesic><cristae-line-layer id="vuelos"></cristae-line-layer></cristae-geodesic>
//
// `enabled` en false dibuja rectas sin desmontar el hijo. La curva usa el modelo del mapa y es estado del
// host: quitar el host la destruye con él.
export class CristaeGeodesic extends CristaeModifierElement {

  // Modificador `map`: consume `line` y `polygon`, produce `geodesic` (uno por host) y deja pasar al host.
  static cristaeSignature = { consumes: ['line', 'polygon'], produces: ['geodesic'], combine: 'map', arity: 'wrapper' }

  // apply del reductor: curva cada host y guarda su baja en el handle de la unit, que `enabled` alterna.
  static cristaeApply(engine, targets, { enabled }) {
    return targets.map(({ id }) => {
      let off = null
      const set = on => {
        if (on) off ??= engine.addGeodesic({ hostId: id })
        else { off?.(); off = null }
      }
      set(enabled)
      return buildUnit('geodesic', { id: `${id}:geodesic`, set }, engine)
    })
  }

  static properties = {
    enabled: { converter: boolDefaultOn },    // default true; "false" o "0" → rectas, sin desmontar el hijo
  }

  #own = []

  constructor() {
    super()
    this.enabled = true
  }

  // El `_handle` es un marcador (no una capa): `removeLayer` no hace nada, y la curva la destruye cada host al irse.
  // `enabled` alterna sólo las curvas propias: las de un <cristae-geodesic> anidado suben con los hijos y son suyas.
  mountLayer(engine) {
    const units  = this._reduce(engine)
    const nested = new Set(grammarChildren(this, grammar.isRegistered).flatMap(el => el.cristaeUnits()))
    this.#own    = units.filter(u => u.kind === 'geodesic' && !nested.has(u))
    return { id: makeAutoId('geodesic-marker'), units }
  }

  // Asignado como propiedad llega crudo: quitarlo (undefined) deja la curva y "false" la apaga, como el atributo.
  cristaeConfig() { return { enabled: !boolOff(this.enabled) } }

  syncLayer(changed) {
    changed.has('enabled') && this.#own.forEach(u => u.handle.set(!boolOff(this.enabled)))
  }
}
