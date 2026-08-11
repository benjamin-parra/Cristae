/* eslint-disable no-irregular-whitespace --
   Uno de los documentos lleva un ESPACIO DE ANCHO CERO (U+200B) pegado a la comilla de cierre de un
   string: es el contenido adversario en sí, no un descuido de tipeo. Escribirlo como escape no
   serviría — la fixture tiene que salir con el byte crudo, que es lo que descoloca a un escáner que
   busque el cierre del string a ojo. La regla queda apagada para el archivo entero porque el
   carácter vive dentro de un template literal, donde un comentario de línea entraría al string. */

// Generador del corpus adversario de `cristae/geojson`.
//
// POR QUE existe un generador en vez de 25 archivos escritos a mano:
//
// 1. Media docena de estos documentos dependen de la BARRA INVERTIDA byte a byte (escapes de clave,
//    strings hostiles, truncados a mitad de un escape). La barra no sobrevive intacta a todos los
//    canales de edicion/copiado, y un documento que perdio una barra deja de probar lo que decia
//    probar SIN romperse — el peor modo de falla de un corpus. Aca la barra se construye por codigo.
// 2. Tres documentos no son escribibles a mano (300 contenedores vacios, un bbox de miles de numeros,
//    100.000 niveles de anidamiento).
// 3. Los cinco truncados se DERIVAN de un unico documento base por corte, asi que su offset de EOF
//    es un dato calculado y no un numero copiado que se desincroniza al editar el base.
//
// Idempotente: reescribe siempre los mismos bytes. Se corre con `node generar.mjs`.

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const AQUI = dirname(fileURLToPath(import.meta.url))

// La barra invertida por codigo: es el unico byte de este corpus que un canal de texto puede comerse
// en silencio, y de el dependen los casos que atacan el salteo de strings.
const BARRA = String.fromCharCode(92)
const u = hex => `${BARRA}u${hex}`

// Siempre LF y sin BOM: los truncados fijan su `at` en bytes, y un CRLF correria cada offset del
// indice sin que ningun test se entere.
const escribir = (nombre, texto) => {
  const buf = Buffer.from(texto, 'utf8')
  writeFileSync(join(AQUI, nombre), buf)
  return { nombre, bytes: buf.length }
}

// Un poligono cerrado (§3.1.6 del RFC: la ultima posicion repite la primera) de 4 vertices, que es el
// dato "sano" contra el que se contrasta el cebo en casi todos los adversarios.
const anillo = (x, y) => `[ [ ${x}, ${y} ], [ ${x + 1}, ${y} ], [ ${x + 1}, ${y + 1} ], [ ${x}, ${y} ] ]`

const escritos = []
const emitir = (nombre, texto) => escritos.push(escribir(nombre, texto))

// ─────────────────────────────────────────────────────────────────────────────
// Falla #1 del prototipo: un VALOR de texto que dice "coordinates".
// §17.3-7 la elimina por arquitectura, asi que lo esperado es la salida LIMPIA.
// El cebo aparece en los tres sitios donde puede aparecer: en properties, como miembro ajeno de la
// geometria (legal, RFC §6.1) y seguido de arrays de numeros con la forma de un anillo.
// La posicion 3D del medio existe para que la falla #3 (numeros correctos, estructura indistinguible)
// sea observable: si el cebo contaminara, `z` no calzaria.
// ─────────────────────────────────────────────────────────────────────────────
emitir('valor-texto-coordinates.geojson', `{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "nota": "coordinates",
        "cebo_plano": [ 111.5, 222.5, 333.5, 444.5 ],
        "cebo_texto_y_numeros": "coordinates",
        "cebo_tras_el_texto": [ 555.5, 666.5 ]
      },
      "geometry": {
        "type": "Polygon",
        "comentario": "coordinates",
        "cebo_anidado": [ [ [ 999.5, 888.5 ], [ 777.5, 666.5 ] ] ],
        "coordinates": [
          [ [ 0, 0 ], [ 1, 0, 25.5 ], [ 1, 1 ], [ 0, 0 ] ]
        ]
      }
    }
  ]
}
`)

// ─────────────────────────────────────────────────────────────────────────────
// Falla #2: la clave escrita con un escape unicode en la n. JSON legal, mismo significado.
// §17.9 manda deshacer el escape al comparar.
// ─────────────────────────────────────────────────────────────────────────────
emitir('clave-coordinates-escape-unicode.geojson', `{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "nombre": "la n de coordinates va escapada" },
      "geometry": {
        "type": "Polygon",
        "coordi${u('006e')}ates": [
          ${anillo(10, 20)}
        ]
      }
    }
  ]
}
`)

