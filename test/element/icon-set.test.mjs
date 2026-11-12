// <cristae-icon-set> y <cristae-icon>: el mapa registra el set antes de montar sus capas, los de fábrica están
// reservados, los hijos cambian el catálogo sin cambiar la identidad del set y las señales de carga salen con `set`.
// Corre con: node --test test/element/icon-set.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { prepararDom } from '../../test-helpers/leaflet-real.mjs'

const window = prepararDom()
;['addEventListener', 'removeEventListener'].forEach(k => { globalThis[k] ??= window[k].bind(window) })
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} }
const { CristaeIconSet } = await import('../../src/element/CristaeIconSet.js')
const { CristaeIcon } = await import('../../src/element/CristaeIcon.js')
const { SET_ICONS } = await import('../../src/atlas/image-icons.js')
const { IconSet } = await import('../../src/atlas/IconSet.js')
CristaeIconSet.finalize()
CristaeIcon.finalize()

const SRC = { a: 'a.svg', b: 'b.svg' }
const tick = () => new Promise(r => queueMicrotask(r))

const motorFalso = (orden = []) => ({
  sets: new Map(),
  registerIconSet(name, set) { this.sets.set(name, set); orden.push(`set:${name}`); return this },
})

// Un ícono hijo sin ciclo de vida de Lit: sólo lo que el set lee.
const icono = (name, src) => ({ localName: 'cristae-icon', name, src })

const crearSet = (props = {}, hijos = [icono('a', SRC.a), icono('b', SRC.b)], mapa = null) => {
  const el = Object.assign(new CristaeIconSet(), { name: 'flota', ...props })
  Object.defineProperty(el, 'children', { value: hijos, writable: true })
  el.closest = () => mapa
  el.renderRoot = document.createElement('div')
  return el
}

const capturar = (metodo, fn) => {
  const originalFn = console[metodo]
  const llamadas = []
  console[metodo] = (...a) => llamadas.push(a.join(' '))
  return Promise.resolve(fn(llamadas)).finally(() => { console[metodo] = originalFn })
}

test('registra un IconSet con el nombre y el tamaño por defecto', () => {
  const motor = motorFalso()
  crearSet().cristaeRegister(motor)
  const set = motor.sets.get('flota')
  assert.ok(set instanceof IconSet)
  assert.equal(typeof set[SET_ICONS], 'function')
})

test('el mapa registra el set antes de montar la capa, sin importar el orden del HTML', async () => {
  const { montarMapa } = await import('../../test-helpers/element-stub.mjs')
  const orden = []
  const set   = crearSet()
  set.cristaeRegister = motor => orden.push(motor ? 'set' : 'set-sin-motor')
  const capa  = { cristaeMount: () => orden.push('capa') }
  // La capa se anuncia ANTES que el set en el HTML: queda pendiente hasta el montaje del motor.
  const { el } = await montarMapa({ querySelectorAll() { set.closest = () => this; return [set] } }, undefined, mapa => mapa.requestMount(capa))
  assert.deepEqual(orden, ['set', 'capa'])
  el.disconnectedCallback()
})

test('un set anidado en un contenedor del mapa se registra; el de un mapa anidado, no', async () => {
  const { montarMapa } = await import('../../test-helpers/element-stub.mjs')
  const orden = []
  const propio = crearSet(), ajeno = crearSet()
  propio.cristaeRegister = () => orden.push('propio')
  ajeno.cristaeRegister  = () => orden.push('ajeno')
  const { el } = await montarMapa({ querySelectorAll() { propio.closest = () => this; ajeno.closest = () => ({}); return [propio, ajeno] } })
  assert.deepEqual(orden, ['propio'])
  el.disconnectedCallback()
})

test('un nombre de fábrica da console.error y no registra', async () => {
  for (const name of ['dot', 'pin', 'circle', 'arrow']) {
    const motor = motorFalso()
    await capturar('error', llamadas => {
      crearSet({ name }).cristaeRegister(motor)
      assert.equal(motor.sets.size, 0)
      assert.match(llamadas[0], /fábrica/)
    })
  }
})

test('sin íconos avisa y espera; al llegar el primero se registra', async () => {
  const motor = motorFalso()
  const el = crearSet({}, [])
  await capturar('warn', async llamadas => {
    el.cristaeRegister(motor)
    assert.equal(motor.sets.size, 0)
    assert.match(llamadas[0], /no tiene/)
    el.children = [icono('a', SRC.a)]
    el.cristaeIconsChanged()
    await tick(); await tick()
    assert.ok(motor.sets.has('flota'))
  })
})

