// Formas en metros (geometry/shape.js) y su densidad (geometry/density.js). Las referencias son
// independientes del módulo: la geographiclib directa para medir cada vértice desde el centro, y las
// fórmulas cerradas de la esfera —el polígono regular inscrito en un casquete, con su perímetro y su área
// exactos, y la flecha de su cuerda—. Contrastar contra el mismo destino que usa el generador daría un test
// que se auto-cumple.
// Corre con: node --test test/geometry/shape.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import geographiclib from 'geographiclib-geodesic'
import { area, perimeter } from '../../src/geometry/measure.js'
import { sphere } from '../../src/geometry/geodesic.js'
import { ellipsoid, WGS84 } from '../../src/geometry/ellipsoid.js'
import { arc, reachesPole, readShape, ring, sizeShape, writeShape } from '../../src/geometry/shape.js'
import { GROUND, segmentsFor, stepsFor, viewTolerance } from '../../src/geometry/density.js'

const MODEL       = Symbol.for('cristae.geometry.model')
const DESTINATION = Symbol.for('cristae.geometry.destination')

const R   = 6371008.8                  // radio medio IUGG R1 (m)
const RAD = Math.PI / 180

const { Geodesic, DISTANCE, AZIMUTH, LATITUDE, LONGITUDE, LONG_UNROLL } = geographiclib.Geodesic
const SOLVERS = {
  esfera : new Geodesic(R, 0),
  wgs84  : new Geodesic(6378137, 0.0033528106647474805),
  plano  : new Geodesic(6378137, 0.1),
}
const MODELOS = { esfera: sphere(), wgs84: WGS84, plano: ellipsoid(6378137, 0.1) }

const cerca = (real, ref, tol, msg) =>
  assert.ok(Math.abs(real - ref) <= tol * Math.abs(ref), `${msg}: ${real} vs ${ref}`)
const dentro = (real, ref, tol, msg) =>
  assert.ok(Math.abs(real - ref) <= tol, `${msg}: ${real} vs ${ref} (±${tol})`)
// Un ángulo, como la diferencia con la referencia en (-180, 180].
const giro = (grados, ref = 0) => ((grados - ref) % 360 + 540) % 360 - 180

// Cada vértice [lat, lng] visto desde el centro por el problema inverso de la geographiclib: la
// distancia y el rumbo con que llega, que son las coordenadas polares con que el generador lo colocó.
const polar = (solver, centro, p) => {
  const { s12, azi1 } = solver.Inverse(centro[0], centro[1], p[0], p[1], DISTANCE | AZIMUTH)
  return { s: s12, azi: azi1 }
}

// El polígono regular de n lados inscrito en el círculo de radio angular ρ de una esfera de radio `radio`:
// cada lado mide 2·asin(sin ρ · sin(π/n)) y cada uno de los n triángulos centro–vértice–vértice, de lados ρ
// y ρ con el ángulo `C` entre ellos, tiene el exceso 2·atan(T² sin C / (1 + T² cos C)), con T = tan(ρ/2).
const inscrito = (radio, metros, n, sector = 2 * Math.PI) => {
  const rho = metros / radio
  const T2  = Math.tan(rho / 2) ** 2
  const C   = sector / n
  return {
    perimetro : n * radio * 2 * Math.asin(Math.sin(rho) * Math.sin(Math.PI / n)),
    area      : n * radio * radio * 2 * Math.atan(T2 * Math.sin(C) / (1 + T2 * Math.cos(C))),
  }
}

// La flecha de la cuerda de un círculo de n lados sobre la esfera: ρ − ρm, con tan ρm = tan ρ · cos(π/n)
// (el triángulo rectángulo entre el centro, el pie de la cuerda y un vértice).
const flecha = (metros, n) => R * (metros / R - Math.atan(Math.tan(metros / R) * Math.cos(Math.PI / n)))

// El radio de la elipse de semiejes `a` (sobre el rumbo) y `b` en la dirección polar φ, en grados.
const rho = (a, b, phi) => a * b / Math.hypot(b * Math.cos(phi * RAD), a * Math.sin(phi * RAD))

const CENTRO = [-33.45, -70.66]

/* ── Círculo ── */