// Mismo mecanismo sobre las OTRAS claves que el lector reconoce (§17.3-9 nombra properties/id/bbox;
// §17.1 nombra feature y geometria). Si el deshacer-escapes se implementa solo para "coordinates",
// este documento entrega una geometria sin type y cae por §17.3-1 en vez de leerse.
emitir('claves-estructurales-escapadas.geojson', `{
  "${u('0074')}ype": "FeatureCollection",
  "f${u('0065')}atures": [
    {
      "type": "Feature",
      "${u('0069')}d": "F-1",
      "properti${u('0065')}s": { "nombre": "claves de estructura escapadas" },
      "g${u('0065')}ometry": {
        "ty${u('0070')}e": "Polygon",
        "coordinates": [
          ${anillo(0, 0)}
        ]
      }
    }
  ]
}
`)

// El escape en el VALOR de type, no en la clave. El contrato manda deshacer escapes al comparar la
// CLAVE y no dice nada del valor: o se lee Polygon, o cierra sin type reconocible (§17.3-1).
emitir('valor-type-escapado.geojson', `{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "nombre": "el valor de type lleva escape" },
      "geometry": {
        "type": "Pol${u('0079')}gon",
        "coordinates": [
          ${anillo(3, 3)}
        ]
      }
    }
  ]
}
`)

// ─────────────────────────────────────────────────────────────────────────────
// Salteo de strings. Cada valor esta armado para que un escaner que "casi" implementa el escape se
// salga de fase y siga leyendo estructura donde hay texto: la barra al final del string (la comilla
// de cierre parece escapada), la comilla escrita como " (parece cierre y no lo es), y la barra
// escrita como \ (parece abrir un escape y no lo abre).
// Todos los cebos dicen "coordinates" y traen numeros: si el escaner se desfasa, aparecen en xy.
// ─────────────────────────────────────────────────────────────────────────────
emitir('strings-escapes-hostiles.geojson', `{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "comilla_escapada": "dice ${BARRA}"coordinates${BARRA}": [ 90, 91 ] y sigue",
        "barra_al_final": "C:${BARRA}${BARRA}",
        "barra_pegada_a_la_comilla_de_cierre": "ruta${BARRA}${BARRA}",
        "comilla_como_unicode": "${u('0022')}coordinates${u('0022')}: [ 92, 93 ]",
        "barra_como_unicode": "${u('005C')}",
        "barra_unicode_pegada_a_comilla": "${u('005C')}${u('0022')}coordinates${u('0022')}: [ 94, 95 ]",
        "doble_barra_y_comilla": "${BARRA}${BARRA}${BARRA}"coordinates${BARRA}${BARRA}${BARRA}": [ [ 96, 97 ] ]",
        "solidus_escapado": "${BARRA}/coordinates${BARRA}/",
        "controles": "${BARRA}b${BARRA}f${BARRA}n${BARRA}r${BARRA}t fin",
        "escape_que_no_es_escape": "${BARRA}${BARRA}u0022coordinates${BARRA}${BARRA}u0022"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          ${anillo(3, 4)}
        ]
      }
    }
  ]
}
`)

// Pares surrogate y bytes multibyte crudos pegados a la comilla de cierre. El surrogate huerfano es
// JSON sintacticamente legal aunque no sea Unicode valido, y el par partido por una barra escrita
// como \ es el caso que descoloca a quien decodifica escapes en vez de saltearlos.
emitir('strings-surrogates-antes-de-comilla.geojson', `{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "par_al_final": "camion ${u('D83D')}${u('DE9B')}",
        "par_solo": "${u('D83D')}${u('DE9B')}",
        "alto_huerfano": "${u('D83D')}",
        "bajo_huerfano": "${u('DE9B')}",
        "alto_y_barra": "${u('D83D')}${BARRA}${BARRA}",
        "par_partido_por_barra": "${u('D83D')}${u('005C')}uDE9B",
        "texto_que_parece_par": "${BARRA}${BARRA}uD83D${BARRA}${BARRA}uDE9B",
        "emoji_crudo_antes_de_comilla": "camion \u{1F69B}",
        "acentos_crudos_antes_de_comilla": "Ñuñoa señal ü",
        "cero_ancho_antes_de_comilla": "invisible ​"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          ${anillo(7, 8)}
        ]
      }
    }
  ]
}
`)

