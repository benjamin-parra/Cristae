// Proyección EPSG:3857 a zoom 0, inlineada (el mapa es EPSG:3857), y su inversa. Hoja: no importa nada,
// para que la geometría y la cámara compartan la fórmula sin arrastrar el render.
// map.project() aloca un Point y, vía toLatLng, un LatLng → por update × miles/seg = el GC
// que se quiere evitar. Esto es lo que hace [0-alloc] real al path incremental (§17.5).
// Mundo 256×256 a zoom 0, centro en (128,128): projX0(0)=128, projY0(0)=128.

const D = Math.PI / 180

export const MAXLAT = 85.0511287798

// El lado del mundo en px a zoom 0: el tile de 256 px de EPSG:3857, un solo tile cubre el mundo.
export const WORLD0 = 256

export const projX0 = lng => WORLD0 * (lng / 360 + 0.5)

// El acotado va con min y max y no con una cascada de `?:`: ésta mezcla las constantes con el argumento en
// una fase tagged que V8 encajona, y asigna 16 bytes por llamada. Da lo mismo, incluido NaN.
export const projY0 = lat => {
  const c = Math.min(Math.max(lat, -MAXLAT), MAXLAT)
  const s = Math.sin(c * D)
  return WORLD0 * (0.5 - 0.25 / Math.PI * Math.log((1 + s) / (1 - s)))
}

// Inversas exactas de projX0/projY0 (world0 px → grados). Mercator inverso: lat = 2·atan(e^y) − 90°,
// con y en radianes de la esfera unidad.
export const unprojX0 = x0 => (x0 / WORLD0 - 0.5) * 360

export const unprojY0 = y0 => {
  const y = (0.5 - y0 / WORLD0) * 2 * Math.PI
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / D
}
