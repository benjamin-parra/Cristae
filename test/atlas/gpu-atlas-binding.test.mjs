// Fija la SUBIDA del atlas (etapa 4, D2): al adquirir un contexto la textura se reserva UNA vez y sólo las celdas
// pedidas suben, una llamada por fila ocupada de la grilla (no una por variante, y nunca las declaradas sin usar);
// una variante nueva sube sola, en el sync del dibujo que la pidió, y un sync sin cambios no toca la GPU.
// El GL es un doble que anota cada llamada con los bytes que viajaron en ese momento; los tiles los arma un
// IconSet real sobre el canvas de utilería, y cada tile lleva su propio valor (`marca`) para ver DÓNDE cayó.
import test from 'node:test'
import assert from 'node:assert/strict'
import { instalarCanvas2d } from '../../test-helpers/canvas-2d.mjs'
import { GpuAtlasBinding } from '../../src/atlas/GpuAtlasBinding.js'
import { defineClusterIconSet, defineIconSet } from '../../src/atlas/IconSet.js'

instalarCanvas2d()

const TILE = 4                                                   // px de lado del tile de prueba
const copia = v => (ArrayBuffer.isView(v) ? Uint8Array.from(v) : v)

const makeGl = () => {
  const llamadas = []
  const gl = new Proxy({ TEXTURE_2D: 3, RGBA: 4, UNSIGNED_BYTE: 5, TEXTURE0: 6 }, {
    get: (t, p) => {
      if (p === 'llamadas') return llamadas
      if (p in t) return t[p]
      return (...args) => { llamadas.push([p, ...args.map(copia)]); return p === 'createTexture' ? { textura: true } : {} }
    },
  })
  return { gl, llamadas, de: nombre => llamadas.filter(([m]) => m === nombre) }
}

// Un IconSet de `n` variantes numeradas 1…n; el tile de la variante k son TILE²·4 bytes iguales a k.
const crear = (declaradas = 40) => defineIconSet({
  variants : Array.from({ length: declaradas }, (_, i) => String(i + 1)),
  sizes    : { canvas: TILE },
  describe : v => ({ shape: 'num', n: Number(v) }),
  renderers: { num: (ctx, _size, d) => { ctx.marca = d.n } },
})

// El byte (R) del píxel (x, y) de una subida de `ancho` px: lo que cayó en esa posición de la banda.
const pixel = (bytes, ancho, x, y) => bytes[(y * ancho + x) * 4]

test('T4.1 adquirir con 5 variantes usadas de 40 declaradas: una reserva y UNA subida, de 5 tiles', () => {
  const set = crear()
  for (let k = 1; k <= 5; k++) set.resolve(String(k))
  const { gl, de } = makeGl()
  new GpuAtlasBinding(gl).sync(set.atlas)

  assert.equal(de('texImage2D').length, 1, 'la textura se reserva una vez')
  const reserva = de('texImage2D')[0]
  assert.equal(reserva.at(-1), null, 'sin datos: la reserva no sube bytes')
  const { cols, rows } = set.atlas
  assert.deepEqual([reserva[4], reserva[5]], [cols * TILE, rows * TILE], 'del tamaño de la grilla, no del número de usadas')

  const subidas = de('texSubImage2D')
  assert.equal(subidas.length, 1, 'cinco variantes caben en la primera fila: una subida')
  const [, , , x, y, w, h, , , bytes] = subidas[0]
  assert.deepEqual([x, y, w, h], [0, 0, 5 * TILE, TILE], 'las cinco celdas de la fila, ni una más')
  assert.equal(bytes.length, 5 * TILE * TILE * 4, 'sólo viajan los bytes de lo usado')
  for (let k = 0; k < 5; k++) assert.equal(pixel(bytes, w, k * TILE + 1, 2), k + 1, `el tile de la variante ${k + 1} cayó en su celda`)
})

test('T4.1 adquirir con todas usadas sube una llamada por fila de la grilla, no una por variante', () => {
  const set = crear(40)
  for (let k = 1; k <= 40; k++) set.resolve(String(k))
  const { cols } = set.atlas                                      // capacidad 60 → 8 columnas
  const filas = Math.ceil(40 / cols)
  const { gl, de } = makeGl()
  new GpuAtlasBinding(gl).sync(set.atlas)

  const subidas = de('texSubImage2D')
  assert.equal(subidas.length, filas)
  assert.ok(subidas.length < 40, 'menos subidas que variantes')
  subidas.forEach(([, , , x, y, w, h, , , bytes], fila) => {
    const n = Math.min(cols, 40 - fila * cols)
    assert.deepEqual([x, y, w, h], [0, fila * TILE, n * TILE, TILE], `fila ${fila}`)
    for (let c = 0; c < n; c++) {
      assert.equal(pixel(bytes, w, c * TILE, 0), fila * cols + c + 1, `fila ${fila}, columna ${c}: esquina superior izquierda`)
      assert.equal(pixel(bytes, w, c * TILE + TILE - 1, TILE - 1), fila * cols + c + 1, `fila ${fila}, columna ${c}: esquina inferior derecha`)
    }
  })
})

test('T4.1 las declaradas sin usar nunca suben, aunque el adelanto ocioso las haya dibujado', async () => {
  const set = crear(40)
  const ranuras = []
  globalThis.requestIdleCallback = cb => ranuras.push(cb)
  try {
    set.resolve('1')
    set.resolve('2')
    while (ranuras.length) ranuras.shift()({ timeRemaining: () => 50 })      // el ocio adelanta las 38 restantes
  } finally { delete globalThis.requestIdleCallback }
  const { gl, de } = makeGl()
  new GpuAtlasBinding(gl).sync(set.atlas)
  const bytes = de('texSubImage2D').reduce((n, llamada) => n + llamada.at(-1).length, 0)
  assert.equal(bytes, 2 * TILE * TILE * 4, 'dos celdas pedidas, dos tiles subidos')
})

