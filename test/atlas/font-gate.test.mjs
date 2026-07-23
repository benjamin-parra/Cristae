// Fija el FONT-GATE del IconSet (naturalización 3.4): #rasterize es SÍNCRONO, así que una variante con
// glifo de fuente web resuelta ANTES de que la fuente cargue hornea un tofu permanente. La red de
// seguridad: si al nacer el IconSet hay un FontFaceSet aún cargando, al terminar document.fonts.ready se
// RE-RASTERIZAN las variantes ya resueltas (misma capacidad → índices estables) y se avisa por
// onAtlasRefresh. Sin FontFaceSet o ya 'loaded' → rasteriza UNA sola vez (camino actual intacto).
//
// El harness shimea window/document (incluye createElement('canvas') con un ctx no-op) — no probamos el
// pixel, sólo el DIRECCIONAMIENTO: cuántas veces se invoca el renderer por variante y la señal de refresh.
import '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { defineIconSet } from '../../src/atlas/IconSet.js'

// Renderer que cuenta invocaciones por variante (la variante viaja en el descriptor). describe TOTAL:
// devuelve descriptor para cualquier string, respetando el contrato del espacio de descriptor.
const makeSet = (extra = {}) => {
  const rasterCount = new Map()
  const bump = (v) => rasterCount.set(v, (rasterCount.get(v) ?? 0) + 1)
  const set = defineIconSet({
    describe: (v) => ({ shape: 'glyph', variant: v }),
    renderers: { glyph: (_ctx, _size, d) => bump(d.variant) },
    ...extra,
  })
  return { set, rasterCount }
}

// Deja correr el .then(document.fonts.ready) del font-gate (microtask) + cualquier cola pendiente.
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0))

test('fonts cargando: la variante resuelta ANTES de ready se re-rasteriza tras ready + avisa por onAtlasRefresh', async () => {
  const doc = globalThis.document
  let resolveReady
  doc.fonts = { status: 'loading', ready: new Promise((r) => { resolveReady = r }) }

  const { set, rasterCount } = makeSet()
  await set.ready

  const i = set.resolve('alpha')                 // rasteriza 1 vez (fuentes aún cargando → potencial tofu)
  assert.equal(rasterCount.get('alpha'), 1)

  let refreshed = 0
  const unsub = set.onAtlasRefresh(() => { refreshed++ })

  // Identidad + generación del atlas ANTES de que carguen las fuentes: la re-rasterización debe hornear
  // una generación NUEVA (identidad distinta), NO mutar los bitmaps del atlas vivo. El binding GPU re-sube
  // sólo porque la identidad cambió; una regresión que re-rasterizara in-place sobre el MISMO objeto nunca
  // llegaría a la GPU (mostraría el tofu para siempre) y, sin esta captura, pasaría los asserts de conteo.
  const prevAtlas = set.atlas
  const prevGen = prevAtlas.generation

  resolveReady()                                 // document.fonts.ready resuelve
  await flushMicrotasks()

  assert.equal(rasterCount.get('alpha'), 2, 're-rasteriza la variante ya resuelta al cargar las fuentes')
  assert.equal(refreshed, 1, 'emite atlasrefreshed exactamente una vez')
  assert.notEqual(set.atlas, prevAtlas, 'la re-rasterización hornea un atlas de IDENTIDAD nueva (no muta in-place)')
  assert.equal(set.atlas.generation, prevGen + 1, 'la generación del atlas se incrementa (señal de re-subida para el binding)')
  assert.equal(set.resolve('alpha'), i, 'el índice del tile es estable entre generaciones (misma capacidad)')

  unsub()
  delete doc.fonts
})

