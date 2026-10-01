import L from 'leaflet'
import { coordOf, hasPointShape } from '../data/path.js'
import { retainTileSnapshots } from './TileSnapshotRetention.js'
import { TILE_FILTER } from './styles.js'

// El anfitrión: Leaflet detrás de facetas con los valores de la API (SPECS §0). Se crea sobre un
// contenedor o adopta un mapa que ya existe; es uno por mapa, y quien lo destruye es el motor que lo
// usa. Toda conversión entre Leaflet y esos valores vive acá: un punto entra con la forma de
// cristae/geometry y lo que sale es un objeto plano.
//
// Las facetas son `camera` —estado, comandos, proyección, política de animación del zoom y ciclo de
// vista—, `surface`, los nodos donde dibujan las capas, `tiles`, el proveedor de la capa base con la
// retención de su imagen y su atribución, e `input`, la entrada del contenedor y el arrastre del mapa.
// `map` queda para `getLeafletMap()`.

// El ciclo de vista, con un solo emisor: cada tipo tiene un oyente en el mapa, y los suscriptores del
// anfitrión se reparten ese lugar en el orden en que llegaron. `zoomlevelschange` avisa que cambiaron los
// topes del zoom —un límite, o una capa que trae los suyos—, aunque la vista no se mueva.
const VIEW_EVENTS = ['movestart', 'move', 'moveend', 'zoomstart', 'zoomanim', 'zoomend', 'resize', 'zoomlevelschange']

// Los eventos del contenedor en que se relee si el arrastre del mapa sigue en curso (ver `input`).
const DRAG_SYNC = ['pointerup', 'pointerenter']
const PASSIVE   = Object.freeze({ passive: true })
const NOOP      = () => {}

const CONTAINER_ORIGIN = Object.freeze([0, 0])

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
// Una caja de la API como el par de esquinas que Leaflet lee; sin caja, nada.
const cornersOf   = box => box && [[box.south, box.west], [box.north, box.east]]

// Los límites de la cámara en las opciones de Leaflet. Uno nulo no limita, que es su default: sin
// `maxZoom` rige el tope de los tiles.
const leafletLimits = ({ minZoom, maxZoom, maxBounds, viscosity } = {}) => ({
  minZoom            : minZoom ?? undefined,
  maxZoom            : maxZoom ?? undefined,
  maxBounds          : cornersOf(maxBounds),
  maxBoundsViscosity : viscosity ?? 0,
})

// Un punto en cualquier forma de cristae/geometry, como el LatLng que Leaflet recibe. Lo que no tiene la
// forma de un punto lanza, y Leaflet rechaza lo que no trae dos números. La latitud no se acota acá:
// la proyección la lleva al rango del mapa.
const latLngOf = (LatLng, point) => {
  if (!hasPointShape(point)) throw new TypeError('[cristae] la cámara espera un punto')
  return new LatLng(coordOf(point, 0), coordOf(point, 1))
}

// Los avisos que reparte el anfitrión, con una lista por tipo. La lista se reemplaza al suscribir y al
// bajar, así que un reparto recorre la del momento en que empezó: quien se suscribe a mitad no entra en
// él. Quien se baja a mitad sale también de él —la baja apaga su entrada—, porque ya soltó lo que su
// oyente toca. `on` toma uno o varios tipos separados por espacios, como en Leaflet, y devuelve una sola
// baja.
const emitter = types => {
  const lists = Object.fromEntries(types.map(type => [type, []]))
  return {
    fire(type, detail) {
      const list = lists[type]
      for (let i = 0; i < list.length; i++) list[i].live && list[i].fn(detail)
    },
    on(names, fn) {
      const each  = names.split(' ')
      const entry = { fn, live: true }
      each.forEach(type => lists[type] = [...lists[type], entry])
      return () => {
        entry.live = false
        each.forEach(type => lists[type] = lists[type].filter(e => e !== entry))
      }
    },
  }
}

