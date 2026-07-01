import { LitElement, nothing } from 'lit'

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 }
// La tarjeta se ancla por su base-centro al punto (su pico apunta al dato). Si cambia este transform,
// hay que ajustar la geometría de #applyClip/#autoPan, que asumen base-centro (−50% x, −100% y).
const NODE_TRANSFORM = 'translate(-50%,-100%)'

// Lee un par numérico desde un atributo string ("[8,12]", "8,12") → [x, y], o null si no parsea.
const parsePair = (v) => {
  if (Array.isArray(v)) return v
  const nums = String(v).match(/-?\d+(?:\.\d+)?/g)?.map(Number)
  return nums && nums.length >= 2 ? [nums[0], nums[1]] : null
}

// Convierte un atributo booleano "presente = ON, default ON": ausente → undefined (tratado como ON
// por los chequeos `=== false`); `"false"`/`"0"` → OFF. Reactivo al valor, no al timing.
const boolDefaultOn = { fromAttribute: (v) => v !== 'false' && v !== '0' }

// <cristae-popup for="fleet"> — tarjeta HTML anclada al dato. NO es una capa GL: es un overlay del
// consumidor que vive en LIGHT DOM (un nodo flotante en document.body), así que el CSS de página lo
// estiliza (a diferencia de un popup de Leaflet, que quedaría dentro del shadow root del mapa). Se
// posiciona proyectando la posición del item a píxeles con la cámara y se reubica en cada cambio de
// viewport/scroll. El contenido lo da la prop `contentOf(item) => string | Node`.
//
//   <cristae-popup for="fleet"></cristae-popup>
//   popup.contentOf = m => `<div class="card"><b>${m.patente}</b><br>${m.estado}</div>`
//
// Se abre al click sobre la capa `for` y se cierra al click fuera o con Escape. También imperativo:
// `popup.open(item, { lat, lng })` / `popup.close()`. El contenedor se estiliza con `.cristae-popup`.
//
// Auto-pan (por defecto ON, como Leaflet): al abrir, si la caja se sale del recuadro visible —el
// contenedor MENOS los viewport-insets que ocluyen UI— la cámara panea lo justo para meterla,
// dejando `auto-pan-padding` de margen. Se desactiva con `auto-pan="false"`.
//
// `pinned` (default ON): la tarjeta queda fijada al PUNTO geográfico → se mueve con el mapa (re-proyecta
// el ancla en cada cambio de viewport). Con `pinned="false"` queda fija en su posición de pantalla sobre
// el mapa (ignora pan/zoom; solo sigue el desplazamiento del propio widget al hacer scroll de página).
//
// `clip` (default ON): si la caja se sale de los límites del mapa (p. ej. al panear), la parte que
// sobresale NO se muestra (clip-path, recorte en el compositor). Sin coste por frame: usa el tamaño
// cacheado en `open`, así no fuerza reflow del nodo al reposicionar.
export class CristaePopup extends LitElement {

  static properties = {
    for: { attribute: 'for' },          // id de la capa cuyos clicks abren la tarjeta
    offset: { attribute: false },       // [dx, dy] en px desde el punto (default: 12px hacia arriba)
    // Reactiva al valor: ausente → ON (default Leaflet); `auto-pan="false"`/`"0"` → OFF.
    autoPan: { attribute: 'auto-pan', converter: boolDefaultOn },
    // Margen en px [x, y] entre la caja y el borde de la región visible al panear (default [20, 20]).
    autoPanPadding: { attribute: 'auto-pan-padding', converter: { fromAttribute: parsePair } },
    // Fijada al dato (sigue al mapa) vs. fija en pantalla. Default ON. Ver nota de cabecera.
    pinned: { attribute: 'pinned', converter: boolDefaultOn },
    // Recorta lo que sobresalga de los límites del mapa. Default ON.
    clip: { attribute: 'clip', converter: boolDefaultOn },
  }

  render() { return nothing }           // sin UI en el shadow: el nodo flotante vive en light DOM

  #map = null
  #node = null
  #anchor = null                        // { lat, lng } del item abierto, o null si está cerrada
  #screenPt = null                      // punto del contenedor congelado para modo `pinned="false"`
  #w = 0                                // tamaño de la caja, medido en `open` (1 reflow por apertura)
  #h = 0
  #lmap = null                          // L.Map crudo enganchado para el `move` continuo (paneo/inercia)
  #onClick = (e) => this.#openFromHit(e.detail.hits)
  #onViewport = () => this.#reposition()
  #onReady = () => this.#bindLeafletMove()
  #onKey = (e) => { if (e.key === 'Escape') this.close() }