test('fonts.ready RECHAZA: el gate degrada sin lanzar (no re-rasteriza, no avisa, no rechazo sin manejar)', async () => {
  const doc = globalThis.document
  let rejectReady
  // ready rechaza → el `.catch(() => {})` del gate debe tragarlo. Sin ese catch, este rechazo quedaría
  // sin manejar y node:test haría fallar la corrida — el test MUERDE si alguien saca el catch.
  doc.fonts = { status: 'loading', ready: new Promise((_r, reject) => { rejectReady = reject }) }

  const { set, rasterCount } = makeSet()
  await set.ready

  set.resolve('alpha')                           // rasteriza 1 vez (fuentes aún "cargando")
  assert.equal(rasterCount.get('alpha'), 1)

  let refreshed = 0
  set.onAtlasRefresh(() => { refreshed++ })

  const prevAtlas = set.atlas
  rejectReady(new Error('fuentes no disponibles'))
  await flushMicrotasks()

  assert.equal(rasterCount.get('alpha'), 1, 'ready rechazado ⇒ NO re-rasteriza')
  assert.equal(refreshed, 0, 'ready rechazado ⇒ NO emite atlasrefreshed')
  assert.equal(set.atlas, prevAtlas, 'ready rechazado ⇒ el atlas vivo no cambia de identidad')
  delete doc.fonts
})

test('fonts cargando pero NADA resuelto (count===0) con prerender: al cargar es no-op, sin refresh', async () => {
  const doc = globalThis.document
  let resolveReady
  doc.fonts = { status: 'loading', ready: new Promise((r) => { resolveReady = r }) }

  // prerender async presente + sin variants ni resolve ⇒ el atlas queda con count 0 cuando #onFontsReady
  // corre → toma el atajo `if (prev.count === 0) return` (nada que re-rasterizar). El gate NO debe hornear
  // una generación nueva ni avisar sobre un atlas vacío.
  const { set, rasterCount } = makeSet({ prerender: async () => {} })
  await set.ready
  assert.equal(set.atlas.count, 0, 'nada sembrado ni resuelto ⇒ atlas vacío')

  let refreshed = 0
  set.onAtlasRefresh(() => { refreshed++ })

  const prevAtlas = set.atlas
  resolveReady()
  await flushMicrotasks()

  assert.equal(refreshed, 0, 'count===0 ⇒ no avisa (no-op)')
  assert.equal(set.atlas, prevAtlas, 'count===0 ⇒ no hornea generación nueva')

  // el gate ya se consumió (fontsPending=false): una resolución posterior rasteriza UNA sola vez.
  set.resolve('tardía')
  await flushMicrotasks()
  assert.equal(rasterCount.get('tardía'), 1, 'tras el no-op, resolver rasteriza una sola vez (gate consumido)')
  delete doc.fonts
})

test('fonts cargando: también re-rasteriza las variantes SEMBRADAS en el constructor', async () => {
  const doc = globalThis.document
  let resolveReady
  doc.fonts = { status: 'loading', ready: new Promise((r) => { resolveReady = r }) }

  const { set, rasterCount } = makeSet({ variants: ['sembrada'] })
  await set.ready
  assert.equal(rasterCount.get('sembrada'), 1, 'la siembra rasteriza 1 vez en #init')

  resolveReady()
  await flushMicrotasks()

  assert.equal(rasterCount.get('sembrada'), 2, 'la variante sembrada también se re-rasteriza tras ready')
  delete doc.fonts
})

test('fonts ya loaded: no se arma el gate → rasteriza una sola vez, sin refresh', async () => {
  const doc = globalThis.document
  doc.fonts = { status: 'loaded', ready: Promise.resolve() }

  const { set, rasterCount } = makeSet()
  await set.ready

  let refreshed = 0
  set.onAtlasRefresh(() => { refreshed++ })
  set.resolve('alpha')
  await flushMicrotasks()

  assert.equal(rasterCount.get('alpha'), 1, 'loaded ⇒ sin re-rasterización')
  assert.equal(refreshed, 0, 'loaded ⇒ nunca emite atlasrefreshed')
  delete doc.fonts
})

test('sin FontFaceSet (document.fonts ausente): rasteriza una sola vez (camino actual intacto)', async () => {
  const doc = globalThis.document
  delete doc.fonts                               // el shim del harness no define document.fonts

  const { set, rasterCount } = makeSet()
  await set.ready
  set.resolve('alpha')
  await flushMicrotasks()

  assert.equal(rasterCount.get('alpha'), 1, 'sin FontFaceSet no hay gate ni re-rasterización')
})
