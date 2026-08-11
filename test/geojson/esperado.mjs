// Generador de la salida esperada del corpus — contrato: SPECS §17.
//
// POR QUÉ EXISTE. El corpus tiene 45 documentos y la salida esperada de cada uno es una decena de
// tablas tipadas. Escribirlas a mano en el runner las volvería inauditables: nadie revisa un
// `vertexAt` de 302 entradas literal. Este script las DERIVA con el oráculo (§17.8) y las deja al
// lado de cada fixture, en texto, para que entren al control de versiones y un cambio del oráculo
// se lea como un diff en vez de como un test que se puso rojo.
//
// POR QUÉ NO LAS CALCULA EL RUNNER EN CALIENTE. Si el runner corriera el oráculo en el momento,
// una regresión del oráculo movería a la vez la vara y lo medido, y el test seguiría verde. El
// .esperado.json congelado es lo que hace que ese movimiento sea visible.
//
// LO QUE NO DERIVA. `propAt`, `idAt` y `stats`: el oráculo no los produce (rangos de BYTE que el
// grafo ya perdió, y contadores cuya forma §17 no declara). El campo `oraculo` de cada archivo dice
// si el documento pudo derivarse; los que no, quedan con el motivo textual y sin tablas — eso NO es
// un defecto del corpus, es una ambigüedad del contrato hecha explícita.
//
// Uso: node test/geojson/esperado.mjs [--check]
//   sin flag  → escribe/actualiza los .esperado.json
//   --check   → no escribe: sólo informa cuáles cambiarían (para CI)

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { oraculo } from './oraculo.mjs'

export const RAIZ_CORPUS = fileURLToPath(new URL('./corpus/', import.meta.url))

// ── codificación ──────────────────────────────────────────────────────────────────────────────

// JSON no sabe escribir NaN ni -0, y los dos son valores con SIGNIFICADO en la salida de §17: NaN
// en `z` marca "la posición era 2D" y -0 es un lng/lat legal que no debe confundirse con 0. Por eso
// viajan como texto y se restauran al leer; usar `null` para NaN los haría indistinguibles de un
// hueco y taparía justo la clase de diferencia que el corpus existe para atrapar.
const ESPECIALES = new Map([[NaN, 'NaN'], [Infinity, 'Infinity'], [-Infinity, '-Infinity'], [-0, '-0']])

const codificarNumero = n =>
  Object.is(n, -0)      ? '-0'
  : Number.isFinite(n)  ? n
  : ESPECIALES.get(n) ?? String(n)

const decodificarNumero = x =>
  typeof x !== 'string' ? x
  : x === 'NaN'         ? NaN
  : x === 'Infinity'    ? Infinity
  : x === '-Infinity'   ? -Infinity
  : x === '-0'          ? -0
  : Number(x)

// Las tablas viajan como arrays JS planos: el .esperado.json es material de LECTURA humana y un
// `{"0":1,"1":2}` (lo que da JSON.stringify de un TypedArray) no se revisa en un diff.
export const codificarTablas = salida =>
  Object.fromEntries(Object.entries(salida).map(([k, v]) =>
    [k, v === null ? null : ArrayBuffer.isView(v) ? Array.from(v, codificarNumero) : v]))

export const decodificarTabla = v => v === null ? null : v.map(decodificarNumero)

// ── recorrido del corpus ──────────────────────────────────────────────────────────────────────

