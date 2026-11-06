// Escritores ingenuos de `.shp`, `.dbf` y zip para las pruebas: claridad antes que velocidad
// (DISENO-INTEROP §5-2). El `.shp` sale de una FeatureCollection GeoJSON, y lo esperado, del oráculo de
// GeoJSON sobre la misma colección (test/geojson/oraculo.mjs): el escritor no comparte código con el
// lector. Referencia: ESRI Shapefile Technical Description, julio 1998.

// Un buffer que crece, con escritores por tipo. `be` = big-endian: el .shp mezcla los dos órdenes.
export const bloque = () => {
  const bytes = []
  const tmp   = new DataView(new ArrayBuffer(8))
  const poner = n => { for (let k = 0; k < n; k++) bytes.push(tmp.getUint8(k)) }
  const b = {
    u8  : v => { bytes.push(v & 0xFF); return b },
    u16 : v => { tmp.setUint16(0, v, true); poner(2); return b },
    i32 : (v, be = false) => { tmp.setInt32(0, v, !be); poner(4); return b },
    u32 : v => { tmp.setUint32(0, v, true); poner(4); return b },
    f64 : v => { tmp.setFloat64(0, v, true); poner(8); return b },
    raw : u8 => { u8.forEach(x => bytes.push(x)); return b },
    get largo() { return bytes.length },
    fijar32 : (pos, v, be = false) => { tmp.setInt32(0, v, !be); for (let k = 0; k < 4; k++) bytes[pos + k] = tmp.getUint8(k) },
    listo   : () => Uint8Array.from(bytes),
  }
  return b
}

const BASE = { Point: 1, MultiPoint: 8, LineString: 3, MultiLineString: 3, Polygon: 5, MultiPolygon: 5 }

// Anillos (o líneas) de una geometría, en el orden en que el .shp los lista.
const anillosDe = g =>
  g.type === 'LineString' || g.type === 'MultiPoint' ? [g.coordinates]
  : g.type === 'MultiLineString' || g.type === 'Polygon' ? g.coordinates
  : g.type === 'MultiPolygon' ? g.coordinates.flat()
  : [[g.coordinates]]

const caja = (b, puntos, eje) => {
  const v = puntos.map(p => p[eje] ?? 0)
  b.f64(v.length ? Math.min(...v) : 0).f64(v.length ? Math.max(...v) : 0)
}

// Contenido de un registro (sin su cabecera). `m` agrega el bloque opcional de M con la medida = índice.
const contenido = (g, tipo, m) => {
  const b = bloque()
  if (g === null) return b.i32(0).listo()

  const z       = tipo > 10 && tipo < 20
  const anillos = anillosDe(g)
  const puntos  = anillos.flat()
  b.i32(tipo)
  if (BASE[g.type] === 1) {
    b.f64(puntos[0][0]).f64(puntos[0][1])
    z && b.f64(puntos[0][2])
    m && b.f64(0)
    return b.listo()
  }
  const xs = puntos.map(p => p[0]), ys = puntos.map(p => p[1])
  b.f64(Math.min(...xs)).f64(Math.min(...ys)).f64(Math.max(...xs)).f64(Math.max(...ys))
  BASE[g.type] === 8 || b.i32(anillos.length)
  b.i32(puntos.length)
  if (BASE[g.type] !== 8) anillos.reduce((desde, anillo) => (b.i32(desde), desde + anillo.length), 0)
  puntos.forEach(p => b.f64(p[0]).f64(p[1]))
  if (z) {
    caja(b, puntos, 2)
    puntos.forEach(p => b.f64(p[2]))
  }
  if (m) {
    b.f64(0).f64(puntos.length)
    puntos.forEach((_, k) => b.f64(k))
  }
  return b.listo()
}

