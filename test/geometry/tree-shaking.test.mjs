// La librería geodésica entra sólo al bundle de quien importa `ellipsoid` o `WGS84`. Se empaqueta con
// esbuild, como lo haría un consumidor, y se busca en la salida un método que sólo tiene esa librería.
// Si alguien agrega los módulos de geometría a `sideEffects`, o hace que `distance` importe el
// elipsoide, estos tests suenan.
// Corre con: node --test test/geometry/tree-shaking.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const raiz = fileURLToPath(new URL('../../', import.meta.url))

// `InverseStart` es un método del prototipo de la geodésica: sobrevive a cualquier minificación.
const MARCA = 'InverseStart'

const empaquetar = async contents => (await build({
  stdin    : { contents, resolveDir: raiz, sourcefile: 'consumidor.js' },
  bundle   : true,
  write    : false,
  format   : 'esm',
  platform : 'browser',
  logLevel : 'silent',
})).outputFiles[0].text

test('quien importa distance y sphere de cristae/geometry no carga la librería geodésica', async () => {
  const js = await empaquetar("export { distance, sphere, toParts, sampleAlong } from './src/geometry/index.js'")
  assert.ok(js.includes('Symbol.for'), 'el bundle trae distance')
  assert.ok(!js.includes(MARCA))
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

test('el entry del mapa no la carga: su grafo no llega al elipsoide', async () => {
  const js = await empaquetar("export * from './src/index.js'")
  assert.ok(js.includes('cristae-map'), 'el bundle trae el mapa')
  assert.ok(!js.includes(MARCA))
})
