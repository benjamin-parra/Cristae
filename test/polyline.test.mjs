// Prueba pura de geometry/polyline.js + render/project.js (sin DOM ni WebGL).
// Corre con: node test/polyline.test.mjs
import { isDeepStrictEqual } from 'node:util'
import { projX0, projY0 } from '../src/render/project.js'
import { nearest, sampleAlong, toParts } from '../src/geometry/polyline.js'

// Azúcar para las pruebas: el índice que arma la capa de líneas para un path recto, con `src` = la
// posición de cada vértice en la entrada. Todo entra por `toParts`, que ya descarta las partes sin
// segmento.
const idxOf = items => ({
  stale  : true,
  sorted : items.flatMap(({ id, path, parts }) => toParts(parts ?? path).map(({ from, path: tramo }, partIndex) => {
    const pts = tramo.map(([lat, lng]) => ({ x: projX0(lng), y: projY0(lat) }))
    const xs  = pts.map(p => p.x), ys = pts.map(p => p.y)
    const box = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
    return { id, partIndex, src: pts.map((_, k) => from + k), pts, bbox: box }
  })),
})

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++ } else { fail++; console.error('  ✗ FAIL:', msg) } }
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps
const igual  = (entrada, esperado, msg) => ok(isDeepStrictEqual(toParts(entrada), esperado), msg)

// ── project.js: mundo 256×256 a zoom 0, centro (128,128) ──
ok(approx(projX0(0), 128), 'projX0(0)=128')
ok(approx(projY0(0), 128), 'projY0(0)=128')
ok(approx(projX0(180), 256), 'projX0(180)=256')
ok(approx(projX0(-180), 0), 'projX0(-180)=0')
ok(projX0(10) > projX0(0), 'projX0 crece con lng')
ok(projY0(10) < projY0(0), 'projY0 decrece con lat (norte = y menor)')

// ── índice vacío / degenerado ──
ok(idxOf([]).sorted.length === 0, 'idxOf([]) vacío')
ok(idxOf([{ id: 1, path: [[0, 0]] }]).sorted.length === 0, 'path de 1 punto se descarta (sin segmento)')
ok(nearest(0, 0, idxOf([]), 1).length === 0, 'nearest sobre índice vacío = []')

// ── una línea horizontal en el ecuador de lng 0..10 ──
const idx1 = idxOf([{ id: 42, path: [[0, 0], [0, 10]] }])

// Punto EXACTO sobre la línea (lat 0, lng 5) → hit dist ~0
{
  const hits = nearest(0, 5, idx1, 0.01)
  ok(hits.length === 1 && hits[0].id === 42, 'punto sobre la línea → hit id 42')
  ok(hits[0].vertexIndex === 0, 'vertexIndex 0')
  ok(hits[0].dist < 1e-6, 'dist ~0 sobre la línea')
}

// Punto a ~1 world0px al norte de la línea. 1 world0px de lat cerca del ecuador ≈ 360/256 grados en lng,
// pero en lat projY0 es no lineal; medimos empíricamente el offset que da ~0.5px.
{
  // desplazamiento en lat que produce ~1 px world0 cerca del ecuador
  const latFor1px = 0 - (projY0(0) - projY0(0.7)) // proxy; usamos tol grande y chico para bracketear
  const near = nearest(0.001, 5, idx1, 1)   // muy cerca → dentro de tol 1px
  ok(near.length === 1, 'punto muy cercano dentro de tol=1 → hit')
  const far = nearest(1, 5, idx1, 0.5)       // ~ world0px lejos → fuera de tol 0.5px
  ok(far.length === 0, 'punto lejos fuera de tol pequeño → sin hit')
  void latFor1px
}

// Fuera del bbox en lng (al este del extremo) más allá de tol → sin hit
ok(nearest(0, 20, idx1, 0.5).length === 0, 'punto al este del extremo fuera de tol → sin hit')

