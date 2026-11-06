// <cristae-scale>: `scaleBar` pura —el redondeo 1-2-3-5, los cortes a km y a mi y un barrido al azar con
// semilla fija— y la medición sobre el Leaflet REAL de jsdom, contra la fórmula cerrada del ecuador y el
// coseno de la latitud. El mapa es un nodo de jsdom con la cámara de verdad y un motor que sólo anota su
// `move`; el elemento pinta en un div suelto, porque el shim de Lit en node no tiene shadow DOM.
// Corre con: node --test test/element/scale.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { contenedor, frame, prepararDom } from '../../test-helpers/leaflet-real.mjs'

const window = prepararDom()
const { createLeafletHost }      = await import('../../src/host/LeafletHost.js')
const { Camera }                 = await import('../../src/engine/Camera.js')
const { CristaeScale, scaleBar } = await import('../../src/element/CristaeScale.js')
const { MEAN_RADIUS }            = await import('../../src/geometry/geodesic.js')

CristaeScale.finalize()   // lo que hace `customElements.define`: sin él, Lit no crea los accessors reactivos

const cerca = (valor, esperado, tolerancia, mensaje) =>
  assert.ok(Math.abs(valor - esperado) <= tolerancia, `${mensaje}: ${valor} en vez de ${esperado}`)

// El valor del rótulo en metros.
const METROS = { m: 1, km: 1000, ft: 1 / 3.2808399, mi: 5280 / 3.2808399 }
const enMetros = label => (([valor, unidad]) => Number(valor) * METROS[unidad])(label.split(' '))

