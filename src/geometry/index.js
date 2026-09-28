// Entry de GEOMETRÍA (`cristae/geometry`): funciones puras sobre puntos y paths en grados. Cero DOM,
// cero Leaflet, cero Lit, sin efectos al importarse: sirve suelto en Node o en un worker.
//
// `toParts` y `sampleAlong` viajan junto a las medidas porque `distance` acepta exactamente el path
// que `toParts` normaliza. Ninguno de estos módulos figura en `sideEffects`: re-exportar `ellipsoid`
// no le carga su librería a quien no lo importa. El pliegue de tramos, el lector de puntos y el
// núcleo de cada modelo quedan internos.

export { distance, sphere } from './geodesic.js'
export { ellipsoid, WGS84 } from './ellipsoid.js'
export { toParts, sampleAlong } from './polyline.js'