// La clave "coordinates" (y "type") en posicion de clave pero FUERA de una geometria: properties
// finge ser una geometria completa. §17.3-7 excluye los VALORES de texto, no dice que la clave se
// reconozca unicamente dentro de un objeto geometria.
emitir('clave-coordinates-fuera-de-geometria.geojson', `{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "type": "Polygon",
        "coordinates": [
          ${anillo(77, 78)}
        ],
        "nota": "properties finge ser una geometria completa"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          ${anillo(0, 0)}
        ]
      }
    }
  ]
}
`)

// Clave duplicada dentro de la misma geometria. JSON no lo prohibe (RFC 8259: los nombres SHOULD ser
// unicos) y el RFC 7946 no lo trata.
emitir('coordinates-duplicado.geojson', `{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "nombre": "coordinates dos veces" },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          ${anillo(0, 0)}
        ],
        "coordinates": [
          ${anillo(5, 5)}
        ]
      }
    }
  ]
}
`)

// type duplicado con valores distintos, y elegidos para que la eleccion sea OBSERVABLE en las tablas
// y no solo en `kinds`: el mismo `coordinates` de 3 niveles se lee como 1 anillo de 4 vertices si
// gana Polygon, y como una estructura de otra forma si gana MultiPoint.
emitir('type-duplicado.geojson', `{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "nombre": "type dos veces" },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          ${anillo(0, 0)}
        ],
        "type": "MultiPoint"
      }
    }
  ]
}
`)

// ─────────────────────────────────────────────────────────────────────────────
// Anidamiento.
// ─────────────────────────────────────────────────────────────────────────────

// GeometryCollection anidada 12 niveles, con una coleccion VACIA de hermana y un poligono colgado a
// mitad de camino: lo unico observable tras el aplanado de §17.1 es el ORDEN de recorrido (A antes
// que B) y que la coleccion vacia no aporta geometrias ni corre la cadena CSR.
const POLI_A = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }
const POLI_B = { type: 'Polygon', coordinates: [[[100, 0], [101, 0], [101, 1], [100, 0]]] }
const GC_VACIA = { type: 'GeometryCollection', geometries: [] }

const gcProfunda = Array.from({ length: 12 }, (_, i) => 12 - i).reduce((dentro, nivel) => ({
  type: 'GeometryCollection',
  geometries: nivel === 3 ? [POLI_A, dentro] : nivel === 1 ? [GC_VACIA, dentro] : [dentro],
}), POLI_B)

emitir('gc-anidada-profunda.geojson', `${JSON.stringify({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: { nombre: 'colecciones anidadas' }, geometry: gcProfunda }],
}, null, 2)}\n`)

// Pozo de arrays dentro de un miembro ajeno de properties, no dentro de coordinates: aisla la
// profundidad del ESCANER de cualquier discusion sobre la forma de una geometria.
// Va en una sola linea porque a 64 y a 100.000 niveles la indentacion no aporta legibilidad.
const pozo = n => `${'['.repeat(n)} 42 ${']'.repeat(n)}`
const conPozo = n => `{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "pozo": ${pozo(n)}
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          ${anillo(0, 0)}
        ]
      }
    }
  ]
}
`

emitir('anidamiento-64-niveles.geojson', conPozo(64))
emitir('anidamiento-100k-niveles.geojson', conPozo(100000))

// ─────────────────────────────────────────────────────────────────────────────
// bbox de largo desmedido (§17.9). Los tres roles llevan bbox para verificar de paso que se descarta
// en documento, feature y geometria (§17.3-9); el desmedido es el del documento.
// Formateado de a 10 numeros por linea: un numero por linea daria 5.000 lineas ilegibles.
// ─────────────────────────────────────────────────────────────────────────────
const NUMEROS_BBOX = 5000
const bboxGrande = Array.from({ length: NUMEROS_BBOX }, (_, i) => i / 8)
  .reduce((lineas, n, i) => {
    const col = i % 10
    return col === 0 ? [...lineas, `    ${n}`] : [...lineas.slice(0, -1), `${lineas.at(-1)}, ${n}`]
  }, [])
  .join(',\n')

emitir('bbox-miles-de-numeros.geojson', `{
  "type": "FeatureCollection",
  "bbox": [
${bboxGrande}
  ],
  "features": [
    {
      "type": "Feature",
      "bbox": [ -70.7, -33.5, -70.6, -33.4 ],
      "properties": { "nombre": "bbox de miles de numeros en el documento" },
      "geometry": {
        "type": "Polygon",
        "bbox": [ 0, 0, 1, 1 ],
        "coordinates": [
          ${anillo(0, 0)}
        ]
      }
    }
  ]
}
`)

