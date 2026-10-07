// La geodésica de un tramo (geometry/curve.js) y su `src` en el índice de picking. Las referencias son
// independientes del módulo: la separación de cada cuerda de Mercator a la geodésica, medida por fuerza
// bruta con la distancia a un círculo máximo de la esfera, y la geographiclib directa para que un punto
// esté sobre la geodésica del elipsoide. Contrastar contra el mismo `count` o el mismo `at` daría un test
// que se auto-cumple.
// Corre con: node --test test/geometry/curve.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import geographiclib from 'geographiclib-geodesic'
import { count, at, geodesic } from '../../src/geometry/curve.js'
import { sphere, byDefault } from '../../src/geometry/geodesic.js'
import { WGS84 } from '../../src/geometry/ellipsoid.js'
import { stepsFor, GROUND } from '../../src/geometry/density.js'
import { nearest, toParts } from '../../src/geometry/polyline.js'
import { projX0, projY0 } from '../../src/render/project.js'

const MODEL       = Symbol.for('cristae.geometry.model')
const DESTINATION = Symbol.for('cristae.geometry.destination')
const HEADING     = Symbol.for('cristae.geometry.heading')

const R   = 6371008.8                  // radio medio IUGG R1 (m)
const RAD = Math.PI / 180

const { Geodesic, DISTANCE } = geographiclib.Geodesic
const solver = new Geodesic(6378137, 0.0033528106647474805)

const dentro = (real, ref, tol, msg) =>
  assert.ok(Math.abs(real - ref) <= tol, `${msg}: ${real} vs ${ref} (±${tol})`)

// ── Referencias de la esfera ──
const hav = (a, b) => {
  const s1 = Math.sin((b[0] - a[0]) * RAD / 2), s2 = Math.sin((b[1] - a[1]) * RAD / 2)
  return 2 * R * Math.asin(Math.sqrt(s1 * s1 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * s2 * s2))
}
const rumbo = (a, b) => Math.atan2(Math.sin((b[1] - a[1]) * RAD) * Math.cos(b[0] * RAD),
  Math.cos(a[0] * RAD) * Math.sin(b[0] * RAD) - Math.sin(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.cos((b[1] - a[1]) * RAD))
// La distancia de p al círculo máximo de a a b.
const alCirculo = (a, b, p) =>
  Math.abs(Math.asin(Math.sin(hav(a, p) / R) * Math.sin(rumbo(a, p) - rumbo(a, b)))) * R
const merc   = lat => Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2))
const unmerc = y => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD

// El destino de a a `metros` y `grados` de rumbo, por la fórmula cerrada de la esfera.
const destino = (a, grados, metros) => {
  const d = metros / R, b = grados * RAD, la = a[0] * RAD
  const lat = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b))
  const lng = a[1] * RAD + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(lat))
  return [lat / RAD, lng / RAD]
}

// La mayor separación entre lo que se dibuja —rectas en Mercator entre los puntos— y la geodésica de a a b,
// en metros de una esfera de radio `r`. Las 31 muestras por cuerda incluyen su punto medio, donde se aparta más.
const separacion = (a, b, puntos, r = R) => {
  let peor = 0
  for (let k = 0; k < puntos.length - 1; k++) {
    const y1 = merc(puntos[k][0]), y2 = merc(puntos[k + 1][0])
    for (let j = 1; j < 32; j++) {
      const f = j / 32
      peor = Math.max(peor, alCirculo(a, b, [unmerc(y1 + (y2 - y1) * f), puntos[k][1] + (puntos[k + 1][1] - puntos[k][1]) * f]))
    }
  }
  return peor * r / R
}

// La cuenta sin prefiltro, armada por otro camino: la cota de `stepsFor` con el largo de la esfera media que
// tiene la misma separación, √(L·θ·R), y la latitud del vértice del círculo máximo cuando cae dentro del tramo
// —los rumbos desde cada punto hacia el otro miran al mismo polo—, por Clairaut: cos φ = cos φ₁·|sin α₁|.
const MAXLAT = 85.0511287798
const cuenta = (modelo, a, b) => {
  const alfa  = rumbo(a, b)
  const apice = Math.cos(alfa) * Math.cos(rumbo(b, a)) > 0
    ? Math.acos(Math.cos(a[0] * RAD) * Math.abs(Math.sin(alfa))) / RAD
    : Math.max(Math.abs(a[0]), Math.abs(b[0]))
  return stepsFor(Math.sqrt(modelo[MODEL](...a, ...b) * hav(a, b)), Math.min(MAXLAT, apice), GROUND)
}

