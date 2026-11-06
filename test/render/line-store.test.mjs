// Contrato de `LineStore`, el arena mutable de las partes de una línea: una parte se reescribe o crece
// subiendo sólo lo escrito, y la textura se rehace únicamente cuando falta lugar. Lo que se mide son las
// subidas que ve la GPU (`texImages` = textura entera, `texSubImages` = filas) y los datos que viajan.
import '../../test-helpers/engine-stub.mjs'
import { makeGl, makePickSpy } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { LineStore } from '../../src/render/LineStore.js'

const make = opts => {
  const spy = makePickSpy()
  return { spy, store: new LineStore({ gl: makeGl(null, spy), ...opts }) }
}

// `n` vértices sobre el eje x, de `x0` en `x0 + n - 1`.
const recta = (n, x0 = 0) => Float64Array.from({ length: n * 2 }, (_, i) => (i % 2 ? 0 : x0 + i / 2))

test('las partes ocupan rangos contiguos, cada una con su hueco', () => {
  const { store } = make()
  const a = store.add(recta(10), 10)
  const b = store.add(recta(5), 5)
  assert.deepEqual([store.firstOf(a), store.countOf(a), store.firstOf(b), store.countOf(b)], [0, 10, 10, 5])
  assert.equal(store.viewOf(b).firstVertex, 10)
  assert.equal(store.viewOf(b).lastVertex, 14)
})

test('reescribir una parte que cabe en su hueco no rehace la textura: sube filas', () => {
  const { store, spy } = make()
  const a = store.add(recta(10), 10)
  store.add(recta(10), 10)
  const imagenes = spy.texImages.length
  const subidas  = spy.texSubImages.length
  store.rewrite(a, recta(6, 100), 6)
  assert.equal(spy.texImages.length, imagenes, 'ni textura nueva ni cambio de tamaño')
  assert.equal(spy.texSubImages.length, subidas + 1, 'una subida de filas')
  assert.deepEqual([store.firstOf(a), store.countOf(a)], [0, 6], 'en su lugar, con el largo nuevo')
})

test('reescribir con el ancla nueva: los vértices viajan relativos a ella', () => {
  const { store, spy } = make()
  const a = store.add(recta(2), 2)                     // ancla (0.5, 0)
  store.rewrite(a, recta(2, 10), 2)                    // ancla (10.5, 0)
  assert.deepEqual([...spy.texSubTexels.at(-1).subarray(0, 4)], [-0.5, 0, 0.5, 0])
})

test('agregar dentro del hueco sube sólo lo agregado y respeta el ancla', () => {
  const { store, spy } = make()
  const a = store.add(recta(2), 2)                     // hueco de 2: lleno
  const b = store.add(recta(4), 4)
  store.rewrite(b, recta(2, 5), 2)                     // b queda con hueco de 4 y 2 usados
  const imagenes = spy.texImages.length
  store.append(b, Float64Array.of(7, 0), 1)
  assert.equal(store.countOf(b), 3)
  assert.equal(spy.texImages.length, imagenes)
  const fila = spy.texSubTexels.at(-1)
  assert.deepEqual([...fila.subarray(store.firstOf(b) * 2, (store.firstOf(b) + 3) * 2)], [-0.5, 0, 0.5, 0, 1.5, 0])
  assert.equal(store.firstOf(a), 0, 'las demás no se tocan')
})

test('agregar más allá del hueco la muda a uno del doble y conserva lo escrito', () => {
  const { store, spy } = make()
  const a = store.add(recta(2), 2)                     // ancla (0.5, 0); hueco 2
  store.add(recta(2), 2)
  store.append(a, Float64Array.of(4, 0), 1)
  assert.equal(store.countOf(a), 3)
  assert.equal(store.firstOf(a), 4, 'mudada al final')
  const fila = spy.texSubTexels.at(-1)
  assert.deepEqual([...fila.subarray(8, 14)], [-0.5, 0, 0.5, 0, 3.5, 0], 'los dos vértices de antes y el nuevo')
  store.append(a, Float64Array.of(5, 0), 1)            // el hueco es de 4: ahora cabe sin mudarse
  assert.equal(store.firstOf(a), 4)
  assert.equal(store.countOf(a), 4)
})

test('una parte quitada libera su slot para la siguiente', () => {
  const { store } = make()
  const a = store.add(recta(3), 3)
  const b = store.add(recta(3), 3)
  store.remove(a)
  assert.equal(store.firstOf(a), -1)
  assert.equal(store.add(recta(3), 3), a, 'el slot libre se reusa')
  assert.notEqual(a, b)
})