// ── dos líneas: la consulta cae cerca de la segunda; broad-phase por maxX ──
const idx2 = idxOf([
  { id: 1, path: [[0, 0], [0, 5]] },      // oeste
  { id: 2, path: [[0, 20], [0, 30]] },    // este
])
{
  const hits = nearest(0, 25, idx2, 0.5)
  ok(hits.length === 1 && hits[0].id === 2, 'consulta al este → sólo línea 2 (broad-phase descarta la 1)')
}

// ── nearest-segment: path en V, el punto cae cerca del segundo segmento ──
{
  const idxV = idxOf([{ id: 7, path: [[0, 0], [5, 5], [0, 10]] }])
  const hits = nearest(0.2, 9.5, idxV, 3)  // cerca del tramo (5,5)->(0,10) = segmento 1
  ok(hits.length === 1 && hits[0].id === 7, 'V: hit')
  ok(hits[0].vertexIndex === 1, 'V: elige el segmento 1 (el más cercano), no el 0 -> vertexIndex 1')
}

// ── índice mutable: una entrada que crece se re-ordena al próximo nearest ──
{
  const idx = idxOf([{ id: 1, path: [[0, 0], [0, 1]] }, { id: 2, path: [[0, 50], [0, 51]] }])
  const e = idx.sorted.find((x) => x.id === 1)
  const antes = nearest(0, 80, idx, 0.5).length
  // El id 1 crece hasta cubrir lng 80 sin que `sorted` se ordene de nuevo: lo que se declara es `stale`.
  e.pts = [...e.pts, { x: projX0(80), y: projY0(0) }]
  e.bbox = { ...e.bbox, maxX: projX0(80) }
  idx.stale = true
  ok(antes === 0 && nearest(0, 80, idx, 0.5).length === 1, 'stale: nearest re-ordena y ve lo que creció')
  ok(idx.stale === false, 'stale se limpia tras el re-orden')
}

// ── toParts: la convención de corte (encoding plano) ──
{
  ok(toParts(null).length === 0, 'toParts(null) = []')
  ok(toParts([]).length === 0, 'toParts([]) = []')
  ok(toParts([[0, 0]]).length === 0, 'un solo vértice = sin parte (no hay segmento)')

  // Un path sano es UNA parte que arranca en 0
  const sano = toParts([[0, 0], [0, 1], [0, 2]])
  ok(sano.length === 1 && sano[0].from === 0 && sano[0].path.length === 3, 'path sano = 1 parte, from 0')

  // 🔴 el caso que motivó el cambio: un bache NO se puentea, CORTA
  const conBache = toParts([[0, 0], [0, 1], [NaN, NaN], [0, 8], [0, 9]])
  ok(conBache.length === 2, 'un vértice no finito CORTA (2 partes), no se descarta puenteando')
  ok(conBache[0].from === 0 && conBache[0].path.length === 2, 'parte 0: from 0, 2 vértices')
  ok(conBache[1].from === 3 && conBache[1].path.length === 2, 'parte 1: from 3 (el corte ocupa índice)')
  ok(conBache[0].path[1][1] === 1 && conBache[1].path[0][1] === 8, 'los extremos del hueco NO quedan unidos')

  // cortes consecutivos y en los extremos colapsan; los tramos de 1 vértice se descartan
  const sucio = toParts([[NaN, 0], [0, 1], [NaN, 0], [NaN, 0], [0, 5], [0, 6], [NaN, 0]])
  ok(sucio.length === 1 && sucio[0].from === 4, 'cortes múltiples/extremos colapsan; tramo de 1 vértice fuera')

  // null / undefined como corte explícito (lo natural de escribir en el consumidor)
  ok(toParts([[0, 0], [0, 1], null, [0, 5], [0, 6]]).length === 2, 'null también corta')

  // 🔴 el corte en el PRIMER vértice no debe confundir al sniff plano/anidado (era un TypeError)
  const arranqueCortado = [
    ['NaN', [[NaN, NaN], [0, 1], [0, 2]]],
    ['null', [null, [0, 1], [0, 2]]],
    ['undefined', [undefined, [0, 1], [0, 2]]],
  ]
  arranqueCortado.forEach(([nombre, entrada]) => {
    const r = toParts(entrada)
    ok(r.length === 1 && r[0].from === 1 && r[0].path.length === 2, `arranque cortado con ${nombre}`)
  })

  ok(toParts([null, null]).length === 0, 'todo nulo = [] (no revienta ni cae al anidado)')

  // 🔴 el corte también se detecta por la LONGITUD, no sólo por la latitud (mutante (m) sobrevivía)
  const lngSucia = toParts([[0, 0], [0, 1], [0, NaN], [0, 8], [0, 9]])
  ok(lngSucia.length === 2 && lngSucia[1].from === 3, 'una lng no finita corta igual que una lat')

  // 🔴 un par sucio EN CABEZA no puede hacer desaparecer el path entero (fila GPS con lat nula)
  const cabezaSucia = toParts([[null, -70.6], [-33.4, -70.6], [-33.5, -70.7]])
  ok(cabezaSucia.length === 1 && cabezaSucia[0].from === 1, 'par sucio en cabeza: se corta, no se pierde la línea')
  ok(toParts([[], [0, 1], [0, 2]]).length === 1, 'par vacío en cabeza: idem')

  // vértices con forma ajena: no revientan, cortan
  ok(toParts([{ lat: () => 0, lng: () => 0 }, { lat: () => 0, lng: () => 1 }]).length === 0, 'vértices con métodos: [] sin throw')

  // 🔴 el spread es lo único que sostiene el contrato `Iterable` (mutante (l) sobrevivía)
  ok(toParts(new Set([[0, 0], [0, 1], [0, 2]]))[0].path.length === 3, 'entrada Set (iterable no-array)')
  const gen = function* () { yield [0, 0]; yield [0, 1]; yield [0, 2] }
  ok(toParts(gen())[0].path.length === 3, 'entrada generador (iterable de un solo uso)')
}

