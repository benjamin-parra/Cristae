// Fija el RASTERIZADO PEREZOSO del IconSet (etapa 4, D2): declarar un espacio de variantes —los 199 buckets de un
// cluster— no rasteriza nada; cada variante se dibuja al primer uso, sobre UN canvas de trabajo, y lo declarado que
// falta se adelanta en ranuras ociosas troceadas, sin bloquear un cuadro. Un IconSet que nadie usa no cuesta nada
// (la espiral que nunca se abre). El canvas es el de utilería (test-helpers/canvas-2d.mjs): no dibuja, devuelve
// píxeles, así que probamos QUÉ se rasteriza, CUÁNDO y con qué contexto, no el pixel.
import test, { afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { instalarCanvas2d } from '../../test-helpers/canvas-2d.mjs'
import { defineClusterIconSet, defineIconSet } from '../../src/atlas/IconSet.js'

const { contextos, imagenes } = instalarCanvas2d()

// Ranuras ociosas CONTROLADAS: `requestIdleCallback` guarda cada ranura y el test la corre a mano, con el tiempo
// que el navegador dejaría libre.
let ranuras = []
globalThis.requestIdleCallback = (cb, opciones) => (ranuras.push({ cb, opciones }), ranuras.length)
const correrRanura = (restante = 0.5, vencida = false) => ranuras.shift().cb({ timeRemaining: () => restante, didTimeout: vencida })
const vaciarRanuras = () => { for (let i = 0; ranuras.length && i < 1000; i++) correrRanura(50) }

afterEach(() => {
  ranuras = []
  contextos.length = 0
  imagenes.length = 0
})

// IconSet de prueba: cada variante declarada es un entero, y el renderer deja `marca` = ese entero (el tile sale con
// esos bytes). `dibujadas` es el orden en que se dibujaron.
const crear = (variants, extra = {}) => {
  const dibujadas = []
  const set = defineIconSet({
    variants,
    sizes    : { canvas: 4 },
    describe : v => ({ shape: 'num', n: Number(v) }),
    renderers: { num: (ctx, _size, d) => { dibujadas.push(d.n); ctx.marca = d.n } },
    ...extra,
  })
  return { set, dibujadas }
}
const NUEVE = Array.from({ length: 9 }, (_, i) => String(i + 1))

test('T4.1 definir no rasteriza: ni un tile, ni un canvas de trabajo, ni una ranura agendada', async () => {
  const { set, dibujadas } = crear(NUEVE)
  await set.ready
  assert.deepEqual(dibujadas, [])
  assert.equal(set.atlas.count, 0, 'el atlas no tiene celdas: lo declarado no se pidió')
  assert.equal(contextos.length, 0, 'ni siquiera se creó el canvas de trabajo')
  assert.equal(ranuras.length, 0, 'un IconSet que nadie usa no agenda adelanto')
})

test('T4.1 el cluster por defecto declara 199 buckets y definirlo no rasteriza ninguno', async () => {
  const dibujos = []
  const set = defineClusterIconSet({ draw: (_ctx, _size, count) => dibujos.push(count) })
  await set.ready
  assert.equal(set.atlas.capacity, 299, 'la capacidad sigue siendo la de los 199 buckets con su margen')
  assert.deepEqual(dibujos, [])
  assert.equal(set.atlas.count, 0)
  assert.equal(ranuras.length, 0)
})

test('T4.1 una variante se rasteriza al primer uso, una sola vez, y pedirla de nuevo es un hit sin trabajo', async () => {
  const { set, dibujadas } = crear(NUEVE)
  await set.ready
  const i = set.resolve('3')
  assert.deepEqual(dibujadas, [3])
  assert.equal(set.resolve('3'), i)
  assert.deepEqual(dibujadas, [3], 'el segundo pedido no dibuja')
  assert.equal(set.atlas.count, 1, 'sólo la usada tiene celda')
})

test('el tile es un Uint8ClampedArray de tileSize²·4 bytes con los píxeles que dejó el renderer', async () => {
  const { set } = crear(NUEVE)
  const i = set.resolve('7')
  const tile = set.atlas.tileAt(i)
  assert.ok(tile instanceof Uint8ClampedArray)
  assert.equal(tile.length, 4 * 4 * 4)
  assert.ok(tile.every(b => b === 7))
})

test('todas las variantes se dibujan en UN contexto de trabajo, reiniciado antes de cada tile', async () => {
  const { set } = crear(NUEVE)
  ;['1', '2', '3'].forEach(v => set.resolve(v))
  assert.equal(contextos.length, 1, 'un solo canvas para las tres')
  const [ctx] = contextos
  assert.equal(ctx.opciones.willReadFrequently, true, 'en CPU: leerlo no es un viaje a la GPU')
  assert.equal(ctx.resets, 3, 'reset() antes de cada variante: el estado de una no pasa a la siguiente')
  assert.equal(ctx.lecturas, 3, 'una lectura de píxeles por tile')
  assert.equal(ctx.canvas.width, 4)
})

test('lo que un renderer deja en el contexto no pasa al tile siguiente', async () => {
  const set = defineIconSet({
    sizes    : { canvas: 4 },
    describe : v => ({ shape: v }),
    renderers: { sucio: (ctx) => { ctx.marca = 9 }, limpio: () => {} },   // `limpio` no dibuja: debe salir transparente
  })
  const iSucio  = set.resolve('sucio')
  const iLimpio = set.resolve('limpio')
  assert.ok(set.atlas.tileAt(iSucio).every(b => b === 9))
  assert.ok(set.atlas.tileAt(iLimpio).every(b => b === 0), 'el tile limpio no hereda la marca del anterior')
})

test('sin reset() nativo se reinicia el contexto reasignando el ancho del canvas', async () => {
  const { set } = crear(NUEVE)
  set.resolve('1')
  const [ctx] = contextos
  ctx.reset = undefined                                  // un navegador sin CanvasRenderingContext2D.reset
  ctx.canvas.width = 99                                  // el tile anterior dejó el canvas a otro ancho: se reasigna al del tile
  set.resolve('2')
  assert.equal(ctx.canvas.width, 4)
})

test('T4.1 el primer uso arranca el adelanto de lo declarado: UNA ranura ociosa, no un trabajo por cuadro', async () => {
  const { set } = crear(NUEVE)
  set.resolve('1')
  assert.equal(ranuras.length, 1)
  assert.ok(ranuras[0].opciones.timeout > 900 && ranuras[0].opciones.timeout <= 1000, 'sin ocio, igual avanza en un segundo')
  set.resolve('2')
  assert.equal(ranuras.length, 1, 'otro pedido no agenda otra ranura mientras hay una en espera')
})

test('una ranura vencida con poco ocio rasteriza UN tile, y NO le da celda', async () => {
  const { set, dibujadas } = crear(NUEVE)
  set.resolve('5')                                       // dibuja el 5; arranca el adelanto
  assert.deepEqual(dibujadas, [5])
  correrRanura(0, true)                                  // la espera venció sin ocio: un solo tile
  assert.deepEqual(dibujadas, [5, 1], 'el primero declarado que falta')
  assert.equal(set.atlas.count, 1, 'lo adelantado espera en el depósito: no ocupa celda ni se sube')
  assert.equal(ranuras.length, 1, 'y deja agendada la siguiente')
})

test('una ranura con menos ocio que un tile cede el turno sin dibujar, y no reinicia el vencimiento', async () => {
  let ahora = 10_000
  const hora = mock.method(performance, 'now', () => ahora)
  try {
    const { set, dibujadas } = crear(NUEVE)
    set.resolve('5')
    assert.equal(ranuras[0].opciones.timeout, 1000)
    ahora += 600
    correrRanura(0.5)                                    // el navegador no dejó ocio
    assert.deepEqual(dibujadas, [5], 'no dibujó nada')
    assert.equal(ranuras.length, 1, 'quedó agendada otra')
    assert.equal(ranuras[0].opciones.timeout, 400, 'con lo que faltaba del segundo, no con otro segundo entero')
    ahora += 400
    correrRanura(0, true)                                // venció: avanza aunque no haya ocio
    assert.deepEqual(dibujadas, [5, 1])
  } finally {
    hora.mock.restore()
  }
})

test('una ranura con tiempo trocea por SLICE_MS: unos pocos tiles, nunca todos de una vez', async () => {
  const hora = mock.method(performance, 'now', () => (hora.mock.callCount() + 1) * 1)   // 1 ms por lectura del reloj
  try {
    const { set, dibujadas } = crear(Array.from({ length: 40 }, (_, i) => String(i + 1)))
    set.resolve('40')
    const antes = dibujadas.length
    correrRanura(50)
    const enLaRanura = dibujadas.length - antes
    assert.ok(enLaRanura >= 1 && enLaRanura <= 4, `una ranura hizo ${enLaRanura} tiles`)
    assert.equal(ranuras.length, 1, 'quedan 39 por adelantar: agenda la siguiente')
  } finally {
    hora.mock.restore()
  }
})

test('T4.3 pedir una variante ya adelantada sólo le da celda: no se vuelve a dibujar', async () => {
  const { set, dibujadas } = crear(NUEVE)
  set.resolve('1')
  vaciarRanuras()                                        // adelanta 2…9
  assert.deepEqual(dibujadas, [1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(set.atlas.count, 1)
  const tile4 = dibujadas.length
  const i = set.resolve('4')
  assert.equal(dibujadas.length, tile4, 'el pedido no dibuja: toma el tile del depósito')
  assert.equal(set.atlas.count, 2)
  assert.ok(set.atlas.tileAt(i).every(b => b === 4), 'y es el tile de esa variante')
  assert.equal(set.resolve('4'), i)
})

test('el adelanto salta lo ya resuelto, termina y no deja ranuras agendadas', async () => {
  const { set, dibujadas } = crear(NUEVE)
  set.resolve('3'); set.resolve('4')
  vaciarRanuras()
  assert.deepEqual([...dibujadas].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9], 'cada variante se dibujó exactamente una vez')
  assert.equal(ranuras.length, 0)
})

test('T4.3 una variante NO declarada aparece en el mismo pedido, y no entra al adelanto', async () => {
  const { set, dibujadas } = crear(NUEVE)
  set.resolve('1')
  const i = set.resolve('77')
  assert.equal(i, 1, 'la celda es la siguiente libre, en el acto')
  assert.deepEqual(dibujadas, [1, 77])
  vaciarRanuras()
  assert.equal(dibujadas.filter(n => n === 77).length, 1)
})

test('sin requestIdleCallback el adelanto cae a un temporizador, y no mantiene vivo al proceso', async t => {
  const rIC = globalThis.requestIdleCallback
  delete globalThis.requestIdleCallback
  t.after(() => { globalThis.requestIdleCallback = rIC })
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
  const { set, dibujadas } = crear(NUEVE)
  set.resolve('9')
  assert.deepEqual(dibujadas, [9])
  mock.timers.tick(50)
  assert.ok(dibujadas.length > 1, 'a los 50 ms corrió una ranura')
  mock.timers.tick(50 * 20)
  assert.deepEqual([...dibujadas].sort((a, b) => a - b), NUEVE.map(Number))
})

test('con las fuentes cargando el adelanto espera: sus tiles saldrían en tofu; cargadas, arranca', async () => {
  let listas
  document.fonts = { status: 'loading', ready: new Promise(r => { listas = r }) }
  try {
    const { set, dibujadas } = crear(NUEVE)
    set.resolve('1')
    assert.equal(ranuras.length, 0, 'sin ranura mientras cargan')
    listas()
    await new Promise(r => setTimeout(r, 0))
    assert.equal(set.atlas.count, 1)
    assert.equal(ranuras.length, 1, 'cargadas, arranca el adelanto')
    vaciarRanuras()
    assert.ok(dibujadas.includes(9))
  } finally {
    delete document.fonts
  }
})

test('sprite(): un canvas por variante, el mismo en cada llamada, con los píxeles del tile del atlas', async () => {
  const { set } = crear(NUEVE)
  const canvas = set.sprite('6')
  assert.equal(canvas.width, 4)
  assert.equal(canvas.height, 4)
  assert.equal(set.sprite('6'), canvas, 'el mismo objeto')
  assert.equal(imagenes.length, 1, 'se armó una vez')
  assert.strictEqual(imagenes[0].img.data, set.atlas.tileAt(set.resolve('6')), 'sobre los bytes del tile, sin copiar')
  assert.notEqual(set.sprite('7'), canvas)
})

test('sprite() de una variante que desborda la capacidad lee el tile del atlas NUEVO, no el del viejo', async () => {
  const { set } = crear([], { describe: v => ({ shape: 'num', n: Number(v) }) })   // capacidad mínima: 16
  for (let n = 1; n <= 16; n++) set.resolve(String(n))
  const antes = set.atlas
  const canvas = set.sprite('17')                        // la celda 17 obliga a Atlas.grow
  assert.notEqual(set.atlas, antes, 'hubo regrow')
  assert.ok(canvas)
  assert.ok(imagenes.at(-1).img.data.every(b => b === 17))
})

test('seed(): sigue adelantando a mano lo que se pide, ahora con celda', async () => {
  const { set, dibujadas } = crear(NUEVE)
  set.seed(['2', '4'])
  assert.deepEqual(dibujadas, [2, 4])
  assert.equal(set.atlas.count, 2)
  assert.equal(set.resolve('2'), 0)
})

test('un renderer que falla en el adelanto no deja a la variante sin tile: al pedirla vuelve a fallar donde se ve', async () => {
  let falla = true
  const set = defineIconSet({
    variants : ['a', 'b'],
    sizes    : { canvas: 4 },
    describe : v => ({ shape: 'x', v }),
    renderers: { x: (ctx, _s, d) => { if (d.v === 'b' && falla) throw new Error('boom'); ctx.marca = 1 } },
  })
  set.resolve('a')
  assert.throws(() => correrRanura(50), /boom/, 'el error del adelanto sale en la ranura, no se traga')
  falla = false
  assert.ok(set.resolve('b') >= 0, 'y la variante se rasteriza bien al usarla')
})

test('R3: con `prerender` pendiente el adelanto espera a que termine: lo declarado no se dibuja sin lo que el raster necesita', async () => {
  let fuente = false
  let soltar
  const { set } = crear(NUEVE, {
    prerender: () => new Promise(r => { soltar = () => { fuente = true; r() } }),   // una fuente web que todavía carga
    renderers: { num: (ctx, _size, d) => { ctx.marca = fuente ? d.n : 0 } },        // sin ella, tofu (0)
  })
  set.resolve('1')                                      // el primer dato llega antes que la fuente
  assert.equal(ranuras.length, 0, 'sin ranura mientras `prerender` no termina')
  soltar()
  await set.ready
  assert.equal(ranuras.length, 1, 'terminado, arranca el adelanto')
  vaciarRanuras()
  assert.deepEqual(['2', '5', '9'].map(v => set.atlas.tileAt(set.resolve(v))[0]), [2, 5, 9], 'las declaradas, con la fuente')
})

test('cargadas las fuentes, sprite() entrega el tile nuevo y la escala de footprint es la del raster nuevo', async () => {
  let listas
  let fuente = false
  document.fonts = { status: 'loading', ready: new Promise(r => { listas = r }) }
  try {
    const { set } = crear(NUEVE, {
      describe : v => ({ shape: 'num', n: Number(v), scale: fuente ? 2 : 1 }),
      renderers: { num: (ctx, _size, d) => { ctx.marca = fuente ? d.n : 0 } },      // sin la fuente, tofu (0)
    })
    const antes = set.sprite('3')
    const i     = set.resolve('3')
    assert.equal(imagenes.at(-1).img.data[0], 0, 'en tofu mientras carga')
    assert.equal(set.tileScale(i), 1)
    fuente = true
    listas()
    await new Promise(r => setTimeout(r, 0))
    const despues = set.sprite('3')
    assert.notEqual(despues, antes, 'el canvas de antes era del tile en tofu')
    assert.equal(imagenes.at(-1).img.data[0], 3)
    assert.equal(set.tileScale(i), 2)
  } finally {
    delete document.fonts
  }
})
