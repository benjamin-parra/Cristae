// Distancias en metros (geometry/geodesic.js, geometry/ellipsoid.js). Las referencias salen de acá: los
// radios escritos a mano, fórmulas distintas de la del módulo y valores publicados del elipsoide WGS84.
// Contrastar contra la misma haversine daría un test que se auto-cumple.
// Corre con: node --test test/geometry/geodesic.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { distance, sphere } from '../../src/geometry/geodesic.js'
import { ellipsoid, WGS84 } from '../../src/geometry/ellipsoid.js'
import { toParts } from '../../src/geometry/polyline.js'
import geographiclib from 'geographiclib-geodesic'

const DESTINATION = Symbol.for('cristae.geometry.destination')
const HEADING     = Symbol.for('cristae.geometry.heading')

const R     = 6371008.8                 // radio medio IUGG R1 (m)
const RAD   = Math.PI / 180
const GRADO = 2 * Math.PI * R / 360     // un grado de arco: 111 195,08 m

const cerca = (real, ref, tol, msg) =>
  assert.ok(Math.abs(real - ref) <= tol * Math.abs(ref), `${msg}: ${real} vs ${ref}`)
const esNaN = (valor, msg) => assert.ok(Number.isNaN(valor), `${msg}: ${valor}`)

// Aproximación equirectangular: a un metro su error es ~1e-14 relativo, y no pasa por ningún seno de
// medio ángulo, así que es independiente de la haversine justo donde la ley de cosenos se rompe.
const equirectangular = (a, b) => R * Math.hypot(
  (b[1] - a[1]) * RAD * Math.cos((a[0] + b[0]) / 2 * RAD),
  (b[0] - a[0]) * RAD,
)

// Vincenty sobre la esfera (forma atan2): bien condicionada a distancias largas y antípodas.
const vincenty = (a, b) => {
  const f1 = a[0] * RAD, f2 = b[0] * RAD, dl = (b[1] - a[1]) * RAD
  const y  = Math.hypot(
    Math.cos(f2) * Math.sin(dl),
    Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl),
  )
  return R * Math.atan2(y, Math.sin(f1) * Math.sin(f2) + Math.cos(f1) * Math.cos(f2) * Math.cos(dl))
}

// Grados, minutos y segundos a grados, con el signo de los grados.
const gms = (g, m, s) => Math.sign(g) * (Math.abs(g) + m / 60 + s / 3600)

// ── la esfera por defecto ─────────────────────────────────────────────────────

test('un grado de longitud sobre el ecuador es 2πR/360 con el radio medio R1', () => {
  cerca(distance([0, 0], [0, 1]), GRADO, 1e-12, 'ecuador')
  assert.equal(distance([0, 0], [0, 1]).toFixed(2), '111195.08')
})

test('un grado de latitud mide lo mismo en cualquier parte: la esfera no achata', () => {
  cerca(distance([0, 0], [1, 0]), GRADO, 1e-12, 'desde el ecuador')
  cerca(distance([45, 10], [46, 10]), GRADO, 1e-12, 'a 45°')
  cerca(distance([-89, -70], [-90, -70]), GRADO, 1e-12, 'al polo')
})

test('antípodas: πR y nunca NaN, también cuando el redondeo saca el término de rango', () => {
  const pares = [
    [[0, 0], [0, 180]],
    [[90, 0], [-90, 0]],
    [[-33.45, -70.66], [33.45, 109.34]],
    // Casi antípodas: con la haversine sin acotar, el término redondea a 1 + 2 ulp y `asin` da NaN.
    [[58.9288, 7.707], [-58.92880000075, -172.29300000079002]],
    [[-58.7298, 42.4383], [58.729799999369995, -137.56170000081]],
  ]
  for (const [a, b] of pares) cerca(distance(a, b), Math.PI * R, 1e-9, `${a} → ${b}`)
})

test('un punto está a 0 m de sí mismo', () => {
  assert.equal(distance([-33.4489, -70.6693], [-33.4489, -70.6693]), 0)
  assert.equal(distance([0, 0], [0, 0]), 0)
})

test('es simétrica', () => {
  const pares = [
    [[-33.4489, -70.6693], [40.4168, -3.7038]],
    [[0, 179.9], [0, -179.9]],
    [[78.22, 15.65], [-54.8, -68.3]],
  ]
  for (const [a, b] of pares) assert.equal(distance(a, b), distance(b, a), `${a} ↔ ${b}`)
})

