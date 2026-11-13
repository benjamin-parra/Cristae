// El ciclo de vida del renderer `gl` de los rótulos sin GPU: lo que no cubre label-gl.test.mjs y la revisión de U3 y U4
// mostró que ninguna prueba sostenía (cada caso falla con la línea rota):
//   · el picking sólo ve miembros visibles y entrega el z del renderer; `hasContent` sigue a la visibilidad;
//   · la vista inyectada del zoom animado vale hasta que el motor reasienta, y una pérdida de contexto la olvida;
//   · el z se pasa al pane; cada dibujo limpia la textura del miembro;
//   · una fuente que termina de cargar vuelve a rasterizar sus glifos una vez y recoloca;
//   · el realm sigue pidiendo cuadros mientras queden glifos sin rasterizar;
//   · las instancias de un restyle suben con bufferSubData, no con una asignación nueva.
// Corre con: node --test test/render/label-gl-ciclo.test.mjs
import { PUNTOS, glFalso, instalarMedida, miembro, montar } from '../../test-helpers/rotulos-gl.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

after(instalarMedida())

const espera = ms => new Promise(res => setTimeout(res, ms))
const factor = z => 2 * 2 ** z / 800

test('el picking sólo ve miembros visibles y entrega el z del renderer; hasContent sigue a la visibilidad', () => {
  const { r } = montar()
  assert.equal(r.hasContent, false, 'sin miembros no hay nada que dibujar')
  const m = miembro({ items: PUNTOS })
  r.attach(m)
  r.resetCanvasReference()
  assert.equal(r.hasContent, true)
  const todos = []
  for (let x = 0; x < 800; x += 4) for (let y = 0; y < 600; y += 4) r.hitsAt(m, { x, y }, todos)
  assert.ok(todos.length > 0, 'el barrido toca rótulos')
  assert.deepEqual([...new Set(todos.map(p => p.zIndex))], [7], 'el z del renderer, que el motor ordena contra los demás')
  m.visible = false
  assert.equal(r.hasContent, false, 'oculto no hay nada que dibujar')
  const ocultos = []
  for (let x = 0; x < 800; x += 4) for (let y = 0; y < 600; y += 4) r.hitsAt(m, { x, y }, ocultos)
  assert.deepEqual(ocultos, [], 'un miembro oculto no se pica')
  r.destroy()
})

test('la vista inyectada vale hasta que el motor reasienta; una pérdida de contexto la olvida', () => {
  const { host, r, s } = montar()
  r.attach(miembro({ items: PUNTOS }))
  r.resetCanvasReference()
  r.renderAtView(15, { lat: -33.4, lng: -70.6 })
  r.repaint()
  assert.ok(Math.abs(s.log.matrices.at(-1)[0] / factor(15) - 1) < 1e-6, 'repinta con la vista inyectada')
  r.resetCanvasReference()
  assert.ok(Math.abs(s.log.matrices.at(-1)[0] / factor(host.state.zoom) - 1) < 1e-6, 'al reasentar vuelve a la de la cámara')
  host.center.lng += 0.01
  r.repaint()
  assert.ok(Math.abs(s.log.matrices.at(-1)[12] - s.log.matrices.at(-2)[12]) > 1e-4, 'tras reasentar sigue a la cámara, no a la última inyectada')
  r.renderAtView(15, { lat: -33.4, lng: -70.6 })
  r.dropGl()
  const otro = glFalso()
  r.buildGl(otro.gl)
  assert.ok(otro.log.draws.length > 0, 'el contexto nuevo dibuja en el acto')
  assert.ok(Math.abs(otro.log.matrices[0][0] / factor(host.state.zoom) - 1) < 1e-6, 'con la vista de la cámara y no con la inyectada del contexto muerto')
  const antes = otro.log.draws.length
  r.dropGl()
  r.repaint()
  r.renderAtView(12, { lat: -33.4, lng: -70.6 })
  assert.equal(otro.log.draws.length, antes, 'sin contexto no dibuja')
  r.destroy()
})

