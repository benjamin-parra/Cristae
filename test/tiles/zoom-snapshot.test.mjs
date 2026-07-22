// Scoring puro de ZoomSnapshotStore.select(): elige el mejor par (primario que cubre el
// centro + secundario que rellena el hueco) contra un viewport destino. Corre por frame de
// zoom, así que su corrección se congela acá con una proyección inyectada (zoomScale) para no
// depender de Leaflet. Se testea el ORÁCULO — el comportamiento actual — no lo deseado.
// Corre con: node --test test/tiles/zoom-snapshot.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'

import { ZoomSnapshotStore } from '../../src/tiles/ZoomSnapshotStore.js'

// Punto mínimo con el álgebra que projectedFrame() usa (multiplyBy/subtract/round).
const pt = (x, y) => ({
  x,
  y,
  multiplyBy(s) { return pt(x * s, y * s) },
  subtract(o) { return pt(x - o.x, y - o.y) },
  round() { return pt(Math.round(x), Math.round(y)) },
})

// Canvas falso: add() lee width/height; discard() llama remove() y colapsa las dimensiones.
const el = (width, height) => ({ width, height, removed: false, remove() { this.removed = true } })

// Snapshot con esquina en (x,y) y tamaño w×h; con zoomScale()=>1 y pixelOrigin (0,0) su frame
// proyectado es rect(x, y, x+w, y+h), así que la geometría del scoring es predecible.
const snap = (x, y, w, h, sourceZoom = 5) => ({
  element: el(w, h),
  meta: { sourceZoom, sourcePixelTopLeft: pt(x, y) },
})

// select() con un viewport 100×100, proyección identidad y zoom destino fijo.
const selectOn = (store) => store.select({
  targetZoom: 5,
  pixelOrigin: pt(0, 0),
  viewportSize: { x: 100, y: 100 },
  zoomScale: () => 1,
})

test('sin entries → []', () => {
  assert.deepEqual(selectOn(new ZoomSnapshotStore()), [])
})

test('un snapshot fuera del viewport (coverage 0 → score 0) no se elige', () => {
  const store = new ZoomSnapshotStore()
  store.add(snap(500, 500, 100, 100)) // frame rect(500,500,600,600): no intersecta el viewport
  assert.deepEqual(selectOn(store), [])
})

test('primary = el candidato de mayor score entre los superpuestos', () => {
  const store = new ZoomSnapshotStore()
  const chico = store.add(snap(0, 0, 50, 50))   // cubre un cuarto
  const grande = store.add(snap(0, 0, 100, 100)) // cubre todo el viewport
  store.add(snap(500, 500, 100, 100))            // fuera → score 0

  const out = selectOn(store)
  assert.equal(out.length, 1)
  assert.equal(out[0].snapshot, grande)
  assert.notEqual(out[0].snapshot, chico)
})

test('secundario bajo MIN_SECONDARY_SCORE se descarta → devuelve solo [primary]', () => {
  // Dos bandas de igual score (config óptima para el secundario). Aun así el aporte residual
  // del segundo cae por debajo del umbral 0.01: el máximo analítico de secondaryScore es
  // (1-a)^3 · a^4 ≈ 0.0084 < 0.01, por lo que el branch [secondary, primary] hoy es inalcanzable.
  const store = new ZoomSnapshotStore()
  const a = store.add(snap(0, 0, 60, 100))  // banda izquierda
  store.add(snap(40, 0, 60, 100))           // banda derecha, mismo score

  const out = selectOn(store)
  assert.equal(out.length, 1)
  assert.equal(out[0].snapshot, a) // empate ⇒ gana el primero agregado
})

test('clear() descarta todos los canvas y deja select() en []', () => {
  const store = new ZoomSnapshotStore()
  const uno = store.add(snap(0, 0, 100, 100))
  const dos = store.add(snap(0, 0, 50, 50))

  store.clear()

  assert.equal(uno.element.removed, true)
  assert.equal(dos.element.removed, true)
  assert.equal(uno.element.width, 0)
  assert.deepEqual(selectOn(store), [])
})

test('#trim recorta los seeds por su propio tope (seeds-primero): 5 seeds, cap 3', () => {
  const store = new ZoomSnapshotStore() // maxSeedSnapshots default = 3
  const seeds = [1, 2, 3, 4, 5].map(() => store.add(snap(0, 0, 100, 100), { kind: 'seed' }))

  // Los dos seeds más antiguos se descartan; sobreviven los tres más nuevos.
  assert.equal(seeds[0].element.removed, true)
  assert.equal(seeds[1].element.removed, true)
  assert.equal(seeds[2].element.removed, false)
  assert.equal(seeds[3].element.removed, false)
  assert.equal(seeds[4].element.removed, false)
})

test('#trim aplica el tope de seeds ANTES que el global', () => {
  // Con snapshots=3 y seeds=2, agregando n1,n2,s1,s2,s3 en orden:
  //   s2 dispara el tope global (4>3) → cae el más viejo: n1.
  //   s3 dispara el tope de seeds (3>2) → cae el seed más viejo: s1 (aunque el global ya estaba OK).
  const store = new ZoomSnapshotStore({ maxSnapshots: 3, maxSeedSnapshots: 2 })
  const n1 = store.add(snap(0, 0, 100, 100))
  const n2 = store.add(snap(0, 0, 100, 100))
  const s1 = store.add(snap(0, 0, 100, 100), { kind: 'seed' })
  const s2 = store.add(snap(0, 0, 100, 100), { kind: 'seed' })
  const s3 = store.add(snap(0, 0, 100, 100), { kind: 'seed' })

  assert.equal(n1.element.removed, true)  // tope global
  assert.equal(s1.element.removed, true)  // tope de seeds
  assert.equal(n2.element.removed, false)
  assert.equal(s2.element.removed, false)
  assert.equal(s3.element.removed, false)
})
