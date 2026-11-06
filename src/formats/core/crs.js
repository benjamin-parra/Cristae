// CRS de la fuente e inversa a grados WGS84 `[lng, lat]` (DISENO-INTEROP §2.5). Tres familias: geográfico
// sin desplazamiento de datum, Mercator esférico y transversa de Mercator sobre WGS84 o GRS80. Lo demás es
// `null`, y el lector lo publica como FormatError('crs').

import { FormatError } from './error.js'

const DEG = 180 / Math.PI
const RAD = Math.PI / 180
const A   = 6378137
const WGS = 298.257223563
const GRS = 298.257222101

// Crs = { name, kind: 0 geográfico | 1 mercator esférico | 2 transversa, a, f, k0, lon0, lat0, fe, fn, unit }.
// `unit` pasa la unidad lineal de la fuente a metros; lon0 y lat0 van en grados.
const crsOf = (name, kind, invf = WGS, k0 = 1, lon0 = 0, lat0 = 0, fe = 0, fn = 0, unit = 1) =>
  ({ name, kind, a: A, f: 1 / invf, k0, lon0, lat0, fe, fn, unit })

const encoder  = new TextEncoder()
const MERCATOR = new Set([3857, 900913, 102100, 102113])

// Número EPSG, o los nombres con que lo escriben las fuentes: `EPSG:32719`, `urn:ogc:def:crs:EPSG::4326`,
// `OGC:CRS84`, `ESRI:102100`.
export const crsFromEpsg = code => {
  if (typeof code === 'string') {
    if (/(^|:)CRS84$/i.test(code.trim())) return crsOf('OGC:CRS84', 0)
    const m = /^(?:(?:urn:ogc:def:crs:)?(?:EPSG|ESRI)(?::[\d.]*)?:)?(\d+)$/i.exec(code.trim())
    return m ? crsFromEpsg(Number(m[1])) : null
  }
  if (!Number.isInteger(code)) return null
  if (code === 4326) return crsOf('EPSG:4326', 0)
  if (MERCATOR.has(code)) return crsOf('EPSG:3857', 1)

  const zone = code % 100
  const band = code - zone
  return (band === 32600 || band === 32700) && zone >= 1 && zone <= 60
    ? crsOf(`EPSG:${code}`, 2, WGS, 0.9996, zone * 6 - 183, 0, 500000, band === 32700 ? 10000000 : 0)
    : null
}

// ── WKT1 (OGC 01-009 y el `.prj` de ESRI), lo mínimo ─────────────────────────────────────────────

const isWord  = c => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
const isSpace = c => c === 32 || c === 9 || c === 10 || c === 13

// Árbol de `CLAVE[args]` o `CLAVE(args)`; los args son texto, número o nodo. Cualquier cosa fuera de la
// gramática es `null`: el lector la convierte en 'crs', nunca en una excepción cruda.
const parseWkt = (bytes, from, to) => {
  let i = from
  const skip = () => { while (i < to && isSpace(bytes[i])) i++ }
  const word = () => {
    const k = i
    while (i < to && isWord(bytes[i])) i++
    let s = ''
    for (let j = k; j < i; j++) s += String.fromCharCode(bytes[j])
    return s
  }

  const node = (key, depth) => {
    if (depth > 16) return null
    const close = bytes[i] === 91 ? 93 : 41
    const args  = []
    i++
    for (;;) {
      skip()
      const c = bytes[i]
      if (c === 34) {
        let s = ''
        for (i++; i < to; i++) {
          if (bytes[i] !== 34) s += String.fromCharCode(bytes[i])
          else if (bytes[i + 1] === 34) {
            s += '"'
            i++
          } else break
        }
        if (i >= to) return null
        i++
        args.push(s)
      } else if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
        const k = i
        while (i < to && (isWord(bytes[i]) || bytes[i] === 43 || bytes[i] === 45 || bytes[i] === 46)) i++
        let s = ''
        for (let j = k; j < i; j++) s += String.fromCharCode(bytes[j])
        const v = Number(s)
        if (!Number.isFinite(v)) return null
        args.push(v)
      } else if (isWord(c)) {
        const name = word()
        skip()
        const child = bytes[i] === 91 || bytes[i] === 40 ? node(name.toUpperCase(), depth + 1) : name
        if (child === null) return null
        args.push(child)
      } else return null

      skip()
      if (bytes[i] === close) {
        i++
        return { key, args }
      }
      if (bytes[i] !== 44) return null
      i++
    }
  }

  skip()
  const key = word().toUpperCase()
  skip()
  return key && (bytes[i] === 91 || bytes[i] === 40) ? node(key, 0) : null
}

