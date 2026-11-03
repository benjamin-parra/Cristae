// Lector de KML y KMZ — contrato: DISENO-INTEROP §3.1, con §1 (salida, errores, opciones) y §2.6
// (XML seguro). Plan de §5: corpus a mano con citas contra el oráculo de jsdom, números exactos,
// formas de entrada, areasOf, KMZ sobre zips armados en el test, recursión y fuzz de mutación.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readKml, readKmz } from '../../../src/formats/kml.js'
import { areasOf } from '../../../src/geojson/geojson.js'
import { compararTablas, esFormatError, fallaCon, formasTexto, fuzz, invariantes, mutante } from '../comun.mjs'
import { oraculoKml } from '../xml/oraculo-xml.mjs'
import { crc32, zip } from './zip-de-prueba.mjs'

const CORPUS = new URL('./corpus/', import.meta.url).pathname

// Veredicto de cada fixture: 'lectura' se compara contra el oráculo; un código es el FormatError que
// la sección citada en el encabezado del fixture exige.
const VEREDICTO = {
  'felices/punto-documento.kml'                     : 'lectura',
  'felices/carpetas-anidadas.kml'                   : 'lectura',
  'felices/multigeometria.kml'                      : 'lectura',
  'especificacion/namespace-con-prefijo.kml'        : 'lectura',
  'especificacion/coordenadas-partidas.kml'         : 'lectura',
  'especificacion/fuera-de-subconjunto.kml'         : 'lectura',
  'especificacion/iso-8859-1.kml'                   : 'lectura',
  'degenerados/anillos.kml'                         : 'lectura',
  'degenerados/vacios.kml'                          : 'lectura',
  'degenerados/ordenadas.kml'                       : 'lectura',
  'adversarios/dtd.kml'                             : 'dtd',
  'adversarios/entidad-no-declarada.kml'            : 'sintaxis',
  'adversarios/referencia-invalida.kml'             : 'sintaxis',
  'adversarios/atributo-repetido.kml'               : 'sintaxis',
  'adversarios/cierre-cruzado.kml'                  : 'sintaxis',
  'adversarios/dos-raices.kml'                      : 'sintaxis',
  'adversarios/vacio.kml'                           : 'sintaxis',
  'adversarios/truncado.kml'                        : 'truncado',
  'adversarios/espacio-en-tupla.kml'                : 'posicion',
  'adversarios/una-ordenada.kml'                    : 'posicion',
  'adversarios/punto-con-dos-tuplas.kml'            : 'posicion',
  'adversarios/nan.kml'                             : 'numero',
  'adversarios/infinito.kml'                        : 'numero',
  'adversarios/basura-en-numero.kml'                : 'numero',
  'adversarios/referencia-letra-en-coordenadas.kml' : 'numero',
  'adversarios/inner-antes-de-outer.kml'            : 'estructura',
  'adversarios/dos-exteriores.kml'                  : 'estructura',
  'adversarios/dos-coordinates.kml'                 : 'estructura',
  'adversarios/borde-sin-anillo.kml'                : 'estructura',
  'adversarios/elemento-en-coordenadas.kml'         : 'estructura',
  'adversarios/raiz-gpx.kml'                        : 'formato',
}

const STATS_DEL_ORACULO = ['openRings', 'shortRings', 'degenerateRings', 'reversedRings', 'extraOrdinates',
  'emptyGeometries', 'foreignMembers', 'skippedGeometries']

const bytesDe = ruta => new Uint8Array(readFileSync(join(CORPUS, ruta)))

// El oráculo recibe texto: se decodifica con lo que declara el prólogo, como haría quien abre el archivo.
const textoDe = bytes => new TextDecoder(/ISO-8859-1/i.test(new TextDecoder('latin1').decode(bytes.subarray(0, 64)))
  ? 'latin1' : 'utf-8').decode(bytes)

const fixtures = readdirSync(CORPUS, { recursive: true }).filter(r => r.endsWith('.kml')).sort()

const contraOraculo = (lectura, esperado) => {
  invariantes(lectura)
  compararTablas(lectura, esperado)
  assert.deepEqual(lectura.layers, esperado.layers)
  STATS_DEL_ORACULO.forEach(k => assert.equal(lectura.stats[k], esperado.stats[k], `stats.${k}`))
}

