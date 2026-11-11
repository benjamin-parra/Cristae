// Geodesia de la cámara agnóstica: la esfera unidad, ECEF, ENU, horizonte, rayo-esfera y casquete de
// una caja. Puro y en float64, sin Leaflet, DOM ni render/. Cada función escribe en `out` y lo
// devuelve: cero asignaciones por llamada.
//
// Marco de la esfera unidad (el de MapLibre y el del gemelo CPU de la variante `sphere`):
//   x = cos φ · sin λ,  y = sin φ,  z = cos φ · cos λ
// con el eje y hacia el polo norte y (lat 0, lng 0) sobre +z. No es el ECEF: éste, más abajo, es el
// estándar (z hacia el polo) y sólo lo usan terreno y modelos.

const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI
const HALF_PI    = Math.PI / 2

// Elipsoide WGS84: semieje mayor (m) y aplanamiento, NIMA TR8350.2 / EPSG:7030.
export const WGS84_A = 6378137
export const WGS84_F = 1 / 298.257223563
const WGS84_E2       = WGS84_F * (2 - WGS84_F)

// Holgura del radio del casquete contra el redondeo de float64 al medir los ángulos, para que una
// esquina nunca caiga fuera por 1 ulp. Mil veces el épsilon de máquina (2.2e-16), por debajo de 1e-12 rad.
const CAP_PAD = 1e-12

export const toUnitSphere = (lat, lng, out3) => {
  const phi = lat * DEG_TO_RAD, lam = lng * DEG_TO_RAD
  const c   = Math.cos(phi)
  out3[0] = c * Math.sin(lam)
  out3[1] = Math.sin(phi)
  out3[2] = c * Math.cos(lam)
  return out3
}

// Inverso de toUnitSphere para un vector no necesariamente unitario. Usa atan2 y no asin, que pierde cifras
// cerca de los polos, y sqrt y no Math.hypot, que V8 llama fuera de línea y encajona sus argumentos: 48 bytes
// por llamada. lng queda en (-180, 180]; en un polo lng vale 0 por convención. out2 = [lat, lng].
export const fromUnitSphere = (v, out2) => {
  out2[0] = Math.atan2(v[1], Math.sqrt(v[0] * v[0] + v[2] * v[2])) * RAD_TO_DEG
  const lng = Math.atan2(v[0], v[2]) * RAD_TO_DEG
  out2[1] = lng <= -180 ? lng + 360 : lng
  return out2
}

// Este, norte y arriba en (lat, lng), en el marco de la esfera unidad: out9 = [E(3), N(3), U(3)].
// Arriba es el propio punto; E × N = U. En un polo, este queda definido por el límite lng = lng dado.
export const enuAt = (lat, lng, out9) => {
  const phi = lat * DEG_TO_RAD, lam = lng * DEG_TO_RAD
  const sp = Math.sin(phi), cp = Math.cos(phi), sl = Math.sin(lam), cl = Math.cos(lam)
  out9[0] = cl;       out9[1] = 0;   out9[2] = -sl
  out9[3] = -sp * sl; out9[4] = cp;  out9[5] = -sp * cl
  out9[6] = cp * sl;  out9[7] = sp;  out9[8] = cp * cl
  return out9
}

// ECEF de WGS84 en metros, h sobre el elipsoide: x hacia (0, 0), z hacia el polo norte.
export const ecef = (lat, lng, h, out3) => {
  const phi = lat * DEG_TO_RAD, lam = lng * DEG_TO_RAD
  const sp = Math.sin(phi), cp = Math.cos(phi)
  const n  = WGS84_A / Math.sqrt(1 - WGS84_E2 * sp * sp)
  out3[0] = (n + h) * cp * Math.cos(lam)
  out3[1] = (n + h) * cp * Math.sin(lam)
  out3[2] = (n * (1 - WGS84_E2) + h) * sp
  return out3
}

// Coseno del ángulo central al horizonte para un ojo a `distance` radios del centro (> 1): un punto
// de la esfera es visible si su producto punto con la dirección del ojo supera 1/d.
export const horizonCos = distance => 1 / distance

// Menor t ≥ 0 con |o + t·d| = 1, o NaN si el rayo no toca la esfera unidad. `d` no necesita ser unitario.
// Con el origen dentro, es la salida. Un rayo tangente da su único punto.
export const raySphere = (ox, oy, oz, dx, dy, dz) => {
  const a    = dx * dx + dy * dy + dz * dz
  const b    = ox * dx + oy * dy + oz * dz
  const disc = b * b - a * (ox * ox + oy * oy + oz * oz - 1)
  if (disc < 0 || !a) return NaN

  const root = Math.sqrt(disc)
  const t0   = (-b - root) / a
  const t1   = (-b + root) / a
  return t0 >= 0 ? t0 : t1 >= 0 ? t1 : NaN
}

// Ángulo entre dos vectores por atan2 de |a × b| y a · b: exacto también con ángulos pequeños, donde acos pierde cifras.
const angle = (ax, ay, az, bx, by, bz) => {
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx
  return Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), ax * bx + ay * by + az * bz)
}

// Casquete que envuelve una caja {south, west, north, east} en grados: out4 = [x, y, z, radio] con el
// centro unitario y el radio angular en radianes. El centro es el de la caja (lat media, lng media); es
// conservador, no el mínimo. east < west cruza el antimeridiano y east − west ≥ 360 es la caja de 360°.
// La distancia al centro crece con |Δλ| y, sobre un meridiano de la caja, sólo es máxima en un extremo
// o en el punto antípoda de la latitud del centro; con eso, esquinas y ese punto bastan.
export const capOfBox = (box, out4) => {
  const south = Math.max(-90, box.south) * DEG_TO_RAD
  const north = Math.min(90, box.north) * DEG_TO_RAD
  let width = box.east - box.west
  if (width < 0) width += 360
  width = Math.min(width, 360)

  const phiC  = (south + north) / 2
  const lngC  = box.west + width / 2
  const halfW = width / 2 * DEG_TO_RAD

  // Con el centro en lng 0: c = (0, sin φc, cos φc); un punto del meridiano del borde, (φ, Δ).
  const sc = Math.sin(phiC), cc = Math.cos(phiC), sd = Math.sin(halfW), cd = Math.cos(halfW)
  const edge = phi => angle(0, sc, cc, Math.cos(phi) * sd, Math.sin(phi), Math.cos(phi) * cd)

  let radius = Math.max(edge(south), edge(north))
  const phi0 = Math.atan2(sc, cc * cd)
  const far  = phi0 > 0 ? phi0 - Math.PI : phi0 + Math.PI
  if (far > south && far < north && Math.abs(far) <= HALF_PI) radius = Math.max(radius, edge(far))

  toUnitSphere(phiC * RAD_TO_DEG, lngC, out4)
  out4[3] = radius + CAP_PAD
  return out4
}