// El perímetro y el área de la forma colocada son los del polígono regular inscrito, y se miden con las
// mismas `perimeter` y `area` que miden cualquier zona. La esfera por defecto va por el camino rápido, los
// otros radios por la marca de destino; el centro sobre el polo y junto a él cubren donde las dos se rompen.
// El área de un anillo que rodea un polo se calcula como 2π menos el exceso, y pierde esos dígitos (~1e-8 de
// lo medido a 1 km): ahí el área se compara a 1e-6, y la distancia de cada vértice, que no los pierde, a
// 10 µm (el camino rápido pierde 6 µm a 1 km de un polo).
for (const [lat, lng, radio, tolerancia] of [
  [0, 0, 500, 1e-8], [-33.45, -70.66, 500, 1e-8], [60, 25, 50_000, 1e-8], [80, 10, 100_000, 1e-8],
  [-45, 170, 2_000_000, 1e-8], [89.99, 10, 500, 1e-7], [89.9999, 10, 500, 1e-6], [90, 0, 1000, 1e-6],
  [-90, 33, 50_000, 1e-6],
]) {
  test(`el círculo de ${radio} m en (${lat}, ${lng}) es el polígono regular inscrito de la esfera`, () => {
    const vertices = ring({ center: [lat, lng], radius: radio })
    const esperado = inscrito(R, radio, vertices.length)
    cerca(perimeter(vertices), esperado.perimetro, 1e-9, 'perímetro')
    cerca(area(vertices), esperado.area, tolerancia, 'área')
    vertices.forEach((p, i) =>
      dentro(polar(SOLVERS.esfera, [lat, lng], p).s, radio, 1e-5, `distancia del vértice ${i}`))
  })
}

test('otra esfera da el círculo con su radio, y sphere() es el defecto sin ser la misma instancia', () => {
  const forma = { center: [10, 20], radius: 2000 }
  for (const radio of [1e5, 6371008.8, 1e7]) {
    const vertices = ring(sphere(radio), forma)
    const regular  = inscrito(radio, 2000, vertices.length)
    cerca(perimeter(sphere(radio), vertices), regular.perimetro, 1e-9, `perímetro a ${radio}`)
    cerca(area(sphere(radio), vertices), regular.area, 1e-8, `área a ${radio}`)
  }
  const rapido = ring(forma)
  const marca  = ring(sphere(), forma)
  assert.equal(marca.length, rapido.length)
  marca.forEach((p, i) => {
    dentro(p[0], rapido[i][0], 1e-9, `lat ${i}`)
    dentro(p[1], rapido[i][1], 1e-9, `lng ${i}`)
  })
})

// Cada vértice está a `radius` metros del centro, y a `i·360/n` grados de rumbo desde el norte, medidos
// con el problema inverso del propio modelo: el sentido es horario y el vértice 0 va al norte.
for (const [nombre, modelo] of Object.entries(MODELOS)) {
  test(`${nombre}: cada vértice del círculo está a radius metros y a i·360/n grados del norte`, () => {
    for (const [centro, radio] of [[CENTRO, 500], [[60, 25], 20_000], [[-5, 179.99], 3000]]) {
      const vertices = ring(modelo, { center: centro, radius: radio })
      vertices.forEach((p, i) => {
        const { s, azi } = polar(SOLVERS[nombre], centro, p)
        dentro(s, radio, 1e-6, `distancia del vértice ${i}`)
        dentro(giro(azi, i * 360 / vertices.length), 0, 1e-8, `rumbo del vértice ${i}`)
      })
    }
  })
}

test('el círculo no lee heading: ni lo usa ni lo valida', () => {
  const base = ring({ center: CENTRO, radius: 700 })
  assert.deepEqual(ring({ center: CENTRO, radius: 700, heading: 77 }), base)
  assert.deepEqual(ring({ center: CENTRO, radius: 700, heading: NaN }), base)
  assert.deepEqual(ring({ center: CENTRO, radius: 700, sweep: 360, heading: 77 }), base)
})

// La flecha de la cuerda no pasa de la tolerancia sin vista, y con la mitad de vértices sí pasaría: n es
// la menor potencia de dos que cumple. Con 16 vértices de piso, un radio chico sólo cumple lo primero.
test('el círculo tiene la menor potencia de dos de vértices con la cuerda a 0,1 m del arco', () => {
  for (const radio of [50, 500, 5000, 100_000]) {
    const n = ring({ center: CENTRO, radius: radio }).length
    assert.ok(flecha(radio, n) <= GROUND, `${radio} m con ${n}: ${flecha(radio, n)}`)
    assert.ok(flecha(radio, n / 2) > GROUND, `${radio} m con ${n / 2} ya cumplía`)
  }
  assert.equal(ring({ center: CENTRO, radius: 1 }).length, 16)
  assert.equal(ring({ center: CENTRO, radius: 1e6 }).length, 4096)
})

test('un círculo junto al antimeridiano y con la lng fuera de ±180 sigue la lng del centro, sin saltos', () => {
  for (const modelo of [sphere(), WGS84]) {
    for (const lng of [179.9999, -179.9999, 540, -540.5]) {
      const lngs = ring(modelo, { center: [10, lng], radius: 2000 }).map(p => p[1])
      assert.ok(lngs.every((x, i) => Math.abs(x - lngs[(i + 1) % lngs.length]) < 0.01), `salto en ${lng}`)
      assert.ok(Math.min(...lngs) < lng && Math.max(...lngs) > lng, `rodea a ${lng}`)
    }
  }
})

