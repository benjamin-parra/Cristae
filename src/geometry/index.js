// Entry de GEOMETRÍA (`cristae/geometry`): funciones puras sobre puntos, paths y zonas en grados, y la
// carga de un terreno, lo único asíncrono, que pide sus tiles por el `fetch` que se le pase. Cero DOM,
// cero Leaflet, cero Lit, sin efectos al importarse: sirve suelto en Node o en un worker.
//
// `toParts` y `sampleAlong` viajan junto a las medidas porque `distance` y `boundsOf` aceptan
// exactamente el path que `toParts` normaliza. Ninguno de estos módulos figura en `sideEffects`:
// re-exportar `ellipsoid` no le carga su librería a quien no lo importa, ni re-exportar `terrain` su
// cargador. El pliegue de tramos, el lector de puntos, el de cajas, el de zonas, el decodificador de
// tiles, las marcas y los núcleos de cada modelo quedan internos.

export { distance, sphere } from './geodesic.js'
export { area, perimeter, diameter } from './measure.js'
export { terrain, terrainPresets, relief } from './terrain.js'
export { boundsOf, boundsPad, boundsContain, boundsCenter } from './bounds.js'
export { ellipsoid, WGS84 } from './ellipsoid.js'
export { toParts, sampleAlong } from './polyline.js'
