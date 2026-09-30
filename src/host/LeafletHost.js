import L from 'leaflet'
import { coordOf, hasPointShape } from '../geometry/polyline.js'

// El anfitrión: Leaflet detrás de facetas con los valores de la API (SPECS §0). Se crea sobre un
// contenedor o adopta un mapa que ya existe; es uno por mapa, y quien lo destruye es el motor que lo
// usa. Toda conversión entre Leaflet y esos valores vive acá: un punto entra con la forma de
// cristae/geometry y lo que sale es un objeto plano.
//
// La faceta es `camera`: estado, comandos, proyección, política de animación del zoom y ciclo de
// vista. `map` y `leaflet` —el mapa y el Leaflet que lo construyó— son para lo que no tiene faceta:
// panes, tiles, entrada, los sustratos vectoriales, glify y `getLeafletMap()`.

// El ciclo de vista, con un solo emisor: cada tipo tiene un oyente en el mapa, y los suscriptores del
// anfitrión se reparten ese lugar en el orden en que llegaron.
const VIEW_EVENTS = ['movestart', 'move', 'moveend', 'zoomstart', 'zoomanim', 'zoomend', 'resize']

const CONTAINER_ORIGIN = Object.freeze([0, 0])
const NOOP             = () => {}

// Lo que envuelve cada `_tryAnimatedZoom` que un anfitrión le pone a un mapa. Dos anfitriones vivos en un
// mapa —el nuevo se adopta antes de soltar el viejo— encadenan sus envoltorios, y el que se suelta sale
// de la cadena desde donde esté: arriba, el mapa recupera lo que envolvía; debajo de otro, ése pasa a
// envolverlo. Así la cadena tiene sólo anfitriones vivos. Si encima quedó un envoltorio que no es de un
// anfitrión, el suelto no puede salir y pasa de largo.
const wrapped = new WeakMap()

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

  // La política decide por los dos extremos de cada zoom: 'none' no anima ninguno, 'in-only' sólo los
  // que no alejan y 'on' todos (el porqué de cada modo, en SPECS §9).
  const animates = (from, to) => zoomPolicy !== 'none' && (zoomPolicy !== 'in-only' || to >= from)

  // El latch `_zoomAnimated` del mapa no se toca: Leaflet se lo copia a cada capa al agregarla, y sólo
  // con él prendido la capa se suscribe a `zoomanim`. Apagarlo dejaría a las capas ya montadas sin
  // cablear para siempre; la política filtra cada zoom en cambio, y por eso se cambia en vivo.
  // `_tryAnimatedZoom` es donde `setView` decide si anima un cambio de zoom: la rueda, el doble click,
  // el teclado, los botones y los comandos de la cámara. Negarlo deja que Leaflet resetee. Con un zoom
  // animado en curso no se juzga: Leaflet ignora el pedido, y un reset a mitad de la transición dejaría
  // la vista pedida sólo hasta que la transición termina en su destino.
  let active = true
  const gate = function (center, zoom, options) {
    return (!active || this._animatingZoom || animates(this.getZoom(), zoom))
      && wrapped.get(gate).call(this, center, zoom, options)
  }
  wrapped.set(gate, map._tryAnimatedZoom)
  map._tryAnimatedZoom = gate
  VIEW_EVENTS.forEach(type => map.on(type, relays[type]))

  const camera = {
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
    flyTo(latlng, zoom, options) { map.flyTo(toLatLng(latlng), zoom, options) },
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

    // Devuelve la baja.
    on(type, fn) {
      const entry     = { fn, live: true }
      listeners[type] = [...listeners[type], entry]
      return () => {
        entry.live      = false
        listeners[type] = listeners[type].filter(e => e !== entry)
      }
    },
  }

  // Un mapa adoptado puede llegar sin vista, y la toma con su primer `setView`, que dispara `load`. El
  // oyente es del anfitrión y se va con él: un motor destruido no se entera de la vista que tome el mapa.
  let onLoad = NOOP

  return {
    ready: new Promise(resolve => map._loaded ? resolve() : map.on('load', onLoad = () => resolve())),
    camera,
    map,
    leaflet,
    // Un mapa adoptado sigue vivo: el anfitrión sólo le devuelve lo que le tomó y le saca lo que le puso.
    // Lo envuelto vuelve como estaba, heredado o propio del mapa.
    destroy() {
      const inner = wrapped.get(gate)
      let link    = map._tryAnimatedZoom

      active = false
      if (link === gate) {
        delete map._tryAnimatedZoom
        map._tryAnimatedZoom === inner || (map._tryAnimatedZoom = inner)
      } else {
        while (wrapped.has(link) && wrapped.get(link) !== gate) link = wrapped.get(link)
        wrapped.has(link) && wrapped.set(link, inner)
      }
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