/* ── Elipse ── */

// Cada vértice es el destino a `heading + atan2(v, u)` y `hypot(u, v)` metros, con u = a·cos t y v = b·sin t:
// medido desde el centro está a ρ(θ) metros, sobre la elipse, y su anomalía excéntrica es i·2π/n. El
// vértice 0 va en `heading`, a `a` metros, y no hace falta que a ≥ b.
for (const [nombre, modelo] of Object.entries(MODELOS)) {
  test(`${nombre}: cada vértice de la elipse está a ρ(θ) del centro, con la anomalía excéntrica uniforme`, () => {
    for (const [a, b, heading] of [[800, 300, 45], [300, 800, 0], [1500, 1400, 200], [600, 100, -30]]) {
      const vertices = ring(modelo, { center: CENTRO, radius: [a, b], heading })
      vertices.forEach((p, i) => {
        const { s, azi } = polar(SOLVERS[nombre], CENTRO, p)
        const phi = giro(azi, heading)
        dentro(s, rho(a, b, phi), 1e-6, `radio del vértice ${i}`)
        const t = Math.atan2(s * Math.sin(phi * RAD) / b, s * Math.cos(phi * RAD) / a)
        dentro(giro(t / RAD, i * 360 / vertices.length), 0, 1e-7, `anomalía del vértice ${i}`)
      })
      const cero = polar(SOLVERS[nombre], CENTRO, vertices[0])
      dentro(cero.s, a, 1e-6, 'el vértice 0 está a `a` metros')
      dentro(giro(cero.azi, heading), 0, 1e-8, 'y en heading')
    }
  })
}

test('la elipse gira con heading, y una elipse de semiejes iguales es el círculo con el vértice 0 en heading', () => {
  const gira = ring({ center: CENTRO, radius: [900, 400], heading: 30 })
  const norte = ring({ center: CENTRO, radius: [900, 400] })
  assert.equal(gira.length, norte.length)
  assert.notDeepEqual(gira[0], norte[0])
  const redonda = ring({ center: CENTRO, radius: [700, 700], heading: 90 })
  assert.equal(redonda.length, ring({ center: CENTRO, radius: 700 }).length)
  dentro(giro(polar(SOLVERS.esfera, CENTRO, redonda[0]).azi, 90), 0, 1e-8, 'parte al este')
})

/* ── Sector ── */

// Un sector es [centro, radio, arco, radio]: el centro, los m vértices del borde izquierdo hasta el arco, el
// arco y los m − 1 del borde derecho de vuelta, así que sus S tramos son N − 2m. m se cuenta en el anillo:
// los vértices que siguen al centro sobre el rumbo del borde izquierdo, medido con la geographiclib.
const partesDe = (solver, forma, vertices) => {
  const izquierdo = forma.heading - forma.sweep / 2
  let m = 1
  while (Math.abs(giro(polar(solver, forma.center, vertices[m + 1]).azi, izquierdo)) < 1e-6) m++
  return { S: vertices.length - 2 * m, m }
}

for (const [nombre, modelo] of Object.entries(MODELOS)) {
  test(`${nombre}: el sector de círculo parte del centro, sus radios van sobre la geodésica y el arco es de radius`, () => {
    for (const [heading, sweep] of [[0, 60], [110, 45], [90, 100], [225, 180], [30, 270], [350, 350]]) {
      const forma    = { center: CENTRO, radius: 4000, heading, sweep }
      const vertices = ring(modelo, forma)
      const { S, m } = partesDe(SOLVERS[nombre], forma, vertices)
      assert.equal(S, Math.ceil(ring(modelo, { center: CENTRO, radius: 4000 }).length * sweep / 360), 'el arco')
      assert.deepEqual(vertices[0], CENTRO)
      for (let k = 1; k <= m; k++) {
        const ida = polar(SOLVERS[nombre], CENTRO, vertices[k])
        dentro(ida.s, 4000 * k / m, 1e-6, `radio izquierdo ${k}`)
        dentro(giro(ida.azi, heading - sweep / 2), 0, 1e-8, `rumbo izquierdo ${k}`)
        const vuelta = polar(SOLVERS[nombre], CENTRO, vertices[vertices.length - k])
        if (k < m) {
          dentro(vuelta.s, 4000 * k / m, 1e-6, `radio derecho ${k}`)
          dentro(giro(vuelta.azi, heading + sweep / 2), 0, 1e-8, `rumbo derecho ${k}`)
        }
      }
      for (let j = 0; j <= S; j++) {
        const p = polar(SOLVERS[nombre], CENTRO, vertices[m + j])
        dentro(p.s, 4000, 1e-6, `arco ${j}`)
        dentro(giro(p.azi, heading - sweep / 2 + sweep * j / S), 0, 1e-8, `rumbo del arco ${j}`)
      }
    }
  })
}