// ── toParts: encoding anidado (partes explícitas) + índices concatenados ──
{
  const partes = toParts([[[0, 0], [0, 1]], [[0, 8], [0, 9], [0, 10]]])
  ok(partes.length === 2, 'anidado = 2 partes')
  ok(partes[0].from === 0 && partes[1].from === 2, 'los índices corren CONCATENADOS entre partes')
  ok(partes[1].path.length === 3, 'la 2ª parte conserva sus 3 vértices')

  // parte degenerada de 1 vértice → descartada, pero sin correr los índices de las siguientes
  const conDegenerada = toParts([[[0, 0]], [[0, 8], [0, 9]]])
  ok(conDegenerada.length === 1 && conDegenerada[0].from === 1, 'parte de 1 vértice fuera; from sigue contando')

  // el sniff no confunde un path plano con partes
  ok(toParts([[0, 0], [0, 1]])[0].path.length === 2, 'sniff: [[lat,lng],…] se lee como plano')

  // una parte nula no revienta y no corre los índices de las siguientes
  const conNula = toParts([null, [[0, 1], [0, 2]]])
  ok(conNula.length === 1 && conNula[0].from === 0, 'parte nula = 0 vértices, no desplaza el índice')

  // 🔴 hueco DENTRO de una parte del anidado: corta ahí y el índice sigue corriendo concatenado
  const huecoInterno = toParts([[[0, 0], [0, 1], [NaN, NaN], [0, 3], [0, 4]], [[0, 8], [0, 9]]])
  ok(huecoInterno.length === 3, 'anidado con hueco interno = 3 partes')
  ok(huecoInterno.map((p) => p.from).join(',') === '0,3,5', 'from = [0,3,5] (concatenado a través del corte)')

  // 🔴 from + scalarOf en el encoding ANIDADO (la suite sólo lo probaba en el plano)
  const pathIndexOf = (v) => (v + 1) >> 1
  const leidos = toParts([[[0, 0], [0, 1]], [[0, 8], [0, 9]]])
    .flatMap(({ path, from }) => Array.from({ length: 2 * (path.length - 1) }, (_, k) => from + pathIndexOf(k)))
  ok(leidos.join(',') === '0,1,2,3', 'anidado: el escalar paralelo se lee concatenado, sin desalineo')
}

