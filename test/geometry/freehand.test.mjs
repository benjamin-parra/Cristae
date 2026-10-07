// El horneado del trazo a mano alzada (`geometry/freehand.js`): Douglas–Peucker, Catmull-Rom centrípeta
// abierta y periódica, y densificado a 1 px. El oráculo de la curva es la Catmull-Rom de Barry–Goldman,
// la pirámide de interpolaciones lineales: otra fórmula que la Hermite/Bézier del código, así que no
// comparten un error de signo ni de parametrización.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bake } from '../../src/geometry/freehand.js'

const SAGITTA = 1

// Pseudoaleatorio determinista.
const azar = semilla => () => {
  semilla = (semilla + 0x6D2B79F5) | 0
  let t = Math.imul(semilla ^ (semilla >>> 15), 1 | semilla)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const pares = xy => Array.from({ length: xy.length / 2 }, (_, i) => [xy[2 * i], xy[2 * i + 1]])
const plano = ps => ps.flat()

const mezcla = (p, q, a, b, t) => [0, 1].map(k => (b - t) / (b - a) * p[k] + (t - a) / (b - a) * q[k])

// La curva de Barry–Goldman entre p1 y p2, con los vecinos p0 y p3, en `n` puntos del tramo (sin el final).
const barryGoldman = (p0, p1, p2, p3, n) => {
  const d  = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) ** 0.5
  const t0 = 0, t1 = d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3)
  const [a, b] = [t1, t2]
  return Array.from({ length: n }, (_, i) => {
    const t  = a + (b - a) * i / n
    const a1 = mezcla(p0, p1, t0, t1, t)
    const a2 = mezcla(p1, p2, t1, t2, t)
    const a3 = mezcla(p2, p3, t2, t3, t)
    const b1 = mezcla(a1, a2, t0, t2, t)
    const b2 = mezcla(a2, a3, t1, t3, t)
    return mezcla(b1, b2, t1, t2, t)
  })
}

// La curva entera por los vértices `ps`, densa. Abierta: más allá de los extremos el vecino es el reflejo.
const curva = (ps, cerrada, n = 400) => {
  const m = ps.length
  const out = []
  for (let i = 0; i < (cerrada ? m : m - 1); i++) {
    const p1 = ps[i], p2 = ps[(i + 1) % m]
    const p0 = cerrada ? ps[(i + m - 1) % m] : ps[i - 1] ?? [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]]
    const p3 = cerrada ? ps[(i + 2) % m] : ps[i + 2] ?? [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]]
    out.push(...barryGoldman(p0, p1, p2, p3, n))
  }
  cerrada || out.push(ps[m - 1])
  return out
}

// Distancia de un punto a una polilínea, abierta o cerrada.
const distancia = (pt, poli, cerrada) => {
  let mejor = Infinity
  for (let i = 0; i < (cerrada ? poli.length : poli.length - 1); i++) {
    const a = poli[i], b = poli[(i + 1) % poli.length]
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const t  = Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)))
    mejor = Math.min(mejor, Math.hypot(a[0] + t * dx - pt[0], a[1] + t * dy - pt[1]))
  }
  return mejor
}

// Dos segmentos propios se cruzan: orientación estricta, sin contar los que comparten un extremo.
const cruzan = (a, b, c, d) => {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0
}

const autoCruces = (poli, cerrada) => {
  const n = poli.length, segs = cerrada ? n : n - 1
  let cruces = 0
  for (let i = 0; i < segs; i++)
    for (let j = i + 2; j < segs; j++)
      !(cerrada && i === 0 && j === segs - 1) && cruzan(poli[i], poli[i + 1], poli[j], poli[(j + 1) % n]) && cruces++
  return cruces
}

const circulo = (n, r = 100) => Array.from({ length: n }, (_, i) => [r * Math.cos(2 * Math.PI * i / n), r * Math.sin(2 * Math.PI * i / n)])
const onda    = n => Array.from({ length: n }, (_, i) => [i * 40, 30 * Math.sin(i * 1.3)])

test('abierta pasa por todos los vértices que Douglas–Peucker conserva y sigue la Catmull-Rom centrípeta', () => {
  const ps    = onda(9)
  const baked = pares(bake(plano(ps), false))
  const real  = curva(ps, false)

  ps.forEach(p => assert.ok(baked.some(q => q[0] === p[0] && q[1] === p[1]), `vértice ${p}`))
  assert.deepEqual(baked[0], ps[0])
  assert.deepEqual(baked.at(-1), ps.at(-1))
  baked.forEach(q => assert.ok(distancia(q, real, false) < 1e-2, `fuera de la curva: ${q}`))
  real.forEach(q => assert.ok(distancia(q, baked, false) <= SAGITTA + 1e-2, `la cuerda se aparta más de ${SAGITTA}px en ${q}`))
})

