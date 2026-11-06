// Oráculo diferencial del lector de EsriJSON (DISENO-INTEROP §5-2): un recorredor sobre `JSON.parse` que
// produce las mismas tablas, con su propia agrupación de anillos (§2.4) escrita desde la regla y sin
// importar nada del lector ni del núcleo. Devuelve las coordenadas de la fuente: el CRS se prueba aparte.
// Donde el contrato no alcanza, se planta con `Error('oraculo: …')`.

const fueraDeContrato = motivo => { throw new Error(`oraculo: ${motivo}`) }

const texto = entrada =>
  (t => (t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t))(
    typeof entrada === 'string' ? entrada : new TextDecoder('utf-8', { ignoreBOM: true }).decode(entrada))

const vacio = v => v === null || v === 'NaN'

// Área firmada con la fórmula del trapecio, cerrando el anillo de forma implícita: positiva si es
// antihorario con el eje y hacia arriba.
const area = anillo => anillo.reduce((s, [x, y], k) => {
  const [xn, yn] = anillo[(k + 1) % anillo.length]
  return s + (x * yn - xn * y)
}, 0) / 2

const caja = anillo => [
  Math.min(...anillo.map(p => p[0])), Math.min(...anillo.map(p => p[1])),
  Math.max(...anillo.map(p => p[0])), Math.max(...anillo.map(p => p[1])),
]

const sobreBorde = ([px, py], anillo) => anillo.some(([ax, ay], k) => {
  const [bx, by] = anillo[(k + 1) % anillo.length]
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax) === 0 &&
    px >= Math.min(ax, bx) && px <= Math.max(ax, bx) && py >= Math.min(ay, by) && py <= Math.max(ay, by)
})

// Par-impar sobre un rayo horizontal.
const adentro = ([px, py], anillo) => anillo.reduce((dentro, [ax, ay], k) => {
  const [bx, by] = anillo[(k + 1) % anillo.length]
  return (ay > py) !== (by > py) && px < (bx - ax) * (py - ay) / (by - ay) + ax ? !dentro : dentro
}, false)

// §2.4: horario = exterior (área ≤ 0, el área 0 también); antihorario = hoyo del exterior más chico que
// lo contiene, por caja y por el primer vértice que no cae sobre el borde. Sin dueño, exterior propio.
// Las partes salen en el orden de los exteriores y, dentro de cada una, los hoyos en orden de archivo.
const agrupar = anillos => {
  const areas = anillos.map(area)
  const cajas = anillos.map(caja)
  const exteriores = anillos.map((_, k) => areas[k] <= 0)

  const duenoDe = h => {
    const [hx0, hy0, hx1, hy1] = cajas[h]
    let mejor = -1
    anillos.forEach((e, k) => {
      if (!exteriores[k] || areas[k] === 0) return
      const [ex0, ey0, ex1, ey1] = cajas[k]
      if (hx0 < ex0 || hy0 < ey0 || hx1 > ex1 || hy1 > ey1) return
      const libre = anillos[h].find(p => !sobreBorde(p, e))
      if (libre !== undefined && !adentro(libre, e)) return
      if (mejor < 0 || Math.abs(areas[k]) < Math.abs(areas[mejor])) mejor = k
    })
    return mejor
  }

  const dueno = anillos.map((_, k) => (exteriores[k] ? -1 : duenoDe(k)))
  return anillos
    .map((anillo, k) => (dueno[k] < 0 ? [anillo, ...anillos.filter((_, h) => dueno[h] === k)] : null))
    .filter(Boolean)
}