test('el área del sector de círculo es la de la suma de triángulos centro–vértice–vértice, también si es reflejo', () => {
  for (const [sweep, radio] of [[60, 4000], [100, 4000], [180, 4000], [270, 4000], [350, 1000]]) {
    const forma    = { center: CENTRO, radius: radio, heading: 40, sweep }
    const vertices = ring(forma)
    const { S }    = partesDe(SOLVERS.esfera, forma, vertices)
    cerca(area(vertices), inscrito(R, radio, S, sweep * RAD).area, 1e-8, `sweep ${sweep}`)
  }
})

test('el sector con la apertura entera, o más, es la figura entera', () => {
  for (const radius of [900, [900, 400]]) {
    const entera = ring({ center: CENTRO, radius, heading: 20 })
    for (const sweep of [360, 361, 720, 1e9])
      assert.deepEqual(ring({ center: CENTRO, radius, heading: 20, sweep }), entera, `sweep ${sweep}`)
    assert.deepEqual(ring({ center: CENTRO, radius, heading: 20, sweep: null }), entera)
    assert.notDeepEqual(ring({ center: CENTRO, radius, heading: 20, sweep: 359 }), entera)
  }
})

test('el sector es simétrico respecto de heading: el espejo por el meridiano del centro lo lleva al sector reflejado', () => {
  const [lat0, lng0] = [0, 10]
  const dir  = ring({ center: [lat0, lng0], radius: 3000, heading: 30, sweep: 100 })
  const esp  = ring({ center: [lat0, lng0], radius: 3000, heading: -30, sweep: 100 })
  assert.equal(esp.length, dir.length)
  dir.forEach((p, i) => {
    const q = esp[(esp.length - i) % esp.length]
    dentro(q[0], p[0], 1e-9, `lat ${i}`)
    dentro(q[1], 2 * lng0 - p[1], 1e-9, `lng ${i}`)
  })
})

// El sector de elipse pasa el ángulo polar a paramétrico: sus dos radios, a ± sweep/2 de heading, miden
// ρ(±sweep/2) y el arco es la elipse con t uniforme entre ±t1, con t1 = atan2(a·sin(sweep/2), b·cos(sweep/2)).
for (const [nombre, modelo] of Object.entries(MODELOS)) {
  test(`${nombre}: el sector de elipse tiene sus radios en el ángulo polar y el arco sobre la elipse`, () => {
    for (const [a, b, heading, sweep] of [[1500, 600, 40, 70], [500, 1800, 300, 200], [2000, 700, 0, 330]]) {
      const forma    = { center: CENTRO, radius: [a, b], heading, sweep }
      const vertices = ring(modelo, forma)
      const { S, m } = partesDe(SOLVERS[nombre], forma, vertices)
      const largo    = rho(a, b, sweep / 2)
      assert.deepEqual(vertices[0], CENTRO)
      for (let k = 1; k < m; k++) {
        const ida = polar(SOLVERS[nombre], CENTRO, vertices[k])
        dentro(ida.s, largo * k / m, 1e-6, `radio ${k}`)
        dentro(giro(ida.azi, heading - sweep / 2), 0, 1e-8, `rumbo ${k}`)
      }
      const t1 = Math.atan2(a * Math.sin(sweep / 2 * RAD), b * Math.cos(sweep / 2 * RAD))
      for (let j = 0; j <= S; j++) {
        const { s, azi } = polar(SOLVERS[nombre], CENTRO, vertices[m + j])
        const phi = giro(azi, heading)
        dentro(s, rho(a, b, phi), 1e-6, `arco ${j} sobre la elipse`)
        const t = Math.atan2(s * Math.sin(phi * RAD) / b, s * Math.cos(phi * RAD) / a)
        dentro(t, -t1 + 2 * t1 * j / S, 1e-8, `anomalía del arco ${j}`)
      }
      dentro(polar(SOLVERS[nombre], CENTRO, vertices[m]).s, largo, 1e-6, 'el arco parte donde acaba el radio')
    }
  })
}