test('cerrada es periódica: el tramo que cierra sigue la misma curva y no repite el primer vértice', () => {
  const ps    = circulo(12)
  const baked = pares(bake(plano(ps), true))
  const real  = curva(ps, true)

  assert.notDeepEqual(baked.at(-1), baked[0])
  ps.forEach(p => assert.ok(baked.some(q => q[0] === p[0] && q[1] === p[1]), `vértice ${p}`))
  baked.forEach(q => assert.ok(distancia(q, real, true) < 1e-2, `fuera de la curva: ${q}`))
  real.forEach(q => assert.ok(distancia(q, baked, true) <= SAGITTA + 1e-2, `la cuerda se aparta más de ${SAGITTA}px en ${q}`))
})

test('cerrada con el último muestreo en el primer punto no lo repite', () => {
  const ps = circulo(12)
  assert.deepEqual(bake(plano([...ps, ps[0]]), true), bake(plano(ps), true))
})

test('cerrada no depende de por dónde empieza el trazo', () => {
  const ps    = circulo(12).map(([x, y], i) => [x * (1 + 0.15 * Math.sin(i * 2)), y])
  const orden = pares(bake(plano(ps), true)).map(String).sort()

  for (let k = 1; k < 12; k += 4) {
    const girada = [...ps.slice(k), ...ps.slice(0, k)]
    assert.deepEqual(pares(bake(plano(girada), true)).map(String).sort(), orden, `girada ${k}`)
  }
})

test('la curva no hace lazos ni cruces consigo misma', () => {
  const rnd = azar(7)
  for (let caso = 0; caso < 20; caso++) {
    const anillo = Array.from({ length: 40 }, (_, i) => {
      const a = 2 * Math.PI * i / 40, r = 80 + 60 * rnd()
      return [r * Math.cos(a), r * Math.sin(a)]
    })
    const espiral = Array.from({ length: 60 }, (_, i) => [i * 2 * Math.cos(i / 6) + rnd(), i * 2 * Math.sin(i / 6) + rnd()])
    assert.equal(autoCruces(pares(bake(plano(anillo), true)), true), 0, `anillo ${caso}`)
    assert.equal(autoCruces(pares(bake(plano(espiral), false)), false), 0, `espiral ${caso}`)
  }
})

test('Douglas–Peucker quita lo que se aparta de la recta menos de 2 px y conserva lo que se aparta más', () => {
  const recta = Array.from({ length: 30 }, (_, i) => [i * 10, (i % 2) * 1.5])
  assert.deepEqual(bake(plano(recta), false), [0, 0, 290, 1.5])

  const pico  = [[0, 0], [50, 2.5], [100, 5], [150, 2.5], [200, 0]]
  const baked = pares(bake(plano(pico), false))
  assert.ok(baked.some(q => q[0] === 100 && q[1] === 5), 'el pico de 5 px queda')
  assert.ok(!baked.some(q => q[0] === 50 && q[1] === 2.5), 'los de sus rectas no')
})

test('una recta es un solo tramo: la flecha ya está bajo 1 px', () => {
  assert.deepEqual(bake([0, 0, 100, 0], false), [0, 0, 100, 0])
  assert.deepEqual(bake(plano(Array.from({ length: 5 }, (_, i) => [i * 10, i * 10])), false), [0, 0, 40, 40])
})

test('cerrada que no encierra área devuelve lo que queda, sin curva', () => {
  assert.ok(bake([0, 0, 50, 0, 100, 0, 150, 0], true).length < 6)
  assert.ok(bake([0, 0, 10, 0], true).length < 6)
})

test('los puntos repetidos y los trazos de un solo punto no dan NaN', () => {
  assert.deepEqual(bake([0, 0, 0, 0, 10, 10, 10, 10], false), [0, 0, 10, 10])
  assert.deepEqual(bake([5, 5, 5, 5], false), [5, 5])
  assert.deepEqual(bake([0, 0, 1, 0, 0, 0], false), [0, 0, 0, 0], 'el trazo que vuelve a su origen conserva los dos extremos')
  assert.deepEqual(bake([], true), [])
  const cuadrado = [0, 0, 100, 0, 100, 100, 0, 100, 0, 0, 100, 0, 100, 100, 0, 100]
  assert.ok(bake(cuadrado, true).every(Number.isFinite))
  assert.ok(bake([0, 0, 100, 0, 100, 100, 0, 100, 0, 0], true).every(Number.isFinite))
})