// ── toParts: la salida COMPLETA, congelada en los casos de corte ──
// Los asertos de arriba miran conteos y `from`; éstos fijan además los pares, para que cualquier
// reescritura del recorrido tenga que devolver exactamente lo mismo.
{
  igual([[null, -70.6], [-33.4, -70.6], [-33.5, -70.7]],
    [{ from: 1, path: [[-33.4, -70.6], [-33.5, -70.7]] }], 'salida: par sucio en cabeza')
  igual([[NaN, NaN], [0, 1], [0, 2]], [{ from: 1, path: [[0, 1], [0, 2]] }], 'salida: corte en el vértice 0')
  igual([undefined, [0, 1], [0, 2]], [{ from: 1, path: [[0, 1], [0, 2]] }], 'salida: undefined en el vértice 0')
  igual([null, [[0, 1], [0, 2]]], [{ from: 0, path: [[0, 1], [0, 2]] }], 'salida: parte nula en el anidado')
  igual([[NaN, 0], [0, 1], [NaN, 0], [NaN, 0], [0, 5], [0, 6], [0, 7], [NaN, 0], [0, 9], [0, 10]],
    [{ from: 4, path: [[0, 5], [0, 6], [0, 7]] }, { from: 8, path: [[0, 9], [0, 10]] }],
    'salida: cortes en cabeza, consecutivos e intermedios')
  igual([[[0, 0], [0, 1], [NaN, NaN], [0, 3], [0, 4]], null, [[0, 8]], [[0, 9], [0, 10]]],
    [{ from: 0, path: [[0, 0], [0, 1]] }, { from: 3, path: [[0, 3], [0, 4]] }, { from: 6, path: [[0, 9], [0, 10]] }],
    'salida: anidado con hueco interno, parte nula y parte degenerada')
  igual([Float64Array.of(0, 0), Float64Array.of(0, 1)], [{ from: 0, path: [[0, 0], [0, 1]] }],
    'salida: vértices tipados salen como pares planos')

  // Un elemento sin nada que lo decida —vacío, nulo, o una parte con un vértice nulo en la cabeza— no
  // define el encoding: decide el primero que trae algo.
  igual([[], [[0, 1], [0, 2]]], [{ from: 0, path: [[0, 1], [0, 2]] }],
    'salida: anidado que arranca con una parte vacía')
  igual([[null], [[0, 1], [0, 2]]], [{ from: 1, path: [[0, 1], [0, 2]] }],
    'salida: anidado que arranca con [null]')
  igual([[null, [0, 1], [0, 2]]], [{ from: 1, path: [[0, 1], [0, 2]] }],
    'salida: anidado cuya parte arranca con un vértice nulo')
  igual([[], [0, 1], [0, 2]], [{ from: 1, path: [[0, 1], [0, 2]] }],
    'salida: plano con un par vacío en cabeza')
  igual([[undefined, undefined], [0, 1], [0, 2]], [{ from: 1, path: [[0, 1], [0, 2]] }],
    'salida: plano con un par sin componentes en cabeza')
  // Un vértice decide por su lat y su lng, como se lee el punto: una cola —una altura, un objeto— no
  // cuenta. Si nada decide, el path es anidado cuando trae un array: una parte vacía no aporta nada.
  const cola = { t: 1 }
  igual([[null, null, cola], [0, 1, cola], [0, 2, cola]], [{ from: 1, path: [[0, 1], [0, 2]] }],
    'salida: plano cuyo vértice 0 no trae lat ni lng, y sí una cola objeto')
  igual([[null, null, [0, 1], [0, 2]]], [{ from: 2, path: [[0, 1], [0, 2]] }],
    'salida: anidado cuya única parte arranca con dos vértices nulos')
  igual([{ lat: 0 }, 5, 'ab', [[0, 1], [0, 2]]], [{ from: 0, path: [[0, 1], [0, 2]] }],
    'salida: lo que no es iterable no decide, no revienta ni ocupa índice en el anidado')
  // Un string se recorre, pero no es un iterable del path: en la cabeza de un plano es un vértice
  // sucio, que corta sin decidir el encoding.
  igual(['N/A', [0, 1], [0, 2], [0, 3]], [{ from: 1, path: [[0, 1], [0, 2], [0, 3]] }],
    'salida: un string en la cabeza de un plano corta, no vuelve anidado al path')

  // Una parte puede ser cualquier iterable y un vértice, una vista tipada: el anidado sale igual que
  // con arrays, sin consumir la parte al decidir el encoding ni correr el `from` de las siguientes.
  const a = [[0, 0], [0, 1], [0, 2]], b = [[0, 5], [0, 6]]
  const enPartes = [{ from: 0, path: a }, { from: 3, path: b }]
  const gen = function* (xs) { yield* xs }
  igual([a.values(), b.values()], enPartes, 'salida: partes iterador')
  igual([gen(a), gen(b)], enPartes, 'salida: partes generador')
  igual([new Set(a), new Set(b)], enPartes, 'salida: partes Set')
  igual(gen([gen(a), gen(b)]), enPartes, 'salida: generador de generadores')
  igual([a, b].map(part => part.map(p => Float64Array.from(p))), enPartes, 'salida: anidado con vértices tipados')

  // Los pares salen COPIADOS y recortados a [lat, lng]: una tercera componente (altura) no viaja, y
  // mutar la salida no toca la entrada.
  const conAltura = [[0, 0, 500], [0, 1, 510]]
  const [{ path }] = toParts(conAltura)
  ok(isDeepStrictEqual(path, [[0, 0], [0, 1]]), 'salida: el par se recorta a [lat, lng]')
  ok(path[0] !== conAltura[0], 'salida: el par es una copia, no el vértice de la entrada')
}

