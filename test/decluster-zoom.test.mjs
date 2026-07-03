// Test de Cluster.declusterZoomFor — zoom mínimo de desclusterización (cómputo puro, no muta estado).
// Corre con: node test/decluster-zoom.test.mjs
import { Cluster } from '../src/cluster/Cluster.js'

let n = 0, fails = 0
const check = (name, cond, extra = '') => { n++; if (!cond) { fails++; console.log(`✗ ${name} ${extra}`) } }

const idOf = p => p.id
const posOf = p => ({ lat: p.lat, lng: p.lng })
const mk = (over = {}) => new Cluster({ radius: 80, maxZoom: 18, minPoints: 2, ...over })

// ── Punto ÚNICO: minPoints=2 ⇒ nunca clusteriza ⇒ solo a todo zoom ⇒ 0 ──
{
  const c = mk()
  c.index([{ id: 1, lat: 0, lng: 0 }], idOf, posOf)
  check('único → 0', c.declusterZoomFor(1) === 0, `got ${c.declusterZoomFor(1)}`)
}

// ── Dos puntos casi coincidentes: clusterizados hasta arriba ⇒ maxZoom+1 (garantía dura) ──
{
  const c = mk()
  c.index([{ id: 1, lat: 0, lng: 0 }, { id: 2, lat: 0, lng: 1e-4 }], idOf, posOf)
  check('pegados → maxZoom+1', c.declusterZoomFor(1) === 19, `got ${c.declusterZoomFor(1)}`)
}

// ── Caso intermedio: zoom en rango + consistencia con recluster/clusteredIds en el borde ──
{
  const c = mk()
  c.index([{ id: 1, lat: 0, lng: 0 }, { id: 2, lat: 0, lng: 0.05 }], idOf, posOf)
  const z = c.declusterZoomFor(1)
  check('intermedio en rango', z > 0 && z <= 19, `got ${z}`)
  // Cross-check con la ruta viva: solo a z, clusterizado a z-1.
  c.recluster(z);     check('borde: solo a z',           !c.clusteredIds.has(1), `z=${z}`)
  c.recluster(z - 1); check('borde: clusterizado a z-1',  c.clusteredIds.has(1), `z-1=${z - 1}`)
}

// ── El cómputo NO muta el estado vivo (pureza) ──
{
  const c = mk()
  c.index([{ id: 1, lat: 0, lng: 0 }, { id: 2, lat: 0, lng: 0.05 }], idOf, posOf)
  c.recluster(3)
  const before = [...c.clusteredIds].sort()
  c.declusterZoomFor(1); c.declusterZoomFor(2)
  const after = [...c.clusteredIds].sort()
  check('puro: clusteredIds intacto', JSON.stringify(before) === JSON.stringify(after), `${before} vs ${after}`)
}

// ── id inexistente / clustering apagado ⇒ null ──
{
  const c = mk()
  c.index([{ id: 1, lat: 0, lng: 0 }], idOf, posOf)
  check('id inexistente → null', c.declusterZoomFor(999) === null)
  const off = mk({ enabled: false })
  off.index([{ id: 1, lat: 0, lng: 0 }, { id: 2, lat: 0, lng: 1e-4 }], idOf, posOf)
  check('apagado → null', off.declusterZoomFor(1) === null)
}

console.log(fails ? `\n${fails}/${n} FAIL` : `\n${n}/${n} OK`)
if (fails) process.exit(1)
