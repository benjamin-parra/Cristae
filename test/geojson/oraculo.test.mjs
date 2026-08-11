// Pruebas del ORÁCULO contra sí mismo (SPECS §17).
//
// Un oráculo sin probar no es un oráculo: es una segunda implementación sin revisar que va a
// congelar sus propios errores en cada fixture del corpus. Por eso las tablas de acá están
// escritas A MANO, leídas del contrato, y no salen de correr el oráculo y copiar la salida —
// hacer eso lo dejaría midiéndose contra su propio reflejo, exactamente el vicio que el corpus
// existe para evitar del lado del lector.

import test from 'node:test'
import assert from 'node:assert/strict'

import { oraculo, comparar, GeoJsonKind } from './oraculo.mjs'

// Las tablas se contratan como arrays tipados (§17.1); acá se aplanan a arrays comunes para que
// el literal escrito a mano sea el que se lee en el diff cuando un test falla.
const plano = s => ({
  geometryAt : [...s.geometryAt],
  partAt     : [...s.partAt],
  ringAt     : [...s.ringAt],
  vertexAt   : [...s.vertexAt],
  kinds      : [...s.kinds],
  featureOf  : [...s.featureOf],
  closed     : [...s.closed],
  xy         : [...s.xy],
  z          : s.z === null ? null : [...s.z],
  conteos    : s.conteos,
})

// ── los siete tipos y la degeneración a cuatro niveles ────────────────────────────────────────

test('Point suelto: el documento es su propio feature y degenera a 1 parte / 1 anillo / 1 vértice', () => {
  const doc = { type: 'Point', coordinates: [-70.6693, -33.4489] }

  assert.deepStrictEqual(plano(oraculo(doc)), {
    geometryAt : [0, 1],
    partAt     : [0, 1],
    ringAt     : [0, 1],
    vertexAt   : [0, 1],
    kinds      : [GeoJsonKind.Point],
    featureOf  : [0],
    closed     : [0],
    xy         : [-70.6693, -33.4489],
    z          : null,
    conteos    : { f: 1, g: 1, p: 1, r: 1, v: 1 },
  })
})

test('MultiPoint es UN anillo de N vértices, no N anillos de 1; LineString comparte su forma', () => {
  const doc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { n: 'a' }, geometry: { type: 'MultiPoint',  coordinates: [[0, 0], [1, 1], [2, 2]] } },
      { type: 'Feature', properties: null,       geometry: { type: 'LineString',  coordinates: [[3, 3], [4, 4]] } },
    ],
  }

  assert.deepStrictEqual(plano(oraculo(doc)), {
    geometryAt : [0, 1, 2],
    partAt     : [0, 1, 2],
    ringAt     : [0, 1, 2],
    vertexAt   : [0, 3, 5],
    kinds      : [GeoJsonKind.MultiPoint, GeoJsonKind.LineString],
    featureOf  : [0, 1],
    closed     : [0, 0],
    xy         : [0, 0, 1, 1, 2, 2, 3, 3, 4, 4],
    z          : null,
    conteos    : { f: 2, g: 2, p: 2, r: 2, v: 5 },
  })
})

test('Polygon con hoyo: 1 parte, 2 anillos, los dos cerrados por el RFC §3.1.6', () => {
  const doc = {
    type: 'Feature',
    properties: { nombre: 'predio' },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
        [[1, 1], [2, 1], [2, 2], [1, 1]],
      ],
    },
  }

  assert.deepStrictEqual(plano(oraculo(doc)), {
    geometryAt : [0, 1],
    partAt     : [0, 1],
    ringAt     : [0, 2],
    vertexAt   : [0, 5, 9],
    kinds      : [GeoJsonKind.Polygon],
    featureOf  : [0],
    closed     : [1, 1],
    xy         : [0, 0, 4, 0, 4, 4, 0, 4, 0, 0,
                  1, 1, 2, 1, 2, 2, 1, 1],
    z          : null,
    conteos    : { f: 1, g: 1, p: 1, r: 2, v: 9 },
  })
})

