// Entry del MAPA (`cristae/map`): motor headless (MapEngine) + web components <cristae-*> de mapa.
// Importar este módulo registra los custom elements de mapa y arrastra Leaflet/glify. La tabla NO
// vive acá — es `cristae/table` (no arrastra Leaflet). El núcleo de datos es `cristae/core`.
// Re-exporta la superficie del núcleo por conveniencia (un consumidor de mapa también crea Sources).

import { grammar } from './element/composite.js'
import { CristaeMap } from './element/CristaeMap.js'
import { CristaePointLayer } from './element/CristaePointLayer.js'
import { CristaePolygonLayer } from './element/CristaePolygonLayer.js'
import { CristaeLabelLayer } from './element/CristaeLabelLayer.js'
import { CristaeCluster } from './element/CristaeCluster.js'
import { CristaeOverlay } from './element/CristaeOverlay.js'
import { CristaeToolbar } from './element/CristaeToolbar.js'
import { CristaePopup } from './element/CristaePopup.js'

// Registrar las firmas de la gramática de composición ANTES de customElements.define:
// así `_enclosingModifier` (base.js) ya sabe qué tags son wrappers cuando el navegador
// dispara el primer connectedCallback al upgradear el DOM existente.
grammar.register('cristae-point-layer', CristaePointLayer.cristaeSignature)
grammar.register('cristae-polygon-layer', CristaePolygonLayer.cristaeSignature)
grammar.register('cristae-label-layer', CristaeLabelLayer.cristaeSignature)
grammar.register('cristae-cluster', CristaeCluster.cristaeSignature)
grammar.register('cristae-overlay', CristaeOverlay.cristaeSignature, { apply: CristaeOverlay.cristaeApply })

const define = (name, ctor) => { if (!customElements.get(name)) customElements.define(name, ctor) }

define('cristae-map', CristaeMap)
define('cristae-point-layer', CristaePointLayer)
define('cristae-polygon-layer', CristaePolygonLayer)
define('cristae-label-layer', CristaeLabelLayer)
define('cristae-cluster', CristaeCluster)
define('cristae-overlay', CristaeOverlay)
define('cristae-toolbar', CristaeToolbar)
define('cristae-popup', CristaePopup)

export { MapEngine } from './engine/MapEngine.js'
export { defineIconSet, defineClusterIconSet, IconSet, prerenderFonts } from './atlas/IconSet.js'
export { defineSource, createSource, makeFilter, makeListener } from './data/index.js'   // núcleo
export { drawLabel } from './render/LabelLayer.js'
export { tilePresets } from './tiles/presets.js'
export { CristaeMap, CristaePointLayer, CristaePolygonLayer, CristaeLabelLayer, CristaeCluster, CristaeOverlay, CristaeToolbar, CristaePopup }
