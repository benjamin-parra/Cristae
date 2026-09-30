// Cajas en grados (geometry/bounds.js): `boundsOf` lee con las formas de llamada y de punto de
// `distance`, y `boundsPad`, `boundsContain` y `boundsCenter` leen la caja con un solo lector. Las cajas
// esperadas van escritas a mano.
// Corre con: node --test test/geometry/bounds.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { boundsOf, boundsPad, boundsContain, boundsCenter } from '../../src/geometry/bounds.js'

const caja = (south, west, north, east) => ({ south, west, north, east })

// ── boundsOf ──────────────────────────────────────────────────────────────────

test('boundsOf da la misma caja por puntos variádicos, por un path plano y por uno anidado', () => {
  const esperada = caja(-34, -71, -33, -70)
  const formas   = {
    par      : ([lat, lng]) => [lat, lng],
    tipado   : ([lat, lng]) => Float64Array.of(lat, lng, 500),
    latLng   : ([lat, lng]) => ({ lat, lng }),
    latLon   : ([lat, lon]) => ({ lat, lon }),
    latitude : ([latitude, longitude]) => ({ latitude, longitude }),
  }
  const puntos = [[-33, -71], [-34, -70.5], [-33.5, -70]]
  for (const [nombre, forma] of Object.entries(formas)) {
    const p = puntos.map(forma)
    assert.deepEqual(boundsOf(...p), esperada, `${nombre}, variádico`)
    assert.deepEqual(boundsOf(p), esperada, `${nombre}, plano`)
    assert.deepEqual(boundsOf([p.slice(0, 1), p.slice(1)]), esperada, `${nombre}, anidado`)
    assert.deepEqual(boundsOf(new Set(p)), esperada, `${nombre}, iterable`)
  }
})

test('un vértice suelto entre cortes entra a la caja, aunque no haga tramo', () => {
  assert.deepEqual(boundsOf([[1, 2], null, [5, 6], [NaN, 0], [3, -4]]), caja(1, -4, 5, 6))
  assert.deepEqual(boundsOf([10, 20], null, [11, 21]), caja(10, 20, 11, 21), 'variádico con un hueco')
  assert.deepEqual(boundsOf([[[10, 20]], [[11, 21]]]), caja(10, 20, 11, 21), 'partes de un vértice')
})

test('un punto solo es la caja de un punto, y sin puntos no hay caja', () => {
  assert.deepEqual(boundsOf([10, 20]), caja(10, 20, 10, 20), 'un par solo es un punto, no un path de números')
  assert.deepEqual(boundsOf({ lat: 10, lng: 20 }), caja(10, 20, 10, 20))
  assert.equal(boundsOf(), null)
  assert.equal(boundsOf(null), null)
  assert.equal(boundsOf([]), null)
  assert.equal(boundsOf('10,20'), null, 'un string no es un punto')
  assert.equal(boundsOf([NaN, 0], undefined), null, 'sólo inválidos')
})

test('la regla de punto de distance: la latitud fuera de rango y una vista tipada larga no son puntos', () => {
  assert.deepEqual(boundsOf([10, 20], [91, 0], [11, 21]), caja(10, 20, 11, 21))
  assert.equal(boundsOf(Float64Array.of(10, 20, 11, 21)), null, 'un intercalado no es un punto')
})

// ── el lector de cajas ────────────────────────────────────────────────────────

test('una Bounds se lee tal cual, y un par de esquinas opuestas se ordena como dos puntos', () => {
  const b = caja(-34, -71, -33, -70)
  assert.deepEqual(boundsCenter(b), { lat: -33.5, lng: -70.5 })
  assert.deepEqual(boundsCenter([[-34, -71], [-33, -70]]), { lat: -33.5, lng: -70.5 })
  assert.deepEqual(boundsPad([{ lat: -33, lng: -71 }, Float32Array.of(-34, -70)], 0), b,
    'noroeste y sudeste, en dos formas de punto')
})

test('lo que no es una caja no se lee: ni invertida, ni con una esquina que no es lugar, ni otro objeto', () => {
  const noCajas = {
    'sur sobre el norte'          : caja(-33, -71, -34, -70),
    'oeste al este del este'      : caja(-34, 170, -33, -170),
    'latitud fuera de rango'      : caja(-34, -71, 91, -70),
    'un lado no finito'           : caja(-34, -71, -33, Infinity),
    'un lado string'              : { south: -34, west: '-71', north: -33, east: -70 },
    'un par con una esquina mala' : [[-34, -71], [NaN, -70]],
    'tres esquinas'               : [[-34, -71], [-33, -70], [-33, -70]],
    'un punto'                    : [-34, -71],
    'un objeto con getters'       : { getSouth: () => -34, getWest: () => -71, getNorth: () => -33, getEast: () => -70 },
    'null'                        : null,
  }
  for (const [nombre, b] of Object.entries(noCajas)) {
    assert.equal(boundsCenter(b), null, nombre)
    assert.equal(boundsPad(b, 0.1), null, nombre)
    assert.equal(boundsContain(b, [-33.5, -70.5]), false, nombre)
  }
})

// ── boundsPad, boundsContain, boundsCenter ────────────────────────────────────

test('boundsPad agranda por cada lado en la fracción de su alto y de su ancho', () => {
  assert.deepEqual(boundsPad(caja(0, 0, 10, 20), 0.5), caja(-5, -10, 15, 30))
  assert.deepEqual(boundsPad([[0, 0], [10, 20]], -0.25), caja(2.5, 5, 7.5, 15), 'negativo achica')
  assert.equal(boundsPad(caja(0, 0, 10, 20), -0.6), null, 'un ratio que la invierte no deja caja')
  assert.equal(boundsPad(caja(0, 0, 10, 20), NaN), null)
})

test('boundsPad acota la latitud a [-90, 90], y la longitud no', () => {
  assert.deepEqual(boundsPad(caja(-80, 170, 85, 179), 1), caja(-90, 161, 90, 188))
})

test('boundsContain cuenta los bordes y lee el punto en cualquier forma', () => {
  const b = caja(0, 0, 10, 20)
  assert.equal(boundsContain(b, [0, 20]), true, 'esquina')
  assert.equal(boundsContain(b, { lat: 5, lon: 10 }), true)
  assert.equal(boundsContain(b, { latitude: 10, longitude: 0 }), true)
  assert.equal(boundsContain(b, [10.0001, 10]), false)
  assert.equal(boundsContain(b, [5, -0.0001]), false)
  assert.equal(boundsContain(b, [NaN, 5]), false, 'lo que no es punto no cae en ninguna caja')
  assert.equal(boundsContain(b, null), false)
})

test('boundsContain no envuelve la longitud, ni la de la caja ni la del punto', () => {
  const b = caja(-10, 170, 10, 190)
  assert.equal(boundsContain(b, [0, 185]), true, 'la caja sigue pasado el antimeridiano')
  assert.equal(boundsContain(b, [0, -175]), false, 'el mismo lugar, en otra copia del mundo')
})

test('boundsCenter promedia los lados, también de la caja de un punto', () => {
  assert.deepEqual(boundsCenter(caja(-10, 100, 30, 140)), { lat: 10, lng: 120 })
  assert.deepEqual(boundsCenter(boundsOf([7, 8])), { lat: 7, lng: 8 })
})