test('a un metro no pierde dígitos: error relativo < 1e-9 contra la equirectangular', () => {
  const metro = 1 / (R * RAD)             // un metro de arco, en grados
  for (const [lat, lng] of [[-33.4489, -70.6693], [0.5, 0.5], [78.22, 15.65]]) {
    const este = metro / Math.cos(lat * RAD)
    for (const b of [[lat + metro, lng], [lat, lng + este], [lat - metro, lng + este]])
      cerca(distance([lat, lng], b), equirectangular([lat, lng], b), 1e-9, `${lat},${lng} → ${b}`)
  }
})

test('a distancias largas coincide con Vincenty', () => {
  const pares = [
    [[-33.4489, -70.6693], [40.4168, -3.7038]],
    [[78.22, 15.65], [-54.8, -68.3]],
    [[35.68, 139.69], [-33.87, 151.21]],
  ]
  for (const [a, b] of pares) cerca(distance(a, b), vincenty(a, b), 1e-12, `${a} → ${b}`)
})

test('el antimeridiano no da la vuelta al mundo: de 179,9 a -179,9 hay 0,2°', () => {
  cerca(distance([0, 179.9], [0, -179.9]), 0.2 * GRADO, 1e-9, 'ecuador')
  cerca(distance([-60, 179.9], [-60, -179.9]), vincenty([-60, -0.1], [-60, 0.1]), 1e-9, 'a -60°')
  assert.ok(distance([0, 180], [0, -180]) < 1e-6, '180 y -180 son el mismo meridiano')
})

// ── formas de llamada y de punto ──────────────────────────────────────────────

const A = [-33.45, -70.66], B = [-33.46, -70.65], C = [-33.48, -70.66]

test('variádico, path plano y anidado miden lo mismo', () => {
  const recorrido = distance(A, B, C)
  cerca(recorrido, distance(A, B) + distance(B, C), 1e-12, 'variádico = suma de tramos')
  assert.equal(distance([A, B, C]), recorrido, 'path plano')
  assert.equal(distance([[A, B], [B, C]]), recorrido, 'anidado sin hueco entre partes')
  assert.equal(distance(WGS84, [A, B, C]), distance(WGS84, A, B, C), 'con modelo, path = variádico')
  assert.equal(distance(WGS84, [[A, B], [B, C]]), distance(WGS84, A, B, C), 'con modelo, anidado = variádico')
})

test('las cuatro formas de punto, y la vista tipada, dan el mismo resultado', () => {
  const formas = {
    par      : p => p,
    tipado   : p => Float64Array.from(p),
    latLng   : ([lat, lng]) => ({ lat, lng }),
    latLon   : ([lat, lon]) => ({ lat, lon }),
    latitude : ([latitude, longitude]) => ({ latitude, longitude }),
  }
  const esperado = distance(A, B, C)
  for (const [nombre, forma] of Object.entries(formas)) {
    const [a, b, c] = [A, B, C].map(forma)
    assert.equal(distance(a, b, c), esperado, `${nombre} variádico`)
    assert.equal(distance([a, b, c]), esperado, `${nombre} path`)
    assert.equal(distance([[a, b], [b, c]]), esperado, `${nombre} anidado`)
    assert.equal(distance(WGS84, a, b, c), distance(WGS84, A, B, C), `${nombre} con WGS84`)
  }
  assert.equal(distance(A, { lat: B[0], lon: B[1] }, { latitude: C[0], longitude: C[1] }), esperado, 'mezcladas')
})

test('lo que no es un punto no se coacciona: un string, un método, una forma a medias', () => {
  const malos = [
    ['1', '2'], { lat: '0', lng: '1' }, { lat: () => 0, lng: () => 1 }, { lat: 0 }, { latitude: 0, lng: 1 },
    [NaN, 0], [0, Infinity], [null, 0], [0, undefined], [], null, undefined, 5,
  ]
  for (const malo of malos) {
    esNaN(distance(malo, A), `${JSON.stringify(malo)} primero`)
    esNaN(distance(A, malo), `${JSON.stringify(malo)} segundo`)
  }
})

