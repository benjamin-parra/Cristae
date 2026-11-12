// El motor no arrastra los lectores de formatos al chunk de entrada: `url` los pide al usarse. Se arma el bundle con
// esbuild y splitting, y se mira qué cadenas quedan en la entrada y cuáles en otros chunks.
// Corre con: node --test test/engine/datos-diferidos.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const RAIZ = new URL('../../', import.meta.url).pathname

// Cadenas que sólo existen en el lector respectivo: el prefijo de sus códigos de error.
const MARCAS = ['kml: ', 'geojson: ']

test('el chunk de entrada de MapEngine no trae los lectores; algún otro chunk sí', async () => {
  const { outputFiles } = await build({
    stdin: { contents: "export { MapEngine } from './src/engine/MapEngine.js'", resolveDir: RAIZ, loader: 'js' },
    bundle: true, splitting: true, format: 'esm', outdir: 'out', write: false, platform: 'browser', external: ['leaflet'],
  })
  const entrada = outputFiles.find(f => !/chunk-/.test(f.path))
  assert.ok(outputFiles.length > 1, 'esbuild no partió en chunks')
  for (const marca of MARCAS) {
    assert.ok(!entrada.text.includes(marca), `la entrada contiene ${marca}`)
    assert.ok(outputFiles.some(f => f !== entrada && f.text.includes(marca)), `ningún chunk contiene ${marca}`)
  }
})