const child = (n, key) => n?.args.find(a => typeof a === 'object' && a.key === key)
const norm  = s => typeof s === 'string' ? s.toUpperCase().replace(/[^A-Z0-9]/g, '') : ''
const near  = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol

// Datum sin desplazamiento: WGS84, o SIRGAS sobre GRS80 (D-2). Devuelve el inverso del aplanamiento,
// o 0 si el geográfico no es de los soportados.
const geographicInvf = g => {
  const datum = child(g, 'DATUM')
  const sph   = child(datum, 'SPHEROID') ?? child(datum, 'ELLIPSOID')
  const name  = norm(datum?.args[0])
  const wgs   = near(sph?.args[1], A, 1e-3) && near(sph?.args[2], WGS, 1e-8)
  const grs   = near(sph?.args[1], A, 1e-3) && near(sph?.args[2], GRS, 1e-8)
  const shift = child(datum, 'TOWGS84')?.args.some(v => v !== 0)
  const prime = child(g, 'PRIMEM')
  const unit  = child(g, 'UNIT')
  const ok    = (/WGS(19)?84/.test(name) && wgs) ||
    ((name.includes('SIRGAS') || name.includes('SISTEMADEREFERENCIAGEOCENTRICOPARALASAMERICAS')) && (grs || wgs))

  return ok && !shift && (!prime || prime.args[1] === 0) && (!unit || near(unit.args[1], RAD, 1e-12))
    ? sph.args[2]
    : 0
}

const authority = n => (a => a && `${a.args[0]}:${a.args[1]}`)(child(n, 'AUTHORITY'))

const projected = (p, invf) => {
  const proj   = norm(child(p, 'PROJECTION')?.args[0])
  const unit   = child(p, 'UNIT')?.args[1] ?? 1
  const axes   = p.args.filter(a => typeof a === 'object' && a.key === 'AXIS').map(a => norm(a.args[1]))
  const params = new Map(p.args.filter(a => typeof a === 'object' && a.key === 'PARAMETER').map(a => [norm(a.args[0]), a.args[1]]))
  const param  = (key, fallback) => params.get(key) ?? fallback
  const name   = authority(p) ?? p.args[0]
  const fe     = param('FALSEEASTING', 0) * unit
  const fn     = param('FALSENORTHING', 0) * unit
  const lon0   = param('CENTRALMERIDIAN', param('LONGITUDEOFCENTER', 0))
  const sphere = proj === 'MERCATORAUXILIARYSPHERE' || proj === 'POPULARVISUALISATIONPSEUDOMERCATOR' ||
    (proj === 'MERCATOR1SP' && (name === 'EPSG:3857' || name === 'EPSG:900913'))

  // Ejes invertidos o reflejados rompen la orientación de la que depende `reversedRings`.
  if (axes.length && (axes.length !== 2 || axes[0] !== 'EAST' || axes[1] !== 'NORTH')) return null
  if (!(typeof unit === 'number' && unit > 0) || ![fe, fn, lon0].every(Number.isFinite)) return null
  if (proj === 'TRANSVERSEMERCATOR') {
    const k0   = param('SCALEFACTOR', 1)
    // Con lat0 ≠ 0 haría falta el arco de meridiano del origen; UTM y los `.prj` del perfil traen 0 [inf.].
    return k0 > 0 && param('LATITUDEOFORIGIN', 0) === 0 ? crsOf(name, 2, invf, k0, lon0, 0, fe, fn, unit) : null
  }
  return sphere && param('AUXILIARYSPHERETYPE', 0) === 0 ? crsOf(name, 1, WGS, 1, lon0, 0, fe, fn, unit) : null
}

export const crsFromWkt = (bytes, from = 0, to = bytes.length) => {
  const root = parseWkt(bytes, from, to)
  if (root === null) return null
  if (root.key === 'GEOGCS') return geographicInvf(root) ? crsOf(authority(root) ?? root.args[0], 0) : null
  if (root.key !== 'PROJCS') return null

  const invf = geographicInvf(child(root, 'GEOGCS'))
  return invf ? projected(root, invf) : null
}