// Los `m` tramos que dibujaría un consumidor del primitivo.
const curvar = (model, a, b, m = count(model, a[0], a[1], b[0], b[1])) =>
  [a, ...Array.from({ length: m - 1 }, (_, k) => at(model, a[0], a[1], b[0], b[1], (k + 1) / m, [0, 0])), b]

let semilla = 11
const azar  = () => (semilla = semilla * 16807 % 2147483647) / 2147483647

/* ── Cuántos tramos ── */

test('un track GPS de pasos de 10 a 100 m no se toca, a cualquier latitud: ningún tramo se parte y el path sale igual', () => {
  for (const lat0 of [-60, 0, 37, 65, 89.9]) {
    let punto = [lat0, -70]
    const track = [punto]
    for (let i = 0; i < 200; i++) track.push(punto = destino(punto, azar() * 360, 10 + azar() * 90))
    for (const modelo of [byDefault, sphere(), WGS84])
      track.slice(1).forEach((q, i) =>
        assert.equal(count(modelo, track[i][0], track[i][1], q[0], q[1]), 1, `lat ${lat0}, tramo ${i}`))
    assert.deepEqual(geodesic(track), [track], `el path a ${lat0}° sale igual`)
    assert.deepEqual(geodesic(WGS84, track), [track])
  }
})

test('100 km a 37° de latitud dan unos 40 tramos, ni uno que no haga falta ni la mitad de los que hacen falta', () => {
  const a = [37, 0], b = [37, 1.12]
  assert.ok(Math.abs(hav(a, b) - 100000) < 1000, 'el tramo mide unos 100 km')
  for (const modelo of [byDefault, WGS84]) {
    const m = count(modelo, a[0], a[1], b[0], b[1])
    assert.ok(m >= 35 && m <= 45, `${m} tramos`)
  }
  const m = count(byDefault, a[0], a[1], b[0], b[1])
  assert.ok(separacion(a, b, curvar(byDefault, a, b)) <= GROUND * 1.0001, 'con los tramos que da, la cuerda cumple 0,1 m')
  assert.ok(separacion(a, b, curvar(byDefault, a, b, Math.ceil(m / 2))) > GROUND, 'con la mitad ya no cumple')
  assert.ok(separacion(a, b, [a, b]) > 100, 'sin partir, la recta de Mercator se aparta decenas de metros')
})

test('la cuerda se aparta de la geodésica a lo más 0,1 m, a cualquier latitud y largo, en cada hemisferio y entre ellos', () => {
  const tabla = [
    [[0, 0], [8, 1]], [[-4, 10], [4, 12]], [[-30, 160], [-29, 170]], [[70, -100], [72, -90]],
    [[6, 0], [-2, 3]], [[0, 0], [0, 5]], [[0, 0], [5, 0.01]], [[-80, 0], [-79, 30]], [[55, 5], [52, 17]],
    [[40.7, -74], [51.5, 0]], [[-62.2, -110.66], [-67.92, -7.63]],
  ]
  for (const [a, b] of tabla) {
    const m = count(byDefault, a[0], a[1], b[0], b[1])
    assert.ok(m < 4096, `${a} → ${b} no llega al tope`)
    assert.ok(separacion(a, b, curvar(byDefault, a, b, m)) <= GROUND * 1.0001, `${a} → ${b}, ${m} tramos`)
  }
})

test('pasados los 80°, la geodésica sube sobre sus extremos y la cuenta va con la latitud de su vértice', () => {
  for (const [a, b] of [[[83.0358, 111.2886], [83.4653, 193.6014]], [[-79.8609, -139.2851], [-79.8405, -189.6906]]]) {
    const m       = count(byDefault, a[0], a[1], b[0], b[1])
    const ingenua = stepsFor(hav(a, b), Math.max(Math.abs(a[0]), Math.abs(b[0])), GROUND)
    assert.ok(separacion(a, b, curvar(byDefault, a, b, m)) <= GROUND * 1.0001, `${a} → ${b}, ${m} tramos`)
    assert.ok(separacion(a, b, curvar(byDefault, a, b, ingenua)) > GROUND * 1.05, `con la latitud de los extremos, ${ingenua}`)
  }
})

