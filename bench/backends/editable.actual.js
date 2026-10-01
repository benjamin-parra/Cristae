// Geometría editable — CASO TESTIGO del banco. DOM puro: un `L.marker` por vértice MÁS uno por
// segmento (los midpoints), o sea ~2N nodos y ~4N listeners para un trazo de N vértices.
//
// 🔴 POR QUÉ EL `paso` INSERTA Y BORRA EN VEZ DE ARRASTRAR. El drag de UN vértice es el único
// camino barato que la capa tiene: reubica la coord y exactamente 2 midpoints adyacentes, sin
// rebuild. Todo lo demás —insertar, borrar, cerrar el trazo, `setValue`— pasa por `#settle()`, que
// arranca con `clearLayers()` y vuelve a crear la totalidad de los marcadores. Medir el drag daría
// un número bonito de una capa que en el uso real (agregar un vértice a una ruta) hace ~1.600
// operaciones de DOM por gesto. Así que el tick alterna N ↔ N+1 vértices por `setValue`, que es la
// ÚNICA superficie pública para editar la geometría (no hay `moveVertex`).
//
// N = VÉRTICES DE UN SOLO TRAZO (400 / 5.000 / 50.000).

const ID       = 'bench-editable'
const HOLGURA  = 1.25
const AMPLITUD = 0.0015

const marco = { lat: 0, lng: 0, dLat: 0, dLng: 0 }

let ctx      = null
let handle   = null
let base     = []
let conExtra = []
let medio    = 0
let latMedio = 0
let tick     = 0
let vivos    = 0   // testigo anti-falso-verde: si queda en 0, la capa nunca emitió y no se midió nada
let firmes   = 0

const encuadrar = mapa => {
  const b = mapa.getBounds()
  const c = b.getCenter()
  marco.lat  = c.lat
  marco.lng  = c.lng
  marco.dLat = (b.getNorth() - b.getSouth()) * HOLGURA
  marco.dLng = (b.getEast() - b.getWest()) * HOLGURA
}

// Referencias de módulo, no clausuras del call-site: la capa las guarda una vez y no reasigna por
// gesto (una lambda inline acá se pagaría en cada emit del drag).
const alCambiar = () => { vivos++ }
const alAsentar = () => { firmes++ }

const latDe = i => ctx.datos?.[i]?.lat ?? marco.lat + (ctx.rnd() - 0.5) * marco.dLat
const lngDe = i => ctx.datos?.[i]?.lng ?? marco.lng + (ctx.rnd() - 0.5) * marco.dLng

// Un recorrido: caminata acotada al encuadre, que es la geometría que el editor edita de verdad.
const trazar = n => {
  const paso = { lat: marco.dLat / n, lng: marco.dLng / n }
  let lat = latDe(0)
  let lng = lngDe(0)
  return Array.from({ length: n }, () => {
    lat += (ctx.rnd() - 0.5) * paso.lat * 2
    lng += paso.lng * 0.8 + (ctx.rnd() - 0.5) * paso.lng
    return [lat, lng]
  })
}

// Vértice insertado = punto medio del segmento anterior. Un duplicado exacto del vecino podría ser
// saneado por la capa y entonces el alta no se mediría.
const conVerticeExtra = () => {
  const previo = base[Math.max(0, medio - 1)]
  const actual = base[medio]
  const nuevo  = [(previo[0] + actual[0]) / 2, (previo[1] + actual[1]) / 2]
  return base.slice(0, medio).concat([nuevo], base.slice(medio))
}

export default {
  id      : 'editable',
  backend : 'dom-nodos',

  montar: contexto => {
    ctx = contexto
    encuadrar(ctx.map)
    handle = ctx.engine.addEditableLayer({
      id       : ID,
      kind     : 'polyline',
      value    : base,
      mode     : 'edit',
      onChange : alCambiar,
      onCommit : alAsentar,
    })
    return handle
  },

  // `conExtra` COMPARTE los pares de `base` y agrega uno: el vértice arrastrado se muta una vez y
  // los dos conjuntos quedan coherentes sin copiar el trazo entero por tick.
  aplicarN: n => {
    base     = trazar(n)
    medio    = base.length >> 1
    latMedio = base.length ? base[medio][0] : marco.lat
    conExtra = base.length ? conVerticeExtra() : []
    tick     = 0
    vivos    = 0
    firmes   = 0
    handle.setValue(base)
  },

  // [0-alloc] — los dos trazos ya existen; el tick mueve un vértice en sitio y alterna cuál se
  // empuja. Alternar el largo es lo que fuerza el rebuild total que este caso testigo persigue.
  paso: t => {
    if (!base.length) return
    base[medio][0] = latMedio + Math.sin(t * 0.002) * AMPLITUD
    handle.setValue(++tick % 2 ? conExtra : base)
  },

  destruir: () => {
    handle?.destroy()
    ctx = handle = null
    base     = []
    conExtra = []
  },

  // Si el guion termina con `cambios` en 0, la capa jamás emitió: lo que se midió fue código
  // muerto y el resultado no vale. Es la única capa del banco cuyo trabajo no se ve en pantalla
  // salvo por los handles, así que declara su propio testigo.
  get testigo() {
    return { cambios: vivos, asentados: firmes }
  },
}
