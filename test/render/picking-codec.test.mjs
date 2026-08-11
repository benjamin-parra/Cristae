// Contrato del picking jerárquico: codec (objeto 14 | chunk 6 | local 12) en los 32 bits del píxel,
// barrido centro-hacia-afuera, destino de PATCH×PATCH sin depth y mailbox de un slot en `request`.
// Sin GPU: un doble de `gl` guioniza el readback y el fence.

import test from 'node:test'
import assert from 'node:assert/strict'
import { Picking, packTag, OBJ_BITS, CHUNK_BITS, LOCAL_BITS } from '../../src/render/Picking.js'

const PATCH = 6

// Bytes que el fragment deja para una entrada: el local (+1) lo aporta el vértice y el tag del draw
// se suma en R, B y A. `entry = -1` ⇒ local 0 = «el objeto, pero no una entrada».
const pixelOf = (obj, chunk, entry) => {
  const local = entry + 1
  return [((local >> 8) & 15) | ((chunk & 15) << 4), local & 255, (chunk >> 4) | ((obj & 63) << 2), obj >> 6]
}

const makeFb = () => ({
  buf: new Uint8Array(PATCH * PATCH * 4),
  paint(col, row, obj, chunk, entry) {
    this.buf.set(pixelOf(obj, chunk, entry), (row * PATCH + col) * 4)
    return this
  },
})

// Batch de un draw (el caso normal de una capa que entra en un chunk), con la forma que declara el
// pase: descriptores propiedad del llamador, reusados entre picks.
const draw = (obj = 1, chunk = 0, extra = {}) =>
  ({ bind: () => {}, texture: null, mode: 0, first: 0, count: 1, obj, chunk, ...extra })

const batch = (...draws) =>
  ({ draws: draws.length ? draws : [draw()], length: draws.length || 1, matrix: new Float32Array(16) })

// `status` guioniza clientWaitSync; `calls` registra el orden de las llamadas que importan.
const makeGl = fb => {
  const calls = []
  const state = { status: 0, renderbuffers: 0, framebuffers: 0, storage: null, tag: null, tags: [] }
  const base = {
    drawingBufferWidth  : 800,
    drawingBufferHeight : 600,
    TIMEOUT_EXPIRED     : 0x911A,
    WAIT_FAILED         : 0x911D,
    createRenderbuffer      : () => { state.renderbuffers++; return {} },
    createFramebuffer       : () => { state.framebuffers++; return {} },
    renderbufferStorage     : (_t, fmt, w, h) => { state.storage = { fmt, w, h } },
    framebufferRenderbuffer : () => {},
    readPixels              : (_x, _y, _w, _h, _f, _t, dst) => {
      calls.push('readPixels')
      if (dst instanceof Uint8Array) dst.set(fb.buf)
    },
    getBufferSubData : (_t, _o, dst) => { calls.push('getBufferSubData'); dst.set(fb.buf) },
    clientWaitSync   : () => state.status,
    uniform3fv       : (_loc, v) => { state.tag = [v[0], v[1], v[2]].map(x => Math.round(x * 255)); state.tags.push(state.tag) },
    drawArrays       : (_mode, first, count) => calls.push(`draw:${first}:${count}`),
  }
  const gl = new Proxy(base, { get: (t, p) => (p in t ? t[p] : () => ({})) })
  return { gl, calls, state }
}

const attached = fb => {
  const doble = makeGl(fb)
  const picking = new Picking()
  picking.attach(doble.gl, {}, {})
  return { picking, ...doble }
}

test('las constantes del reparto suman los 32 bits del píxel', () => {
  assert.equal(OBJ_BITS + CHUNK_BITS + LOCAL_BITS, 32)
  assert.deepEqual([OBJ_BITS, CHUNK_BITS, LOCAL_BITS], [14, 6, 12])
})

test('packTag escribe en un scratch reusado y no desborda el byte del rojo', () => {
  assert.equal(packTag(1, 0), packTag(9999, 63))            // misma instancia: [0-alloc] por draw
  for (let obj = 1; obj < 1 << OBJ_BITS; obj += 7)
    for (let chunk = 0; chunk < 1 << CHUNK_BITS; chunk++) {
      const t = packTag(obj, chunk)
      const bytes = [Math.round(t[0] * 255), Math.round(t[1] * 255), Math.round(t[2] * 255)]
      assert.deepEqual(bytes, [(chunk & 15) << 4, (chunk >> 4) | ((obj & 63) << 2), obj >> 6])
      assert.ok(bytes[0] + 15 <= 255)                        // + el nibble alto del local máximo
    }
})

test('round-trip del codec en los extremos', () => {
  const casos = [
    { obj: 1,     chunk: 0,  entry: 0 },
    { obj: 16383, chunk: 63, entry: 4094 },                  // máximos de los tres campos
    { obj: 200,   chunk: 5,  entry: -1 },                    // objeto sin entrada
    { obj: 63,    chunk: 16, entry: 2047 },                  // frontera obj/chunk entre B y A
  ]
  casos.forEach(({ obj, chunk, entry }) => {
    const fb = makeFb().paint(3, 3, obj, chunk, entry)
    const { picking } = attached(fb)
    const hits = picking.pickSync(100, 100, batch(), null).hits
    assert.equal(hits.count, 1)
    assert.deepEqual([hits.objects[0], hits.chunks[0], hits.slots[0]], [obj, chunk, entry])
  })
})

test('un objeto < 64 deja el alpha en 0 y aun así es impacto', () => {
  const px = pixelOf(1, 0, 7)
  assert.equal(px[3], 0)                                     // el viejo guard `alpha === 0` lo perdía
  const { picking } = attached(makeFb().paint(3, 3, 1, 0, 7))
  const hits = picking.pickSync(100, 100, batch(), null).hits
  assert.equal(hits.count, 1)
  assert.equal(hits.slots[0], 7)
})