// ─────────────────────────────────────────────────────────────────────────────
// Contadores de contenedores vacios (§17.9: enteros de 32 bits, un Uint8Array da la vuelta a los 256).
// 300 > 256 en los tres niveles donde hay un contador: partes, anillos y geometrias.
// ─────────────────────────────────────────────────────────────────────────────
const VACIOS = 300

emitir('partes-vacias-300.geojson', `${JSON.stringify({
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { nombre: `${VACIOS} poligonos vacios y uno real` },
    geometry: {
      type: 'MultiPolygon',
      coordinates: [...Array.from({ length: VACIOS }, () => []), [[[0, 0], [1, 0], [1, 1], [0, 0]]]],
    },
  }],
}, null, 2)}\n`)

emitir('anillos-vacios-300.geojson', `${JSON.stringify({
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { nombre: `${VACIOS} anillos vacios y uno real` },
    geometry: {
      type: 'Polygon',
      coordinates: [...Array.from({ length: VACIOS }, () => []), [[0, 0], [1, 0], [1, 1], [0, 0]]],
    },
  }],
}, null, 2)}\n`)

emitir('geometrias-nulas-300.geojson', `${JSON.stringify({
  type: 'FeatureCollection',
  features: [
    ...Array.from({ length: VACIOS }, (_, i) => ({
      type: 'Feature',
      properties: { nombre: `sin geometria ${i}` },
      geometry: null,
    })),
    { type: 'Feature', properties: { nombre: 'con geometria' }, geometry: POLI_A },
  ],
}, null, 2)}\n`)

// ─────────────────────────────────────────────────────────────────────────────
// Truncados. Los cinco salen del MISMO documento base por corte, asi que el offset del EOF es un dato
// calculado: editar el base no desincroniza ningun numero copiado a mano.
// ─────────────────────────────────────────────────────────────────────────────
const BASE_TRUNCADO = `{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "nombre": "Cerro Truncado" },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [ [ -70.65, -33.45 ], [ -70.64, -33.45 ], [ -70.64, -33.44 ], [ -70.65, -33.45 ] ]
        ]
      }
    }
  ]
}
`

const cortarTras = marca => BASE_TRUNCADO.slice(0, BASE_TRUNCADO.indexOf(marca) + marca.length)
const cortarAntes = marca => BASE_TRUNCADO.slice(0, BASE_TRUNCADO.indexOf(marca))

// A mitad de un numero: el punto decimal queda sin digitos, que es donde 'truncado' y 'numero'
// compiten por el mismo documento.
emitir('truncado-en-numero.geojson', cortarTras('[ -70.64, -33.45 ], [ -70.'))

// A mitad de un string.
emitir('truncado-en-string.geojson', cortarTras('"nombre": "Cerro Trunc'))

// Justo despues de una barra de escape: quien consume "el caracter escapado" sin mirar el fin del
// buffer lee un byte que no existe. §17.8 exige que ninguna lectura salga de rango.
emitir('truncado-tras-barra-escape.geojson', `${cortarAntes('Cerro Truncado')}ruta${BARRA}`)

// A mitad de un escape unicode: faltan dos de los cuatro digitos hexadecimales.
emitir('truncado-en-escape-unicode.geojson', `${cortarAntes('Cerro Truncado')}medio ${BARRA}u00`)

// A mitad de un array: tres contenedores quedan abiertos y el ultimo cierre valido es un anillo.
emitir('truncado-en-array.geojson', cortarTras('[ [ -70.65, -33.45 ], [ -70.64, -33.45 ]'))

// ─────────────────────────────────────────────────────────────────────────────
// Documentos que no llegan a ser GeoJSON.
// ─────────────────────────────────────────────────────────────────────────────
emitir('documento-vacio.geojson', '')

// Los cuatro espacios en blanco que JSON reconoce (espacio, tab, CR, LF), por codigo para que no haya
// duda de que bytes son.
const ESPACIOS = [0x20, 0x09, 0x0D, 0x0A, 0x20, 0x20, 0x0A].map(c => String.fromCharCode(c)).join('')
emitir('solo-espacios.geojson', ESPACIOS)

// JSON valido que no es un objeto GeoJSON.
emitir('null-suelto.geojson', 'null\n')

// La raiz entera es el texto "coordinates": la falla #1 llevada al documento completo.
emitir('raiz-escalar-texto-coordinates.geojson', '"coordinates"\n')

console.table(escritos)