test('la cuenta no depende del radio: con otra esfera la cuerda también queda a 0,1 m, medida en ella', () => {
  const [a, b] = [[60, -10], [65, 8]]
  for (const r of [1737400, 2 * R]) {
    const m = count(sphere(r), a[0], a[1], b[0], b[1])
    assert.ok(separacion(a, b, curvar(sphere(r), a, b, m), r) <= GROUND * 1.0001, `radio ${r}, ${m} tramos`)
    assert.ok(separacion(a, b, curvar(sphere(r), a, b, Math.ceil(m * 0.9)), r) > GROUND, 'con menos no alcanza')
  }
})

test('junto a un polo la cuenta se corta en la latitud de la proyección, y un meridiano no se parte', () => {
  assert.deepEqual(geodesic([[89.99, 0], [89.99, 10]]), [[[89.99, 0], [89.99, 10]]], 'un paso de 200 m en el borde')
  assert.deepEqual(geodesic([[90, 0], [89.99999, 0]]), [[[90, 0], [89.99999, 0]]], 'un vértice en el polo')
  for (const [a, b] of [[[-60, 20], [70, 20]], [[90, 0], [-89.9999, 0]]]) {
    assert.equal(count(byDefault, a[0], a[1], b[0], b[1]), 1, `${a} → ${b}`)
    assert.equal(count(WGS84, a[0], a[1], b[0], b[1]), 1)
  }
  assert.ok(separacion([-60, 20], [70, 20], [[-60, 20], [70, 20]]) < 1e-6, 'la recta de Mercator es el meridiano')
})

test('el prefiltro no cambia la cuenta, también al borde del umbral y sobre el elipsoide', () => {
  for (const modelo of [byDefault, WGS84]) {
    for (let i = 0; i < 3000; i++) {
      const a      = [(azar() * 2 - 1) * 85, azar() * 360 - 180]
      const umbral = Math.sqrt(8 * R * GROUND / Math.tan(Math.max(Math.abs(a[0]), 1) * RAD))
      const b      = destino(a, azar() * 360, umbral * (0.9 + azar() * 0.2))
      if (Math.abs(b[0]) > 85) continue
      assert.equal(count(modelo, a[0], a[1], b[0], b[1]), cuenta(modelo, a, b), `${a} → ${b}`)
    }
  }
  // Casi un meridiano a 70°: el arco del elipsoide mide 0,3 % más que el de la esfera media, y la cota del
  // prefiltro tiene que cubrirlo.
  const [a, b] = [[70, 10], [70.012225, 10.0000001]]
  assert.equal(cuenta(WGS84, a, b), 2)
  assert.equal(count(WGS84, a[0], a[1], b[0], b[1]), 2)
  // Un paralelo junto al ecuador: la geodésica sube 1 % sobre sus extremos, y la latitud del prefiltro también
  // tiene que cubrirlo.
  const [c, d] = [[0.0001, 0], [0.0001, 15.3]]
  assert.equal(cuenta(byDefault, c, d), 2)
  assert.equal(count(byDefault, c[0], c[1], d[0], d[1]), 2)
})

test('un tramo de más de media vuelta de longitud no se toca, y uno de exactamente media sí se curva', () => {
  assert.equal(count(byDefault, 10, 170, 10, -170), 1, 'el consumidor eligió el lado largo')
  assert.equal(count(byDefault, 10, 170, 40, -100), 1)
  assert.ok(count(byDefault, 10, 170, 10, 190) > 1, 'por el antimeridiano pero por el lado corto')
  assert.ok(count(byDefault, 30, 0, 30, 180) > 1, 'media vuelta que no es entre antípodas, por el polo')
  const largo = [[10, 170], [10, -170]]
  assert.deepEqual(geodesic(largo), [largo])
})

test('los antípodas no tienen una geodésica y quedan en un tramo, igual que los dos polos', () => {
  for (const [a, b] of [[[10, 0], [-10, 180]], [[0, 0], [0, 180]], [[90, 0], [-90, 30]], [[-90, 10], [90, -40]]]) {
    for (const modelo of [byDefault, WGS84]) assert.equal(count(modelo, a[0], a[1], b[0], b[1]), 1, `${a} → ${b}`)
    assert.deepEqual(geodesic([a, b]), [[a, b]])
  }
})

