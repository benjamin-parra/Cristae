// Proyección EPSG:3857 a zoom 0, inlineada (glify ya EXIGE EPSG:3857 — points.ts:100).
// map.project() aloca un Point y, vía toLatLng, un LatLng → por update × miles/seg = el GC
// que se quiere evitar. Esto es lo que hace [0-alloc] real al path incremental (§17.5).
// Mundo 256×256 a zoom 0, centro en (128,128): projX0(0)=128, projY0(0)=128.

const D = Math.PI / 180
const MAXLAT = 85.0511287798

export const projX0 = (lng) => 256 * (lng / 360 + 0.5)

export const projY0 = (lat) => {
  const c = lat > MAXLAT ? MAXLAT : lat < -MAXLAT ? -MAXLAT : lat
  const s = Math.sin(c * D)
  return 256 * (0.5 - 0.25 / Math.PI * Math.log((1 + s) / (1 - s)))
}
