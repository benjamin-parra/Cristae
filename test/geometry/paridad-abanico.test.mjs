// ¿Los anillos de un objeto tienen que COMPARTIR el ancla del abanico? La pregunta es de geometría,
// así que se dirime en CPU: por cada arista (vᵢ, vᵢ₊₁) se cuenta si el triángulo (ancla, vᵢ, vᵢ₊₁)
// cubre el punto de muestra y se toma la paridad —el equivalente exacto de `stencilOp INVERT` con la
// regla par-impar—, contra un oráculo independiente de ray casting.
// La pertenencia usa desempate top-left, que equivale a evaluar el punto desplazado (-ε, -ε²): sin
// una regla así, un radio ancla→vᵢ —arista que comparten dos triángulos del abanico— se contaría dos
// veces o ninguna, y la prueba mentiría justo en los puntos que interesan. El oráculo aplica el
// MISMO desplazamiento simbólico, de modo que el contrato queda definido también sobre el trazo.
// Todas las coordenadas de las figuras son PARES: el medio de cualquier arista cae en entero y toda
// la aritmética es exacta en float64 (ningún producto cruzado pasa de ~1e12).
// Corre con: node --test test/geometry/paridad-abanico.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'

// ── álgebra de pertenencia ────────────────────────────────────────────────────

const cross = (ax, ay, bx, by) => ax * by - ay * bx

// Lado del punto r respecto de la arista dirigida p→q: > 0 a la izquierda.
const lado = ([px, py], [qx, qy], [x, y]) => cross(qx - px, qy - py, x - px, y - py)

// Desempate top-left sobre p→q, con el triángulo ya normalizado a CCW. Acepta el empate exactamente
// cuando cross(q - p, (-ε, -ε²)) > 0, así que de dos triángulos que comparten la arista en sentidos
// opuestos la cubre uno y sólo uno.
const topLeft = ([px, py], [qx, qy]) => qy > py || (qy === py && qx < px)

const SIEMPRE = () => true
const NUNCA   = () => false

const cubreArista = (p, q, r, empate) => {
  const e = lado(p, q, r)
  return e > 0 || (e === 0 && empate(p, q))
}

// Área nula ⇒ no cubre nada, que es lo que hace el rasterizador con un triángulo degenerado: el caso
// del ancla colineal con una arista o apoyada en un vértice.
const cubre = (a, b, c, r, empate = topLeft) => {
  const area = cross(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1])
  if (area === 0) return false
  const [u, v] = area > 0 ? [b, c] : [c, b]
  return cubreArista(a, u, r, empate) && cubreArista(u, v, r, empate) && cubreArista(v, a, r, empate)
}

const siguiente = (anillo, i) => anillo[(i + 1) % anillo.length]

const paridadAbanico = (anillo, ancla, r, empate) =>
  anillo.filter((v, i) => cubre(ancla, v, siguiente(anillo, i), r, empate)).length % 2

const paridadCompuesta = (anillos, anclaDe, r, empate) =>
  anillos.reduce((acc, anillo, k) => acc ^ paridadAbanico(anillo, anclaDe(k), r, empate), 0)

// ── oráculo independiente: ray casting ────────────────────────────────────────

// Cruces de la semirrecta +x, regla par-impar. La franja en y usa `>=` y el empate lateral se
// resuelve hacia el mismo lado que el desempate del abanico: ambas convenciones son el
// desplazamiento (-ε, -ε²), sólo que resuelto en enteros en vez de con un epsilon real.
const cruces = (anillo, [x, y]) => anillo.filter((a, i) => {
  const b = siguiente(anillo, i)
  if ((a[1] >= y) === (b[1] >= y)) return false
  const s = lado(a, b, [x, y])
  return b[1] > a[1] ? s >= 0 : s <= 0
}).length

const dentroPorRayo = (anillos, r) => anillos.reduce((n, anillo) => n + cruces(anillo, r), 0) % 2

// La convención clásica (PNPOLY): franja semiabierta por abajo y empate estricto. Fuera del trazo
// tiene que coincidir con la anterior — sobre el trazo NO, y eso es lo que prueba que el borde lo
// decide la convención y no la geometría.
const crucesClasico = (anillo, [x, y]) => anillo.filter((a, i) => {
  const b = siguiente(anillo, i)
  if ((a[1] > y) === (b[1] > y)) return false
  const s = lado(a, b, [x, y])
  return b[1] > a[1] ? s > 0 : s < 0
}).length

const dentroClasico = (anillos, r) =>
  anillos.reduce((n, anillo) => n + crucesClasico(anillo, r), 0) % 2

// ── incidencias: trazo y radios ───────────────────────────────────────────────

