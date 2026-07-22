import { LitElement, nothing } from 'lit'
import { safe } from '../data/safe.js'
import { computePlacement, stagesFrom } from './popupPlacement.js'
import { resolvePopupHit } from './popupResolution.js'
import { parsePair, parseTokens, fitFromAttribute, boolDefaultOn, boolOff, finitePos } from './attrs.js'

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 }
// La tarjeta se ancla por su base-centro al punto (su pico apunta al dato). Si cambia este transform,
// hay que ajustar la geometría de #applyClip/#autoPan, que asumen base-centro (−50% x, −100% y).
const NODE_TRANSFORM = 'translate(-50%,-100%)'

// onError estable de módulo para `safe` ([0-alloc], ver safe.js): el flush corre dentro del
// fan-out del Emitter — un `contentOf` que lance no debe cortar la entrega al resto.
const onFlushError = (e) => console.error('[cristae-popup] contentOf/flush', e)

// <cristae-popup for="fleet"> — tarjeta HTML anclada al dato. NO es una capa GL: es un overlay del
// consumidor que vive en LIGHT DOM (nodos flotantes en document.body), así que el CSS de página lo
// estiliza (a diferencia de un popup de Leaflet, que quedaría dentro del shadow root del mapa). Se
// posiciona proyectando la posición del item a píxeles con la cámara y se reubica en cada cambio de
// viewport/scroll. El contenido lo da la prop `contentOf(item) => string | Node`.
//
//   <cristae-popup for="fleet"></cristae-popup>
//   popup.contentOf = m => `<div class="card"><b>${m.patente}</b><br>${m.estado}</div>`
//
// `for` acepta uno o varios ids de capa (token-list, como el `headers` del DOM) — capas hermanas
// que presentan los MISMOS datos (p. ej. una capa espejo/resaltado sobre su capa base): el click
// en cualquiera abre la misma tarjeta. Se abre cuando el TOP hit es de una capa `for` y se cierra
// al click fuera o con Escape. También imperativo: `open(item, latlng?)` / `close(id?)` (una
// tarjeta por id de dato, o todas). El contenedor se estiliza con `.cristae-popup`.
//
// ANCLA VIVA (default): abierta sin `latlng`, la tarjeta queda anclada AL ITEM — se suscribe a la
// Source de su capa y en cada flush (ya coalescido a rAF por el Emitter, mismo patrón que
// Camera.followPoint) relee el dato: si se movió (`move`/`patch`) lo sigue; si su objeto fue
// REEMPLAZADO (`set`/`patch`) re-ejecuta `contentOf`; si el id salió del dataset se cierra. Sin
// señales propias: comparaciones O(1) por tarjeta en el flush, y un move NUNCA re-ejecuta
// `contentOf`. Un `latlng` explícito (colocación deliberada — p. ej. una hoja presentada por un
// overlay en su lugar desplegado) congela el ancla; `follow="false"` congela todas. `refresh()`
// re-ejecuta `contentOf` de lo abierto sin panear la cámara.
//
// `max-open` (default 1): tarjetas simultáneas. Con 1, abrir reemplaza; con N>1 cada item abre la
// suya (re-click la renueva) y al exceder N cae la más antigua. Cambiarlo en caliente aplica en la
// próxima apertura.
//
// Auto-pan (por defecto ON, como Leaflet): al ABRIR, si la caja se sale del recuadro visible —el
// contenedor MENOS los viewport-insets que ocluyen UI— la cámara panea lo justo para meterla,
// dejando `auto-pan-padding` de margen. Se desactiva con `auto-pan="false"`. Sólo al abrir: los
// re-anclajes del seguimiento y los re-render de contenido no mueven la cámara.
//
// `pinned` (default ON): la tarjeta queda fijada al PUNTO geográfico → se mueve con el mapa (re-proyecta
// el ancla en cada cambio de viewport). Con `pinned="false"` queda fija en su posición de pantalla sobre
// el mapa (ignora pan/zoom y el ancla viva; solo sigue el desplazamiento del propio widget al hacer
// scroll de página).
//
// `clip` (default ON): si la caja se sale de los límites del mapa (p. ej. al panear), la parte que
// sobresale NO se muestra (clip-path, recorte en el compositor). Sin coste por frame: usa el tamaño
// cacheado al renderizar, así no fuerza reflow del nodo al reposicionar.
//
// `fit` (OPT-IN, ausente por defecto): keep-in-view que mueve la TARJETA (no la cámara). Los tokens
// activan etapas de un pipeline fijo lado→corrimiento→recorte — su orden es irrelevante:
//   · flip  → abre encima o debajo del ancla según dónde entre (más espacio como desempate);
//   · shift → desliza la caja lo mínimo para que entre;
//   · clip  → recorta el residuo contra el borde real (`fit-padding` sólo anticipa flip/shift).
// La geometría vive en popupPlacement.js (pura: misma entrada ⇒ misma salida) y la caja calculada
// es la pintada (left/top literales, sin transform; `data-side` expone el lado elegido). Encuadra
// igual un ancla normal y una desplazada por cluster/spider. SIN `fit`, todo lo anterior aplica
// sin cambios.
export class CristaePopup extends LitElement {