// ── toParts: las cuatro formas de punto, una sola salida ──
// Un punto entra como par, vista tipada, `{ lat, lng }`, `{ lat, lon }` o `{ latitude, longitude }`,
// y sale siempre como par. El discriminador plano/anidado mira puntos: un anidado de objetos se lee
// como anidado aunque su primera parte llegue sucia en la cabeza.
{
  const pares = [[0, 0], [0, 1], [0, 2]]
  const formas = {
    'par'                     : pares,
    'vista tipada'            : pares.map(p => Float64Array.from(p)),
    '{ lat, lng }'            : pares.map(([lat, lng]) => ({ lat, lng })),
    '{ lat, lon }'            : pares.map(([lat, lon]) => ({ lat, lon })),
    '{ latitude, longitude }' : pares.map(([latitude, longitude]) => ({ latitude, longitude })),
  }
  for (const [nombre, path] of Object.entries(formas)) {
    igual(path, [{ from: 0, path: pares }], `forma ${nombre}: plano`)
    igual([path.slice(0, 2), path.slice(1)], [{ from: 0, path: pares.slice(0, 2) }, { from: 2, path: pares.slice(1) }],
      `forma ${nombre}: anidado`)
  }
  igual([[0, 0], { lat: 0, lon: 1 }, { latitude: 0, longitude: 2 }], [{ from: 0, path: pares }], 'formas mezcladas')

  const cabeza = { lat: NaN, lng: 0 }
  igual([[cabeza, { lat: 0, lng: 1 }, { lat: 0, lng: 2 }], [{ lat: 0, lng: 5 }, { lat: 0, lng: 6 }]],
    [{ from: 1, path: [[0, 1], [0, 2]] }, { from: 3, path: [[0, 5], [0, 6]] }],
    'anidado de objetos con la cabeza sucia: sigue anidado')
  igual([[null, { lat: 0, lng: 1 }, { lat: 0, lng: 2 }]], [{ from: 1, path: [[0, 1], [0, 2]] }],
    'anidado de objetos con un nulo en la cabeza')

  // Lo que no es un punto corta: un string que parece número, un método, una forma a medias o
  // cruzada, un componente no finito, un primitivo suelto.
  const noPuntos = [
    { lat: '0', lng: '5' }, { lat: () => 0, lng: () => 5 }, { lat: 0 }, { lng: 5 }, { latitude: 0, lng: 5 },
    { lat: 0, longitude: 5 }, { lat: NaN, lng: 5 }, { lat: 0, lon: Infinity }, 5, 'ab', true,
  ]
  noPuntos.forEach((malo, k) => igual([[0, 0], [0, 1], malo, [0, 3], [0, 4]],
    [{ from: 0, path: [[0, 0], [0, 1]] }, { from: 3, path: [[0, 3], [0, 4]] }], `no es punto, corta: caso ${k}`))

  // En un plano de objetos decide el primer punto: nada de lo que venga después —un string, un
  // anidado perdido— lo vuelve anidado, y lo que no es punto corta.
  const objetos = [0, 1, 2, 3, 4].map(lng => ({ lat: 0, lng }))
  const cortado = [{ from: 0, path: [[0, 0], [0, 1]] }, { from: 3, path: [[0, 3], [0, 4]] }]
  for (const malo of ['', 'ab', [[0, 9], [0, 9]], new Set([[0, 9]])])
    igual([objetos[0], objetos[1], malo, objetos[3], objetos[4]], cortado, `plano de objetos con ${JSON.stringify(malo)}`)
  const iterablePunto = (lat, lng) => ({ lat, lng, *[Symbol.iterator]() { yield lat; yield lng } })
  igual([0, 1, 2].map(lng => iterablePunto(0, lng)), [{ from: 0, path: pares }],
    'un punto objeto iterable es un vértice, no una parte')

  // La latitud tiene que caer en [-90, 90]: una fila con lat y lng cruzadas fuera de ese rango corta.
  igual([[37.77, -122.42], [37.78, -122.42], [-122.43, 37.79], [37.80, -122.43], [37.81, -122.44]],
    [{ from: 0, path: [[37.77, -122.42], [37.78, -122.42]] }, { from: 3, path: [[37.80, -122.43], [37.81, -122.44]] }],
    'una latitud fuera de rango corta')
  igual([[90, 0], { lat: -90, lng: 0 }, { latitude: 90.0000001, longitude: 0 }], [{ from: 0, path: [[90, 0], [-90, 0]] }],
    'los polos son puntos; un poco más allá, no')
}

