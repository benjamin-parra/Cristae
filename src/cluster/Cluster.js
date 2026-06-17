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
  #enabled = true                // off → no suprime nada y no emite burbujas (toggle limpio)
  #features = []
  #allIds = new Set()
  #clusteredIds = new Set()      // estable: nunca se reasigna, solo clear()+add()
  #bubbles = []
  #signature = null

  constructor({ radius = 80, maxZoom = 18, minPoints = 2, enabled = true } = {}) {
    this.#radius = radius
    this.#maxZoom = maxZoom
    this.#minPoints = minPoints
    this.#enabled = enabled
    this.#sc = this.#build()
  }

  get clusteredIds() { return this.#clusteredIds }
  get bubbles() { return this.#bubbles }

  /* ── Config reactiva: recrea el índice y recarga las features ya extraídas ── */

  set radius(v) { if (v !== this.#radius) { this.#radius = v; this.#rebuildIndex() } }
  set maxZoom(v) { if (v !== this.#maxZoom) { this.#maxZoom = v; this.#rebuildIndex() } }
  set minPoints(v) { if (v !== this.#minPoints) { this.#minPoints = v; this.#rebuildIndex() } }
  // Toggle de clustering: al apagarlo se fuerza el recálculo (signature null) → el próximo
  // recluster vacía clusteredIds/bubbles; al encenderlo vuelve a agrupar. Limpio, sin desmontar.
  set enabled(v) { if (v !== this.#enabled) { this.#enabled = v; this.#signature = null } }

  /* ── Datos: extrae features e indexa. O(n) extracción + O(n log n) build ── */

  index(items, idOf, positionOf) {
    const features = []
    const ids = new Set()
    items.forEach(item => {
      const pos = positionOf(item)
      if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return
      const id = idOf(item)
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
      return true
    }

    const results = this.#sc.getClusters(WORLD, Math.round(zoom))

    let signature = zoom + ':'
    results.forEach(f => {
      const p = f.properties
      signature += p.cluster ? `c${f.id}:${p.point_count},` : `s${p.id},`
    })
    if (signature === this.#signature) return false
    this.#signature = signature

    const soloIds = new Set()
    const bubbles = []
    results.forEach(f => {
      const p = f.properties
      if (p.cluster) {
        const [lng, lat] = f.geometry.coordinates
        bubbles.push({ id: f.id, lat, lng, count: p.point_count })
      } else {
        soloIds.add(p.id)
      }
    })

    // allIds − soloIds = los realmente dentro de un cluster. Worldwide garantiza que cada
    // id indexado aparece en results, así que la resta es algebraicamente completa.
    this.#clusteredIds.clear()
    this.#allIds.forEach(id => { if (!soloIds.has(id)) this.#clusteredIds.add(id) })

    this.#bubbles = bubbles
    return true
  }

  reset() {
    this.#features = []
    this.#allIds = new Set()
    this.#clusteredIds.clear()
    this.#bubbles = []
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