test('un solo argumento que no es punto, ni path, ni nulo es un punto inválido: NaN en cualquier forma', () => {
  const malos = [
    [NaN, 0], Float64Array.of(NaN, 0), { lat: NaN, lng: 0 }, { lat: NaN, lon: 0 }, { latitude: null, longitude: 5 },
    { lat: '1', lng: '2' }, { lat: 95, lng: 0 }, 'abc', 5, true,
  ]
  for (const malo of malos) {
    esNaN(distance(malo), `${JSON.stringify(malo)} solo`)
    esNaN(distance(WGS84, malo), `${JSON.stringify(malo)} solo, con WGS84`)
  }
})

test('lo que no decide el encoding no lo cambia: path y variádico miden lo mismo', () => {
  const objeto = ([lat, lng]) => ({ lat, lng })
  const iterablePunto = ([lat, lng]) => ({ lat, lng, *[Symbol.iterator]() { yield lat; yield lng } })
  const cola = { t: 1 }
  const casos = {
    'un string en la cabeza de un plano'        : ['N/A', A, B, C],
    'un string en un plano de objetos'          : [A, B, '', C].map(p => (typeof p === 'string' ? p : objeto(p))),
    'un anidado perdido en un plano'            : [objeto(A), objeto(B), [A, B], objeto(C)],
    'puntos objeto iterables'                   : [A, B, C].map(iterablePunto),
    'un vértice 0 sin lat ni lng, con una cola' : [[null, null, cola], ...[A, B, C].map(p => [...p, cola])],
  }
  for (const [nombre, path] of Object.entries(casos)) {
    const variadico = distance(...path)
    assert.ok(variadico > 0, `${nombre}: el variádico mide algo`)
    assert.equal(distance(path), variadico, nombre)
  }
  assert.equal(distance(casos['un string en la cabeza de un plano']), distance(A, B, C), 'el string sólo corta la cabeza')
})

test('una latitud fuera de [-90, 90] corta en todos los modelos: el elipsoide no vuelve NaN el track', () => {
  // Una fila con lat y lng cruzadas en medio de un track.
  const track = [[37.77, -122.42], [37.78, -122.42], [-122.43, 37.79], [37.80, -122.43], [37.81, -122.44]]
  for (const [nombre, modelo] of [['esfera', sphere()], ['WGS84', WGS84]]) {
    const partes = distance(modelo, track[0], track[1]) + distance(modelo, track[3], track[4])
    cerca(distance(modelo, track), partes, 1e-12, `${nombre}, path`)
    cerca(distance(modelo, ...track), partes, 1e-12, `${nombre}, variádico`)
    esNaN(distance(modelo, [90.0000001, 0], [0, 0]), `${nombre}, pasado el polo`)
    assert.ok(Number.isFinite(distance(modelo, [90, 0], [-90, 0])), `${nombre}, de polo a polo`)
  }
})

// Una vista tipada es un punto con dos o tres componentes. Más larga es un track intercalado —el `xy` de
// `cristae/geojson`—, que leído como punto mediría 0 en silencio.
test('una vista tipada de más de tres componentes no es un punto: corta, y sola da NaN', () => {
  const conAltura   = Float64Array.of(A[0], A[1], 520)
  const intercalado = Float64Array.of(A[0], A[1], B[0], B[1])
  assert.equal(distance(conAltura, B), distance(A, B), 'la altura se ignora')
  esNaN(distance(intercalado), 'un track intercalado solo')
  esNaN(distance(intercalado, B), 'como punto de un recorrido')
  assert.equal(distance([intercalado, B, C]), distance(B, C), 'en un path, corta')
  assert.deepEqual(toParts([intercalado, B, C]).map(parte => parte.from), [1], 'toParts corta igual')
})

test('el modelo es el primer argumento, reconocido por su marca y no por su clase', () => {
  assert.equal(distance(sphere(), A, B), distance(A, B))
  assert.notEqual(distance(WGS84, A, B), distance(A, B), 'el modelo cambia la medida')
  // Un modelo de otra copia de la librería: el mismo símbolo global, otro objeto.
  const deOtraCopia = { [Symbol.for('cristae.geometry.model')]: () => 42 }
  assert.equal(distance(deOtraCopia, A, B), 42)
  assert.equal(distance(deOtraCopia, [A, B, C]), 84)
})

test('null o undefined primero no son un modelo: son un punto inválido', () => {
  const vacio = []
  esNaN(distance(vacio[0], vacio[1]), 'dos lecturas de un array vacío')
  esNaN(distance(null, A), 'null y un punto')
  esNaN(distance(undefined, A), 'undefined y un punto')
  esNaN(distance(null, [A, B]), 'null y un path: dos argumentos son dos puntos')
  const modelo = null
  assert.equal(distance(modelo ?? sphere(), A, B), distance(A, B), 'el modelo opcional se resuelve antes')
})

