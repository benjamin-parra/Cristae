// Medidas de zona (geometry/measure.js y los núcleos de área de geodesic.js y ellipsoid.js). Las
// referencias no comparten fórmula con lo que se prueba: áreas cerradas del octante, de la banda y del
// elipsoide entero; la geographiclib con f = 0 como implementación independiente de la esfera; y la
// fuerza bruta sobre todos los pares para el diámetro.
// Corre con: node --test test/geometry/measure.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import geodesic from 'geographiclib-geodesic'
import { area, perimeter, diameter } from '../../src/geometry/measure.js'
import { distance, sphere } from '../../src/geometry/geodesic.js'
import { WGS84, ellipsoid } from '../../src/geometry/ellipsoid.js'

const R     = 6371008.8                 // radio medio IUGG R1 (m)
const RAD   = Math.PI / 180
const A     = 6378137                   // semieje mayor de WGS84 (m)
const F     = 1 / 298.257223563
const E2    = F * (2 - F)
const E     = Math.sqrt(E2)
const B     = A * (1 - F)
const MODEL = Symbol.for('cristae.geometry.model')
const AREA  = Symbol.for('cristae.geometry.area')

const raiz = fileURLToPath(new URL('../../', import.meta.url))

const cerca = (real, ref, tol, msg) =>
  assert.ok(Math.abs(real - ref) <= tol * Math.abs(ref), `${msg}: ${real} vs ${ref}`)
const esNaN = (valor, msg) => assert.ok(Number.isNaN(valor), `${msg}: ${valor}`)

// La esfera de radio R1 en la geographiclib: con f = 0 resuelve el mismo problema por otro camino.
const { Geodesic }  = geodesic.Geodesic
const esferaRef     = new Geodesic(R, 0)
const elipsoideRef  = new Geodesic(A, F)
const poligonoRef   = (solver, anillo) => {
  const p = solver.Polygon(false)
  anillo.forEach(([lat, lng]) => p.AddPoint(lat, lng))
  return p.Compute(false, true)
}
const areaRef       = (solver, anillo) => Math.abs(poligonoRef(solver, anillo).area)

