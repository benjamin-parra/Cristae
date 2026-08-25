// Contrato del picking JERÁRQUICO, sobre el que se monta la geometría editable en GPU: el píxel del
// pase reparte objeto(14) | chunk(6) | local(12), el barrido entrega los impactos del cursor hacia
// afuera, `request` se queda con la ÚLTIMA muestra en vez de descartarla, y el destino mide un parche
// —no la pantalla—. Sin GPU: el doble del harness guioniza el readback y el fence, y registra lo que el
// pase pidió (tamaño del destino, adjuntos, origen del viewport, tags y draws).
//
// El harness va PRIMERO: instala los globals de módulo (window/document) que Leaflet toca al evaluarse.
import { makeGl, makePickSpy, makeGlify, makeIconSet, makeMap, makeSurface } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Picking, packTag, OBJ_BITS, CHUNK_BITS, LOCAL_BITS } from '../../src/render/Picking.js'
import { PointLayer } from '../../src/render/PointLayer.js'

const PATCH = 6
const HALF  = PATCH >> 1
const ANCHO = 800
const ALTO  = 600

// El cursor cae SIEMPRE en el texel central: el pase centra el parche trasladando el viewport.
const texel  = (col, row) => row * PATCH + col
const CERCA  = texel(HALF, HALF)          // distancia 0 al cursor
const MEDIO  = texel(HALF, HALF - 1)      // a un texel
const LEJOS  = texel(0, 0)                // la esquina: el más lejano, y el PRIMERO del buffer

const byte = x => Math.round(x * 255)

// Pinta un texel como lo compone el fragment: el vértice aporta el índice LOCAL en b,a y el pase le
// SUMA el tag del draw en R, B y A. `local` va con la convención del packer (`slot + 1`), así que el 0
// es «el objeto, pero no una entrada». Devuelve los cuatro bytes para poder mirarlos.
const pintar = (frame, i, obj, chunk, local) => {
  const tag = packTag(obj, chunk)
  const px  = [byte((local >> 8) / 255 + tag[0]), byte((local & 255) / 255), byte(tag[1]), byte(tag[2])]
  frame.set(px, i * 4)
  return px
}

// Batch mínimo con la forma que declara el pase. En el doble los píxeles los pinta el test, así que lo
// único que el batch decide acá es que HAYA un draw: su tag no interviene en el decode.
const PASE = {
  draws  : [{ bind: () => {}, texture: null, mode: 0, first: 0, count: 1, obj: 1, chunk: 0 }],
  length : 1,
  matrix : new Float32Array(16),
}

const montar = (useDepth = false) => {
  const spy     = makePickSpy()
  const gl      = makeGl(null, spy)
  const picking = new Picking()
  picking.attach(gl, {}, {}, useDepth)
  return { picking, gl, spy, frame: spy.frame }
}

const impactos = hits => Array.from(hits.objects.slice(0, hits.count))
const pick     = (picking, cx = 100, cy = 100) => picking.pickSync(cx, cy, PASE, null).hits

/* ── 1. El reparto de bits ── */

const OBJETOS = [1, 63, 64, 16383]         // 63/64: la frontera del objeto entre los canales B y A
const CHUNKS  = [0, 15, 16, 63]            // 15/16: la frontera del chunk entre R y B
const LOCALES = [0, 1, 255, 256, 4095]     // 255/256: el acarreo del local de G a R; 0 = sin entrada

test('round-trip del reparto 14/6/12 en los bordes de los tres ejes', () => {
  const { picking, frame } = montar()
  OBJETOS.forEach(obj => CHUNKS.forEach(chunk => LOCALES.forEach(local => {
    const caso = `obj ${obj} · chunk ${chunk} · local ${local}`
    frame.fill(0)
    const px   = pintar(frame, CERCA, obj, chunk, local)
    const hits = pick(picking)
    assert.ok(px.every(v => v === (v & 255)), `${caso}: la suma del fragment desborda el byte`)
    assert.equal(hits.count, 1, caso)
    assert.deepEqual([hits.objects[0], hits.chunks[0], hits.slots[0]], [obj, chunk, local - 1], caso)
  })))
})

test('las constantes que exporta el codec son las que suman los 32 bits del píxel', () => {
  assert.deepEqual([OBJ_BITS, CHUNK_BITS, LOCAL_BITS], [14, 6, 12])
  assert.equal(OBJ_BITS + CHUNK_BITS + LOCAL_BITS, 32)
  assert.equal(packTag(1, 0), packTag(16383, 63), 'packTag corre por draw: escribe en un scratch reusado')
})

/* ── 2. Vacío es el WORD, no el alpha ── */

