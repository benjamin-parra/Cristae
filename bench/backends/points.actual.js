// Puntos GPU (glify) — LÍNEA BASE del banco.
// Es la capa donde la promesa se cumple: un slot por punto en el buffer, sprite en atlas y `move`
// O(1) sin rebuild (la Source coalesce sus notificaciones a rAF). Lo que el medidor registre acá es
// PISO DEL INSTRUMENTO, no costo de la capa: calibra contra esto antes de leer las demás.

import { createSource, shapePresetIconSet } from '../../src/index.js'

const ID       = 'bench-points'
const FRACCION = 0.2      // porción del conjunto que se mueve por tick en la fase viva
const HOLGURA  = 1.25     // el dato excede el encuadre para que el paneo revele geometría nueva
const AMPLITUD = 0.0015   // grados de vaivén: mueve de verdad sin sacar el punto de cámara
const PALETA   = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626']

// El ítem ES su posición: `positionOf` devuelve el propio ítem en vez de un literal nuevo, así el
// accessor no asigna un objeto por lectura y la métrica de allocs queda de la capa, no del banco.
const ACCESSORS = {
  idOf       : p => p.id,
  positionOf : p => p,
  variantOf  : p => p.variante,
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

// El escenario manda las posiciones; sin ellas se derivan del encuadre vigente, porque un dato
// fuera de cámara no dibuja y el banco mediría cero.
const latDe = i => ctx.datos?.[i]?.lat ?? marco.lat + (ctx.rnd() - 0.5) * marco.dLat
const lngDe = i => ctx.datos?.[i]?.lng ?? marco.lng + (ctx.rnd() - 0.5) * marco.dLng

const armar = (_, i) => {
  const lat = latDe(i)
  const lng = lngDe(i)
  return { id: i, lat, lng, lat0: lat, lng0: lng, variante: PALETA[i % PALETA.length] }
}

export default {
  id      : 'points',
  backend : 'gpu-glify',

  montar: contexto => {
    ctx    = contexto
    fuente = createSource(ACCESSORS, PALETA)
    encuadrar(ctx.map ?? ctx.engine.getLeafletMap())
    capa = ctx.engine.addPointLayer({
      id        : ID,
      accessors : ACCESSORS,
      source    : fuente,
      iconSet   : shapePresetIconSet({ shape: 'dot', size: 12 }),
    })
    return capa
  },

  aplicarN: n => {
    items  = Array.from({ length: n }, armar)
    mueve  = Math.max(1, Math.round(n * FRACCION))
    cursor = 0
    fuente.set(items)
  },

  // [0-alloc] — bucle explícito, sin lambdas por tick: el vaivén se calcula contra la posición
  // original (no acumula deriva) y `move` reescribe el slot sin reconstruir el buffer.
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
