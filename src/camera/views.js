// Vistas de la cámara agnóstica, inyectadas y en float64: la plana con inclinación y rumbo, el globo vertical
// a t = 1 y la ortográfica. Una vista es un objeto con sus portadores preasignados; las funciones de abajo
// la leen y escriben en `out`, sin asignar. Puro: sin Leaflet, DOM ni render/. Los px son CSS, con el
// origen en la esquina superior izquierda del contenedor y la y hacia abajo.
//
// Los tres tipos comparten la escala de Mercator en el centro: a un mismo zoom, un px de pantalla mide lo
// mismo en el centro de cualquiera: la vista plana lo fija con la focal, el globo con el radio de la esfera
// a la latitud del centro, y la ortográfica con ese mismo radio.
import { MAXLAT, WORLD0, projX0, projY0, unprojX0, unprojY0 } from '../projection/mercator.js'
import { sphereAnchor, sphereRelInto } from '../projection/sphere.js'
import { MODEL } from '../geometry/geodesic.js'
import { create, multiply, perspective, fromPose } from './mat4.js'
import { toUnitSphere, fromUnitSphere, enuAt } from './geodesy.js'

export const PLANE = 'plane'
export const GLOBE = 'globe'
export const ORTHO = 'ortho'

// El campo de visión vertical del anfitrión GL plano: el de MapLibre por defecto, atan(3/4) rad (36,87°). La
// distancia focal en px de una vista de alto h es h / 2 / tan(FOV / 2) = 1,5 h.
export const FOV = 0.6435011087932844

// El plano cercano de la perspectiva. No afecta a x, y ni a w —las únicas salidas de estas vistas—, sólo a
// la z de clip, que no se usa; basta con que sea positivo.
const NEAR = 1e-3

// Hasta dónde llega el suelo cuando un rayo no lo toca, en distancias focales desde el ojo. Un rayo sale del
// suelo sólo con pitch + FOV/2 ≥ 90° (con el tope de 60 de MapLibre no pasa); entonces el punto del
// horizonte queda a esta distancia, en el acimut del rayo. Elección propia: 1e4 focales son unos 1,4e7 px
// con una vista de 600 px, el mundo entero de Mercator a zoom 15, más lejos de lo que un horizonte distingue.
export const FAR = 1e4

// El paso con que `metersPerPixelOf` mide un paralelo o un meridiano, en grados. Origen: el mismo que el de
// la faceta de LeafletHost: a 1e-5° (unos 1,1 m) la cuerda contra el arco difiere en menos de 1e-15
// relativo, y la haversine no se cancela a esa distancia.
const STEP = 1e-5

const DEG = Math.PI / 180

const tmp3 = new Float64Array(3)
const tmp2 = new Float64Array(2)

const clampLat = lat => lat > MAXLAT ? MAXLAT : lat < -MAXLAT ? -MAXLAT : lat

// Las tres vistas tienen la misma forma: los mismos campos, en el mismo orden y con el mismo tipo, aunque la
// plana no use la esfera ni el globo el rumbo. `screenOf` las lee desde un solo sitio de llamada, y con formas
// distintas V8 lee cada campo numérico por un camino polimórfico que lo encajona: 16 bytes por lectura.
// El centro y el tamaño van planos en la vista (lat, lng, w, h) por la misma razón.
//
// La esfera unidad tiene el centro sobre `u`, y `enu` trae este, norte y arriba del centro. El radio en px
// es el de Mercator en el centro: world0 por vuelta, entre 2π, entre cos φc.
const makeView = (kind, { center, zoom, size, pitch = 0, bearing = 0 }) => ({
  kind,
  lat     : center.lat,
  lng     : center.lng,
  zoom,
  w       : size.x,
  h       : size.y,
  pitch,
  bearing,
  f       : size.y / 2 / Math.tan(FOV / 2),
  r       : WORLD0 * 2 ** zoom / (2 * Math.PI) / Math.cos(clampLat(center.lat) * DEG),
  scale   : 2 ** zoom,
  cx0     : projX0(center.lng),
  cy0     : projY0(center.lat),
  D       : Infinity,
  cosHorizon: 0,
  eye     : new Float64Array(3),
  axes    : new Float64Array(9),   // los ejes de la cámara en el mundo, por filas de la pose: derecha, arriba y atrás
  m       : create(),              // proyección · pose, para x, y y w
  u       : toUnitSphere(center.lat, center.lng, new Float64Array(3)),
  enu     : enuAt(center.lat, center.lng, new Float64Array(9)),
  q       : new Float64Array(2),   // la entrada de screenOf (lat, lng) o de surfaceOf (x, y)
  rel     : new Float64Array(2),   // el world0 del punto relativo al ancla
  p       : new Float64Array(3),   // el punto proyectado, sobre la esfera
  s       : new Float64Array(3),   // el punto relativo a rtc
  atrig   : sphereAnchor(center.lat, center.lng, new Float64Array(4)),
  sa      : new Float64Array(3),   // esfera(ancla) − rtc
  tmp     : { x: 0, y: 0, occluded: false, depth: 0 },
  hit     : { lat: 0, lng: 0, onSurface: false, incidence: 0, altitude: 0 },
})