test('un modelo fuera del primer lugar, o una fábrica sin llamar, es un error: TypeError', () => {
  assert.throws(() => distance(A, B, WGS84), TypeError, 'el modelo al final')
  assert.throws(() => distance([A, B], WGS84), TypeError, 'el modelo después del path')
  assert.throws(() => distance(WGS84, A, sphere(), B), TypeError, 'un segundo modelo')
  assert.throws(() => distance([A, WGS84, B]), TypeError, 'un modelo dentro del path')
  assert.throws(() => distance(ellipsoid, A, B), TypeError, 'la fábrica sin llamar, primero')
  assert.throws(() => distance(sphere), TypeError, 'sólo la fábrica')
})

// ── la regla de inválidos ─────────────────────────────────────────────────────

test('sin tramo medible: 0 si no hubo datos inválidos, NaN si los hubo', () => {
  for (const nada of [[], null, undefined]) assert.equal(distance(nada), 0, `path sin puntos: ${nada}`)
  assert.equal(distance(), 0, 'sin argumentos')
  assert.equal(distance(WGS84), 0, 'sólo el modelo')
  assert.equal(distance(A), 0, 'un punto')
  assert.equal(distance(WGS84, A), 0, 'un punto con modelo')
  assert.equal(distance([A]), 0, 'un path de un punto')
  assert.equal(distance({ lat: 0, lng: 0 }), 0, 'un punto objeto')
  assert.equal(distance([[A], [B]]), 0, 'partes explícitas de un vértice')
  assert.equal(distance([null, [A]]), 0, 'una parte nula no es un dato inválido')
  assert.equal(distance([[], []]), 0, 'partes vacías')
  assert.equal(distance([[]]), 0, 'una sola parte vacía')
  assert.equal(distance([null, []]), 0, 'una parte nula y una vacía')
  assert.equal(distance(WGS84, [[], []]), 0, 'partes vacías, con modelo')

  esNaN(distance([[null]]), 'una parte con un vértice nulo sí trae un dato inválido')
  esNaN(distance([NaN, NaN]), 'un punto inválido solo')
  esNaN(distance([[NaN, NaN], [null, 1]]), 'un path de puros inválidos')
  esNaN(distance(A, null, B), 'dos puntos que el inválido deja sueltos')
  esNaN(distance([A, [NaN, 0], B]), 'el hueco no se puentea: ningún tramo')
  esNaN(distance([[A], [[NaN, 0]]]), 'anidado con una parte de un vértice y otra inválida')
  esNaN(distance(WGS84, [[NaN, NaN]]), 'con modelo, la misma regla')
})

test('un punto inválido corta: el hueco no suma, igual que las partes de toParts', () => {
  const track = [
    [null, -70.6], [-33.40, -70.60], [-33.41, -70.61], [NaN, NaN],
    [-33.50, -70.70], [-33.51, -70.71], [-33.52, -70.70], [-33.6, Infinity], [-33.7, -70.8],
  ]
  const porPartes = toParts(track).reduce(
    (suma, { path }) => path.reduce((s, p, i) => (i ? s + distance(path[i - 1], p) : s), suma),
    0,
  )
  cerca(distance(track), porPartes, 1e-12, 'track con baches')
  cerca(distance(...track), porPartes, 1e-12, 'los mismos puntos, variádicos')
  assert.ok(distance(track.filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng))) > porPartes,
    'puentear el hueco mediría de más')
})

test('anidado: la suma de las partes, sin el puente entre ellas', () => {
  const a = [[0, 0], [0, 1]], b = [[0, 5], [0, 6], [1, 6]]
  const partes = distance(...a) + distance(...b)
  cerca(distance([a, b]), partes, 1e-12, 'dos partes')
  assert.equal(distance([null, a]), distance(...a), 'una parte nula no suma')
  assert.equal(distance([[], a]), distance(...a), 'una parte vacía en cabeza no lo vuelve plano')
  assert.equal(distance([[null], a]), distance(...a), 'ni una parte [null] en cabeza')
  assert.ok(distance([...a, ...b]) > partes, 'concatenadas en un plano, el tramo entre partes sí suma')
})

