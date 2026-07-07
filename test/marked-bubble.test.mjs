// Test del eje "marked" de Cluster — señalización de burbujas que contienen ids marcados
// (tag `marked` + markedHidden) y la consulta pura contents(). Corre con: node test/marked-bubble.test.mjs
import { Cluster } from '../src/cluster/Cluster.js'

let n = 0, fails = 0
const check = (name, cond, extra = '') => { n++; if (!cond) { fails++; console.log(`✗ ${name} ${extra}`) } }

const idOf = p => p.id
const posOf = p => ({ lat: p.lat, lng: p.lng })
const mk = (over = {}) => new Cluster({ radius: 80, maxZoom: 18, minPoints: 2, ...over })
// Dos pares bien separados: a bajo zoom cada par clusteriza por su lado.
const FLOTA = [
  { id: 1, lat: 0, lng: 0 }, { id: 2, lat: 0, lng: 1e-4 },        // burbuja A
  { id: 3, lat: 20, lng: 60 }, { id: 4, lat: 20, lng: 60.0001 },  // burbuja B
]

// ── Marcado oculto en una burbuja → colocación con el centro de ESA burbuja + tag `marked` ──
{
  const c = mk()
  c.index(FLOTA, idOf, posOf)
  c.marked = [1]
  c.recluster(3)
  check('oculto → 1 colocación', c.markedHidden.length === 1, `got ${c.markedHidden.length}`)
  const h = c.markedHidden[0]
  check('colocación por id de dato', h.id === 1)
  check('centro ≈ burbuja A', Math.abs(h.center.lat - 0) < 0.01 && Math.abs(h.center.lng - 0) < 0.01,
    `got ${h.center.lat},${h.center.lng}`)
  const marcadas = c.bubbles.filter(b => b.marked)
  check('sólo la burbuja contenedora taggeada', marcadas.length === 1 && Math.abs(marcadas[0].lat - 0) < 0.01)
}

// ── Multi: dos marcados en la MISMA burbuja (mismo centro) y en burbujas DISTINTAS ──
{
  const c = mk()
  c.index(FLOTA, idOf, posOf)
  c.marked = [1, 2]
  c.recluster(3)
  check('misma burbuja → 2 colocaciones', c.markedHidden.length === 2)
  check('misma burbuja → mismo centro',
    c.markedHidden[0].center.lat === c.markedHidden[1].center.lat &&
    c.markedHidden[0].center.lng === c.markedHidden[1].center.lng)

  c.marked = [1, 3]
  c.recluster(3)
  check('burbujas distintas → 2 colocaciones', c.markedHidden.length === 2)
  check('orden canónico por id', c.markedHidden[0].id === 1 && c.markedHidden[1].id === 3)
  check('ambas burbujas taggeadas', c.bubbles.filter(b => b.marked).length === 2)
}

// ── Exclusiones: solo (desclusterizado), podado, set vacío ──
{
  const c = mk()
  c.index(FLOTA, idOf, posOf)
  c.marked = [1]
  c.recluster(19)                       // sobre maxZoom: todos solos
  check('solo → sin colocación', c.markedHidden.length === 0, `got ${c.markedHidden.length}`)

  c.recluster(3)
  check('(setup) vuelve a oculto', c.markedHidden.length === 1)
  c.marked = [999]                      // id que no existe en la flota (≈ podado)
  c.recluster(3)
  check('podado → sin colocación', c.markedHidden.length === 0)
  c.marked = []
  c.recluster(3)
  check('set vacío → sin colocación ni tags', c.markedHidden.length === 0 && !c.bubbles.some(b => b.marked))
}

// ── Hoja de espiral abierta: en clusteredIds pero VISIBLE → excluida ──
{
  const c = mk()
  c.index(FLOTA, idOf, posOf)
  c.marked = [1]
  c.recluster(3)
  const burbujaA = c.bubbles.find(b => Math.abs(b.lat - 0) < 0.01)
  c.expandCluster(burbujaA.id)          // abre la sesión: 1 y 2 pasan a hojas de espiral
  c.recluster(3)
  check('hoja de espiral → sin colocación', c.markedHidden.length === 0, `got ${c.markedHidden.length}`)
  c.collapseAll()
  c.recluster(3)
  check('al colapsar vuelve la colocación', c.markedHidden.length === 1)
}

// ── Clustering apagado → sin colocaciones; getter puro (no muta estado) ──
{
  const off = mk({ enabled: false })
  off.index(FLOTA, idOf, posOf)
  off.marked = [1]
  off.recluster(3)
  check('apagado → sin colocación', off.markedHidden.length === 0)

  const c = mk()
  c.index(FLOTA, idOf, posOf)
  c.marked = [1]
  c.recluster(3)
  const antes = JSON.stringify([[...c.clusteredIds].sort(), c.bubbles.length])
  c.markedHidden; c.markedHidden        // lecturas repetidas
  const despues = JSON.stringify([[...c.clusteredIds].sort(), c.bubbles.length])
  check('lectura pura: estado intacto', antes === despues)
}

// ── Cambiar el set al MISMO zoom re-taggea (la firma se invalida) ──
{
  const c = mk()
  c.index(FLOTA, idOf, posOf)
  c.marked = [1]
  check('recluster tras marcar → true', c.recluster(3) === true)
  check('(setup) A taggeada', c.bubbles.some(b => b.marked))
  c.marked = [3]
  check('recluster tras re-marcar al mismo zoom → true', c.recluster(3) === true)
  const marcadas = c.bubbles.filter(b => b.marked)
  check('tag migró a la burbuja B', marcadas.length === 1 && Math.abs(marcadas[0].lat - 20) < 0.01)
}

// ── contents(): consulta pura del contenido de una burbuja del frame ──
{
  const c = mk()
  c.index(FLOTA, idOf, posOf)
  c.recluster(3)
  const burbujaA = c.bubbles.find(b => Math.abs(b.lat - 0) < 0.01)
  const ids = c.contents(burbujaA.id)
  check('contents → ids de la burbuja', JSON.stringify([...ids].sort()) === '[1,2]', `got ${ids}`)
  check('contents id stale → null', c.contents(123456789) === null)
}

console.log(fails ? `\n${fails}/${n} FAIL` : `\n${n}/${n} OK`)
if (fails) process.exit(1)