export const planeView = args => {
  const view = makeView(PLANE, args)
  const { f, eye, axes } = view
  const sp   = Math.sin(view.pitch * DEG), cp = Math.cos(view.pitch * DEG)
  const sb   = Math.sin(view.bearing * DEG), cb = Math.cos(view.bearing * DEG)
  // Este, norte y arriba, con el centro de la vista en el origen y el ojo a una focal de él.
  eye[0] = -sp * f * sb
  eye[1] = -sp * f * cb
  eye[2] = f * cp
  const pose = fromPose(create(), eye, new Float64Array(3), new Float64Array([sb * cp, cb * cp, sp]))
  const proj = perspective(create(), FOV, view.w / view.h, NEAR, Infinity)
  const rows = [0, 4, 8, 1, 5, 9, 2, 6, 10]
  for (let i = 0; i < 9; i++) axes[i] = pose[rows[i]]
  multiply(view.m, proj, pose)
  return view
}

export const globeView = args => {
  const view = makeView(GLOBE, args)
  const { u, eye } = view
  const dist = (view.f + view.r) / view.r   // el ojo, en radios del centro de la esfera
  view.D          = dist
  view.cosHorizon = 1 / dist
  eye[0] = u[0] * dist
  eye[1] = u[1] * dist
  eye[2] = u[2] * dist
  const pose = fromPose(create(), eye, new Float64Array(3), view.enu.subarray(3, 6))
  const proj = perspective(create(), FOV, view.w / view.h, NEAR, Infinity)
  // El origen rtc es el propio centro: la esfera del ancla menos rtc es cero (`sa`), y la matriz le devuelve
  // rtc a lo relativo. El motor de verdad sube `sa` y `atrig` como uniformes por draw.
  const move = create()
  move[12] = u[0]; move[13] = u[1]; move[14] = u[2]
  multiply(view.m, multiply(create(), proj, pose), move)
  return view
}

export const orthoView = args => makeView(ORTHO, args)

// Las funciones por tipo leen su entrada de `view.q` y no de parámetros: un número que cruza una llamada que V8
// no inlinea se encajona (16 bytes), y estas funciones son demasiado grandes para contar con que se inlineen.
// Sólo `screenOf` y `surfaceOf` reciben números, y son lo bastante cortas para que sí se inlineen.

// ---- screenOf ----

// q = [lat, lng]
const planeScreen = (view, out) => {
  // La fila de x, y y w de `view.m · (X, Y, 0, 1)`, escrita a mano.
  const { m, q } = view
  const X = (projX0(q[1]) - view.cx0) * view.scale
  const Y = (view.cy0 - projY0(q[0])) * view.scale
  const w = m[3] * X + m[7] * Y + m[15]
  out.x        = ((m[0] * X + m[4] * Y + m[12]) / w + 1) * view.w / 2
  out.y        = (1 - (m[1] * X + m[5] * Y + m[13]) / w) * view.h / 2
  out.occluded = false
  out.depth    = w
  return out
}