test('acepta los mismos iterables que toParts, también como partes del anidado', () => {
  const gen = function* (xs) { yield* xs }
  cerca(distance(gen([[0, 0], [0, 1]])), GRADO, 1e-12, 'generador')
  cerca(distance(new Set([[0, 0], [0, 1]])), GRADO, 1e-12, 'Set')

  const a = [[0, 0], [0, 1], [0, 2]], b = [[0, 5], [0, 6]]
  const enArrays = distance([a, b])
  cerca(enArrays, 3 * GRADO, 1e-12, 'anidado de arrays')
  cerca(distance([a.values(), b.values()]), enArrays, 1e-12, 'partes iterador')
  cerca(distance([gen(a), gen(b)]), enArrays, 1e-12, 'partes generador')
  cerca(distance([new Set(a), new Set(b)]), enArrays, 1e-12, 'partes Set')
  cerca(distance([a, b].map(part => part.map(([lat, lng]) => ({ lat, lng })))), enArrays, 1e-12, 'partes de objetos')
})

// ── los modelos ───────────────────────────────────────────────────────────────

test('sphere() es exactamente el modelo por defecto', () => {
  const pares = [[A, B], [[0, 0], [0, 180]], [[78.22, 15.65], [-54.8, -68.3]], [[-60, 179.9], [-60, -179.9]]]
  for (const [a, b] of pares) {
    assert.equal(distance(sphere(), a, b), distance(a, b), `${a} → ${b}`)
    assert.equal(distance(sphere(R), a, b), distance(a, b), `${a} → ${b}, con el radio explícito`)
  }
})

test('sphere(r) escala en la razón exacta de los radios', () => {
  const ecuatorial = sphere(6378137)
  for (const [a, b] of [[A, B], [[0, 0], [0, 1]], [[78.22, 15.65], [-54.8, -68.3]]])
    cerca(distance(ecuatorial, a, b) / distance(a, b), 6378137 / R, 1e-15, `${a} → ${b}`)
})

test('las fábricas validan al construir: RangeError, no un NaN en medio de un track', () => {
  for (const radio of [0, -1, NaN, Infinity, '6371000', null])
    assert.throws(() => sphere(radio), RangeError, `sphere(${radio})`)
  const malos = [
    [0, 0.003], [-1, 0.003], [NaN, 0.003], [Infinity, 0.003], ['6378137', 0.003],
    [6378137, -0.1], [6378137, 1], [6378137, NaN], [6378137, '0.003'], [6378137, undefined],
  ]
  for (const [a, f] of malos) assert.throws(() => ellipsoid(a, f), RangeError, `ellipsoid(${a}, ${f})`)
  assert.doesNotThrow(() => ellipsoid(6378137, 0), 'achatamiento 0: una esfera por la vía geodésica')
})

test('los modelos son inmutables', () => {
  for (const modelo of [sphere(), sphere(6378137), WGS84, ellipsoid(6378137, 1 / 300)])
    assert.ok(Object.isFrozen(modelo))
})

test('WGS84 es exactamente ellipsoid(6378137, 1 / 298.257223563)', () => {
  const definido = ellipsoid(6378137, 1 / 298.257223563)
  for (const [a, b] of [[A, B], [[0, 0], [90, 0]], [[78.22, 15.65], [-54.8, -68.3]], [[-30, 0], [29.9, 179.8]]])
    assert.equal(distance(WGS84, a, b), distance(definido, a, b), `${a} → ${b}`)
})

// Valores publicados del elipsoide WGS84 (a = 6 378 137 m, f = 1/298,257223563), independientes de la
// librería geodésica que los calcula.
test('WGS84: un grado de longitud sobre el ecuador es a·π/180 = 111 319,4908 m', () => {
  const grado = distance(WGS84, [0, 0], [0, 1])
  assert.equal(grado.toFixed(4), '111319.4908')
  cerca(grado, 6378137 * RAD, 1e-12, 'a·π/180')
})

test('WGS84: el cuadrante meridiano mide 10 001 965,729 m', () => {
  assert.equal(distance(WGS84, [0, 0], [90, 0]).toFixed(3), '10001965.729')
  assert.equal(distance(WGS84, [0, 0], [0, 180]).toFixed(3), '20003931.459',
    'dos cuadrantes: entre antípodas del ecuador la geodésica pasa por el polo')
})

test('WGS84: de Flinders Peak a Buninyong hay 54 972,271 m', () => {
  const flinders  = [gms(-37, 57, 3.72030), gms(144, 25, 29.52440)]
  const buninyong = [gms(-37, 39, 10.15610), gms(143, 55, 35.38390)]
  assert.equal(distance(WGS84, flinders, buninyong).toFixed(3), '54972.271')
})