describe('KML: corpus', () => {
  test('cada fixture tiene veredicto y cita', () => {
    assert.deepEqual(fixtures, Object.keys(VEREDICTO).sort())
    fixtures.forEach(r => assert.match(textoDe(bytesDe(r)), /<!--[^]*(§|WFC|07-147r2)/, `${r} sin cita`))
  })

  fixtures.forEach(ruta => test(ruta, async () => {
    const veredicto = VEREDICTO[ruta]
    const bytes     = bytesDe(ruta)
    if (veredicto !== 'lectura') return fallaCon(() => readKml(bytes), veredicto, 'kml')
    contraOraculo(readKml(bytes), oraculoKml(textoDe(bytes)))
  }))

  test('la raíz gpx da formato con hint', async () => {
    const e = await fallaCon(() => readKml(bytesDe('adversarios/raiz-gpx.kml')), 'formato')
    assert.equal(e.hint, 'gpx')
  })
})

describe('KML: atributos, capas e ids (§1.1, §1.2)', () => {
  const lectura = readKml(bytesDe('felices/punto-documento.kml'))

  test('propertiesOf: hijos directos, Data y SimpleData, con entidades y CDATA resueltos', () => {
    assert.deepEqual(lectura.propertiesOf(0), {
      name: 'Torre', description: '<b>alta</b> & visible', styleUrl: '#rojo', altura: '42', tipo: 'mirador',
    })
    assert.deepEqual(lectura.propertiesOf(1), {})
    assert.equal(lectura.propertiesOf(2), null)
  })

  test('idOf: el atributo id con su referencia resuelta; sin id es null', () => {
    assert.equal(lectura.idOf(0), 'p1')
    assert.equal(lectura.idOf(1), null)
  })

  test('el rango de atributos es el Placemark entero', () => {
    const texto = new TextDecoder().decode(lectura.bytes.subarray(lectura.propAt[2], lectura.propAt[3]))
    assert.match(texto, /^<Placemark>[^]*<\/Placemark>$/)
  })

  test('format, crs y capas', () => {
    assert.equal(lectura.format, 'kml')
    assert.equal(lectura.crs, 'EPSG:4326')
    assert.deepEqual(lectura.layers, [{ name: 'Predios & caminos', parent: -1 }])
    assert.deepEqual(Array.from(lectura.layerOf), [0, 0])
  })

  test('sólo los hijos DIRECTOS del Placemark son atributos (§17.3-11)', () => {
    const r = readKml('<kml><Placemark><name>a</name><atom:author xmlns:atom="x"><atom:name>b</atom:name></atom:author></Placemark></kml>')
    assert.deepEqual(r.propertiesOf(0), { name: 'a' })
    assert.equal(r.stats.foreignMembers, 1)
  })

  test('un Data name="__proto__" es una clave, no el prototipo', () => {
    const r = readKml('<kml><Placemark><ExtendedData><Data name="__proto__"><value>x</value></Data></ExtendedData></Placemark></kml>')
    const p = r.propertiesOf(0)
    assert.equal(Object.getPrototypeOf(p), Object.prototype)
    assert.equal(Object.getOwnPropertyDescriptor(p, '__proto__').value, 'x')
  })

  test('la codificación declarada vale para el texto materializado', () => {
    const r = readKml(bytesDe('especificacion/iso-8859-1.kml'))
    assert.equal(r.layers[0].name, 'Peñalolén')
    assert.deepEqual(r.propertiesOf(0), { name: 'Camión' })
  })

  test('UTF-8 inválido en un texto materializado es codificacion, no U+FFFD', async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('<kml><Document><name>a'), 0xFF, ...new TextEncoder().encode('</name></Document></kml>')])
    await fallaCon(() => readKml(bytes), 'codificacion', 'kml')
  })

  test('release suelta los bytes y propertiesOf pasa a liberado', async () => {
    const r = readKml(bytesDe('felices/punto-documento.kml'))
    r.release()
    assert.equal(r.bytes, null)
    await fallaCon(() => r.propertiesOf(0), 'liberado')
    assert.equal(r.vertexCount, 2)
  })
})