const globeScreen = (view, out) => {
  const { s, u, m, q, rel } = view
  rel[0] = projX0(q[1]) - view.cx0
  rel[1] = projY0(q[0]) - view.cy0
  sphereRelInto(rel, view.atrig, view.sa, s)
  // El horizonte: el plano de normal u que deja delante los puntos con cos θ > 1/D, sobre s = p − rtc.
  const hidden = u[0] * s[0] + u[1] * s[1] + u[2] * s[2] + 1 - view.cosHorizon <= 0
  const w = m[3] * s[0] + m[7] * s[1] + m[11] * s[2] + m[15]
  out.x        = ((m[0] * s[0] + m[4] * s[1] + m[8] * s[2] + m[12]) / w + 1) * view.w / 2
  out.y        = (1 - (m[1] * s[0] + m[5] * s[1] + m[9] * s[2] + m[13]) / w) * view.h / 2
  out.occluded = hidden
  out.depth    = w
  return out
}

const orthoScreen = (view, out) => {
  const { p, enu, q } = view
  // `toUnitSphere` recibiría lat y lng como números y los encajonaría: la cuenta va en línea.
  const phi = q[0] * DEG, lam = q[1] * DEG
  const cphi = Math.cos(phi)
  p[0] = cphi * Math.sin(lam)
  p[1] = Math.sin(phi)
  p[2] = cphi * Math.cos(lam)
  out.x        = view.w / 2 + view.r * (p[0] * enu[0] + p[1] * enu[1] + p[2] * enu[2])
  out.y        = view.h / 2 - view.r * (p[0] * enu[3] + p[1] * enu[4] + p[2] * enu[5])
  out.occluded = p[0] * enu[6] + p[1] * enu[7] + p[2] * enu[8] <= 0
  out.depth    = 1
  return out
}

// Escribe en `out` el px (x, y) del punto, si lo tapa la propia esfera (`occluded`) y la profundidad `depth`
// (w de clip, en px en la plana y en radios en el globo): con depth ≤ 0 el punto está detrás del ojo, y x e y
// se calculan igual —no dicen nada—; la faceta lo da por no visible. `out` trae x, y, occluded y depth.
// En el globo, el punto pasa por `sphereRel` con el centro como ancla (rel = world0 del punto − world0 del
// centro), el camino del shader. Sobre MAXLAT un punto cae donde su world0, a MAXLAT, que es lo que dibujan las
// capas; la ortográfica no pasa por world0 y no lo acota.
export const screenOf = (view, lat, lng, out) => {
  view.q[0] = lat
  view.q[1] = lng
  return screenAt(view, out)
}

const screenAt = (view, out) =>
  view.kind === PLANE ? planeScreen(view, out) : view.kind === GLOBE ? globeScreen(view, out) : orthoScreen(view, out)

// ---- surfaceOf ----

// q = [x, y]
const planeSurface = (view, out) => {
  const { axes, eye, f, q } = view
  const dxc = (q[0] - view.w / 2) / f
  const dyc = -(q[1] - view.h / 2) / f
  const dx = axes[0] * dxc + axes[3] * dyc - axes[6]
  const dy = axes[1] * dxc + axes[4] * dyc - axes[7]
  const dz = axes[2] * dxc + axes[5] * dyc - axes[8]

  let px, py
  if (dz < 0) {
    const t = -eye[2] / dz
    px = eye[0] + t * dx
    py = eye[1] + t * dy
    out.onSurface = true
    // El coseno entre el rayo y la normal del suelo, que es la vertical.
    out.incidence = -dz / Math.sqrt(dx * dx + dy * dy + dz * dz)
  } else {
    const h = Math.sqrt(dx * dx + dy * dy)
    // Mirar al cenit no tiene acimut: se toma el del rumbo.
    const ux = h ? dx / h : Math.sin(view.bearing * DEG)
    const uy = h ? dy / h : Math.cos(view.bearing * DEG)
    px = eye[0] + FAR * f * ux
    py = eye[1] + FAR * f * uy
    out.onSurface = false
    out.incidence = 0
  }
  out.lng      = unprojX0(view.cx0 + px / view.scale)
  out.lat      = unprojY0(view.cy0 - py / view.scale)
  out.altitude = 0
  return out
}

