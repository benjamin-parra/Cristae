import { CristaeModifierElement } from './base.js'
import { makeAutoId } from './autoId.js'
import { grammar } from './composite.js'
import { grammarChildren } from '../grammar/index.js'

// Semilla del id por-host de cada badge que monta `cristaeApply` (`<hostId>:overlay:<n>`): un mismo
// host puede llevar varios overlays, así que el contador desambigua. Vive acá, no en `makeAutoId`,
// porque su id lleva el prefijo del host (no el `overlay-<n>` plano de la ruta hoja).
let ovlSeq = 0

// <cristae-overlay> — DECORADOR de la gramática de composición.
// Toma la capa de puntos más cercana que envuelve y, por cada una, monta un
// badge ligado: comparte la Source del host (mismo dato → se mueve en vivo) pero renderiza con su propio
// `iconSet`/`variantOf`/`sizeOf` SIN rotar, y filtra con `where` (sólo los ítems con
// badge). El badge hereda la supresión del host: si un cluster lo envuelve, los badges
// de los puntos clusterizados desaparecen con ellos (lee `host.suppressed`).
//
//   <cristae-cluster>
//     <cristae-overlay>            <!-- iconSet/variantOf/where por ref -->
//       <cristae-point-layer id="fleet"/>
//     </cristae-overlay>
//   </cristae-cluster>
//
// Por fuera del cluster da lo mismo: el cluster no produce puntos propios, se atraviesa y el badge va
// sobre los puntos que re-emite.
export class CristaeOverlay extends CristaeModifierElement {

  // Decorador: un badge por capa de puntos más cercana, ligado a ella.
  static cristaeSignature = { role: 'decorate', consumes: ['point'], produces: ['overlay'] }

  // apply del reductor: un badge por productor alcanzado, ligado a él (`hostId`).
  static cristaeApply(engine, targets, cfg) {
    const out = []
    for (const t of targets) {
      const h = engine.addOverlay({
        id       : `${t.id}:overlay:${++ovlSeq}`,
        hostId   : t.id,
        iconSet  : cfg.iconSet,
        variantOf: cfg.variantOf,
        sizeOf   : cfg.sizeOf,
        where    : cfg.where,
        visible  : cfg.visible,
      })
      if (h) out.push({ kind: 'overlay', id: h.id, handle: h, hostId: t.id, source: t.source, suppressed: null })
    }
    return out
  }

  static properties = {
    iconSet  : { attribute: 'icon-set' },  // IconSet del badge (rotates:false). Objeto por ref o nombre.
    variantOf: { attribute: false },       // (item) => variante del badge (p. ej. estado de conexión)
    sizeOf   : { attribute: false },       // (item) => tamaño del badge
    where    : { attribute: false },       // (item) => boolean: sólo los que tienen badge entran
    visible  : { type: Boolean },
  }

  constructor() {
    super()
    this.visible = true
  }

  // Listo cuando el hijo entidad existe y tiene su config, y el badge tiene su IconSet.
  mountReady() {
    const host = grammarChildren(this, grammar.isRegistered)[0]
    return !!host && host.mountReady() && this.iconSet != null
  }

  mountLayer(engine) {
    this._reduce(engine)

    // El _handle.id es el id del PUNTO que pasa por debajo: así un cluster que envuelva a
    // este overlay clusteriza el punto (y los badges, ligados, heredan su supresión).
    const point = this._units.find(u => u.kind === 'point')
    return { id: point ? point.id : (this.id || makeAutoId('overlay')), units: this._units }
  }

  // Config que lee el `apply` del reductor.
  cristaeConfig() {
    return { iconSet: this.iconSet, variantOf: this.variantOf, sizeOf: this.sizeOf, where: this.where, visible: this.visible }
  }

  syncLayer(changed) {
    if (changed.has('where')) {
      for (const u of this._units ?? []) if (u.kind === 'overlay') u.handle?.setWhere?.(this.where)
    }
    if (changed.has('visible')) {
      for (const u of this._units ?? []) if (u.kind === 'overlay') u.handle?.setVisible?.(this.visible)
    }
  }
}