const entre = (a, b, c) => Math.min(a, b) <= c && c <= Math.max(a, b)

const enSegmento = (p, q, r) =>
  lado(p, q, r) === 0 && entre(p[0], q[0], r[0]) && entre(p[1], q[1], r[1])

const enTrazo = (anillos, r) =>
  anillos.some(anillo => anillo.some((a, i) => enSegmento(a, siguiente(anillo, i), r)))

const enRadio = (anillo, ancla, r) => anillo.some(v => enSegmento(ancla, v, r))

const degenerados = (anillo, ancla) => anillo.filter((v, i) => {
  const w = siguiente(anillo, i)
  return cross(v[0] - ancla[0], v[1] - ancla[1], w[0] - ancla[0], w[1] - ancla[1]) === 0
}).length

// ── figuras, anclas y grilla ──────────────────────────────────────────────────

const CUADRADO = [[0, 0], [12, 0], [12, 12], [0, 12]]
const MARCO    = [[0, 0], [16, 0], [16, 16], [0, 16]]
const HUECO    = [[4, 4], [4, 12], [12, 12], [12, 4]]      // sentido opuesto al marco, a propósito
const ISLA     = [[6, 6], [10, 6], [10, 10], [6, 10]]

// Rectángulo con una V que baja hasta (10,0): los dos vecinos del vértice quedan del MISMO lado del
// radio (0,0)→(10,0), o sea que los dos triángulos adyacentes tienen orientación opuesta y el radio
// no se cancela por sentido. Es la configuración donde un desempate ingenuo se rompe.
const MUESCA = [[-4, -4], [20, -4], [20, 8], [14, 4], [10, 0], [6, 4], [-4, 8]]

const FIGURAS = {
  convexo             : { anillos: [CUADRADO] },
  concavo             : { anillos: [[[0, 0], [12, 0], [12, 4], [4, 4], [4, 12], [0, 12]]] },
  lazo                : { anillos: [[[0, 0], [12, 12], [12, 0], [0, 12]]] },
  dobleVuelta         : { anillos: [[...CUADRADO, ...CUADRADO]] },
  enredado            : { anillos: [[[0, 0], [16, 0], [16, 16], [0, 16], [0, 4],
                                     [12, 4], [12, 12], [4, 12], [4, 8], [8, 8]]] },
  muesca              : { anillos: [MUESCA], extra: { enLaMuesca: [0, 0] } },
  exteriorConAgujero  : { anillos: [MARCO, HUECO], extra: { enAgujero: [5, 5] } },
  exteriorAgujeroIsla : { anillos: [MARCO, HUECO, ISLA], extra: { enAgujero: [5, 5] } },
}

const bbox = anillos => anillos.flat().reduce((b, [x, y]) => ({
  minX : Math.min(b.minX, x), maxX : Math.max(b.maxX, x),
  minY : Math.min(b.minY, y), maxY : Math.max(b.maxY, y),
}), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity })

const MARGEN = 3

const rango = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

const grilla = anillos => {
  const b = bbox(anillos)
  return rango(b.minY - MARGEN, b.maxY + MARGEN)
    .flatMap(y => rango(b.minX - MARGEN, b.maxX + MARGEN).map(x => [x, y]))
}

const promedio = (vs, eje) => Math.round(vs.reduce((s, v) => s + v[eje], 0) / vs.length)

// Ancla muy lejana: sigue siendo entera, así que los productos cruzados (~1e12) son exactos.
const MUY_LEJOS = [999_982, -700_014]

const anclasDe = ({ anillos, extra }) => {
  const vs = anillos.flat()
  const b  = bbox(anillos)
  return {
    centroide   : [promedio(vs, 0), promedio(vs, 1)],
    esquinaBbox : [b.minX, b.minY],
    muyLejano   : MUY_LEJOS,
    vertice     : anillos[0][0],
    medioArista : [(anillos[0][0][0] + anillos[0][1][0]) / 2, (anillos[0][0][1] + anillos[0][1][1]) / 2],
    ...extra,
  }
}

const figuras = Object.entries(FIGURAS)

const combinaciones = (opciones, n) => n === 0 ? [[]]
  : combinaciones(opciones, n - 1).flatMap(resto => opciones.map(o => [...resto, o]))

// ── el harness no miente: oráculo y muestreo ──────────────────────────────────