describe('KML: opciones (§1.5)', () => {
  const texto = readFileSync(join(CORPUS, 'felices/carpetas-anidadas.kml'), 'utf8')

  test('bounds: caja por geometría', () => {
    const r = readKml(texto, { bounds: true })
    assert.deepEqual(Array.from(r.bounds), [0, 0, 2, 0.5, 0, 0, 4, 4, 9, 9, 9, 9])
    assert.equal(readKml(texto).bounds, null)
  })

  test('opciones inválidas son entrada', async () => {
    await fallaCon(() => readKml(texto, { maxDepth: 0 }), 'entrada', 'kml')
    await fallaCon(() => readKml(texto, { capacityHint: -1 }), 'entrada', 'kml')
    await fallaCon(() => readKml(42), 'entrada', 'kml')
  })

  test('capacityHint no cambia la lectura', () => compararTablas(readKml(texto, { capacityHint: 1 }), readKml(texto)))
})

describe('KML: números exactos (§5-4)', () => {
  // Semilla fija; la frontera de 31 a 34 dígitos significativos es la que §17.5 declara obligatoria.
  let s = 0x9E3779B9
  const azar = n => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s % n
  }
  const digitos = n => Array.from({ length: n }, (_, k) => (k === 0 ? 1 + azar(9) : azar(10))).join('')
  const token = () => {
    const total = [1, 5, 15, 16, 17, 22, 31, 32, 33, 34, 40][azar(11)]
    const punto = azar(total + 1)
    const d     = digitos(total)
    const base  = punto === total ? d : `${d.slice(0, punto) || '0'}.${d.slice(punto)}`
    return (azar(2) ? '-' : '') + base + (azar(4) ? '' : `e${azar(2) ? '-' : ''}${azar(30)}`)
  }

  test('paridad bit a bit con Number(texto) en 2000 ordenadas', () => {
    const tokens = Array.from({ length: 2000 }, token)
    const tuplas = []
    for (let k = 0; k < tokens.length; k += 2) tuplas.push(`${tokens[k]},${tokens[k + 1]}`)
    const r = readKml(`<kml><Placemark><LineString><coordinates>${tuplas.join(' ')}</coordinates></LineString></Placemark></kml>`)
    tokens.forEach((t, k) => assert.ok(Object.is(r.xy[k], Number(t)), `${t}: ${r.xy[k]} contra ${Number(t)}`))
  })
})

describe('KML: formas de entrada (§17.3-6, §17.8)', () => {
  const texto = '﻿' + readFileSync(join(CORPUS, 'felices/punto-documento.kml'), 'utf8')

  test('string, ArrayBuffer, Uint8Array y Buffer pooled dan la misma lectura', () => {
    const [[, base], ...resto] = formasTexto(texto).map(([nombre, entrada]) => [nombre, readKml(entrada)])
    resto.forEach(([nombre, r]) => {
      compararTablas(r, base)
      assert.deepEqual(r.propertiesOf(0), base.propertiesOf(0), nombre)
      assert.equal(r.idOf(0), base.idOf(0), nombre)
    })
  })
})

describe('KML: areasOf sirve sin cambios (§5-3ter)', () => {
  test('selecciona los anillos de los polígonos y su feature dueño', () => {
    const r = readKml(bytesDe('felices/carpetas-anidadas.kml'))
    const a = areasOf(r)
    assert.deepEqual(Array.from(a.parts), [1])
    assert.deepEqual(Array.from(a.rings), [1, 2, 3])
    assert.equal(a.owner[1], 1)
    assert.equal(a.xy, r.xy)
  })
})

describe('KML: anidamiento sin recursión (§1.5)', () => {
  const profundo = n => `<kml><Placemark>${'<MultiGeometry>'.repeat(n)}<Point><coordinates>1,2</coordinates></Point>${'</MultiGeometry>'.repeat(n)}</Placemark></kml>`

  test('100 mil MultiGeometry anidadas: profundidad con el tope por defecto', async () => {
    await fallaCon(() => readKml(profundo(100000)), 'profundidad', 'kml')
  })

  test('con el tope alto se lee entero, sin RangeError', () => {
    const r = readKml(profundo(100000), { maxDepth: 200000 })
    assert.equal(r.geometryCount, 1)
    assert.deepEqual(Array.from(r.xy), [1, 2])
  })
})