  connectedCallback() {
    super.connectedCallback()
    this.#map = this.closest('cristae-map')
    if (!this.#map) return
    this.#node = document.createElement('div')
    this.#node.className = 'cristae-popup'
    this.#node.style.cssText = `position:fixed; z-index:10000; display:none; transform:${NODE_TRANSFORM}`
    document.body.appendChild(this.#node)
    // Eventos en el ELEMENTO mapa (no en el engine): sobreviven a un re-mount, y la cámara se lee viva.
    this.#map.addEventListener('cristae:click', this.#onClick)
    this.#map.addEventListener('cristae:viewportchange', this.#onViewport)
    // El motor solo emite `viewportchange` en moveend/zoomend (señal de baja frecuencia, por contrato).
    // Para que la tarjeta y su clip sigan el paneo/inercia EN CONTINUO enganchamos el `move` crudo del
    // L.Map. Se (re)engancha por montaje vía cristae:ready (otro motor → otro mapa); intento inmediato
    // por si el motor ya estaba listo cuando se conectó la tarjeta.
    this.#map.addEventListener('cristae:ready', this.#onReady)
    this.#bindLeafletMove()
    addEventListener('scroll', this.#onViewport, true)
    addEventListener('resize', this.#onViewport)
    document.addEventListener('keydown', this.#onKey)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this.#map?.removeEventListener('cristae:click', this.#onClick)
    this.#map?.removeEventListener('cristae:viewportchange', this.#onViewport)
    this.#map?.removeEventListener('cristae:ready', this.#onReady)
    this.#lmap?.off('move', this.#onViewport)
    this.#lmap = null
    removeEventListener('scroll', this.#onViewport, true)
    removeEventListener('resize', this.#onViewport)
    document.removeEventListener('keydown', this.#onKey)
    this.#node?.remove()
    this.#node = null
  }

  // Engancha el `move` continuo del L.Map vivo (paneo/inercia/flyTo/panBy). Idempotente: si el mapa no
  // cambió, no hace nada; si cambió (re-mount), suelta el anterior y engancha el nuevo. No cachear entre
  // montajes es la regla para el consumidor; acá la tarjeta re-vincula sola en cada cristae:ready.
  #bindLeafletMove() {
    const lmap = this.#map?.engine?.getLeafletMap()
    if (!lmap || lmap === this.#lmap) return
    this.#lmap?.off('move', this.#onViewport)
    this.#lmap = lmap
    lmap.on('move', this.#onViewport)
  }

  // Abre la tarjeta sobre un item, en una posición geográfica. La invoca el click o el consumidor.
  open(item, latlng) {
    const content = this.contentOf?.(item)
    if (content == null || !this.#node) return
    if (typeof content === 'string') this.#node.innerHTML = content
    else this.#node.replaceChildren(content)
    this.#node.style.display = ''
    this.#anchor = latlng
    this.#screenPt = null              // se fija en el primer #reposition (punto inicial de apertura)
    this.#measure()                    // tamaño con el contenido visible — cacheado para clip/auto-pan
    this.#reposition()
    this.#autoPan()
  }

  close() {
    if (this.#node) this.#node.style.display = 'none'
    this.#anchor = null
  }

  // Toggle reactivo de pinned/clip en caliente: reubica al instante, sin esperar un viewportchange.
  updated() { if (this.#anchor) this.#reposition() }

  // Mide la caja una vez por apertura (clip y auto-pan trabajan luego con este tamaño cacheado, así el
  // reposicionamiento por frame no fuerza reflow del nodo). clip-path no afecta el rect → medida limpia.
  #measure() {
    const r = this.#node.getBoundingClientRect()
    this.#w = r.width
    this.#h = r.height
  }

  // Click en el mapa: abre sólo si la capa `for` es el TOP hit (no si quedó ocluida debajo de otra
  // capa interactiva — p. ej. una burbuja de cluster encima de un punto). Empty-safe: hits=[] (click
  // al vacío) → hit null → cierra. Esto evita que clickear un cluster/spider abra el popup de un punto
  // tapado. `hits` viene ordenado top-first (LayerRegistry.resolveHits).
  #openFromHit(hits) {
    const hit = hits[0]?.layerId === this.for ? hits[0] : null
    const record = hit && this.#map.getLayer(this.for)
    const item = record?.source?.itemById?.(hit.id)
    if (item == null) { this.close(); return }
    // Si el hit trae posición propia (overlay que presenta una hoja en su lugar desplegado), anclar ahí;
    // si no, en la posición real del item.
    this.open(item, hit.latlng ?? record.source.accessors.positionOf(item))
  }

  #reposition() {
    if (!this.#anchor) return
    const cam = this.#map?.camera
    if (!cam) return
    const rect = this.#map.getBoundingClientRect()
    // Punto del contenedor: pinned → re-proyecta el ancla viva (sigue al mapa) y memoriza el spot;
    // unpinned → reusa el spot congelado (queda fijo en pantalla, ajeno a pan/zoom).
    let cx, cy
    if (this.pinned === false && this.#screenPt) {
      cx = this.#screenPt.x; cy = this.#screenPt.y
    } else {
      const pt = cam.latLngToContainerPoint([this.#anchor.lat, this.#anchor.lng])
      cx = pt.x; cy = pt.y
      this.#screenPt = { x: cx, y: cy }
    }
    const [dx, dy] = this.offset ?? [0, -12]
    const nodeLeft = rect.left + cx + dx
    const nodeTop = rect.top + cy + dy
    this.#node.style.left = `${nodeLeft}px`
    this.#node.style.top = `${nodeTop}px`
    this.#applyClip(rect, cam.insets ?? ZERO_INSETS, nodeLeft, nodeTop)
  }

  // Recorta con clip-path la fracción de la caja que sobresale de la REGIÓN VISIBLE = rect del mapa
  // MENOS los viewport-insets (la franja que ocupan los widgets/paneles) → la tarjeta no se monta sobre
  // ellos. Geometría derivada del tamaño cacheado + transform base-centro (sin getBoundingClientRect en
  // el camino caliente). inset() mayor que el lado oculta ese lado entero → caja totalmente fuera =
  // invisible. clip-path es recorte de compositor (no relayout). Off → limpia la propiedad si estaba.
  #applyClip(rect, ins, nodeLeft, nodeTop) {
    const node = this.#node
    if (this.clip === false) { if (node.style.clipPath) node.style.clipPath = ''; return }
    const vTop = rect.top + ins.top, vBottom = rect.bottom - ins.bottom
    const vLeft = rect.left + ins.left, vRight = rect.right - ins.right
    const left = nodeLeft - this.#w / 2, right = nodeLeft + this.#w / 2
    const top = nodeTop - this.#h, bottom = nodeTop
    const cTop = Math.max(0, vTop - top)
    const cRight = Math.max(0, right - vRight)
    const cBottom = Math.max(0, bottom - vBottom)
    const cLeft = Math.max(0, vLeft - left)
    node.style.clipPath = (cTop || cRight || cBottom || cLeft)
      ? `inset(${cTop}px ${cRight}px ${cBottom}px ${cLeft}px)`
      : ''
  }

  // Si la caja ya posicionada se sale de la región visible (contenedor menos viewport-insets),
  // panea la cámara lo justo para meterla con `auto-pan-padding` de margen. Mismo cálculo que el
  // _adjustPan de Leaflet pero contra los insets del mapa. El panBy dispara `viewportchange` →
  // #reposition reubica la tarjeta sobre su ancla viva (sin re-disparar auto-pan: solo abre acá).
  // Solo en modo pinned: si la tarjeta no sigue al mapa, panear la cámara no la metería en cuadro.
  #autoPan() {
    if (this.autoPan === false || this.pinned === false || !this.#anchor || !this.#node) return
    const cam = this.#map?.camera
    if (!cam) return

    const rect = this.#map.getBoundingClientRect()
    // Caja en coords del contenedor, desde el tamaño cacheado + transform base-centro.
    const pt = cam.latLngToContainerPoint([this.#anchor.lat, this.#anchor.lng])
    const [ox, oy] = this.offset ?? [0, -12]
    const nx = pt.x + ox, ny = pt.y + oy
    const left = nx - this.#w / 2, right = nx + this.#w / 2, top = ny - this.#h, bottom = ny

    const ins = cam.insets ?? ZERO_INSETS
    const [px, py] = this.autoPanPadding ?? [20, 20]
    const minX = ins.left + px, minY = ins.top + py
    const maxX = rect.width - ins.right - px, maxY = rect.height - ins.bottom - py

    let dx = 0, dy = 0
    if (right > maxX) dx = right - maxX
    if (left - dx < minX) dx = left - minX        // el borde de entrada manda si la caja no entra entera
    if (bottom > maxY) dy = bottom - maxY
    if (top - dy < minY) dy = top - minY
    if (dx || dy) cam.panBy([dx, dy])
  }
}
