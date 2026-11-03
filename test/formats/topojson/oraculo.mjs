// Oráculo diferencial del lector de TopoJSON (DISENO-INTEROP §5-2): un recorredor sobre `JSON.parse`
// que produce las mismas tablas desde la especificación, sin importar nada del lector. Claridad antes
// que velocidad. Donde el contrato no alcanza, se planta con `Error('oraculo: …')`.
//
// No calcula `propAt`/`idAt` (rangos de byte) ni `stats`: se prueban aparte. Tampoco el CRS: devuelve
// las coordenadas de la fuente, que es lo que hay que comparar con un documento geográfico.

const KIND = { Point: 1, MultiPoint: 2, LineString: 3, MultiLineString: 4, Polygon: 5, MultiPolygon: 6 }

const fueraDeContrato = motivo => { throw new Error(`oraculo: ${motivo}`) }

const texto = entrada =>
  (t => (t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t))(
    typeof entrada === 'string' ? entrada : new TextDecoder('utf-8', { ignoreBOM: true }).decode(entrada))

// topojson-specification 1.0 §2.1.2 (§ a verificar): con `transform`, la primera posición de cada
// arco es absoluta y las demás son deltas; después todo se escala y se traslada. Las ordenadas desde la
// tercera no se tocan [inf.: como topojson-client].
const decodificarArcos = (arcs, transform) => arcs.map(arco => {
  if (!transform) return arco.map(p => [...p])
  let x = 0, y = 0
  return arco.map(([dx, dy, ...resto]) => {
    x += dx
    y += dy
    return [x * transform.scale[0] + transform.translate[0], y * transform.scale[1] + transform.translate[1], ...resto]
  })
})

const cuantizar = (p, transform) => transform
  ? [p[0] * transform.scale[0] + transform.translate[0], p[1] * transform.scale[1] + transform.translate[1], ...p.slice(2)]
  : p

export const oraculo = (entrada, { object } = {}) => {
  const doc = JSON.parse(texto(entrada))
  doc?.type === 'Topology' || fueraDeContrato('no es Topology')
  const arcos = decodificarArcos(doc.arcs ?? [], doc.transform)

  const acc = {
    geometryAt: [0], partAt: [0], ringAt: [0], vertexAt: [0], kinds: [], featureOf: [], closed: [],
    posiciones: [], layerOf: [], layers: [],
  }

  // §2.1.4: un índice negativo `~i` recorre el arco `i` al revés; al unir, cada arco salvo el primero
  // pierde su primera posición, que repite la última del anterior.
  const linea = refs => refs.flatMap((r, k) => {
    const a = arcos[r < 0 ? ~r : r] ?? fueraDeContrato(`arco ${r} inexistente`)
    const recorrido = r < 0 ? [...a].reverse() : a
    return k ? recorrido.slice(1) : recorrido
  })

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

  // Tipo → partes y anillos, SPECS §17.1; contenedor vacío, §17.3-14.
  const hoja = (o, f) => {
    const t = o.type
    if (t === 'Point') o.coordinates.length && parte([[cuantizar(o.coordinates, doc.transform)]])
    else if (t === 'MultiPoint') o.coordinates.length && parte([o.coordinates.map(p => cuantizar(p, doc.transform))])
    else if (t === 'LineString') o.arcs.length && parte([linea(o.arcs)])
    else if (t === 'MultiLineString') o.arcs.forEach(l => parte([linea(l)]))
    else if (t === 'Polygon') o.arcs.length && parte(o.arcs.map(linea))
    else if (t === 'MultiPolygon') o.arcs.forEach(p => parte(p.map(linea)))
    else fueraDeContrato(`tipo ${t}`)
    acc.kinds.push(KIND[t])
    acc.featureOf.push(f)
    acc.partAt.push(acc.ringAt.length - 1)
  }

  // Las colecciones se aplanan en profundidad (SPECS §17.1); `type: null` no aporta geometría.
  const geometrias = (o, f) =>
    o.type === null ? undefined
    : o.type === 'GeometryCollection' ? o.geometries.forEach(h => geometrias(h, f))
    : hoja(o, f)

  const feature = (o, capa) => {
    const f = acc.layerOf.length
    acc.layerOf.push(capa)
    geometrias(o, f)
    acc.geometryAt.push(acc.kinds.length)
  }

  // §2.1.5: cada miembro de `objects` es una capa; si es colección, cada hijo es un feature.
  Object.entries(doc.objects ?? {}).forEach(([nombre, o]) => {
    if (object !== undefined && nombre !== object) return
    const capa = acc.layers.push({ name: nombre, parent: -1 }) - 1
    o.type === 'GeometryCollection' ? o.geometries.forEach(h => feature(h, capa)) : feature(o, capa)
  })

  const conZ = acc.posiciones.some(p => p.length >= 3)
  return {
    geometryAt : Uint32Array.from(acc.geometryAt),
    partAt     : Uint32Array.from(acc.partAt),
    ringAt     : Uint32Array.from(acc.ringAt),
    vertexAt   : Uint32Array.from(acc.vertexAt),
    kinds      : Uint8Array.from(acc.kinds),
    featureOf  : Uint32Array.from(acc.featureOf),
    closed     : Uint8Array.from(acc.closed),
    layerOf    : Uint32Array.from(acc.layerOf),
    xy         : Float64Array.from(acc.posiciones.flatMap(p => [p[0], p[1]])),
    z          : conZ ? Float64Array.from(acc.posiciones, p => (p.length >= 3 ? p[2] : NaN)) : null,
    layers     : acc.layers.length ? acc.layers : [{ name: null, parent: -1 }],

    featureCount  : acc.layerOf.length,
    geometryCount : acc.kinds.length,
    partCount     : acc.ringAt.length - 1,
    ringCount     : acc.vertexAt.length - 1,
    vertexCount   : acc.posiciones.length,
  }
}