  static properties = {
    for: { attribute: 'for' },          // id(s) de capa cuyos clicks abren la tarjeta (token-list)
    offset: { attribute: false },       // [dx, dy] en px desde el punto (default: 12px hacia arriba)
    // Reactiva al valor: ausente → ON (default Leaflet); `auto-pan="false"`/`"0"` → OFF.
    autoPan: { attribute: 'auto-pan', converter: boolDefaultOn },
    // Margen en px [x, y] entre la caja y el borde de la región visible al panear (default [20, 20]).
    autoPanPadding: { attribute: 'auto-pan-padding', converter: { fromAttribute: parsePair } },
    // Fijada al dato (sigue al mapa) vs. fija en pantalla. Default ON. Ver nota de cabecera.
    pinned: { attribute: 'pinned', converter: boolDefaultOn },
    // Recorta lo que sobresalga de los límites del mapa. Default ON.
    clip: { attribute: 'clip', converter: boolDefaultOn },
    // Ancla VIVA: la tarjeta sigue la posición del item. Default ON. Ver nota de cabecera.
    follow: { attribute: 'follow', converter: boolDefaultOn },
    // Tarjetas simultáneas (default 1 = abrir reemplaza). Ver nota de cabecera.
    maxOpen: { attribute: 'max-open', converter: { fromAttribute: (v) => Number(v) } },
    // Etapas keep-in-view (opt-in). Ausente, vacío o removido ⇒ camino legacy. Ver cabecera + #placeFit.
    fit: { attribute: 'fit', converter: { fromAttribute: fitFromAttribute } },
    // Margen [x,y] px que anticipa flip/shift (default [20,20]). Alias de `auto-pan-padding`.
    fitPadding: { attribute: 'fit-padding', converter: { fromAttribute: parsePair } },
  }

  render() { return nothing }           // sin UI en el shadow: los nodos flotantes viven en light DOM

  #map = null
  #lmap = null                          // L.Map crudo enganchado para el `move` continuo (paneo/inercia)
  // Tarjetas abiertas por clave de dato (orden de inserción = antigüedad para el cupo `max-open`;
  // la más reciente queda arriba sola, por orden de append en el body). Cada una es un registro
  // plano — mismo patrón que Camera#follow: { key, item, binding, node, live, lat, lng, screenPt,
  // w, h, ro, unsub }. lat/lng son copia numérica del ancla (el override de `move()` se muta in
  // place; una ref compartida rompería la comparación de cambio).
  #popups = new Map()
  #warned = new Set()      // capas `for` no resolubles ya avisadas (un warning por capa)
  #onClick = (e) => this.#openFromHit(e.detail.hits)
  #onViewport = () => this.#popups.forEach((p) => this.#place(p))
  #onReady = () => this.#bindLeafletMove()
  #onKey = (e) => { if (e.key === 'Escape') this.close() }