test('el oráculo por rayo reconoce las figuras a mano', () => {
  assert.equal(dentroPorRayo([CUADRADO], [6, 6]), 1, 'centro del cuadrado')
  assert.equal(dentroPorRayo([CUADRADO], [30, 6]), 0, 'afuera del cuadrado')
  assert.equal(dentroPorRayo(FIGURAS.concavo.anillos, [8, 8]), 0, 'la escotadura de la L está afuera')
  assert.equal(dentroPorRayo(FIGURAS.concavo.anillos, [2, 8]), 1, 'el brazo alto de la L está adentro')
  assert.equal(dentroPorRayo([MARCO, HUECO], [8, 8]), 0, 'el agujero está afuera')
  assert.equal(dentroPorRayo([MARCO, HUECO], [2, 8]), 1, 'la banda entre marco y agujero está adentro')
  assert.equal(dentroPorRayo([MARCO, HUECO, ISLA], [8, 8]), 1, 'la isla vuelve a estar adentro')
  assert.equal(dentroPorRayo([MARCO, HUECO, ISLA], [5, 8]), 0, 'el agujero alrededor de la isla, afuera')

  // Vuelta doble: winding 2 en todas partes ⇒ par-impar vacío. Es el caso que separa las dos reglas.
  const doble = FIGURAS.dobleVuelta.anillos
  assert.equal(grilla(doble).filter(r => dentroPorRayo(doble, r)).length, 0, 'winding par ⇒ nada adentro')
})

test('las dos convenciones del oráculo coinciden fuera del trazo, y sólo difieren sobre él', () => {
  const discrepanEnBorde = figuras.flatMap(([, { anillos }]) => {
    const fuera = grilla(anillos).filter(r => !enTrazo(anillos, r))
    fuera.forEach(r => assert.equal(dentroPorRayo(anillos, r), dentroClasico(anillos, r),
      `las convenciones difieren fuera del trazo en ${r}`))
    return grilla(anillos).filter(r => enTrazo(anillos, r) &&
      dentroPorRayo(anillos, r) !== dentroClasico(anillos, r))
  })
  assert.ok(discrepanEnBorde.length > 0,
    'sobre el trazo el veredicto lo fija la convención — si nunca difieren, el muestreo no toca el borde')
})

test('la grilla toca de verdad las regiones que importan', () => {
  figuras.forEach(([nombre, figura]) => {
    const { anillos } = figura
    const puntos      = grilla(anillos)
    const anclas      = Object.values(anclasDe(figura))
    const adentro     = puntos.filter(r => dentroPorRayo(anillos, r)).length
    const enBorde     = puntos.filter(r => enTrazo(anillos, r)).length
    const enRadios    = puntos.filter(r => !enTrazo(anillos, r) &&
      anclas.some(a => anillos.some(anillo => enRadio(anillo, a, r)))).length

    assert.ok(enBorde > 0, `${nombre}: ninguna muestra cae sobre el trazo`)
    assert.ok(enRadios > 0, `${nombre}: ninguna muestra cae sobre un radio ancla→vᵢ fuera del trazo`)
    if (nombre !== 'dobleVuelta') assert.ok(adentro > 0, `${nombre}: ninguna muestra cae adentro`)
  })
})

test('las anclas apoyadas en el trazo generan triángulos degenerados de verdad', () => {
  figuras.forEach(([nombre, figura]) => {
    const anclas = anclasDe(figura)
    const anillo = figura.anillos[0]
    assert.ok(degenerados(anillo, anclas.vertice) >= 2,
      `${nombre}: el ancla sobre un vértice debería degenerar sus dos triángulos`)
    assert.ok(degenerados(anillo, anclas.medioArista) >= 1,
      `${nombre}: el ancla sobre una arista debería degenerar el triángulo de esa arista`)
  })
})

// ── el resultado: el ancla se cancela ─────────────────────────────────────────

figuras.forEach(([nombre, figura]) => {
  test(`«${nombre}»: la paridad del abanico ≡ el oráculo, sea cual sea el ancla`, () => {
    const { anillos } = figura
    const puntos      = grilla(anillos)
    const oraculo     = puntos.map(r => dentroPorRayo(anillos, r))

    Object.entries(anclasDe(figura)).forEach(([quien, ancla]) => {
      const falla = puntos.findIndex((r, i) =>
        paridadCompuesta(anillos, () => ancla, r) !== oraculo[i])
      if (falla >= 0) assert.fail(`ancla ${quien}=[${ancla}] discrepa en [${puntos[falla]}]: ` +
        `abanico ${paridadCompuesta(anillos, () => ancla, puntos[falla])} vs oráculo ${oraculo[falla]}`)
    })
  })
})

// ── la pregunta de fondo: compartir el ancla entre anillos ────────────────────

const MULTI = ['exteriorConAgujero', 'exteriorAgujeroIsla']

