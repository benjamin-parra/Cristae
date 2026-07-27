import { prepareIndex, idsFor } from '../geometry/polygon.js'
import { focusedStyle } from './focus.js'

// Capa de POLÍGONOS reactiva a un Source. Hermana de LeafletLineLayer (Leaflet-nativo, sin contexto
// WebGL): dibuja con `L.polygon` y le delega a Leaflet la reproyección en pan/zoom. A diferencia del
// `addPolygonLayer` imperativo previo (clearLayers + re-add por cada cambio, O(n)), se SUSCRIBE al
// Source en el constructor y, cuando el snapshot no cambia de tamaño y trae `dirtyIds`, re-evalúa SÓLO
// esos polígonos (setStyle/setLatLngs sobre el `L.polygon` guardado por id) — el resto no se toca.
// Sólo cae a rebuild total cuando cambia la membresía (tamaño distinto) o el Source no expone el
// patch incremental (`dirtyIds`/`itemById`), o un id sucio no tiene aún su polígono montado.
//
// Accessors: `idOf` (índice por id), `ringsOf` (geometría: anillo simple o multi-anillo, mismo
// contrato que `L.polygon`) y `styleOf` opcional (opciones de path de Leaflet). El índice de hit
// (geometry/polygon.prepareIndex) se mantiene sincronizado en ambos caminos; el picking es
// point-in-poly CPU (idsFor), sin contexto GL. kind 'polygon', distancePx 0 (dentro o fuera).
//
// CAVEAT de perf — el fast-path NO es O(1): re-estilar los ids sucios es O(k) DOM (setStyle/setLatLngs
// sobre los `k` polígonos tocados), pero cada flush RECONSTRUYE el índice de hit desde el snapshot
// entero (#reindex → prepareIndex sobre las `n` entidades, con alloc de un array nuevo). El costo real
// por flush es O(k) DOM + O(n) índice. Es deliberado y aceptable para el caso de uso al que apunta la
// capa: GEOCERCAS — pocas entidades, baja frecuencia de cambio. NO usarla para muchos polígonos que se
// muevan por frame (ahí el reindex O(n)+alloc por tick domina); ese perfil es el de las capas GL.

export class PolygonLayer {

  #L; #pane; #source; #interactive
  #accessors
  #group = null
  #byId  = new Map()               // id → instancia L.polygon (para el patch O(k) por id)
  #index = { sorted: [] }          // índice espacial point-in-poly (picking)
  #unsub = null
  #focus = { ids: null, dim: 0.3 } // eje focus: ids enfocados (null = sin foco) + opacidad del resto

  // `map` sólo hace falta para anclar el layerGroup; el picking es en espacio latlng (sin escala de
  // zoom, a diferencia de las líneas), así que no se retiene.
  constructor({ L, map, pane, source, interactive = false }) {
    this.#L           = L
    this.#pane        = pane
    this.#source      = source
    this.#accessors   = source.accessors
    this.#interactive = interactive
    this.#group       = L.layerGroup([], { pane }).addTo(map)
    this.#unsub       = source.subscribe(() => this.#onChange())
    this.#onChange()
  }

  get count() { return this.#byId.size }

  /* ── Lifecycle: NO es capa GL (Leaflet reproyecta solo) → el motor no la inscribe en #glLayers, así
     que no declara redraw/resetCanvasReference (el ciclo GL no la invoca), igual que LeafletLineLayer.
     `refresh()` queda con guard sólo como reconstrucción imperativa para uso EXTERNO (no la llama el
     motor): fuerza un rebuild total desde el snapshot vigente. ── */
  refresh() { if (this.#group) this.#rebuild(this.#source.getSnapshot()) }

  destroy() {
    this.#unsub?.()
    this.#group?.remove()
    this.#group = null
    this.#byId.clear()
  }

  // Eje focus: atenúa por FEATURE (no por pane) — cada polígono lleva su propia opacidad.
  applyFocus(ids, dim = this.#focus.dim) {
    this.#focus = { ids, dim }
    const a = this.#accessors
    this.#source.getSnapshot().forEach(item => {
      const id = a.idOf(item)
      this.#byId.get(id)?.setStyle(focusedStyle(a.styleOf?.(item), this.#focus, id))
    })
    return true
  }

  /* ── Picking CPU point-in-poly (idsFor): kind 'polygon', sin distancia (dentro/fuera) ── */
  resolveClick(baseEvent) { return this.#hitsAt(baseEvent) }
  resolveHover(baseEvent) { return this.#hitsAt(baseEvent) }

  #hitsAt(baseEvent) {
    return this.#interactive && baseEvent?.latlng && this.#index.sorted.length
      ? idsFor(baseEvent.latlng.lat, baseEvent.latlng.lng, this.#index)
        .map(id => ({ ref: id, id, distancePx: 0 }))
      : []
  }

  /* ── Reacción al Source (ya coalescida a rAF por el Emitter) ── */
  // El estilo y la geometría son ESTADO (accessors styleOf/ringsOf); mutarlos + set/patch la Source
  // cae acá. FAST-PATH: mismo tamaño de set + dirtyIds ⇒ re-estilar sólo esos; si no, rebuild total.
  #onChange() {
    const snap = this.#source.getSnapshot()
    const dirty = this.#source.dirtyIds?.()
    const itemById = this.#source.itemById
    if (dirty?.size && itemById && snap.length === this.#byId.size && this.#patch(snap, dirty, itemById))
      return
    this.#rebuild(snap)
  }

  // Re-evalúa SÓLO los ids sucios sobre su `L.polygon` vivo (setStyle/setLatLngs). Devuelve false —y
  // deja al caller rebuildear— si algún id sucio no resuelve a un polígono montado o desapareció del
  // Source (membresía cambiada sin cambio de tamaño): la red de seguridad no re-estila a medias.
  #patch(snap, dirty, itemById) {
    if ([...dirty].some(id => !this.#byId.has(id) || itemById(id) == null)) return false
    const a = this.#accessors
    dirty.forEach(id => {
      const item = itemById(id)
      const poly = this.#byId.get(id)
      poly.setStyle(focusedStyle(a.styleOf?.(item), this.#focus, id))
      poly.setLatLngs(a.ringsOf(item))
    })
    this.#reindex(snap)
    return true
  }

  // Rebuild total: reemplaza todos los polígonos (clearLayers + re-add) y reconstruye el índice de id.
  #rebuild(snap) {
    const a = this.#accessors
    this.#group.clearLayers()
    this.#byId.clear()
    snap.forEach(item => {
      const id   = a.idOf(item)
      const poly = this.#L.polygon(a.ringsOf(item), { pane: this.#pane, ...focusedStyle(a.styleOf?.(item), this.#focus, id) })
      poly.addTo(this.#group)
      this.#byId.set(id, poly)
    })
    this.#reindex(snap)
  }

  // Índice de hit sincronizado con el snapshot vigente (O(n) CPU, sin DOM). En el fast-path los
  // anillos no-sucios no cambiaron, pero recomputar desde el snapshot es correcto y barato.
  #reindex(snap) {
    const a = this.#accessors
    this.#index = prepareIndex(snap.map(item => ({ id: a.idOf(item), rings: a.ringsOf(item) })))
  }
}
