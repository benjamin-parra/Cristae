import Supercluster from 'supercluster'

// Cluster — agrupamiento espacial headless (SPECS §8.3, MODELO §13). Sin dominio:
// opera sobre {id, lat, lng} extraídos por accessors; no conoce vehículos ni capas.
//
// Estrategia worldwide: getClusters siempre con bounds [-180,-90,180,90] → el resultado
// depende SOLO del zoom, nunca del viewport. Cada punto es "solo" (visible en su capa, en su
// posición real) o "clustered" (suprimido y reemplazado por una burbuja). El pan no recalcula:
// el buffer global ya contiene todos los solos y todas las burbujas.
//
// Dos productos, ambos refs estables-por-recluster:
//   clusteredIds — Set ESTABLE mutado in-place: un sibling lo asigna una vez y queda sincronizado.
//   bubbles      — array nuevo por recluster (alimenta un Source → rebuild de la capa de burbujas).
//
// Build O(n log n) (supercluster), query O(1) por zoom. reindex en cambio de datos; recluster
// en cambio de zoom. La firma evita re-propagar un set idéntico.

const WORLD = [-180, -90, 180, 90]

export class Cluster {

  #sc
  #radius
  #maxZoom
  #minPoints
  #splitThreshold = 16           // N≤esto → spiderfy hojas directas; si no → sub-clusters (~√N de ~√N)
  #enabled        = true         // off → no suprime nada y no emite burbujas (toggle limpio)
  #features       = []
  #allIds         = new Set()
  #clusteredIds   = new Set()    // estable: nunca se reasigna, solo clear()+add()
  #bubbles        = []
  #signature      = null
  // Expansión llaveada por HOJA-ancla (id de dato del usuario), NO por id de cluster de Supercluster.
  // El cluster_id es efímero: cambia en cada load()/zoom y getLeaves(idViejo) puede lanzar O —peor—
  // devolver hojas EQUIVOCADAS sin lanzar (el id decodifica a otro cluster válido). Por eso el estado
  // se ancla a properties.id de hojas estables; un cluster se "explota" si sus hojas ACTUALES contienen
  // el ancla. Sobrevive a reindex en vivo y a que entren móviles al bucket.
  //
  // Jerarquía ALTURA MÁX 2 codificada en la FORMA del estado (no por guardas): exactamente UN cluster
  // base abierto + a lo sumo UN sub-cluster interno abierto. Abrir otro base cierra el anterior (y su
  // interno); abrir otro interno cierra el anterior.
  //
  // #sesion agrupa TODO el snapshot de la sesión de expansión, o null si no hay ninguna. Limpiar la
  // sesión es SIEMPRE `this.#sesion = null` — un único punto de verdad, imposible olvidar un campo (antes
  // eran cinco asignaciones a null copiadas en collapse*/enabled/index/reset; olvidar una = sesión zombi).
  // Campos:
  //   · baseAnchor  — hoja-ancla (nearest-centroid) del ÚNICO cluster base abierto.
  //   · innerAnchor — min leaf-id del ÚNICO sub-cluster interno abierto (depth-2), o null.
  //   · expandedSig — firma de (baseAnchor|innerAnchor) para detectar cambios de estado en recluster (hot).
  //   · baseLeaves  — SNAPSHOT congelado en el click: [{ properties:{id}, geometry:{coordinates:[lng,lat]} }].
  //   · baseLeafIds — Set(id) del snapshot (supresión/membresía O(1)).
  // El SNAPSHOT (baseLeaves/baseLeafIds) congela membresía/conteo/partición del base: NO se re-derivan del
  // árbol vivo en cada recluster. Con el set fijo, #partition es determinista entre reclusters; sólo encoge
  // por bajas reales (que lo re-particionan y cierran el sub-cluster interno). Un móvil nuevo NO se suma a
  // una espiral abierta (semántica spiderfy).
  #sesion = null
  // Producto del recluster (0-o-1 grupo del base abierto), NO parte del snapshot: se reescribe en cada
  // recluster (junto a #bubbles/#markedHidden), por eso vive FUERA de #sesion.
  #expandedGroups = []
  // Marcado: ids de dato que el consumidor quiere señalizados. Las burbujas que contengan alguno
  // se taggean `marked` (variante propia del icon-set) y su colocación queda en #markedHidden.
  #markedIds    = new Set()
  #markedHidden = []             // [{ id, center:{lat,lng} }] de los marcados ocultos en una burbuja, por recluster