test('MultiPolygon: la parte ata cada anillo a SU polígono, y el anillo abierto se cuenta, no se corrige', () => {
  // El caso que §17.1 usa para justificar el nivel `parte`: sin él, el anillo 1 podría leerse como
  // exterior del polígono 1 en vez de hoyo del polígono 0. El tercer anillo viene abierto a
  // propósito — §17.3-5: el lector cuenta la violación, no la arregla.
  const doc = {
    type: 'MultiPolygon',
    coordinates: [
      [[[0, 0], [2, 0], [2, 2], [0, 0]], [[0.5, 0.5], [1, 0.5], [1, 1], [0.5, 0.5]]],
      [[[10, 10], [12, 10], [12, 12]]],
    ],
  }

  assert.deepStrictEqual(plano(oraculo(doc)), {
    geometryAt : [0, 1],
    partAt     : [0, 2],
    ringAt     : [0, 2, 3],
    vertexAt   : [0, 4, 8, 11],
    kinds      : [GeoJsonKind.MultiPolygon],
    featureOf  : [0],
    closed     : [1, 1, 0],
    xy         : [0, 0, 2, 0, 2, 2, 0, 0,
                  0.5, 0.5, 1, 0.5, 1, 1, 0.5, 0.5,
                  10, 10, 12, 10, 12, 12],
    z          : null,
    conteos    : { f: 1, g: 1, p: 2, r: 3, v: 11 },
  })
})

// Comparte profundidad 3 con Polygon y aun así normaliza distinto: la tabla de §17.1 va por TIPO, no
// por forma. Una línea es una sub-geometría independiente, así que es su propia parte; meter las dos
// en una sola parte diría que son los anillos de un mismo polígono, que es exactamente la pertenencia
// que el nivel existe para no perder.
test('MultiLineString son N partes de 1 anillo, no 1 parte de N anillos (§17.1)', () => {
  const doc = { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3], [4, 4]]] }

  assert.deepStrictEqual(plano(oraculo(doc)), {
    geometryAt : [0, 1],
    partAt     : [0, 2],
    ringAt     : [0, 1, 2],
    vertexAt   : [0, 2, 5],
    kinds      : [GeoJsonKind.MultiLineString],
    featureOf  : [0],
    closed     : [0, 0],
    xy         : [0, 0, 1, 1, 2, 2, 3, 3, 4, 4],
    z          : null,
    conteos    : { f: 1, g: 1, p: 2, r: 2, v: 5 },
  })
})

// El contraste que fija la tabla: mismo anidamiento que el de arriba, reparto opuesto. Si algún día
// los dos vuelven a normalizar igual, uno de estos dos tests se pone en rojo.
test('Polygon con hoyo es 1 parte de N anillos: la pertenencia anillo→polígono se preserva (§17.1)', () => {
  const doc = { type: 'Polygon', coordinates: [[[0, 0], [9, 0], [9, 9], [0, 0]], [[3, 3], [4, 3], [4, 4], [3, 3]]] }
  const r   = plano(oraculo(doc))

  assert.deepStrictEqual([r.partAt, r.ringAt, r.conteos.p, r.conteos.r], [[0, 1], [0, 2], 1, 2])
})

// Un punto no tiene interior, así que entre sus posiciones no hay pertenencia que preservar: agrupar
// no pierde nada y evita que una capa de N puntos multiplique las tablas por N.
test('MultiPoint es la excepción: 1 parte, 1 anillo, N vértices (§17.1)', () => {
  const doc = { type: 'MultiPoint', coordinates: [[0, 0], [1, 1], [2, 2]] }
  const r   = plano(oraculo(doc))

  assert.deepStrictEqual([r.partAt, r.ringAt, r.vertexAt], [[0, 1], [0, 1], [0, 3]])
})

// §17.3-14: un contenedor vacío ANIDADO ocupa ranura, y el nivel lo fija el tipo — la forma no puede,
// porque `[[]]` es indistinguible entre «un anillo sin posiciones» y «una parte sin anillos».
test('el contenedor vacío anidado se ubica por el tipo, no por la forma (§17.3-14)', () => {
  const poly  = plano(oraculo({ type: 'Polygon', coordinates: [[]] }))
  const multi = plano(oraculo({ type: 'MultiPolygon', coordinates: [[]] }))

  assert.deepStrictEqual([poly.partAt, poly.ringAt, poly.vertexAt], [[0, 1], [0, 1], [0, 0]],
    'Polygon [[]] es una parte con UN anillo vacío')
  assert.deepStrictEqual([multi.partAt, multi.ringAt, multi.vertexAt], [[0, 1], [0, 0], [0]],
    'MultiPolygon [[]] es una parte SIN anillos')
})