// ── mapeo buffer↔dato multi-parte: el gradiente lee el índice de la ENTRADA (replica de #applyGradient) ──
{
  const pathIndexOf = (v) => (v + 1) >> 1
  // [p0, p1, BAD, p3, p4] → parte A (from 0, 2 pts) + parte B (from 3, 2 pts); 2 vértices cada una
  const parts = toParts([[0, 0], [0, 1], [NaN, NaN], [0, 8], [0, 9]])
  let vertOffset = 0
  const runs = parts.map(({ path, from }) => {
    const run = { vertOffset, vertCount: 2 * (path.length - 1), from }
    vertOffset += run.vertCount
    return run
  })
  ok(runs.length === 2 && vertOffset === 4, '2 partes de 2 puntos = 4 vértices en total')
  ok(runs[0].vertOffset === 0 && runs[1].vertOffset === 2, 'las partes son CONTIGUAS en el buffer')

  const leidos = runs.flatMap(({ vertCount, from }) =>
    Array.from({ length: vertCount }, (_, k) => from + pathIndexOf(k)))
  ok(leidos.join(',') === '0,1,3,4', 'scalarOf se lee en [0,1,3,4] — saltando el índice del corte')
}

// ── picking multi-parte: UNA entidad con partes disjuntas → UN hit, la parte más cercana ──
{
  const idxM = idxOf([{ id: 77, parts: [[[0, 0], [0, 5]], [[0, 20], [0, 30]]] }])
  ok(idxM.sorted.length === 2, 'el índice guarda una entrada POR PARTE (bboxes ajustadas)')

  const enParte0 = nearest(0, 2, idxM, 0.5)
  ok(enParte0.length === 1 && enParte0[0].partIndex === 0, 'clic sobre la parte 0 → un hit, partIndex 0')

  const enParte1 = nearest(0, 25, idxM, 0.5)
  ok(enParte1.length === 1 && enParte1[0].partIndex === 1, 'clic sobre la parte 1 → un hit, partIndex 1')

  // 🔴 el hueco (lng 5..20) NO es parte de la línea: ahí no debe haber hit
  ok(nearest(0, 12, idxM, 0.5).length === 0, 'el HUECO entre partes no pica (no hay recta puenteando)')

  // con tol enorme ambas partes entran al narrow-phase → igual UN solo hit, el de la parte más cercana
  const ambas = nearest(0, 6, idxM, 100)
  ok(ambas.length === 1, 'ambas partes dentro de tol → sigue siendo UN hit por id')
  ok(ambas[0].partIndex === 0, 'gana la parte más cercana (la 0, a lng 5 vs la 1 a lng 20)')

  // …y el desempate funciona en el otro sentido, con la parte 1 más cerca
  ok(nearest(0, 19, idxM, 100)[0].partIndex === 1, 'desempate simétrico: gana la parte 1')
}