// La flecha de cada cuerda contra la elipse verdadera, por fuerza bruta. Cada vértice pasa al marco de la
// forma con su distancia y su rumbo desde el centro según la geographiclib —u sobre heading, v de través—,
// donde el borde es (a·cos t, b·sin t); entre dos vértices se muestrea la elipse de la anomalía de uno a la
// del otro y se toma la mayor distancia a la cuerda. `paso` toma uno de cada tantos vértices, y el último.
const flechaDeElipse = (solver, forma, vertices, paso = 1) => {
  const [a, b] = forma.radius
  const marco  = vertices.map(p => {
    const { s, azi } = polar(solver, forma.center, p)
    const phi = (azi - (forma.heading ?? 0)) * RAD
    return { u: s * Math.cos(phi), v: s * Math.sin(phi), t: Math.atan2(s * Math.sin(phi) / b, s * Math.cos(phi) / a) }
  })
  const tomados = marco.filter((_, i) => i % paso === 0 || i === marco.length - 1)
  let peor = 0
  for (let i = 0; i + 1 < tomados.length; i++) {
    const p  = tomados[i], q = tomados[i + 1]
    const du = q.u - p.u, dv = q.v - p.v, largo = Math.hypot(du, dv)
    const dt = giro((q.t - p.t) / RAD) * RAD
    for (let k = 1; k < 64; k++) {
      const t = p.t + dt * k / 64
      peor = Math.max(peor, Math.abs((a * Math.cos(t) - p.u) * dv - (b * Math.sin(t) - p.v) * du) / largo)
    }
  }
  return peor
}

// Con t uniforme, la flecha máxima de la elipse es la del círculo de su semieje mayor, así que los n vértices
// de ese círculo la dejan a 0,1 m. El arco de un sector recorre 2·t1 de anomalía, y no sweep: sus tramos se
// cuentan por la anomalía, y la cuerda tampoco se aparta del borde más de 0,1 m. Con la mitad de tramos ya no
// cumple donde la flecha es la del semieje mayor.
for (const [nombre, modelo] of [['esfera', sphere()], ['wgs84', WGS84]]) {
  test(`${nombre}: la cuerda de la elipse y del arco de un sector de elipse no se aparta del borde más de 0,1 m`, () => {
    for (const forma of [
      { center: CENTRO, radius: [2000, 200] }, { center: CENTRO, radius: [5000, 200], heading: 30 },
      { center: CENTRO, radius: [300, 800] }, { center: CENTRO, radius: [2000, 200], sweep: 10 },
      { center: CENTRO, radius: [5000, 500], heading: 20, sweep: 20 },
      { center: CENTRO, radius: [2000, 700], heading: 300, sweep: 60 },
      { center: CENTRO, radius: [1000, 100], heading: 90, sweep: 30 },
      { center: CENTRO, radius: [300, 1500], heading: 45, sweep: 90 },
    ]) {
      const vertices = arc(modelo, forma)
      const flecha   = flechaDeElipse(SOLVERS[nombre], forma, vertices)
      assert.ok(flecha <= GROUND, `${JSON.stringify(forma)}: ${flecha} m con ${vertices.length - 1} tramos`)
      if (forma.radius[0] > forma.radius[1]) {
        const mitad = flechaDeElipse(SOLVERS[nombre], forma, vertices, 2)
        assert.ok(mitad > GROUND, `${JSON.stringify(forma)}: con la mitad, ${mitad} m`)
      }
    }
  })
}

// Los radios de un sector son geodésicas, que en Mercator se curvan: se parten en tramos para que la
// polilínea recta no se aparta del radio más de la tolerancia sin vista. Se mide con una geodésica muestreada
// densamente, en el plano de Mercator y con la escala de cada latitud.
test('los radios de un sector siguen la geodésica en Mercator a menos de 0,1 m, y un solo tramo no', () => {
  const centro = [60, 10]
  const radio  = 30_000
  const heading = 45
  const mercator = ([lat, lng]) => [lng * RAD, Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2))]
  const aSegmento = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const t  = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
  }
  const geodesica = Array.from({ length: 601 }, (_, i) => {
    const to = SOLVERS.esfera.Direct(centro[0], centro[1], heading, radio * i / 600, LATITUDE | LONGITUDE | LONG_UNROLL)
    return mercator([to.lat2, to.lon2])
  })
  const desvio = camino => {
    let peor = 0
    for (let i = 0; i + 1 < camino.length; i++)
      for (let t = 0.05; t < 1; t += 0.05) {
        const p = camino[i].map((x, k) => x + t * (camino[i + 1][k] - x))
        const lat = 2 * Math.atan(Math.exp(p[1])) - Math.PI / 2
        const d = Math.min(...geodesica.slice(0, -1).map((g, j) => aSegmento(p, g, geodesica[j + 1])))
        peor = Math.max(peor, d * R * Math.cos(lat))
      }
    return peor
  }
  const forma    = { center: centro, radius: radio, heading: heading + 25, sweep: 50 }
  const vertices = ring(forma)
  const { m }    = partesDe(SOLVERS.esfera, forma, vertices)
  assert.ok(m > 4, `radios de ${m} tramos`)
  const radioIzq = vertices.slice(0, m + 1).map(mercator)
  assert.ok(desvio(radioIzq) < GROUND, `la polilínea se aparta ${desvio(radioIzq)} m`)
  assert.ok(desvio([radioIzq[0], radioIzq[m]]) > GROUND, 'el radio sin partir sí se aparta')
})

