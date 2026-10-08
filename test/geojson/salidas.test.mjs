// Las salidas que el corpus deja sin asertar por VALOR: `bounds` (que no tenía ninguna prueba), los
// rangos de byte de `properties`/`id` (que sólo se verificaban por longitud), los contadores de §17.4bis
// y el contrato de `maxDepth`. Todo entra por el enganche, así que sirve para una segunda implementación.
import test from 'node:test'
import assert from 'node:assert/strict'
import { leer } from './lector.mjs'

const enc = new TextEncoder()
const doc = valor => enc.encode(JSON.stringify(valor))

const feature = (geometry, properties = {}, extra = {}) => ({ type: 'Feature', properties, geometry, ...extra })

const CUADRADO = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]

/* ── bounds ─────────────────────────────────────────────────────────────────────────────────── */

const CON_DOS = doc({
  type: 'FeatureCollection',
  features: [
    feature({ type: 'Polygon', coordinates: [CUADRADO] }),
    feature({ type: 'Point', coordinates: [-3.5, 42.25] }),
  ],
})

test('sin la opción, bounds es null', () => {
  assert.equal(leer(CON_DOS).bounds, null)
})

test('bounds trae [minLng, minLat, maxLng, maxLat] por GEOMETRÍA, derivado de los vértices leídos', () => {
  const geo = leer(CON_DOS, { bounds: true })
  assert.equal(geo.bounds.length, geo.geometryCount * 4)
  for (let g = 0; g < geo.geometryCount; g++) {
    const esperado = [Infinity, Infinity, -Infinity, -Infinity]
    for (let p = geo.partAt[g]; p < geo.partAt[g + 1]; p++)
      for (let r = geo.ringAt[p]; r < geo.ringAt[p + 1]; r++)
        for (let i = geo.vertexAt[r]; i < geo.vertexAt[r + 1]; i++) {
          const lng = geo.xy[i * 2], lat = geo.xy[i * 2 + 1]
          esperado[0] = Math.min(esperado[0], lng); esperado[1] = Math.min(esperado[1], lat)
          esperado[2] = Math.max(esperado[2], lng); esperado[3] = Math.max(esperado[3], lat)
        }
    assert.deepEqual([...geo.bounds.subarray(g * 4, g * 4 + 4)], esperado, `geometría ${g}`)
  }
})

test('la caja sale de los vértices, no del miembro `bbox`, que puede mentir', () => {
  const mentiroso = doc({ type: 'Feature', properties: {}, bbox: [-999, -999, 999, 999],
    geometry: { type: 'Polygon', coordinates: [CUADRADO] } })
  assert.deepEqual([...leer(mentiroso, { bounds: true }).bounds], [0, 0, 10, 10])
})

/* ── rangos de byte de properties / id ──────────────────────────────────────────────────────── */

test('propAt e idAt recortan JSON válido, y propertiesOf devuelve lo mismo que JSON.parse', () => {
  const props = { nombre: 'zona "uno"', n: 12.5, anidado: { a: [1, 2, 3] }, nulo: null }
  const bytes = doc({ type: 'FeatureCollection', features: [
    feature({ type: 'Point', coordinates: [1, 2] }, props, { id: 'zona-1' }),
    feature({ type: 'Point', coordinates: [3, 4] }, { otra: true }, { id: 77 }),
  ] })
  const geo = leer(bytes)
  const texto = (a, b) => new TextDecoder().decode(bytes.subarray(a, b))

  assert.deepEqual(geo.propertiesOf(0), props)
  assert.deepEqual(JSON.parse(texto(geo.propAt[0], geo.propAt[1])), props)
  assert.equal(geo.idOf(0), 'zona-1')
  assert.equal(JSON.parse(texto(geo.idAt[0], geo.idAt[1])), 'zona-1')
  assert.deepEqual(geo.propertiesOf(1), { otra: true })
  assert.equal(geo.idOf(1), 77)
})

