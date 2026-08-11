// Indice del corpus adversario de `cristae/geojson` — categoria "lo que intenta romperlo".
//
// Cada entrada declara QUE espera el CONTRATO (SPECS §17), no lo que haga la implementacion: este
// archivo se escribio antes que el lector, a proposito, para que la salida esperada no se derive de
// lo que el codigo termine haciendo.
//
// `espera.tipo` discrimina tres situaciones, y la tercera es la mas importante:
//
//   'lectura'  el contrato determina la salida — `conteos` y `tablas` son la derivacion.
//   'error'    el contrato nombra el `code` de GeoJsonError.
//   'ambiguo'  §17 NO determina la respuesta. `ramas` lista las lecturas compatibles con el texto.
//              Estos casos NO se asertan hasta que el contrato se cierre: un test que elige una rama
//              la convierte en contrato por la puerta de atras. La lista completa esta en
//              AMBIGUEDADES, al final.
//
// 🔴 El oraculo diferencial (un recorredor sobre JSON.parse, §17.8) NO puede arbitrar los casos con
// `oraculoNoArbitra`: ahi JSON.parse tiene un comportamiento propio —resolver claves duplicadas por
// ultima-gana— que el contrato nunca declaro. Tomarlo como verdad seria hornear un detalle de V8
// adentro del corpus.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const DIR_ADVERSARIOS = dirname(fileURLToPath(import.meta.url))

// Los documentos se entregan como bytes: `readGeoJson` es un lector de bytes UTF-8 y leerlos como
// string ya seria una conversion que el corpus no pidio (§17.2 los admite, pero el canonico es
// Uint8Array y el mismo documento debe dar la misma salida por las cuatro vias).
export const leerBytes = archivo => new Uint8Array(readFileSync(join(DIR_ADVERSARIOS, archivo)))

// Un poligono cerrado de 4 vertices es la forma "sana" repetida: se escribe una vez para que las
// tablas esperadas de los adversarios no sean 25 copias del mismo literal.
const UNA_GEOMETRIA_UN_ANILLO = {
  geometryAt: [0, 1],
  partAt: [0, 1],
  ringAt: [0, 1],
  vertexAt: [0, 4],
  kinds: [5],
  featureOf: [0],
  closed: [1],
}

