// GOLDEN de la superficie pública: los entry points que NO arrastran DOM ni Leaflet
// (`src/index.js` queda afuera a propósito) + el mapa `exports`/`sideEffects` del package.json,
// que es lo primero que mueve el eje de desfragmentación.
//
// Las listas están escritas A MANO. Derivarlas del propio módulo daría un test que se
// auto-cumple: sólo sirve si agregar, quitar o renombrar un export hace ruido acá.
// Corre con: node --test test/entry-surface.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const raiz = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url))
const pkg = JSON.parse(readFileSync(raiz('package.json'), 'utf8'))

// ── Orden de carga: `core`, `grammar`, `geojson` y `geometry` PRIMERO y sin ningún stub. Si
//    alguno tocara customElements o Leaflet al importarse (no deben: no figuran en `sideEffects`)
//    reventaría acá.
const core = await import('../src/data/index.js')
const grammar = await import('../src/grammar/index.js')
const geojson = await import('../src/geojson/index.js')
const geometry = await import('../src/geometry/index.js')

// Módulos que DEFINEN cada export re-exportado por los entries de arriba. El golden de
// nombres no distingue una función de otra (todas son `function`): la identidad contra el
// módulo fuente es lo único que detecta un intercambio de exports o un stub homónimo.
const gGrammar = await import('../src/grammar/grammar.js')
const gValidate = await import('../src/grammar/validate.js')
const gReduce = await import('../src/grammar/reduce.js')
const gMounting = await import('../src/grammar/mounting.js')
const gUtil = await import('../src/grammar/util.js')
const dSource = await import('../src/data/Source.js')
const dFilters = await import('../src/data/filters.js')
const jLector = await import('../src/geojson/geojson.js')
const gGeodesic = await import('../src/geometry/geodesic.js')
const gEllipsoid = await import('../src/geometry/ellipsoid.js')
const gPolyline = await import('../src/geometry/polyline.js')
const gBounds = await import('../src/geometry/bounds.js')
const gMeasure = await import('../src/geometry/measure.js')
const gShape = await import('../src/geometry/shape.js')
const gCurve = await import('../src/geometry/curve.js')
const gTerrain = await import('../src/geometry/terrain.js')

// `table/` SÍ registra el custom element al importarse: se stubea el registry para observar
// la definición sin DOM. El stub va después de los imports de arriba, a propósito.
const registry = { gets: [], defines: [] }
globalThis.customElements = {
  get: (tag) => { registry.gets.push(tag); return undefined },
  define: (tag, ctor) => { registry.defines.push([tag, ctor]) },
}
const table = await import('../src/table/index.js')

// Módulos fuente del trío propio de `table` (ya cargados por el import de arriba: son cache hits,
// no re-ejecutan el registro del custom element).
const tTable = await import('../src/table/CristaeTable.js')
const tPaged = await import('../src/table/PagedTable.js')
const tPagination = await import('../src/table/pagination.js')

// ── Golden literales (a mano, no derivados) ──
const CORE = {
  createSource: 'function',
  defineSource: 'function',
  makeFilter: 'function',
  makeListener: 'function',
}
const GRAMMAR = {
  GrammarError: 'function',
  buildUnit: 'function',
  defineGrammar: 'function',
  enclosingModifier: 'function',
  grammarChildren: 'function',
  leafUnits: 'function',
  reduceModifier: 'function',
  tagName: 'function',
  validate: 'function',
  validateSignature: 'function',
}
const TABLE = {
  CristaeTable: 'function',
  PagedTable: 'function',
  createSource: 'function',
  defineSource: 'function',
  makeFilter: 'function',
  makeListener: 'function',
  paginationModel: 'function',
}

// Nombres + typeof de cada export, en orden estable.
const firma = (mod) => Object.fromEntries(Object.keys(mod).sort().map(k => [k, typeof mod[k]]))

test('cristae/core expone exactamente las 4 factories del núcleo', () => {
  assert.deepEqual(Object.keys(core).sort(), Object.keys(CORE))
  assert.deepEqual(firma(core), CORE)
})