/* ── Arco ── */

test('el arco de un sector es su borde curvo, de heading − sweep/2 a heading + sweep/2, abierto', () => {
  for (const modelo of [sphere(), WGS84]) {
    const forma    = { center: CENTRO, radius: 4000, heading: 80, sweep: 100 }
    const vertices = arc(modelo, forma)
    const n        = ring(modelo, { center: CENTRO, radius: 4000 }).length
    assert.equal(vertices.length, Math.ceil(n * 100 / 360) + 1)
    const solver = modelo === WGS84 ? SOLVERS.wgs84 : SOLVERS.esfera
    vertices.forEach((p, j) => {
      const { s, azi } = polar(solver, CENTRO, p)
      dentro(s, 4000, 1e-6, `radio ${j}`)
      dentro(giro(azi, 30 + 100 * j / (vertices.length - 1)), 0, 1e-8, `rumbo ${j}`)
    })
  }
})

test('el arco de la figura entera es el contorno cerrado: el anillo, repitiendo el primer vértice', () => {
  for (const radius of [900, [900, 400]]) {
    const forma  = { center: CENTRO, radius, heading: 20 }
    const cerrado = arc(forma)
    const anillo  = ring(forma)
    assert.equal(cerrado.length, anillo.length + 1)
    assert.deepEqual(cerrado.slice(0, -1), anillo)
    assert.deepEqual(cerrado.at(-1), cerrado[0])
    assert.deepEqual(arc({ ...forma, sweep: 360 }), cerrado)
  }
})

test('el arco de un sector son los vértices del sector entre sus dos radios', () => {
  const forma    = { center: CENTRO, radius: [3000, 1200], heading: 50, sweep: 120 }
  const sector   = ring(forma)
  const tramo    = arc(forma)
  const inicio   = sector.findIndex(p => p[0] === tramo[0][0] && p[1] === tramo[0][1])
  assert.ok(inicio >= 1)
  assert.deepEqual(sector.slice(inicio, inicio + tramo.length), tramo)
})

/* ── La regla de validez ── */

test('la regla de validez: lo ausente toma el default y un número presente que se usa y no sirve la descarta', () => {
  const ok = { center: CENTRO, radius: 500 }
  const buenas = [
    ok, { ...ok, heading: null }, { ...ok, heading: undefined, sweep: null }, { ...ok, radius: [500, 200] },
    { ...ok, radius: [500, 200], heading: 10 }, { ...ok, radius: new Float64Array([500, 200]) },
    { ...ok, heading: 10, sweep: 90 }, { ...ok, heading: -400, sweep: 1 }, { ...ok, sweep: 400 },
    { ...ok, heading: NaN }, { ...ok, heading: NaN, sweep: 360 }, { ...ok, heading: Infinity },
    { center: { lat: -33.45, lng: -70.66 }, radius: 500 }, { center: { latitude: 1, longitude: 2 }, radius: 500 },
    { center: new Float64Array([1, 2]), radius: 500 }, { center: [1, 2, 3000], radius: 500 },
  ]
  buenas.forEach((f, i) => assert.ok(ring(f).length >= 3, `la ${i} es válida: ${JSON.stringify(f)}`))
  const malas = [
    null, undefined, {}, 5, 'forma', [], { center: CENTRO }, { radius: 500 },
    { center: null, radius: 500 }, { center: [91, 0], radius: 500 }, { center: [NaN, 0], radius: 500 },
    { center: [0, Infinity], radius: 500 }, { center: ['1', '2'], radius: 500 }, { center: [1], radius: 500 },
    { ...ok, radius: 0 }, { ...ok, radius: -1 }, { ...ok, radius: NaN }, { ...ok, radius: Infinity },
    { ...ok, radius: null }, { ...ok, radius: undefined }, { ...ok, radius: '500' }, { ...ok, radius: [] },
    { ...ok, radius: [500] }, { ...ok, radius: [500, 0] }, { ...ok, radius: [0, 500] }, { ...ok, radius: [500, NaN] },
    { ...ok, radius: [Infinity, 500] }, { ...ok, radius: [500, -3] },
    { ...ok, radius: [500, 200], heading: NaN }, { ...ok, radius: [500, 200], heading: Infinity },
    { ...ok, sweep: 90, heading: NaN }, { ...ok, sweep: 0 }, { ...ok, sweep: -10 }, { ...ok, sweep: NaN },
    { ...ok, sweep: Infinity }, { ...ok, sweep: '90' },
  ]
  malas.forEach((f, i) => {
    assert.deepEqual(ring(f), [], `la ${i} se descarta: ${JSON.stringify(f)}`)
    assert.deepEqual(arc(f), [], `y su arco: ${JSON.stringify(f)}`)
  })
})