const globeSurface = (view, out) => {
  const { enu, u, f, p, q } = view
  const dxc = (q[0] - view.w / 2) / f
  const dyc = -(q[1] - view.h / 2) / f
  // La dirección del rayo en el mundo, desde el ojo en D·u.
  const rx = enu[0] * dxc + enu[3] * dyc - enu[6]
  const ry = enu[1] * dxc + enu[4] * dyc - enu[7]
  const rz = enu[2] * dxc + enu[5] * dyc - enu[8]
  // El ojo está fuera de la esfera: el rayo la toca si el discriminante no es negativo y la entrada está
  // delante. Es la cuenta de `raySphere`, en línea para no pasarle seis números a una función fuera de línea.
  const a    = rx * rx + ry * ry + rz * rz
  const b    = view.D * (u[0] * rx + u[1] * ry + u[2] * rz)
  const disc = b * b - a * (view.D * view.D - 1)
  const t    = (-b - Math.sqrt(disc)) / a
  if (disc >= 0 && t >= 0) {
    p[0] = u[0] * view.D + t * rx
    p[1] = u[1] * view.D + t * ry
    p[2] = u[2] * view.D + t * rz
    out.onSurface = true
    // El coseno entre el rayo y la normal de la esfera en el punto, que es el propio punto de la esfera unidad.
    out.incidence = -(p[0] * rx + p[1] * ry + p[2] * rz) / Math.sqrt(a)
  } else {
    // Fuera del disco: el limbo, el círculo de los puntos con cos θ = 1/D, en la dirección de pantalla que va
    // del centro al píxel. A t = 1 el rayo tangente es exacto: cos α = 1/D y sin α = √(1 − 1/D²).
    const h  = Math.sqrt(dxc * dxc + dyc * dyc)
    const ex = h ? dxc / h : 1
    const ey = h ? dyc / h : 0
    const ca = view.cosHorizon
    const sa = Math.sqrt(1 - ca * ca)
    p[0] = u[0] * ca + sa * (enu[0] * ex + enu[3] * ey)
    p[1] = u[1] * ca + sa * (enu[1] * ex + enu[4] * ey)
    p[2] = u[2] * ca + sa * (enu[2] * ex + enu[5] * ey)
    out.onSurface = false
    out.incidence = 0
  }
  fromUnitSphere(p, tmp2)
  out.lat      = tmp2[0]
  out.lng      = tmp2[1]
  out.altitude = 0
  return out
}

const orthoSurface = (view, out) => {
  const { enu, r, p, q } = view
  const dx  = (q[0] - view.w / 2) / r
  const dy  = -(q[1] - view.h / 2) / r
  const rho = Math.sqrt(dx * dx + dy * dy)
  const ex  = rho > 1 ? dx / rho : dx
  const ey  = rho > 1 ? dy / rho : dy
  const ez  = rho > 1 ? 0 : Math.sqrt(1 - rho * rho)
  p[0] = enu[0] * ex + enu[3] * ey + enu[6] * ez
  p[1] = enu[1] * ex + enu[4] * ey + enu[7] * ez
  p[2] = enu[2] * ex + enu[5] * ey + enu[8] * ez
  out.onSurface = rho <= 1
  out.incidence = ez                  // la normal es el punto y el rayo va por −z de la pantalla: su coseno es ez
  fromUnitSphere(p, tmp2)
  out.lat      = tmp2[0]
  out.lng      = tmp2[1]
  out.altitude = 0
  return out
}

// Escribe en `out` el punto de la superficie bajo el px (x, y): lat, lng, onSurface, incidence y altitude = 0.
// `incidence` es el coseno entre el rayo y la normal de la superficie, y vale 0 fuera de ella. Fuera de la
// superficie, onSurface es false y el punto es el más cercano que la vista da: el limbo en el globo y la
// ortográfica, en la dirección radial desde el centro de la pantalla, y en la plana el suelo a `FAR` focales
// en el acimut del rayo. La lng de la plana no se envuelve (sigue a projX0, como Leaflet); la de las esferas
// queda en (-180, 180].
export const surfaceOf = (view, x, y, out) => {
  view.q[0] = x
  view.q[1] = y
  return view.kind === PLANE ? planeSurface(view, out) : view.kind === GLOBE ? globeSurface(view, out) : orthoSurface(view, out)
}