// ── GeometryCollection ────────────────────────────────────────────────────────────────────────

test('GeometryCollection anidada se aplana en profundidad y todas las hojas quedan en el mismo feature', () => {
  const doc = {
    type: 'Feature',
    geometry: {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [5, 5] },
        {
          type: 'GeometryCollection',
          geometries: [
            { type: 'LineString', coordinates: [[6, 6], [7, 7]] },
            { type: 'Point',      coordinates: [8, 8] },
          ],
        },
      ],
    },
  }

  assert.deepStrictEqual(plano(oraculo(doc)), {
    geometryAt : [0, 3],
    partAt     : [0, 1, 2, 3],
    ringAt     : [0, 1, 2, 3],
    vertexAt   : [0, 1, 3, 4],
    kinds      : [GeoJsonKind.Point, GeoJsonKind.LineString, GeoJsonKind.Point],
    featureOf  : [0, 0, 0],
    closed     : [0, 0, 0],
    xy         : [5, 5, 6, 6, 7, 7, 8, 8],
    z          : null,
    conteos    : { f: 1, g: 3, p: 3, r: 3, v: 4 },
  })
})

test('el aplanado es idempotente: envolver las mismas hojas en una colección más no cambia nada', () => {
  const hojas = [
    { type: 'Point',      coordinates: [5, 5] },
    { type: 'LineString', coordinates: [[6, 6], [7, 7]] },
  ]
  const llano   = { type: 'GeometryCollection', geometries: hojas }
  const envuelto = { type: 'GeometryCollection', geometries: [{ type: 'GeometryCollection', geometries: hojas }] }

  assert.deepStrictEqual(comparar(oraculo(llano), oraculo(envuelto)), [])
})

// ── posiciones 2D / 3D ────────────────────────────────────────────────────────────────────────

test('posiciones de 2 y 3 números mezcladas en el MISMO anillo: xy con stride 2 y la altitud en z', () => {
  const doc = { type: 'LineString', coordinates: [[0, 0], [1, 1, 7], [0, 0]] }

  assert.deepStrictEqual(plano(oraculo(doc)), {
    geometryAt : [0, 1],
    partAt     : [0, 1],
    ringAt     : [0, 1],
    vertexAt   : [0, 3],
    kinds      : [GeoJsonKind.LineString],
    featureOf  : [0],
    closed     : [1],                        // la última posición repite a la primera, y las dos son 2D
    xy         : [0, 0, 1, 1, 0, 0],
    z          : [NaN, 7, NaN],              // NaN = la posición era 2D (§17.1)
    conteos    : { f: 1, g: 1, p: 1, r: 1, v: 3 },
  })
})

test('z es del DOCUMENTO: una sola posición 3D lo saca del caso `z: null`', () => {
  const doc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point',      coordinates: [0, 0] } },
      { type: 'Feature', geometry: { type: 'MultiPoint', coordinates: [[1, 1], [2, 2, 5]] } },
    ],
  }

  assert.deepStrictEqual(plano(oraculo(doc)), {
    geometryAt : [0, 1, 2],
    partAt     : [0, 1, 2],
    ringAt     : [0, 1, 2],
    vertexAt   : [0, 1, 3],
    kinds      : [GeoJsonKind.Point, GeoJsonKind.MultiPoint],
    featureOf  : [0, 1],
    closed     : [0, 0],
    xy         : [0, 0, 1, 1, 2, 2],
    z          : [NaN, NaN, 5],
    conteos    : { f: 2, g: 2, p: 2, r: 2, v: 3 },
  })
})

test('el cierre compara la POSICIÓN entera: un último 3D no cierra contra un primero 2D', () => {
  const mismaDimension  = oraculo({ type: 'LineString', coordinates: [[0, 0], [1, 1], [0, 0]] })
  const dimensionDistinta = oraculo({ type: 'LineString', coordinates: [[0, 0], [1, 1], [0, 0, 0]] })

  assert.deepStrictEqual([...mismaDimension.closed],   [1])
  assert.deepStrictEqual([...dimensionDistinta.closed], [0])
})

test('un anillo de un solo vértice no está cerrado: `count - closed[r]` lo dejaría en cero', () => {
  assert.deepStrictEqual([...oraculo({ type: 'Point', coordinates: [3, 4] }).closed], [0])
})