  constructor({ radius = 80, maxZoom = 18, minPoints = 2, enabled = true, splitThreshold = 16 } = {}) {
    this.#radius         = radius
    this.#maxZoom        = maxZoom
    this.#minPoints      = minPoints
    this.#splitThreshold = splitThreshold
    this.#enabled        = enabled
    this.#sc             = this.#build()
  }

  get clusteredIds() { return this.#clusteredIds }
  get bubbles() { return this.#bubbles }
  // Clusters expandidos del último recluster (0-o-1 grupo del base abierto):
  // [{ clusterId, center:{lat,lng}, slots }] donde slots = heterogéneos
  // ({kind:'leaf',id} | {kind:'subcluster',id,count,ids}). El motor los proyecta a píxeles para
  // renderizar la espiral + las líneas (headless: no calcula pantalla).
  get expandedGroups() { return this.#expandedGroups }

  // Ids marcados (los define el consumidor). Cambiarlos invalida la firma → el próximo recluster
  // re-taggea las burbujas y regenera #markedHidden.
  set marked(ids) {
    this.#markedIds = ids instanceof Set ? ids : new Set(ids ?? [])
    this.#signature = null
  }
  get hasMarked() { return this.#markedIds.size > 0 }
  // Colocación de los marcados OCULTOS en una burbuja colapsada: [{ id, center }] en orden por id.
  // Snapshot del último recluster (lectura O(1), como `bubbles` — nunca consulta el índice).
  get markedHidden() { return this.#markedHidden }

  // Estructura LÓGICA de la sesión de expansión abierta, o null si no hay ninguna. Es lo que consume el
  // motor para armar el payload de los eventos `cluster:expand/update/dismiss` — INDEPENDIENTE de qué
  // sub-cluster está drilleado (a diferencia de `expandedGroups`, que splicea el abierto para el render):
  //   { id, count, ids, groups }
  //   · id     = hoja-ancla base (ESTABLE: sobrevive reindex/zoom → key para casar expand↔update↔dismiss)
  //   · ids    = todas las hojas del snapshot congelado (orden espacial), plano
  //   · groups = subburbujas [{ id, count, ids, expanded }] cuando el base se particiona (count > splitThreshold);
  //              [] cuando es plano (hojas directas). `expanded` marca la subburbuja abierta (#innerAnchor).
  // Sale del SNAPSHOT baseLeaves → invariante a reindex (mismo criterio que la espiral).
  get sessionStructure() {
    const s = this.#sesion
    if (!s) return null
    const ids = s.baseLeaves.map(l => l.properties.id)
    const count = ids.length
    if (count <= this.#splitThreshold) return { id: s.baseAnchor, count, ids, groups: [] }
    const groups = this.#partitionGroups(s.baseLeaves)
      .map(g => ({ id: g.id, count: g.ids.length, ids: g.ids, expanded: g.id === s.innerAnchor }))
    return { id: s.baseAnchor, count, ids, groups }
  }

  /* ── Expand / collapse de clusters individuales (modelo ANCLA por hoja) ──
   * El caller (MapEngine) garantiza que `clusterId` es del frame ACTUAL verificándolo contra la
   * fuente de burbujas viva antes de llamar; el try/catch es la red secundaria ante la carrera
   * reindex-en-vuelo (el id se volvió stale entre el paint de la burbuja y el click). */

  // Hojas de un clusterId, o null si el id está STALE. Un id RETENIDO (carrera reindex-en-vuelo entre
  // el paint de la burbuja y el click) hace lanzar a Supercluster —o peor, devolver hojas de OTRO
  // cluster—; la staleness se materializa a `null` (ausente) en UN solo punto de captura, y los
  // call-sites ramifican sobre ese null en vez de repetir try/catch. recluster usa ids FRESCOS de
  // getClusters directo (this.#sc.getLeaves), no pasa por acá.
  #leavesOf(clusterId) {
    try { return this.#sc.getLeaves(clusterId, Infinity) }
    catch { return null }
  }

  // Ancla = hoja más cercana al centroide del cluster (la menos propensa a ser el móvil que se aleja).
  #pickAnchor(leaves) {
    let sx = 0, sy = 0
    for (const lf of leaves) { const c = lf.geometry.coordinates; sx += c[0]; sy += c[1] }
    const cx = sx / leaves.length, cy = sy / leaves.length
    let best = leaves[0], bestD = Infinity
    for (const lf of leaves) {
      const c = lf.geometry.coordinates
      const d = (c[0] - cx) ** 2 + (c[1] - cy) ** 2
      if (d < bestD) { bestD = d; best = lf }
    }
    return best.properties.id
  }

  // ¿estas hojas contienen el ancla del base abierto? (el base es "este cluster" del frame). Hojas
  // ausentes (null: id stale desde #leavesOf) → false, para que los call-sites pasen el resultado directo.
  #hasBaseAnchor(leaves) {
    const a = this.#sesion?.baseAnchor
    if (a == null || !leaves) return false
    for (const lf of leaves) if (lf.properties.id === a) return true
    return false
  }

  // Partición pura STR (Sort-Tile-Recursive): parte las hojas en ~√N grupos balanceados y espacialmente
  // coherentes, cada uno keyed por su min leaf-id (ancla estable). Determinista — el tiebreak por id es
  // OBLIGATORIO en AMBOS sorts (la estabilidad de Array.sort no está garantizada a estos tamaños; sin él
  // la partición y los conteos parpadean entre reindex en vivo). O(N log N), corre SÓLO al recluster del
  // base abierto. Es la partición LÓGICA (independiente de qué sub-cluster está drilleado): la consumen
  // `#partition` (slots de render, que splicean el abierto) y `sessionStructure` (payload del evento).
  #partitionGroups(leaves) {
    const N = leaves.length
    const G = Math.ceil(Math.sqrt(N))          // nº de sub-clusters
    const S = Math.ceil(N / G)                 // ~hojas por sub-cluster
    const P = Math.ceil(Math.sqrt(G))          // franjas verticales
    const sliceCap = P * S
    const cmpId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    const arr = leaves.map(lf => ({ id: lf.properties.id, x: lf.geometry.coordinates[0], y: lf.geometry.coordinates[1] }))
    arr.sort((a, b) => (a.x - b.x) || cmpId(a, b))     // por lng, tiebreak id
    const groups = []
    for (let i = 0; i < arr.length; i += sliceCap) {
      const slice = arr.slice(i, i + sliceCap)
      slice.sort((a, b) => (a.y - b.y) || cmpId(a, b))  // por lat dentro de la franja, tiebreak id
      for (let j = 0; j < slice.length; j += S) {
        const grp = slice.slice(j, j + S)
        let min = grp[0].id
        for (const g of grp) if (g.id < min) min = g.id
        groups.push({ id: min, ids: grp.map(g => g.id) })
      }
    }
    return groups
  }

  // Slots de RENDER de la espiral a partir de la partición lógica: el sub-cluster ABIERTO (#innerAnchor)
  // florece en sus hojas spliced EN SU LUGAR → el caracol crece y empuja a los hermanos (`group` las une
  // visualmente); el resto quedan como burbujas {kind:'subcluster'}. Preserva el orden de #partitionGroups.
  #partition(leaves) {
    const inner = this.#sesion?.innerAnchor
    const slots = []
    for (const g of this.#partitionGroups(leaves)) {
      if (g.id === inner) {
        for (const id of g.ids) slots.push({ kind: 'leaf', id, group: g.id })
      } else {
        slots.push({ kind: 'subcluster', id: g.id, count: g.ids.length, ids: g.ids })
      }
    }
    return slots
  }

  // Recalcula la firma (baseAnchor|innerAnchor) del snapshot vigente. Sólo se llama con una sesión abierta
  // (tras crearla o togglear sus anclas); limpiar la sesión es `this.#sesion = null`, no pasa por acá.
  #refreshExpandedSig() {
    const s = this.#sesion
    if (s) s.expandedSig = (s.baseAnchor ?? '') + '|' + (s.innerAnchor ?? '')
  }

  // Expande el cluster `clusterId` como BASE (single-open: cierra el base anterior y su interno).
  // Devuelve { anchorId, ids } o null (id stale / sin hojas). `ids` = los id de DATO del usuario.
  expandCluster(clusterId) {
    const leaves = this.#leavesOf(clusterId)
    if (!leaves?.length) return null
    const anchorId = this.#pickAnchor(leaves)
    const ids = leaves.map(lf => lf.properties.id)
    // Captura la SESIÓN: congela el set de hojas (id + posición) del click. Desde acá la membresía/conteo
    // del base no se re-derivan del árbol vivo. innerAnchor arranca null (abrir otro base cierra el interno).
    this.#sesion = {
      baseAnchor: anchorId,
      innerAnchor: null,
      expandedSig: '',
      baseLeaves: leaves.map(lf => ({ properties: { id: lf.properties.id }, geometry: { coordinates: lf.geometry.coordinates } })),
      baseLeafIds: new Set(ids),
    }
    this.#refreshExpandedSig()
    this.#signature = null
    return { anchorId, ids }
  }