test('cristae/core no filtra los internos Store ni Emitter', () => {
  // Documentado en data.md: los posee createSource, no son superficie pública.
  assert.equal('Store' in core, false)
  assert.equal('Emitter' in core, false)
})

test('cristae/grammar expone exactamente las 10 piezas del segmento', () => {
  assert.deepEqual(Object.keys(grammar).sort(), Object.keys(GRAMMAR).sort())
  assert.deepEqual(firma(grammar), GRAMMAR)
})

// El `typeof` de los goldenes de arriba no puede fallar (todo export del segmento es una
// función): lo único que congelan es la LISTA de nombres. La correspondencia nombre → función
// se congela acá, contra el módulo que la define — un `export { validate as validateSignature }`
// cruzado, o un `tagName` reemplazado por un stub, pasan el golden y mueren en estos dos tests.

test('cada export de cristae/grammar es la MISMA función que define su módulo', () => {
  const origen = {
    defineGrammar: gGrammar,
    GrammarError: gValidate, validate: gValidate, validateSignature: gValidate,
    reduceModifier: gReduce, leafUnits: gReduce, buildUnit: gReduce,
    enclosingModifier: gMounting,
    grammarChildren: gUtil, tagName: gUtil,
  }
  assert.deepEqual(Object.keys(origen).sort(), Object.keys(GRAMMAR).sort(),
    'hay un export del segmento sin módulo de origen declarado en este test')
  for (const [k, mod] of Object.entries(origen))
    assert.equal(grammar[k], mod[k], `grammar.${k} no es el ${k} de su módulo fuente`)
})

test('cada export de cristae/core es la MISMA función que define su módulo', () => {
  const origen = {
    createSource: dSource, defineSource: dSource,
    makeFilter: dFilters, makeListener: dFilters,
  }
  assert.deepEqual(Object.keys(origen).sort(), Object.keys(CORE).sort())
  for (const [k, mod] of Object.entries(origen))
    assert.equal(core[k], mod[k], `core.${k} no es el ${k} de su módulo fuente`)
})

test('cristae/table expone su trío propio más el núcleo re-exportado', () => {
  assert.deepEqual(Object.keys(table).sort(), Object.keys(TABLE).sort())
  assert.deepEqual(firma(table), TABLE)
})

test('el núcleo re-exportado por cristae/table es la MISMA referencia, no una copia', () => {
  // Si table dejara de re-exportar desde data/ (o duplicara el factory), un consumidor
  // que mezcle `cristae/core` y `cristae/table` tendría dos universos de Source.
  for (const k of ['createSource', 'defineSource', 'makeFilter', 'makeListener'])
    assert.equal(table[k], core[k], `table.${k} !== core.${k}`)
})

test('el trío propio de cristae/table es la MISMA función que define su módulo', () => {
  const origen = { CristaeTable: tTable, PagedTable: tPaged, paginationModel: tPagination }
  for (const [k, mod] of Object.entries(origen))
    assert.equal(table[k], mod[k], `table.${k} no es el ${k} de su módulo fuente`)
})

test('ningún entry point tiene export default', () => {
  for (const [nombre, mod] of Object.entries({ core, grammar, table, geojson, geometry }))
    assert.equal('default' in mod, false, `${nombre} trae default`)
})

// ── Efecto de importación de cristae/table ──

test('importar cristae/table registra <cristae-table> una sola vez y guardado por get()', () => {
  assert.deepEqual(registry.gets, ['cristae-table'])
  assert.equal(registry.defines.length, 1)
  const [tag, ctor] = registry.defines[0]
  assert.equal(tag, 'cristae-table')
  assert.equal(ctor, table.CristaeTable)
})

// ── geojson: el lector NO filtra su autómata ──

// El entry re-exporta TRES nombres y nada más. El autómata y su registro de estado —`stack`,
// `flags`, las tablas de claves— son la mitad del archivo y no salen: si alguno aparece acá es que
// se filtró un detalle de implementación que después alguien va a usar y no se va a poder mover.
const GEOJSON = {
  GeoJsonError: 'function',
  GeoJsonKind: 'object',
  readGeoJson: 'function',
  areasOf: 'function',
}

