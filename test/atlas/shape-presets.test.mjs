// Fija los presets de FORMA: cada forma construye un IconSet donde la variante es el color de relleno,
// el atlas crece por color DISTINTO (no por ítem), `sprite(color)` entrega un canvas rasterizado y el
// set nunca rota. El harness shimea window/document (canvas no-op) — probamos direccionamiento y contrato,
// no el pixel. Se importa PRIMERO para que el shim exista antes de que #rasterize toque document.
import '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { shapePresetIconSet, RENDERERS } from '../../src/atlas/shape-presets.js'

const FORMAS = ['dot', 'pin', 'circle']
const ROJO = '#ff0000'
const AZUL = '#0000ff'

// ctx espía: registra cada llamada de dibujo con sus argumentos y guarda las props de estilo. Sirve para
// asertar que CADA forma efectivamente dibuja (una forma que no llama a nada pintaría un tile vacío en
// silencio: eso es el bug que buscamos morder). El harness real es no-op, por eso el spy es propio.
const spyCtx = () => {
  const calls = []
  const rec = (name) => (...args) => { calls.push({ name, args }); return undefined }
  return {
    calls,
    of: (name) => calls.filter((c) => c.name === name),
    called: (name) => calls.some((c) => c.name === name),
    beginPath: rec('beginPath'),
    closePath: rec('closePath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    arc: rec('arc'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    fillStyle: undefined,
    strokeStyle: undefined,
    lineWidth: undefined,
  }
}

const SIZE = 100

for (const shape of FORMAS) {
  test(`${shape}: la variante es el color; el atlas crece por color distinto, no por ítem`, async () => {
    const set = await shapePresetIconSet({ shape }).ready

    assert.equal(set.rotates, false)                 // una forma coloreada no tiene rumbo
    assert.equal(set.atlas.count, 0)                 // sin variantes declaradas: atlas vacío al inicio

    const iRojo = set.resolve(ROJO)
    const iAzul = set.resolve(AZUL)
    assert.notEqual(iRojo, iAzul)                    // dos colores → dos tiles
    assert.equal(set.atlas.count, 2)

    // Reresolver el MISMO color no agrega tile (direcciona por variante, no por ítem).
    assert.equal(set.resolve(ROJO), iRojo)
    assert.equal(set.atlas.count, 2)

    // sprite(color) devuelve el canvas rasterizado de esa variante (reuso fuera del mapa).
    const canvas = set.sprite(ROJO)
    assert.ok(canvas && typeof canvas.getContext === 'function')
  })
}

test('describe es total: cualquier string entra como color sin lanzar', async () => {
  const set = await shapePresetIconSet({ shape: 'dot' }).ready
  assert.doesNotThrow(() => set.resolve('rebeccapurple'))
  assert.doesNotThrow(() => set.resolve('no-es-un-color'))   // degrada al default del canvas, no excepción
})

test('size fija el tamaño en pantalla por defecto (defaultSize)', async () => {
  const set = await shapePresetIconSet({ shape: 'circle', size: 40 }).ready
  assert.equal(set.defaultSize, 40)
})

test('forma desconocida lanza en construcción (no degrada silenciosa)', () => {
  assert.throws(() => shapePresetIconSet({ shape: 'hexagono' }), /forma desconocida/)
})

test('RENDERERS expone las tres formas para composición', () => {
  assert.deepEqual(Object.keys(RENDERERS).sort(), ['circle', 'dot', 'pin'])
  for (const f of FORMAS) assert.equal(typeof RENDERERS[f], 'function')
})

// --- Cada forma DIBUJA algo (nada de pintar un tile vacío en silencio) -----------------------------

test('dot: dibuja un disco relleno con el color (arc + fill), centrado en el tile', () => {
  const ctx = spyCtx()
  RENDERERS.dot(ctx, SIZE, { shape: 'dot', color: ROJO })

  const arcs = ctx.of('arc')
  assert.equal(arcs.length, 1, 'dot debe trazar exactamente un arco')
  const [x, y, r] = arcs[0].args
  assert.equal(x, SIZE / 2)                         // centrado horizontalmente
  assert.equal(y, SIZE / 2)                         // centrado verticalmente (marca el punto)
  assert.ok(r > 0, 'radio del disco debe ser positivo')
  assert.ok(ctx.called('fill'), 'dot debe rellenar (si no, no pinta nada)')
  assert.equal(ctx.fillStyle, ROJO, 'el relleno usa el color de la variante')
  assert.ok(!ctx.called('stroke'), 'el disco es relleno, no trazo')
})

test('circle: dibuja un anillo con el color (arc + stroke grueso), centrado en el tile', () => {
  const ctx = spyCtx()
  RENDERERS.circle(ctx, SIZE, { shape: 'circle', color: AZUL })

  const arcs = ctx.of('arc')
  assert.equal(arcs.length, 1, 'circle debe trazar exactamente un arco')
  const [x, y, r] = arcs[0].args
  assert.equal(x, SIZE / 2)
  assert.equal(y, SIZE / 2)
  assert.ok(r > 0, 'radio del anillo debe ser positivo')
  assert.ok(ctx.called('stroke'), 'circle debe trazar (si no, no pinta nada)')
  assert.equal(ctx.strokeStyle, AZUL, 'el trazo usa el color de la variante')
  assert.ok(ctx.lineWidth > 0, 'el grosor del anillo debe ser positivo')
  assert.ok(!ctx.called('fill'), 'el anillo es hueco: no se rellena')
})

test('pin: dibuja bulbo + punta rellenos (arc + lineTo + fill) y la PUNTA marca el centro del tile', () => {
  const ctx = spyCtx()
  RENDERERS.pin(ctx, SIZE, { shape: 'pin', color: ROJO })

  const arcs = ctx.of('arc')
  assert.equal(arcs.length, 1, 'pin traza el bulbo con un arco')
  assert.ok(ctx.called('lineTo'), 'pin baja a la punta con un segmento (si no, no hay gota)')
  assert.ok(ctx.called('fill'), 'pin debe rellenar (si no, no pinta nada)')
  assert.equal(ctx.fillStyle, ROJO, 'el relleno usa el color de la variante')

  // Bug del anclaje: la punta (vértice que marca el punto) DEBE caer en el centro exacto del tile,
  // porque el atlas centra el sprite en la coordenada sin anchor-offset.
  const puntaEnCentro = ctx.of('lineTo').some(({ args: [x, y] }) => x === SIZE / 2 && y === SIZE / 2)
  assert.ok(puntaEnCentro, 'la punta del pin debe estar en (size/2, size/2) para marcar el punto')

  // El bulbo queda ARRIBA de la punta (centro del arco con menor y que la punta central).
  const [, cy] = arcs[0].args
  assert.ok(cy < SIZE / 2, 'el bulbo del pin debe quedar por encima de la punta')
})
