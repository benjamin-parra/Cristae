// Oráculo de WKT (DISENO-INTEROP §5-2): descenso recursivo trivial sobre tokens de expresión regular,
// que traduce el texto a GeoJSON. Las tablas esperadas salen del oráculo de GeoJSON sobre esa
// traducción, así que nada se deriva del lector. Claridad antes que velocidad.
//
// Reglas que traduce, con su fuente: gramática de 06-103r4 §7 (§ a verificar); la M se descarta y sin
// modificador 3 números son Z (DISENO §3.3); `TRIANGLE` es Polygon y `TIN`/`POLYHEDRALSURFACE` son
// MultiPolygon; un contenedor vacío bajo el tope ocupa su ranura (§17.3-14); un punto vacío dentro de
// un MULTIPOINT no aporta posición. Lo que no reconoce lo rechaza con `Error('oraculo: …')`.

const TOKEN = /\s*(?:(SRID=\d+;)|([A-Za-z]+)|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|([(),;]))/y

const tokens = texto => {
  const lista = []
  let p = 0, m
  TOKEN.lastIndex = 0
  while ((m = TOKEN.exec(texto))) {
    p = TOKEN.lastIndex
    lista.push(m[1] ? { srid: Number(m[1].slice(5, -1)) } : m[2] ? { palabra: m[2].toUpperCase() }
      : m[3] ? { numero: Number(m[3]) } : { signo: m[4] })
  }
  const resto = texto.slice(p)
  ;/^\s*$/.test(resto) || error(`resto sin tokenizar: ${resto.slice(0, 20)}`)
  return lista
}

const error = motivo => { throw new Error(`oraculo: ${motivo}`) }

const TIPOS = {
  POINT: 'Point', LINESTRING: 'LineString', POLYGON: 'Polygon', MULTIPOINT: 'MultiPoint',
  MULTILINESTRING: 'MultiLineString', MULTIPOLYGON: 'MultiPolygon', GEOMETRYCOLLECTION: 'GeometryCollection',
  TRIANGLE: 'Polygon', TIN: 'MultiPolygon', POLYHEDRALSURFACE: 'MultiPolygon',
}

export const wktAGeoJson = texto => {
  const t = tokens(texto.replace(/^\uFEFF/, ""))
  let k = 0
  const ver     = () => t[k]
  const tomar   = () => t[k++] ?? error('fin inesperado')
  const signo   = s => tomar().signo === s || error(`se esperaba ${s}`)
  const esSigno = s => ver()?.signo === s
  const vacio   = () => ver()?.palabra === 'EMPTY' && !!++k

  const posicion = mod => {
    const n = []
    while (ver()?.numero !== undefined) n.push(tomar().numero)
    return mod === 'M' ? n.slice(0, 2) : n.slice(0, 3)
  }

  const lista = (nivel, mod) => {
    if (vacio()) return []
    signo('(')
    const items = []
    do items.push(nivel > 1 ? lista(nivel - 1, mod) : posicion(mod))
    while (esSigno(',') && ++k)
    signo(')')
    return items
  }

  const multipunto = mod => {
    if (vacio()) return []
    signo('(')
    const puntos = []
    do {
      if (vacio()) continue
      const paren = esSigno('(') && !!++k
      puntos.push(posicion(mod))
      paren && signo(')')
    } while (esSigno(',') && ++k)
    signo(')')
    return puntos
  }

  const geometria = heredado => {
    let palabra = tomar().palabra ?? error('se esperaba un tipo')
    let mod = heredado
    const pegado = /^(.*?)(ZM|Z|M)$/.exec(palabra)
    if (!TIPOS[palabra] && pegado && TIPOS[pegado[1]]) {
      palabra = pegado[1]
      mod     = pegado[2]
    } else if (['Z', 'M', 'ZM'].includes(ver()?.palabra)) mod = tomar().palabra
    const type = TIPOS[palabra] ?? error(`tipo ${palabra}`)

    if (type === 'GeometryCollection') {
      if (vacio()) return { type, geometries: [] }
      signo('(')
      const geometries = []
      do geometries.push(geometria(mod))
      while (esSigno(',') && ++k)
      signo(')')
      return { type, geometries }
    }
    const nivel = { Point: 1, LineString: 1, Polygon: 2, MultiLineString: 2, MultiPolygon: 3 }[type]
    const coordinates = type === 'MultiPoint' ? multipunto(mod) : lista(nivel, mod)
    return { type, coordinates: type === 'Point' ? coordinates[0] ?? [] : coordinates }
  }

  const geometrias = []
  while (k < t.length) {
    ver().srid !== undefined && k++
    geometrias.push(geometria(null))
    esSigno(';') && k++
  }
  return {
    type     : 'FeatureCollection',
    features : geometrias.map(geometry => ({ type: 'Feature', properties: null, geometry })),
  }
}