describe('KMZ (§3.1, §2.7)', () => {
  const kml = bytesDe('felices/carpetas-anidadas.kml')
  const otro = new TextEncoder().encode('<kml><Placemark><Point><coordinates>7,8</coordinates></Point></Placemark></kml>')

  test('doc.kml en la raíz gana, comprimido o no', async () => {
    for (const metodo of [0, 8]) {
      const z = await zip([['otro.kml', otro, metodo], ['doc.kml', kml, metodo], ['files/a.png', new Uint8Array(3), 0]])
      const r = await readKmz(z)
      compararTablas(r, readKml(kml))
      assert.equal(r.format, 'kml')
      assert.deepEqual(r.propertiesOf(1), readKml(kml).propertiesOf(1))
    }
  })

  test('sin doc.kml, la primera entrada .kml del directorio, sin distinguir mayúsculas', async () => {
    const r = await readKmz(await zip([['leeme.txt', otro, 0], ['capa/X.KML', otro, 8], ['b.kml', kml, 8]]))
    assert.deepEqual(Array.from(r.xy), [7, 8])
  })

  test('sin ninguna entrada .kml es formato', async () => {
    await fallaCon(async () => readKmz(await zip([['a.txt', otro, 0]])), 'formato', 'kmz')
  })

  test('el inflado sobre maxBytes es tope, antes de inflar', async () => {
    await fallaCon(async () => readKmz(await zip([['doc.kml', kml, 8]]), { maxBytes: 64 }), 'tope', 'kmz')
  })

  test('un error del KML lleva el formato kmz y el offset dentro del KML inflado', async () => {
    const roto = new TextEncoder().encode('<kml><Placemark><Point><coordinates>1, 2</coordinates></Point></Placemark></kml>')
    const e    = await fallaCon(async () => readKmz(await zip([['doc.kml', roto, 8]])), 'posicion', 'kmz')
    assert.equal(e.at, 38)
  })

  test('CRC que no coincide es compresion', async () => {
    const z = await zip([['doc.kml', otro, 0]], { crc: crc32(otro) ^ 1 })
    await fallaCon(() => readKmz(z), 'compresion', 'kmz')
  })

  test('entradas inválidas rechazan la promesa con FormatError', async () => {
    await fallaCon(() => readKmz(null), 'entrada', 'kmz')
    await fallaCon(() => readKmz(new Uint8Array(4), { maxBytes: 0 }), 'entrada', 'kmz')
    const e = await readKmz(new Uint8Array(10)).catch(x => x)
    assert.ok(esFormatError(e, 'kmz'), String(e))
  })
})

describe('KML: fuzz de mutación (§5-6)', () => {
  test('sólo FormatError y la vista envenenada no cambia nada', { timeout: 120000 }, async () => {
    const semillas = fixtures.filter(r => VEREDICTO[r] === 'lectura').map(r => [r, bytesDe(r)])
    const { leidos, rechazados } = await fuzz(readKml, semillas, { casos: 80, formato: 'kml' })
    assert.ok(leidos > 0 && rechazados > 0, `${leidos} leídos, ${rechazados} rechazados`)
  })

  test('propertiesOf e idOf sobre los mutantes legibles sólo lanzan FormatError', () => {
    fixtures.filter(r => VEREDICTO[r] === 'lectura').forEach(r => {
      for (let n = 0; n < 80; n++) {
        let leido = null
        try { leido = readKml(mutante(bytesDe(r), 0xA11CE, n)) } catch { continue }
        for (let f = 0; f < leido.featureCount; f++)
          for (const metodo of ['propertiesOf', 'idOf']) {
            try { leido[metodo](f) } catch (e) { assert.ok(esFormatError(e), `${r} #${n}: ${e?.stack ?? e}`) }
          }
      }
    })
  })
})
