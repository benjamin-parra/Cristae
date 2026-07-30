// Polígonos — paths SVG de Leaflet (`L.polygon`), no GPU.
// Dos costos distintos que el guion tiene que separar:
//   · FLUSH con el mismo conteo → camino "rápido" (#patch)… que igual REINDEXA O(n·vértices) el
//     índice geométrico completo. El fast-path no evita el reindex: sólo evita recrear los paths.
//   · ALTA o BAJA de UN polígono → el guard de conteo falla y cae a rebuild total.
// Por eso `paso` cicla 3 tiempos: un flush plano y un par alta/baja. Medir sólo el flush plano
// subestimaría la capa; medir sólo la baja escondería que ni el camino barato lo es.
//
// N = ANILLOS × VÉRTICES (total de vértices repartido en anillos de `VERTICES_POR_ANILLO`).

const ID                  = 'bench-polygon'
const VERTICES_POR_ANILLO = 24
const HOLGURA             = 1.25
const AMPLITUD            = 0.0015
const RADIO_RELATIVO      = 0.015   // fracción del encuadre que ocupa cada anillo
const PALETA              = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626']

const ACCESSORS = {
  idOf    : g => g.id,
  ringsOf : g => g.anillo,
  styleOf : g => g.estilo,
}

const marco = { lat: 0, lng: 0, dLat: 0, dLng: 0 }

let ctx      = null
let capa     = null
let todos    = []
let menosUno = []
let cursor   = 0
let tick     = 0

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

// Anillo convexo con radio jitereado alrededor de un centro: la forma de una geocerca real, que es
// lo que esta capa transporta en producción.
const anilloDe = (i, vertices) => {
  const lat = latDe(i)
  const lng = lngDe(i)
  const rLat = marco.dLat * RADIO_RELATIVO
  const rLng = marco.dLng * RADIO_RELATIVO
  return Array.from({ length: vertices }, (_, v) => {
    const a = (v / vertices) * Math.PI * 2
    const r = 0.7 + ctx.rnd() * 0.6
    return [lat + Math.sin(a) * rLat * r, lng + Math.cos(a) * rLng * r]
  })
}

const armar = (i, vertices) => {
  const color = PALETA[i % PALETA.length]
  return {
    id     : i,
    anillo : anilloDe(i, vertices),
    offset : 0,
    estilo : { color, fillColor: color, weight: 1, fillOpacity: 0.25 },
  }
}

// Un anillo por tick, en sitio: sin esto el flush plano podría cortocircuitar por geometría idéntica
// y el camino "rápido" se mediría sin trabajo.
const ondular = t => {
  const g = todos[cursor]
  cursor = (cursor + 1) % todos.length
  const meta   = Math.sin(t * 0.002) * AMPLITUD
  const delta  = meta - g.offset
  const anillo = g.anillo
  g.offset = meta
  let v = -1
  while (++v < anillo.length) anillo[v][0] += delta
}

export default {
  id      : 'polygon',
  backend : 'leaflet-vector',

  montar: contexto => {
    ctx = contexto
    encuadrar(ctx.map ?? ctx.engine.getLeafletMap())
    capa = ctx.engine.addPolygonLayer({ id: ID, accessors: ACCESSORS, data: todos })
    return capa
  },

  // Ruta `data`: PolygonLayerConfig no acepta `source` (hueco documentado), así que el conjunto se
  // empuja con `handle.set` y el motor posee la Source interna.
  aplicarN: n => {
    const anillos  = Math.max(1, Math.round(n / VERTICES_POR_ANILLO))
    const vertices = Math.max(3, Math.round(n / anillos))
    todos = Array.from({ length: anillos }, (_, i) => armar(i, vertices))
    menosUno = todos.slice(0, -1)   // preasignado: la baja del tick no debe asignar un array
    cursor   = 0
    tick     = 0
    capa.set(todos)
  },

  // [0-alloc] — ambos conjuntos ya existen; el tick sólo alterna cuál se empuja.
  paso: t => {
    if (!todos.length) return
    ondular(t)
    capa.set(++tick % 3 === 1 ? menosUno : todos)
  },

  destruir: () => {
    capa && ctx.engine.removeLayer(ID)
    ctx = capa = null
    todos    = []
    menosUno = []
  },
}