  connectedCallback() {
    super.connectedCallback()
    this.#map = this.closest('cristae-map')
    if (!this.#map) return
    // Eventos en el ELEMENTO mapa (no en el engine): sobreviven a un re-mount, y la cámara se lee viva.
    this.#map.addEventListener('cristae:click', this.#onClick)
    this.#map.addEventListener('cristae:viewportchange', this.#onViewport)
    // El motor solo emite `viewportchange` en moveend/zoomend (señal de baja frecuencia, por contrato).
    // Para que las tarjetas y su clip sigan el paneo/inercia EN CONTINUO enganchamos el `move` crudo del
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
    this.close()                        // baja cada tarjeta: nodo flotante + RO + suscripción
    this.#map?.removeEventListener('cristae:click', this.#onClick)
    this.#map?.removeEventListener('cristae:viewportchange', this.#onViewport)
    this.#map?.removeEventListener('cristae:ready', this.#onReady)
    this.#map = null
    this.#lmap?.off('move', this.#onViewport)
    this.#lmap = null
    removeEventListener('scroll', this.#onViewport, true)
    removeEventListener('resize', this.#onViewport)
    document.removeEventListener('keydown', this.#onKey)
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

  // Abre la tarjeta de un item. Sin `latlng` el ancla es VIVA (la posición del item en su Source —
  // requiere que viva en alguna capa `for`); con `latlng` explícito y finito queda CONGELADA ahí.
  // Único punto de validación del flujo de apertura: lo que sigue confía en sus entradas.
  open(item, latlng) {
    if (!this.#map) return
    const binding = this.#bindingFor(item)
    const anchor = latlng != null
      ? finitePos(latlng)
      : binding && finitePos(binding.source.accessors.positionOf(binding.source.itemById(binding.id)))
    if (!anchor) return
    const content = this.contentOf?.(item)
    if (content == null) return

    const key = binding?.id ?? item
    this.#discard(key)                  // re-apertura del mismo item = tarjeta fresca
    const max = Math.max(1, Number(this.maxOpen) || 1)
    const excess = this.#popups.size - max + 1        // > 0 ⇒ liberar cupo para la nueva
    if (excess > 0) [...this.#popups.keys()].slice(0, excess).forEach((k) => this.#discard(k))

    const popup = this.#create(key, item, binding, anchor, latlng == null)
    this.#popups.set(key, popup)
    this.#setContent(popup, content)    // medida con el contenido visible — cacheada para clip/fit
    this.#place(popup)                  // con `fit` ya encuadra card-space (flip/shift/clip)
    if (!this.fit) this.#autoPan(popup) // sin `fit`: comportamiento legacy (pan de cámara al abrir)
  }

  // Cierra una tarjeta por id de dato (string | number), o TODAS: cualquier otro valor cuenta como
  // "sin argumento" (un `close` colgado directo como handler recibe el Event y cierra todo).
  close(id) {
    if (typeof id === 'string' || typeof id === 'number') return this.#discard(id)
    this.#popups.forEach((p) => this.#dispose(p))
    this.#popups.clear()
  }

  // Re-ejecuta `contentOf` de las tarjetas abiertas con su item vigente (misma ancla, sin auto-pan).
  // Para refrescos transversales del consumidor (p. ej. un cambio de idioma).
  refresh() {
    this.#popups.forEach((p) => {
      const content = this.contentOf?.(p.item)
      if (content == null) return
      this.#setContent(p, content)
      this.#place(p)
    })
  }

  // Toggle reactivo de pinned/clip/fit en caliente: reubica al instante, sin esperar un viewportchange.
  // Apagar `fit` restaura el transform base-centro (el encuadre fit posiciona por caja literal).
  updated(changed) {
    if (changed.has('fit') && !this.fit) {
      this.#popups.forEach((p) => {
        p.node.style.transform = NODE_TRANSFORM
        delete p.node.dataset.side
      })
    }
    this.#popups.forEach((p) => this.#place(p))
  }

  /* ── Apertura / cierre ── */

  // Vínculo de VIDA de un item: la primera capa `for` cuya Source lo contiene → { source, id }.
  // Las capas `for` presentan los mismos datos — idealmente la MISMA instancia de Source (con
  // instancias gemelas el primer flush re-renderiza una vez por el cambio de ref) — así que el
  // orden de los tokens es solo prioridad de resolución. null = item ajeno a toda Source (o
  // Source sin subscribe/itemById) → tarjeta estática.
  #bindingFor(item) {
    const bindingOf = (layerId) => {
      const source = this.#map.getLayer(layerId)?.source
      if (!source?.subscribe || !source.itemById || !source.accessors?.idOf) return null
      const id = source.accessors.idOf(item)
      return id != null && source.itemById(id) != null ? { source, id } : null
    }
    // Primer vínculo que resuelva, en el orden de los tokens (`??` no evalúa el resto tras el match).
    return parseTokens(this.for).reduce((found, layerId) => found ?? bindingOf(layerId), null)
  }

  // Crea la tarjeta: nodo flotante propio + RO (el contenido puede cambiar de tamaño con la tarjeta
  // abierta — datos async, imágenes) + suscripción de vida a su Source (#onFlush), aislada con
  // `safe`: un `contentOf` que lance no corta el fan-out del Emitter. Sin binding no hay vida.
  #create(key, item, binding, anchor, live) {
    const node = document.createElement('div')
    node.className = 'cristae-popup'
    node.style.cssText = `position:fixed; z-index:10000; transform:${NODE_TRANSFORM}`
    document.body.appendChild(node)
    const popup = {
      key, item, binding, node, live,
      lat: anchor.lat, lng: anchor.lng,
      screenPt: null,                   // se fija en el primer #place (modo pinned="false")
      w: 0, h: 0,                       // tamaño cacheado (1 reflow por render; clip/fit no re-miden)
      ro: null, unsub: null,
    }
    popup.ro = new ResizeObserver(() => { this.#measure(popup); this.#place(popup) })
    popup.ro.observe(node)
    if (binding) {
      const flush = () => this.#onFlush(popup)
      popup.unsub = binding.source.subscribe(() => safe(flush, undefined, onFlushError))
    }
    return popup
  }

  #discard(key) {
    const popup = this.#popups.get(key)
    if (!popup) return
    this.#popups.delete(key)
    this.#dispose(popup)
  }

  #dispose(popup) {
    popup.unsub?.()
    popup.ro.disconnect()
    popup.node.remove()
  }

  /* ── Vida (flush de la Source, ya coalescido a rAF) ── */

  // Toda la vida de la tarjeta cuelga de esta única señal: (1) el id salió del dataset → cerrar;
  // (2) su objeto fue REEMPLAZADO (set/patch) → re-render con el fresco; (3) su posición cambió y
  // el ancla es viva → re-anclar, sin re-render. Cada paso computa su hecho; la colocación corre
  // una sola vez al final si algo cambió.
  #onFlush(popup) {
    const { source, id } = popup.binding
    const fresh = source.itemById(id)
    if (fresh == null) return this.#discard(popup.key)

    const replaced = fresh !== popup.item
    popup.item = fresh                  // antes de contentOf: si lanza, no se reintenta por flush
    const content = replaced ? this.contentOf?.(fresh) : null
    if (content != null) this.#setContent(popup, content)

    const follows = popup.live && !boolOff(this.follow) && !boolOff(this.pinned)
    const p = follows ? source.accessors.positionOf(fresh) : null
    // finitePos desplegado a primitivos: este es el camino caliente ([0-alloc] por flush).
    const lat = Number(p?.lat), lng = Number(p?.lng)
    const moved = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== popup.lat || lng !== popup.lng)
    if (moved) { popup.lat = lat; popup.lng = lng }

