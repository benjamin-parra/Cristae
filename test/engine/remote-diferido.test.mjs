// Los lectores de formatos no viajan en el chunk de entrada de `loadRemote`: se piden al usarse.
// Corre con: node --test test/engine/remote-diferido.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const RAIZ = new URL('../../', import.meta.url).pathname

// Una cadena que sólo existe en el lector respectivo: un código de error propio de cada uno.
const MARCA_KML = 'kml: '
const MARCA_GEOJSON = 'geojson: '

test('el chunk de entrada no lleva el lector de KML ni el escáner de GeoJSON; algún chunk sí', async () => {
  const { outputFiles } = await build({
    stdin: { contents: "export { loadRemote } from './src/engine/remote.js'", resolveDir: RAIZ, loader: 'js' },
    bundle: true, splitting: true, format: 'esm', outdir: 'out', write: false, platform: 'neutral',
  })
  const texto = f => f.text
  const entrada = outputFiles.find(f => !/chunk-/.test(f.path))
  assert.ok(outputFiles.length > 1, 'esbuild no partió en chunks')
  for (const marca of [MARCA_KML, MARCA_GEOJSON]) {
    assert.ok(!texto(entrada).includes(marca), `la entrada contiene ${marca}`)
    assert.ok(outputFiles.some(f => f !== entrada && texto(f).includes(marca)), `ningún chunk contiene ${marca}`)
  }
})
