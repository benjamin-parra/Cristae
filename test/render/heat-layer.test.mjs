// Contrato de HeatLayer (backend canvas 2D acumulativo): monta contra el harness headless, estampa una
// brocha por punto EN pantalla (culling de los de afuera), consulta `colorRamp` para armar la paleta y
// coloriza (getImageData → putImageData) sin throwear. El harness se importa PRIMERO (shimea
// window/document + expone makeMap). El ctx del canvas se instrumenta acá con un spy funcional (el ctx
// no-op del harness no ejercería createRadialGradient/getImageData), para verificar el pipeline entero.
import { makeMap } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { HeatLayer } from '../../src/render/HeatLayer.js'
import { createSource } from '../../src/data/Source.js'

/* ── Spy de canvas 2D: cuenta las llamadas del pipeline y CAPTURA lo que hace falta para morder los
   bugs: el globalAlpha con que se estampa cada brocha (densidad vs saturación) y el framebuffer que se
   escribe colorizado (mapeo alpha→color). `createRadialGradient` throwea con radio<0 como el API real
   (el ctx no-op no lo haría → el guard de radius/blur negativo quedaría sin cobertura). ── */

const installCanvasSpy = () => {
  const calls = { gradient: 0, drawImage: 0, getImageData: 0, putImageData: 0, alphas: [], lastImageData: null }
  const ctx = {
    globalAlpha: 1,
    fillStyle: null,
    clearRect() {}, fillRect() {},
    createRadialGradient(x0, y0, r0, x1, y1, r1) {
      // El API real (CanvasRenderingContext2D) lanza IndexSizeError si algún radio es negativo.
      if (r0 < 0 || r1 < 0) throw new Error('IndexSizeError: radio negativo en createRadialGradient')
      calls.gradient++
      return { addColorStop() {} }
    },
    drawImage() { calls.drawImage++; calls.alphas.push(this.globalAlpha) },
    getImageData(x, y, w, h) {
      calls.getImageData++
      // Alpha 128 en cada pixel → la colorización recorre la paleta para todos con un alpha CONOCIDO.
      const data = new Uint8ClampedArray(Math.max(w * h, 1) * 4)
      for (let i = 3; i < data.length; i += 4) data[i] = 128
      return { data, width: w, height: h }
    },
    putImageData(img) { calls.putImageData++; calls.lastImageData = img?.data },
  }
  const orig = document.createElement
  document.createElement = (tag) => (String(tag).toLowerCase() === 'canvas'
    ? { width: 0, height: 0, className: '', style: {}, getContext: () => ctx, appendChild() {}, remove() {} }
    : orig.call(document, tag))
  return { calls, restore: () => { document.createElement = orig } }
}

const idOf = (it) => it.id
const positionOf = (it) => it.pos
const weightOf = (it) => it.w

// Puntos EN pantalla: latLngToContainerPoint del harness = {x: lng*100, y: lat*100}; viewport 800×600.
const onScreen = [
  { id: 1, pos: { lat: 1, lng: 1 }, w: 1 },
  { id: 2, pos: { lat: 2, lng: 3 }, w: 5 },
  { id: 3, pos: { lat: 1.5, lng: 4 }, w: 3 },
]

const mount = (points, opts = {}, accessors = { idOf, positionOf, weightOf }) => {
  const spy = installCanvasSpy()
  const map = makeMap()
  const source = createSource(accessors)
  source.set(points)
  const layer = new HeatLayer({ glify: {}, map, pane: 'heat', source, ...opts })
  return { spy, map, source, layer }
}

test('construye sin throwear, consulta colorRamp para la paleta y arma la brocha', () => {
  let rampCalls = 0
  const colorRamp = (t) => { rampCalls++; return [t, 0, 1 - t, 1] }
  const { spy, layer } = mount(onScreen, { colorRamp })

  assert.ok(rampCalls >= 256, `colorRamp se muestrea GRAD_STEPS veces (fue ${rampCalls})`)
  assert.ok(spy.calls.gradient >= 1, 'la brocha se construye con un degradado radial')
  assert.ok(layer, 'la capa se construyó')
  layer.destroy()
  spy.restore()
})

test('estampa una brocha por cada punto EN pantalla y coloriza (getImageData → putImageData)', () => {
  const { spy, layer } = mount(onScreen)
  // El primer paint (constructor) ya dibujó; reseteo y fuerzo un redraw síncrono para contar limpio.
  spy.calls.drawImage = 0
  spy.calls.getImageData = 0
  spy.calls.putImageData = 0
  layer.redraw()

  assert.equal(spy.calls.drawImage, onScreen.length, 'una estampa por punto visible')
  assert.ok(spy.calls.getImageData >= 1, 'lee el framebuffer para colorizar')
  assert.ok(spy.calls.putImageData >= 1, 'escribe el framebuffer colorizado')
  layer.destroy()
  spy.restore()
})