test('el texel sin pintar (word 0) no es impacto', () => {
  const { picking } = attached(makeFb())
  assert.equal(picking.pickSync(100, 100, batch(), null).hits.count, 0)
})

test('el barrido va del texel del cursor hacia afuera', () => {
  const fb = makeFb()
  fb.paint(0, 0, 7, 0, 70).paint(3, 3, 8, 0, 80).paint(3, 4, 9, 0, 90)
  const { picking } = attached(fb)
  const hits = picking.pickSync(100, 100, batch(), null).hits
  assert.equal(hits.count, 3)
  assert.deepEqual([hits.objects[0], hits.objects[1], hits.objects[2]], [8, 9, 7])
  assert.equal(hits.firstOf(7), 2)
  assert.equal(hits.firstOf(7, 0), 2)
  assert.equal(hits.firstOf(7, 1), -1)
  assert.equal(hits.firstOf(4242), -1)
})

test('no hay dedup: un sprite cubre varios texeles y cada uno es una entrada, en orden', () => {
  const fb = makeFb()
  fb.paint(3, 3, 1, 0, 5).paint(2, 3, 1, 0, 5).paint(4, 3, 1, 0, 6)
  const { picking } = attached(fb)
  const hits = picking.pickSync(100, 100, batch(), null).hits
  assert.equal(hits.count, 3)
  assert.deepEqual([hits.slots[0], hits.slots[1], hits.slots[2]], [5, 5, 6])
})

test('el resultado es la MISMA instancia entre picks (contenedor reusado)', () => {
  const { picking } = attached(makeFb().paint(3, 3, 1, 0, 0))
  const uno = picking.pickSync(10, 10, batch(), 'a')
  const dos = picking.pickSync(20, 20, batch(), 'b')
  assert.equal(uno, dos)
  assert.equal(uno.hits, dos.hits)
  assert.equal(dos.metadata, 'b')
})

test('cada draw emite su propio tag y el orden del batch se respeta', () => {
  const { picking, state, calls } = attached(makeFb())
  picking.pickSync(10, 10, batch(draw(1, 0), draw(300, 63, { first: 4095, count: 10 })), null)
  assert.deepEqual(state.tags, [[0, 4, 0], [240, 179, 4]])
  assert.deepEqual(calls.filter(c => c.startsWith('draw')), ['draw:0:1', 'draw:4095:10'])
})

test('el draw con objeto 0 se saltea (emitirlo haría ilegible el pase)', () => {
  const { picking, state, calls } = attached(makeFb())
  picking.pickSync(10, 10, batch(draw(0, 0), draw(5, 1)), null)
  assert.deepEqual(state.tags, [[16, 20, 0]])
  assert.deepEqual(calls.filter(c => c.startsWith('draw')), ['draw:0:1'])
})

test('el destino es un renderbuffer de PATCH×PATCH y no hay depth', () => {
  const { state } = attached(makeFb())
  assert.equal(state.renderbuffers, 1)                       // color y nada más
  assert.equal(state.framebuffers, 1)
  assert.deepEqual([state.storage.w, state.storage.h], [PATCH, PATCH])
})

test('syncSize no reasigna nada', () => {
  const { picking, state } = attached(makeFb())
  for (let i = 0; i < 200; i++) picking.syncSize()
  assert.equal(state.renderbuffers, 1)
  assert.equal(state.framebuffers, 1)
})

test('request encola en vez de descartar y dispara al liberarse el vuelo', () => {
  const fb = makeFb().paint(3, 3, 1, 0, 3)
  const { picking, calls } = attached(fb)                     // status 0 = fence listo
  assert.equal(picking.request(10, 10, batch(), 'vieja'), true)
  assert.equal(picking.request(20, 20, batch(), 'nueva'), true)
  assert.equal(picking.request(30, 30, batch(), 'ultima'), true)
  assert.equal(calls.filter(c => c === 'readPixels').length, 1)   // un solo pase en vuelo
  assert.equal(picking.busy, true)

  const primero = picking.collect()
  assert.equal(primero.metadata, 'vieja')
  // La copia del PBO va ANTES del readPixels del encolado: si no, lo pisaría.
  assert.deepEqual(calls.filter(c => !c.startsWith('draw')), ['readPixels', 'getBufferSubData', 'readPixels'])
  assert.equal(picking.pending, true)                          // el encolado quedó en vuelo

  assert.equal(picking.collect().metadata, 'ultima')           // pisó a 'nueva': sólo importa la última
  assert.equal(picking.busy, false)
  assert.equal(picking.collect(), null)
})

test('el fence perdido no traba el mailbox', () => {
  const { picking, state } = attached(makeFb())
  picking.request(10, 10, batch(), 'a')
  picking.request(20, 20, batch(), 'b')
  state.status = 0x911D                                        // WAIT_FAILED
  assert.equal(picking.collect(), null)
  assert.equal(picking.pending, true)                          // el encolado salió igual
  state.status = 0
  assert.equal(picking.collect().metadata, 'b')
})

test('collect no consume el vuelo mientras el fence no está listo', () => {
  const { picking, state } = attached(makeFb())
  picking.request(10, 10, batch(), 'a')
  state.status = 0x911A                                        // TIMEOUT_EXPIRED
  assert.equal(picking.collect(), null)
  assert.equal(picking.pending, true)
})

test('abort deja IDLE aunque haya vuelo y encolado', () => {
  const { picking } = attached(makeFb())
  picking.request(10, 10, batch(), 'a')
  picking.request(20, 20, batch(), 'b')
  picking.abort()
  assert.equal(picking.pending, false)
  assert.equal(picking.busy, false)
  assert.equal(picking.collect(), null)
})