// Se recorre el DIRECTORIO y no los `indice.mjs` de cada categoría: los cinco índices exportan con
// nombres y formas distintas (`casos`, `CASOS`, `CASOS_RFC`), y un archivo que se sume al corpus sin
// pasar por su índice se quedaría sin esperado en silencio. El disco es la fuente de verdad.
export const fixtures = (raiz = RAIZ_CORPUS) =>
  readdirSync(raiz, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.geojson'))
    .map(e => join(e.parentPath ?? e.path, e.name))
    .sort()

export const rutaEsperado = geojson => geojson.replace(/\.geojson$/, '.esperado.json')

export const nombreCorto = geojson => geojson.slice(RAIZ_CORPUS.length).replaceAll('\\', '/')

// ── lo que el oráculo NO puede derivar, y sale del contrato ───────────────────────────────────

// §17.9, fila "documento truncado": `GeoJsonError('truncado')` con el offset, nunca una salida
// parcial silenciosa. El oráculo no llega a estos documentos —JSON.parse revienta antes—, así que el
// veredicto se toma de la tabla del contrato, que es la fuente correcta igual.
// El `at` NO entra: §17 exige "con el offset" pero no dice CUÁL, y cada uno de estos documentos
// admite más de un punto de detección razonable (ver ambigüedades).
const CODIGO_DEL_CONTRATO = {
  'adversarios/truncado-en-numero.geojson'        : 'truncado',
  'adversarios/truncado-en-string.geojson'        : 'truncado',
  'adversarios/truncado-tras-barra-escape.geojson': 'truncado',
  'adversarios/truncado-en-escape-unicode.geojson': 'truncado',
  'adversarios/truncado-en-array.geojson'         : 'truncado',
  // §17.9: nada que haya empezado — distinto de `truncado`, que es una estructura abierta sin cerrar.
  'adversarios/documento-vacio.geojson'           : 'sintaxis',
  'adversarios/solo-espacios.geojson'             : 'sintaxis',
  // §17.9: la raíz tiene que ser un objeto.
  'adversarios/null-suelto.geojson'                    : 'formato',
  'adversarios/raiz-escalar-texto-coordinates.geojson' : 'formato',
  // §17.9 resuelve la clave duplicada con última-gana, y entonces §17.1 valida la profundidad contra
  // el tipo ganador y no coincide. Los dos pasos son del contrato: el caso quedó determinado.
  'adversarios/type-duplicado.geojson'            : 'estructura',
  // §17.3-15: el objeto afirma que contiene geometrías y que es una. El oráculo NO puede derivarlo
  // —se planta, y con razón— pero el contrato nombra el code, así que el veredicto sale de ahí. Los
  // tres órdenes están para que el mismo objeto no salga distinto según dónde cayó cada miembro.
  'adversarios/geometries-y-type-hoja-coords-antes.geojson'  : 'estructura',
  'adversarios/geometries-y-type-hoja-coords-despues.geojson': 'estructura',
  'adversarios/geometries-vacio-y-type-hoja.geojson'         : 'estructura',
  // §17.2 fija `maxDepth` en 512. El oráculo no puede arbitrarlo —JSON.parse de Node se traga los
  // 100.000 niveles— pero el contrato sí lo determina, y el árbitro es el contrato.
  'adversarios/anidamiento-100k-niveles.geojson'  : 'profundidad',
  // Un contenedor que NO escribe marco deja el slot de su profundidad con lo que puso el anterior, y
  // `geometryPos` es el unico lugar que lee el slot de un nivel ajeno. §17.3-11 y la validacion de
  // profundidad de §17.1 los determinan como error; el corpus no tenia esta forma, y sin ella una
  // version del lector que la lea mal pasa las 1128 pruebas y el fuzzer.
  'adversarios/slot-sembrado-geometry.geojson'      : 'estructura',
  'adversarios/slot-sembrado-tras-anillo.geojson'   : 'posicion',
  'adversarios/slot-sembrado-multipoligono.geojson' : 'posicion',
  'adversarios/geometria-dentro-de-posicion.geojson': 'estructura',
  // §17.9: un documento de otro formato no es una lectura válida de cero features. El oráculo los
  // parsea sin problema —son JSON legal— así que el veredicto sale del contrato.
  'adversarios/raiz-topojson.geojson'  : 'formato',
  'adversarios/raiz-esrijson.geojson'  : 'formato',
}

// Documentos donde el oráculo SÍ produce tablas pero §17 no determina que sean ÉSAS. Entran al
// corpus igual —de hecho entran por eso— y quedan anotados para que el runner no los aserte: un test
// que elige una rama convierte la ambigüedad en contrato por la puerta de atrás, y encima horneando
// una decisión de JSON.parse (última-gana en claves duplicadas, escapes deshechos en los valores,
// BOM comido por TextDecoder) que el contrato nunca declaró.
//
// `'*'` = ninguna tabla se asierta. Una lista = sólo esas tablas quedan afuera.
// Casos donde el ORÁCULO no puede arbitrar. Ojo con la distinción: no es «el contrato no lo dice»
// —eso lo cerró la compuerta 0 y ya no queda ninguno— sino «el contrato lo dice, y el oráculo no
// puede reproducirlo porque corre sobre JSON.parse». Es un límite de la referencia, no del diseño.
const SIN_ARBITRO = {
  'entradas/secuencia-bbox-multiraiz.geojson': ['*',
    '§17.9 manda leer las varias raíces y dejar stats.roots > 1, pero JSON.parse sólo lee UN valor: el oráculo no puede producir la referencia de una secuencia RFC 8142. Las tablas de cada raíz quedan cubiertas por las fixtures de raíz única.'],
}

// ── derivación ────────────────────────────────────────────────────────────────────────────────

// El oráculo se planta a propósito donde §17 no determina la salida, y JSON.parse revienta sobre los
// documentos truncados: las dos cosas son RESULTADOS del corpus, no fallas del script. Se capturan y
// se anotan con su motivo para que el runner sepa que ese caso no tiene tablas que comparar todavía.
const derivar = bytes => {
  try {
    const { conteos, ...tablas } = oraculo(bytes)
    return {
      oraculo: 'ok',
      conteos,
      tablas: codificarTablas(tablas),
    }
  } catch (e) {
    return {
      oraculo: e instanceof SyntaxError ? 'json-invalido' : 'plantado',
      motivo: e.message,
    }
  }
}

// El veredicto es lo que el runner puede EXIGIR, y se decide con el contrato en la mano — no con lo
// que haya salido del oráculo:
//   'error'   §17 nombra el code. Se asierta el code; el `at` no (§17 pide "el offset", no cuál).
//   'lectura' el oráculo derivó las tablas y §17 las determina: se asiertan.
//   'abierto' §17 no determina la respuesta. Lo único exigible es §17.10-3: si lanza, tiene que ser
//             un GeoJsonError con `code` y `at`, nunca una excepción cruda.
const veredictoDe = (fixture, derivado) =>
  CODIGO_DEL_CONTRATO[fixture] ? { veredicto: 'error', code: CODIGO_DEL_CONTRATO[fixture] }
  : derivado.oraculo !== 'ok'
      ? { veredicto: 'abierto', porque: SIN_ARBITRO[fixture]?.[1] ?? `el oráculo no pudo derivarlo (${derivado.oraculo}) y §17 no nombra el code` }
  : !SIN_ARBITRO[fixture] ? { veredicto: 'lectura' }
  : { veredicto: 'lectura', noAsertar: SIN_ARBITRO[fixture][0], porque: SIN_ARBITRO[fixture][1] }

export const esperadoDe = geojson => {
  const bytes = new Uint8Array(readFileSync(geojson))
  const fixture = nombreCorto(geojson)
  const derivado = derivar(bytes)
  return { fixture, bytes: bytes.length, ...veredictoDe(fixture, derivado), ...derivado }
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────

const serializar = registro => `${JSON.stringify(registro, null, 2)}\n`

const leerSiExiste = ruta => { try { return readFileSync(ruta, 'utf8') } catch { return null } }

const main = soloChequear => {
  const filas = fixtures().map(geojson => {
    const registro = esperadoDe(geojson)
    const destino = rutaEsperado(geojson)
    const texto = serializar(registro)
    const previo = leerSiExiste(destino)
    if (!soloChequear && previo !== texto) writeFileSync(destino, texto)
    return { ...registro, cambio: previo === null ? 'nuevo' : previo === texto ? 'igual' : 'cambia' }
  })

  filas.forEach(r => console.log(
    [
      r.cambio.padEnd(6),
      r.oraculo.padEnd(13),
      r.fixture.padEnd(52),
      r.oraculo === 'ok' ? JSON.stringify(r.conteos) : r.motivo,
    ].join(' '),
  ))

  const derivados = filas.filter(r => r.oraculo === 'ok').length
  console.log(`\n${filas.length} fixtures · ${derivados} con tablas · ${filas.length - derivados} sin derivar`)
  return filas
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  main(process.argv.includes('--check'))
}
