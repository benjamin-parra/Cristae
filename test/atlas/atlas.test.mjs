// Fija el comportamiento observable de Atlas (valor CPU append-only, direccionado por generación):
// append hasta capacity → -1 SIN mutar; grow preserva variante→índice e índice→tile; tileChannel
// normaliza por CAPACIDAD fija; cellOf reusa el MISMO scratch [0-alloc]. Atlas no toca DOM ni WebGL:
// los "bitmaps" son objetos opacos cualquiera (el atlas los guarda por referencia, no los interpreta).
import test from 'node:test'
import assert from 'node:assert/strict'
import Atlas from '../../src/atlas/Atlas.js'

test('append: asigna índices consecutivos desde 0, sube count y guarda el bitmap por referencia', () => {
  const a = new Atlas(4, 128)
  const bmp = { id: 'x' }
  assert.equal(a.count, 0)
  assert.equal(a.append('a', bmp), 0)
  assert.equal(a.append('b', {}), 1)
  assert.equal(a.count, 2)
  assert.equal(a.indexOf('a'), 0)
  assert.equal(a.indexOf('b'), 1)
  assert.strictEqual(a.tileAt(0), bmp)          // sin copiar: el MISMO objeto
})

test('indexOf: variante ausente → -1 (antes y después de poblar)', () => {
  const a = new Atlas(4, 128)
  assert.equal(a.indexOf('nope'), -1)
  a.append('a', {})
  assert.equal(a.indexOf('nope'), -1)
})

test('append: lleno (count === capacity) → -1 SIN mutar estado', () => {
  const a = new Atlas(3, 128)                    // capacity 3
  const tiles = [{}, {}, {}]
  tiles.forEach((b, i) => assert.equal(a.append('v' + i, b), i))
  assert.equal(a.count, 3)

  // El estado queda congelado: el intento fallido no toca count, ni variantes, ni tiles.
  assert.equal(a.append('overflow', { id: 'z' }), -1)
  assert.equal(a.count, 3)
  assert.equal(a.indexOf('overflow'), -1)
  tiles.forEach((b, i) => assert.strictEqual(a.tileAt(i), b))
})

test('cellOf: col = index % cols, row = floor(index / cols) — estable por generación', () => {
  const a = new Atlas(4, 128)                    // cols = ceil(sqrt(4)) = 2
  assert.equal(a.cols, 2)
  assert.deepEqual({ ...a.cellOf(0) }, { col: 0, row: 0 })
  assert.deepEqual({ ...a.cellOf(1) }, { col: 1, row: 0 })
  assert.deepEqual({ ...a.cellOf(2) }, { col: 0, row: 1 })
  assert.deepEqual({ ...a.cellOf(3) }, { col: 1, row: 1 })
  // La celda de un índice es función pura de (index, cols): no se mueve dentro de la generación.
  assert.deepEqual({ ...a.cellOf(2) }, { col: 0, row: 1 })
})

test('cellOf: devuelve SIEMPRE el MISMO objeto scratch [0-alloc]', () => {
  const a = new Atlas(9, 128)                    // cols = 3
  const c0 = a.cellOf(0)
  const c1 = a.cellOf(5)
  assert.strictEqual(c0, c1)                     // no asigna por llamada
  assert.strictEqual(c0, a.cell)                 // es el scratch público
  // La última llamada gana: el objeto refleja el índice más reciente.
  assert.equal(c1.col, 5 % a.cols)
  assert.equal(c1.row, (5 / a.cols) | 0)
})

test('tileChannel: normaliza por CAPACIDAD fija (index / (C-1)), no por count', () => {
  const a = new Atlas(5, 128)                    // divisor = C-1 = 4
  assert.equal(a.tileChannel(0), 0)
  assert.equal(a.tileChannel(2), 0.5)
  assert.equal(a.tileChannel(4), 1)
  // Mismo índice, distinta capacidad ⇒ distinto canal: prueba que divide por C, no por count.
  const b = new Atlas(9, 128)                    // divisor = 8
  assert.equal(a.tileChannel(1), 1 / 4)
  assert.equal(b.tileChannel(1), 1 / 8)
})

test('tileChannel: capacity 1 no divide por cero (max(C-1, 1) = 1)', () => {
  const a = new Atlas(1, 128)
  assert.equal(a.tileChannel(0), 0)
})

test('grow: duplica capacity, sube generación y preserva variante→índice e índice→tile', () => {
  const a = new Atlas(3, 128, 0)
  const tiles = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  tiles.forEach((b, i) => a.append('v' + i, b))

  const g = Atlas.grow(a)
  assert.notStrictEqual(g, a)                    // objeto NUEVO: el binding detecta el regrow por identidad
  assert.equal(g.capacity, 6)                    // doble
  assert.equal(g.generation, 1)                  // +1
  assert.equal(g.tileSize, a.tileSize)
  assert.equal(g.count, a.count)                 // mismo poblado

  tiles.forEach((b, i) => {
    assert.equal(g.indexOf('v' + i), i)          // variante→índice preservado
    assert.strictEqual(g.tileAt(i), b)           // índice→tile por REFERENCIA (no copia)
  })

  // El atlas previo queda intacto; el nuevo tiene headroom para seguir apilando desde count.
  assert.equal(a.count, 3)
  assert.equal(g.append('v3', { id: 'd' }), 3)
  assert.equal(g.count, 4)
  assert.equal(a.indexOf('v3'), -1)              // no tocó al previo
  assert.equal(a.count, 3)
})
