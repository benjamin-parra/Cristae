// Marcadores HTML — un NODO DOM por ítem (envoltorio e icono), posicionado por `translate3d`.
// La capa se suscribe a la Source y reconcilia por id: reutiliza el nodo de cada marcador, rehace el
// HTML sólo si cambió y escribe el transform sólo del que se movió. No lee `dirtyIds` ni
// `moveDirtyIds`: mover un solo badge recorre igual todos los marcadores, aunque escriba uno.
//
// Lo que el banco tiene que separar acá: la notificación de `move` está coalescida a rAF, o sea que
// las N/5 llamadas del tick colapsan en UNA reconciliación por frame. La cota es "una pasada O(N) por
// frame con cualquier cambio", con escrituras de DOM sólo para lo que se movió.
//
// N = ÍTEMS.

import { createSource } from '../../src/index.js'

const ID       = 'bench-html'
const FRACCION = 0.2
const HOLGURA  = 1.25
const AMPLITUD = 0.0015
const TAMANO   = [26, 26]   // referencia compartida: `sizeOf` no debe asignar un par por lectura

const ACCESSORS = {
  idOf       : m => m.id,
  positionOf : m => m,
  htmlOf     : m => m.html,
  sizeOf     : () => TAMANO,
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

// El HTML se arma UNA vez por ítem y se guarda: `htmlOf` corre en cada reconciliación y construir el
// string ahí cargaría a la capa con asignaciones del banco.
const armar = (_, i) => {
  const lat  = latDe(i)
  const lng  = lngDe(i)
  const html = `<span class="bench-badge">${i % 100}</span>`
  return { id: i, lat, lng, lat0: lat, lng0: lng, html }
}

export default {
  id      : 'html',
  backend : 'dom-nodos',

  montar: contexto => {
    ctx    = contexto
    fuente = createSource(ACCESSORS)
    encuadrar(ctx.map)
    capa = ctx.engine.addHtmlLayer({ id: ID, accessors: ACCESSORS, source: fuente })
    return capa
  },

  aplicarN: n => {
    items  = Array.from({ length: n }, armar)
    mueve  = Math.max(1, Math.round(n * FRACCION))
    cursor = 0
    fuente.set(items)
  },

  // [0-alloc] del lado del banco. La posición se muta EN EL ÍTEM además de llamar a `move`: la
  // reconciliación lee `positionOf(item)`, no el override de la Source, y sin la mutación los
  // marcadores quedarían en el mismo lugar (igual de cara, pero sin nada que mostrar).
  paso: t => {
    const total = items.length
    if (!total) return
    const fase = t * 0.002
    let i = cursor
    let k = -1
    while (++k < mueve) {
      const m = items[i]
      m.lat = m.lat0 + Math.sin(fase + i) * AMPLITUD
      m.lng = m.lng0 + Math.cos(fase + i) * AMPLITUD
      fuente.move(m.id, m.lat, m.lng)
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