// mulberry32: la semilla queda escrita en el test, así que los casos son siempre los mismos.
const sembrado = semilla => () => {
  semilla = (semilla + 0x6D2B79F5) | 0
  let t = Math.imul(semilla ^ (semilla >>> 15), 1 | semilla)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// Un cuadrado de lado `lado` grados con la esquina en (lat, lng), en sentido antihorario.
const cuadrado = (lat, lng, lado) => [[lat, lng], [lat, lng + lado], [lat + lado, lng + lado], [lat + lado, lng]]

// ── área: fórmulas cerradas ──────────────────────────────────────────────────

const OCTANTE = [[0, 0], [0, 90], [90, 0]]

test('el octante mide πR²/2 en la esfera', () => {
  cerca(area(OCTANTE), Math.PI * R * R / 2, 1e-14, 'octante')
})

test('el octante de WGS84 mide un octavo del área del elipsoide', () => {
  const total = 2 * Math.PI * A * A * (1 + (1 - E2) / E * Math.atanh(E))
  cerca(area(WGS84, OCTANTE), total / 8, 1e-12, 'octante WGS84')
})

test('sphere(r) escala el área en (r/R)²', () => {
  const zona = cuadrado(-37, -73, 0.5)
  cerca(area(sphere(1000), zona), area(zona) * (1000 / R) ** 2, 1e-15, 'r = 1000')
  assert.equal(area(sphere(), zona), area(zona))
})

test('una banda de 1° × 1°, con 1 000 vértices por paralelo, contra la zona esférica y la elipsoidal', () => {
  const [sur, norte, oeste, este] = [-37, -36, -73, -72]
  const paralelo = (lat, desde, hasta) =>
    Array.from({ length: 1000 }, (_, i) => [lat, desde + (hasta - desde) * i / 999])
  const banda = [...paralelo(sur, oeste, este), ...paralelo(norte, este, oeste)]
  const dLng  = (este - oeste) * RAD
  const q     = phi => {
    const s = Math.sin(phi * RAD)
    return s / (1 - E2 * s * s) + Math.log((1 + E * s) / (1 - E * s)) / (2 * E)
  }
  cerca(area(banda), R * R * dLng * (Math.sin(norte * RAD) - Math.sin(sur * RAD)), 1e-11, 'esfera')
  cerca(area(WGS84, banda), B * B * dLng / 2 * Math.abs(q(norte) - q(sur)), 1e-11, 'WGS84')
})

// ── área: la esfera contra la geographiclib ─────────────────────────────────

test('los anillos de ±80°, en los dos sentidos y cruzando la costura, miden la región polar que encierran', () => {
  const paralelo = lat => Array.from({ length: 360 }, (_, i) => [lat, i - 180])
  for (const lat of [80, -80])
    for (const anillo of [paralelo(lat), paralelo(lat).reverse()])
      cerca(area(anillo), areaRef(esferaRef, anillo), 1e-12, `casquete a ${lat}°`)
})

// Un anillo que se superpone a sí mismo pasa de 4π de exceso: el núcleo tiene que seguir en [0, A₀/2],
// como la geographiclib, y no salir negativo.
test('un anillo recorrido siete veces y uno que retrocede por el polo quedan en [0, A₀/2], como la geographiclib', () => {
  const triangulo = [[10, -60], [10, 60], [-70, 0]]
  const retroceso = [[-90, -135], [-90, -315], [-90, -135], [-3, -315], [0, -135], [0, -45]]
  for (const anillo of [Array.from({ length: 7 }, () => triangulo).flat(), retroceso])
    cerca(area(anillo), areaRef(esferaRef, anillo), 1e-12, JSON.stringify(anillo.slice(0, 3)))
})

test('300 polígonos sembrados de 10⁻³° a 1° de radio coinciden con la geographiclib', () => {
  const azar = sembrado(20261001)
  for (let k = 0; k < 300; k++) {
    const lat     = azar() * 120 - 60
    const lng     = azar() * 360 - 180
    const radio   = 10 ** (azar() * 3 - 3)
    const lados   = 3 + Math.floor(azar() * 18)
    const angulos = Array.from({ length: lados }, () => azar() * 2 * Math.PI).sort((a, b) => a - b)
    const anillo  = angulos.map(t => {
      const r = radio * (0.5 + azar() / 2)
      return [lat + r * Math.sin(t), lng + r * Math.cos(t) / Math.cos(lat * RAD)]
    })
    cerca(area(anillo), areaRef(esferaRef, anillo), 1e-9, `polígono ${k}`)
  }
})

// El Δλ reducido por módulo redondea y mete ~5·10⁻⁵ de error en estas figuras; la reducción ingenua
// del exceso cancela los dígitos de las de giro negativo. Son cuadriláteros irregulares: en un
// paralelogramo el error del Δλ de un lado se cancela con el del opuesto.
test('2 000 cuadriláteros de pocas hectáreas en (−45,14, −77,92), en los dos giros, coinciden con la geographiclib', () => {
  const azar = sembrado(4514)
  for (let k = 0; k < 1000; k++) {
    const [lat, lng] = [-45.14 + azar() * 0.01, -77.92 + azar() * 0.01]
    const radio      = 0.0005 + azar() * 0.002
    const anillo     = Array.from({ length: 4 }, (_, i) => {
      const [r, t] = [radio * (0.6 + 0.4 * azar()), (i + azar() / 2) * Math.PI / 2]
      return [lat + r * Math.sin(t), lng + r * Math.cos(t) / Math.cos(lat * RAD)]
    })
    for (const giro of [anillo, [...anillo].reverse()])
      cerca(area(giro), areaRef(esferaRef, giro), 1e-9, `cuadrilátero ${k}`)
  }
})

test('el antimeridiano: la figura con la longitud envuelta y sin envolver mide lo mismo, bit a bit', () => {
  const envuelta    = [[-10, 170], [-10, -170], [10, -170], [10, 170]]
  const sinEnvolver = [[-10, 170], [-10, 190], [10, 190], [10, 170]]
  assert.equal(area(envuelta), area(sinEnvolver))
  assert.equal(area(WGS84, envuelta), area(WGS84, sinEnvolver))
  cerca(area(envuelta), areaRef(esferaRef, envuelta), 1e-12, 'contra la geographiclib')
})

test('un vértice en el polo vale con cualquier longitud: el triángulo y el cuadrilátero miden el octante', () => {
  cerca(area([[0, 0], [90, 0], [0, 90]]), Math.PI * R * R / 2, 1e-15, 'triángulo')
  cerca(area([[0, 0], [90, 0], [90, 90], [0, 90]]), Math.PI * R * R / 2, 1e-15, 'cuadrilátero')
})

// ── área: composición y formas ───────────────────────────────────────────────

const EXTERIOR = cuadrado(-37, -73, 0.1)
const HUECO    = cuadrado(-36.97, -72.97, 0.04)

// Anillos sin simetría: en la esfera, invertirlos o repetir el cierre cambia el orden de suma del
// exceso, y eso se nota en los últimos bits.
const IRREGULAR   = [[-37, -73], [-37.02, -72.9], [-36.93, -72.88], [-36.9, -72.99]]
const HUECO_IRREG = [[-36.97, -72.97], [-36.96, -72.93], [-36.93, -72.94]]

test('un hueco se resta, y el giro de ningún anillo cambia el área más que el redondeo', () => {
  for (const m of [sphere(), WGS84]) {
    const esperado = area(m, IRREGULAR) - area(m, HUECO_IRREG)
    assert.equal(area(m, [IRREGULAR, HUECO_IRREG]), esperado)
    for (const exterior of [IRREGULAR, [...IRREGULAR].reverse()])
      for (const hueco of [HUECO_IRREG, [...HUECO_IRREG].reverse()])
        cerca(area(m, [exterior, hueco]), esperado, 1e-12, `${exterior[1]} ${hueco[1]}`)
  }
})

test('un multipolígono de dos partes disjuntas suma sus partes', () => {
  const otra = cuadrado(-30, -70, 0.2)
  assert.equal(area([[EXTERIOR, HUECO], [otra]]), area([EXTERIOR, HUECO]) + area(otra))
})

test('las cuatro formas de punto, la vista tipada y el cierre repetido miden lo mismo', () => {
  const ref    = area(EXTERIOR)
  const formas = [
    EXTERIOR.map(([lat, lng]) => ({ lat, lng })),
    EXTERIOR.map(([lat, lng]) => ({ lat, lon: lng })),
    EXTERIOR.map(([latitude, longitude]) => ({ latitude, longitude })),
    EXTERIOR.map(p => Float64Array.from(p)),
    [...EXTERIOR, EXTERIOR[0]],
  ]
  formas.forEach((anillo, i) => assert.equal(area(anillo), ref, `forma ${i}`))
  // Float32 redondea las coordenadas: mide la figura redondeada, que se compara con la misma en pares.
  const redondeada = EXTERIOR.map(([lat, lng]) => Float32Array.of(lat, lng, 120))
  assert.equal(area(redondeada), area(redondeada.map(([lat, lng]) => [lat, lng])))
  for (const anillo of [IRREGULAR, HUECO_IRREG])
    for (const m of [sphere(), WGS84]) {
      assert.equal(area(m, [...anillo, anillo[0]]), area(m, anillo), `cierre de ${anillo[0]}`)
      assert.equal(perimeter(m, [...anillo, anillo[0]]), perimeter(m, anillo), `cierre de ${anillo[0]}`)
    }
})

// ── bordes ───────────────────────────────────────────────────────────────────

test('una zona sin anillos mide 0 en las tres medidas', () => {
  for (const vacia of [null, undefined, [], [[]], [null], [[], null], [[null, []]], [[EXTERIOR.slice(0, 0)]]])
    for (const medida of [area, perimeter, diameter])
      assert.equal(medida(vacia), 0, `${medida.name}(${JSON.stringify(vacia)})`)
  assert.equal(area(), 0)
})

test('un exterior nulo o vacío se lleva sus huecos, y un anillo o un polígono nulo no aporta', () => {
  assert.equal(area([null, HUECO]), 0)
  assert.equal(area([[], HUECO]), 0)
  assert.equal(area([EXTERIOR, null, HUECO]), area([EXTERIOR, HUECO]))
  assert.equal(area([[EXTERIOR], null, [], [[], HUECO]]), area(EXTERIOR))
  assert.equal(area([[[], null], [EXTERIOR]]), area(EXTERIOR))
})

test('un anillo de 1 vértice mide 0, y uno de 2, área 0, perímetro de ida y vuelta y diámetro d', () => {
  const [p, q] = EXTERIOR
  for (const medida of [area, perimeter, diameter]) assert.equal(medida([p]), 0, medida.name)
  const d = distance(p, q)
  assert.equal(area([p, q]), 0)
  assert.equal(perimeter([p, q]), d + d)
  assert.equal(diameter([p, q]), d)
})

test('un vértice inválido en cualquier anillo da NaN en las tres medidas', () => {
  const invalidos = [
    [[-37, -73], null, [-36.9, -72.9]],
    [[-37, -73], [95, 0], [-36.9, -72.9]],
    [[-37, -73], ['-36', '-72'], [-36.9, -72.9]],
    [EXTERIOR, [HUECO[0], [NaN, 0], HUECO[2]]],
    [[EXTERIOR], [[EXTERIOR[0], { lat: 1 }, EXTERIOR[2]]]],
    [[null, 5], [-37, -73], [-36.9, -72.9]],
    [[null, null], [-37, -73], [-36, -73], [-36, -72]],
    [EXTERIOR, [[null, null], ...HUECO]],
    [, [-37, -73], [-36, -73], [-36, -72]],
    [[-37, -73], [-36, -73], [-36, -72], ,],
  ]
  for (const zona of invalidos)
    for (const medida of [area, perimeter, diameter]) esNaN(medida(zona), `${medida.name}(${JSON.stringify(zona)})`)
})

test('una zona que no es array ni nula, o algo que no es array en la posición de un anillo, da NaN', () => {
  const malas = [{ lat: -37, lng: -73 }, new Set([EXTERIOR]), 42, 'zona', Float64Array.of(1, 2, 3, 4),
    [EXTERIOR, 42], [[EXTERIOR], { lat: 1, lng: 2 }]]
  for (const zona of malas)
    for (const medida of [area, perimeter, diameter]) esNaN(medida(zona), `${medida.name}(${String(zona)})`)
})

test('el modelo va primero y construido: lo demás lanza TypeError con el nombre de la medida', () => {
  for (const medida of [area, perimeter, diameter]) {
    const msg = new RegExp(`^TypeError: \\[${medida.name}\\] recibe \\(model\\?, polygon\\)`)
    assert.throws(() => medida(EXTERIOR, WGS84), msg)
    assert.throws(() => medida(WGS84), msg)
    assert.throws(() => medida(sphere), msg)
    assert.throws(() => medida(null, EXTERIOR), msg)
    assert.throws(() => medida(WGS84, EXTERIOR, EXTERIOR), msg)
    assert.throws(() => medida(WGS84, sphere()), msg)
  }
})

test('un modelo de otra versión, sin la marca de área, sirve a perimeter y diameter, y area lo rechaza', () => {
  const viejo = { [MODEL]: sphere()[MODEL] }
  assert.throws(() => area(viejo, EXTERIOR), /^TypeError: \[area\] este modelo no mide áreas/)
  assert.equal(perimeter(viejo, EXTERIOR), perimeter(EXTERIOR))
  assert.equal(diameter(viejo, EXTERIOR), diameter(EXTERIOR))
})

test('un modelo de terceros con las marcas armadas a mano mide con su propio núcleo de área', () => {
  const vistos = []
  const ajeno  = {
    [MODEL] : (lat1, lng1, lat2, lng2) => Math.hypot(lat2 - lat1, lng2 - lng1),
    [AREA]  : (coords, count) => {
      vistos.push([...coords.subarray(0, count * 2)])
      return 7
    },
  }
  assert.equal(area(ajeno, EXTERIOR.slice(0, 2)), 0)
  assert.equal(area(ajeno, [EXTERIOR, HUECO]), 0)
  assert.deepEqual(vistos, [EXTERIOR.flat(), HUECO.flat()])
  assert.equal(area(ajeno, [[EXTERIOR], [HUECO]]), 14)
})

test('diameter mide en horizontal: un objeto que trae la marca de terreno lanza TypeError', () => {
  const terreno = { [MODEL]: sphere()[MODEL], [Symbol.for('cristae.geometry.relief')]: () => ({}) }
  assert.throws(() => diameter(terreno, EXTERIOR), /^TypeError: \[diameter\] mide en horizontal/)
})

// ── perímetro ────────────────────────────────────────────────────────────────

test('el perímetro de un anillo es, bit a bit, distance del anillo cerrado', () => {
  for (const m of [sphere(), WGS84]) {
    assert.equal(perimeter(m, EXTERIOR), distance(m, [...EXTERIOR, EXTERIOR[0]]))
    assert.equal(perimeter(m, HUECO), distance(m, [...HUECO, HUECO[0]]))
  }
})

test('con un hueco, los anillos se suman seguidos, como distance de los dos anillos cerrados', () => {
  for (const m of [sphere(), WGS84])
    assert.equal(perimeter(m, [EXTERIOR, HUECO]), distance(m, [[...EXTERIOR, EXTERIOR[0]], [...HUECO, HUECO[0]]]))
})

test('con WGS84 coincide con el perímetro de PolygonArea', () => {
  for (const anillo of [EXTERIOR, cuadrado(60, 10, 3), [[-10, 170], [-10, -170], [10, -170], [10, 170]]])
    cerca(perimeter(WGS84, anillo), poligonoRef(elipsoideRef, anillo).perimeter, 1e-9, JSON.stringify(anillo[0]))
})

// ── diámetro: contra la fuerza bruta ─────────────────────────────────────────

const fuerzaBruta = (m, puntos) => {
  let mayor = 0
  for (let i = 0; i < puntos.length; i++)
    for (let j = i + 1; j < puntos.length; j++) mayor = Math.max(mayor, distance(m, puntos[i], puntos[j]))
  return mayor
}

// Un círculo de `n` vértices con el rumbo sesgado, az = 360·(t + k·sen(2π(t+φ))/(2π)): los vértices se
// amontonan de un lado, y el par más lejano deja de ser el de rumbos opuestos.
const circuloSesgado = (lat, lng, metros, k, fase, n = 300) => Array.from({ length: n }, (_, i) => {
  const t   = i / n
  const az  = 360 * (t + k * Math.sin(2 * Math.PI * (t + fase)) / (2 * Math.PI))
  const fin = esferaRef.Direct(lat, lng, az, metros)
  return [fin.lat2, fin.lon2]
})

test('diameter coincide con la fuerza bruta en círculos sesgados de 1 a 3 000 km', () => {
  const azar = sembrado(300)
  for (const metros of [1e3, 1e5, 1e6, 3e6])
    for (let c = 0; c < 30; c++) {
      const puntos  = circuloSesgado(azar() * 170 - 85, azar() * 360 - 180, metros, 0.3 + 0.4 * azar(), azar())
      const modelos = (metros === 1e3 || metros === 1e6) && c < 10 ? [sphere(), WGS84] : [sphere()]
      for (const m of modelos) cerca(diameter(m, puntos), fuerzaBruta(m, puntos), 1e-12, `${metros} m, círculo ${c}`)
    }
})

test('diameter coincide con la fuerza bruta en 100 nubes al azar de 10 m a 3 000 km', () => {
  const azar = sembrado(64)
  for (let c = 0; c < 100; c++) {
    const [lat, lng] = [azar() * 170 - 85, azar() * 360 - 180]
    const radio      = 10 * 3e5 ** azar()
    const puntos     = Array.from({ length: 5 + Math.floor(azar() * 60) }, () => {
      const fin = esferaRef.Direct(lat, lng, azar() * 360, radio * azar())
      return [fin.lat2, fin.lon2]
    })
    cerca(diameter(puntos), fuerzaBruta(sphere(), puntos), 1e-12, `nube ${c}`)
    if (c < 20) cerca(diameter(WGS84, puntos), fuerzaBruta(WGS84, puntos), 1e-12, `nube ${c}, WGS84`)
  }
})

// En el elipsoide, una bola de casi 90° deja de ser convexa en la gnomónica: el vértice del medio del
// grupo lejano, que el casco descarta por colineal, es el más lejano del grupo opuesto.
test('diameter en el elipsoide no pierde el par más lejano en zonas de casi 90° de ancho', () => {
  const casos = [
    [WGS84, [[0, -0.01], [0.01, 0], [0, 0.01], [1, 89.9], [0, 89.9], [-1, 89.9]]],
    [ellipsoid(A, 0.2), [[0, -0.01], [0.01, 0], [0, 0.01], [5, 85], [0, 85], [-5, 85]]],
  ]
  for (const [m, zona] of casos) cerca(diameter(m, zona), fuerzaBruta(m, zona), 1e-12, String(zona[3]))
})

// Un modelo que cuenta sus llamadas y mide con la esfera.
const contador = () => {
  const arco   = sphere()[MODEL]
  const modelo = { llamadas: 0 }
  modelo[MODEL] = (...args) => {
    modelo.llamadas++
    return arco(...args)
  }
  return modelo
}

test('una zona sin centro o de 45° o más de radio angular se mide sobre todos los pares', () => {
  const ecuador = Array.from({ length: 36 }, (_, i) => [0, i * 10 - 180])
  const arco    = Array.from({ length: 30 }, (_, i) => [20, i * 4 - 60])
  for (const zona of [ecuador, arco]) {
    const m = contador()
    assert.equal(diameter(m, zona), fuerzaBruta(sphere(), zona))
    assert.equal(m.llamadas, zona.length * (zona.length - 1) / 2)
  }
})

test('costo: un círculo de 10 000 vértices y 2 km llama al modelo menos de 2 veces por vértice', () => {
  const m      = contador()
  const puntos = circuloSesgado(-37, -73, 2000, 0, 0, 10000)
  cerca(diameter(m, puntos), 4000, 1e-9, 'el diámetro del círculo')
  assert.ok(m.llamadas <= 2 * puntos.length, `${m.llamadas} llamadas`)
})

// ── segunda copia ────────────────────────────────────────────────────────────

// Una copia empaquetada del entry, importada desde un data: URL, es otra instancia de todo su grafo:
// sus modelos y los de este proceso sólo se reconocen por las marcas del registro global. Importar
// `index.js?copia` no sirve: sólo duplicaría el archivo de entrada, no sus imports.
test('una segunda copia empaquetada mide con los modelos de la primera, y al revés, lo mismo que con los suyos', async () => {
  const [salida] = (await build({
    entryPoints : [`${raiz}src/geometry/index.js`],
    bundle      : true,
    write       : false,
    format      : 'esm',
    platform    : 'browser',
    logLevel    : 'silent',
  })).outputFiles
  const copia = await import(`data:text/javascript;base64,${Buffer.from(salida.text).toString('base64')}`)
  assert.notEqual(copia.area, area)
  const zona = [EXTERIOR, HUECO]
  for (const [propio, ajeno] of [[sphere(), copia.sphere()], [WGS84, copia.WGS84]]) {
    assert.equal(copia.area(propio, zona), copia.area(ajeno, zona))
    assert.equal(area(ajeno, zona), area(propio, zona))
    assert.equal(copia.perimeter(propio, zona), perimeter(propio, zona))
    assert.equal(copia.diameter(ajeno, zona), diameter(propio, zona))
  }
})