test('WGS84: un par casi antípoda converge, sin NaN', () => {
  const d = distance(WGS84, [-30, 0], [29.9, 179.8])
  assert.ok(Number.isFinite(d), `${d}`)
  assert.ok(d > 19.9e6 && d <= 20003931.459, `entre 19 900 km y dos cuadrantes: ${d}`)
})

test('la esfera se aparta del elipsoide lo que documenta: hasta 0,56 %', () => {
  let peor = 0
  for (let lat = -89; lat <= 89; lat++)
    for (const [dLat, dLng] of [[1e-3, 0], [0, 1e-3], [7e-4, 7e-4]]) {
      const a = [lat, 10], b = [lat + dLat, 10 + dLng]
      peor = Math.max(peor, Math.abs(distance(a, b) / distance(WGS84, a, b) - 1))
    }
  assert.ok(peor > 0.0055 && peor < 0.0057, `${peor}`)
})

// ── destino y rumbo ───────────────────────────────────────────────────────────

// Los oráculos: la geographiclib con f = 0 es una implementación independiente de la esfera, y con el
// achatamiento de WGS84 es el elipsoide. Un modelo propio no se contrasta contra su propia fórmula.
const { Geodesic, DISTANCE, AZIMUTH, LATITUDE, LONGITUDE, LONG_UNROLL } = geographiclib.Geodesic
const SOLVER   = { sphere: new Geodesic(R, 0), wgs84: new Geodesic(6378137, 0.0033528106647474805) }
const MODELOS  = { sphere: sphere(), wgs84: WGS84 }
const alRumbo  = (modelo, lat, lng, rumbo, metros, out = new Float64Array(2)) =>
  modelo[DESTINATION](lat, lng, rumbo, metros, out)
const desvio   = (solver, p, q) => solver.Inverse(p[0], p[1], q[0], q[1], DISTANCE).s12
const esRumbo  = (real, ref, msg, tol = 1e-7) => {
  const d = Math.abs(real - ref) % 360
  assert.ok(Math.min(d, 360 - d) < tol, `${msg}: ${real} vs ${ref}`)
}
const ORIGENES = [[0, 0], [45, 10], [-60, 179.9], [10, -170], [89.9999, 30], [-89.999, 0], [90, 0], [-90, 179.9]]
const RUMBOS   = [0, 33, 90, 180, 270, -45, 720.5]
const METROS   = [0, 1, 1000, 1e6, 1.5e7, -5e5, -1.5e7]

test('todo modelo de la librería trae las marcas de destino y rumbo', () => {
  for (const modelo of [sphere(), sphere(6378137), WGS84, ellipsoid(6378137, 1 / 300)]) {
    assert.equal(typeof modelo[DESTINATION], 'function')
    assert.equal(typeof modelo[HEADING], 'function')
  }
})

test('destino: la esfera coincide con la geographiclib f = 0 en posición, para todo rumbo y distancia', () => {
  let peor = 0
  for (const [lat, lng] of ORIGENES) for (const rumbo of RUMBOS) for (const metros of METROS) {
    const real = alRumbo(MODELOS.sphere, lat, lng, rumbo, metros)
    const ref  = SOLVER.sphere.Direct(lat, lng, rumbo, metros, LATITUDE | LONGITUDE | LONG_UNROLL)
    peor = Math.max(peor, desvio(SOLVER.sphere, real, [ref.lat2, ref.lon2]))
  }
  assert.ok(peor < 1e-6, `el peor se aparta ${peor} m`)
})

test('destino: la lng sigue a la de partida sin envolverse, hasta media circunferencia', () => {
  for (const [lat, lng] of ORIGENES) for (const rumbo of RUMBOS) for (const metros of METROS)
    for (const modelo of ['sphere', 'wgs84']) {
      const real = alRumbo(MODELOS[modelo], lat, lng, rumbo, metros)
      const ref  = SOLVER[modelo].Direct(lat, lng, rumbo, metros, LATITUDE | LONGITUDE | LONG_UNROLL)
      assert.ok(Math.abs(real[1] - ref.lon2) < 1e-7, `${modelo} ${lat},${lng} ${rumbo} ${metros}: ${real[1]} vs ${ref.lon2}`)
    }
  const este  = alRumbo(MODELOS.sphere, 0, 179.9, 90, 100000)
  const oeste = alRumbo(MODELOS.wgs84, 0, -179.9, 270, 100000)
  cerca(este[1], 179.9 + 100000 / GRADO, 1e-12, 'esfera, hacia el este por el antimeridiano')
  assert.ok(este[1] > 180 && oeste[1] < -180, `sin envolver: ${este[1]}, ${oeste[1]}`)
  cerca(-oeste[1] - 179.9, 100000 / (6378137 * RAD), 1e-9, 'elipsoide, hacia el oeste')
})

