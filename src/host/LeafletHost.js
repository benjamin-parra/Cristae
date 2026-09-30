import L from 'leaflet'
import { coordOf, hasPointShape } from '../geometry/polyline.js'

// El anfitrión: Leaflet detrás de facetas con los valores de la API (SPECS §0). Se crea sobre un
// contenedor o adopta un mapa que ya existe; es uno por mapa, y quien lo destruye es el motor que lo
// usa. Toda conversión entre Leaflet y esos valores vive acá: un punto entra con la forma de
// cristae/geometry y lo que sale es un objeto plano.
//
// Las facetas son `camera` —estado, comandos, proyección, política de animación del zoom y ciclo de
// vista— y `surface`, los nodos donde dibujan las capas. `substrate` es el Leaflet y el mapa para lo
// que todavía dibuja con Leaflet: los sustratos vectoriales y glify, y nada más. `map` y `leaflet` son
// para lo que no tiene faceta: tiles, entrada y `getLeafletMap()`.

// El ciclo de vista, con un solo emisor: cada tipo tiene un oyente en el mapa, y los suscriptores del
// anfitrión se reparten ese lugar en el orden en que llegaron.
const VIEW_EVENTS = ['movestart', 'move', 'moveend', 'zoomstart', 'zoomanim', 'zoomend', 'resize']

const CONTAINER_ORIGIN = Object.freeze([0, 0])
const NOOP             = () => {}

// Lo que la superficie le escribe a un pane: lo que le devuelve a uno prestado.
const PANE_STYLE = ['zIndex', 'pointerEvents', 'visibility', 'opacity']

// Lo que envuelve cada método privado que un anfitrión le reemplaza a un mapa. Dos anfitriones vivos en
// un mapa —el nuevo se adopta antes de soltar el viejo— encadenan sus envoltorios, y el que se suelta
// sale de la cadena desde donde esté: arriba, el mapa recupera lo que envolvía; debajo de otro, ése pasa
// a envolverlo. Así la cadena tiene sólo anfitriones vivos. Si encima quedó un envoltorio que no es de un
// anfitrión, el suelto no puede salir y pasa de largo.
const wrapped = new WeakMap()

// Los panes que se sostienen en cada mapa, con cuántos los sostienen (ver `surface`). La cuenta es del
// mapa y no del anfitrión: con dos anfitriones vivos en él, uno puede montar el nombre que ya montó el
// otro, y el que se suelta primero no puede sacarle el nodo.
const heldPanes = new WeakMap()

const plainLatLng = ({ lat, lng }) => ({ lat, lng })
const plainPoint  = ({ x, y }) => ({ x, y })

// Un punto en cualquier forma de cristae/geometry, como el LatLng que Leaflet recibe. Lo que no tiene la
// forma de un punto lanza, y Leaflet rechaza lo que no trae dos números. La latitud no se acota acá:
// la proyección la lleva al rango del mapa.
const latLngOf = (LatLng, point) => {
  if (!hasPointShape(point)) throw new TypeError('[cristae] la cámara espera un punto')
  return new LatLng(coordOf(point, 0), coordOf(point, 1))
}

