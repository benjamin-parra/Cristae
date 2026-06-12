// Entry del MAPA (`cristae/map`): motor headless (MapEngine) + web components <cristae-*> de mapa.
// Importar este módulo registra los custom elements de mapa y arrastra Leaflet/glify. La tabla NO
// vive acá — es `cristae/table` (no arrastra Leaflet). El núcleo de datos es `cristae/core`.
// Re-exporta la superficie del núcleo por conveniencia (un consumidor de mapa también crea Sources).

import { CristaeMap } from './element/CristaeMap.js'
import { CristaePointLayer } from './element/CristaePointLayer.js'
import { CristaePolygonLayer } from './element/CristaePolygonLayer.js'
import { CristaeLabelLayer } from './element/CristaeLabelLayer.js'
import { CristaeCluster } from './element/CristaeCluster.js'
import { CristaeToolbar } from './element/CristaeToolbar.js'
import { CristaePopup } from './element/CristaePopup.js'

const define = (name, ctor) => { if (!customElements.get(name)) customElements.define(name, ctor) }

define('cristae-map', CristaeMap)
define('cristae-point-layer', CristaePointLayer)
define('cristae-polygon-layer', CristaePolygonLayer)
define('cristae-label-layer', CristaeLabelLayer)
define('cristae-cluster', CristaeCluster)
define('cristae-toolbar', CristaeToolbar)
define('cristae-popup', CristaePopup)

export { MapEngine } from './engine/MapEngine.js'
export { defineIconSet, defineClusterIconSet, IconSet, prerenderFonts } from './atlas/IconSet.js'
export { defineSource, createSource, makeFilter, makeListener } from './data/index.js'   // núcleo
export { drawLabel } from './render/LabelLayer.js'
export { tilePresets } from './tiles/presets.js'
export { CristaeMap, CristaePointLayer, CristaePolygonLayer, CristaeLabelLayer, CristaeCluster, CristaeToolbar, CristaePopup }
