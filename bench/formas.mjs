// Costo CPU de las formas con cada modelo de la Tierra, sin navegador ni vite:
//
//   node bench/formas.mjs
//
// Corre el motor con su opción `model` sobre los dobles de `test-helpers` (un mapa y un contexto GL falsos),
// así que mide lo que cuesta el modelo —el teselado, el hit y el arrastre de un editor— y no la GPU. Un
// destino de la esfera es una fórmula cerrada; uno de WGS84 es un `Direct` de geographiclib, que asigna.
// Cada celda es la mediana de varias corridas, en milisegundos o microsegundos por operación.
import {
  conGlDeEdicion, makeDragging, makeEditGl, makeLeaflet, makeMap, makePickSpy, makeSurface,
} from '../test-helpers/engine-stub.mjs'
import { MapEngine } from '../src/engine/MapEngine.js'
import { WGS84 } from '../src/geometry/ellipsoid.js'
import { DESTINATION, byDefault } from '../src/geometry/geodesic.js'
import { adoptLeafletHost } from '../src/host/LeafletHost.js'

const FORMAS   = 1000
const CORRIDAS = 7
const FRAMES   = 2000
const DESTINOS = 200000
const MODELOS  = [['esfera', byDefault], ['WGS84', WGS84]]

let gl = null
const restaurar = conGlDeEdicion(() => gl)

const mediana = valores => valores.sort((a, b) => a - b)[valores.length >> 1]
const medir   = (corridas, operacion) =>
  mediana(Array.from({ length: corridas }, () => { const t0 = performance.now(); operacion(); return performance.now() - t0 }))

const motor = (model, zoom) => {
  const map = { ...makeMap({ zoom }), dragging: makeDragging() }
  return { map, engine: new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }), model }) }
}

/* ── La capa de formas: el refresco entero y el re-teselado de un cambio de zoom ── */

const FORMA = {
  'círculo 500 m'  : () => ({ radius: 500 }),
  'elipse 800×300' : i => ({ radius: [800, 300], heading: i % 360 }),
  'sector 5 km 90°': i => ({ radius: 5000, heading: i % 360, sweep: 90 }),
}
const accessors = {
  idOf: f => f.id, positionOf: f => f.center, radiusOf: f => f.radius, headingOf: f => f.heading, sweepOf: f => f.sweep,
}

const capa = ([nombre, forma], [modelo, model]) => {
  gl = makeEditGl()
  const { map, engine } = motor(model, 15)
  const data = Array.from({ length: FORMAS }, (_, i) => ({
    id: i, center: [-33 + (i % 40) * 0.05, -70 + Math.floor(i / 40) * 0.05], ...forma(i),
  }))
  engine.addShapeLayer({ id: 'formas', accessors, data })
  const layer   = engine.getLayer('formas').layer
  const refresh = medir(CORRIDAS, () => layer.refresh())
  const hit     = medir(CORRIDAS, () => data.forEach(({ center: [lat, lng] }) => layer.resolveClick({ lat, lng }))) / FORMAS * 1000
  const zoom    = mediana(Array.from({ length: CORRIDAS }, (_, i) => {
    map.setZoomForTest(i % 2 ? 15 : 17)
    const t0 = performance.now()
    map.fire('zoomend')
    return performance.now() - t0
  }))
  engine.destroy()
  return `${modelo.padEnd(6)} · ${nombre.padEnd(16)} refresh ${refresh.toFixed(0).padStart(4)} ms   zoomend ${zoom.toFixed(0).padStart(4)} ms   hit ${hit.toFixed(1).padStart(4)} µs`
}

/* ── El arrastre de una manija de un editor de forma: el costo de un frame y el de soltar ── */

const EDITOR = {
  círculo : { kind: 'circle', value: { center: [0, 0], radius: 30000 } },
  elipse  : { kind: 'ellipse', value: { center: [0, 0], radius: [30000, 15000], heading: 30 } },
  sector  : { kind: 'sector', value: { center: [0, 0], radius: 30000, heading: 30, sweep: 90 } },
}

const arrastre = ([nombre, { kind, value }], [modelo, model]) => {
  const spy = makePickSpy()
  gl = makeEditGl(spy, makeSurface({ dpr: 1 }))
  const { map, engine } = motor(model, 10)
  engine.addEditableLayer({ id: 'editor', kind, value })
  const contenedor = map.getContainer()
  const emitir     = (tipo, x, y) => contenedor.emitir(tipo, { clientX: x, clientY: y, target: contenedor, pointerId: 1 })
  // La manija `i` es la entrada y el local 2i del trazo: la 0 es el centro, que traslada la forma, y la 1 la
  // de radio, que en cada frame le pide al modelo una distancia y un rumbo.
  const gesto = manija => {
    spy.bajoElCursor = { obj: 1, entrada: 2 * manija, local: 2 * manija }
    const frames = [], sueltas = []
    for (let c = 0; c < CORRIDAS; c++) {
      emitir('pointerdown', 0, 0)
      let t0 = performance.now()
      for (let i = 0; i < FRAMES; i++) emitir('pointermove', 10 + i % 20, 5 + i % 7)
      frames.push((performance.now() - t0) / FRAMES * 1000)
      t0 = performance.now()
      emitir('pointerup', 0, 0)
      sueltas.push(performance.now() - t0)
    }
    return `frame ${mediana(frames).toFixed(0).padStart(4)} µs   soltar ${mediana(sueltas).toFixed(1).padStart(4)} ms`
  }
  const fila = `${modelo.padEnd(6)} · ${nombre.padEnd(8)} centro ${gesto(0)}   radio ${gesto(1)}`
  engine.destroy()
  return fila
}

/* ── Un destino: lo que paga cada vértice de un anillo ── */

const destino = ([modelo, model]) => {
  const out = [0, 0]
  const ns  = medir(CORRIDAS, () => {
    for (let i = 0; i < DESTINOS; i++) model[DESTINATION](-33 + i % 40 * 0.05, -70, i % 360, 500 + i % 5000, out)
  }) / DESTINOS * 1e6
  return `${modelo.padEnd(6)} · ${ns.toFixed(0).padStart(5)} ns por destino`
}

console.log(`Capa de formas · ${FORMAS} formas a zoom 15 (zoomend: 15 ↔ 17)`)
MODELOS.forEach(modelo => Object.entries(FORMA).forEach(forma => console.log(capa(forma, modelo))))
console.log('\nArrastre de una manija de editor de forma · zoom 10')
MODELOS.forEach(modelo => Object.entries(EDITOR).forEach(editor => console.log(arrastre(editor, modelo))))
console.log('\nUn vértice')
MODELOS.forEach(modelo => console.log(destino(modelo)))
restaurar()