test('cristae/geojson expone el lector, el enum, el error y la selección de áreas — nada del autómata', () => {
  assert.deepEqual(Object.keys(geojson).sort(), Object.keys(GEOJSON).sort())
  for (const [nombre, tipo] of Object.entries(GEOJSON)) {
    assert.equal(typeof geojson[nombre], tipo, `${nombre} no es ${tipo}`)
    assert.equal(geojson[nombre], jLector[nombre], `${nombre} no es el del módulo fuente`)
  }
})

// El enum viaja congelado: es una tabla de códigos que entra a `kinds`, y un consumidor que le
// agregue una entrada estaría inventando un tipo que el lector nunca emite.
test('GeoJsonKind es inmutable y cubre los seis tipos del RFC', () => {
  assert.ok(Object.isFrozen(geojson.GeoJsonKind))
  assert.deepEqual(geojson.GeoJsonKind, {
    Point: 1, MultiPoint: 2, LineString: 3, MultiLineString: 4, Polygon: 5, MultiPolygon: 6,
  })
})

// El lector no toca `customElements` ni al importarse ni al correr.
// Se verifica contra el registry stubeado, que para este punto ya registró lo de `table`.
test('el lector no registra ningún custom element', () => {
  const antes = registry.defines.length
  geojson.readGeoJson('{"type":"Point","coordinates":[1,2]}')
  assert.equal(registry.defines.length, antes)
  assert.ok(!pkg.sideEffects.includes('./src/geojson/index.js'))
})

// ── geometry: la medida, los modelos y el contrato de path, sin la regla interna ──

// Veinte nombres. `foldRuns`, `foldPart`, `foldArgs`, `iterable`, `coordOf`, `isPlace`,
// `hasPointShape` e `isPoint` son la regla de corte y de punto que comparten `toParts`, `distance`,
// `boundsOf` y `fitToLayers`, y los editores leen con `coordOf` e `isPoint`, la cámara con `isPlace` y
// el anfitrión con `coordOf` y `hasPointShape`; `emptyBounds`, `growBounds`, `growRun` y `readBounds`,
// la caja y su lector, que comparten las cajas, los encuadres del motor y la cámara; `arcMeters`,
// `makeModel` y `checkLength`, el núcleo de la esfera y la fábrica de modelos que comparten las medidas
// y el picking de círculos; `MODEL`, `isModel` y `byDefault`, la marca de modelo y el modelo por
// defecto que comparten `distance` y las medidas de zona, y `AREA`, `ELEVATION` y `RELIEF`, las marcas
// que leen esas medidas y el terreno; `foldRings` y `areaStep`, el lector de zonas y la suma de su
// área, que comparten esas medidas y `relief`, y `measureArgs`, el de sus argumentos; `readShape`,
// `reachesPole`, `readDrawable`, `viewSegments`, `sizeShape`, `writeShape` y `pairs`, el escritor de formas
// que comparten `ring`, `arc`, las capas de círculos y de formas y los editores, y `GROUND`,
// `MIN_SEGMENTS`, `segmentsFor`, `stepsFor`, `viewTolerance` y `pixelsToMeters`, el módulo de densidad que
// usan ese escritor, esas capas y los editores; `count` y `at`, los tramos y los puntos de la curva que
// comparten `geodesic`, las capas de líneas y de polígonos y los editores, `checkPlacer` y `checkHeading`,
// los controles del modelo que coloca puntos y da rumbos; y `decodeTile`, el decodificador de tiles de altura
// del terreno: si salen del entry, alguien los usa y ya no se pueden mover.
const GEOMETRY = {
  WGS84          : 'object',
  arc            : 'function',
  area           : 'function',
  boundsCenter   : 'function',
  boundsContain  : 'function',
  boundsOf       : 'function',
  boundsPad      : 'function',
  diameter       : 'function',
  distance       : 'function',
  elevation      : 'function',
  ellipsoid      : 'function',
  geodesic       : 'function',
  perimeter      : 'function',
  relief         : 'function',
  ring           : 'function',
  sampleAlong    : 'function',
  sphere         : 'function',
  terrain        : 'function',
  terrainPresets : 'object',
  toParts        : 'function',
}