test('un atlas vacío reserva la textura y no sube nada', () => {
  const { gl, de } = makeGl()
  new GpuAtlasBinding(gl).sync(crear().atlas)
  assert.equal(de('texImage2D').length, 1)
  assert.equal(de('texSubImage2D').length, 0)
})

test('una fila de un solo tile sube el tile mismo, sin copiarlo a una banda', () => {
  const set = defineIconSet({ variants: ['a'], sizes: { canvas: TILE }, describe: () => ({ shape: 'n' }), renderers: { n: ctx => { ctx.marca = 8 } } })
  set.resolve('a')
  const { gl, de } = makeGl()
  new GpuAtlasBinding(gl).sync(set.atlas)
  const [llamada] = de('texSubImage2D')
  assert.deepEqual(llamada.slice(3, 7), [0, 0, TILE, TILE])
  assert.ok(llamada.at(-1).every(b => b === 8))
})

test('T4.3 una variante nueva sube sola en el sync que sigue a su pedido, en su celda', () => {
  const set = crear(40)
  for (let k = 1; k <= 10; k++) set.resolve(String(k))
  const { gl, llamadas, de } = makeGl()
  const binding = new GpuAtlasBinding(gl)
  binding.sync(set.atlas)
  const antes = llamadas.length

  const i = set.resolve('33')                                    // la pide el dibujo de este cuadro…
  binding.sync(set.atlas)                                        // …y sube en el sync de ese mismo dibujo
  const nuevas = llamadas.slice(antes).filter(([m]) => m === 'texSubImage2D')
  assert.equal(nuevas.length, 1, 'una sola subida')
  const [, , , x, y, w, h, , , bytes] = nuevas[0]
  const { cols } = set.atlas
  assert.deepEqual([x, y, w, h], [(i % cols) * TILE, Math.floor(i / cols) * TILE, TILE, TILE], 'su celda, su tamaño')
  assert.ok(bytes.every(b => b === 33), 'con sus bytes')
  assert.equal(de('texImage2D').length, 1, 'sin reservar la textura de nuevo')
})

test('varias variantes nuevas en un cuadro suben una llamada cada una, y un sync sin cambios no toca la GPU', () => {
  const set = crear(40)
  set.resolve('1')
  const { gl, llamadas } = makeGl()
  const binding = new GpuAtlasBinding(gl)
  binding.sync(set.atlas)
  const antes = llamadas.length
  ;['20', '21', '22'].forEach(v => set.resolve(v))
  binding.sync(set.atlas)
  assert.equal(llamadas.slice(antes).filter(([m]) => m === 'texSubImage2D').length, 3)

  const despues = llamadas.length
  binding.sync(set.atlas)
  binding.sync(set.atlas)
  assert.equal(llamadas.slice(despues).filter(([m]) => /^tex/.test(m)).length, 0, 'estable: ninguna subida')
})

test('T4.1 re-adquirir (un binding nuevo sobre el mismo atlas) vuelve a subir lo pedido, no lo declarado', () => {
  const set = crear(40)
  for (let k = 1; k <= 12; k++) set.resolve(String(k))
  const a = makeGl(), b = makeGl()
  new GpuAtlasBinding(a.gl).sync(set.atlas)
  new GpuAtlasBinding(b.gl).sync(set.atlas)
  assert.deepEqual(b.de('texSubImage2D'), a.de('texSubImage2D'), 'el mismo trabajo y los mismos bytes en el contexto nuevo')
  assert.equal(b.de('texImage2D').length, 1)
})

test('regrow: un atlas nuevo reserva de nuevo y sube todas las celdas pedidas con los índices intactos', () => {
  const set = defineIconSet({ sizes: { canvas: TILE }, describe: v => ({ shape: 'n', n: Number(v) }), renderers: { n: (ctx, _s, d) => { ctx.marca = d.n } } })
  for (let k = 1; k <= 16; k++) set.resolve(String(k))
  const { gl, de } = makeGl()
  const binding = new GpuAtlasBinding(gl)
  binding.sync(set.atlas)
  set.resolve('17')                                              // desborda la capacidad de 16
  binding.sync(set.atlas)
  assert.equal(de('texImage2D').length, 2, 'una reserva por generación')
  const ultimas = de('texSubImage2D').slice(-Math.ceil(17 / set.atlas.cols))
  const { cols } = set.atlas
  ultimas.forEach(([, , , , y, w, , , , bytes], fila) => {
    const n = Math.min(cols, 17 - fila * cols)
    for (let c = 0; c < n; c++) assert.equal(pixel(bytes, w, c * TILE, 0), fila * cols + c + 1)
    assert.equal(y, fila * TILE)
  })
})

test('el cluster por defecto, con unas pocas burbujas, sube una fracción del atlas de 2304×2176', () => {
  const set = defineClusterIconSet({ draw: (ctx, _size, count) => { ctx.marca = count % 256 }, sizes: { canvas: TILE } })
  ;[2, 3, 5, 8, 13, 21].forEach(c => set.resolve(set.variantForCount(c)))
  const { gl, de } = makeGl()
  new GpuAtlasBinding(gl).sync(set.atlas)
  const total = de('texSubImage2D').reduce((n, llamada) => n + llamada.at(-1).length, 0)
  assert.equal(total, 6 * TILE * TILE * 4, 'seis tiles, no 199')
  assert.equal(de('texSubImage2D').length, 1)
})