test('un objeto de 1..63 deja el alpha en 0 y NO es «vacío»: el guard es el word entero', () => {
  const { picking, frame } = montar()
  for (let obj = 1; obj < 1 << 6; obj++) {
    frame.fill(0)
    const px   = pintar(frame, CERCA, obj, 0, 1)
    const hits = pick(picking)
    assert.equal(px[3], 0, `obj ${obj}: el objeto entra entero en B, el alpha queda en 0`)
    assert.deepEqual([hits.count, hits.objects[0], hits.slots[0]], [1, obj, 0], `obj ${obj}`)
  }
  frame.fill(0)
  assert.equal(pick(picking).count, 0, 'vacío = las CUATRO componentes en 0, que es lo que deja el clear')
})

/* ── 3. Orden del barrido ── */

test('el orden es por cercanía al cursor, no por posición en el buffer', () => {
  const { picking, frame } = montar()
  // El más cercano vive en el ÚLTIMO índice de los dos: un barrido lineal lo entregaría segundo.
  pintar(frame, LEJOS, 7, 0, 1)
  pintar(frame, CERCA, 8, 0, 1)
  assert.deepEqual(impactos(pick(picking)), [8, 7])

  // Mismos texeles, identidades intercambiadas: manda la distancia, no el objeto ni el índice.
  frame.fill(0)
  pintar(frame, LEJOS, 8, 0, 1)
  pintar(frame, CERCA, 7, 0, 1)
  assert.deepEqual(impactos(pick(picking)), [7, 8])
})

test('el barrido es determinista: el mismo parche entrega siempre la misma secuencia', () => {
  const { picking, frame } = montar()
  pintar(frame, LEJOS, 7, 0, 1)
  pintar(frame, MEDIO, 9, 0, 1)
  pintar(frame, CERCA, 8, 0, 1)
  for (let i = 0; i < 5; i++)
    assert.deepEqual(impactos(pick(picking)), [8, 9, 7], `repetición ${i}`)
})

/* ── 4. Mailbox de un slot ── */

// El pase traslada el viewport para centrar el parche en el cursor; #restore lo devuelve a (0,0). El
// origen es entonces la huella observable de QUÉ muestra se dibujó.
const origenes = spy => spy.viewports.filter(v => v.x || v.y)

test('con un pick en vuelo el pedido nuevo se ENCOLA y dispara la ÚLTIMA muestra, no la primera', () => {
  const { picking, spy, frame } = montar()
  pintar(frame, CERCA, 5, 0, 1)
  const origenDe = (cx, cy) => { spy.viewports.length = 0; picking.pickSync(cx, cy, PASE, null); return spy.viewports[0] }
  const ultima   = origenDe(200, 100)
  const primera  = origenDe(10, 10)
  spy.viewports.length = 0
  spy.readbacks.length = 0

  assert.equal(picking.request(10, 10, PASE, 'primera'), true)
  assert.equal(picking.request(60, 60, PASE, 'segunda'), true, 'no se descarta por haber un pick en vuelo')
  assert.equal(picking.request(200, 100, PASE, 'ultima'), true)
  assert.equal(spy.readbacks.length, 1, 'un solo pase en vuelo: los siguientes esperan turno')
  assert.equal(picking.busy, true)

  assert.equal(picking.collect().metadata, 'primera')
  assert.equal(picking.pending, true, 'el encolado salió al liberarse el vuelo')
  assert.deepEqual(origenes(spy), [primera, ultima], 'el segundo pase se dibujó en la posición de la última muestra')
  assert.equal(picking.collect().metadata, 'ultima', "'segunda' fue PISADA en el mailbox, no encolada aparte")
  assert.equal(picking.busy, false)
  assert.equal(picking.collect(), null)
})

/* ── 5. Tamaño del destino ── */

// `spy.storage` guarda SÓLO el último storage pedido —acá el de profundidad—, así que lo que se afirma es
// la forma del ÚLTIMO adjunto; que los dos se pidan lo cuenta `renderbuffers`.
test('el destino mide un parche y no la pantalla, y con banda lleva profundidad', () => {
  const { picking, gl, spy } = montar(true)
  assert.deepEqual([spy.storage.width, spy.storage.height], [PATCH, PATCH])
  assert.notDeepEqual([spy.storage.width, spy.storage.height], [ANCHO, ALTO])
  assert.equal(spy.storage.width * spy.storage.height * 4, 144, 'el parche son 36 texeles: 144 bytes en el color')
  assert.equal(spy.renderbuffers, 2, 'color y profundidad')
  assert.deepEqual(spy.attachments, [gl.COLOR_ATTACHMENT0, gl.DEPTH_ATTACHMENT])

  picking.pickSync(400, 300, PASE, null)
  assert.deepEqual(spy.readbacks, [{ x: 0, y: 0, width: PATCH, height: PATCH }], 'y la lectura pide los mismos 144 bytes')
})

test('syncSize no reasigna el destino: no depende del drawing buffer', () => {
  const { picking, spy } = montar(true)
  for (let i = 0; i < 100; i++) picking.syncSize()
  assert.deepEqual([spy.renderbuffers, spy.framebuffers], [2, 1])
})

/* ── 6. Las DOS unidades: el cursor llega en px CSS y el parche se recorta en px del buffer ── */