// ── bordes que §17.9 declara legales ──────────────────────────────────────────────────────────

test('`"coordinates": []` es geometría vacía legal: 0 partes, 0 anillos — no error de estructura', () => {
  const doc = { type: 'Polygon', coordinates: [] }

  assert.deepStrictEqual(plano(oraculo(doc)), {
    geometryAt : [0, 1],
    partAt     : [0, 0],
    ringAt     : [0],
    vertexAt   : [0],
    kinds      : [GeoJsonKind.Polygon],
    featureOf  : [0],
    closed     : [],
    xy         : [],
    z          : null,
    conteos    : { f: 1, g: 1, p: 0, r: 0, v: 0 },
  })
})

test('`geometry: null` da un feature sin geometrías: geometryAt[i] === geometryAt[i+1]', () => {
  const doc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: null },
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [9, 9] } },
    ],
  }

  assert.deepStrictEqual(plano(oraculo(doc)), {
    geometryAt : [0, 0, 1],
    partAt     : [0, 1],
    ringAt     : [0, 1],
    vertexAt   : [0, 1],
    kinds      : [GeoJsonKind.Point],
    featureOf  : [1],
    closed     : [0],
    xy         : [9, 9],
    z          : null,
    conteos    : { f: 2, g: 1, p: 1, r: 1, v: 1 },
  })
})

test('los atributos hermanos de `geometry` también son un feature (§17.4): no se exige `type: "Feature"`', () => {
  const conType = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { id: 7 }, geometry: { type: 'Point', coordinates: [1, 2] } }] }
  const sinType = { type: 'FeatureCollection', features: [{ id: 7, nombre: 'x', geometry: { type: 'Point', coordinates: [1, 2] } }] }

  assert.deepStrictEqual(comparar(oraculo(conType), oraculo(sinType)), [])
})

// ── el orden de los miembros y el envase de la entrada ────────────────────────────────────────

test('`type` después de `coordinates` da la misma salida: el RFC §3 declara el orden irrelevante', () => {
  const texto = '{"coordinates":[[[0,0],[2,0],[2,2],[0,0]]],"type":"Polygon"}'
  const orden = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] }

  assert.deepStrictEqual(comparar(oraculo(texto), oraculo(orden)), [])
})

test('texto, Uint8Array y Buffer pooled dan la misma salida que el objeto ya parseado', () => {
  const texto = '{"type":"MultiPoint","coordinates":[[1,2,3],[4,5]]}'
  const bytes = new TextEncoder().encode(texto)
  // `Buffer.concat` de tres trozos vive en el pool compartido de Node con byteOffset ≠ 0: el
  // envase que §17.3-6 usa para exigir que la vista se respete en vez del ArrayBuffer entero.
  const pooled = Buffer.concat([Buffer.from(texto.slice(0, 10)), Buffer.from(texto.slice(10, 30)), Buffer.from(texto.slice(30))])

  const esperado = oraculo(JSON.parse(texto))
  assert.deepStrictEqual(comparar(esperado, oraculo(texto)),  [])
  assert.deepStrictEqual(comparar(esperado, oraculo(bytes)),  [])
  assert.deepStrictEqual(comparar(esperado, oraculo(pooled)), [])
  assert.notEqual(pooled.byteOffset, 0)
})

// ── comparar ──────────────────────────────────────────────────────────────────────────────────

const conCambio = (s, tabla, i, valor) => {
  const copia = { ...s, [tabla]: s[tabla].slice() }
  copia[tabla][i] = valor
  return copia
}

const dosFeatures = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'MultiPoint', coordinates: [[0, 0], [1, 1], [2, 2]] } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[3, 3], [4, 4]] } },
  ],
}

test('comparar: salidas idénticas no producen diferencias', () => {
  assert.deepStrictEqual(comparar(oraculo(dosFeatures), oraculo(dosFeatures)), [])
})

test('comparar nombra la TABLA y el índice, y traduce el índice de xy a vértice + eje', () => {
  const a = oraculo(dosFeatures)
  assert.deepStrictEqual(comparar(a, conCambio(a, 'xy', 2, 99)), ['xy[2] (vértice 1, lng): 1 ≠ 99'])
  assert.deepStrictEqual(comparar(a, conCambio(a, 'xy', 5, 99)), ['xy[5] (vértice 2, lat): 2 ≠ 99'])
  assert.deepStrictEqual(comparar(a, conCambio(a, 'vertexAt', 1, 4)), ['vertexAt[1]: 3 ≠ 4'])
})

