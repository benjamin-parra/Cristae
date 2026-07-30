// Heatmap — la demo lo anuncia «(GPU)» y es CANVAS 2D. Exhibirlo es media razón de ser del banco.
//
// 🔴 N NO ES LA VARIABLE DOMINANTE. La cota es el VIEWPORT: cada redibujo hace `getImageData` del
// framebuffer entero (≈8,3 MB a 1080p), recorre W×H píxeles en JS para colorear por rampa y devuelve
// con `putImageData`. Duplicar los puntos casi no mueve la aguja; agrandar la ventana sí. Por eso la
// lectura útil de esta capa es MB/s asignados y ms por redibujo — no ms por ítem.
//
// De ahí que el guion tenga que MOVER dato: la capa se suscribe a la Source y redibuja completo ante
// cualquier notificación (sin consultar dirtyIds), así que la fase viva revela el costo por frame que
// una escena estática esconde.

import { createSource } from '../../src/index.js'

const ID       = 'bench-heat'
const FRACCION = 0.2
const HOLGURA  = 1.25
const AMPLITUD = 0.0015

const ACCESSORS = {
  idOf       : p => p.id,
  positionOf : p => p,
  weightOf   : p => p.peso,
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

const armar = (_, i) => {
  const lat = latDe(i)
  const lng = lngDe(i)
  return { id: i, lat, lng, lat0: lat, lng0: lng, peso: 0.4 + ctx.rnd() * 0.6 }
}

export default {
  id      : 'heat',
  backend : 'canvas-2d',

  montar: contexto => {
    ctx    = contexto
    fuente = createSource(ACCESSORS)
    encuadrar(ctx.map ?? ctx.engine.getLeafletMap())
    // Parámetros EXPLÍCITOS: si el remake cambia sus defaults, la comparación A/B dejaría de ser
    // pareja sin que nadie lo note.
    capa = ctx.engine.addHeatLayer({
      id        : ID,
      accessors : ACCESSORS,
      source    : fuente,
      radius    : 24,
      blur      : 15,
      intensity : 1,
    })
    return capa
  },

  aplicarN: n => {
    items  = Array.from({ length: n }, armar)
    mueve  = Math.max(1, Math.round(n * FRACCION))
    cursor = 0
    fuente.set(items)
  },

  // [0-alloc] — el banco no aporta basura; la que aparezca en la fase viva es del `getImageData`
  // por redibujo. Las N/5 llamadas a `move` colapsan en UNA notificación (rAF), así que lo que se
  // mide es un redibujo completo por frame, no uno por punto movido.
  paso: t => {
    const total = items.length
    if (!total) return
    const fase = t * 0.002
    let i = cursor
    let k = -1
    while (++k < mueve) {
      const p = items[i]
      p.lat = p.lat0 + Math.sin(fase + i) * AMPLITUD
      p.lng = p.lng0 + Math.cos(fase + i) * AMPLITUD
      fuente.move(p.id, p.lat, p.lng)
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