/* ── Dónde caen los puntos ── */

const TRAMOS = [
  [[37, 0], [37, 1.12]], [[-33.45, -70.66], [-23.65, -70.4]], [[60, -10], [48, 30]],
  [[-60, 100], [-50, 160]], [[10, 170], [20, 200]], [[-5, -179], [5, -150]], [[0, 0], [30, 45]],
]

// El punto a la fracción `t` del largo, por el problema directo desde el primero al rumbo inicial: la
// distancia a él es lineal en un desvío lateral, y no cuadrática como d(a,p) + d(p,b) − d(a,b).
const sobreEsfera    = (a, b, t) => destino(a, rumbo(a, b) / RAD, t * hav(a, b))
const sobreElipsoide = (a, b, t) => {
  const { azi1, s12 } = solver.Inverse(a[0], a[1], b[0], b[1])
  const { lat2, lon2 } = solver.Direct(a[0], a[1], azi1, t * s12)
  return [lat2, lon2]
}
const metrosElipsoide = (p, q) => solver.Inverse(p[0], p[1], q[0], q[1], DISTANCE).s12

test('en la esfera cada punto es el de la geodésica a su fracción del largo', () => {
  for (const [a, b] of TRAMOS)
    for (const modelo of [byDefault, sphere()]) {
      const m = count(modelo, a[0], a[1], b[0], b[1])
      assert.ok(m > 1)
      curvar(modelo, a, b, m).forEach((p, k) =>
        dentro(hav(p, sobreEsfera(a, b, k / m)), 0, 1e-6, `${a} → ${b}, punto ${k} de ${m}`))
    }
})

test('en el elipsoide cada punto es el de la geodésica de Karney a su fracción del largo', () => {
  for (const [a, b] of TRAMOS) {
    const m = count(WGS84, a[0], a[1], b[0], b[1])
    assert.ok(m > 1)
    curvar(WGS84, a, b, m).forEach((p, k) =>
      dentro(metrosElipsoide(p, sobreElipsoide(a, b, k / m)), 0, 1e-6, `${a} → ${b}, punto ${k} de ${m}`))
  }
})

test('at no confunde tramos ni modelos: alternarlos da el punto de cada uno', () => {
  // Cada caso cambia una sola cosa respecto del anterior.
  const casos = [
    [WGS84, [10, 0], [20, 30]], [WGS84, [10, 0], [21, 30]], [WGS84, [10, 0], [21, 31]],
    [WGS84, [11, 0], [21, 31]], [WGS84, [11, 1], [21, 31]], [sphere(), [11, 1], [21, 31]],
  ]
  for (const t of [0.25, 0.5])
    for (const [modelo, a, b] of casos) {
      const p = at(modelo, a[0], a[1], b[0], b[1], t, [0, 0])
      const lejos = modelo === WGS84 ? metrosElipsoide(p, sobreElipsoide(a, b, t)) : hav(p, sobreEsfera(a, b, t))
      dentro(lejos, 0, 1e-6, `${a} → ${b} a ${t}`)
    }
})

test('el elipsoide parte en los mismos tramos que la esfera, a uno de diferencia', () => {
  for (const [a, b] of TRAMOS) {
    const esfera = count(byDefault, a[0], a[1], b[0], b[1]), elipsoide = count(WGS84, a[0], a[1], b[0], b[1])
    assert.ok(Math.abs(esfera - elipsoide) <= Math.max(1, esfera * 0.02), `${a} → ${b}: ${esfera} contra ${elipsoide}`)
  }
})

test('el camino rápido de la esfera por defecto y la composición de las marcas dan el mismo punto', () => {
  for (const [a, b] of TRAMOS)
    for (const t of [0.1, 0.5, 0.93]) {
      const rapido = at(byDefault, a[0], a[1], b[0], b[1], t, [0, 0])
      const marcas = at(sphere(), a[0], a[1], b[0], b[1], t, [0, 0])
      dentro(hav(rapido, marcas), 0, 1e-6, `${a} → ${b} a ${t}`)
      dentro(rapido[1], marcas[1], 1e-9, 'y con la misma lng, sin envolver')
    }
})

