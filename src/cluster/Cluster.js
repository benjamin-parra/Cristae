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
  #enabled = true                // off → no suprime nada y no emite burbujas (toggle limpio)
  #features = []
  #allIds = new Set()
  #clusteredIds = new Set()      // estable: nunca se reasigna, solo clear()+add()
  #bubbles = []
  #signature = null
  // Expansión llaveada por HOJA-ancla (id de dato del usuario), NO por id de cluster de Supercluster.
  // El cluster_id es efímero: cambia en cada load()/zoom y getLeaves(idViejo) puede lanzar O —peor—
  // devolver hojas EQUIVOCADAS sin lanzar (el id decodifica a otro cluster válido). Por eso el estado
  // se ancla a properties.id de hojas estables; un cluster se "explota" si sus hojas ACTUALES contienen
  // el ancla. Sobrevive a reindex en vivo y a que entren móviles al bucket.
  //
  // Jerarquía ALTURA MÁX 2 codificada en la FORMA del estado (no por guardas): exactamente UN cluster
  // base abierto + a lo sumo UN sub-cluster interno abierto. Abrir otro base cierra el anterior (y su
  // interno); abrir otro interno cierra el anterior.
  #baseAnchor = null             // hoja-ancla (nearest-centroid) del ÚNICO cluster base abierto, o null
  #innerAnchor = null            // min leaf-id del ÚNICO sub-cluster interno abierto (depth-2), o null
  #expandedSig = ''              // firma de (baseAnchor|innerAnchor) para detectar cambios en recluster
  #expandedGroups = []           // 0-o-1: [{ clusterId, center, slots }] del base abierto
  // SNAPSHOT de la sesión de expansión: las hojas (id + posición) capturadas en el click, congeladas.
  // La membresía/conteo/partición del base NO se re-derivan del árbol vivo en cada recluster (eso hacía
  // saltar sub-burbujas↔hojas al cruzar el umbral entre dos generaciones de #sc). Con el set fijo,
  // #partition es determinista entre reclusters; sólo encoge por bajas reales (que lo re-particionan y
  // cierran el sub-cluster interno). Un móvil nuevo NO se suma a una espiral abierta (semántica spiderfy).
  #baseLeaves = null             // [{ properties:{id}, geometry:{coordinates:[lng,lat]} }] | null
  #baseLeafIds = null            // Set(id) del snapshot (supresión/membresía O(1)) | null

  constructor({ radius = 80, maxZoom = 18, minPoints = 2, enabled = true, splitThreshold = 16 } = {}) {
    this.#radius = radius
    this.#maxZoom = maxZoom
    this.#minPoints = minPoints
    this.#splitThreshold = splitThreshold
    this.#enabled = enabled
    this.#sc = this.#build()
  }

  get clusteredIds() { return this.#clusteredIds }
  get bubbles() { return this.#bubbles }
  // Clusters expandidos del último recluster: [{ clusterId, center:{lat,lng}, ids:[...] }]. El motor
  // los usa para renderizar las hojas en espiral + las líneas (es headless: no calcula píxeles).
  // 0-o-1 grupo del base abierto: [{ clusterId, center, slots }] donde slots = heterogéneos
  // ({kind:'leaf',id} | {kind:'subcluster',id,count,ids}). El motor los proyecta a píxeles (headless
  // no calcula pantalla). Fase 1: todos los slots son 'leaf'.
  get expandedGroups() { return this.#expandedGroups }

  /* ── Expand / collapse de clusters individuales (modelo ANCLA por hoja) ──
   * El caller (MapEngine) garantiza que `clusterId` es del frame ACTUAL verificándolo contra la
   * fuente de burbujas viva antes de llamar; el try/catch es la red secundaria ante la carrera
   * reindex-en-vuelo (el id se volvió stale entre el paint de la burbuja y el click). */

  // getLeaves con id FRESCO de getClusters del frame actual. Interno: nunca recibe un id retenido.
  #leavesOf(clusterId) { return this.#sc.getLeaves(clusterId, Infinity) }

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

  // ¿estas hojas contienen el ancla del base abierto? (el base es "este cluster" del frame).
  #hasBaseAnchor(leaves) {
    if (this.#baseAnchor == null) return false
    for (const lf of leaves) if (lf.properties.id === this.#baseAnchor) return true
    return false
  }

  // Sub-clustering STR (Sort-Tile-Recursive): parte las hojas en ~√N grupos balanceados y
  // espacialmente coherentes. Determinista — el tiebreak por id es OBLIGATORIO en AMBOS sorts (la
  // estabilidad de Array.sort no está garantizada a estos tamaños; sin él la partición y los conteos
  // parpadean entre reindex en vivo). Cada grupo → slot {kind:'subcluster', id:minLeafId(ancla
  // estable), count, ids}. O(N log N), corre SÓLO al recluster del base abierto (no por-frame del resto).
  #partition(leaves) {
    const N = leaves.length
    const G = Math.ceil(Math.sqrt(N))          // nº de sub-clusters
    const S = Math.ceil(N / G)                 // ~hojas por sub-cluster
    const P = Math.ceil(Math.sqrt(G))          // franjas verticales
    const sliceCap = P * S
    const cmpId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    const arr = leaves.map(lf => ({ id: lf.properties.id, x: lf.geometry.coordinates[0], y: lf.geometry.coordinates[1] }))
    arr.sort((a, b) => (a.x - b.x) || cmpId(a, b))     // por lng, tiebreak id
    const slots = []
    for (let i = 0; i < arr.length; i += sliceCap) {
      const slice = arr.slice(i, i + sliceCap)
      slice.sort((a, b) => (a.y - b.y) || cmpId(a, b))  // por lat dentro de la franja, tiebreak id
      for (let j = 0; j < slice.length; j += S) {
        const grp = slice.slice(j, j + S)
        let min = grp[0].id
        for (const g of grp) if (g.id < min) min = g.id
        if (min === this.#innerAnchor) {
          // ABIERTO (depth-2): el sub-cluster florece en sus hojas, spliced EN SU LUGAR → el caracol
          // crece y empuja a los hermanos (la espiral se recalcula sobre el nuevo total de slots).
          // `group` marca que son del sub-cluster abierto → el motor las une visualmente (patas color).
          for (const g of grp) slots.push({ kind: 'leaf', id: g.id, group: min })
        } else {
          slots.push({ kind: 'subcluster', id: min, count: grp.length, ids: grp.map(g => g.id) })
        }
      }
    }
    return slots
  }

  #refreshExpandedSig() {
    this.#expandedSig = (this.#baseAnchor ?? '') + '|' + (this.#innerAnchor ?? '')
  }

  // Expande el cluster `clusterId` como BASE (single-open: cierra el base anterior y su interno).
  // Devuelve { anchorId, ids } o null (id stale / sin hojas). `ids` = los id de DATO del usuario.
  expandCluster(clusterId) {
    let leaves
    try { leaves = this.#leavesOf(clusterId) } catch { return null }
    if (!leaves.length) return null
    const anchorId = this.#pickAnchor(leaves)
    const ids = leaves.map(lf => lf.properties.id)
    // Captura la SESIÓN: congela el set de hojas (id + posición) del click. Desde acá la membresía/conteo
    // del base no se re-derivan del árbol vivo (lo que causaba el flip sub-burbujas↔hojas tras un reindex).
    this.#baseAnchor = anchorId
    this.#innerAnchor = null                // abrir otro base cierra el sub-cluster interno
    this.#baseLeaves = leaves.map(lf => ({ properties: { id: lf.properties.id }, geometry: { coordinates: lf.geometry.coordinates } }))
    this.#baseLeafIds = new Set(ids)
    this.#refreshExpandedSig()
    this.#signature = null
    return { anchorId, ids }
  }

  // Colapsa el cluster base si en este frame contiene el ancla. Devuelve los ids re-clusterizados
  // (para limpiar un panel simétrico al expand), o null si no cambió.
  collapseCluster(clusterId) {
    // Caso ancla-sola: la burbuja dim tiene id sintético 'b:'+ancla → getLeaves lanzaría; atajo directo.
    if (!(this.#baseAnchor != null && clusterId === 'b:' + this.#baseAnchor)) {
      let leaves
      try { leaves = this.#leavesOf(clusterId) } catch { return null }
      if (!this.#hasBaseAnchor(leaves)) return null
    }
    const ids = this.#baseLeafIds ? [...this.#baseLeafIds] : []
    this.#baseAnchor = null
    this.#innerAnchor = null
    this.#baseLeaves = null
    this.#baseLeafIds = null
    this.#refreshExpandedSig(); this.#signature = null
    return ids
  }

  collapseAll() {
    if (this.#baseAnchor == null && this.#innerAnchor == null) return false
    this.#baseAnchor = null
    this.#innerAnchor = null
    this.#baseLeaves = null
    this.#baseLeafIds = null
    this.#expandedSig = ''
    this.#signature = null
    return true
  }

  // Abre/cierra (toggle) el sub-cluster interno cuyo ancla (min leaf-id) es `subId`, dentro del base
  // abierto. Single-open interno: abrir otro cierra el anterior. Devuelve true si quedó abierto.
  expandInner(subId) {
    if (this.#baseAnchor == null) return false
    this.#innerAnchor = (this.#innerAnchor === subId) ? null : subId
    this.#refreshExpandedSig(); this.#signature = null
    return this.#innerAnchor != null
  }

  // ¿El cluster del frame actual es el base abierto? (sus hojas contienen el ancla base).
  isClusterExpanded(clusterId) {
    if (this.#baseAnchor != null && clusterId === 'b:' + this.#baseAnchor) return true   // dim sintética (ancla-sola)
    let leaves
    try { leaves = this.#leavesOf(clusterId) } catch { return false }
    return this.#hasBaseAnchor(leaves)
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
    if (!v) { this.#baseAnchor = null; this.#innerAnchor = null; this.#baseLeaves = null; this.#baseLeafIds = null; this.#refreshExpandedSig() }
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
    if (this.#baseAnchor != null && !ids.has(this.#baseAnchor)) {
      this.#baseAnchor = null; this.#innerAnchor = null; this.#baseLeaves = null; this.#baseLeafIds = null; this.#refreshExpandedSig()
    } else if (this.#baseLeafIds != null) {
      if (this.#baseLeaves.some(l => !ids.has(l.properties.id))) {
        this.#baseLeaves = this.#baseLeaves.filter(l => ids.has(l.properties.id))
        this.#baseLeafIds = new Set(this.#baseLeaves.map(l => l.properties.id))
        this.#innerAnchor = null   // una baja real re-particiona el snapshot → cierra el sub-cluster interno
        this.#refreshExpandedSig()
      }
      if (this.#baseLeaves.length <= 1) {   // sólo quedó el ancla (o nada) → la espiral no tiene sentido
        this.#baseAnchor = null; this.#innerAnchor = null; this.#baseLeaves = null; this.#baseLeafIds = null; this.#refreshExpandedSig()
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
      return true
    }

    const results = this.#sc.getClusters(WORLD, Math.round(zoom))

    // En el caso común (nada expandido) la firma es idéntica al código original — sin overhead, ideal
    // para bursts de zoom. Solo con anclas activas se prefija 'a[...]' para detectar cambios de estado
    // al mismo zoom (getClusters devuelve lo mismo; solo cambia qué clusters se explotan).
    // Caso común (nada abierto) → firma idéntica al original, cero overhead en bursts de zoom. Con un
    // base abierto se prefija 'a[baseAnchor|innerAnchor]' para detectar cambios de estado al mismo zoom
    // (incluido togglear el sub-cluster interno: getClusters devuelve lo mismo, sólo cambia el bloom).
    const hasExpansion = this.#baseAnchor != null
    let signature = hasExpansion ? zoom + ':a[' + this.#expandedSig + ']:' : zoom + ':'
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
    // CONGELADO #baseLeaves. count y partición salen del snapshot, NO del árbol vivo → invariantes a
    // reindex (mata el flip). Pocas hojas → directas; muchas → sub-clusters (~√N de ~√N) legibles.
    const emitBase = (bubbleId, center, liveLeaves) => {
      baseFound = true
      const snap = this.#baseLeaves
      bubbles.push({ id: bubbleId, lat: center.lat, lng: center.lng, count: snap.length, expanded: true })
      const slots = snap.length <= this.#splitThreshold
        ? snap.map(l => ({ kind: 'leaf', id: l.properties.id }))
        : this.#partition(snap)
      groups.push({ clusterId: bubbleId, center, slots })
      // Miembros VIVOS del bucket base que NO están en el snapshot (un móvil que entró/se desplazó al
      // cluster del base DURANTE la sesión): no se suman a la espiral congelada, pero deben seguir
      // VISIBLES en su posición real → solos (no suprimidos). Sin esto desaparecerían del mapa.
      if (liveLeaves) for (const lf of liveLeaves) if (!this.#baseLeafIds.has(lf.properties.id)) soloIds.add(lf.properties.id)
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
        if (hasExpansion && !baseFound && p.id === this.#baseAnchor) emitBase('b:' + this.#baseAnchor, { lat, lng }, null)
      }
    })

    // Las hojas del snapshot SIEMPRE quedan suprimidas en el host (se dibujan en la espiral), aunque el
    // árbol vivo marque alguna como `solo` tras moverse → evita verla duplicada (posición real + espiral).
    if (this.#baseLeafIds != null) this.#baseLeafIds.forEach(id => soloIds.delete(id))
    // allIds − soloIds = los realmente dentro de un cluster (incluidas las hojas expandidas, que
    // siguen suprimidas en el host). Worldwide garantiza que cada id indexado aparece en results.
    this.#clusteredIds.clear()
    this.#allIds.forEach(id => { if (!soloIds.has(id)) this.#clusteredIds.add(id) })

    this.#bubbles = bubbles
    this.#expandedGroups = groups
    return true
  }

  reset() {
    this.#features = []
    this.#allIds = new Set()
    this.#clusteredIds.clear()
    this.#bubbles = []
    this.#expandedGroups = []
    this.#baseAnchor = null
    this.#innerAnchor = null
    this.#baseLeaves = null
    this.#baseLeafIds = null
    this.#expandedSig = ''
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
