// Entry del LECTOR de GeoJSON (`cristae/geojson`). La superficie pública del escáner de coordenadas:
// bytes (o texto) → geometría en arrays tipados, sin construir nunca el grafo de `JSON.parse`, más
// `areasOf` —los anillos y las partes de área del documento (§17.6)—. Cero DOM, cero Leaflet, cero
// Lit — no depende de nada. Lo consume `cristae/map` (RingStore toma el orden [lng, lat] del RFC) y
// sirve suelto para cualquier consumidor headless.
//
// El autómata y su registro de estado quedan INTERNOS; `properties` no se interpreta: el lector
// devuelve rangos de bytes y el consumidor paga el parse de lo que toca (ver docs/geojson.md).

export { readGeoJson, GeoJsonKind, GeoJsonError, areasOf } from './geojson.js'