test('destino: más allá de media circunferencia el punto es el mismo, a menos de 360° de lng', () => {
  for (const modelo of ['sphere', 'wgs84']) {
    const real = alRumbo(MODELOS[modelo], 10, 20, 90, 3e7)
    const ref  = SOLVER[modelo].Direct(10, 20, 90, 3e7, LATITUDE | LONGITUDE | LONG_UNROLL)
    assert.ok(Math.abs(real[0] - ref.lat2) < 1e-9, `${modelo} lat`)
    esRumbo(real[1], ref.lon2, `${modelo} lng módulo 360`)
  }
})

test('destino: valores de referencia en los ejes y sobre el elipsoide publicado', () => {
  const norte = alRumbo(MODELOS.sphere, 10, 25, 0, 2 * GRADO)
  assert.ok(Math.abs(norte[0] - 12) < 1e-12 && Math.abs(norte[1] - 25) < 1e-12, `a 2° al norte: ${norte}`)
  const ecuador = alRumbo(MODELOS.sphere, 0, 5, 90, 3 * GRADO)
  assert.ok(Math.abs(ecuador[0]) < 1e-12 && Math.abs(ecuador[1] - 8) < 1e-12, `a 3° al este: ${ecuador}`)
  const ecuatorial = alRumbo(sphere(6378137), 0, 0, 0, 6378137 * RAD)
  assert.ok(Math.abs(ecuatorial[0] - 1) < 1e-12, `sphere(r) usa su radio: ${ecuatorial}`)
  // Flinders Peak a Buninyong: 54 972,271 m a 306°52′05,37″ (valores publicados de Vincenty).
  const flinders = [gms(-37, 57, 3.72030), gms(144, 25, 29.52440)]
  const llegada  = alRumbo(WGS84, flinders[0], flinders[1], gms(306, 52, 5.37), 54972.271)
  assert.ok(Math.abs(llegada[0] - gms(-37, 39, 10.15610)) < 3e-8, `lat ${llegada[0]}`)
  assert.ok(Math.abs(llegada[1] - gms(143, 55, 35.38390)) < 3e-8, `lng ${llegada[1]}`)
})

test('destino: un negativo mira al lado opuesto, y cero deja el punto', () => {
  for (const modelo of Object.values(MODELOS)) for (const rumbo of [0, 33, 200]) {
    const atras   = alRumbo(modelo, 20, 30, rumbo, -250000)
    const opuesto = alRumbo(modelo, 20, 30, rumbo + 180, 250000)
    assert.ok(Math.abs(atras[0] - opuesto[0]) < 1e-9 && Math.abs(atras[1] - opuesto[1]) < 1e-9, `${rumbo}`)
    const quieto = alRumbo(modelo, 20, 30, rumbo, 0)
    assert.ok(Math.abs(quieto[0] - 20) < 1e-12 && Math.abs(quieto[1] - 30) < 1e-12, `cero metros: ${quieto}`)
  }
})

test('destino: ida y vuelta con distance y heading, en los dos modelos', () => {
  const origenes = ORIGENES.filter(([lat]) => Math.abs(lat) < 85)
  for (const nombre of ['sphere', 'wgs84']) {
    const modelo = MODELOS[nombre]
    for (const [lat, lng] of origenes) for (const rumbo of [0, 33, 90, 180, 270, 359.5]) for (const metros of [10, 1000, 1e5, 5e6]) {
      const q = alRumbo(modelo, lat, lng, rumbo, metros)
      assert.ok(Math.abs(distance(modelo, [lat, lng], q) - metros) < 1e-6, `${nombre} distance`)
      esRumbo(modelo[HEADING](lat, lng, q[0], q[1]), rumbo, `${nombre} heading ${lat},${lng} ${rumbo} ${metros}`)
    }
  }
})