test('cristae/geometry expone la medida, los modelos y el contrato de path — nada de lo que comparten por dentro', () => {
  assert.deepEqual(firma(geometry), GEOMETRY)
  assert.ok(!pkg.sideEffects.includes('./src/geometry/index.js'))
})

test('cada export de cristae/geometry es el MISMO valor que define su módulo', () => {
  const origen = {
    distance: gGeodesic, sphere: gGeodesic,
    ellipsoid: gEllipsoid, WGS84: gEllipsoid,
    toParts: gPolyline, sampleAlong: gPolyline,
    boundsOf: gBounds, boundsPad: gBounds, boundsContain: gBounds, boundsCenter: gBounds,
    area: gMeasure, perimeter: gMeasure, diameter: gMeasure,
    ring: gShape, arc: gShape, geodesic: gCurve,
    terrain: gTerrain, terrainPresets: gTerrain, relief: gTerrain, elevation: gTerrain,
  }
  assert.deepEqual(Object.keys(origen).sort(), Object.keys(GEOMETRY).sort())
  for (const [k, mod] of Object.entries(origen))
    assert.equal(geometry[k], mod[k], `geometry.${k} no es el ${k} de su módulo fuente`)
})

// El mapa arrastra Leaflet y registra custom elements al importarse, así que su superficie de
// geometría se lee del texto de src/index.js: re-exporta de los módulos y no del entry, sin `ellipsoid`
// ni `WGS84` (el porqué, en src/index.js; tree-shaking.test.mjs lo verifica empaquetando).
const MAPA_GEOMETRIA = {
  './geometry/geodesic.js' : ['distance', 'sphere'],
  './geometry/polyline.js' : ['sampleAlong', 'toParts'],
  './geometry/shape.js'    : ['arc'],
}

test('cristae/map re-exporta distance, sphere, toParts, sampleAlong y arc, sin el elipsoide', () => {
  const fuente = readFileSync(raiz('src/index.js'), 'utf8')
  const reexporta = Object.fromEntries([...fuente.matchAll(/^export \{([^}]*)\} from '(\.\/geometry\/[^']+)'/gm)]
    .map(([, nombres, desde]) => [desde, nombres.split(',').map(n => n.trim()).sort()]))
  assert.deepEqual(reexporta, MAPA_GEOMETRIA)
  assert.doesNotMatch(fuente.replace(/\/\/.*$/gm, ''), /ellipsoid|WGS84|geometry\/index\.js/, 'fuera de los comentarios')
})

// ── package.json: rutas de exports y sideEffects ──

test('el mapa exports congela las 7 rutas públicas más ./package.json', () => {
  assert.deepEqual(pkg.exports, {
    './core': { types: './types/core.d.ts', default: './src/data/index.js' },
    './table': { types: './types/table.d.ts', default: './src/table/index.js' },
    './map': { types: './types/map.d.ts', default: './src/index.js' },
    './grammar': { types: './types/grammar.d.ts', default: './src/grammar/index.js' },
    './geojson': { types: './types/geojson.d.ts', default: './src/geojson/index.js' },
    './geometry': { types: './types/geometry.d.ts', default: './src/geometry/index.js' },
    './react': { types: './react/types/index.d.ts', default: './react/src/index.js' },
    './package.json': './package.json',
  })
})

// `react` es peer OPCIONAL: el core no lo importa en ningún camino, así que un consumidor sin React
// instala Cristae sin arrastrarlo ni ver warnings de peer no satisfecho.
test('react es peer opcional (el core sigue siendo agnóstico)', () => {
  assert.equal(pkg.peerDependencies.react, '>=18')
  assert.equal(pkg.peerDependenciesMeta.react.optional, true)
  assert.ok(pkg.files.includes('react/src') && pkg.files.includes('react/types'),
    'el binding tiene que viajar en el tarball')
})