test('tras release() la geometría sigue y los atributos dejan de servir', () => {
  const geo = leer(doc(feature({ type: 'Point', coordinates: [1, 2] }, { a: 1 })))
  const antes = [...geo.xy]
  geo.release()
  assert.deepEqual([...geo.xy], antes, 'la geometría sobrevive')
  assert.throws(() => geo.propertiesOf(0), e => e.name === 'GeoJsonError' && e.code === 'liberado')
})

/* ── contadores de §17.4bis ─────────────────────────────────────────────────────────────────── */

test('los contadores cuentan lo que el documento traía, sin corregirlo', () => {
  const geo = leer(doc({
    type: 'FeatureCollection',
    ajeno: 1,
    features: [
      feature({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }),  // no cierra
      feature({ type: 'Point', coordinates: [1, 2, 3, 4] }),                          // una ordenada de más
      feature({ type: 'MultiPoint', coordinates: [] }),                               // vacía
    ],
  }))
  assert.equal(geo.stats.openRings, 1, 'el anillo que no repite su primera posición')
  assert.equal(geo.stats.extraOrdinates, 1, 'la posición con cuatro números')
  assert.equal(geo.stats.emptyGeometries, 1)
  assert.ok(geo.stats.foreignMembers >= 1, 'el miembro ajeno de la raíz')
  assert.equal(geo.stats.roots, 1)
  // Y la geometría NO se corrigió: el anillo abierto sigue con sus cuatro vértices.
  assert.equal(geo.vertexAt[1] - geo.vertexAt[0], 4)
})

test('una secuencia RFC 8142 deja roots > 1', () => {
  const uno = JSON.stringify(feature({ type: 'Point', coordinates: [1, 2] }))
  assert.equal(leer(enc.encode(`${uno}\n${uno}\n`)).stats.roots, 2)
})

/* ── formas numéricas que el corpus no tenía ────────────────────────────────────────────────── */

// El literal va crudo: `JSON.stringify` normaliza `-2.5E3` a `-2500` y borraría la forma que se prueba.
test('la notación con exponente se lee, y cuenta como número fuera del camino rápido', () => {
  const geo = leer(enc.encode('{"type":"Point","coordinates":[1.5e-7,-2.5E3]}'))
  assert.equal(geo.xy[0], 1.5e-7)
  assert.equal(geo.xy[1], -2.5e3)
  assert.ok(geo.stats.slowNumbers >= 2)
})

test('el cero negativo se preserva: es un lng/lat legal y no es 0', () => {
  const geo = leer(enc.encode('{"type":"Point","coordinates":[-0.0,-0]}'))
  assert.ok(Object.is(geo.xy[0], -0), 'lng')
  assert.ok(Object.is(geo.xy[1], -0), 'lat')
})

/* ── contrato de maxDepth (§17.2 y §17.10-3) ────────────────────────────────────────────────── */

const PUNTO = doc({ type: 'Point', coordinates: [1, 2] })

test('un maxDepth absurdo sale como GeoJsonError, nunca como excepción cruda', () => {
  for (const valor of [-5, 0, 1.5, NaN, Infinity, 'ocho'])
    assert.throws(() => leer(PUNTO, { maxDepth: valor }),
      e => e.name === 'GeoJsonError' && e.code === 'entrada' && Number.isInteger(e.at),
      `maxDepth: ${valor}`)
})

test('null y undefined caen al default, que lee bien', () => {
  assert.equal(leer(PUNTO, { maxDepth: null }).vertexCount, 1)
  assert.equal(leer(PUNTO, { maxDepth: undefined }).vertexCount, 1)
})

// La cota corta el anidamiento y no reserva memoria por ella: con una alta se lee lo que el documento
// anida, también más hondo de lo que caben las tablas al empezar.
test('una cota alta no reserva memoria por ella, y lo que el documento anida crece hasta la cota', () => {
  const antes = process.memoryUsage().arrayBuffers
  assert.equal(leer(PUNTO, { maxDepth: 1e9 }).vertexCount, 1)
  assert.ok(process.memoryUsage().arrayBuffers - antes < 1 << 20, 'menos de 1 MB por leer un punto')
  const hondo = Array.from({ length: 300 }).reduce(dentro => [dentro], 1)
  const geo   = leer(doc(feature({ type: 'Point', coordinates: [1, 2] }, { hondo })), { maxDepth: 1e9 })
  assert.equal(geo.vertexCount, 1)
  assert.deepEqual(geo.propertiesOf(0), { hondo })
  assert.throws(() => leer(doc(feature({ type: 'Point', coordinates: [1, 2] }, { hondo })), { maxDepth: 200 }),
    e => e.name === 'GeoJsonError' && e.code === 'profundidad')
})

