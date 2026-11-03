// Generador de WKB para las pruebas (DISENO-INTEROP §5-2): escribe los bytes con `DataView` desde una
// geometría GeoJSON, y lo esperado sale del oráculo de GeoJSON sobre esa misma geometría. Es
// deliberadamente ingenuo, y se contrasta contra fixtures hex escritas a mano (generador.test.mjs).
//
// Codificación: 06-103r4 §8 (§ a verificar): byte de orden (0 = big endian, 1 = little endian),
// uint32 de tipo, y después el cuerpo. Tipos ISO 1..7 con +1000 Z, +2000 M, +3000 ZM. EWKB de
// PostGIS: banderas 0x80000000 Z, 0x40000000 M y 0x20000000 SRID, con el SRID como uint32 tras el
// tipo.

const TIPO = { Point: 1, LineString: 2, Polygon: 3, MultiPoint: 4, MultiLineString: 5, MultiPolygon: 6, GeometryCollection: 7 }

// opciones:
//   orden : 'le' | 'be' | (profundidad) => 'le' | 'be'   — el orden puede cambiar por nivel
//   dims  : 'xy' | 'xyz' | 'xym' | 'xyzm'
//   sabor : 'iso' | 'ewkb'
//   srid  : número, sólo en la raíz y sólo con sabor 'ewkb'
//   m     : valor de la M que se escribe (se descarta al leer)
export const escribirWkb = (geometria, { orden = 'le', dims = 'xy', sabor = 'iso', srid = 0, m = 7 } = {}) => {
  const trozos = []
  const conZ = dims.includes('z'), conM = dims.includes('m')

  const u32 = (v, le) => {
    const b = new DataView(new ArrayBuffer(4))
    b.setUint32(0, v, le)
    trozos.push(new Uint8Array(b.buffer))
  }
  const f64 = (v, le) => {
    const b = new DataView(new ArrayBuffer(8))
    b.setFloat64(0, v, le)
    trozos.push(new Uint8Array(b.buffer))
  }

  const tipo = (nombre, raiz) => {
    const base = TIPO[nombre]
    if (sabor === 'iso') return base + (conZ && conM ? 3000 : conZ ? 1000 : conM ? 2000 : 0)
    return (base | (conZ ? 0x80000000 : 0) | (conM ? 0x40000000 : 0) | (raiz && srid ? 0x20000000 : 0)) >>> 0
  }

  const posicion = (p, le) => {
    f64(p[0], le)
    f64(p[1], le)
    if (conZ) {
      if (p.length < 3) throw new Error(`generador: dims ${dims} con una posición 2D`)
      f64(p[2], le)
    }
    conM && f64(m, le)
  }

  const geometria1 = (g, profundidad) => {
    const lado = typeof orden === 'function' ? orden(profundidad) : orden
    const le   = lado === 'le'
    trozos.push(Uint8Array.of(le ? 1 : 0))
    u32(tipo(g.type, profundidad === 0), le)
    profundidad === 0 && sabor === 'ewkb' && srid && u32(srid, le)

    const lista = posiciones => {
      u32(posiciones.length, le)
      posiciones.forEach(p => posicion(p, le))
    }
    const hijos = (lista2, nombre) => {
      u32(lista2.length, le)
      lista2.forEach(c => geometria1({ type: nombre, coordinates: c }, profundidad + 1))
    }

    switch (g.type) {
      case 'Point':
        posicion(g.coordinates.length ? g.coordinates : [NaN, NaN, NaN], le)   // vacío: NaN NaN
        break
      case 'LineString':      lista(g.coordinates); break
      case 'Polygon':         u32(g.coordinates.length, le); g.coordinates.forEach(lista); break
      case 'MultiPoint':      hijos(g.coordinates, 'Point'); break
      case 'MultiLineString': hijos(g.coordinates, 'LineString'); break
      case 'MultiPolygon':    hijos(g.coordinates, 'Polygon'); break
      case 'GeometryCollection':
        u32(g.geometries.length, le)
        g.geometries.forEach(c => geometria1(c, profundidad + 1))
        break
      default: throw new Error(`generador: tipo ${g.type}`)
    }
  }

  geometria1(geometria, 0)
  const total = new Uint8Array(trozos.reduce((n, t) => n + t.length, 0))
  let at = 0
  trozos.forEach(t => {
    total.set(t, at)
    at += t.length
  })
  return total
}

export const hex = bytes => Buffer.from(bytes).toString('hex').toUpperCase()

// La misma geometría sin la tercera ordenada: lo que se espera cuando el WKB no lleva Z.
export const en2D = g =>
  g.type === 'GeometryCollection' ? { ...g, geometries: g.geometries.map(en2D) }
  : { ...g, coordinates: plano(g.coordinates) }

const plano = c => typeof c[0] === 'number' ? c.slice(0, 2) : c.map(plano)