MULTI.forEach(nombre => {
  test(`«${nombre}»: ancla COMPARTIDA y ancla POR ANILLO dan la misma paridad`, () => {
    const figura      = FIGURAS[nombre]
    const { anillos } = figura
    const anclas      = Object.values(anclasDe(figura))
    const puntos      = grilla(anillos)
    const oraculo     = puntos.map(r => dentroPorRayo(anillos, r))
    const repartos    = combinaciones(anclas, anillos.length)

    repartos.forEach(reparto => {
      const falla = puntos.findIndex((r, i) => paridadCompuesta(anillos, k => reparto[k], r) !== oraculo[i])
      if (falla >= 0) assert.fail(`reparto ${JSON.stringify(reparto)} discrepa en [${puntos[falla]}]`)
    })

    // Sin esto el test pasaría con un solo reparto: hay que haber probado también los mixtos.
    const mixtos = repartos.filter(reparto => new Set(reparto).size > 1).length
    assert.ok(mixtos >= repartos.length - anclas.length, `${nombre}: faltan repartos con anclas distintas`)
  })
})

test('el agujero sigue leyéndose como AFUERA aunque cada anillo traiga su propia ancla', () => {
  const anillos = FIGURAS.exteriorAgujeroIsla.anillos
  const anclas  = anclasDe(FIGURAS.exteriorAgujeroIsla)
  const reparto = [anclas.muyLejano, anclas.enAgujero, anclas.vertice]   // uno de cada naturaleza
  const paridad = r => paridadCompuesta(anillos, k => reparto[k], r)

  assert.equal(paridad([2, 8]), 1, 'banda entre marco y agujero')
  assert.equal(paridad([5, 8]), 0, 'agujero')
  assert.equal(paridad([8, 8]), 1, 'isla dentro del agujero')
  assert.equal(paridad([20, 8]), 0, 'fuera del marco')
})

// ── dónde SÍ hace falta compartir: tramos de un mismo contorno ────────────────

// Un anillo cerrado partido en polilíneas abiertas cuya unión son sus mismas aristas. Cada tramo
// aporta sólo sus aristas explícitas: le faltan los radios de los extremos, que en el anillo entero
// se cancelaban contra los del tramo vecino.
const CONTORNO = [[0, 0], [16, 0], [16, 10], [10, 10], [10, 16], [0, 16]]

const TRAMOS = [
  [CONTORNO[0], CONTORNO[1], CONTORNO[2]],
  [CONTORNO[2], CONTORNO[3]],
  [CONTORNO[3], CONTORNO[4], CONTORNO[5], CONTORNO[0]],
]

const paridadTramo = (tramo, ancla, r) =>
  tramo.slice(0, -1).filter((v, i) => cubre(ancla, v, tramo[i + 1], r)).length % 2

const paridadTramos = (anclaDe, r) => TRAMOS.reduce((acc, t, k) => acc ^ paridadTramo(t, anclaDe(k), r), 0)

test('tramos de un contorno: con ancla COMPARTIDA reproducen el anillo entero', () => {
  const puntos = grilla([CONTORNO])
  const anclas = anclasDe({ anillos: [CONTORNO] })

  Object.entries(anclas).forEach(([quien, ancla]) => {
    const falla = puntos.findIndex(r => paridadTramos(() => ancla, r) !== dentroPorRayo([CONTORNO], r))
    if (falla >= 0) assert.fail(`ancla ${quien}=[${ancla}] discrepa en [${puntos[falla]}]`)
  })
})

test('tramos de un contorno: con ancla POR TRAMO la costura NO cancela — acá sí hay que compartir', () => {
  const puntos  = grilla([CONTORNO])
  const anclas  = anclasDe({ anillos: [CONTORNO] })
  const reparto = [anclas.centroide, anclas.muyLejano, anclas.vertice]
  const rotos   = puntos.filter(r => paridadTramos(k => reparto[k], r) !== dentroPorRayo([CONTORNO], r))

  assert.ok(rotos.length > 0,
    'el radio que le falta a cada tramo sólo se cancela contra el del vecino si apuntan al mismo lado')
})

// ── por qué el desempate no es un detalle ─────────────────────────────────────

test('sin un desempate consistente el abanico miente sobre los radios', () => {
  const fallas = empate => figuras.reduce((n, [, { anillos }]) => {
    const puntos = grilla(anillos)
    const anclas = Object.values(anclasDe({ anillos }))
    return n + anclas.reduce((m, ancla) => m + puntos.filter(r =>
      paridadCompuesta(anillos, () => ancla, r, empate) !== dentroPorRayo(anillos, r)).length, 0)
  }, 0)

  assert.ok(fallas(SIEMPRE) > 0, 'aceptar todo empate cuenta dos veces el radio compartido')
  assert.ok(fallas(NUNCA)   > 0, 'rechazar todo empate deja el radio compartido sin contar')
  assert.equal(fallas(topLeft), 0, 'el desempate top-left lo cuenta exactamente una vez')
})