// ---- metersPerPixelOf ----

// Los metros del modelo por cada px world0 de Mercator hacia el este en (lat, lng): Mercator es conforme, así
// que da lo mismo en cualquier dirección. La latitud se acota a ±MAXLAT, que es donde acaba el mundo.
const metersPerWorld0 = (lat, lng, model) => {
  const phi  = clampLat(lat)
  const east = lng + STEP
  // El paso que de verdad se dio: `lng + STEP` se redondea, y la resta es exacta.
  return model[MODEL](phi, lng, phi, east) / ((east - lng) * WORLD0 / 360)
}

// Los metros por radián de arco del modelo en (lat, lng), por un paso al norte; al sur si el norte pasa del polo.
const metersPerRadian = (lat, lng, model) => {
  const other = lat + STEP <= 90 ? lat + STEP : lat - STEP
  return model[MODEL](lat, lng, other, lng) / Math.abs((other - lat) * DEG)
}

// Los metros que mide un px CSS en (lat, lng), por el mejor valor singular del jacobiano suelo → pantalla: el
// de la dirección perpendicular a la mirada, que es la que la inclinación no acorta.
//   plana  : metros por px world0 · depth / (f · 2^zoom), con pitch 0 la escala de Mercator
//   globo  : mR · (D − cos θ) / f, con mR los metros por radián del modelo y θ el ángulo al centro
//   ortog. : mR / r
export const metersPerPixelOf = (view, lat, lng, model) => {
  if (view.kind === PLANE) {
    view.q[0] = lat
    view.q[1] = lng
    planeScreen(view, view.tmp)
    return metersPerWorld0(lat, lng, model) / view.scale * view.tmp.depth / view.f
  }
  const mR = metersPerRadian(lat, lng, model)
  if (view.kind === ORTHO) return mR / view.r
  toUnitSphere(lat, lng, tmp3)
  const cos = view.u[0] * tmp3[0] + view.u[1] * tmp3[1] + view.u[2] * tmp3[2]
  return mR * (view.D - cos) / view.f
}

// ---- boundsOf ----

const SAMPLES = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]]

const wrapLng = lng => lng > 180 ? lng - 360 : lng <= -180 ? lng + 360 : lng

// La caja {south, west, north, east} que envuelve lo que la vista ve. Plana: las esquinas y los puntos medios de
// los bordes de la pantalla sobre el suelo, exacta con pitch 0, con la lng sin envolver. Esferas: el casquete
// del horizonte pasado a caja; si abarca un polo, ese lado es ±90 y la caja da toda la vuelta. Con west > east
// cruza el antimeridiano.
export const boundsOf = (view, out) => {
  if (view.kind === PLANE) {
    out.south = out.west = Infinity
    out.north = out.east = -Infinity
    const hit = view.hit
    for (let i = 0; i < SAMPLES.length; i++) {
      view.q[0] = SAMPLES[i][0] * view.w
      view.q[1] = SAMPLES[i][1] * view.h
      planeSurface(view, hit)
      out.south = Math.min(out.south, hit.lat)
      out.north = Math.max(out.north, hit.lat)
      out.west  = Math.min(out.west, hit.lng)
      out.east  = Math.max(out.east, hit.lng)
    }
    return out
  }

  const alpha = view.kind === GLOBE ? Math.acos(view.cosHorizon) : Math.PI / 2
  const phi   = view.lat * DEG
  out.south = Math.max(-90, (phi - alpha) / DEG)
  out.north = Math.min(90, (phi + alpha) / DEG)
  if (phi + alpha >= Math.PI / 2 || phi - alpha <= -Math.PI / 2) {
    out.west = -180
    out.east = 180
    return out
  }
  const span = Math.asin(Math.sin(alpha) / Math.cos(phi)) / DEG
  out.west = wrapLng(view.lng - span)
  out.east = wrapLng(view.lng + span)
  return out
}
