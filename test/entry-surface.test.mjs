// GOLDEN de la superficie pública: los tres entry points que NO arrastran DOM ni Leaflet
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

// ── Orden de carga: `core` y `grammar` PRIMERO y sin ningún stub. Si alguno tocara
//    customElements al importarse (no deben: no figuran en `sideEffects`) reventaría acá.
const core = await import('../src/data/index.js')
const grammar = await import('../src/grammar/index.js')

// Módulos que DEFINEN cada export re-exportado por los dos entries anteriores. El golden de
// nombres no distingue una función de otra (todas son `function`): la identidad contra el
// módulo fuente es lo único que detecta un intercambio de exports o un stub homónimo.
const gGrammar = await import('../src/grammar/grammar.js')
const gValidate = await import('../src/grammar/validate.js')
const gReduce = await import('../src/grammar/reduce.js')
const gMounting = await import('../src/grammar/mounting.js')
const gUtil = await import('../src/grammar/util.js')
const dSource = await import('../src/data/Source.js')
const dFilters = await import('../src/data/filters.js')

// `table/` SÍ registra el custom element al importarse: se stubea el registry para observar
// la definición sin DOM. El stub va después de los dos imports de arriba, a propósito.
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
  for (const [nombre, mod] of [['core', core], ['grammar', grammar], ['table', table]])
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

// ── package.json: rutas de exports y sideEffects ──

test('el mapa exports congela las 4 rutas públicas más ./package.json', () => {
  assert.deepEqual(pkg.exports, {
    './core': { types: './types/core.d.ts', default: './src/data/index.js' },
    './table': { types: './types/table.d.ts', default: './src/table/index.js' },
    './map': { types: './types/map.d.ts', default: './src/index.js' },
    './grammar': './src/grammar/index.js',
    './package.json': './package.json',
  })
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
  './src/grammar/index.js',
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
  assert.equal(pkg.name, 'cristae')
  for (const carpeta of ['src', 'types']) assert.ok(pkg.files.includes(carpeta), `files sin ${carpeta}`)
})

// ── S3: types/core.d.ts vs. lo que realmente devuelven los factories ──
// El .d.ts declara que ambos devuelven CristaeSource<T>; en runtime defineSource devuelve 7
// miembros de LECTURA (sin set/move/patch/remove/addFilter/removeFilter/destroy) y createSource
// devuelve además version/variants/dirtyIds/moveDirtyIds, que el tipo no menciona. Se compara
// el tipo declarado contra el objeto real: el día que se sincronice cualquiera de los dos lados,
// el test se destilda solo.

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

// Miembros que el .d.ts declara HOY en CristaeSource, a mano. Congelarlos acá (y no sólo
// contrastarlos con el runtime dentro de un `todo`) es lo que hace ruido si el .d.ts se mueve
// solo: si el tipo declarado como retorno pasa a ser uno que no existe en el archivo, el
// `miembrosDeclarados` de abajo revienta EN UN TEST QUE SÍ CUENTA.
const MIEMBROS_CRISTAE_SOURCE = [
  'accessors', 'addFilter', 'destroy', 'getSnapshot', 'itemById',
  'move', 'patch', 'remove', 'removeFilter', 'set', 'subscribe',
]

test('el .d.ts declara CristaeSource como retorno de AMBOS factories, con sus 11 miembros', () => {
  assert.equal(retornoDeclarado(dtsCore, 'createSource'), 'CristaeSource')
  assert.equal(retornoDeclarado(dtsCore, 'defineSource'), 'CristaeSource')
  assert.deepEqual(miembrosDeclarados(dtsCore, 'CristaeSource'), MIEMBROS_CRISTAE_SOURCE)
})

// Lista literal del retorno de createSource — hermano NO-todo del de defineSource que está más
// abajo. Sin él, los dos `todo` de S3 (que hoy fallan de verdad, y por eso se los traga node)
// eran los ÚNICOS asertos sobre la forma de createSource: renombrar moveDirtyIds, borrar
// itemById/variants/dirtyIds o AGREGAR un miembro público pasaban con fail 0.
const MIEMBROS_CREATE_SOURCE = [
  'accessors', 'addFilter', 'destroy', 'dirtyIds', 'getSnapshot', 'itemById',
  'move', 'moveDirtyIds', 'patch', 'remove', 'removeFilter', 'set',
  'subscribe', 'variants', 'version',
]

test('el retorno de createSource son exactamente estos 15 miembros, ni uno más', () => {
  const src = core.createSource({ idOf: (it) => it.id, positionOf: (it) => it })
  const reales = Object.keys(src).sort()
  src.destroy()
  assert.deepEqual(reales, MIEMBROS_CREATE_SOURCE)
})

// ── Los dos `todo` de S3: SÓLO el aserto del desajuste, nada más ──
// OJO: node:test NO falla cuando un `todo` empieza a pasar (lo reporta `ok … # TODO`). El día
// que S3 se arregle, esto no avisa solo: buscar "S3" en la suite y destildarlos a mano.

test('S3 — defineSource devuelve los miembros que su tipo declara', { todo: 'bug S3 — types/core.d.ts tipa la ruta B como CristaeSource, pero es sólo lectura' }, () => {
  assert.deepEqual(Object.keys(fuenteDefinida()).sort(), MIEMBROS_CRISTAE_SOURCE)
})

test('S3 — createSource devuelve los miembros que su tipo declara', { todo: 'bug S3 — createSource expone version/variants/dirtyIds/moveDirtyIds fuera del tipo' }, () => {
  const src = core.createSource({ idOf: (it) => it.id, positionOf: (it) => it })
  const reales = Object.keys(src).sort()
  src.destroy()
  assert.deepEqual(reales, MIEMBROS_CRISTAE_SOURCE)
})

test('el retorno de defineSource cumple al menos el subconjunto de LECTURA del contrato', () => {
  // Lo que el motor sí consume hoy; esta parte del tipo no miente y no debe moverse.
  const s = fuenteDefinida()
  for (const k of ['accessors', 'getSnapshot', 'subscribe', 'itemById', 'variants', 'dirtyIds', 'version'])
    assert.ok(k in s, `defineSource sin ${k}`)
  assert.deepEqual(Object.keys(s).sort(),
    ['accessors', 'dirtyIds', 'getSnapshot', 'itemById', 'subscribe', 'variants', 'version'])
})