// Pasados los 64 niveles las tablas crecen también donde el lector mira: una geometría tan honda se lee.
test('una geometría a más de 64 niveles se lee, con la cota por defecto y con una alta', () => {
  const punto       = { type: 'Point', coordinates: [1, 2] }
  const ajeno       = { docs: Array.from({ length: 70 }).reduce(dentro => [dentro], feature(punto)) }
  const colecciones = Array.from({ length: 40 }).reduce(g => ({ type: 'GeometryCollection', geometries: [g] }), punto)
  for (const maxDepth of [undefined, 1e9])
    for (const valor of [ajeno, colecciones]) {
      const geo = leer(doc(valor), { maxDepth })
      assert.deepEqual([geo.geometryCount, geo.vertexCount, geo.xy[0], geo.xy[1]], [1, 1, 1, 2], `maxDepth ${maxDepth}`)
    }
})

// `maxDepth` es el anidamiento que se lee: con la cota justa se lee, y un nivel más es 'profundidad'.
test('con la cota justa se lee, y un nivel más es profundidad', () => {
  const niveles = n => doc(feature({ type: 'Point', coordinates: [1, 2] }, { hondo: Array.from({ length: n - 2 }).reduce(d => [d], 1) }))
  for (const maxDepth of [200, 512]) {
    assert.equal(leer(niveles(maxDepth), { maxDepth }).vertexCount, 1, `${maxDepth} niveles`)
    assert.throws(() => leer(niveles(maxDepth + 1), { maxDepth }),
      e => e.name === 'GeoJsonError' && e.code === 'profundidad' && e.at >= 0, `${maxDepth + 1} niveles`)
  }
})

// Las tablas de anidamiento de este lector son Int32Array: el espía ve qué se le pide al runtime. Lo que
// pide no depende de la cota, crece duplicando, y el rechazo del runtime es 'profundidad' (§17.10-3).
test('las tablas de anidamiento no dependen de la cota, crecen duplicando, y su rechazo es profundidad', () => {
  const Original = globalThis.Int32Array
  const pedidos  = []
  let tope       = Infinity
  globalThis.Int32Array = class extends Original {
    constructor(n, ...resto) {
      if (typeof n === 'number') {
        pedidos.push(n)
        if (n > tope) throw new RangeError('Array buffer allocation failed')
      }
      super(n, ...resto)
    }
  }
  try {
    leer(PUNTO)
    const base = Math.max(...pedidos)
    pedidos.length = 0
    leer(PUNTO, { maxDepth: 1e9 })
    assert.equal(Math.max(...pedidos), base, 'la cota alta pide lo mismo que la de siempre')

    pedidos.length = 0
    const hondo = doc(feature({ type: 'Point', coordinates: [1, 2] }, { hondo: Array.from({ length: 20000 }).reduce(d => [d], 1) }))
    assert.equal(leer(hondo, { maxDepth: 1e9 }).vertexCount, 1)
    assert.ok(pedidos.length <= 2 + Math.log2(20000), `${pedidos.length} pedidos para 20 000 niveles`)

    tope = base
    assert.throws(() => leer(hondo, { maxDepth: 1e9 }),
      e => e.name === 'GeoJsonError' && e.code === 'profundidad' && Number.isInteger(e.at) && e.at >= 0)
  } finally {
    globalThis.Int32Array = Original
  }
})

test('pasarse de la cota es GeoJsonError(profundidad), con offset', () => {
  const hondo = enc.encode(`{"type":"Point","coordinates":${'['.repeat(40)}1${']'.repeat(40)}}`)
  assert.throws(() => leer(hondo, { maxDepth: 8 }),
    e => e.name === 'GeoJsonError' && e.code === 'profundidad' && e.at >= 0)
})
