// Fast-path incremental de LineLayer: un `patch` de UN id sobre un set del mismo tamaño reescribe SÓLO
// los vértices de esa línea por bufferSubData — NO llama glify.setData (rebuild O(n), que realoca el
// buffer). Un cambio de tamaño (o de nº de vértices de una parte) SÍ cae a setData (re-encode seguro).
//
// Se importa el harness PRIMERO (shimea window/document + requestAnimationFrame, que la Source real usa
// para coalescer su emit a rAF). El makeGlify del harness es de PUNTOS (bytes=7); las líneas usan otra
// instancia (bytes=6, layout [x,y,r,g,b,a] y setData por FeatureCollection), así que se arma un glify
// stub LOCAL para lines() que cuenta setData y captura cada bufferSubData (con una copia del rango).
import '../../test-helpers/engine-stub.mjs'
import { makeMap } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { LineLayer } from '../../src/render/LineLayer.js'
import { createSource } from '../../src/data/Source.js'
import { projX0, projY0 } from '../../src/render/project.js'

const BYTES = 6

// La Source real emite en rAF (defer:'raf' → setTimeout(0) bajo el shim); un macrotask lo vacía.
const flush = () => new Promise(r => globalThis.setTimeout(r, 0))

// Reconstruye allVerticesTyped como glify.Lines: por feature, color per-feature; por parte, duplica los
// vértices interiores (gl.LINES). Con mapCenterPixels {0,0} el x,y es projX0(lng)/projY0(lat) directo, el
// MISMO marco que reescribe el fast-path → un restyle puro deja la geometría idéntica (geomDirty=false).
const buildVerts = (settings) => {
  const out = []
  settings.data.features.forEach((feature, fi) => {
    const col = typeof settings.color === 'function' ? settings.color(fi) : settings.color
    const partsCoords = feature.geometry.type === 'MultiLineString'
      ? feature.geometry.coordinates
      : [feature.geometry.coordinates]
    partsCoords.forEach((coords) => {
      const K = coords.length
      for (let j = 0; j < K; j++) {
        const [lat, lng] = coords[j]
        const push = () => out.push(projX0(lng), projY0(lat), col.r, col.g, col.b, col.a)
        if (j !== 0 && j !== K - 1) push()   // interior duplicado
        push()
      }
    })
  })
  return new Float32Array(out)
}

// glify stub de líneas: una instancia por lines(); cuenta setData y registra cada bufferSubData con una
// COPIA del rango escrito (el 4º arg `src` ES el espejo #verts de la capa → se lee el valor real subido).
const makeLinesGlify = () => {
  const stats = { setData: 0, subData: [] }
  const gl = new Proxy({ ARRAY_BUFFER: 1, DYNAMIC_DRAW: 2 }, {
    get: (t, p) => {
      if (p === 'bufferSubData') return (_target, dstByteOffset, src, srcOffset, length) =>
        stats.subData.push({ dstByteOffset, srcOffset, length, data: src.slice(srcOffset, srcOffset + length) })
      return p in t ? t[p] : () => ({})
    },
  })
  return {
    stats,
    lines(settings) {
      const layer = {
        bytes: 6,
        gl,
        mapCenterPixels: { x: 0, y: 0 },
        allVerticesTyped: buildVerts(settings),
        getBuffer: () => ({}),
        setData(fc) { stats.setData++; settings = { ...settings, data: fc }; layer.allVerticesTyped = buildVerts(settings) },
        layer: { redraw() {}, _reset() {} },
        remove() {},
      }
      return layer
    },
  }
}

// Línea de 2 puntos (una sola parte, 2·(2−1)=2 vértices) con estilo plano.
const line = (id, color, path) => ({ id, color, path })

const accessors = {
  idOf: (it) => it.id,
  pathOf: (it) => it.path,
  styleOf: (it) => ({ color: it.color, weight: 3, opacity: 1 }),
}

