// La librería geodésica entra sólo al bundle de quien importa `ellipsoid` o `WGS84`, y el cargador de
// tiles, sólo al de quien importa `terrain` o `relief`. Se empaqueta con esbuild, como lo haría un
// consumidor, y se busca en la salida un nombre que sólo tiene cada pieza. Si alguien agrega los
// módulos de geometría a `sideEffects`, o hace que `distance` o las medidas de zona importen el
// elipsoide o el terreno, estos tests suenan.
// Corre con: node --test test/geometry/tree-shaking.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { basename } from 'node:path'
import { build } from 'esbuild'

const raiz = fileURLToPath(new URL('../../', import.meta.url))

// `InverseStart` es un método del prototipo de la geodésica, y `DecompressionStream` un global que sólo
// nombra el decodificador de tiles: los dos sobreviven a cualquier minificación.
const MARCA   = 'InverseStart'
const TERRENO = 'DecompressionStream'

const empaquetar = async contents => (await build({
  stdin    : { contents, resolveDir: raiz, sourcefile: 'consumidor.js' },
  bundle   : true,
  write    : false,
  format   : 'esm',
  platform : 'browser',
  logLevel : 'silent',
})).outputFiles[0].text

test('quien importa distance y sphere de cristae/geometry no carga la librería geodésica ni el terreno', async () => {
  const js = await empaquetar("export { distance, sphere, toParts, sampleAlong } from './src/geometry/index.js'")
  assert.ok(js.includes('Symbol.for'), 'el bundle trae distance')
  assert.ok(!js.includes(MARCA))
  assert.ok(!js.includes(TERRENO))
})

test('quien mide zonas con area, perimeter o diameter tampoco los carga', async () => {
  const js = await empaquetar("export { area, perimeter, diameter } from './src/geometry/index.js'")
  assert.ok(js.includes('cristae.geometry.area'), 'el bundle trae las medidas')
  assert.ok(!js.includes(MARCA))
  assert.ok(!js.includes(TERRENO))
})

test('quien coloca formas con ring y arc tampoco los carga, y con WGS84 sí', async () => {
  const js = await empaquetar("export { ring, arc, sphere } from './src/geometry/index.js'")
  assert.ok(js.includes('cristae.geometry.destination'), 'el bundle trae los generadores')
  assert.ok(!js.includes(MARCA))
  assert.ok(!js.includes(TERRENO))
  assert.ok((await empaquetar("export { ring, WGS84 } from './src/geometry/index.js'")).includes(MARCA))
})

test('quien curva con geodesic tampoco carga la librería geodésica, y con WGS84 sí', async () => {
  const js = await empaquetar("export { geodesic, sphere } from './src/geometry/index.js'")
  assert.ok(js.includes('no ubica rumbos'), 'el bundle trae la curva')
  assert.ok(!js.includes(MARCA))
  assert.ok(!js.includes(TERRENO))
  assert.ok((await empaquetar("export { geodesic, WGS84 } from './src/geometry/index.js'")).includes(MARCA))
})

test('quien importa terrain y relief carga el decodificador, y no la librería geodésica', async () => {
  const js = await empaquetar("export { terrain, relief } from './src/geometry/index.js'")
  assert.ok(js.includes(TERRENO))
  assert.ok(!js.includes(MARCA))
})

test('terrainPresets solo son datos: no traen el cargador', async () => {
  const js = await empaquetar("export { terrainPresets } from './src/geometry/index.js'")
  assert.ok(js.includes('elevation-tiles-prod'), 'el bundle trae los presets')
  assert.ok(!js.includes(TERRENO))
})

test('quien importa WGS84 o ellipsoid sí la carga', async () => {
  for (const nombre of ['WGS84', 'ellipsoid'])
    assert.ok((await empaquetar(`export { ${nombre} } from './src/geometry/index.js'`)).includes(MARCA), nombre)
})

// WGS84 se construye al cargar el módulo: si nadie lo importa, el bundle no debe pagar ese elipsoide.
test('quien importa sólo ellipsoid no construye WGS84', async () => {
  const js = await empaquetar("export { ellipsoid } from './src/geometry/index.js'")
  assert.ok(!js.includes('ellipsoid(6378137'))
  assert.ok((await empaquetar("export { WGS84 } from './src/geometry/index.js'")).includes('ellipsoid(6378137'), 'la marca sirve')
})

// El entry se parte en chunks: los lectores de formato se importan diferidos (src/engine/remote.js), y el
// zip de KMZ y shapefile-zip nombra `DecompressionStream`. Lo que se mide es lo que baja de entrada, el
// entry y los chunks que importa de forma estática, y no lo que baja quien pide un formato con `url`.
const empaquetarEntry = async contents => {
  const r = await build({
    stdin    : { contents, resolveDir: raiz, sourcefile: 'consumidor.js' },
    bundle   : true,
    write    : false,
    metafile : true,
    splitting: true,
    outdir   : 'salida',
    format   : 'esm',
    platform : 'browser',
    logLevel : 'silent',
  })
  const salidas  = r.metafile.outputs
  const relativa = ruta => Object.keys(salidas).find(k => basename(k) === basename(ruta))
  const pendientes = Object.keys(salidas).filter(k => basename(k) === 'stdin.js')
  const vistos = new Set()
  while (pendientes.length) {
    const k = pendientes.pop()
    if (vistos.has(k)) continue
    vistos.add(k)
    for (const i of salidas[k].imports) if (i.kind === 'import-statement') pendientes.push(i.path)
  }
  return r.outputFiles.filter(f => vistos.has(relativa(f.path))).map(f => f.text).join('\n')
}

test('el entry del mapa no los carga: su grafo no llega al elipsoide ni al terreno', async () => {
  const js = await empaquetarEntry("export * from './src/index.js'")
  assert.ok(js.includes('cristae-map'), 'el bundle trae el mapa')
  assert.ok(!js.includes(MARCA))
  assert.ok(!js.includes(TERRENO))
})

test('el bundle de cristae/geometry no trae src/render/', async () => {
  const salida = (await build({
    stdin    : { contents: "export * from './src/geometry/index.js'", resolveDir: raiz, sourcefile: 'consumidor.js' },
    bundle   : true,
    write    : false,
    metafile : true,
    format   : 'esm',
    platform : 'browser',
    logLevel : 'silent',
  })).metafile
  const entradas = Object.keys(salida.inputs)
  assert.ok(entradas.some(f => f.includes('src/geometry/')))
  assert.deepEqual(entradas.filter(f => f.includes('src/render/')), [])
})