// ── el hit es CRUZABLE con el dato: vertexIndex vive en el espacio de la ENTRADA, no de la parte ──
{
  // [p0,p1,CORTE,p3,p4,p5]: la 2ª parte arranca en el índice de entrada 3
  const idxC = idxOf([{ id: 5, path: [[0, 0], [0, 1], [NaN, NaN], [0, 3], [0, 4], [0, 5]] }])
  const h = nearest(0, 3.5, idxC, 0.5)
  ok(h.length === 1 && h[0].partIndex === 1, 'hit en la 2ª parte')
  ok(h[0].vertexIndex === 3, 'vertexIndex 3 = espacio de la ENTRADA (from 3 + segmento 0), no 0')
  // el mismo índice sirve para indexar un array paralelo de escalares
  const vel = [10, 20, null, 30, 40, 50]
  ok(vel[h[0].vertexIndex] === 30, 'el vertexIndex indexa el escalar paralelo sin desalineo')
}

// ── orden del índice: la clave es maxX (con minX el broad-phase pierde hits) ──
{
  // maxX = [10, 5, 20] si se ordenara por minX → secuencia no monótona → el binario saltea
  const idxO = idxOf([
    { id: 'A', path: [[0, 0], [0, 10]] },
    { id: 'B', path: [[0, 4], [0, 5]] },
    { id: 'C', path: [[0, 15], [0, 20]] },
  ])
  nearest(0, 0, idxO, 1)
  const maxs = idxO.sorted.map((e) => e.bbox.maxX)
  ok(maxs.every((v, i) => i === 0 || maxs[i - 1] <= v), 'el primer nearest deja el índice ordenado por maxX ascendente')
  ok(nearest(0, 9.5, idxO, 0.1).map((h) => h.id).join(',') === 'A', 'la línea bajo el cursor pica (no la saltea el binario)')
}

// ── borde EXACTO de la tolerancia (sin margen: es la invariante que documenta lowerBound) ──
{
  const idxT = idxOf([{ id: 9, path: [[0, 5], [1, 5]] }])
  const tolExact = projX0(5.0001) - projX0(5)
  ok(nearest(0.5, 5.0001, idxT, tolExact).length === 1, 'distancia == tol: INCLUIDO (borde inclusivo)')
}

