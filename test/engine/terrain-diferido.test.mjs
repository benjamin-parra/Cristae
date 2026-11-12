// El terreno no entra al chunk de entrada: la capa de terreno trae el decodificador de teselas al primer mosaico, y
// quien no la usa no lo descarga. Se arma el bundle con esbuild y splitting sobre el entry del paquete, y se busca el
// mensaje del decodificador de PNG (src/geometry/raster.js), que sólo existe ahí. Lo que se mide es lo que baja de
// entrada —la entrada y los chunks que importa de forma estática—, y no lo que baja quien monta una capa de terreno.
// Corre con: node --test test/engine/terrain-diferido.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { build } from 'esbuild'

const RAIZ = new URL('../../', import.meta.url).pathname

const NO_PNG = 'este entorno no decodifica PNG'

test('el chunk de entrada no trae el decodificador de teselas; algún otro chunk sí', async () => {
  const { outputFiles, metafile } = await build({
    stdin: { contents: "export * from './src/index.js'", resolveDir: RAIZ, loader: 'js' },
    bundle: true, splitting: true, format: 'esm', outdir: 'out', write: false, platform: 'browser', metafile: true, logLevel: 'silent',
  })
  const salidas    = metafile.outputs
  const relativa   = ruta => Object.keys(salidas).find(k => basename(k) === basename(ruta))
  const pendientes = Object.keys(salidas).filter(k => basename(k) === 'stdin.js')
  const estaticos  = new Set()
  while (pendientes.length) {
    const k = pendientes.pop()
    if (estaticos.has(k)) continue
    estaticos.add(k)
    for (const i of salidas[k].imports) if (i.kind === 'import-statement') pendientes.push(i.path)
  }
  const deEntrada = outputFiles.filter(f => estaticos.has(relativa(f.path)))
  const diferidos = outputFiles.filter(f => !estaticos.has(relativa(f.path)))

  assert.ok(deEntrada.some(f => f.text.includes('cristae-map')), 'la entrada trae el mapa')
  assert.ok(!deEntrada.some(f => f.text.includes(NO_PNG)), 'la entrada contiene el decodificador de teselas')
  assert.ok(diferidos.some(f => f.text.includes(NO_PNG)), 'ningún chunk diferido contiene el decodificador')
})
