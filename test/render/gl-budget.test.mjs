// La política de recuperación (src/render/gl-budget.js) con superficies de mentira: lo que decide ella y no la superficie.
// Se re-adquiere una por cuadro y en el orden en que se perdieron; una pérdida dentro del segundo siguiente a una recuperación es
// falta de cupo y vacía la cola; una que tira al re-adquirir se suelta; y en pleno zoom animado se espera a que asiente. Con
// superficies reales, y navegadores que desalojan, la prueban pointlayer-readquirir y test/element/contextos-readquirir.
// Corre con: node --test test/render/gl-budget.test.mjs
import { after, afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { glBudget } from '../../src/render/gl-budget.js'

/* ── Cuadros a mano, y un reloj que avanza entre test y test ── */

const rafPrevio    = globalThis.requestAnimationFrame
const cancelPrevio = globalThis.cancelAnimationFrame
const agendados    = new Map()
let serie          = 0
globalThis.requestAnimationFrame = cb => (agendados.set(++serie, cb), serie)
globalThis.cancelAnimationFrame  = id => agendados.delete(id)

const cuadro = () => {
  const ahora = [...agendados.values()]
  agendados.clear()
  ahora.forEach(cb => cb(0))
}

// La ventana de un segundo es estado del módulo: cada test empieza lejos de la recuperación del anterior.
const reloj   = performance.now.bind(performance)
let   desfase = 0
performance.now = () => reloj() + desfase
beforeEach(() => { desfase += 10_000 })

after(() => {
  globalThis.requestAnimationFrame = rafPrevio
  globalThis.cancelAnimationFrame  = cancelPrevio
  performance.now                  = reloj
})

// Superficies de mentira: anotan lo que la política les pide.
const llamadas = []
const hechas   = []
const nueva = (nombre, { tira = false, zooming = false } = {}) => {
  const surface = {
    nombre, zooming,
    acquire() {
      llamadas.push(['acquire', nombre])
      if (tira) throw new Error(`${nombre}: sin cupo`)
    },
    release() { llamadas.push(['release', nombre]) },
  }
  hechas.push(surface)
  return surface
}

// Lo que quedó esperando se resuelve antes del test siguiente: el módulo recuerda su cuadro agendado, y una espera de zoom que
// nadie apaga lo dejaría ocupado para siempre.
afterEach(() => {
  hechas.forEach(surface => {
    surface.zooming = false
    glBudget.dropped(surface)
  })
  for (let i = 0; agendados.size && i < 20; i++) cuadro()
  agendados.clear()
  llamadas.length = 0
  hechas.length   = 0
})

const nombres = accion => llamadas.filter(([a]) => a === accion).map(([, n]) => n)

/* ── Una por cuadro ── */

test('re-adquiere de a una por cuadro, en el orden en que se perdieron', () => {
  const [a, b, c] = ['a', 'b', 'c'].map(n => nueva(n))
  ;[a, b, c].forEach(s => glBudget.lost(s))
  assert.deepEqual(nombres('acquire'), [], 'el aviso no toma nada: espera al cuadro')

  cuadro()
  assert.deepEqual(nombres('acquire'), ['a'])
  cuadro()
  assert.deepEqual(nombres('acquire'), ['a', 'b'])
  cuadro()
  assert.deepEqual(nombres('acquire'), ['a', 'b', 'c'])
  cuadro()
  assert.deepEqual(nombres('acquire'), ['a', 'b', 'c'], 'con la cola vacía no agenda ni toma nada')
  assert.equal(agendados.size, 0)
})

test('una superficie soltada o destruida mientras esperaba su turno no se re-adquiere', () => {
  const [a, b] = ['a', 'b'].map(n => nueva(n))
  glBudget.lost(a)
  glBudget.lost(b)
  glBudget.dropped(a)
  cuadro()
  assert.deepEqual(nombres('acquire'), ['b'])
})

/* ── Falta de cupo ── */

test('una pérdida dentro del segundo de una recuperación es falta de cupo: no se recupera nada más', () => {
  const [a, b, c] = ['a', 'b', 'c'].map(n => nueva(n))
  glBudget.lost(a)
  glBudget.lost(b)
  cuadro()                                              // a vuelve y desaloja a c, que se pierde de inmediato
  glBudget.lost(c)
  cuadro()
  cuadro()
  assert.deepEqual(nombres('acquire'), ['a'], 'b esperaba y se queda perdida, como c: ni turnos ni rotación')
  assert.equal(agendados.size, 0)
})

test('pasado el segundo, otra pérdida es un accidente nuevo y se recupera', () => {
  const [a, b] = ['a', 'b'].map(n => nueva(n))
  glBudget.lost(a)
  cuadro()
  desfase += 1001
  glBudget.lost(b)
  cuadro()
  assert.deepEqual(nombres('acquire'), ['a', 'b'])
})

test('una que tira al re-adquirir se suelta, no se queda con un cupo, y el error sale', () => {
  const mala = nueva('mala', { tira: true })
  const buena = nueva('buena')
  glBudget.lost(mala)
  glBudget.lost(buena)
  assert.throws(cuadro, /mala: sin cupo/)
  assert.deepEqual(nombres('release'), ['mala'])
  cuadro()
  assert.deepEqual(nombres('acquire'), ['mala', 'buena'], 'y la que seguía no se queda sin su turno')
})

/* ── Zoom animado ── */

test('en pleno zoom animado no se re-adquiere: espera a que asiente, y recién ahí toma un contexto', () => {
  const [a, b] = [nueva('a', { zooming: true }), nueva('b', { zooming: true })]
  glBudget.lost(a)
  glBudget.lost(b)
  for (let i = 0; i < 5; i++) cuadro()
  assert.deepEqual(nombres('acquire'), [], 'cinco cuadros de zoom, ningún getContext')
  assert.equal(agendados.size, 1, 'queda un solo cuadro agendado: el de la espera')

  a.zooming = false
  cuadro()
  assert.deepEqual(nombres('acquire'), ['a'], 'asentó: vuelve la primera')
  b.zooming = false
  cuadro()
  assert.deepEqual(nombres('acquire'), ['a', 'b'], 'y la segunda en el cuadro siguiente')
})

test('la que espera por el zoom conserva su lugar en la cola, y la espera se apaga si ya no hay a quién esperar', () => {
  const [a, b] = [nueva('a', { zooming: true }), nueva('b')]
  glBudget.lost(a)
  glBudget.lost(b)
  cuadro()
  assert.deepEqual(nombres('acquire'), [], 'b está detrás de a y espera con ella')

  glBudget.dropped(a)
  glBudget.dropped(b)
  cuadro()
  assert.equal(agendados.size, 0, 'sin nadie en la cola, la espera termina sola')
})

test('esperar el zoom no cuenta como una recuperación: otra pérdida durante la espera se recupera', () => {
  const [a, b] = [nueva('a', { zooming: true }), nueva('b', { zooming: true })]
  glBudget.lost(a)
  cuadro()
  glBudget.lost(b)                                      // no hubo recuperación: no hay ventana que la declare falta de cupo
  a.zooming = b.zooming = false
  cuadro()
  cuadro()
  assert.deepEqual(nombres('acquire'), ['a', 'b'])
})
