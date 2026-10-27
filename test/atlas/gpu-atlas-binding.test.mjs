// Fija la SUBIDA del atlas (etapa 4, D2): al adquirir un contexto la textura se reserva UNA vez y sólo suben las
// celdas pedidas, una `texSubImage2D` por tile (nunca las declaradas sin usar, y desde el tile de píxeles, no desde
// un canvas suelto); una variante nueva sube sola, en el sync del dibujo que la pidió, y un sync sin cambios no
// toca la GPU. El GL es un doble que anota cada llamada con los bytes que viajaron en ese momento; los tiles los
// arma un IconSet real sobre el canvas de utilería, y cada tile lleva su propio valor (`marca`) para ver DÓNDE cayó.
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

// Las subidas de tiles con la celda a la que fueron: [x, y, ancho, alto, bytes].
const subidasDe = llamadas => llamadas.filter(([m]) => m === 'texSubImage2D').map(([, , , x, y, w, h, , , bytes]) => ({ x, y, w, h, bytes }))
const celda = (set, i) => ({ x: (i % set.atlas.cols) * TILE, y: Math.floor(i / set.atlas.cols) * TILE })

test('T4.1 adquirir con 5 variantes usadas de 40 declaradas: una reserva y cinco subidas, una por tile', () => {
  const set = crear()
  for (let k = 1; k <= 5; k++) set.resolve(String(k))
  const { gl, llamadas, de } = makeGl()
  new GpuAtlasBinding(gl).sync(set.atlas)

  assert.equal(de('texImage2D').length, 1, 'la textura se reserva una vez')
  const reserva = de('texImage2D')[0]
  assert.equal(reserva.at(-1), null, 'sin datos: la reserva no sube bytes')
  const { cols, rows } = set.atlas
  assert.deepEqual([reserva[4], reserva[5]], [cols * TILE, rows * TILE], 'del tamaño de la grilla, no del número de usadas')

  const subidas = subidasDe(llamadas)
  assert.equal(subidas.length, 5, 'una subida por celda pedida, ni una de las 35 que nadie usa')
  subidas.forEach((u, k) => {
    assert.deepEqual([u.x, u.y, u.w, u.h], [...Object.values(celda(set, k)), TILE, TILE], `el tile ${k + 1} en su celda`)
    assert.equal(u.bytes.length, TILE * TILE * 4)
    assert.ok(u.bytes.every(b => b === k + 1), `con los bytes de la variante ${k + 1}`)
  })
})

test('T4.1 adquirir con todas las variantes usadas sube cada celda pedida una vez, en su sitio', () => {
  const set = crear(40)
  for (let k = 1; k <= 40; k++) set.resolve(String(k))
  const { gl, llamadas } = makeGl()
  new GpuAtlasBinding(gl).sync(set.atlas)

  const subidas = subidasDe(llamadas)
  assert.equal(subidas.length, 40)
  subidas.forEach((u, k) => {
    assert.deepEqual([u.x, u.y], Object.values(celda(set, k)))
    assert.ok(u.bytes.every(b => b === k + 1))
  })
  assert.equal(new Set(subidas.map(u => `${u.x},${u.y}`)).size, 40, 'ninguna celda se pisa')
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
  const { gl, llamadas } = makeGl()
  new GpuAtlasBinding(gl).sync(set.atlas)
  const bytes = subidasDe(llamadas).reduce((n, u) => n + u.bytes.length, 0)
  assert.equal(bytes, 2 * TILE * TILE * 4, 'dos celdas pedidas, dos tiles subidos')
})

test('un atlas vacío reserva la textura y no sube nada', () => {
  const { gl, de } = makeGl()
  new GpuAtlasBinding(gl).sync(crear().atlas)
  assert.equal(de('texImage2D').length, 1)
  assert.equal(de('texSubImage2D').length, 0)
})

test('cada subida entrega el tile del atlas tal cual, sin copiarlo a otro buffer', () => {
  const set = defineIconSet({ variants: ['a'], sizes: { canvas: TILE }, describe: () => ({ shape: 'n' }), renderers: { n: ctx => { ctx.marca = 8 } } })
  set.resolve('a')
  const enviados = []
  const gl = new Proxy({ TEXTURE_2D: 3, RGBA: 4, UNSIGNED_BYTE: 5, TEXTURE0: 6 }, {
    get: (t, p) => (p in t ? t[p] : (...args) => { p === 'texSubImage2D' && enviados.push(args.at(-1)); return {} }),
  })
  new GpuAtlasBinding(gl).sync(set.atlas)
  assert.equal(enviados.length, 1)
  assert.strictEqual(enviados[0], set.atlas.tileAt(0))
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
  const nuevas = subidasDe(llamadas.slice(antes))
  assert.equal(nuevas.length, 1, 'una sola subida')
  assert.deepEqual([nuevas[0].x, nuevas[0].y, nuevas[0].w, nuevas[0].h], [...Object.values(celda(set, i)), TILE, TILE], 'su celda, su tamaño')
  assert.ok(nuevas[0].bytes.every(b => b === 33), 'con sus bytes')
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
  assert.equal(subidasDe(llamadas.slice(antes)).length, 3)

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
  assert.deepEqual(subidasDe(b.llamadas), subidasDe(a.llamadas), 'el mismo trabajo y los mismos bytes en el contexto nuevo')
  assert.equal(subidasDe(b.llamadas).length, 12)
  assert.equal(b.de('texImage2D').length, 1)
})

test('regrow: un atlas nuevo reserva de nuevo y sube todas las celdas pedidas con los índices intactos', () => {
  const set = defineIconSet({ sizes: { canvas: TILE }, describe: v => ({ shape: 'n', n: Number(v) }), renderers: { n: (ctx, _s, d) => { ctx.marca = d.n } } })
  for (let k = 1; k <= 16; k++) set.resolve(String(k))
  const { gl, llamadas, de } = makeGl()
  const binding = new GpuAtlasBinding(gl)
  binding.sync(set.atlas)
  const antes = llamadas.length
  set.resolve('17')                                              // desborda la capacidad de 16
  binding.sync(set.atlas)
  assert.equal(de('texImage2D').length, 2, 'una reserva por generación')
  const nuevas = subidasDe(llamadas.slice(antes))
  assert.equal(nuevas.length, 17, 'las 17 celdas pedidas')
  nuevas.forEach((u, k) => {
    assert.deepEqual([u.x, u.y], Object.values(celda(set, k)), 'en la grilla de la generación nueva')
    assert.ok(u.bytes.every(b => b === k + 1), 'cada índice conserva su tile')
  })
})

test('el cluster por defecto, con unas pocas burbujas, sube una fracción del atlas de 2304×2176', () => {
  const set = defineClusterIconSet({ draw: (ctx, _size, count) => { ctx.marca = count % 256 }, sizes: { canvas: TILE } })
  ;[2, 3, 5, 8, 13, 21].forEach(c => set.resolve(set.variantForCount(c)))
  const { gl, llamadas } = makeGl()
  new GpuAtlasBinding(gl).sync(set.atlas)
  const total = subidasDe(llamadas).reduce((n, u) => n + u.bytes.length, 0)
  assert.equal(total, 6 * TILE * TILE * 4, 'seis tiles, no 199')
  assert.equal(subidasDe(llamadas).length, 6)
})
