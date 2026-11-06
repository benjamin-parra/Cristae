// Interaction.restack: el motor le corre el z o el orden a un participante de la puerta del puntero (un
// reasiento o un setLayerZ) y la próxima pulsación se reparte con el lugar nuevo. Es la misma entrada:
// no se duplica y la baja que devolvió `join` la sigue sacando. Corre con:
//   node --test test/engine/puerta-restack.test.mjs
//
// El arnés es el de puerta-del-puntero.test.mjs. Importa el helper de stubs PRIMERO: instala el shim
// window/document que la carga del árbol de Cristae toca por top-level.
import { makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Camera } from '../../src/engine/Camera.js'
import { Interaction } from '../../src/engine/Interaction.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

/* ── Harness ── */

const participante = (handleAt = () => true) => {
  const recibido = []
  const anotar   = tipo => (...args) => { recibido.push([tipo, ...args]) }
  return {
    recibido,
    handleAt,
    down     : anotar('down'),
    move     : anotar('move'),
    up       : anotar('up'),
    leave    : anotar('leave'),
    click    : anotar('click'),
    dblclick : () => false,
  }
}

const mount = ({ hits = [] } = {}) => {
  const map       = makeMap()
  const container = map.getContainer()
  const clicks    = []
  const host      = adoptLeafletHost(map, { leaflet: makeLeaflet() })
  const puerta    = new Interaction({
    host, camera: new Camera({ host }), pickLayers: () => [],
    registry : { resolveHits: () => hits },
    bus      : { dispatch: kind => kind === 'click' && clicks.push(kind) },
  })
  return { container, clicks, puerta }
}

const emitir   = (esc, tipo, x, y) => esc.container.emitir(tipo, { clientX: x, clientY: y })
const clickear = (esc, x, y) => { emitir(esc, 'pointerdown', x, y); emitir(esc, 'pointerup', x, y) }
const tipos    = p => p.recibido.map(([tipo]) => tipo)
const vaciar   = (...ps) => ps.forEach(p => { p.recibido.length = 0 })

/* ── restack ── */

test('restack del de abajo por encima: la próxima pulsación la toma él', () => {
  const esc    = mount()
  const abajo  = participante()
  const arriba = participante()
  esc.puerta.join(abajo, 500, 1)
  esc.puerta.join(arriba, 600, 2)

  clickear(esc, 0, 0)
  assert.deepEqual({ arriba: tipos(arriba), abajo: tipos(abajo) }, { arriba: ['down', 'up'], abajo: [] })

  vaciar(abajo, arriba)
  assert.equal(esc.puerta.restack(abajo, 700, 1), true)
  clickear(esc, 0, 0)
  assert.deepEqual({ arriba: tipos(arriba), abajo: tipos(abajo) }, { arriba: [], abajo: ['down', 'up'] })
})

test('con el mismo z, restack a un orden menor gana el desempate', () => {
  const esc = mount()
  const a   = participante()
  const b   = participante()
  esc.puerta.join(a, 500, 1)
  esc.puerta.join(b, 500, 2)

  esc.puerta.restack(b, 500, 0)
  clickear(esc, 0, 0)
  assert.deepEqual({ a: tipos(a), b: tipos(b) }, { a: [], b: ['down', 'up'] })
})

// El dueño se decide contra el hit de click con el z de la entrada: el restack lo mueve sobre la capa.
test('restack por encima del hit de una capa le devuelve la pulsación al participante', () => {
  const esc    = mount({ hits: [{ layerId: 'capa', zIndex: 600, order: 3 }] })
  const editor = participante()
  esc.puerta.join(editor, 500, 1)

  clickear(esc, 0, 0)
  assert.deepEqual(tipos(editor), ['click'], 'debajo de la capa, la pulsación es del mapa')

  vaciar(editor)
  esc.puerta.restack(editor, 700, 1)
  clickear(esc, 0, 0)
  assert.deepEqual({ editor: tipos(editor), clicks: esc.clicks }, { editor: ['down', 'up'], clicks: ['click'] })
})

test('restack no duplica: una pulsación tiene un solo dueño y un move llega una vez a cada uno', () => {
  const esc    = mount()
  const abajo  = participante()
  const arriba = participante()
  esc.puerta.join(abajo, 500, 1)
  esc.puerta.join(arriba, 600, 2)

  esc.puerta.restack(abajo, 700, 1)
  esc.puerta.restack(abajo, 800, 1)
  esc.puerta.restack(arriba, 650, 2)
  clickear(esc, 0, 0)
  emitir(esc, 'pointermove', 5, 0)

  assert.deepEqual(
    { abajo: tipos(abajo), arriba: tipos(arriba) },
    { abajo: ['down', 'up', 'move'], arriba: ['move'] },
  )
})

test('la pulsación en curso conserva su dueño: el restack cuenta desde la próxima', () => {
  const esc    = mount()
  const abajo  = participante()
  const arriba = participante()
  esc.puerta.join(abajo, 500, 1)
  esc.puerta.join(arriba, 600, 2)

  emitir(esc, 'pointerdown', 0, 0)
  esc.puerta.restack(abajo, 700, 1)
  emitir(esc, 'pointermove', 1, 0)
  emitir(esc, 'pointerup', 1, 0)
  assert.deepEqual({ arriba: tipos(arriba), abajo: tipos(abajo) }, { arriba: ['down', 'move', 'up'], abajo: [] })

  vaciar(abajo, arriba)
  clickear(esc, 0, 0)
  assert.deepEqual({ arriba: tipos(arriba), abajo: tipos(abajo) }, { arriba: [], abajo: ['down', 'up'] })
})

test('la baja que devolvió join lo sigue sacando después de un restack', () => {
  const esc    = mount()
  const editor = participante()
  const otro   = participante(() => false)
  const salir  = esc.puerta.join(editor, 500, 1)
  esc.puerta.join(otro, 600, 2)

  esc.puerta.restack(editor, 700, 1)
  salir()
  clickear(esc, 0, 0)
  emitir(esc, 'pointermove', 5, 0)

  assert.deepEqual(
    { editor: tipos(editor), otro: tipos(otro), clicks: esc.clicks, otraVez: esc.puerta.restack(editor, 800, 1) },
    { editor: [], otro: ['click', 'move'], clicks: ['click'], otraVez: false },
  )
})

test('restack de un participante ausente devuelve false y no lo suma', () => {
  const esc   = mount()
  const unido = participante()
  const ajeno = participante()
  esc.puerta.join(unido, 500, 1)

  assert.equal(esc.puerta.restack(ajeno, 900, 0), false)
  clickear(esc, 0, 0)
  emitir(esc, 'pointermove', 5, 0)
  assert.deepEqual({ unido: tipos(unido), ajeno: tipos(ajeno) }, { unido: ['down', 'up', 'move'], ajeno: [] })
})
