// Escritor ingenuo de FlatGeobuf para las pruebas: claridad antes que velocidad (DISENO-INTEROP §5-2).
// Escribe desde una FeatureCollection GeoJSON; lo esperado sale del oráculo de GeoJSON sobre la misma
// colección. Referencia: esquemas `header.fbs` y `feature.fbs` [inf.: de memoria, D-11].
//
// FlatBuffers hacia adelante: cada objeto se escribe DESPUÉS de quien lo referencia, porque `uoffset`
// no tiene signo. La vtable va justo antes de su tabla (`soffset` sí lo tiene). Sin alineación: el
// formato la recomienda y el lector no la necesita.

const TAM = { u8: 1, i8: 1, u16: 2, i16: 2, i32: 4, u32: 4, f32: 4, u64: 8, i64: 8, f64: 8 }
const SET = {
  u8: 'setUint8', i8: 'setInt8', u16: 'setUint16', i16: 'setInt16', i32: 'setInt32', u32: 'setUint32',
  f32: 'setFloat32', u64: 'setBigUint64', i64: 'setBigInt64', f64: 'setFloat64',
}

export const tabla   = campos => ({ clase: 'tabla', campos })     // campos[i]: undefined, escalar o ref
export const escalar = (tipo, v) => ({ tipo, v })
export const ref     = objeto => ({ ref: objeto })
export const vector  = (tipo, valores) => ({ clase: 'vector', tipo, valores })
export const tablas  = lista => ({ clase: 'tablas', lista })
export const texto   = s => vector('u8', [...new TextEncoder().encode(s)])

// Un buffer con su offset de raíz. Una misma tabla referida dos veces se escribe una sola vez: es lo
// que permite armar la amplificación de §1.6-3.
export const serializar = raiz => {
  const b      = []
  const tmp    = new DataView(new ArrayBuffer(8))
  const vistas = new Map()
  const poner  = (tipo, v, pos = b.length) => {
    tmp[SET[tipo]](0, v, true)
    for (let k = 0; k < TAM[tipo]; k++) b[pos + k] = tmp.getUint8(k)
  }

  const escribir = obj => {
    if (vistas.has(obj)) return vistas.get(obj)
    const pos = b.length
    if (obj.clase === 'vector') {
      poner('u32', obj.valores.length)
      obj.valores.forEach(v => poner(obj.tipo, v))
      return pos
    }
    if (obj.clase === 'tablas') {
      poner('u32', obj.lista.length)
      const huecos = obj.lista.map(() => (poner('u32', 0), b.length - 4))
      obj.lista.forEach((hijo, k) => poner('u32', escribir(hijo) - huecos[k], huecos[k]))
      return pos
    }
    let tam = 4
    // Array.from y no map: los campos ausentes son huecos del array y map los saltaría.
    const offs = Array.from(obj.campos, c => c ? (tam += c.ref ? 4 : TAM[c.tipo]) - (c.ref ? 4 : TAM[c.tipo]) : 0)
    poner('u16', 4 + 2 * obj.campos.length)
    poner('u16', tam)
    offs.forEach(o => poner('u16', o))
    const t = b.length
    vistas.set(obj, t)
    poner('i32', t - pos)
    const refs = []
    obj.campos.forEach(c => c && (c.ref ? (refs.push([b.length, c.ref]), poner('u32', 0)) : poner(c.tipo, c.v)))
    refs.forEach(([hueco, hijo]) => poner('u32', escribir(hijo) - hueco, hueco))
    return t
  }

  poner('u32', 0)
  poner('u32', escribir(raiz), 0)
  return Uint8Array.from(b)
}

export const TIPO = { Point: 1, LineString: 2, Polygon: 3, MultiPoint: 4, MultiLineString: 5, MultiPolygon: 6, GeometryCollection: 7 }

