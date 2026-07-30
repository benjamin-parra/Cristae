// Líneas GPU (glify.Lines) — LÍNEA BASE del banco junto con `points`.
// Segunda capa donde la promesa se cumple: los vértices viven en el buffer GL y el patch por rango
// entra por `bufferSubData` coalescido a rAF. Sirve de calibración: el costo que aparezca acá con N
// vértices es el piso contra el que se leen polygon/circle/editable, que mueven la MISMA geometría
// por SVG o por DOM.
//
// N = VÉRTICES TOTALES (no líneas): se reparten en trazos de `VERTICES_POR_LINEA`.

import { createSource } from '../../src/index.js'

const ID                 = 'bench-lines'
const VERTICES_POR_LINEA = 128
const FRACCION           = 0.2
const HOLGURA            = 1.25
const AMPLITUD           = 0.0015
const PALETA             = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626']

// `hashOf` sobre un contador propio: la Source necesita ver que la línea cambió para entrar al
// camino patch — la identidad del path no alcanza porque se muta EN SITIO (no se reemplaza).
const ACCESSORS = {
  idOf    : l => l.id,
  pathOf  : l => l.path,
  hashOf  : l => l.v,
  styleOf : l => l.estilo,
}

const marco = { lat: 0, lng: 0, dLat: 0, dLng: 0 }

// Doble buffer del lote sucio: `patch` se procesa ahora pero la emisión va coalescida al próximo
// rAF, o sea el mismo tick en que el banco vuelve a pisar sus buffers. Alternando, lo entregado no
// se toca hasta dos ticks después — y sigue sin asignar nada por tick.
const buffers = [
  { sucios: new Set(), lote: [] },
  { sucios: new Set(), lote: [] },
]

let ctx    = null
let fuente = null
let capa   = null
let items  = []
let mueve  = 0
let cursor = 0
let tick   = 0

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

// Caminata aleatoria acotada al encuadre: la forma de un track GPS, que es lo que la capa transporta.
const trazo = (i, vertices) => {
  const paso = { lat: marco.dLat / vertices, lng: marco.dLng / vertices }
  let lat = latDe(i)
  let lng = lngDe(i)
  return Array.from({ length: vertices }, () => {
    lat += (ctx.rnd() - 0.5) * paso.lat * 2
    lng += paso.lng * 0.8 + (ctx.rnd() - 0.5) * paso.lng
    return [lat, lng]
  })
}

const armar = (i, vertices) => ({
  id     : i,
  path   : trazo(i, vertices),
  v      : 0,
  offset : 0,
  estilo : { color: PALETA[i % PALETA.length], weight: 2 },
})

export default {
  id      : 'lines',
  backend : 'gpu-glify',

  montar: contexto => {
    ctx    = contexto
    fuente = createSource(ACCESSORS)
    encuadrar(ctx.map ?? ctx.engine.getLeafletMap())
    capa = ctx.engine.addLineLayer({ id: ID, accessors: ACCESSORS, source: fuente })
    return capa
  },

  aplicarN: n => {
    const lineas   = Math.max(1, Math.round(n / VERTICES_POR_LINEA))
    const vertices = Math.max(2, Math.round(n / lineas))
    items  = Array.from({ length: lineas }, (_, i) => armar(i, vertices))
    mueve  = Math.max(1, Math.round(lineas * FRACCION))
    cursor = 0
    tick   = 0
    fuente.set(items)
  },

  // [0-alloc] en régimen — buffers de módulo que se vacían y rellenan; el desplazamiento va por
  // delta contra el offset vigente, así el path se muta en sitio sin copia base ni deriva acumulada.
  paso: t => {
    const total = items.length
    if (!total) return
    const { sucios, lote } = buffers[tick++ % 2]
    sucios.clear()
    lote.length = 0
    const fase = t * 0.002
    let i = cursor
    let k = -1
    while (++k < mueve) {
      const linea = items[i]
      const meta  = Math.sin(fase + i) * AMPLITUD
      const delta = meta - linea.offset
      const path  = linea.path
      let v = -1
      while (++v < path.length) {
        path[v][0] += delta
        path[v][1] += delta * 0.5
      }
      linea.offset = meta
      linea.v++
      sucios.add(linea.id)
      lote.push(linea)
      i = (i + 1) % total
    }
    cursor = i
    fuente.patch(lote, sucios)
  },

  destruir: () => {
    capa && ctx.engine.removeLayer(ID)
    fuente?.destroy()
    ctx = fuente = capa = null
    items = []
    buffers.forEach(b => {
      b.lote.length = 0
      b.sucios.clear()
    })
  },
}