export const oraculo = entrada => {
  const doc = JSON.parse(texto(entrada))
  ;(typeof doc === 'object' && doc !== null && !Array.isArray(doc)) || fueraDeContrato('raíz')

  const esGeometria = o => ['x', 'points', 'paths', 'rings', 'xmin', 'curvePaths', 'curveRings'].some(k => k in o)
  const features = 'features' in doc ? doc.features
    : 'geometry' in doc || 'attributes' in doc ? [doc]
    : esGeometria(doc) ? [{ geometry: doc }]
    : fueraDeContrato('raíz sin rol')
  const raiz = { hasZ: doc.hasZ, hasM: doc.hasM }

  const acc = { geometryAt: [0], partAt: [0], ringAt: [0], vertexAt: [0], kinds: [], featureOf: [], closed: [], posiciones: [] }

  const anillo = posiciones => {
    const n = posiciones.length, a = posiciones[0], b = posiciones[n - 1]
    acc.closed.push(n >= 2 && Object.is(a[0], b[0]) && Object.is(a[1], b[1]) && Object.is(a[2], b[2]) ? 1 : 0)
    acc.posiciones.push(...posiciones)
    acc.vertexAt.push(acc.posiciones.length)
  }
  const parte = anillos => {
    anillos.forEach(anillo)
    acc.ringAt.push(acc.vertexAt.length - 1)
  }
  const cerrar = (kind, f) => {
    acc.kinds.push(kind)
    acc.featureOf.push(f)
    acc.partAt.push(acc.ringAt.length - 1)
  }

  const geometria = (g, f) => {
    if (g === null || g === undefined || !esGeometria(g) || 'curvePaths' in g || 'curveRings' in g) return

    // §3.6: con hasM y sin hasZ, la tercera es M; sin banderas, Z.
    const hz = g.hasZ ?? raiz.hasZ, hm = g.hasM ?? raiz.hasM
    const conZ = hz === true || (hz === undefined && hm !== true)
    const posicion = p => (conZ && p.length >= 3 && p[2] !== null ? [p[0], p[1], p[2]] : [p[0], p[1]])

    if ('x' in g) {
      if (vacio(g.x)) return cerrar(1, f)
      parte([[typeof g.z === 'number' ? [g.x, g.y, g.z] : [g.x, g.y]]])
      return cerrar(1, f)
    }
    if ('points' in g) {
      g.points.length && parte([g.points.map(posicion)])
      return cerrar(2, f)
    }
    if ('paths' in g) {
      g.paths.forEach(p => parte([p.map(posicion)]))
      return cerrar(g.paths.length > 1 ? 4 : 3, f)
    }
    const anillos = 'rings' in g ? g.rings.map(r => r.map(posicion))
      : [g.xmin, g.ymin, g.xmax, g.ymax].some(vacio) ? []
      : [[[g.xmin, g.ymin], [g.xmin, g.ymax], [g.xmax, g.ymax], [g.xmax, g.ymin], [g.xmin, g.ymin]]]
    const partes = agrupar(anillos)
    partes.forEach(parte)
    cerrar(partes.length > 1 ? 6 : 5, f)
  }

  features.forEach((feature, f) => {
    geometria(feature.geometry, f)
    acc.geometryAt.push(acc.kinds.length)
  })

  const z = acc.posiciones.some(p => p.length >= 3)
  return {
    geometryAt : Uint32Array.from(acc.geometryAt),
    partAt     : Uint32Array.from(acc.partAt),
    ringAt     : Uint32Array.from(acc.ringAt),
    vertexAt   : Uint32Array.from(acc.vertexAt),
    kinds      : Uint8Array.from(acc.kinds),
    featureOf  : Uint32Array.from(acc.featureOf),
    closed     : Uint8Array.from(acc.closed),
    layerOf    : new Uint32Array(features.length),
    xy         : Float64Array.from(acc.posiciones.flatMap(p => [p[0], p[1]])),
    z          : z ? Float64Array.from(acc.posiciones, p => (p.length >= 3 ? p[2] : NaN)) : null,

    featureCount  : features.length,
    geometryCount : acc.kinds.length,
    partCount     : acc.ringAt.length - 1,
    ringCount     : acc.vertexAt.length - 1,
    vertexCount   : acc.posiciones.length,
  }
}