test('la lng sigue a la del primer punto: cruzar el antimeridiano no salta, tampoco desde fuera de ±180', () => {
  for (const [a, b] of [[[10, 170], [10, 190]], [[10, 175], [30, 200]], [[10, -175], [-20, -200]], [[10, 190], [10, 170]]]) {
    const lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1])
    for (const modelo of [byDefault, WGS84]) {
      const puntos = curvar(modelo, a, b)
      assert.ok(puntos.length > 2)
      puntos.forEach(p => assert.ok(p[1] >= lo - 1e-9 && p[1] <= hi + 1e-9, `${p} fuera de [${lo}, ${hi}]`))
      puntos.slice(1).forEach((p, k) => assert.ok(Math.sign(p[1] - puntos[k][1]) === Math.sign(b[1] - a[1]), 'monótona'))
    }
  }
})

test('media vuelta de lng por el polo: los puntos son finitos y siguen la geodésica', () => {
  const a = [30, 0], b = [30, 180]
  const m = count(byDefault, 30, 0, 30, 180)
  curvar(byDefault, a, b, m).forEach((p, k) => {
    assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]), `punto ${k}`)
    dentro(hav(p, sobreEsfera(a, b, k / m)), 0, 1e-6, `punto ${k}`)
  })
})

/* ── geodesic ── */

test('geodesic conserva los puntos de entrada y curva cada tramo largo, también el de cierre de un anillo', () => {
  const a = [0, 0], b = [0, 3], c = [40, 3]
  const [curvo] = geodesic([a, b, c, a])
  assert.deepEqual([curvo[0], curvo.at(-1)], [a, a])
  for (const v of [b, c]) assert.ok(curvo.some(p => p[0] === v[0] && p[1] === v[1]), `${v} se conserva`)
  assert.ok(curvo.length > 4 + 100, 'los tramos largos se partieron, el del ecuador no')
  assert.equal(curvo.filter(p => p[0] === 0).length, 3, 'el ecuador es una geodésica: su tramo no se parte')
  const cierre = curvo.slice(curvo.findIndex(p => p[0] === 40 && p[1] === 3))
  assert.ok(cierre.length > 2, 'la arista de cierre c → a se partió')
  cierre.forEach(p => dentro(alCirculo(c, a, p), 0, 1e-6, 'sobre la geodésica de c a a'))
})

test('geodesic parte como toParts: un vértice que no es punto corta, lo anidado son partes, y no trae las de un vértice', () => {
  const larga = (lat, lng0) => [[lat, lng0], [lat, lng0 + 2]]
  const plano = [...larga(10, 0), [NaN, NaN], ...larga(50, 0), [NaN, NaN], [7, 7]]
  const salida = geodesic(plano)
  assert.equal(salida.length, 2, 'dos partes, la de un vértice no sale')
  assert.deepEqual(salida.map(p => [p[0], p.at(-1)]), [[[10, 0], [10, 2]], [[50, 0], [50, 2]]])
  assert.deepEqual(geodesic([larga(10, 0), larga(50, 0)]).map(p => p.length), salida.map(p => p.length), 'lo anidado da lo mismo')
  assert.deepEqual(geodesic([new Float64Array([10, 0]), new Float64Array([10, 2])]), [salida[0]], 'vistas tipadas')
  for (const nada of [null, undefined, [], [[1, 2]], [[NaN, 1], [2, 3]]]) assert.deepEqual(geodesic(nada), [])
})

test('geodesic parte con el modelo que se le pasa, y los puntos siguen siendo los de la geodésica', () => {
  const path  = [[37, 0], [37, 1.12]]
  const doble = geodesic(sphere(2 * R), path)[0]
  assert.ok(separacion(...path, doble, 2 * R) <= GROUND * 1.0001, `${doble.length - 1} tramos sobre la esfera del doble de radio`)
  doble.forEach(p => dentro(alCirculo(path[0], path[1], p), 0, 1e-6, 'sobre la geodésica'))
})

test('geodesic no retiene ni toca la entrada, y devuelve pares propios', () => {
  const entrada = [[10, 0], [10, 2]]
  const copia   = structuredClone(entrada)
  const [parte] = geodesic(entrada)
  assert.deepEqual(entrada, copia)
  parte[0][0] = 99
  assert.deepEqual(entrada, copia, 'el par de salida no es el de la entrada')
})

