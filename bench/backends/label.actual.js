// Etiquetas — canvas 2D sobre un overlay de Leaflet. No hay atlas ni sprite: cada etiqueta se
// dibuja por separado con `save/clip/restore`, se mide su texto y se compone la píldora.
//
// La ruta caliente es `setLabels(labels)`: reemplaza el set entero y repinta TODO. No existe
// `patch` ni `move` — cambiar una etiqueta cuesta lo mismo que cambiarlas todas. Por eso el tick
// mueve el 20 % y reenvía el conjunto completo: es el único camino que la capa ofrece, y medir otra
// cosa sería medir una API que no existe.
//
// FUERA DEL BANCO A PROPÓSITO: el texto es ESTABLE. La memo de anchos (`fuente|texto`) no tiene
// cota ni desalojo, así que con texto dinámico crece para siempre — pero construir un string por
// etiqueta y por frame metería asignaciones del banco en la métrica de la capa. La fuga se audita
// aparte; acá se mide el repintado.
//
// N = ÍTEMS.

import { createSource } from '../../src/index.js'

const ID       = 'bench-label'
const FRACCION = 0.2
const HOLGURA  = 1.25
const AMPLITUD = 0.0015
const ACENTO   = '#16a34a'
const ESTILO   = { surface: '#ffffff', text: '#0f172a', accent: '#2563eb' }

// El ítem ES el label: cumple `{id, lat, lng, text}`, así que el mismo array alimenta a la Source y
// a `setLabels` sin proyectar una copia por tick.
const ACCESSORS = {
  idOf       : l => l.id,
  positionOf : l => l,
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

// Una de cada cuatro lleva acento: el painter por defecto dibuja además la franja lateral y ese
// camino tiene que entrar a la medición.
const armar = (_, i) => {
  const lat = latDe(i)
  const lng = lngDe(i)
  return { id: i, lat, lng, lat0: lat, lng0: lng, text: `L-${i}`, accent: i % 4 ? undefined : ACENTO }
}

export default {
  id      : 'label',
  backend : 'canvas-2d',

  montar: contexto => {
    ctx    = contexto
    fuente = createSource(ACCESSORS)
    encuadrar(ctx.map ?? ctx.engine.getLeafletMap())
    // Ruta standalone (`source` + `accessors` + `textOf`), no `bindTo`: ligarla a una capa host
    // mezclaría el costo del host con el de las etiquetas y el banco dejaría de aislar la capa.
    capa = ctx.engine.addLabelLayer({
      id        : ID,
      accessors : ACCESSORS,
      source    : fuente,
      textOf    : l => l.text,
      style     : ESTILO,
    })
    return capa
  },

  aplicarN: n => {
    items  = Array.from({ length: n }, armar)
    mueve  = Math.max(1, Math.round(n * FRACCION))
    cursor = 0
    fuente.set(items)
    capa.setLabels(items)
  },

  // [0-alloc] — se mutan las etiquetas en sitio y se reenvía la MISMA referencia. No se toca la
  // Source: notificarla dispararía además el camino derivado del motor y se contarían dos
  // repintados por tick, uno de ellos inventado por el banco.
  paso: t => {
    const total = items.length
    if (!total) return
    const fase = t * 0.002
    let i = cursor
    let k = -1
    while (++k < mueve) {
      const l = items[i]
      l.lat = l.lat0 + Math.sin(fase + i) * AMPLITUD
      l.lng = l.lng0 + Math.cos(fase + i) * AMPLITUD
      i = (i + 1) % total
    }
    cursor = i
    capa.setLabels(items)
  },

  destruir: () => {
    capa && ctx.engine.removeLayer(ID)
    fuente?.destroy()
    ctx = fuente = capa = null
    items = []
  },
}