  // Colapsa el cluster base si en este frame contiene el ancla. Devuelve los ids re-clusterizados
  // (para limpiar un panel simétrico al expand), o null si no cambió.
  collapseCluster(clusterId) {
    const s = this.#sesion
    // Caso ancla-sola: la burbuja dim tiene id sintético 'b:'+ancla → getLeaves lanzaría; atajo directo.
    if (!(s && clusterId === 'b:' + s.baseAnchor)) {
      if (!this.#hasBaseAnchor(this.#leavesOf(clusterId))) return null   // stale → hojas null → hasBaseAnchor false
    }
    const ids = s ? [...s.baseLeafIds] : []
    this.#sesion = null
    this.#signature = null
    return ids
  }

  collapseAll() {
    if (!this.#sesion) return false
    this.#sesion = null
    this.#signature = null
    return true
  }

  // Abre/cierra (toggle) el sub-cluster interno cuyo ancla (min leaf-id) es `subId`, dentro del base
  // abierto. Single-open interno: abrir otro cierra el anterior. Devuelve true si quedó abierto.
  expandInner(subId) {
    const s = this.#sesion
    if (!s) return false
    s.innerAnchor = (s.innerAnchor === subId) ? null : subId
    this.#refreshExpandedSig(); this.#signature = null
    return s.innerAnchor != null
  }

  // ¿El cluster del frame actual es el base abierto? (sus hojas contienen el ancla base).
  isClusterExpanded(clusterId) {
    const s = this.#sesion
    if (s && clusterId === 'b:' + s.baseAnchor) return true   // dim sintética (ancla-sola)
    return this.#hasBaseAnchor(this.#leavesOf(clusterId))     // stale → hojas null → false
  }

  // Contenido (ids de dato) de una burbuja BASE del FRAME actual — consulta pura, hermana de
  // expandCluster pero sin efectos. `clusterId` es efímero: pasar uno recién obtenido (un hit
  // del frame). La burbuja dim de la sesión abierta ('b:'+ancla) responde con el snapshot congelado.
  // null si el id es stale/desconocido. (El contenido de una SUB-burbuja de la espiral NO se consulta
  // acá — su id es una hoja-ancla, no un cluster de Supercluster — sino en sessionStructure.groups.)
  contents(clusterId) {
    const s = this.#sesion
    if (s && clusterId === 'b:' + s.baseAnchor)
      return s.baseLeaves.map(l => l.properties.id)
    const leaves = this.#leavesOf(clusterId)
    if (!leaves) return null                       // id stale/desconocido
    // Burbuja dim de la sesión abierta con id VIVO de Supercluster (caso común, no el sintético
    // 'b:'): responde con el snapshot CONGELADO — lo que la burbuja y la espiral renderizan
    // (conteo + hojas del click) — no con el bucket vivo, que puede haber ganado/perdido
    // miembros durante la sesión. Misma atomicidad con-lo-visto que las sub-burbujas.
    if (this.#hasBaseAnchor(leaves)) return s.baseLeaves.map(l => l.properties.id)
    return leaves.map(lf => lf.properties.id)
  }

  /* ── Config reactiva: recrea el índice y recarga las features ya extraídas ── */

  set radius(v) { if (v !== this.#radius) { this.#radius = v; this.#rebuildIndex() } }
  set maxZoom(v) { if (v !== this.#maxZoom) { this.#maxZoom = v; this.#rebuildIndex() } }
  set minPoints(v) { if (v !== this.#minPoints) { this.#minPoints = v; this.#rebuildIndex() } }
  // Toggle de clustering: al apagarlo se fuerza el recálculo (signature null) → el próximo recluster
  // vacía clusteredIds/bubbles; al encenderlo vuelve a agrupar. Apagar también CIERRA la sesión de
  // expansión (si no, sobreviviría al apagón y "resucitaría" stale al re-encender). Limpio, sin desmontar.
  set enabled(v) {
    if (v === this.#enabled) return
    this.#enabled = v
    if (!v) this.#sesion = null
    this.#signature = null
  }

  /* ── Datos: extrae features e indexa. O(n) extracción + O(n log n) build ── */

  index(items, idOf, positionOf) {
    const features = []
    const ids = new Set()
    items.forEach(item => {
      const pos = positionOf(item)
      if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return
      const id = idOf(item)
      if (ids.has(id)) return                    // id duplicado → gana el primero (mismo criterio que Store/PointLayer)
      ids.add(id)
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pos.lng, pos.lat] },
        properties: { id },
      })
    })
    this.#features = features
    this.#allIds = ids
    this.#sc.load(features)
    // Poda de anclas + reconciliación del SNAPSHOT de sesión ante rotación de flota. Si el ancla base ya
    // no existe → colapsa todo. Si sigue, el snapshot sólo ENCOGE por bajas reales (hojas que salieron del
    // dataset); nunca crece (semántica spiderfy: un nuevo móvil no se suma a una espiral abierta). Cualquier
    // baja cierra el sub-cluster interno (re-particiona); si quedó ≤1 hoja → colapsa el base.
    const s = this.#sesion
    if (s && !ids.has(s.baseAnchor)) {
      this.#sesion = null
    } else if (s) {
      if (s.baseLeaves.some(l => !ids.has(l.properties.id))) {
        s.baseLeaves = s.baseLeaves.filter(l => ids.has(l.properties.id))
        s.baseLeafIds = new Set(s.baseLeaves.map(l => l.properties.id))
        s.innerAnchor = null   // una baja real re-particiona el snapshot → cierra el sub-cluster interno
        this.#refreshExpandedSig()
      }
      if (s.baseLeaves.length <= 1) {   // sólo quedó el ancla (o nada) → la espiral no tiene sentido
        this.#sesion = null
      }
    }
    this.#signature = null          // datos nuevos → fuerza recálculo en el próximo recluster
  }

  /* ── Viewport: reagrupa al zoom dado. O(1) query + O(results) firma ── */

  recluster(zoom) {
    // Apagado: ningún punto suprimido, ninguna burbuja. Idempotente vía firma 'off'.
    if (!this.#enabled) {
      if (this.#signature === 'off') return false
      this.#signature = 'off'
      this.#clusteredIds.clear()
      this.#bubbles = []
      this.#expandedGroups = []
      this.#markedHidden = []
      return true
    }

    const results = this.#sc.getClusters(WORLD, Math.round(zoom))

    // Caso común (nada abierto) → firma idéntica al original, cero overhead en bursts de zoom. Con un
    // base abierto se prefija 'a[baseAnchor|innerAnchor]' para detectar cambios de estado al mismo zoom
    // (incluido togglear el sub-cluster interno: getClusters devuelve lo mismo, sólo cambia el bloom).
    const s = this.#sesion                         // snapshot de sesión cacheado (leído en toda esta ruta caliente)
    const hasExpansion = s != null
    let signature = hasExpansion ? zoom + ':a[' + s.expandedSig + ']:' : zoom + ':'
    results.forEach(f => {
      const p = f.properties
      signature += p.cluster ? `c${f.id}:${p.point_count},` : `s${p.id},`
    })
    if (signature === this.#signature) return false
    this.#signature = signature

    const soloIds = new Set()
    const bubbles = []
    const groups = []
    // Sólo hay UN base abierto → en cuanto se ubica, los demás clusters son burbujas normales (corta
    // el getLeaves del resto).
    let baseFound = false
    // Emite la SESIÓN de expansión (burbuja dim + grupo de slots) centrada en `center`, desde el snapshot
    // CONGELADO s.baseLeaves. count y partición salen del snapshot, NO del árbol vivo → invariantes a
    // reindex. Pocas hojas → directas; muchas → sub-clusters (~√N de ~√N) legibles.
    const emitBase = (bubbleId, center, liveLeaves) => {
      baseFound = true
      const snap = s.baseLeaves
      bubbles.push({ id: bubbleId, lat: center.lat, lng: center.lng, count: snap.length, expanded: true })
      const slots = snap.length <= this.#splitThreshold
        ? snap.map(l => ({ kind: 'leaf', id: l.properties.id }))
        : this.#partition(snap)
      groups.push({ clusterId: bubbleId, center, slots })
      // Miembros VIVOS del bucket base que NO están en el snapshot (un móvil que entró/se desplazó al
      // cluster del base DURANTE la sesión): no se suman a la espiral congelada, pero deben seguir
      // VISIBLES en su posición real → solos (no suprimidos). Sin esto desaparecerían del mapa.
      if (liveLeaves) for (const lf of liveLeaves) if (!s.baseLeafIds.has(lf.properties.id)) soloIds.add(lf.properties.id)
    }
    results.forEach(f => {
      const p = f.properties
      const [lng, lat] = f.geometry.coordinates
      if (p.cluster) {
        // getLeaves SOLO para UBICAR el base (su centro vivo) y detectar arribos; la membresía de la
        // espiral sale del snapshot. f.id es FRESCO de este getClusters → nunca stale.
        const leaves = (hasExpansion && !baseFound) ? this.#sc.getLeaves(f.id, Infinity) : null
        if (leaves && this.#hasBaseAnchor(leaves)) emitBase(f.id, { lat, lng }, leaves)   // base abierto → spiderfy
        else bubbles.push({ id: f.id, lat, lng, count: p.point_count })
      } else {
        soloIds.add(p.id)
        // El ancla puede quedar SOLA a este zoom → centrar la espiral en su posición y emitir la sesión.
        if (hasExpansion && !baseFound && p.id === s.baseAnchor) emitBase('b:' + s.baseAnchor, { lat, lng }, null)
      }
    })

    // Las hojas del snapshot SIEMPRE quedan suprimidas en el host (se dibujan en la espiral), aunque el
    // árbol vivo marque alguna como `solo` tras moverse → evita verla duplicada (posición real + espiral).
    if (s) s.baseLeafIds.forEach(id => soloIds.delete(id))
    // allIds − soloIds = los realmente dentro de un cluster (incluidas las hojas expandidas, que
    // siguen suprimidas en el host). Worldwide garantiza que cada id indexado aparece en results.
    this.#clusteredIds.clear()
    this.#allIds.forEach(id => { if (!soloIds.has(id)) this.#clusteredIds.add(id) })

    this.#bubbles = bubbles
    this.#expandedGroups = groups
    this.#refreshMarked()
    return true
  }

  /* ── Marcado: señaliza las burbujas que contienen ids marcados ── */

  // Marcados OCULTOS en una burbuja colapsada: dentro de clusteredIds pero fuera del snapshot de
  // espiral (baseLeafIds, que se dibuja desplegado). Sólo estos necesitan señalización — un
  // marcado solo ya es visible. O(|marcados|), sin tocar el índice.
  #markedOcultos() {
    const leafIds = this.#sesion?.baseLeafIds
    const ocultos = new Set()
    this.#markedIds.forEach(id => {
      if (this.#clusteredIds.has(id) && !leafIds?.has(id)) ocultos.add(id)
    })
    return ocultos
  }

  // Ids de `target` contenidos en UNA burbuja colapsada. getLeaves con id FRESCO del recluster
  // vigente (mismo criterio que emitBase); la burbuja expandida se salta (sus hojas están a la vista).
  #markedEn(bubble, target) {
    if (bubble.expanded) return []
    const leaves = this.#leavesOf(bubble.id)
    if (!leaves) return []                         // id stale → sin marcados en esta burbuja
    return leaves.map(lf => lf.properties.id).filter(id => target.has(id))
  }

  // Corre al final de cada recluster: taggea `marked` las burbujas con marcados ocultos y cachea
  // su colocación [{ id, center }]. getLeaves sólo si quedó alguno oculto, con early-stop al
  // ubicarlos todos. Orden canónico por id → la firma del emisor no depende del índice.
  #refreshMarked() {
    this.#markedHidden = []
    if (!this.#markedIds.size) return
    const target = this.#markedOcultos()
    for (const b of this.#bubbles) {
      if (!target.size) break
      for (const id of this.#markedEn(b, target)) {
        target.delete(id)
        b.marked = true
        this.#markedHidden.push({ id, center: { lat: b.lat, lng: b.lng } })
      }
    }
    this.#markedHidden.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  /* ── Consulta pura: zoom mínimo al que un punto deja de estar clusterizado ──
   * Cómputo headless, hermano de recluster: NO muta el estado vivo (#signature/#clusteredIds/#bubbles).
   * Devuelve el menor zoom entero ∈ [0, maxZoom+1] al que `id` es SOLO (no absorbido en una burbuja), o
   * null si el id no está indexado o el clustering está apagado (el consumidor no necesita subir el zoom).
   * "Solo a z" se determina con la MISMA query worldwide que recluster → el resultado coincide EXACTO con
   * clusteredIds a ese zoom (un bbox mínimo NO sirve: el range query de supercluster no devuelve fiable el
   * punto contenido). Monótono en zoom (más zoom = más separación) → búsqueda binaria; soloAt(maxZoom+1) es
   * siempre true (Supercluster no agrupa sobre maxZoom), así que el borde superior existe y la búsqueda
   * termina. O(results) por paso × O(log maxZoom) pasos; corre sólo al enfocar (no es hot-path). */
  declusterZoomFor(id) {
    if (!this.#enabled || !this.#allIds.has(id)) return null
    const soloAt = z => {
      for (const f of this.#sc.getClusters(WORLD, z))
        if (!f.properties.cluster && f.properties.id === id) return true
      return false
    }
    let lo = 0, hi = this.#maxZoom + 1
    while (lo < hi) { const m = (lo + hi) >> 1; if (soloAt(m)) hi = m; else lo = m + 1 }
    return lo
  }

  reset() {
    this.#features = []
    this.#allIds = new Set()
    this.#clusteredIds.clear()
    this.#bubbles = []
    this.#expandedGroups = []
    this.#markedHidden = []
    this.#sesion = null
    this.#signature = null
    this.#sc = this.#build()
  }

  /* ── Internos ── */

  #build() {
    return new Supercluster({ radius: this.#radius, maxZoom: this.#maxZoom, minPoints: this.#minPoints })
  }

  // Reconfig (§11): recrea el índice con la nueva config y recarga las features ya extraídas.
  #rebuildIndex() {
    this.#sc = this.#build()
    this.#sc.load(this.#features)
    this.#signature = null
  }
}
