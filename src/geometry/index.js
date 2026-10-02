// Entry de GEOMETRÍA (`cristae/geometry`): funciones puras sobre puntos, paths y zonas en grados. Cero
// DOM, cero Leaflet, cero Lit, sin efectos al importarse: sirve suelto en Node o en un worker.
//
// `toParts` y `sampleAlong` viajan junto a las medidas porque `distance` y `boundsOf` aceptan
// exactamente el path que `toParts` normaliza. Ninguno de estos módulos figura en `sideEffects`:
// re-exportar `ellipsoid` no le carga su librería a quien no lo importa. El pliegue de tramos, el
// lector de puntos, el de cajas, el de zonas, las marcas y los núcleos de cada modelo quedan internos.

export { distance, sphere } from './geodesic.js'
export { area, perimeter, diameter } from './measure.js'
export { boundsOf, boundsPad, boundsContain, boundsCenter } from './bounds.js'
export { ellipsoid, WGS84 } from './ellipsoid.js'
export { toParts, sampleAlong } from './polyline.js'