test('ring y arc no tocan ni retienen la forma', () => {
  const forma = Object.freeze({
    center: Object.freeze([...CENTRO]), radius: Object.freeze([800, 300]), heading: 10, sweep: 90,
  })
  const uno   = ring(forma)
  assert.deepEqual(ring(forma), uno)
  uno[0][0] = 0
  assert.notEqual(ring(forma)[0][0], 0)
})

/* ── El modelo ── */

test('el modelo va primero y construido; con dos argumentos el primero tiene que serlo', () => {
  const forma = { center: CENTRO, radius: 500 }
  for (const llamar of [
    () => ring(sphere, forma), () => ring(sphere(), sphere(), forma), () => ring(sphere(), forma, forma),
    () => ring(sphere()), () => ring(forma, sphere()), () => ring(1, forma), () => ring(null, forma),
    () => ring(() => forma), () => arc(sphere, forma), () => arc(forma, forma),
  ]) assert.throws(llamar, { name: 'TypeError', message: /recibe \(model\?, shape\)/ })
})

test('un modelo sin la marca de destino lanza TypeError: sirve para medir, no para colocar', () => {
  const sinDestino = { [MODEL]: (lat1, lng1, lat2, lng2) => Math.hypot(lat2 - lat1, lng2 - lng1) * 111000 }
  const forma = { center: CENTRO, radius: 500 }
  assert.throws(() => ring(sinDestino, forma), { name: 'TypeError', message: '[ring] este modelo no ubica destinos' })
  assert.throws(() => arc(sinDestino, forma), { name: 'TypeError', message: '[arc] este modelo no ubica destinos' })
  assert.throws(() => ring(sinDestino, null), { name: 'TypeError' }, 'también con una forma ausente')
})

test('un modelo de otra implementación con la marca de destino coloca la forma, sin pedir área ni rumbo', () => {
  const plano = {
    [MODEL]       : () => 0,
    [DESTINATION] : (lat, lng, heading, metros, out) => {
      out[0] = lat + metros * Math.cos(heading * RAD) / 111000
      out[1] = lng + metros * Math.sin(heading * RAD) / 111000
      return out
    },
  }
  const vertices = ring(plano, { center: [10, 20], radius: 1000, heading: 0 })
  assert.equal(vertices.length, 256)
  dentro(vertices[0][0], 10 + 1000 / 111000, 1e-12, 'el vértice 0 va al norte')
  dentro(vertices[0][1], 20, 1e-12, 'sobre la lng del centro')
  const este = ring(plano, { center: [10, 20], radius: [1000, 400], heading: 90 })[0]
  dentro(este[0], 10, 1e-12, 'a 90, la elipse parte al este')
  dentro(este[1], 20 + 1000 / 111000, 1e-12, 'a `a` metros')
})

/* ── El escritor que comparten la capa y los editores ── */

test('readShape lee la forma con la regla de validez y no retiene el centro', () => {
  const centro = { lat: 1, lng: 2 }
  const forma  = readShape({ center: centro, radius: [30, 20], heading: 15, sweep: 90 })
  centro.lat = 99
  assert.deepEqual([forma.lat, forma.lng, forma.a, forma.b, forma.heading, forma.sweep], [1, 2, 30, 20, 15, 90])
  assert.equal(readShape({ center: [1, 2], radius: 5, heading: 40 }).heading, 0, 'el círculo entero no lee heading')
  assert.equal(readShape({ center: [1, 2], radius: 5, heading: 40, sweep: 90 }).heading, 40)
  assert.equal(readShape({ center: [1, 2], radius: 5, sweep: 500 }).sweep, 360)
  assert.equal(readShape({ center: [1, 2], radius: 0 }), null)
})

// Un polo está a 90° − |lat| de distancia angular del centro: lo alcanza el borde que llega hasta ahí por
// cualquiera de los dos semiejes, sea cual sea el que apunta al norte.
test('reachesPole dice si el borde llega a un polo por el semieje mayor', () => {
  const alPolo = (90 - 89) * RAD * 6371008.8   // 111 km
  assert.equal(reachesPole(readShape({ center: [89, 0], radius: alPolo * 0.99 })), false)
  assert.equal(reachesPole(readShape({ center: [89, 0], radius: alPolo * 1.01 })), true)
  assert.equal(reachesPole(readShape({ center: [-89, 0], radius: [alPolo * 1.01, 1000] })), true)
  assert.equal(reachesPole(readShape({ center: [89, 0], radius: [1000, alPolo * 1.01], heading: 90 })), true)
  assert.equal(reachesPole(readShape({ center: [89, 0], radius: [alPolo * 0.99, 1000], sweep: 30 })), false)
})