const hostOf = (map, leaflet, ownsMap, zoomPolicy) => {
  const toLatLng  = point => latLngOf(leaflet.LatLng, point)
  const container = map.getContainer()
  const view      = emitter(VIEW_EVENTS)

  // `zoomanim` es el único con carga: la vista destino. Leaflet lo dispara antes de mover la vista, así
  // que durante el reparto `zoom()` y `center()` todavía dan la de partida.
  const relays = Object.fromEntries(VIEW_EVENTS.map(type => [type, type === 'zoomanim'
    ? e => view.fire(type, { center: plainLatLng(e.center), zoom: e.zoom })
    : () => view.fire(type)]))

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

  // Los cuatro límites en las opciones de Leaflet: la viscosidad la lee cada arrastre al empezar. Los de
  // un mapa adoptado son de su dueño: se guardan la primera vez que el motor pone los suyos y vuelven al
  // soltarlo, ya sin los listeners del ciclo de vista, porque lo que el mapa se mueva entonces es del dueño.
  const applyLimits = ({ minZoom, maxZoom, maxBounds, maxBoundsViscosity }) => {
    map.options.maxBoundsViscosity = maxBoundsViscosity
    map.setMinZoom(minZoom)
    map.setMaxZoom(maxZoom)
    map.setMaxBounds(maxBounds)
  }
  let ownerLimits

  const camera = {
    // Un mapa adoptado puede llegar sin vista, y la toma con su primer `setView`. Mientras no la tenga,
    // leer su caja o proyectar lanza.
    hasView : () => !!map._loaded,
    center  : () => plainLatLng(map.getCenter()),
    zoom    : () => map.getZoom(),
    minZoom : () => map.getMinZoom(),
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
    // hace Leaflet cuando no puede volar. El vuelo de Leaflet no pasa por los topes, como sí `setView`: el
    // zoom se topa antes, y la política juzga el zoom en que queda la vista.
    flyTo(latlng, zoom, options) {
      const target = toLatLng(latlng)
      const to     = Math.min(Math.max(zoom, map.getMinZoom()), map.getMaxZoom())
      animates(map.getZoom(), to) ? map.flyTo(target, to, options) : map.setView(target, to, options)
    },
    // `box` es una caja válida e `insets`, los cuatro lados en píxeles. `maxZoom`, si no es nulo, topa el
    // zoom antes de centrar, así que la caja queda en el medio de la región visible también cuando corta.
    // `animate` es el de `setView`: con `false` no anima nada.
    fitBounds(box, { insets: { top, right, bottom, left }, maxZoom, animate }) {
      map.fitBounds(cornersOf(box), {
        paddingTopLeft     : [left, top],
        paddingBottomRight : [right, bottom],
        maxZoom,
        animate,
      })
    },
    setZoom(zoom) { map.setZoom(zoom) },
    zoomIn(delta) { map.zoomIn(delta) },
    zoomOut(delta) { map.zoomOut(delta) },
    // Fija los cuatro. Una vista que queda fuera la trae Leaflet adentro con un movimiento.
    setLimits(limits) {
      const { minZoom, maxZoom, maxBounds, maxBoundsViscosity } = map.options
      ownsMap || (ownerLimits ??= { minZoom, maxZoom, maxBounds, maxBoundsViscosity })
      applyLimits(leafletLimits(limits))
    },
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

    on: view.on,
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
    container,

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

  // Un proveedor a la vez (docs/tiles.md#el-proveedor-lo-pone-el-anfitrión). La retención va antes que la
  // capa, por el orden en que Leaflet avisa el reset (docs/tiles.md#la-retención). La atribución es la del
  // proveedor vigente, como la dio: la dibuja quien usa el mapa, porque el anfitrión no pone controles.
  let tileLayer        = null
  let releaseRetention = null
  const tiles          = {
    attribution: () => tileLayer?.getAttribution() ?? null,
    // Las opciones, salvo `url`, van tal cual a la capa de Leaflet. Su nodo nace cuando la capa entra al
    // mapa, que en uno adoptado sin vista es en su primer `setView`: el filtro se le pone ahí.
    setProvider({ url, ...options } = {}) {
      releaseRetention?.()
      tileLayer?.remove()
      tileLayer        = new leaflet.TileLayer(url, options)
        .on('add', ({ target }) => { target.getContainer().style.filter = TILE_FILTER })
      releaseRetention = retainTileSnapshots(map, surface, tileLayer)
      tileLayer.addTo(map)
    },
  }

  // El arrastre del usuario, que `onDrag` avisa con `true` al empezar y `false` al terminar. Leaflet lo
  // abre con `dragstart`, cuando todavía no lo marca en curso; cuándo termina, aunque Leaflet lo corte
  // sin `dragend`, y en qué eventos se relee, en docs/interaction.md#el-cursor-del-contenedor. Se oye
  // desde que alguien lo pide.
  const drag        = emitter(['drag'])
  let dragging      = false
  let dragHeard     = false
  const setDragging = value => {
    if (value === dragging) return
    dragging = value
    drag.fire('drag', value)
  }
  const startDrag = () => setDragging(true)
  const syncDrag  = () => setDragging(!!map.dragging.moving())
  const hearDrag  = (onMap, onContainer) => {
    map[onMap]('dragstart', startDrag)
    map[onMap]('dragend moveend', syncDrag)
    DRAG_SYNC.forEach(type => container[onContainer](type, syncDrag, PASSIVE))
  }

  // Lo que no cuelga de `mapPane` es la UI que Leaflet pone en el contenedor: los controles, que un mapa
  // propio no trae.
  const mapPane = map.getPane('mapPane')

  const input = {
    // El evento tal como llega al contenedor: `on` y `off` son su `addEventListener` y su
    // `removeEventListener`, con las mismas opciones. El anfitrión oye en burbuja sobre ese mismo nodo
    // —su arrastre, su zoom por doble click—, así que un oyente en captura oye cada evento antes que él, y
    // cortar ahí su propagación se lo saca.
    on  : (type, fn, options) => container.addEventListener(type, fn, options),
    off : (type, fn, options) => container.removeEventListener(type, fn, options),

    // Si el destino de un evento es la superficie del mapa —el contenedor o lo que cuelga de sus panes— y
    // no la UI del anfitrión.
    onSurface: target => target === container || mapPane.contains(target),
    // Un doble click que Cristae consumió no hace zoom. Se llama desde un oyente en captura (ver `on`).
    suppressDoubleClickZoom: event => event.stopPropagation(),

    onDrag(fn) {
      dragHeard || hearDrag('on', 'addEventListener')
      dragHeard = true
      return drag.on('drag', fn)
    },
    // Presta el arrastre del mapa a quien tomó el puntero, y devuelve con qué soltarlo. Sólo se presta lo
    // que estaba prendido: un mapa que su dueño dejó fijo no se puede «devolver».
    lendDrag() {
      const handler = map.dragging
      if (!handler.enabled()) return NOOP
      handler.disable()
      return () => handler.enable()
    },
  }

  // El `load` con que un mapa adoptado toma su primera vista lo oye el anfitrión, y el oyente se va con
  // él: un motor destruido no se entera de la vista que tome el mapa después.
  let onLoad = NOOP

  return {
    ready: new Promise(resolve => camera.hasView() ? resolve() : map.on('load', onLoad = () => resolve())),
    camera,
    surface,
    tiles,
    input,
    map,
    // Un mapa adoptado sigue vivo: el anfitrión sólo le devuelve lo que le tomó y le saca lo que le puso.
    destroy() {
      releases.forEach(release => release())
      releaseRetention?.()
      tileLayer?.remove()
      VIEW_EVENTS.forEach(type => map.off(type, relays[type]))
      ownerLimits && applyLimits(ownerLimits)
      map.off('load', onLoad)
      dragHeard && hearDrag('off', 'removeEventListener')
      ownsMap && map.remove()
    },
  }
}

// Un mapa propio sobre `container`, con la vista inicial de `view` y los límites de `limits`, que van en
// la construcción para que esa vista ya los cumpla: puestos después, la corregirían con un movimiento.
// `zoomAnimation` de Leaflet queda en su default a propósito: ver el latch, arriba. Sin otra política,
// el zoom no anima. Nace sin controles: el contenedor es pura superficie, y el zoom y la atribución los
// dibuja quien usa el mapa, fuera de él.
export const createLeafletHost = ({ container, view: { center = [0, 0], zoom = 2 } = {}, limits }) =>
  hostOf(new L.Map(container, {
    preferCanvas        : true,
    fadeAnimation       : false,
    markerZoomAnimation : false,
    zoomControl         : false,
    attributionControl  : false,
    center              : latLngOf(L.LatLng, center),
    zoom,
    ...leafletLimits(limits),
  }), L, true, 'none')

// Un mapa que ya existe, con el Leaflet que lo construyó (el porqué, en SPECS §6). El mapa es de quien
// lo creó, y también su política de zoom mientras el motor no pida otra.
export const adoptLeafletHost = (map, { leaflet = L } = {}) => hostOf(map, leaflet, false, 'on')
