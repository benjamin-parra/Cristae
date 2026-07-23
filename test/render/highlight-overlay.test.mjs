// Caracterización del HighlightOverlay (el pase de composición separado del estado de interacción).
// Verifica: (1) dibuja cada resaltado en su posición proyectada; (2) el feed sólo redibuja si se movió
// un RESALTADO (gate O(K), los N puntos que se mueven no lo tocan); (3) resaltar NO crece el atlas
// (el costo in-tile que el overlay evita); (4) micro-benchmark del redibujo O(K).
//
// El harness (engine-stub) shimea window/document y provee glify/map stub — se importa PRIMERO.

import './../../test-helpers/engine-stub.mjs'
import { makeGlify, makeMap } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHighlightOverlay } from '../../src/render/HighlightOverlay.js'
import { createSource } from '../../src/data/Source.js'
import { defineIconSet } from '../../src/atlas/IconSet.js'
import { PointLayer } from '../../src/render/PointLayer.js'

/* ── Helpers ── */

// Proyección determinista (misma forma que el map stub): geográfica → píxel de contenedor.
const project = (lat, lng) => ({ x: lng * 100, y: lat * 100 })

// ctx de canvas mínimo: registra `translate` (para asertar posición); el resto no-op.
const makeCtx = () => ({
  tr: [],
  save() {}, restore() {}, translate(x, y) { this.tr.push([x, y]) },
  clearRect() {}, beginPath() {}, arc() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
})

// Tratamiento representativo (anillo + 4 rayos al seguir) — el costo real de raster es del browser;
// acá mide el overhead JS (proyección + loop + llamadas). ctx ya viene trasladado al punto.
const drawReticle = (ctx, size, key) => {
  const r = size * 0.6
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke()
  if (key === 'follow') {
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2
      ctx.beginPath()
      ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r)
      ctx.lineTo(Math.cos(a) * r * 1.4, Math.sin(a) * r * 1.4)
      ctx.stroke()
    }
  }
}

const buildSource = (n) => {
  const items = Array.from({ length: n }, (_, i) => ({ id: i + 1, lat: (i % 100) * 0.1, lng: (i % 50) * 0.2, size: 24 }))
  const accessors = { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }), sizeOf: it => it.size }
  const source = createSource(accessors)
  source.set(items)
  return { source, items, accessors }
}

const flushRaf = () => new Promise(r => setTimeout(r, 5))   // el Emitter difiere el notify a rAF (setTimeout0 en el stub)
const dotIconSet = () => defineIconSet({ describe: () => ({ shape: 'dot' }), renderers: { dot: () => {} } })

/* ── Tests ── */

test('dibuja cada resaltado en su posición proyectada viva', async () => {
  const { source } = buildSource(3)
  await flushRaf()                                     // drena el notify de set() antes de suscribir el overlay
  const ctx = makeCtx()
  let cleared = 0
  const overlay = createHighlightOverlay({
    source, project, ctx, clear: () => { cleared++ }, drawHighlight: drawReticle,
    sizeOf: it => it.size, schedule: fn => fn(),
  })
  overlay.setHighlighted(new Map([[2, 'follow']]))     // id=2 → i=1 → lat 0.1 / lng 0.2 → (x 20, y 10)
  assert.ok(cleared >= 1, 'limpia antes de dibujar')
  assert.deepEqual(ctx.tr.at(-1), [20, 10], 'traslada al punto proyectado del resaltado')
  overlay.destroy()
})

test('el feed sólo redibuja si se movió un RESALTADO (gate O(K))', async () => {
  const { source } = buildSource(3)
  await flushRaf()
  const ctx = makeCtx()
  let draws = 0
  const overlay = createHighlightOverlay({
    source, project, ctx, clear: () => {}, drawHighlight: () => { draws++ },
    sizeOf: it => it.size, schedule: fn => fn(),
  })
  overlay.setHighlighted(new Map([[2, 'follow']]))
  const base = draws                                   // 1 (dibujo inicial del set)

  source.move(1, 9, 9); await flushRaf()               // NO-resaltado
  assert.equal(draws, base, 'mover un no-resaltado NO despierta el overlay')

  source.move(2, 5, 6); await flushRaf()               // resaltado
  assert.equal(draws, base + 1, 'mover un resaltado redibuja')
  assert.deepEqual(ctx.tr.at(-1), [600, 500], 'redibuja en la posición VIVA (override del move)')
  overlay.destroy()
})

test('resaltar NO crece el atlas (el costo in-tile que el overlay evita)', async () => {
  const iconSet = dotIconSet()
  const { source } = buildSource(1000)
  await flushRaf()
  const layer = new PointLayer({ glify: makeGlify(), map: makeMap(), pane: 'pts', source, iconSet })
  assert.equal(iconSet.atlas.count, 1, 'la flota usa UNA variante base')

  const overlay = createHighlightOverlay({
    source, project, ctx: makeCtx(), clear: () => {}, drawHighlight: drawReticle,
    sizeOf: it => it.size, schedule: fn => fn(),
  })
  const hl = new Map()
  for (let i = 1; i <= 50; i++) hl.set(i, 'follow')
  overlay.setHighlighted(hl)
  for (let i = 1; i <= 50; i++) source.move(i, i * 0.01, i * 0.02)
  await flushRaf()
  assert.equal(iconSet.atlas.count, 1, 'el overlay resalta 50 ids SIN agregar un solo tile al atlas')

  iconSet.resolve('default:follow')                    // contraste: hornear el realce en la variante...
  assert.equal(iconSet.atlas.count, 2, '...SÍ agregaría un tile por estado (lo que el overlay evita)')
  layer.destroy(); overlay.destroy()
})

test('micro-benchmark: el redibujo es O(K), no O(N) — <<1ms/frame en JS', async () => {
  const { source } = buildSource(1000)
  await flushRaf()
  const overlay = createHighlightOverlay({
    source, project, ctx: makeCtx(), clear: () => {}, drawHighlight: drawReticle,
    sizeOf: it => it.size, schedule: fn => fn(),
  })
  const N = 5000
  let usK50 = Infinity
  for (const K of [0, 1, 10, 50]) {
    const hl = new Map()
    for (let i = 1; i <= K; i++) hl.set(i, 'follow')
    overlay.setHighlighted(hl)
    const t0 = performance.now()
    for (let n = 0; n < N; n++) overlay.redraw()
    const us = (performance.now() - t0) / N * 1000
    if (K === 50) usK50 = us
    console.log(`  redibujo K=${String(K).padStart(2)}: ${us.toFixed(2)} µs/frame`)
  }
  // El raster real es del browser; acá mide el mecanismo JS. Aun K=50 debe estar MUY por debajo de 1ms.
  assert.ok(usK50 < 500, `K=50 debe ser <<1ms/frame en JS puro (fue ${usK50.toFixed(2)}µs)`)
  overlay.destroy()
})