// Tabla `Geometry` (feature.fbs): ends 0, xy 1, z 2, m 3, type 6, parts 7. `conTipo` escribe `type`:
// hace falta con la cabecera en Unknown y en las partes de una colección.
export const geometria = (g, conTipo, { m = false } = {}) => {
  const campos = []
  conTipo && (campos[6] = escalar('u8', TIPO[g.type]))
  if (g.type === 'GeometryCollection') {
    campos[7] = ref(tablas(g.geometries.map(h => geometria(h, true, { m }))))
    return tabla(campos)
  }
  if (g.type === 'MultiPolygon') {
    campos[7] = ref(tablas(g.coordinates.map(p => geometria({ type: 'Polygon', coordinates: p }, false, { m }))))
    return tabla(campos)
  }
  const anillos = g.type === 'Point' ? [[g.coordinates]]
    : g.type === 'Polygon' || g.type === 'MultiLineString' ? g.coordinates
    : [g.coordinates]
  const pos = anillos.flat()
  pos.length && (campos[1] = ref(vector('f64', pos.flatMap(p => [p[0], p[1]]))))
  pos.length && pos.every(p => p.length > 2) && (campos[2] = ref(vector('f64', pos.map(p => p[2]))))
  m && pos.length && (campos[3] = ref(vector('f64', pos.map((_, k) => k))))
  anillos.length > 1 && (campos[0] = ref(vector('u32', anillos.map((_, k) => anillos.slice(0, k + 1).flat().length))))
  return tabla(campos)
}

// ColumnType: Byte, UByte, Bool, Short, UShort, Int, UInt, Long, ULong, Float, Double, String, Json,
// DateTime, Binary.
const VALOR = ['i8', 'u8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'f32', 'f64']

export const propiedades = (props, columnas) => {
  const bytes = []
  const tmp   = new DataView(new ArrayBuffer(8))
  const poner = (tipo, v) => {
    tmp[SET[tipo]](0, v, true)
    for (let k = 0; k < TAM[tipo]; k++) bytes.push(tmp.getUint8(k))
  }
  columnas.forEach(({ nombre, tipo }, k) => {
    const v = props?.[nombre]
    if (v === undefined) return
    poner('u16', k)
    if (tipo < 11) return poner(VALOR[tipo], tipo === 2 ? Number(v) : tipo === 7 || tipo === 8 ? BigInt(v) : v)
    const crudo = tipo === 14 ? v : new TextEncoder().encode(v)
    poner('u32', crudo.length)
    crudo.forEach(x => bytes.push(x))
  })
  return bytes
}

// Nodos del árbol empaquetado para `n` hojas (el bucle de `calcTreeSize` de la referencia [inf.]).
export const nodosDelIndice = (n, nodo) => {
  let k = n, total = n
  do total += k = Math.ceil(k / nodo)
  while (k !== 1)
  return total
}

// `opciones`: tipo de cabecera (default: el de la primera geometría; 0 = Unknown), columnas
// [{ nombre, tipo }], `nodo` (index_node_size; undefined = sin escribir, que vale 16), `conteo`
// (escribir features_count), `crs` (campos de la tabla Crs), `version` mayor, `m`, `z` (has_z).
export const escribirFgb = (coleccion, opciones = {}) => {
  const primera = coleccion.features.find(f => f.geometry)?.geometry
  const {
    tipo = primera ? TIPO[primera.type] : 0, columnas = [], nodo, conteo = true, crs = null, version = 3,
    m = false, z = false,
  } = opciones
  const n = coleccion.features.length

  const cabecera = []
  cabecera[2] = escalar('u8', tipo)
  z && (cabecera[3] = escalar('u8', 1))
  columnas.length && (cabecera[7] = ref(tablas(columnas.map(c => tabla([ref(texto(c.nombre)), escalar('u8', c.tipo)])))))
  conteo && (cabecera[8] = escalar('u64', BigInt(n)))
  nodo === undefined || (cabecera[9] = escalar('u16', nodo))
  if (crs) {
    const c = []
    crs.org === undefined || (c[0] = ref(texto(crs.org)))
    crs.code === undefined || (c[1] = escalar('i32', crs.code))
    crs.wkt === undefined || (c[4] = ref(texto(crs.wkt)))
    crs.codeString === undefined || (c[5] = ref(texto(crs.codeString)))
    cabecera[10] = ref(tabla(c))
  }

  const partes = [[0x66, 0x67, 0x62, version, 0x66, 0x67, 0x62, 0x01]]
  const largo  = bytes => [...new Uint8Array(new Uint32Array([bytes.length]).buffer), ...bytes]
  partes.push(largo(serializar(tabla(cabecera))))
  const conIndice = conteo && n > 0 && (nodo ?? 16) > 1
  conIndice && partes.push(new Uint8Array(nodosDelIndice(n, nodo ?? 16) * 40))
  coleccion.features.forEach(f => {
    const campos = []
    f.geometry && (campos[0] = ref(geometria(f.geometry, tipo === 0 || tipo === 7, { m })))
    const props = propiedades(f.properties, columnas)
    props.length && (campos[1] = ref(vector('u8', props)))
    partes.push(largo(serializar(tabla(campos))))
  })
  return Uint8Array.from(partes.flatMap(p => [...p]))
}