test('descarta (cull) los puntos fuera del viewport', () => {
  const puntos = [
    { id: 1, pos: { lat: 1, lng: 1 }, w: 1 },       // dentro
    { id: 2, pos: { lat: 999, lng: 999 }, w: 1 },    // y = 99900 px → muy afuera
  ]
  const { spy, layer } = mount(puntos)
  spy.calls.drawImage = 0
  layer.redraw()

  assert.equal(spy.calls.drawImage, 1, 'sólo el punto dentro del viewport se estampa')
  layer.destroy()
  spy.restore()
})

// Bug #1 (EL bug): con pesos uniformes (weightOf ausente) e intensity=1 default, el aporte por punto NO
// debe ser 1 (saturaría los cores a disco sólido). Debe ser CHICO para que source-over acumule densidad.
test('bug#1: weightOf ausente + intensity default ⇒ alpha por punto CHICO (densidad ACUMULA, no satura)', () => {
  const { spy, layer } = mount(onScreen, {}, { idOf, positionOf })   // sin weightOf → pesos uniformes
  spy.calls.alphas.length = 0
  spy.calls.drawImage = 0
  layer.redraw()

  assert.equal(spy.calls.alphas.length, onScreen.length, 'una estampa por punto')
  // Sin peso, todos los puntos comparten el MISMO aporte (uniforme)…
  assert.ok(spy.calls.alphas.every((a) => a === spy.calls.alphas[0]), 'aporte uniforme sin weightOf')
  // …y ese aporte es CHICO: con alpha=1 (el bug) los cores opacos saturarían a disco sólido.
  for (const a of spy.calls.alphas) {
    assert.ok(a > 0 && a < 0.5, `el aporte por punto es chico para acumular densidad (fue ${a}, debe ser <0.5)`)
    assert.ok(a < 1, 'un aporte de 1 satura source-over al toque (disco sólido, no densidad)')
  }
  layer.destroy()
  spy.restore()
})

// Contrapositivo: subir intensity acerca el aporte a la saturación (semántica "más caliente").
test('bug#1: intensity>1 sube el aporte por punto (satura antes), pero nunca pasa de 1', () => {
  const alto = mount(onScreen, { intensity: 100 }, { idOf, positionOf })
  alto.spy.calls.alphas.length = 0
  alto.layer.redraw()
  for (const a of alto.spy.calls.alphas)
    assert.ok(a === 1, `intensity alto clampa el aporte a 1 (fue ${a})`)
  alto.layer.destroy(); alto.spy.restore()

  const bajo = mount(onScreen, { intensity: 1 }, { idOf, positionOf })
  bajo.spy.calls.alphas.length = 0
  bajo.layer.redraw()
  const aporteDefault = bajo.spy.calls.alphas[0]
  assert.ok(aporteDefault < 1, 'con intensity default el aporte deja margen para acumular')
  bajo.layer.destroy(); bajo.spy.restore()
})

// Bug #2: un radius/blur negativo en el setter NO debe throwear (createRadialGradient con radio<0 lanza).
// Se elige un negativo cuyo R = radius+blur quede < 0 SIN el guard (blur default 15, radius -30 → R=-15).
test('bug#2: radius/blur negativo en el setter no throwea (no createRadialGradient con radio<0)', () => {
  const { spy, layer } = mount(onScreen)

  // Sin el guard: radius=-30 + blur=15 ⇒ R=-15 ⇒ createRadialGradient(...,-15) throwea.
  assert.doesNotThrow(() => { layer.radius = -30 }, 'radius negativo se satura a >=0')
  // Sin el guard: blur=-30 + radius=25 ⇒ R=-5 ⇒ throwea.
  assert.doesNotThrow(() => { layer.blur = -30 }, 'blur negativo se satura a >=0')
  // Y radius=blur=0 (ambos al piso) tampoco throwea (0/0 → NaN en el core sin el guard R>0).
  assert.doesNotThrow(() => { layer.radius = 0; layer.blur = 0 }, 'radius=blur=0 no rompe el core del degradado')

  layer.destroy()
  spy.restore()
})