test('sideEffects declara sólo los dos entries que registran custom elements', () => {
  assert.deepEqual(pkg.sideEffects, ['./src/index.js', './src/table/index.js'])
})

// Destinos escritos A MANO (no derivados de pkg.exports): así el test se sostiene solo aunque
// alguien borre el golden literal de arriba, y `destinos.length` deja de ser un número mágico
// sacado de la misma estructura que dice verificar.
const DESTINOS = [
  './types/core.d.ts', './src/data/index.js',
  './types/table.d.ts', './src/table/index.js',
  './types/map.d.ts', './src/index.js',
  './types/grammar.d.ts', './src/grammar/index.js',
  './types/geojson.d.ts', './src/geojson/index.js',
  './types/geometry.d.ts', './src/geometry/index.js',
  './react/types/index.d.ts', './react/src/index.js',
  './package.json',
]

test('toda ruta declarada en exports apunta a un archivo que existe', () => {
  const declarados = Object.values(pkg.exports)
    .flatMap(v => (typeof v === 'string' ? [v] : Object.values(v)))
  assert.deepEqual(declarados.slice().sort(), DESTINOS.slice().sort())
  for (const d of DESTINOS) assert.ok(existsSync(raiz(d)), `no existe ${d}`)
})

test('el paquete es ESM y publica src + types', () => {
  assert.equal(pkg.type, 'module')
  // Se contrasta el nombre SIN el scope: un consumidor puede vendorizar el paquete bajo su propio
  // scope (`@org/cristae`) sin que eso cambie nada de la superficie que este test cubre.
  assert.equal(pkg.name.replace(/^@[^/]+\//, ''), 'cristae')
  for (const carpeta of ['src', 'types']) assert.ok(pkg.files.includes(carpeta), `files sin ${carpeta}`)
})

// ── S3 (corregido): el .d.ts parte el contrato en LECTURA + DUEÑO ──
// defineSource devuelve CristaeReadSource (lo que el motor consume); createSource devuelve
// CristaeSource, que extiende la lectura con la mutación. Se contrasta el tipo declarado contra el
// objeto real: si alguno de los dos lados se mueve y vuelve a divergir, estos tests suenan.

const dtsCore = readFileSync(raiz('types/core.d.ts'), 'utf8')

// Nombres de miembro declarados en una `export interface` del .d.ts (con balanceo de llaves).
// El nombre va ANCLADO (`indexOf` casaba por prefijo: un rename CristaeSource → CristaeSourceX
// seguía encontrando la interfaz y el test no se enteraba).
const miembrosDeclarados = (src, nombre) => {
  const m = src.match(new RegExp(String.raw`export interface ${nombre}\s*[<{]`))
  assert.ok(m, `types/core.d.ts no declara ${nombre}`)
  const abre = src.indexOf('{', m.index)
  let prof = 0, fin = abre
  for (; fin < src.length; fin++) {
    if (src[fin] === '{') prof++
    else if (src[fin] === '}' && --prof === 0) break
  }
  return [...src.slice(abre + 1, fin).matchAll(/^ *(\w+)\??\s*[(:]/gm)].map(m => m[1]).sort()
}
// Nombre del tipo de retorno declarado para un factory.
const retornoDeclarado = (src, fn) => {
  const m = src.match(new RegExp(`export function ${fn}<[\\s\\S]*?\\): (\\w+)<`))
  assert.ok(m, `types/core.d.ts no declara el retorno de ${fn}`)
  return m[1]
}

const fuenteDefinida = () => core.defineSource({
  accessors: { idOf: (it) => it.id, positionOf: (it) => it },
  getSnapshot: () => [],
  subscribe: () => () => {},
})

// Miembros declarados a mano en cada interfaz del .d.ts. Congelarlos acá (no derivarlos del
// archivo) es lo que hace ruido si el tipo se mueve: LECTURA = lo que el motor consume, DUEÑO =
// el cuerpo PROPIO de CristaeSource (los heredados no se repiten en su bloque).
const MIEMBROS_READ_SOURCE = [
  'accessors', 'appendedPoints', 'dirtyIds', 'getSnapshot', 'itemById', 'moveDirtyIds', 'subscribe', 'variants', 'version',
]
const MIEMBROS_OWNER_SOURCE = [
  'addFilter', 'append', 'appendedPoints', 'destroy', 'dirtyIds', 'itemById', 'move', 'moveDirtyIds', 'patch', 'remove', 'removeFilter', 'set',
]

test('el .d.ts parte el contrato: defineSource devuelve lectura, createSource dueño', () => {
  assert.equal(retornoDeclarado(dtsCore, 'createSource'), 'CristaeSource')
  assert.equal(retornoDeclarado(dtsCore, 'defineSource'), 'CristaeReadSource')
  assert.deepEqual(miembrosDeclarados(dtsCore, 'CristaeReadSource'), MIEMBROS_READ_SOURCE)
  assert.deepEqual(miembrosDeclarados(dtsCore, 'CristaeSource'), MIEMBROS_OWNER_SOURCE)
})

// Lista literal del retorno de createSource — hermano NO-todo del de defineSource que está más
// abajo. Sin él, los dos `todo` de S3 (que hoy fallan de verdad, y por eso se los traga node)
// eran los ÚNICOS asertos sobre la forma de createSource: renombrar moveDirtyIds, borrar
// itemById/variants/dirtyIds o AGREGAR un miembro público pasaban con fail 0.
const MIEMBROS_CREATE_SOURCE = [
  'accessors', 'addFilter', 'append', 'appendedPoints', 'destroy', 'dirtyIds', 'getSnapshot', 'itemById',
  'move', 'moveDirtyIds', 'patch', 'remove', 'removeFilter', 'set',
  'subscribe', 'variants', 'version',
]

test('el retorno de createSource son exactamente estos 17 miembros, ni uno más', () => {
  const src = core.createSource({ idOf: (it) => it.id, positionOf: (it) => it })
  const reales = Object.keys(src).sort()
  src.destroy()
  assert.deepEqual(reales, MIEMBROS_CREATE_SOURCE)
})

// ── S3 corregido: el tipo ya no miente sobre lo que devuelve cada factory ──
// Antes eran dos `todo` (el .d.ts prometía métodos de dueño en la ruta B y ocultaba 4 miembros de
// createSource). Con el contrato partido, el runtime cae exactamente dentro de lo declarado.

test('S3 — defineSource sólo expone miembros de CristaeReadSource (ruta B = lectura)', () => {
  const reales = Object.keys(fuenteDefinida()).sort()
  // El runtime puede OMITIR opcionales (moveDirtyIds), pero no exponer nada fuera de la lectura.
  for (const k of reales) assert.ok(MIEMBROS_READ_SOURCE.includes(k), `defineSource expone ${k}, ausente del tipo de lectura`)
})

test('S3 — createSource devuelve exactamente lectura + dueño, sin miembros fuera del tipo', () => {
  const src = core.createSource({ idOf: (it) => it.id, positionOf: (it) => it })
  const reales = Object.keys(src).sort()
  src.destroy()
  const declarados = [...new Set([...MIEMBROS_READ_SOURCE, ...MIEMBROS_OWNER_SOURCE])].sort()
  assert.deepEqual(reales, declarados)
})

test('el retorno de defineSource cumple al menos el subconjunto de LECTURA del contrato', () => {
  // Lo que el motor sí consume hoy; esta parte del tipo no miente y no debe moverse.
  const s = fuenteDefinida()
  for (const k of ['accessors', 'getSnapshot', 'subscribe', 'itemById', 'variants', 'dirtyIds', 'version'])
    assert.ok(k in s, `defineSource sin ${k}`)
  assert.deepEqual(Object.keys(s).sort(),
    ['accessors', 'dirtyIds', 'getSnapshot', 'itemById', 'subscribe', 'variants', 'version'])
})