test('el z va al pane y cada dibujo limpia la textura del miembro', () => {
  const { host, r, s } = montar()
  const puestos = []
  host.surface.setZ = (pane, z) => puestos.push([pane, z])
  assert.equal(r.setZ(7), false, 'el mismo z no cambia nada')
  assert.equal(r.setZ(9), true)
  assert.deepEqual(puestos, [['cristae-labels-gl', 9]])
  assert.equal(r.zIndex, 9)
  r.attach(miembro({ items: PUNTOS }))
  let limpias = 0
  s.gl.clear = () => limpias++
  r.resetCanvasReference()
  host.center.lng += 1e-3
  r.resetCanvasReference()
  assert.equal(limpias, 2, 'un clear por dibujo')
  r.destroy()
})

test('los restyle suben con bufferSubData sobre la misma reserva, no con una asignación nueva', () => {
  const { r, s } = montar()
  const m = miembro({ items: PUNTOS })
  r.attach(m)
  r.resetCanvasReference()
  const datas = s.log.datas.length
  m.hovered.add('a')
  r.invalidate(m, 'hover')
  r.repaint()
  assert.equal(s.log.datas.length, datas, 'la reserva de la GPU alcanza')
  assert.equal(s.log.subs.length, 1, 'sube lo que ocupa')
})

test('una fuente que termina de cargar vuelve a rasterizar sus glifos una vez y recoloca lo que la usa', async () => {
  let carga = null
  const cargas = []
  globalThis.document.fonts = { load: f => (cargas.push(f), new Promise(ok => (carga = ok))) }
  try {
    const { r, atlas } = montar()
    const olvidos = []
    const forget = atlas.forget
    atlas.forget = f => (olvidos.push(f), forget(f))
    let pedidos = 0
    const glyph = atlas.glyph
    atlas.glyph = (k, u) => (pedidos++, glyph(k, u))
    const a = miembro({ id: 'a', items: PUNTOS })
    const b = miembro({ id: 'b', items: PUNTOS })
    r.attach(a)
    r.attach(b)
    r.resetCanvasReference()
    assert.deepEqual(cargas, [a.opts.font], 'una sola espera por fuente, aunque la usen dos miembros')
    const antes = pedidos
    carga()
    await espera(30)
    assert.deepEqual(olvidos, [a.opts.font], 'el atlas rasteriza de nuevo con los mismos ids')
    assert.ok(pedidos > antes, 'cada miembro recoloca con la fuente cargada')
    r.destroy()
  } finally {
    delete globalThis.document.fonts
  }
})

test('mientras queden glifos sin rasterizar, el realm sigue pidiendo cuadros', async () => {
  const { r, atlas } = montar()
  const flush = atlas.flush
  let llamadas = 0
  atlas.flush = (...a) => (llamadas++, llamadas === 1 ? (flush(...a), 1) : flush(...a))
  r.attach(miembro({ items: PUNTOS }))
  r.resetCanvasReference()
  for (let i = 0; i < 50 && llamadas < 2; i++) await espera(5)
  assert.ok(llamadas >= 2, 'con glifos pendientes pide el cuadro siguiente')
  r.destroy()
})

test('destruido, el renderer sale del realm: el atlas compartido ya no lo repinta', async () => {
  const { r: a, atlas } = montar()
  const { r: b } = montar({ atlas })
  a.attach(miembro({ items: PUNTOS }))
  a.resetCanvasReference()
  a.destroy()
  let repintadas = 0
  a.repaint = () => repintadas++
  b.attach(miembro({ items: [{ id: 'n', lat: -33.5, lng: -70.7, text: 'Nuevo glifo ñ' }] }))
  b.resetCanvasReference()
  for (let i = 0; i < 50 && atlas.pending; i++) await espera(5)
  assert.equal(atlas.pending, 0)
  assert.equal(repintadas, 0)
  b.destroy()
})