const hostOf = (map, leaflet, ownsMap, zoomPolicy) => {
  const toLatLng  = point => latLngOf(leaflet.LatLng, point)
  const listeners = Object.fromEntries(VIEW_EVENTS.map(type => [type, []]))

  // La lista se reemplaza al suscribir y al bajar, así que un reparto recorre la del momento en que
  // empezó: quien se suscribe a mitad no entra en él. Quien se baja a mitad sale también de él —la baja
  // apaga su entrada—, porque ya soltó lo que su oyente toca.
  const fire = (type, detail) => {
    const list = listeners[type]
    for (let i = 0; i < list.length; i++) list[i].live && list[i].fn(detail)
  }
  // `zoomanim` es el único con carga: la vista destino. Leaflet lo dispara antes de mover la vista, así
  // que durante el reparto `zoom()` y `center()` todavía dan la de partida.
  const relays = Object.fromEntries(VIEW_EVENTS.map(type => [type, type === 'zoomanim'
    ? e => fire(type, { center: plainLatLng(e.center), zoom: e.zoom })
    : () => fire(type)]))

  // La política decide por los dos extremos de cada zoom, lo pida quien lo pida: 'none' no anima
  // ninguno, 'in-only' sólo los que no alejan y 'on' todos (el porqué de cada modo, en SPECS §9).
  const animates = (from, to) => zoomPolicy !== 'none' && (zoomPolicy !== 'in-only' || to >= from)

  // Reemplaza un método privado del mapa por el suyo, y devuelve con qué soltarlo: al soltarse sale de la
  // cadena de envoltorios del método (ver `wrapped`).
  const intercept = (name, gate) => {
    let active = true
    const own  = function (...args) {
      const original = wrapped.get(own)
      return active ? gate.call(this, original, ...args) : original.apply(this, args)
    }
    wrapped.set(own, map[name])
    map[name] = own
    return () => {
      const inner = wrapped.get(own)
      let link    = map[name]

      active = false
      if (link === own) {
        // Lo envuelto vuelve como estaba: heredado del prototipo, o propio del mapa.
        delete map[name]
        map[name] === inner || (map[name] = inner)
      } else {
        while (wrapped.has(link) && wrapped.get(link) !== own) link = wrapped.get(link)
        wrapped.has(link) && wrapped.set(link, inner)
      }
    }
  }

  // El latch `_zoomAnimated` del mapa no se toca: Leaflet se lo copia a cada capa al agregarla, y sólo
  // con él prendido la capa se suscribe a `zoomanim`. Apagarlo dejaría a las capas ya montadas sin
  // cablear para siempre; la política filtra cada zoom en cambio, y por eso se cambia en vivo.
  // - `_tryAnimatedZoom` es donde `setView` decide si anima un cambio de zoom: la rueda, el doble
  //   click, el teclado, los botones y los comandos de la cámara. Negarlo deja que Leaflet resetee. Con
  //   un zoom animado en curso no se juzga: Leaflet ignora el pedido, y un reset a mitad de la
  //   transición dejaría la vista pedida sólo hasta que la transición termina en su destino.
  // - `_animateZoom` lo llama además el cierre del pinch, que lleva el zoom fraccionario del gesto al
  //   ajustado sin pasar por `setView`. Negado, cierra como Leaflet sin animación: con `_resetView`.
  //   Un cierre que deja el zoom donde está —dos dedos que se desplazan juntos— no es un zoom y no se
  //   juzga: `_resetView` no emitiría el `zoomend` que cierra el `zoomstart` con que abrió el gesto.
  const releases = [
    intercept('_tryAnimatedZoom', function (original, center, zoom, options) {
      return (this._animatingZoom || animates(this.getZoom(), zoom)) && original.call(this, center, zoom, options)
    }),
    intercept('_animateZoom', function (original, center, zoom, startAnim, noUpdate) {
      const from = this.getZoom()
      return from === zoom || animates(from, zoom)
        ? original.call(this, center, zoom, startAnim, noUpdate)
        : this._resetView(center, zoom)
    }),
  ]
  VIEW_EVENTS.forEach(type => map.on(type, relays[type]))

  const camera = {
    // Un mapa adoptado puede llegar sin vista, y la toma con su primer `setView`. Mientras no la tenga,
    // leer su caja o proyectar lanza.
    hasView : () => !!map._loaded,
    center  : () => plainLatLng(map.getCenter()),
    zoom    : () => map.getZoom(),
    maxZoom : () => map.getMaxZoom(),
    size    : () => plainPoint(map.getSize()),
    bounds() {
      const b = map.getBounds()
      return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }
    },

    setView(latlng, zoom, options) { map.setView(toLatLng(latlng), zoom, options) },
    panTo(latlng) { map.panTo(toLatLng(latlng)) },
    panBy(offset, options) { map.panBy(offset, options) },
    // Un vuelo es un zoom animado más: si la política no lo anima, es un `setView`, que es lo mismo que
    // hace Leaflet cuando no puede volar.
    flyTo(latlng, zoom, options) {
      const target = toLatLng(latlng)
      animates(map.getZoom(), zoom) ? map.flyTo(target, zoom, options) : map.setView(target, zoom, options)
    },
    // `box` es una caja válida e `insets`, los cuatro lados en píxeles.
    fitBounds(box, { insets: { top, right, bottom, left } }) {
      map.fitBounds([[box.south, box.west], [box.north, box.east]], {
        paddingTopLeft     : [left, top],
        paddingBottomRight : [right, bottom],
      })
    },
    setZoom(zoom) { map.setZoom(zoom) },
    zoomIn(delta) { map.zoomIn(delta) },
    zoomOut(delta) { map.zoomOut(delta) },
    // El ancla queda fija: recentrar tras un resize se percibe como un salto.
    invalidateSize() { map.invalidateSize({ pan: false }) },

    toContainer   : latlng => plainPoint(map.latLngToContainerPoint(toLatLng(latlng))),
    fromContainer : point => plainLatLng(map.containerPointToLatLng(point)),
    project       : (latlng, zoom) => plainPoint(map.project(toLatLng(latlng), zoom)),
    unproject     : (point, zoom) => plainLatLng(map.unproject(point, zoom)),
    // Dónde cae el píxel (0, 0) del contenedor en el marco que acompaña al paneo: lo que se le resta a
    // una posición del contenedor para colgarla de un pane.
    frameOrigin   : () => plainPoint(map.containerPointToLayerPoint(CONTAINER_ORIGIN)),

    get zoomPolicy() { return zoomPolicy },
    set zoomPolicy(mode) { zoomPolicy = mode },

    // `types` son uno o varios tipos separados por espacios, como en Leaflet; devuelve una sola baja.
    on(types, fn) {
      const list  = types.split(' ')
      const entry = { fn, live: true }
      list.forEach(type => listeners[type] = [...listeners[type], entry])
      return () => {
        entry.live = false
        list.forEach(type => listeners[type] = listeners[type].filter(e => e !== entry))
      }
    },
  }

  // Varias capas pueden montar el mismo nombre de pane, y lo sostienen todas. Uno que se creó se va con la
  // última. Uno que el mapa ya tenía —los de Leaflet, o uno que creó el dueño de un mapa adoptado— se
  // presta: queda en el mapa, y con la última vuelve al estilo con que se prestó, que guarda `lent`.
  const held      = heldPanes.get(map) ?? heldPanes.set(map, new Map()).get(map)
  const stylePane = (name, key, value) => {
    const node = map.getPane(name)
    node && (node.style[key] = value)
  }
  const surface = {
    container: map.getContainer(),

    // Un nodo en el marco que sigue al paneo, colgado del pane raíz del mapa. `z` y `pointer` se aplican
    // si vienen: quien sólo necesita el nodo lo toma como lo dejó el que lo configuró.
    mount(name, z, { pointer } = {}) {
      const found = map.getPane(name)
      const node  = found ?? map.createPane(name)
      const entry = held.get(name)
        ?? { count: 0, lent: found && Object.fromEntries(PANE_STYLE.map(key => [key, found.style[key]])) }
      entry.count++
      held.set(name, entry)
      z != null && (node.style.zIndex = String(z))
      pointer != null && (node.style.pointerEvents = pointer ? '' : 'none')
      return node
    },
    // Con el último que lo sostiene, un pane prestado recupera su estilo y uno propio sale. Leaflet no
    // quita panes: el nodo sale del documento, y su entrada de `_panes` y el renderer que cacheó para él
    // en `_paneRenderers`, del mapa. Si quedaran, el próximo montaje con ese nombre recibiría el nodo
    // desconectado, y un path nuevo se dibujaría en el lienzo viejo; el renderer, además, seguiría
    // redibujándose en cada movimiento. El nodo puede no estar: el dueño de un mapa adoptado lo quitó, o
    // removió el mapa entero.
    unmount(name) {
      const entry = held.get(name)
      if (!entry || --entry.count) return
      const node = map.getPane(name)
      held.delete(name)
      if (entry.lent) {
        node && Object.assign(node.style, entry.lent)
        return
      }

      const renderer = map._paneRenderers[name]
      renderer && map.removeLayer(renderer)
      delete map._paneRenderers[name]
      node?.remove()
      delete map._panes[name]
    },
    setZ       : (name, z) => stylePane(name, 'zIndex', String(z)),
    setVisible : (name, visible) => stylePane(name, 'visibility', visible ? '' : 'hidden'),
    setOpacity : (name, alpha) => stylePane(name, 'opacity', alpha >= 1 ? '' : String(alpha)),

    // Que un nodo montado acompañe la transición del zoom animado: el transform que le da quien lo montó
    // al oír `zoomanim` se interpola con el del mapa, desde la esquina del nodo. Lo hace la clase de
    // Leaflet que se le suma.
    followZoom: node => node.className += ' leaflet-zoom-animated',
  }

  // El `load` con que un mapa adoptado toma su primera vista lo oye el anfitrión, y el oyente se va con
  // él: un motor destruido no se entera de la vista que tome el mapa después.
  let onLoad = NOOP

  return {
    ready: new Promise(resolve => camera.hasView() ? resolve() : map.on('load', onLoad = () => resolve())),
    camera,
    surface,
    substrate: Object.freeze({ L: leaflet, map }),
    map,
    leaflet,
    // Un mapa adoptado sigue vivo: el anfitrión sólo le devuelve lo que le tomó y le saca lo que le puso.
    destroy() {
      releases.forEach(release => release())
      VIEW_EVENTS.forEach(type => map.off(type, relays[type]))
      map.off('load', onLoad)
      ownsMap && map.remove()
    },
  }
}

// Un mapa propio sobre `container`, con la vista inicial de `view`. `zoomAnimation` de Leaflet queda en
// su default a propósito: ver el latch, arriba. Sin otra política, el zoom no anima.
export const createLeafletHost = ({ container, view: { center = [0, 0], zoom = 2 } = {}, zoomControl = true }) =>
  hostOf(new L.Map(container, {
    preferCanvas        : true,
    fadeAnimation       : false,
    markerZoomAnimation : false,
    center              : latLngOf(L.LatLng, center),
    zoom,
    zoomControl,
  }), L, true, 'none')

// Un mapa que ya existe, con el Leaflet que lo construyó (el porqué, en SPECS §6). El mapa es de quien
// lo creó, y también su política de zoom mientras el motor no pida otra.
export const adoptLeafletHost = (map, { leaflet = L } = {}) => hostOf(map, leaflet, false, 'on')