test('destino: sólo escribe out[0..1] y lo devuelve', () => {
  for (const modelo of Object.values(MODELOS)) {
    const out = Float64Array.of(-1, -1, 7, 8)
    assert.equal(alRumbo(modelo, 10, 20, 45, 5000, out), out)
    assert.deepEqual([out[2], out[3]], [7, 8])
    assert.ok(out[0] > 10 && out[1] > 20, `${out}`)
    const lista = [-1, -1]
    assert.equal(alRumbo(modelo, 10, 20, 45, 5000, lista), lista, 'sirve con un array común')
  }
})

test('destino: junto a un polo la esfera sigue a la geographiclib, también en el polo exacto', () => {
  for (const lat of [90, -90, 89.9999999])
    for (const rumbo of [0, 33, 180, 270]) for (const metros of [1, 1000, 1e6]) {
      const real = alRumbo(MODELOS.sphere, lat, 10, rumbo, metros)
      const ref  = SOLVER.sphere.Direct(lat, 10, rumbo, metros, LATITUDE | LONGITUDE | LONG_UNROLL)
      assert.ok(desvio(SOLVER.sphere, real, [ref.lat2, ref.lon2]) < 1e-6, `${lat} ${rumbo} ${metros}`)
      esRumbo(real[1], ref.lon2, `lng ${lat} ${rumbo} ${metros}`)
    }
})

test('rumbo: coincide con el azimut de la geographiclib, en [0, 360)', () => {
  let pares = 0
  for (const [lat1, lng1] of ORIGENES) for (const [lat2, lng2] of [[0, 0], [45, 10], [-60, 179.9], [10, -170], [3, 4], [-30, 100]]) {
    for (const nombre of ['sphere', 'wgs84']) {
      const real = MODELOS[nombre][HEADING](lat1, lng1, lat2, lng2)
      if (Number.isNaN(real)) continue
      const ref = SOLVER[nombre].Inverse(lat1, lng1, lat2, lng2, DISTANCE | AZIMUTH)
      assert.ok(real >= 0 && real < 360, `${nombre} ${lat1},${lng1} → ${lat2},${lng2}: ${real}`)
      if (ref.s12 > 1e5 && Math.abs(lat1) < 90) esRumbo(real, ref.azi1, `${nombre} ${lat1},${lng1} → ${lat2},${lng2}`)
      pares++
    }
  }
  assert.ok(pares > 60, `${pares}`)
  esRumbo(MODELOS.wgs84[HEADING](gms(-37, 57, 3.72030), gms(144, 25, 29.52440), gms(-37, 39, 10.15610), gms(143, 55, 35.38390)),
    gms(306, 52, 5.37), 'Flinders Peak a Buninyong, publicado a la centésima de segundo', 1.5e-6)
  for (const modelo of Object.values(MODELOS)) {
    assert.equal(modelo[HEADING](0, 0, 10, 0), 0, 'al norte')
    assert.equal(modelo[HEADING](0, 0, 0, 10), 90, 'al este')
    assert.equal(modelo[HEADING](10, 0, 0, 0), 180, 'al sur')
    assert.equal(modelo[HEADING](0, 10, 0, 0), 270, 'al oeste')
  }
})

test('rumbo: un azimut apenas negativo queda en 0 y no en 360, y el norte exacto es 0 y no -0', () => {
  for (const modelo of Object.values(MODELOS)) {
    const h = modelo[HEADING](0, 0, 10, -1e-15)
    assert.ok(h >= 0 && h < 360, `${h}`)
    assert.equal(modelo[HEADING](0, 0, 10, -0), 0, 'al norte con la lng en -0')
    assert.equal(modelo[HEADING](10, 50, 90, 20), 0, 'al polo norte')
  }
})

test('rumbo: NaN si los puntos coinciden, también con la lng corrida una vuelta o en un polo', () => {
  for (const modelo of Object.values(MODELOS)) {
    esNaN(modelo[HEADING](10, 20, 10, 20), 'el mismo punto')
    esNaN(modelo[HEADING](10, 20, 10, 380), 'una vuelta de más')
    esNaN(modelo[HEADING](-45, 180, -45, -180), 'el antimeridiano por los dos lados')
    esNaN(modelo[HEADING](90, 20, 90, 50), 'el polo norte con otra lng')
    esNaN(modelo[HEADING](-90, 20, -90, -70), 'el polo sur con otra lng')
    assert.ok(!Number.isNaN(modelo[HEADING](10, 20, 10.000001, 20)), 'a 11 cm no coincide')
  }
})