test('comparar distingue largos y sigue comparando el prefijo común', () => {
  const a = oraculo(dosFeatures)
  const b = { ...a, kinds: a.kinds.slice(0, 1) }

  assert.deepStrictEqual(comparar(a, b), ['kinds: largo 2 ≠ 1'])
  assert.deepStrictEqual(comparar(a, { ...b, kinds: Uint8Array.from([9]) }), ['kinds: largo 2 ≠ 1', 'kinds[0]: 2 ≠ 9'])
})

test('comparar trata `z: null` (documento 2D) como distinto de un z vacío de altitudes', () => {
  const a = oraculo(dosFeatures)

  assert.deepStrictEqual(comparar(a, { ...a, z: new Float64Array(5) }), ['z: uno es null (documento 2D) y el otro trae 5 entradas'])
})

test('comparar separa NaN de NaN y -0 de 0, que es donde una igualdad laxa taparía el error', () => {
  const a = oraculo({ type: 'LineString', coordinates: [[0, 0], [1, 1, 7]] })

  assert.deepStrictEqual(comparar(a, conCambio(a, 'z', 0, 0)), ['z[0]: NaN ≠ 0'])
  assert.deepStrictEqual(comparar(a, conCambio(a, 'xy', 0, -0)), ['xy[0] (vértice 0, lng): 0 ≠ -0'])
})

test('comparar corta el chorro por tabla y dice cuántas quedaron', () => {
  const a = oraculo(dosFeatures)
  const b = { ...a, xy: a.xy.map(n => n + 1) }

  assert.deepStrictEqual(comparar(a, b, { maxPorTabla: 2 }), [
    'xy[0] (vértice 0, lng): 0 ≠ 1',
    'xy[1] (vértice 0, lat): 0 ≠ 1',
    'xy: … y 8 diferencias más',
  ])
})

test('comparar ignora lo que el lector trae de más y avisa si falta una salida entera', () => {
  const a = oraculo(dosFeatures)
  const conExtras = { ...a, propAt: Uint32Array.from([0, 10]), idAt: Uint32Array.from([0, 0]), bytes: null, stats: {} }

  assert.deepStrictEqual(comparar(a, conExtras), [])
  assert.deepStrictEqual(comparar(a, null), ['comparar: falta la salida b'])
})

test('comparar contrasta los conteos sólo cuando los dos lados los traen', () => {
  const a = oraculo(dosFeatures)

  assert.deepStrictEqual(comparar(a, { ...a, conteos: { ...a.conteos, v: 99 } }), ['conteos.v: 5 ≠ 99'])
  assert.deepStrictEqual(comparar(a, { ...a, conteos: undefined }), [])
})

// ── el oráculo se planta donde §17 no decide ──────────────────────────────────────────────────

test('lo que el contrato no determina se planta en vez de inventar una salida', () => {
  const casos = [
    [{ type: 'Point',      coordinates: [1, 2, 3, 4] },       /2 o 3/],
    [{ type: 'Point',      coordinates: [1] },                /2 o 3/],
    [{ type: 'Point' },                                       /coordinates/],
    // El type desconocido se prueba ANIDADO: en la raíz no se distingue de "esto no es un
    // documento GeoJSON", y ahí la plantada correcta es la de la raíz irreconocible.
    [{ type: 'Feature', geometry: { type: 'Circle', coordinates: [0, 0] } },      /no es una de las seis/],
    [{ type: 'Feature', geometry: { type: 'constructor', coordinates: [0, 0] } }, /no es una de las seis/],
    [{ type: 'MultiPolygon', coordinates: [[[[[0, 0]]]]] },   /anidado 5 niveles/],
    [{ type: 'Point',      coordinates: ['1', 2] },           /no numérico o no finito/],
    [{ type: 'GeometryCollection' },                          /GeometryCollection sin/],
    [[{ type: 'Point', coordinates: [0, 0] }],                /raíz no es un objeto/],
    [{ type: 'Topology', objects: {} },                       /raíz irreconocible/],
  ]

  casos.forEach(([doc, patron]) => assert.throws(() => oraculo(doc), patron, JSON.stringify(doc)))
})
