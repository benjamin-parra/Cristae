// Capa de IMAGEN georreferenciada en un nodo DOM propio, colgado de un pane de la superficie, como
// `HtmlLayer`: no es GL y no abre otro contexto WebGL. La imagen la decodifica y la escala el navegador.
//
// Un envoltorio de `REF × REF` px lleva la imagen: su caja no depende del tamaño natural, así que el
// layout no espera a `load` y un canvas, un video o un svg se ubican igual que una URL. Un `matrix3d` lo
// lleva a las cuatro esquinas proyectadas: con una caja es afín, y con esquinas libres es una homografía
// (`quadTransform`). Se reescribe sólo cuando la vista asienta; un paneo lo lleva el marco. Un zoom
// animado lo lleva al destino con la transición de la superficie, y uno sin destino lo reubica en cada
// `move`.
//
// La imagen se estira sobre la caja proyectada en Mercator, como en Leaflet. Una latitud más allá de
// ±85,0511 se aplasta en el borde de la proyección.

import { safe } from '../data/safe.js'
import { coordOf, isPoint } from '../data/path.js'
import { projX0, projY0 } from './project.js'
import { quadTransform } from './homography.js'

const REF = 256

// Lo que la capa escribe en el estilo de un nodo ajeno, y le devuelve al soltarlo.
const ADOPTED = {
  display   : 'block',
  width     : '100%',
  height    : '100%',
  maxWidth  : 'none',
  maxHeight : 'none',
  objectFit : 'fill',
}
const KEYS = Object.keys(ADOPTED)

const onCallbackError = e => console.error('[cristae] image-layer onLoad/onError', e)
const toMatrix        = xy => quadTransform(REF, REF, xy)
const keepLast        = () => {}

const fail = what => { throw new TypeError(`[cristae] image-layer: ${what}`) }

// Las cuatro esquinas, [lat, lng] × 4 en el orden nw, ne, se, sw, desde una caja o una lista de puntos.
// La longitud se desenvuelve: el este de una caja que cruza el antimeridiano pasa de 180, y cada esquina
// queda a ±180 de la anterior. Se valida en la proyección de zoom 0, que difiere de la del contenedor
// sólo en escala y traslación: el cuadrilátero tiene que ser convexo y con área.
const readQuad = ({ bounds, corners }) => {
  if (!bounds === !corners) fail('se pasa `bounds` o `corners`, uno de los dos')
  const quad = new Float64Array(8)
  if (bounds) {
    const { south, west, north, east } = bounds
    if (![south, west, north, east].every(Number.isFinite) || south > north) fail('`bounds` no es una caja')
    const e = west > east ? east + 360 : east
    quad.set([north, west, north, e, south, e, south, west])
  } else {
    if (corners.length !== 4 || !Array.from(corners).every(isPoint)) fail('`corners` son cuatro puntos')
    let prev = coordOf(corners[0], 1)
    for (let i = 0; i < 4; i++) {
      const lng = coordOf(corners[i], 1)
      prev = lng + 360 * Math.round((prev - lng) / 360)
      quad[i * 2]     = coordOf(corners[i], 0)
      quad[i * 2 + 1] = prev
    }
  }
  const world = new Float64Array(8)
  for (let i = 0; i < 4; i++) {
    world[i * 2]     = projX0(quad[i * 2 + 1])
    world[i * 2 + 1] = projY0(quad[i * 2])
  }
  quadTransform(REF, REF, world)
  return quad
}

const readOpacity = v => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : fail('`opacity` no es un número'))

export class ImageLayer {

  #camera; #surface; #pane; #id; #interactive
  #root
  #quad
  #opacity
  #node      = null    // lo que se ve: el <img> propio o el nodo del consumidor
  #adopted   = null    // el estilo previo del nodo del consumidor, o null si el nodo es propio
  #pending   = null    // el <img> que carga, y sus dos oyentes
  #onDone    = null
  #onFail    = null
  #shown     = false
  #transform = null
  #toward    = null
  #zooming   = false
  #xy        = new Float64Array(8)
  #at        = { lat: 0, lng: 0 }
  #offs
  #crossOrigin; #alt; #onLoad; #onError

