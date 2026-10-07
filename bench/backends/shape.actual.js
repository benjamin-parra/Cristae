// Formas en metros (círculos) — teseladas en la GPU: una textura de anillos y un solo canvas.
// Lo que la castiga es el ZOOM del guion: el radio va en METROS, así que cada cambio de escala
// obliga a reteselar el radio de TODAS las formas. La fase de pan es comparativamente barata
// (el pane traslada el canvas) y la fase viva agrega el rehecho de todos los anillos que la capa
// corre en cada cambio de la Source.
//
// N = FORMAS.

import { createSource } from '../../src/index.js'

const ID               = 'bench-shape'
const FRACCION         = 0.2
const HOLGURA          = 1.25
const AMPLITUD         = 0.0015
const RADIO_RELATIVO   = 0.012   // fracción del alto del encuadre: se ve a cualquier zoom inicial
const METROS_POR_GRADO = 111320
const PALETA           = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626']

const ACCESSORS = {
  idOf           : c => c.id,
  positionOf     : c => c,
  radiusOf       : c => c.radio,
  styleOf        : c => c.estilo,
}

const marco = { lat: 0, lng: 0, dLat: 0, dLng: 0 }

let ctx    = null
let fuente = null
let capa   = null
let items  = []
let mueve  = 0
let cursor = 0

const encuadrar = mapa => {
  const b = mapa.getBounds()
  const c = b.getCenter()
  marco.lat  = c.lat
  marco.lng  = c.lng
  marco.dLat = (b.getNorth() - b.getSouth()) * HOLGURA
  marco.dLng = (b.getEast() - b.getWest()) * HOLGURA
}

const latDe = i => ctx.datos?.[i]?.lat ?? marco.lat + (ctx.rnd() - 0.5) * marco.dLat
const lngDe = i => ctx.datos?.[i]?.lng ?? marco.lng + (ctx.rnd() - 0.5) * marco.dLng

// El radio se deriva del encuadre, no de una constante en metros: así el círculo ocupa la misma
// fracción de pantalla sea cual sea la vista inicial que fije el stage.
const armar = (_, i) => {
  const lat    = latDe(i)
  const lng    = lngDe(i)
  const radio  = marco.dLat * METROS_POR_GRADO * RADIO_RELATIVO * (0.5 + ctx.rnd())
  const color  = PALETA[i % PALETA.length]
  const estilo = { color, fillColor: color, weight: 1, fillOpacity: 0.15 }
  return { id: i, lat, lng, lat0: lat, lng0: lng, radio, estilo }
}

export default {
  id      : 'shape',
  backend : 'gpu-teselado',

  montar: contexto => {
    ctx    = contexto
    fuente = createSource(ACCESSORS)
    encuadrar(ctx.map)
    capa = ctx.engine.addShapeLayer({ id: ID, accessors: ACCESSORS, source: fuente })
    return capa
  },

  aplicarN: n => {
    items  = Array.from({ length: n }, armar)
    mueve  = Math.max(1, Math.round(n * FRACCION))
    cursor = 0
    fuente.set(items)
  },

  // [0-alloc] — el `move` es O(1) del lado dato; lo que cuesta es lo que dispara del lado capa.
  paso: t => {
    const total = items.length
    if (!total) return
    const fase = t * 0.002
    let i = cursor
    let k = -1
    while (++k < mueve) {
      const c = items[i]
      c.lat = c.lat0 + Math.sin(fase + i) * AMPLITUD
      c.lng = c.lng0 + Math.cos(fase + i) * AMPLITUD
      fuente.move(c.id, c.lat, c.lng)
      i = (i + 1) % total
    }
    cursor = i
  },

  destruir: () => {
    capa && ctx.engine.removeLayer(ID)
    fuente?.destroy()
    ctx = fuente = capa = null
    items = []
  },
}