// El texel del cursor —que con el viewport trasladado es el centro del parche— traído a píxeles del
// DRAWING BUFFER: con el origen en (-ox, -oy), el texel (HALF, HALF) ES el píxel (ox + HALF, oy + HALF).
// GL cuenta la y desde ABAJO, así que un cursor a `cy` del borde superior está a `alto - cy`.
const pixelLeido = ({ x, y }) => ({ x: -x + HALF, y: -y + HALF })

const montarSobre = superficie => {
  const spy     = makePickSpy()
  const picking = new Picking()
  picking.attach(makeGl(null, spy, superficie), {}, {})
  return { picking, spy }
}

const leerEn = (picking, spy, cx, cy) => {
  spy.viewports.length = 0
  picking.pickSync(cx, cy, PASE, null)
  return pixelLeido(spy.viewports[0])
}

test('el parche se recorta sobre el píxel del CURSOR, con la superficie a 1× y a 2×', () => {
  const [cx, cy] = [100, 90]
  ;[1, 2].forEach(dpr => {
    const { picking, spy } = montarSobre(makeSurface({ width: ANCHO, height: ALTO, dpr }))
    assert.deepEqual(leerEn(picking, spy, cx, cy), { x: cx * dpr, y: (ALTO - cy) * dpr },
      `dpr ${dpr}: el número CSS interpretado como píxel de dispositivo lee a media pantalla del cursor`)
  })
})

// La superficie de edición rinde a CSS × DPR y la de glify a tamaño CSS: en la misma pantalla conviven
// las dos, así que la escala tiene que salir del CANVAS y no de `devicePixelRatio`.
test('la escala sale del canvas: una superficie a tamaño CSS pickea igual en una pantalla HiDPI', () => {
  const previo = globalThis.devicePixelRatio
  globalThis.devicePixelRatio = 2
  try {
    const { picking, spy } = montarSobre(makeSurface({ width: ANCHO, height: ALTO }))
    assert.deepEqual(leerEn(picking, spy, 100, 90), { x: 100, y: ALTO - 90 })
  } finally { globalThis.devicePixelRatio = previo }
})

test('syncSize remide la escala: el canvas puede cambiar de caja sin cambiar de buffer', () => {
  const superficie = makeSurface({ width: ANCHO, height: ALTO })
  const { picking, spy } = montarSobre(superficie)
  assert.deepEqual(leerEn(picking, spy, 100, 90), { x: 100, y: ALTO - 90 })

  superficie.clientWidth /= 2                        // misma resolución, media caja → el doble de escala
  assert.deepEqual(leerEn(picking, spy, 100, 90), { x: 100, y: ALTO - 90 }, 'la medida vale hasta el resize')
  picking.syncSize()
  assert.deepEqual(leerEn(picking, spy, 100, 90), { x: 200, y: ALTO - 180 })
})

/* ── La costura con la capa: el pase sólo dibuja si la capa le arma el BATCH ── */

const items = ['A', 'B', 'C', 'D'].map((id, i) => ({ id, pos: { lat: i, lng: i } }))

const capa = () => {
  const glify = makeGlify()
  const layer = new PointLayer({
    glify, map: makeMap(), pane: 'p', iconSet: makeIconSet(), interactive: true,
    source: {
      accessors:   { idOf: it => it.id, positionOf: it => it.pos },
      getSnapshot: () => items,
      subscribe:   () => () => {},
    },
  })
  const { gl } = glify.layers[0]
  return { layer, gl, spy: gl.spy }
}

test('la capa arma el batch: un draw con su objeto, chunk 0 y el largo del buffer', () => {
  const { layer, gl, spy } = capa()
  layer.pickObject = 300                                   // la identidad que le asigna el motor

  pintar(spy.frame, CERCA, 300, 0, 3)                       // el vértice del slot 2, con ese tag
  const partes = layer.resolveClick({ containerPoint: { x: 10, y: 10 } })

  assert.deepEqual(spy.draws, [{ mode: gl.POINTS, first: 0, count: items.length }], 'sin batch el pase no dibuja nada')
  assert.deepEqual(spy.tags, [[0, (300 & 63) << 2, 300 >> 6]], 'el tag del draw es el objeto de la capa con chunk 0')
  assert.deepEqual(partes.map(p => p.id), ['C'], 'y el índice local vuelve al id de dato')
})

test('el pick asíncrono devuelve la MUESTRA como metadata: el cache de hover queda atado a su seq', () => {
  const { layer, spy } = capa()
  layer.pickObject = 1
  pintar(spy.frame, CERCA, 1, 0, 1)
  const sample = { containerPoint: { x: 10, y: 10 }, seq: 42 }

  assert.equal(layer.requestHoverHit(sample), true)
  assert.equal(layer.collectHoverHit(), sample)
  assert.deepEqual(layer.resolveHover({ seq: 42 }).map(p => p.id), ['A'])
  assert.deepEqual(layer.resolveHover({ seq: 43 }), [], 'otra muestra no hereda los hits de la anterior')
})