test('la textura crece por potencias de dos cuando falta lugar', () => {
  const { store, spy } = make()
  store.add(recta(200), 200)
  const chica = spy.texImages.at(-1)
  store.add(recta(900), 900)
  const grande = spy.texImages.at(-1)
  assert.deepEqual([chica.width * chica.height, grande.width * grande.height], [256, 2048])
  assert.ok(grande.width <= 2048)
})

test('con basura por la mitad se compacta en vez de crecer', () => {
  const { store, spy } = make()
  const a = store.add(recta(100), 100)
  const b = store.add(recta(100), 100)
  store.remove(a)
  const antes = spy.texImages.at(-1)
  const c = store.add(recta(100), 100)
  const despues = spy.texImages.at(-1)
  assert.deepEqual([despues.width, despues.height], [antes.width, antes.height], 'mismo tamaño')
  assert.deepEqual([store.firstOf(b), store.firstOf(c)], [0, 100], 'las vivas quedan juntas')
})

test('los arcos acumulan el largo por vértice, y por parte', () => {
  const { store, spy } = make()
  const a = store.add(Float64Array.of(0, 0, 3, 4, 3, 10), 3)
  const b = store.add(Float64Array.of(0, 0, 0, 2), 2)
  assert.ok(store.arcTexture)
  const arcos = spy.texels.at(-1)
  assert.deepEqual([...arcos.subarray(store.firstOf(a), store.firstOf(a) + 3)], [0, 5, 11])
  assert.deepEqual([...arcos.subarray(store.firstOf(b), store.firstOf(b) + 2)], [0, 2], 'cada parte arranca en cero')
})

test('con gradiente cada vértice lleva su color, y agregar sube también los colores', () => {
  const { store, spy } = make({ gradient: true })
  const a = store.add(recta(2), 2, Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255))
  const colores = spy.texSubTexels.filter(t => t instanceof Uint8Array).at(-1)
  assert.deepEqual([...colores.subarray(0, 8)], [255, 0, 0, 255, 0, 255, 0, 255])
  store.append(a, Float64Array.of(3, 0), 1, Uint8Array.of(0, 0, 255, 255))
  const fila = spy.texSubTexels.filter(t => t instanceof Uint8Array).at(-1)
  assert.deepEqual([...fila.subarray(store.firstOf(a) * 4, store.firstOf(a) * 4 + 12)], [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255])
})

test('sin gradiente no hay textura de colores', () => {
  const { store, spy } = make()
  store.add(recta(2), 2)
  assert.equal(store.colorTexture, null)
  assert.ok(!spy.texels.some(t => t instanceof Uint8Array))
})

/* ── Sin contexto, y contexto nuevo ── */

// Un contexto que anota las texturas que le piden borrar y, con `tope`, contesta su lado máximo de textura.
const MAX_TEXTURE_SIZE = 0x0D33
const conSpy = (spy, { tope = null, borradas = [] } = {}) => new Proxy(makeGl(null, spy), {
  get: (t, p) => (p === 'deleteTexture' ? textura => borradas.push(textura)
    : tope !== null && p === 'MAX_TEXTURE_SIZE' ? MAX_TEXTURE_SIZE
    : tope !== null && p === 'getParameter' ? q => (q === MAX_TEXTURE_SIZE ? tope : undefined)
    : t[p]),
})

// La textura de posiciones tal como la deja la GPU: la imagen entera y las filas que se le subieron después.
const contenido = spy => {
  const datos = Array.from(spy.texels.at(-1))
  spy.texSubTexels.forEach((fila, k) => datos.splice(spy.texSubImages[k].srcOffset, fila.length, ...fila))
  return datos
}