// ── borde INCLUSIVO del broad-phase: una línea cuyo borde este cae exacto a tol no se pierde ──
{
  // línea vertical en lng=5, lat 0..1; consulta a la derecha a distancia ~tol del extremo este
  const idxB = idxOf([{ id: 9, path: [[0, 5], [1, 5]] }])
  const tolExact = projX0(5.0001) - projX0(5)   // ~ distancia world0 px de 0.0001° lng
  const hits = nearest(0.5, 5.0001, idxB, tolExact * 1.001)
  ok(hits.length === 1 && hits[0].id === 9, 'borde este a ~tol: incluido (lowerBound inclusivo)')
}

// ── sampleAlong: muestreo equiespaciado con rumbo (flechas por composición) ──
{
  ok(sampleAlong(null, 4).length === 0, 'sampleAlong(null) = []')
  ok(sampleAlong([[0, 0]], 4).length === 0, 'sampleAlong con 1 punto = []')
  ok(sampleAlong([[0, 0], [0, 10]], 0).length === 0, 'count 0 = []')
  ok(sampleAlong([[5, 5], [5, 5]], 3).length === 0, 'path degenerado (largo 0) = []')

  // línea al ESTE (lng creciente, lat constante) → heading 90
  const este = sampleAlong([[0, 0], [0, 10]], 1)
  ok(este.length === 1, 'count 1 → 1 muestra')
  ok(approx(este[0].heading, 90, 1e-6), 'rumbo ESTE = 90°')
  ok(approx(este[0].lng, 5, 1e-9), 'count 1 cae en el medio (lng 5)')

  // línea al NORTE (lat creciente) → heading 0
  const norte = sampleAlong([[0, 0], [10, 0]], 1)
  ok(approx(norte[0].heading, 0, 1e-6), 'rumbo NORTE = 0°')

  // línea al OESTE → 270 ; al SUR → 180
  ok(approx(sampleAlong([[0, 10], [0, 0]], 1)[0].heading, 270, 1e-6), 'rumbo OESTE = 270°')
  ok(approx(sampleAlong([[10, 0], [0, 0]], 1)[0].heading, 180, 1e-6), 'rumbo SUR = 180°')

  // equiespaciado centrado: count 2 sobre 0..10 → lng 2.5 y 7.5
  const dos = sampleAlong([[0, 0], [0, 10]], 2)
  ok(dos.length === 2, 'count 2 → 2 muestras')
  ok(approx(dos[0].lng, 2.5, 1e-9) && approx(dos[1].lng, 7.5, 1e-9), 'muestras centradas (25% y 75%)')

  // en un path en L, la 2ª mitad toma el rumbo del 2º tramo
  const ele = sampleAlong([[0, 0], [0, 10], [10, 10]], 2)
  ok(approx(ele[0].heading, 90, 1e-6), 'L: 1ª muestra rumbo ESTE')
  ok(approx(ele[1].heading, 0, 1e-6), 'L: 2ª muestra rumbo NORTE (cambió de tramo)')

  // 🔴 multi-parte: NO puede devolver NaN ni muestrear sobre el hueco (antes daba NaN en todo)
  const conHueco = sampleAlong([[0, 0], [0, 2], [NaN, NaN], [0, 10], [0, 12]], 2)
  ok(conHueco.length === 2, 'path con bache → 2 muestras')
  ok(conHueco.every((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng)), 'ninguna muestra es NaN')
  ok(conHueco.every((m) => m.lng <= 2 || m.lng >= 10), 'ninguna muestra cae DENTRO del hueco (2..10)')

  // …y acepta el encoding anidado igual que el resto del módulo
  const anidado = sampleAlong([[[0, 0], [0, 2]], [[0, 10], [0, 12]]], 2)
  ok(anidado.every((m) => Number.isFinite(m.lng)), 'encoding anidado: muestras finitas')
  ok(approx(anidado[0].lng, 1) && approx(anidado[1].lng, 11), 'una muestra por parte, centrada en cada una')
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} ok, ${fail} fallidos`)
process.exit(fail === 0 ? 0 : 1)