const mount = async () => {
  const glify = makeLinesGlify()
  const map = makeMap()
  const source = createSource(accessors)
  source.set([
    line('a', '#111111', [[0, 0], [1, 1]]),
    line('b', '#222222', [[10, 10], [11, 11]]),
  ])
  await flush()                                          // deja pasar el emit inicial del set()
  const layer = new LineLayer({ glify, map, pane: 'p', source, interactive: true })
  await flush()                                          // vacía el emit pendiente pre-montaje (incremental a,b)
  return { glify, source, layer }
}

// Canales r,g,b esperados de un hex (el fast-path escribe toRGBA en el buffer).
const rgb = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16)
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255]
}

test('patch del estilo de UNA línea NO llama setData y reescribe SÓLO el buffer de esa línea', async () => {
  const { glify, source, layer } = await mount()

  assert.equal(layer.count, 2, 'las 2 líneas quedaron montadas')
  assert.equal(glify.stats.setData, 0, 'el build inicial usa lines() (constructor), nunca setData')

  const setDataBaseline = glify.stats.setData
  glify.stats.subData.length = 0                          // aísla los uploads del patch

  // Muta el color de 'b' y patchea SÓLO su id, sin tocar los largos.
  const snap = source.getSnapshot()
  snap.find(it => it.id === 'b').color = '#ff8800'
  source.patch(snap, new Set(['b']))
  await flush()

  assert.equal(glify.stats.setData, setDataBaseline, 'el patch de estilo NO disparó rebuild (setData)')
  assert.ok(glify.stats.subData.length >= 1, 'el patch subió al menos un rango por bufferSubData')

  // 'b' es el 2º feature: vertOffset 2, 2 vértices → rango [2·6, 4·6) = elementos 12..24, byte 48.
  const uploaded = glify.stats.subData.filter(c => c.srcOffset === 2 * BYTES && c.length === 2 * BYTES)
  assert.ok(uploaded.length >= 1, "se subió el rango de la línea 'b' (offset 12, len 12)")
  assert.ok(glify.stats.subData.every(c => c.srcOffset === 2 * BYTES),
    "ningún upload tocó el rango de la línea 'a' (offset 0)")

  // El color nuevo llegó al buffer en TODOS los vértices de 'b' (canales r,g,b por vértice).
  const [r, g, b] = rgb('#ff8800')
  const data = uploaded[0].data
  for (let vtx = 0; vtx < 2; vtx++) {
    const o = vtx * BYTES
    assert.ok(Math.abs(data[o + 2] - r) < 1e-6 && Math.abs(data[o + 3] - g) < 1e-6 && Math.abs(data[o + 4] - b) < 1e-6,
      `vértice ${vtx} de 'b' recibió el color nuevo`)
  }
})

test('agregar una línea (cambia el tamaño) cae a rebuild (setData)', async () => {
  const { glify, source } = await mount()
  const baseline = glify.stats.setData

  source.set([
    line('a', '#111111', [[0, 0], [1, 1]]),
    line('b', '#222222', [[10, 10], [11, 11]]),
    line('c', '#333333', [[20, 20], [21, 21]]),
  ])
  await flush()

  assert.equal(glify.stats.setData, baseline + 1, 'el cambio de membresía dispara setData (rebuild)')
})

test('patch que CAMBIA el nº de vértices de una línea cae a rebuild (re-encode seguro)', async () => {
  const { glify, source } = await mount()
  const baseline = glify.stats.setData
  glify.stats.subData.length = 0

  // Misma cantidad de features (2), pero 'b' pasa de 2 a 3 vértices → los offsets siguientes ya no calzan.
  const snap = source.getSnapshot()
  const b = snap.find(it => it.id === 'b')
  b.path = [[10, 10], [11, 11], [12, 12]]
  source.patch(snap, new Set(['b']))
  await flush()

  assert.equal(glify.stats.setData, baseline + 1, 'el cambio de conteo de vértices fuerza rebuild')
})