test('sin contexto las partes se escriben igual y no se sube nada; buildGl sube el espejo entero de una vez', () => {
  const sin = new LineStore({})
  const a = sin.add(recta(10), 10)
  const b = sin.add(recta(5, 20), 5)
  sin.rewrite(a, recta(8, 100), 8)
  sin.append(b, Float64Array.of(30, 0), 1)
  assert.deepEqual([sin.firstOf(a), sin.countOf(a), sin.firstOf(b), sin.countOf(b)], [0, 8, 15, 6], 'la segunda se mudó al final: no cabía')
  assert.deepEqual([sin.texture, sin.arcTexture, sin.colorTexture], [null, null, null], 'ni texturas, ni siquiera la de arcos')

  const nuevo = makePickSpy()
  sin.buildGl(conSpy(nuevo))
  assert.deepEqual([nuevo.texImages.length, nuevo.texSubImages.length], [1, 0], 'una imagen entera y ninguna fila')
  assert.ok(sin.texture)

  const viva = makePickSpy()
  const con  = new LineStore({ gl: conSpy(viva) })
  const x = con.add(recta(10), 10)
  const y = con.add(recta(5, 20), 5)
  con.rewrite(x, recta(8, 100), 8)
  con.append(y, Float64Array.of(30, 0), 1)
  assert.deepEqual(contenido(nuevo), contenido(viva), 'la misma textura que dejaron las subidas incrementales')
})

test('dropGl olvida las texturas sin borrarlas; lo que se escribe después no sube, y destroy no toca el contexto', () => {
  const spy      = makePickSpy()
  const borradas = []
  const store    = new LineStore({ gl: conSpy(spy, { borradas }), gradient: true })
  const a = store.add(recta(4), 4, new Uint8Array(16))
  assert.ok(store.arcTexture)
  const subidas = spy.texImages.length + spy.texSubImages.length

  assert.equal(store.dropGl(), store)
  assert.deepEqual([store.texture, store.arcTexture, store.colorTexture], [null, null, null])
  store.append(a, Float64Array.of(9, 0), 1, new Uint8Array(4))
  store.add(recta(300), 300, new Uint8Array(1200))                      // crece: rehace las dimensiones
  assert.equal(spy.texImages.length + spy.texSubImages.length, subidas, 'sin contexto no sube nada')
  store.destroy()
  assert.equal(borradas.length, 0, 'y no borra lo de un contexto que ya no está')
})

test('buildGl en un contexto nuevo crea las texturas ahí, con todo lo que tenía el espejo', () => {
  const primero = makePickSpy()
  const store   = new LineStore({ gl: conSpy(primero), gradient: true })
  store.add(recta(6), 6, Uint8Array.from({ length: 24 }, (_, i) => i))
  const vieja = store.texture
  const subidas = primero.texImages.length
  store.dropGl()

  const segundo = makePickSpy()
  store.buildGl(conSpy(segundo))
  assert.notEqual(store.texture, vieja, 'una textura del contexto nuevo')
  assert.ok(store.colorTexture)
  assert.deepEqual(segundo.texImages.map(({ width, height }) => width * height), [256, 256], 'posiciones y colores')
  assert.deepEqual([...segundo.texels[1].subarray(0, 24)], Array.from({ length: 24 }, (_, i) => i), 'los colores de cada vértice')
  assert.equal(primero.texImages.length, subidas, 'el contexto viejo no recibe más')
})

test('con el contexto vivo, destroy devuelve las tres texturas', () => {
  const borradas = []
  const store    = new LineStore({ gl: conSpy(makePickSpy(), { borradas }), gradient: true })
  store.add(recta(4), 4, new Uint8Array(16))
  store.arcTexture
  store.destroy()
  assert.equal(borradas.length, 3)
  assert.deepEqual([store.texture, store.arcTexture, store.colorTexture], [null, null, null], 'y no quedan a la vista')
})

test('el tope de textura del contexto lo hereda el store que releva, también sin contexto', () => {
  const con = new LineStore({ gl: conSpy(makePickSpy(), { tope: 1 }) })
  assert.equal(con.limit, 1)
  assert.throws(() => con.add(recta(3000), 3000), /4096 vértices no entran en una textura de 1×1/)
  assert.doesNotThrow(() => new LineStore({}).add(recta(3000), 3000), 'sin tope conocido no hay con qué comparar')
  const sin = new LineStore({ limit: con.limit })
  assert.throws(() => sin.add(recta(3000), 3000), /4096 vértices no entran en una textura de 1×1/)
})

test('buildGl vuelve a medir el tope: lo que ya no cabe en el contexto nuevo lanza antes de crear nada', () => {
  const store = new LineStore({})
  store.add(recta(3000), 3000)
  const spy = makePickSpy()
  assert.throws(() => store.buildGl(conSpy(spy, { tope: 1 })), /no entran en una textura de 1×1/)
  assert.equal(store.texture, null)
  assert.equal(spy.texImages.length, 0)
  assert.equal(store.limit, 1)
})