test('agregar, quitar o cambiar un ícono conserva la identidad y llama a SET_ICONS', async () => {
  const motor = motorFalso()
  const el = crearSet()
  el.cristaeRegister(motor)
  const set = motor.sets.get('flota')
  const llamadas = []
  const original = set[SET_ICONS]
  set[SET_ICONS] = (icons, opts) => { llamadas.push({ icons: { ...icons }, opts }); return original(icons, opts) }

  el.children = [...el.children, icono('c', 'c.svg')]
  el.cristaeIconsChanged(); el.cristaeIconsChanged()
  await tick()
  assert.equal(llamadas.length, 1, 'los cambios se juntan en una microtarea')
  assert.deepEqual(Object.keys(llamadas[0].icons), ['a', 'b', 'c'])

  el.children = [icono('a', 'otra.svg')]
  el.cristaeIconsChanged()
  await tick()
  assert.deepEqual(llamadas[1].icons, { a: 'otra.svg' })
  assert.equal(motor.sets.get('flota'), set)
})

test('quitar el último ícono conserva el catálogo y avisa', async () => {
  const motor = motorFalso()
  const el = crearSet()
  el.cristaeRegister(motor)
  el.children = []
  await capturar('warn', async llamadas => {
    el.cristaeIconsChanged()
    await tick()
    assert.match(llamadas[0], /se conserva/)
  })
})

test('un nombre de ícono repetido gana el último y avisa', () => {
  const motor = motorFalso()
  const el = crearSet({}, [icono('a', 'uno.svg'), icono('a', 'dos.svg')])
  return capturar('warn', llamadas => {
    el.cristaeRegister(motor)
    assert.match(llamadas[0], /repetido/)
  })
})

test('size y rotates cambian el set vivo por SET_ICONS con sus valores', async () => {
  const motor = motorFalso()
  const el = crearSet({ size: 40, rotates: true })
  el.cristaeRegister(motor)
  const set = motor.sets.get('flota')
  let visto
  set[SET_ICONS] = (_, opts) => { visto = opts }
  el.size = 64
  el.updated(new Map([['size', 40]]))
  await tick()
  assert.deepEqual(visto, { rotates: true, size: 64 })
})

test('cambiar name registra con el nombre nuevo y avisa del viejo', async () => {
  const motor = motorFalso()
  const el = crearSet()
  el.cristaeRegister(motor)
  const set = motor.sets.get('flota')
  el.name = 'otra'
  await capturar('warn', llamadas => {
    el.updated(new Map([['name', 'flota']]))
    assert.match(llamadas[0], /'flota' sigue registrado/)
  })
  assert.equal(motor.sets.get('otra'), set)
  assert.equal(motor.sets.get('flota'), set)
})

test('cristae:load y cristae:error salen con el nombre del set', async () => {
  const motor = motorFalso()
  const el = crearSet()
  const vistos = []
  el.dispatchEvent = e => { vistos.push(e); return true }
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('caído') }
  try {
    el.cristaeRegister(motor)
    await motor.sets.get('flota').prerender?.()
    await new Promise(r => setTimeout(r, 20))
  } finally { globalThis.fetch = original }
  const errores = vistos.filter(e => e.type === 'cristae:error')
  assert.ok(errores.length >= 1)
  assert.equal(errores[0].detail.set, 'flota')
  assert.ok(errores[0].detail.icon)
  assert.ok(errores[0].bubbles && errores[0].composed)
})

test('un set que se conecta después del montaje se registra solo', () => {
  const motor = motorFalso()
  const mapa = { engine: motor }
  const el = crearSet({}, undefined, mapa)
  el.connectedCallback()
  assert.ok(motor.sets.has('flota'))
  el.disconnectedCallback()
})

test('un set que se conecta sin motor no registra nada', () => {
  const el = crearSet({}, undefined, { engine: null })
  el.connectedCallback()
  assert.doesNotThrow(() => el.disconnectedCallback())
})

test('<cristae-icon> avisa a su set al conectarse, cambiar y desconectarse', () => {
  const avisos = []
  const padre = { cristaeIconsChanged: () => avisos.push('x') }
  const el = Object.assign(new CristaeIcon(), { renderRoot: document.createElement('div'), closest: () => padre, name: 'a', src: 'a.svg' })
  el.connectedCallback()
  assert.equal(avisos.length, 1)
  el.updated(new Map([['src', 'x']]))
  assert.equal(avisos.length, 2)
  el.updated(new Map([['otra', 1]]))
  assert.equal(avisos.length, 2)
  el.closest = () => null
  el.disconnectedCallback()
  assert.equal(avisos.length, 3, 'avisa al set que recordó, no al que busca ahora')
  el.updated(new Map([['name', 'z']]))
  assert.equal(avisos.length, 3)
})

test('<cristae-icon> sin set conectado no falla', () => {
  const el = Object.assign(new CristaeIcon(), { renderRoot: document.createElement('div'), closest: () => null })
  assert.doesNotThrow(() => { el.connectedCallback(); el.updated(new Map([['name', 'a']])); el.disconnectedCallback() })
})