  constructor({ host, pane, id, url, image, bounds, corners, opacity = 1, interactive = false, crossOrigin, alt = '', onLoad, onError }) {
    if (!url === !image) fail('se pasa `url` o `image`, uno de los dos')
    this.#quad    = readQuad({ bounds, corners })
    this.#opacity = readOpacity(opacity)

    const root = document.createElement('div')
    root.className = 'cristae-image-layer'
    Object.assign(root.style, {
      position        : 'absolute',
      left            : '0',
      top             : '0',
      width           : `${REF}px`,
      height          : `${REF}px`,
      transformOrigin : '0 0',
      pointerEvents   : 'none',
      userSelect      : 'none',
      visibility      : 'hidden',
      opacity         : String(this.#opacity),
    })

    this.#camera      = host.camera
    this.#surface     = host.surface
    this.#pane        = pane
    this.#id          = id
    this.#interactive = interactive
    this.#crossOrigin = crossOrigin
    this.#alt         = alt
    this.#onLoad      = onLoad
    this.#onError     = onError
    this.#root        = root
    this.#surface.followZoom(root)
    this.#surface.mount(pane).appendChild(root)
    this.#offs = [
      this.#camera.on('zoomstart', () => (this.#zooming = true)),
      this.#camera.on('zoomanim', toward => {
        this.#toward = toward
        this.#layout()
      }),
      this.#camera.on('move', () => this.#zooming && this.#layout()),
      this.#camera.on('moveend zoomend resize', () => {
        this.#zooming = false
        this.#toward  = null
        this.#layout()
      }),
    ]
    url ? this.#load(url) : this.#show(image, true)
    this.#layout()
  }

  destroy() {
    if (!this.#root) return
    this.#drop()
    this.#release()
    this.#offs.forEach(off => off())
    this.#root.remove()
    this.#surface.unmount(this.#pane)
    this.#root = null
  }

  // La caja de las cuatro esquinas, con la que la cámara encuadra la capa.
  get bounds() {
    const q = this.#quad
    return {
      south : Math.min(q[0], q[2], q[4], q[6]),
      west  : Math.min(q[1], q[3], q[5], q[7]),
      north : Math.max(q[0], q[2], q[4], q[6]),
      east  : Math.max(q[1], q[3], q[5], q[7]),
    }
  }

  // `setUrl` e `setImage` se reemplazan entre sí. La imagen vigente sigue a la vista hasta que la nueva
  // URL carga, y un `load` de una URL descartada no llega.
  setUrl(url) {
    if (!url) fail('`url` vacía')
    return this.#load(url)
  }

  setImage(node) {
    if (!node) fail('`image` vacío')
    this.#drop()
    return this.#show(node, true)
  }

  setBounds(bounds) { return this.#place({ bounds }) }
  setCorners(corners) { return this.#place({ corners }) }

  setOpacity(opacity) {
    this.#opacity = readOpacity(opacity)
    this.#root.style.opacity = String(this.#opacity)
    return this.#opacity
  }

  /* ── Picking: el punto dentro del cuadrilátero, en px de contenedor (kind 'image') ── */
  resolveClick(sample) { return this.#hitsAt(sample) }
  resolveHover(sample) { return this.#hitsAt(sample) }

  #hitsAt(sample) {
    if (!this.#interactive || !this.#shown || !this.#camera.hasView()) return []
    const xy = this.#project(null)
    let pos = 0, neg = 0
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4
      const c = (xy[j * 2] - xy[i * 2]) * (sample.y - xy[i * 2 + 1]) - (xy[j * 2 + 1] - xy[i * 2 + 1]) * (sample.x - xy[i * 2])
      c > 0 ? pos++ : c < 0 && neg++
    }
    return pos && neg ? [] : [{ ref: this.#id, id: this.#id, distancePx: 0 }]
  }

  /* ── Carga ── */

  #load(url) {
    this.#drop()
    const img  = document.createElement('img')
    const done = ok => () => {
      this.#drop()
      ok ? this.#show(img, false) : this.#hide()
      const callback = ok ? this.#onLoad : this.#onError
      callback && safe(callback, { url }, onCallbackError)
    }
    this.#onDone = done(true)
    this.#onFail = done(false)
    img.addEventListener('load', this.#onDone)
    img.addEventListener('error', this.#onFail)
    this.#crossOrigin != null && (img.crossOrigin = this.#crossOrigin)
    img.alt       = this.#alt
    img.draggable = false
    this.#pending = img
    img.src       = url
    return img
  }

  // Suelta la carga en curso: sus oyentes salen, así que ni su `load` tardío ni su `error` corren.
  #drop() {
    const img = this.#pending
    if (!img) return
    img.removeEventListener('load', this.#onDone)
    img.removeEventListener('error', this.#onFail)
    this.#pending = this.#onDone = this.#onFail = null
  }

  #show(node, adopted) {
    this.#release()
    adopted && (this.#adopted = KEYS.map(key => node.style[key]))
    Object.assign(node.style, ADOPTED)
    this.#root.appendChild(node)
    this.#node  = node
    this.#shown = true
    this.#root.style.visibility = ''
    return node
  }

  #hide() {
    this.#release()
    this.#shown = false
    this.#root.style.visibility = 'hidden'
  }

  // El nodo vigente sale del envoltorio; uno ajeno recupera el estilo con que llegó.
  #release() {
    const node = this.#node
    if (!node) return
    node.remove()
    this.#adopted?.forEach((value, i) => (node.style[KEYS[i]] = value))
    this.#adopted = null
    this.#node    = null
  }

  #place(cfg) {
    this.#quad = readQuad(cfg)
    this.#layout()
    return this.bounds
  }

  /* ── Posición ── */

  // Las esquinas en px: de contenedor, o del marco con `origin`. En un zoom animado, las de la vista
  // destino, con el centro destino en el medio del contenedor.
  #project(origin) {
    const camera = this.#camera
    const toward = origin && this.#toward
    const size   = toward && camera.size()
    const mid    = toward && camera.project(toward.center, toward.zoom)
    const q      = this.#quad
    const xy     = this.#xy
    const at     = this.#at
    for (let i = 0; i < 4; i++) {
      at.lat = q[i * 2]
      at.lng = q[i * 2 + 1]
      const p = toward ? camera.project(at, toward.zoom) : camera.toContainer(at)
      xy[i * 2]     = toward ? p.x - mid.x + size.x / 2 : p.x
      xy[i * 2 + 1] = toward ? p.y - mid.y + size.y / 2 : p.y
      if (origin) {
        xy[i * 2]     += origin.x
        xy[i * 2 + 1] += origin.y
      }
    }
    return xy
  }

  // Una vista que deforma la caja más allá de lo convexo —un polo aplastado— deja el último transform.
  #layout() {
    if (!this.#camera.hasView()) return
    const xy = this.#project(this.#camera.frameOrigin())
    const m  = safe(toMatrix, xy, keepLast)
    if (!m) return
    const transform = `matrix3d(${m.join(',')})`
    if (transform === this.#transform) return
    this.#transform            = transform
    this.#root.style.transform = transform
  }
}