    if (content != null || moved) this.#place(popup)
  }

  // Vuelca el contenido al nodo y re-mide (1 reflow). La colocación la decide el caller.
  #setContent(popup, content) {
    if (typeof content === 'string') popup.node.innerHTML = content
    else popup.node.replaceChildren(content)
    this.#measure(popup)
  }

  // Mide la caja (clip y auto-pan trabajan luego con este tamaño cacheado, así el reposicionamiento
  // por frame no fuerza reflow del nodo). clip-path no afecta el rect → medida limpia.
  #measure(popup) {
    const r = popup.node.getBoundingClientRect()
    popup.w = r.width
    popup.h = r.height
  }

  // Click en el mapa: abre sólo si el TOP hit es de una capa `for` (no si quedó ocluida debajo de
  // otra capa interactiva — p. ej. una burbuja de cluster encima de un punto). Empty-safe: hits=[]
  // (click al vacío) → hit null → cierra. `hits` viene ordenado top-first (LayerRegistry.resolveHits);
  // el item se resuelve contra la Source de la capa del hit.
  #openFromHit(hits) {
    const hit = parseTokens(this.for).includes(hits[0]?.layerId) ? hits[0] : null
    if (!hit) { this.close(); return }
    // Una capa `for` que no resuelve ítems por id (p. ej. polígonos) no puede vincular contenido:
    // se avisa UNA vez y se cierra, en vez de no abrir nunca sin explicación.
    const res = resolvePopupHit(this.#map.getLayer(hit.layerId), hit.id)
    if (res.action === 'unresolvable') this.#warnUnresolvable(hit.layerId)
    if (res.action !== 'open') { this.close(); return }
    // Hit con posición propia (overlay que presenta una hoja en su lugar desplegado) → ancla ahí,
    // congelada; sin ella → ancla viva del item.
    this.open(res.item, hit.latlng)
  }

  // Aviso por capa (una sola vez): un `for` mal apuntado no debe inundar la consola por click.
  #warnUnresolvable(layerId) {
    if (this.#warned.has(layerId)) return
    this.#warned.add(layerId)
    console.warn(`[cristae-popup] la capa "${layerId}" del atributo \`for\` no resuelve ítems por id ` +
      `(sin Source.itemById — p. ej. una capa de polígonos): el popup no puede vincular su contenido. ` +
      '`for` requiere una capa de puntos, líneas o html.')
  }

  /* ── Colocación ── */

  #place(popup) {
    const cam = this.#map?.camera
    if (!cam) return
    const rect = this.#map.getBoundingClientRect()
    // Punto del contenedor: pinned → re-proyecta el ancla viva (sigue al mapa) y memoriza el spot;
    // unpinned → reusa el spot congelado (queda fijo en pantalla, ajeno a pan/zoom).
    let cx, cy
    if (boolOff(this.pinned) && popup.screenPt) {
      cx = popup.screenPt.x; cy = popup.screenPt.y
    } else {
      const pt = cam.latLngToContainerPoint([popup.lat, popup.lng])
      cx = pt.x; cy = pt.y
      popup.screenPt ??= { x: 0, y: 0 }  // registro reusado: sin alloc en la reposición continua
      popup.screenPt.x = cx; popup.screenPt.y = cy
    }
    // Con `fit` la caja se computa entera desde el ancla (#placeFit). Sin `fit`, camino legacy.
    if (this.fit) return this.#placeFit(popup, rect, cx, cy)
    const [dx, dy] = parsePair(this.offset) ?? [0, -12]
    const nodeLeft = rect.left + cx + dx
    const nodeTop = rect.top + cy + dy
    popup.node.style.left = `${nodeLeft}px`
    popup.node.style.top = `${nodeTop}px`
    this.#applyClip(popup, rect, cam.insets ?? ZERO_INSETS, nodeLeft, nodeTop)
  }

  // Recorta con clip-path la fracción de la caja que sobresale de la REGIÓN VISIBLE = rect del mapa
  // MENOS los viewport-insets (la franja que ocupan los widgets/paneles) → la tarjeta no se monta sobre
  // ellos. Geometría derivada del tamaño cacheado + transform base-centro (sin getBoundingClientRect en
  // el camino caliente). inset() mayor que el lado oculta ese lado entero → caja totalmente fuera =
  // invisible. clip-path es recorte de compositor (no relayout). Off → limpia la propiedad si estaba.
  #applyClip(popup, rect, ins, nodeLeft, nodeTop) {
    const node = popup.node
    if (boolOff(this.clip)) { if (node.style.clipPath) node.style.clipPath = ''; return }
    const vTop = rect.top + ins.top, vBottom = rect.bottom - ins.bottom
    const vLeft = rect.left + ins.left, vRight = rect.right - ins.right
    const left = nodeLeft - popup.w / 2, right = nodeLeft + popup.w / 2
    const top = nodeTop - popup.h, bottom = nodeTop
    const cTop = Math.max(0, vTop - top)
    const cRight = Math.max(0, right - vRight)
    const cBottom = Math.max(0, bottom - vBottom)
    const cLeft = Math.max(0, vLeft - left)
    node.style.clipPath = (cTop || cRight || cBottom || cLeft)
      ? `inset(${cTop}px ${cRight}px ${cBottom}px ${cLeft}px)`
      : ''
  }

  // Encuadre `fit`: proyecta el ancla, delega la geometría al módulo puro (popupPlacement.js) y
  // escribe el resultado tal cual — la caja calculada ES la pintada (left/top literales, transform
  // neutro). `fit`/`fit-padding`/`offset` se normalizan en el punto de uso: pueden llegar parseados
  // por su converter (vía atributo) o crudos (asignación directa de la propiedad); parseTokens/
  // parsePair aceptan ambas formas.
  #placeFit(popup, rect, cx, cy) {
    const ins = this.#map?.camera?.insets ?? ZERO_INSETS
    const [ox, oy] = parsePair(this.offset) ?? [0, -12]
    const [px, py] = parsePair(this.fitPadding ?? this.autoPanPadding) ?? [20, 20]
    const { left, top, side, clip } = computePlacement({
      anchor: { x: rect.left + cx, y: rect.top + cy },
      size: { w: popup.w, h: popup.h },
      viewport: {
        left: rect.left + ins.left,
        top: rect.top + ins.top,
        right: rect.right - ins.right,
        bottom: rect.bottom - ins.bottom,
      },
      stages: stagesFrom(parseTokens(this.fit)),
      offsetX: ox,
      gap: Math.abs(oy),
      paddingX: px,
      paddingY: py,
    })
    const node = popup.node
    node.style.transform = 'none'
    node.style.left = `${left}px`
    node.style.top = `${top}px`
    node.dataset.side = side
    node.style.clipPath = clip ? `inset(${clip.top}px ${clip.right}px ${clip.bottom}px ${clip.left}px)` : ''
  }

  // Si la caja ya posicionada se sale de la región visible (contenedor menos viewport-insets),
  // panea la cámara lo justo para meterla con `auto-pan-padding` de margen. Mismo cálculo que el
  // _adjustPan de Leaflet pero contra los insets del mapa. El panBy dispara `viewportchange` →
  // #place reubica las tarjetas sobre su ancla viva (sin re-disparar auto-pan: solo abre acá).
  // Solo en modo pinned: si la tarjeta no sigue al mapa, panear la cámara no la metería en cuadro.
  #autoPan(popup) {
    if (boolOff(this.autoPan) || boolOff(this.pinned)) return
    const cam = this.#map?.camera
    if (!cam) return

    const rect = this.#map.getBoundingClientRect()
    // Caja en coords del contenedor, desde el tamaño cacheado + transform base-centro.
    const pt = cam.latLngToContainerPoint([popup.lat, popup.lng])
    const [ox, oy] = parsePair(this.offset) ?? [0, -12]
    const nx = pt.x + ox, ny = pt.y + oy
    const left = nx - popup.w / 2, right = nx + popup.w / 2, top = ny - popup.h, bottom = ny

    const ins = cam.insets ?? ZERO_INSETS
    const [px, py] = parsePair(this.autoPanPadding) ?? [20, 20]
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