// mulberry32, como test/geojson/fuzz.test.mjs.
const generador = semilla => () => {
  let t = (semilla = (semilla + 0x6D2B79F5) | 0)
  t = Math.imul(t ^ (t >>> 15), 1 | t)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// Un <cristae-map> mínimo: cámara real, el modelo del mapa y un motor que guarda quién oye su `move`.
const motor = () => {
  const e = { oyentes: new Set() }
  e.on    = (evento, cb) => (e.oyentes.add(cb), () => e.oyentes.delete(cb))
  e.mover = () => e.oyentes.forEach(cb => cb())
  return e
}
const mapa = ({ center = [0, 0], zoom = 10, container = contenedor() } = {}) => {
  const host = createLeafletHost({ container, view: { center, zoom } })
  return Object.assign(document.createElement('div'), { camera: new Camera({ host }), engine: motor(), host })
}

const escala = async (map, props = {}) => {
  const el = Object.assign(new CristaeScale(), { renderRoot: document.createElement('div'), closest: () => map }, props)
  el.connectedCallback()
  await frame()
  await el.updateComplete
  return el
}

const barras = el => [...el.renderRoot.querySelectorAll('[role="img"]')]
  .map(n => ({ part: n.getAttribute('part'), label: n.getAttribute('aria-label'), width: parseFloat(n.style.width) }))

test('scaleBar redondea hacia abajo a 1, 2, 3 o 5 por potencia de 10', () => {
  ;[[1.9, '1 m'], [2.5, '2 m'], [4, '3 m'], [7, '5 m'], [999, '500 m'], [0.07, '0.05 m'], [30, '30 m']]
    .forEach(([metros, label]) => assert.equal(scaleBar(metros, 100, 'metric').label, label, `${metros} m`))
  assert.equal(scaleBar(4, 100, 'metric').width, 75)
})

test('scaleBar pasa a km desde 1000 m y a mi desde una milla', () => {
  assert.deepEqual(scaleBar(1000, 100, 'metric'), { label: '1 km', width: 100 })
  assert.equal(scaleBar(4000, 100, 'metric').label, '3 km')
  assert.equal(scaleBar(1600, 100, 'imperial').label, '5000 ft')
  assert.equal(scaleBar(1610, 100, 'imperial').label, '1 mi')
  assert.equal(scaleBar(10000, 100, 'imperial').label, '5 mi')
  assert.equal(scaleBar(1, 100, 'imperial').label, '3 ft')
})

test('barrido de 10⁻² a 10⁸ m: rótulo {1, 2, 3, 5}·10ⁿ, ancho en [maxWidth/2, maxWidth] y proporcional', () => {
  const rng = generador(0xC0FFEE)
  for (let i = 0; i < 20000; i++) {
    const metros   = 10 ** (rng() * 10 - 2)
    const maxWidth = 20 + rng() * 280
    const unit     = rng() < 0.5 ? 'metric' : 'imperial'
    const { label, width }           = scaleBar(metros, maxWidth, unit)
    const valor    = Number(label.split(' ')[0])
    const digito   = valor / 10 ** Math.floor(Math.log10(valor) + 1e-12)
    const caso     = `${metros} m, ${maxWidth} px, ${unit}: ${label}`
    assert.ok([1, 2, 3, 5].some(d => Math.abs(digito - d) < 1e-9), caso)
    assert.ok(width > maxWidth / 2 && width <= maxWidth * (1 + 1e-12), caso)
    cerca(width / maxWidth, enMetros(label) / metros, 1e-9, caso)
  }
})

test('en el ecuador mide 2πR·maxWidth/(256·2^z), la fórmula cerrada de Mercator', async () => {
  for (const zoom of [3, 10, 15]) {
    const map = mapa({ zoom })
    const el  = await escala(map)
    const m   = 2 * Math.PI * MEAN_RADIUS * 100 / (256 * 2 ** zoom)
    const [b] = barras(el)
    const e   = scaleBar(m, 100, 'metric')
    assert.equal(b.label, e.label, `zoom ${zoom}`)
    cerca(b.width, e.width, 1e-6, `zoom ${zoom}`)
    el.disconnectedCallback()
    map.host.destroy()
  }
})

test('en latitud 60 la misma barra mide la mitad de metros que en el ecuador', async () => {
  const medir = async center => {
    const map = mapa({ center, zoom: 10 })
    const el  = await escala(map)
    const [b] = barras(el)
    el.disconnectedCallback()
    map.host.destroy()
    return enMetros(b.label) * 100 / b.width
  }
  cerca(await medir([60, 0]) / await medir([0, 0]), 0.5, 1e-4, 'cos 60°')
})

test('sigue el `move` del motor: al panear al sur cambia, sin esperar a viewportchange', async () => {
  const map   = mapa({ center: [60, 0], zoom: 10 })
  const el    = await escala(map)
  const antes = barras(el)[0]
  map.camera.setView([0, 0], 10)
  map.engine.mover()
  map.engine.mover()
  await frame()
  await el.updateComplete
  assert.notDeepEqual(barras(el)[0], antes)
  el.disconnectedCallback()
  assert.equal(map.engine.oyentes.size, 0, 'al desconectar suelta el move')
  map.host.destroy()
})

test('se re-engancha al motor nuevo en cada cristae:ready', async () => {
  const map   = mapa()
  const el    = await escala(map)
  const viejo = map.engine
  map.engine  = motor()
  map.dispatchEvent(new window.Event('cristae:ready'))
  assert.equal(viejo.oyentes.size, 0)
  assert.equal(map.engine.oyentes.size, 1)
  el.disconnectedCallback()
  map.host.destroy()
})

test('las dos unidades van métrica primero, cada una con su part y su aria-label', async () => {
  const map = mapa()
  const el  = await escala(map, { units: 'imperial metric' })
  const [metrica, imperial] = barras(el)
  assert.equal(metrica.part, 'scale-metric')
  assert.equal(imperial.part, 'scale-imperial')
  assert.match(metrica.label, /^\d+(\.\d+)? k?m$/)
  assert.match(imperial.label, /^\d+(\.\d+)? (ft|mi)$/)
  el.disconnectedCallback()
  map.host.destroy()
})

test('units y max-width inválidos caen al default: métrica y 100 px', async () => {
  const map  = mapa()
  const ref  = await escala(map)
  const base = barras(ref)
  ref.disconnectedCallback()
  for (const props of [{ units: 'nautical foo', maxWidth: -5 }, { units: '', maxWidth: NaN }, { maxWidth: Infinity }]) {
    const el = await escala(map, props)
    assert.deepEqual(barras(el), base, JSON.stringify(props))
    el.disconnectedCallback()
  }
  map.host.destroy()
})

test('un contenedor de alto 0 no da barra', async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  Object.defineProperties(container, { clientWidth: { value: 800 }, clientHeight: { value: 0 } })
  const map = mapa({ container })
  const el  = await escala(map)
  assert.deepEqual(barras(el), [])
  el.disconnectedCallback()
  map.host.destroy()
})

test('fuera de un <cristae-map>, o antes de ready, no dibuja ni lanza', async () => {
  const suelto = await escala(null)
  assert.deepEqual(barras(suelto), [])
  suelto.disconnectedCallback()

  const sinMotor = Object.assign(document.createElement('div'), { camera: undefined, engine: undefined })
  const el       = await escala(sinMotor)
  assert.deepEqual(barras(el), [])
  el.disconnectedCallback()
})