// Bug #3: la ruta del Source debe dibujar SÍNCRONO en el callback (el Emitter ya coalescó a rAF); un rAF
// propio ahí sería un doble rAF (2º frame de latencia). El rAF queda SÓLO para eventos de mapa.
//   - El Emitter entrega vía setTimeout(0) (rAF cacheado del harness) → se drena con un macrotask real.
//   - El rAF del layer usa globalThis.requestAnimationFrame (resuelto al llamar) → se intercepta acá.
test('bug#3: la ruta del Source dibuja SÍNCRONO (sin doble rAF); el rAF queda para eventos de mapa', async () => {
  const rafQ = []
  const origRaf = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length }
  try {
    const { spy, layer, source, map } = mount(onScreen)
    // Drena el emit del `set` inicial (agendado antes de suscribir el layer) y limpia contadores.
    await new Promise((r) => setTimeout(r, 5))
    rafQ.length = 0
    spy.calls.putImageData = 0

    // Cambio del Source: el Emitter lo entrega en un macrotask; el callback del layer debe dibujar YA.
    source.set([...onScreen, { id: 9, pos: { lat: 1, lng: 2 }, w: 1 }])
    await new Promise((r) => setTimeout(r, 5))

    assert.equal(rafQ.length, 0, 'la ruta del Source NO agenda un rAF propio (sin doble rAF)')
    assert.ok(spy.calls.putImageData >= 1, 'dibujó SÍNCRONO al recibir el cambio del Source')

    // En cambio, un evento de MAPA sí coalesce a rAF: no dibuja hasta el frame.
    spy.calls.putImageData = 0
    map.fire('moveend')
    assert.equal(rafQ.length, 1, 'un evento de mapa agenda exactamente un rAF')
    assert.equal(spy.calls.putImageData, 0, 'no dibuja hasta que llega el frame')
    rafQ.splice(0).forEach((cb) => cb(0))                 // corre el frame
    assert.ok(spy.calls.putImageData >= 1, 'dibuja al llegar el frame del evento de mapa')

    layer.destroy()
    spy.restore()
  } finally {
    globalThis.requestAnimationFrame = origRaf
  }
})

// Bug #4: la colorización mapea el alpha ACUMULADO al color de la rampa. Se captura el framebuffer que
// va a putImageData y se asertan índice (qué entrada de la paleta) Y canales (r,g,b,a en su lugar). La
// rampa tiene 3 canales DISTINTOS en función de t → un swap de canal o un índice corrido se detecta.
test('bug#4: colorize mapea un alpha conocido al color EXACTO de la rampa (índice y canales)', () => {
  const ramp = (t) => [t, t * 0.5, 1 - t, 1]
  const { spy, layer } = mount(onScreen, { colorRamp: ramp })
  spy.calls.lastImageData = null
  layer.redraw()

  const out = spy.calls.lastImageData
  assert.ok(out, 'putImageData recibió el framebuffer colorizado')

  // El spy alimenta alpha=128 en cada pixel. Reproduzco la MISMA aritmética + clamp del layer para el
  // esperado (paleta muestreada en t=alpha/255; alpha final = alpha·paleta.a/255).
  const A = 128
  const c = ramp(A / (256 - 1))
  const pal = new Uint8ClampedArray(4)
  pal[0] = c[0] * 255; pal[1] = c[1] * 255; pal[2] = c[2] * 255; pal[3] = c[3] * 255
  const finalA = new Uint8ClampedArray(1)
  finalA[0] = (A * pal[3]) / 255

  // Valores concretos (que el índice/canal correctos deben producir): [128, 64, 127, 128].
  assert.equal(pal[0], 128); assert.equal(pal[1], 64); assert.equal(pal[2], 127); assert.equal(finalA[0], 128)

  assert.equal(out[0], pal[0], 'R = paleta[alpha].r (índice del alpha correcto)')
  assert.equal(out[1], pal[1], 'G = paleta[alpha].g (sin swap de canal)')
  assert.equal(out[2], pal[2], 'B = paleta[alpha].b')
  assert.equal(out[3], finalA[0], 'alpha final = alpha·paleta[alpha].a/255')

  // Un pixel con alpha 0 (no acumulado) se salta: queda transparente, no toma color.
  assert.equal(out[4 * 1 + 3] !== undefined, true)   // el buffer cubre >1 pixel

  layer.destroy()
  spy.restore()
})

test('redibuja ante cambios del Source y props en vivo sin throwear', () => {
  const { spy, layer, source } = mount(onScreen)
  assert.doesNotThrow(() => {
    layer.radius = 40           // reconstruye la brocha
    layer.intensity = 2
    layer.colorRamp = (t) => [0, t, 0, 1]   // re-muestrea la paleta
    source.set([...onScreen, { id: 4, pos: { lat: 2, lng: 2 }, w: 2 }])
    layer.refresh()
    layer.resetCanvasReference()
    layer.redraw()
  })
  layer.destroy()
  spy.restore()
})