// `options.crs` (§1.5): código EPSG, su nombre (`'EPSG:32719'`) o WKT1, para la fuente que no declara
// el suyo. Otro tipo es 'entrada'; un CRS que no se soporta, 'crs' con lo pedido en el mensaje.
export const optionCrs = (option, format) => {
  if (option === undefined || option === null) return null
  if (typeof option !== 'number' && typeof option !== 'string') throw new FormatError(format, 'entrada')

  const found = crsFromEpsg(option) ?? (typeof option === 'string' ? crsFromWkt(encoder.encode(option)) : null)
  if (found === null) throw new FormatError(format, 'crs', -1, null, String(option))
  return found
}

// ── Inversas ──────────────────────────────────────────────────────────────────────────────────────

// Coeficientes β de la inversa de Krüger a orden 6 en n (Karney 2011, «Transverse Mercator with an
// accuracy of a few nanometers», ec. 36 da β₁…β₈; acá hasta n⁶. Verificada).
const krugerBeta = n => {
  const n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n
  return [
    n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360 - 81 * n5 / 512 + 96199 * n6 / 604800,
    n2 / 48 + n3 / 15 - 437 * n4 / 1440 + 46 * n5 / 105 - 1118711 * n6 / 3870720,
    17 * n3 / 480 - 37 * n4 / 840 - 209 * n5 / 4480 + 5569 * n6 / 90720,
    4397 * n4 / 161280 - 11 * n5 / 504 - 830251 * n6 / 7257600,
    4583 * n5 / 161280 - 108847 * n6 / 3991680,
    20648693 * n6 / 638668800,
  ]
}

// En sitio sobre los vértices [from, to) de `xy`. Devuelve false si algún resultado sale NaN.
export const toLngLat = (crs, xy, from, to) => {
  if (crs.kind === 0) return true

  const { a, f, k0, lon0, fe, fn, unit } = crs
  if (crs.kind === 1) {
    for (let v = from; v < to; v++) {
      const x = xy[v * 2] * unit - fe, y = xy[v * 2 + 1] * unit - fn
      xy[v * 2]     = lon0 + x / a * DEG
      xy[v * 2 + 1] = (2 * Math.atan(Math.exp(y / a)) - Math.PI / 2) * DEG
      if (Number.isNaN(xy[v * 2]) || Number.isNaN(xy[v * 2 + 1])) return false
    }
    return true
  }

  const n    = f / (2 - f)
  const n2   = n * n
  const rect = a / (1 + n) * (1 + n2 / 4 + n2 * n2 / 64 + n2 * n2 * n2 / 256)
  const e    = Math.sqrt(f * (2 - f))
  const beta = krugerBeta(n)

  for (let v = from; v < to; v++) {
    const xi  = (xy[v * 2 + 1] * unit - fn) / (k0 * rect)
    const eta = (xy[v * 2] * unit - fe) / (k0 * rect)
    let xp = xi, ep = eta
    for (let j = 1; j <= 6; j++) {
      xp -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta)
      ep -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta)
    }
    const chi = Math.asin(Math.sin(xp) / Math.cosh(ep))
    const psi = Math.asinh(Math.tan(chi))
    // Latitud desde la isométrica: punto fijo de φ = 2·atan(exp(ψ + e·atanh(e·sen φ))) − π/2.
    let phi = chi
    for (let k = 0; k < 12; k++) {
      const next = 2 * Math.atan(Math.exp(psi + e * Math.atanh(e * Math.sin(phi)))) - Math.PI / 2
      if (Math.abs(next - phi) < 1e-15) { phi = next; break }
      phi = next
    }
    xy[v * 2]     = lon0 + Math.atan2(Math.sinh(ep), Math.cos(xp)) * DEG
    xy[v * 2 + 1] = phi * DEG
    if (Number.isNaN(xy[v * 2]) || Number.isNaN(xy[v * 2 + 1])) return false
  }
  return true
}

// −1 si todo cabe en ±180 / ±90; si no, el índice del primer vértice que no.
export const isGeographic = (xy, from, to) => {
  for (let v = from; v < to; v++)
    if (!(Math.abs(xy[v * 2]) <= 180 && Math.abs(xy[v * 2 + 1]) <= 90)) return v
  return -1
}