test('el modelo va primero y construido; con dos argumentos el primero tiene que serlo', () => {
  const path = [[10, 0], [10, 2]]
  for (const llamar of [
    () => geodesic(sphere, path), () => geodesic(sphere(), sphere(), path), () => geodesic(sphere(), path, path),
    () => geodesic(sphere()), () => geodesic(path, sphere()), () => geodesic(null, path), () => geodesic(() => path),
  ]) assert.throws(llamar, { name: 'TypeError', message: /recibe \(model\?, path\)/ })
})

test('un modelo que no ubica destinos o rumbos lanza TypeError: sirve para medir, no para curvar', () => {
  const sinDestino = { [MODEL]: () => 0, [HEADING]: () => 0 }
  const sinRumbo   = { [MODEL]: () => 0, [DESTINATION]: (lat, lng, h, m, out) => out }
  assert.throws(() => geodesic(sinDestino, [[0, 0], [0, 1]]), { name: 'TypeError', message: '[geodesic] este modelo no ubica destinos' })
  assert.throws(() => geodesic(sinRumbo, [[0, 0], [0, 1]]), { name: 'TypeError', message: '[geodesic] este modelo no ubica rumbos' })
  assert.throws(() => geodesic(sinRumbo, null), { name: 'TypeError' }, 'también con un path ausente')
})

test('un modelo de otra implementación con las tres marcas curva el path', () => {
  const plano = {
    [MODEL]       : (lat1, lng1, lat2, lng2) => Math.hypot(lat2 - lat1, lng2 - lng1) * 111000,
    [HEADING]     : (lat1, lng1, lat2, lng2) => Math.atan2(lng2 - lng1, lat2 - lat1) / RAD,
    [DESTINATION] : (lat, lng, heading, metros, out) => {
      out[0] = lat + metros * Math.cos(heading * RAD) / 111000
      out[1] = lng + metros * Math.sin(heading * RAD) / 111000
      return out
    },
  }
  const [parte] = geodesic(plano, [[60, 0], [60, 50]])
  assert.ok(parte.length > 2)
  parte.forEach(p => dentro(p[0], 60, 1e-9, 'en un plano la geodésica es la recta'))
})

/* ── El hit sobre un path curvado ── */

test('nearest con src devuelve el vértice de la ENTRADA que abre el tramo, no el del path denso', () => {
  const entrada = [[0, 0], [0, 1], [NaN, NaN], [20, 0], [25, 12], [25, 40]]
  const partes  = toParts(entrada).map(({ path, from }) => {
    const denso = [path[0]], src = []
    path.slice(1).forEach((q, i) => {
      const m = count(byDefault, ...path[i], ...q)
      for (let k = 1; k <= m; k++) {
        denso.push(k < m ? at(byDefault, ...path[i], ...q, k / m, [0, 0]) : q)
        src.push(from + i)
      }
    })
    assert.equal(src.length, denso.length - 1, 'un src por tramo del path denso')
    return { from, path: denso, src }
  })
  assert.ok(partes[1].path.length > 3 + 30, 'la segunda parte se densificó')
  const indice = {
    stale  : true,
    sorted : partes.map(({ path, src }, partIndex) => {
      const pts = path.map(([lat, lng]) => ({ x: projX0(lng), y: projY0(lat) }))
      const xs  = pts.map(p => p.x), ys = pts.map(p => p.y)
      return { id: 'ruta', partIndex, src, pts, bbox: { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) } }
    }),
  }
  const [segmentoLargo, ultimo] = [[[20, 0], [25, 12]], [[25, 12], [25, 40]]]
  const primero = 0.5 / count(byDefault, ...ultimo[0], ...ultimo[1])
  const final   = 1 - 0.5 / count(byDefault, ...segmentoLargo[0], ...segmentoLargo[1])
  for (const [esperado, [a, b], t] of [[3, segmentoLargo, 0.5], [3, segmentoLargo, final], [4, ultimo, 0.5], [4, ultimo, primero]]) {
    const punto = at(byDefault, ...a, ...b, t, [0, 0])
    const [hit, ...resto] = nearest(punto[0], punto[1], indice, 0.01)
    assert.equal(resto.length, 0)
    assert.equal(hit.vertexIndex, esperado, `el punto a ${t} de ${a} → ${b} pertenece al tramo que abre el vértice ${esperado} de la entrada`)
    assert.equal(hit.partIndex, 1)
  }
  const [recto] = nearest(0, 0.5, indice, 0.01)
  assert.equal(recto.vertexIndex, 0, 'la primera parte, sin cortes, abre en 0')
})