export const CASOS = [
  {
    archivo: 'valor-texto-coordinates.geojson',
    clausula: '§17.3-7 · §17.9 (tabla "eliminados por arquitectura", fila 1)',
    prueba: 'Un VALOR de texto que dice exactamente "coordinates" —en properties y como miembro ajeno de la geometria— seguido de arrays de numeros con forma de anillo.',
    espera: {
      tipo: 'lectura',
      conteos: { f: 1, g: 1, p: 1, r: 1, v: 4 },
      tablas: {
        ...UNA_GEOMETRIA_UN_ANILLO,
        xy: [0, 0, 1, 0, 1, 1, 0, 0],
        // La segunda posicion es 3D: §17.3-4 manda stride fijo 2 en `xy` y la altitud en `z`, asi que
        // el documento deja de ser 2D y `z` deja de ser null aunque solo una posicion la traiga.
        z: [NaN, 25.5, NaN, NaN],
      },
      // El cebo entero: si alguno de estos numeros aparece en xy/z, el valor de texto abrio geometria.
      ausentesDeXY: [111.5, 222.5, 333.5, 444.5, 555.5, 666.5, 999.5, 888.5, 777.5],
    },
  },
  {
    archivo: 'clave-coordinates-escape-unicode.geojson',
    clausula: '§17.9 (tabla "que SI requieren manejo", fila 2) · §17.3-7',
    prueba: 'La clave escrita "coordi\\u006eates": JSON legal, mismo significado; el escape se deshace al comparar.',
    espera: {
      tipo: 'lectura',
      conteos: { f: 1, g: 1, p: 1, r: 1, v: 4 },
      tablas: { ...UNA_GEOMETRIA_UN_ANILLO, xy: [10, 20, 11, 20, 11, 21, 10, 20], z: null },
    },
  },
  {
    archivo: 'claves-estructurales-escapadas.geojson',
    clausula: '§17.3-7 · §17.9 fila 2 · §17.3-9 (id) · §17.2 (idOf)',
    prueba: 'El mismo escape sobre las OTRAS claves reconocidas (type, features, geometry, properties, id): si el deshacer-escapes solo cubre "coordinates", la geometria cierra sin type y cae por §17.3-1.',
    espera: {
      tipo: 'lectura',
      conteos: { f: 1, g: 1, p: 1, r: 1, v: 4 },
      tablas: { ...UNA_GEOMETRIA_UN_ANILLO, xy: [0, 0, 1, 0, 1, 1, 0, 0], z: null },
      // idOf hace JSON.parse del fragmento (§17.2), asi que su valor SI es asertable — a diferencia
      // del rango de propertiesOf, que §17.4 y §17.7 describen distinto (ver AMBIGUEDADES).
      idOf: { 0: 'F-1' },
    },
  },
  {
    archivo: 'valor-type-escapado.geojson',
    clausula: '§17.3-1 · §17.3-7 · §17.9 fila 2',
    prueba: 'El escape va en el VALOR de type ("Pol\\u0079gon"), no en la clave.',
    espera: {
      tipo: 'ambiguo',
      motivo: 'El contrato manda deshacer escapes al comparar la CLAVE; del valor de `type` no dice nada.',
      ramas: [
        'los escapes tambien se deshacen en el valor ⇒ Polygon normal: 1/1/1/1/4 con xy [3,3, 4,3, 4,4, 3,3]',
        'solo se deshacen en claves ⇒ la geometria cierra sin type reconocible ⇒ GeoJsonError("tipo") (§17.3-1)',
      ],
    },
  },
  {
    archivo: 'strings-escapes-hostiles.geojson',
    clausula: '§17.3-7 · §17.8 (fuzzer: ninguna lectura fuera de rango) · §17.5 (el escaner atraviesa todo)',
    prueba: 'Diez formas de descolocar el salteo de strings: comilla escapada, barra pegada a la comilla de cierre, comilla como \\u0022, barra como \\u005C, barra-barra-comilla, solidus escapado y escapes de control. Todos los cebos dicen "coordinates" y traen numeros.',
    espera: {
      tipo: 'lectura',
      conteos: { f: 1, g: 1, p: 1, r: 1, v: 4 },
      tablas: { ...UNA_GEOMETRIA_UN_ANILLO, xy: [3, 4, 4, 4, 4, 5, 3, 4], z: null },
      // Si el escaner se sale de fase dentro de un string, sigue leyendo estructura donde hay texto y
      // estos numeros aterrizan en xy. Es la senal de la falla, no un extra.
      ausentesDeXY: [90, 91, 92, 93, 94, 95, 96, 97],
    },
  },
  {
    archivo: 'strings-surrogates-antes-de-comilla.geojson',
    clausula: '§17.3-7 · §17.8',
    prueba: 'Pares surrogate, surrogates huerfanos, un par partido por una barra escrita como \\u005C, y bytes UTF-8 crudos de 2, 3 y 4 bytes pegados a la comilla de cierre.',
    espera: {
      tipo: 'lectura',
      conteos: { f: 1, g: 1, p: 1, r: 1, v: 4 },
      tablas: { ...UNA_GEOMETRIA_UN_ANILLO, xy: [7, 8, 8, 8, 8, 9, 7, 8], z: null },
    },
  },
  {
    archivo: 'clave-coordinates-fuera-de-geometria.geojson',
    clausula: '§17.3-7 · §17.3-9 · §17.4',
    prueba: '"coordinates" y "type" en posicion de clave pero DENTRO de properties: el objeto properties finge ser una geometria completa.',
    espera: {
      tipo: 'ambiguo',
      motivo: '§17.3-7 excluye los VALORES de texto; no dice que la clave se reconozca unicamente dentro de un objeto geometria. §17.3-9 (captura por rol) y §17.4 ("el lector no sabe que hay en properties") apuntan a la primera rama, pero ninguna de las dos lo declara.',
      ramas: [
        'la clave solo cuenta en rol geometria ⇒ 1 feature, 1 geometria, xy [0,0, 1,0, 1,1, 0,0]',
        'la clave cuenta en cualquier objeto ⇒ properties abre una segunda geometria (anillo 77,78 primero) y la cadena CSR se corre',
        'la clave cuenta en cualquier objeto pero el cierre no encuentra type valido ⇒ GeoJsonError("tipo")',
      ],
    },
  },
  {
    archivo: 'coordinates-duplicado.geojson',
    clausula: '§17.3-2 · §17.3-3 · §17.9',
    prueba: '"coordinates" dos veces en la misma geometria, con anillos distintos (0,0 y 5,5).',
    oraculoNoArbitra: true,
    espera: {
      tipo: 'ambiguo',
      motivo: 'Ni el RFC 7946 ni §17 tratan la clave duplicada. RFC 8259 dice que los nombres SHOULD ser unicos, no MUST.',
      ramas: [
        'gana la primera ⇒ 1 parte, 1 anillo, xy [0,0, 1,0, 1,1, 0,0]',
        'gana la ultima ⇒ 1 parte, 1 anillo, xy [5,5, 6,5, 6,6, 5,5]',
        'se acumulan ⇒ 1 parte con 2 anillos (o 2 partes), 8 vertices — justo el corrimiento de la cadena CSR que §17.3-3 existe para matar',
        'GeoJsonError("estructura")',
      ],
      // JSON.parse resuelve ultima-gana en silencio. Verificado: devuelve el anillo de 5,5. Si el
      // oraculo diferencial se toma como verdad aca, el corpus adopta una decision de V8 como si
      // fuera el contrato.
      porQueElOraculoNoSirve: 'JSON.parse resuelve ultima-gana; el contrato no dice eso ni lo contrario',
    },
  },
  {
    archivo: 'type-duplicado.geojson',
    clausula: '§17.3-1 · §17.3-2',
    prueba: '"type" dos veces con valores que se leen distinto sobre el MISMO coordinates: Polygon primero, MultiPoint despues.',
    oraculoNoArbitra: true,
    espera: {
      tipo: 'ambiguo',
      motivo: '§17.3-2 dice que el tipo se fija al CERRAR el objeto, retro-parchando `kinds` — lo que sugiere que el ultimo visto gana, pero no lo declara. Y si gana MultiPoint, el mapeo de partes/anillos de MultiPoint tampoco esta declarado (ver AMBIGUEDADES).',
      ramas: [
        'gana el primero ⇒ kinds [5] (Polygon), 1 parte, 1 anillo, 4 vertices',
        'gana el ultimo ⇒ kinds [2] (MultiPoint) sobre un coordinates de 3 niveles: forma indeterminada',
        'GeoJsonError("tipo") o "estructura" por type contradictorio',
      ],
      porQueElOraculoNoSirve: 'JSON.parse resuelve ultima-gana (MultiPoint); el contrato no lo declara',
    },
  },
  {
    archivo: 'gc-anidada-profunda.geojson',
    clausula: '§17.1 (GeometryCollection no sobrevive: aplanado en orden de recorrido) · §17.9 (contenedor vacio)',
    prueba: '12 niveles de GeometryCollection —legal: el RFC dice SHOULD avoid, no MUST NOT— con una coleccion vacia de hermana y un poligono colgado a mitad del descenso.',
    espera: {
      tipo: 'lectura',
      conteos: { f: 1, g: 2, p: 2, r: 2, v: 8 },
      tablas: {
        geometryAt: [0, 2],
        partAt: [0, 1, 2],
        ringAt: [0, 1, 2],
        vertexAt: [0, 4, 8],
        kinds: [5, 5],
        // Las dos geometrias hoja pertenecen al mismo feature: el arbol se pierde, la pertenencia no.
        featureOf: [0, 0],
        closed: [1, 1],
        // El orden es lo unico observable del aplanado: A (nivel 3) antes que B (nivel 12).
        xy: [0, 0, 1, 0, 1, 1, 0, 0, 100, 0, 101, 0, 101, 1, 100, 0],
        z: null,
      },
      nota: 'La GeometryCollection vacia no aporta geometrias ni corre ninguna cadena CSR.',
      dependeDe: 'tope de profundidad (ver AMBIGUEDADES)',
    },
  },
  {
    archivo: 'anidamiento-64-niveles.geojson',
    clausula: '§17.2 (code "profundidad") · §17.10-3',
    prueba: 'Un pozo de 64 arrays anidados dentro de un miembro ajeno de properties — aisla la profundidad del ESCANER de cualquier discusion sobre la forma de una geometria.',
    espera: {
      tipo: 'ambiguo',
      motivo: 'El code "profundidad" existe pero §17 no fija ningun tope, asi que "cerca del tope" no es escribible.',
      ramas: [
        'tope ≥ ~70 ⇒ lectura normal: 1/1/1/1/4 con xy [0,0, 1,0, 1,1, 0,0]',
        'tope < 64 ⇒ GeoJsonError("profundidad")',
      ],
      // Esto SI es asertable hoy, sea cual sea el tope: es la invariante, no la eleccion.
      invarianteFirme: 'o lectura normal o GeoJsonError("profundidad"); nunca un RangeError crudo ni una salida parcial (§17.10-3)',
    },
  },
  {
    archivo: 'anidamiento-100k-niveles.geojson',
    clausula: '§17.2 (code "profundidad") · §17.8 (ningun camino sin terminacion) · §17.10-3',
    prueba: 'El mismo pozo a 100.000 niveles: pasa cualquier tope razonable y hace explotar a un lector recursivo.',
    espera: {
      tipo: 'ambiguo',
      motivo: 'Mismo hueco que el caso de 64, del otro lado.',
      ramas: [
        'hay tope ⇒ GeoJsonError("profundidad")',
        'no hay tope ⇒ lectura normal: 1/1/1/1/4 con xy [0,0, 1,0, 1,1, 0,0]',
      ],
      invarianteFirme: 'o lectura normal o GeoJsonError("profundidad"); nunca un RangeError crudo (§17.10-3)',
      // Medido en node v24: JSON.parse traga los 100.000 niveles sin chistar. O sea que el oraculo
      // diferencial SI produce una salida para este documento — y si el lector aplica un tope, el
      // test diferencial falla sin que ninguno de los dos este mal. El contrato tiene que elegir.
      choqueConElOraculo: 'JSON.parse acepta el documento; un tope de profundidad lo rechazaria',
    },
  },
  {
    archivo: 'bbox-miles-de-numeros.geojson',
    clausula: '§17.9 (fila "bbox de largo desmedido") · §17.3-9',
    prueba: 'Un bbox de 5.000 numeros en el documento, mas un bbox normal en el feature y otro en la geometria.',
    espera: {
      tipo: 'lectura',
      conteos: { f: 1, g: 1, p: 1, r: 1, v: 4 },
      tablas: { ...UNA_GEOMETRIA_UN_ANILLO, xy: [0, 0, 1, 0, 1, 1, 0, 0], z: null },
      // §17.3-9: bbox se descarta en los tres roles. Los 5.000 numeros no son coordenadas y no entran
      // ni a xy ni al rango de propertiesOf/idOf.
      ausentesDeXY: [0.125, 0.25, 624.875],
      dependeDe: 'la cota dura del bbox, su contador en stats, y si GeoJsonRead expone bbox (ver AMBIGUEDADES)',
    },
  },
  {
    archivo: 'partes-vacias-300.geojson',
    clausula: '§17.9 (filas "coordinates: []" y "contadores de contenedores vacios") · §17.3-8',
    prueba: 'Un MultiPolygon con 300 poligonos vacios seguidos y uno real al final: 300 > 256, el numero en que un contador de un byte da la vuelta.',
    espera: {
      tipo: 'lectura',
      conteos: { f: 1, g: 1, p: 301, r: 1, v: 4 },
      tablas: {
        geometryAt: [0, 1],
        partAt: [0, 301],
        // 301 entradas repetidas en 0 y la ultima en 1: exactamente la tabla donde `lowerBound`
        // devuelve el dueño equivocado y §17.3-8 manda `upperBound - 1`.
        ringAt: [...Array(301).fill(0), 1],
        vertexAt: [0, 4],
        kinds: [6],
        featureOf: [0],
        closed: [1],
        xy: [0, 0, 1, 0, 1, 1, 0, 0],
        z: null,
      },
      ascenso: { partOf: { 0: 300 }, geometryOf: { 300: 0 } },
    },
  },
  {
    archivo: 'anillos-vacios-300.geojson',
    clausula: '§17.9 (filas "coordinates: []" y "contadores de contenedores vacios") · §17.3-8',
    prueba: 'Un Polygon con 300 anillos vacios seguidos y uno real: el mismo desborde, un nivel mas abajo de la cadena.',
    espera: {
      tipo: 'lectura',
      conteos: { f: 1, g: 1, p: 1, r: 301, v: 4 },
      tablas: {
        geometryAt: [0, 1],
        partAt: [0, 1],
        ringAt: [0, 301],
        vertexAt: [...Array(301).fill(0), 4],
        kinds: [5],
        featureOf: [0],
        // Los 300 primeros no tienen vertices, asi que ninguno repite a ninguno.
        closed: [...Array(300).fill(0), 1],
        xy: [0, 0, 1, 0, 1, 1, 0, 0],
        z: null,
      },
      dependeDe: 'closed de un anillo de 0 vertices (ver AMBIGUEDADES)',
    },
  },
  {
    archivo: 'geometrias-nulas-300.geojson',
    clausula: '§17.9 (fila "geometry: null") · §17.3-8',
    prueba: '300 features con geometry null seguidos y uno con Polygon: el contador desbordable en el nivel feature→geometria.',
    espera: {
      tipo: 'lectura',
      conteos: { f: 301, g: 1, p: 1, r: 1, v: 4 },
      tablas: {
        // §17.9: un feature sin geometria cumple geometryAt[i] === geometryAt[i+1].
        geometryAt: [...Array(301).fill(0), 1],
        partAt: [0, 1],
        ringAt: [0, 1],
        vertexAt: [0, 4],
        kinds: [5],
        featureOf: [300],
        closed: [1],
        xy: [0, 0, 1, 0, 1, 1, 0, 0],
        z: null,
      },
      // §17.1: propAt e idAt son [2f]. Con 301 features son 602 entradas, esten pobladas o no.
      largos: { propAt: 602, idAt: 602 },
    },
  },
  {
    archivo: 'truncado-en-numero.geojson',
    clausula: '§17.9 (fila "documento truncado")',
    prueba: 'El documento corta dejando "-70." — un punto decimal sin digitos, donde "truncado" y "numero" compiten por el mismo documento.',
    espera: {
      tipo: 'error',
      code: 'truncado',
      bytes: 262,
      at: 'AMBIGUO (ver AMBIGUEDADES: fin de buffer vs inicio del token)',
    },
  },
  {
    archivo: 'truncado-en-string.geojson',
    clausula: '§17.9 (fila "documento truncado")',
    prueba: 'El documento corta dentro de un string, sin comilla de cierre.',
    espera: { tipo: 'error', code: 'truncado', bytes: 124, at: 'AMBIGUO' },
  },
  {
    archivo: 'truncado-tras-barra-escape.geojson',
    clausula: '§17.9 (fila "documento truncado") · §17.8 (ninguna lectura fuera de rango)',
    prueba: 'El ultimo byte del documento es la barra de escape: quien consume "el caracter escapado" sin mirar el fin del buffer lee un byte que no existe.',
    espera: { tipo: 'error', code: 'truncado', bytes: 118, at: 'AMBIGUO' },
  },
  {
    archivo: 'truncado-en-escape-unicode.geojson',
    clausula: '§17.9 (fila "documento truncado") · §17.8',
    prueba: 'El documento corta a mitad de un \\u00__: faltan dos de los cuatro digitos hexadecimales.',
    espera: { tipo: 'error', code: 'truncado', bytes: 123, at: 'AMBIGUO' },
  },
  {
    archivo: 'truncado-en-array.geojson',
    clausula: '§17.9 (fila "documento truncado")',
    prueba: 'El documento corta con tres contenedores abiertos y el ultimo cierre valido en un anillo: es el caso donde una salida parcial silenciosa seria plausible.',
    espera: {
      tipo: 'error',
      code: 'truncado',
      bytes: 254,
      at: 'AMBIGUO',
      nota: 'Lo prohibido explicitamente es la salida parcial: dos posiciones leidas no pueden salir como geometria.',
    },
  },
  {
    archivo: 'documento-vacio.geojson',
    clausula: '§17.2 (tabla de codes) · §17.3-6',
    prueba: 'Cero bytes. La entrada es de un tipo valido; lo que falta es contenido.',
    espera: {
      tipo: 'ambiguo',
      motivo: 'Ningun code esta asignado al documento vacio. "entrada" esta reservado por §17.3-6 al TIPO de la entrada, no a su contenido.',
      ramas: ['GeoJsonError("truncado")', 'GeoJsonError("sintaxis")', 'GeoJsonError("estructura")'],
      invarianteFirme: 'es un GeoJsonError con code y offset, nunca una excepcion cruda (§17.10-3)',
    },
  },
  {
    archivo: 'solo-espacios.geojson',
    clausula: '§17.2 (tabla de codes) · §17.3-6',
    prueba: 'Los cuatro bytes de espacio en blanco que JSON reconoce (espacio, tab, CR, LF) y nada mas.',
    espera: {
      tipo: 'ambiguo',
      motivo: 'Mismo hueco que el documento vacio.',
      ramas: ['GeoJsonError("truncado")', 'GeoJsonError("sintaxis")', 'GeoJsonError("estructura")'],
      invarianteFirme: 'es un GeoJsonError con code y offset (§17.10-3)',
    },
  },
  {
    archivo: 'null-suelto.geojson',
    clausula: '§17.2 (codes "estructura"/"tipo"/"formato" y `hint`) · §17.10-3',
    prueba: 'JSON perfectamente valido que no es un objeto GeoJSON.',
    espera: {
      tipo: 'ambiguo',
      motivo: '§17 no dice si una raiz que no es objeto GeoJSON es error, ni con que code, ni que `hint` lleva.',
      ramas: [
        'GeoJsonError("estructura")',
        'GeoJsonError("tipo")',
        'GeoJsonError("formato") con hint null',
        'lectura vacia: f = 0, g = 0, todas las tablas en [0]',
      ],
    },
  },
  {
    archivo: 'raiz-escalar-texto-coordinates.geojson',
    clausula: '§17.3-7 · §17.2 (tabla de codes)',
    prueba: 'La raiz entera es el texto "coordinates": la falla #1 del prototipo llevada al documento completo.',
    espera: {
      tipo: 'ambiguo',
      motivo: 'Mismo hueco que null suelto.',
      ramas: ['GeoJsonError("estructura"/"tipo"/"formato")', 'lectura vacia: f = 0, g = 0'],
      // Esto no depende de la rama: §17.3-7 lo garantiza en cualquiera de las dos.
      invarianteFirme: 'no produce ni una geometria ni un vertice — el texto "coordinates" no abre nada',
    },
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Lo que §17 NO determina. Mientras esta lista no este vacia, el contrato no esta cerrado y los casos
// 'ambiguo' de arriba no se pueden asertar.
// ─────────────────────────────────────────────────────────────────────────────
export const AMBIGUEDADES = [
  {
    id: 'stats-sin-forma',
    donde: '§17.1 · §17.3-5 · §17.5 · §17.9',
    que: '`GeoJsonStats` se declara y se le manda contar cuatro cosas distintas (violaciones de geometria, caidas al respaldo numerico, bbox desmedido), pero nunca se enumeran sus campos. Ningun caso puede asertar stats.',
    afecta: ['bbox-miles-de-numeros.geojson', 'anillos-vacios-300.geojson'],
  },
  {
    id: 'bbox-sin-superficie-ni-cota',
    donde: '§17.1 vs §17.9',
    que: '`GeoJsonRead` no declara ningun miembro `bbox`, pero §17.9 dice "bbox = null" para el caso multi-raiz. No se sabe si el bbox se expone, con que forma, ni cual es la "cota dura" a partir de la cual deja de parsearse.',
    afecta: ['bbox-miles-de-numeros.geojson'],
  },
  {
    id: 'tope-de-profundidad',
    donde: '§17.2 (code "profundidad")',
    que: 'El code existe; el tope no. Sin un numero, "cerca del tope" no es escribible y ningun documento puede declarar si debe leerse o fallar. Ademas JSON.parse de node acepta 100.000 niveles (medido), asi que un tope hace fallar al test diferencial de §17.8 sin que ninguna de las dos partes este mal.',
    afecta: ['anidamiento-64-niveles.geojson', 'anidamiento-100k-niveles.geojson', 'gc-anidada-profunda.geojson'],
  },
  {
    id: 'claves-duplicadas',
    donde: '§17.3-2 · §17.3-3',
    que: 'No se declara que pasa con una clave repetida en el mismo objeto (gana la primera, gana la ultima, se acumulan, o es error). El oraculo de §17.8 no puede arbitrarlo: JSON.parse resuelve ultima-gana por su cuenta y eso no es contrato.',
    afecta: ['coordinates-duplicado.geojson', 'type-duplicado.geojson'],
  },
  {
    id: 'escapes-en-el-valor-de-type',
    donde: '§17.3-7 · §17.9',
    que: 'Deshacer escapes se manda para la CLAVE. Un valor "Pol\\u0079gon" es JSON legal y significa Polygon, pero nada dice si se compara con escapes deshechos o si cae por §17.3-1.',
    afecta: ['valor-type-escapado.geojson'],
  },
  {
    id: 'alcance-del-reconocimiento-de-clave',
    donde: '§17.3-7 · §17.3-9 · §17.4',
    que: '"La clave se reconoce solo en posicion de clave" excluye los VALORES de texto, pero no dice que la clave se reconozca unicamente dentro de un objeto geometria. Un `properties` con miembros "type" y "coordinates" —forma real y legal— queda indefinido.',
    afecta: ['clave-coordinates-fuera-de-geometria.geojson'],
  },
  {
    id: 'propertiesOf-devuelve-que',
    donde: '§17.4 vs §17.7',
    que: '§17.4 manda anotar el rango del OBJETO QUE ENVUELVE la geometria (el feature entero, para cubrir los payloads con atributos hermanos de `geometry`), pero el ejemplo de §17.7 hace `propertiesOf(f)?.nombre` como si devolviera el contenido del miembro `properties`. Con la regla de §17.4 ese acceso seria `.properties.nombre`. Ningun caso puede asertar propAt ni el valor de propertiesOf.',
    afecta: ['todos los casos con properties'],
  },
  {
    id: 'at-de-un-truncado',
    donde: '§17.2 ("offset de BYTE donde se detecto") vs §17.9 ("con el offset")',
    que: 'No se declara si `at` es el fin del buffer (donde se detecta) o el inicio del token incompleto (donde empieza el problema). Los cinco truncados registran sus bytes para que la aserción se cierre en cuanto se decida.',
    afecta: ['los 5 truncados'],
  },
  {
    id: 'truncado-vs-numero',
    donde: '§17.2 (codes) vs §17.9',
    que: 'La tabla manda "truncado" para el documento truncado, pero el code "numero" existe y no se dice cuando aplica. Un EOF adentro de un numero incompleto ("-70.") satisface las dos descripciones.',
    afecta: ['truncado-en-numero.geojson'],
  },
  {
    id: 'documento-sin-contenido',
    donde: '§17.2 (codes) · §17.3-6',
    que: 'Cero bytes y solo-espacios no tienen code asignado. "entrada" esta tomado por el tipo de la entrada, asi que quedan repartidos entre "truncado", "sintaxis" y "estructura" sin criterio.',
    afecta: ['documento-vacio.geojson', 'solo-espacios.geojson'],
  },
  {
    id: 'raiz-que-no-es-objeto-geojson',
    donde: '§17.2 (codes y `hint`)',
    que: 'Una raiz `null` o un string suelto son JSON validos que no son GeoJSON. No se declara si son error, con que code, con que `hint`, ni si en cambio salen como lectura vacia.',
    afecta: ['null-suelto.geojson', 'raiz-escalar-texto-coordinates.geojson'],
  },
  {
    id: 'closed-de-un-anillo-vacio',
    donde: '§17.1 (definicion de `closed`)',
    que: '"1 = el ultimo vertice repite al primero" es vacuo sobre un anillo de 0 vertices. La lectura natural es 0, pero no esta declarada, y este corpus tiene 300 de esos anillos.',
    afecta: ['anillos-vacios-300.geojson', 'partes-vacias-300.geojson'],
  },
  {
    id: 'mapeo-parte-anillo-por-kind',
    donde: '§17.1',
    que: 'El nivel parte se justifica y se fija para MultiPolygon (parte = poligono), y de ahi se deriva Polygon = 1 parte. Para Point, MultiPoint, LineString y MultiLineString no se declara cuantas partes ni cuantos anillos produce cada uno — y §17.7 muestra que Point y MultiPoint SI aparecen en `eachRing`.',
    afecta: ['type-duplicado.geojson (si gana MultiPoint)'],
  },
]

// El contrato no esta cerrado mientras esto sea > 0. Lo expone el indice para que el corredor pueda
// fallar ruidosamente en vez de saltear en silencio los casos que todavia no se pueden asertar.
export const CONTRATO_CERRADO = AMBIGUEDADES.length === 0