test('sizeShape cuenta lo que writeShape escribe, que sólo toca su tramo y devuelve dónde termina', () => {
  const formas = [
    { center: CENTRO, radius: 500 }, { center: CENTRO, radius: [900, 300], heading: 20 },
    { center: CENTRO, radius: 4000, heading: 10, sweep: 120 }, { center: CENTRO, radius: [3000, 900], sweep: 250 },
  ]
  for (const modelo of [sphere(), WGS84]) {
    const leidas = formas.map(readShape)
    const total  = leidas.reduce((suma, f) => suma + sizeShape(f, 64), 0)
    const xy     = new Float64Array(total * 2 + 4).fill(-777)
    let at = 2
    leidas.forEach((f, i) => {
      const desde = at
      at = writeShape(modelo, f, xy, at)
      assert.equal(at - desde, sizeShape(f, 64) * 2, `la forma ${i}`)
    })
    assert.equal(at, total * 2 + 2)
    assert.equal(xy[0], -777)
    assert.equal(xy[1], -777)
    assert.equal(xy[total * 2 + 2], -777)
    assert.equal(xy[total * 2 + 3], -777)
  }
})

test('el escritor teselado con n segmentos escribe n vértices en la figura entera, y el centro primero en un sector', () => {
  const entera = readShape({ center: CENTRO, radius: 500 })
  assert.equal(sizeShape(entera, 32), 32)
  const sector = readShape({ center: CENTRO, radius: 500, sweep: 90 })
  const total  = sizeShape(sector, 32)
  const xy     = new Float64Array(total * 2)
  writeShape(sphere(), sector, xy, 0)
  assert.deepEqual([xy[0], xy[1]], [CENTRO[1], CENTRO[0]], 'el par es [lng, lat]')
})

/* ── La densidad ── */

// La tabla de segmentos del círculo por (latitud, radio, zoom), congelada: con `viewTolerance`, la tolerancia
// de 0,2 px vale lo que vale en metros a ese zoom.
test('viewTolerance y segmentsFor dan la tabla de segmentos del círculo por latitud, radio y zoom', () => {
  for (const [lat, radio, zoom, n] of [
    [0, 1000, 3, 16], [0, 1000, 18, 256], [0, 100_000, 22, 4096], [-33.45, 500, 15, 64], [60, 50_000, 10, 128],
    [80, 100_000, 8, 256], [45, 500_000, 5, 64], [10, 20_000, 12, 128], [-70, 2000, 17, 512], [0, 50, 20, 128],
    [85, 300_000, 4, 256], [30, 800, 16, 128], [0, 10, 10, 16], [-12, 5000, 14, 128],
  ]) assert.equal(segmentsFor(radio, viewTolerance(lat, radio, zoom)), n, `lat ${lat}, ${radio} m, zoom ${zoom}`)
})

test('segmentsFor es potencia de dos entre 16 y 4096, y no baja si la tolerancia es más fina', () => {
  let previo = 0
  for (const tolerancia of [10, 1, 0.1, 0.01, 1e-3, 1e-6, 1e-12, 1e-20]) {
    const n = segmentsFor(1000, tolerancia)
    assert.ok(Number.isInteger(Math.log2(n)) && n >= 16 && n <= 4096, `${n}`)
    assert.ok(n >= previo)
    previo = n
  }
  assert.equal(segmentsFor(1, 100), 16)
  assert.equal(segmentsFor(1e9, 1e-9), 4096)
})

// La separación máxima entre la recta de Mercator y la geodésica es L²·tan|φ| / 8R: con esa cota a mano,
// m = ⌈√(separación / tolerancia)⌉, y 1 si ya cabe.
test('stepsFor parte el tramo en ⌈√(L²·tan φ / 8R / tolerancia)⌉ y no lo parte si ya cabe', () => {
  assert.equal(stepsFor(1000, 60, 0.1), 1)       // 0,034 m
  assert.equal(stepsFor(2000, 60, 0.1), 2)       // 0,136 m → √1,36
  assert.equal(stepsFor(100_000, 45, 0.1), 45)   // 196,2 m → √1962
  assert.equal(stepsFor(30_000, 60, 0.1), 18)    // 30,6 m → √306
  assert.equal(stepsFor(30_000, 0, 0.1), 1, 'sobre el ecuador la recta de Mercator es la geodésica')
  assert.equal(stepsFor(100_000, 45, 100), 2)    // 196,2 m a 100 m
  assert.equal(stepsFor(1e7, 90, 0.1), 4096, 'junto al polo la cota diverge y se acota')
})