// `.shp` de una FeatureCollection de un solo tipo (más nulos). `variante`: 0, 10 (Z) o 20 (M).
export const escribirShp = (coleccion, { variante = 0, m = false, tipo } = {}) => {
  const primera = coleccion.features.find(f => f.geometry !== null)?.geometry
  const forma   = tipo ?? (primera ? BASE[primera.type] + variante : 0)
  const cuerpos = coleccion.features.map(f => contenido(f.geometry, forma, m))
  const b       = bloque()
  b.i32(9994, true)
  for (let k = 0; k < 5; k++) b.i32(0)
  b.i32((100 + cuerpos.reduce((s, c) => s + 8 + c.length, 0)) / 2, true)
  b.i32(1000).i32(forma)
  for (let k = 0; k < 8; k++) b.f64(0)
  cuerpos.forEach((c, k) => b.i32(k + 1, true).i32(c.length / 2, true).raw(c))
  return b.listo()
}

// `.dbf`. `campos`: [{ nombre, tipo, largo }]; `filas`: arrays de textos ya en su ancho o más cortos
// (C se rellena a la derecha, lo demás a la izquierda). `codificar` pasa un texto a bytes.
export const latin1 = s => Uint8Array.from(s, c => c.charCodeAt(0) & 0xFF)

export const escribirDbf = (campos, filas, { version = 0x03, ldid = 0, borrados = [], codificar = latin1 } = {}) => {
  const largo = 1 + campos.reduce((s, c) => s + c.largo, 0)
  const b     = bloque()
  b.u8(version).u8(126).u8(11).u8(3).u32(filas.length).u16(32 + 32 * campos.length + 1).u16(largo)
  for (let k = 12; k < 29; k++) b.u8(0)
  b.u8(ldid).u8(0).u8(0)
  campos.forEach(({ nombre, tipo, largo }) => {
    const n = latin1(nombre)
    for (let k = 0; k < 11; k++) b.u8(n[k] ?? 0)
    b.u8(tipo.charCodeAt(0)).u32(0).u8(largo).u8(0)
    for (let k = 0; k < 14; k++) b.u8(0)
  })
  b.u8(0x0D)
  filas.forEach((fila, r) => {
    b.u8(borrados.includes(r) ? 0x2A : 0x20)
    campos.forEach(({ tipo, largo }, c) => {
      const v = codificar(fila[c] ?? '')
      const relleno = Array(Math.max(0, largo - v.length)).fill(0x20)
      b.raw(tipo === 'C' ? [...v, ...relleno].slice(0, largo) : [...relleno, ...v].slice(0, largo))
    })
  })
  b.u8(0x1A)
  return b.listo()
}

// ── zip (PKWARE APPNOTE: encabezado local, directorio central, EOCD) ──────────────────────────────

const TABLA_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

export const crc32 = bytes => (bytes.reduce((c, x) => TABLA_CRC[(c ^ x) & 0xFF] ^ (c >>> 8), 0xFFFFFFFF) ^ 0xFFFFFFFF) >>> 0

const desinflar = async bytes =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())

// `entradas`: [{ nombre, bytes, metodo: 0 | 8 }].
export const escribirZip = async entradas => {
  const b       = bloque()
  const central = []
  for (const { nombre, bytes, metodo = 8 } of entradas) {
    const datos = metodo === 8 ? await desinflar(bytes) : bytes
    const n     = latin1(nombre)
    central.push({ n, metodo, crc: crc32(bytes), packed: datos.length, size: bytes.length, offset: b.largo })
    b.u32(0x04034b50).u16(20).u16(0).u16(metodo).u16(0).u16(0).u32(crc32(bytes))
      .u32(datos.length).u32(bytes.length).u16(n.length).u16(0).raw(n).raw(datos)
  }
  const inicio = b.largo
  central.forEach(({ n, metodo, crc, packed, size, offset }) =>
    b.u32(0x02014b50).u16(20).u16(20).u16(0).u16(metodo).u16(0).u16(0).u32(crc).u32(packed).u32(size)
      .u16(n.length).u16(0).u16(0).u16(0).u16(0).u32(0).u32(offset).raw(n))
  const fin = b.largo
  b.u32(0x06054b50).u16(0).u16(0).u16(central.length).u16(central.length).u32(fin - inicio).u32(inicio).u16(0)
  return b.listo()
}
