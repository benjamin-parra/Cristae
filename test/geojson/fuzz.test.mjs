// Fuzzer de mutación de bytes del lector de GeoJSON — contrato: SPECS §17.8.
//
// QUÉ PROMETE. Sobre CUALQUIER entrada, por corrupta que sea:
//   1. ninguna lectura fuera de rango,
//   2. ningún camino sin terminación,
//   3. ninguna excepción cruda: todo lo que sale es un GeoJsonError con `code` y `at` (§17.10-3),
//   4. si el mutante sigue siendo JSON válido, la salida coincide con el oráculo sobre ESE mutante.
//
// CÓMO SE VERIFICA CADA UNA. Las cuatro son afirmaciones sobre lo que NO pasa, y una promesa
// negativa sólo se prueba si se elige bien el testigo:
//
//   1. En JS una lectura fuera de rango no revienta: devuelve `undefined` y sigue. Así que el
//      testigo no es una excepción sino una DIFERENCIA — cada mutante se lee dos veces, una como
//      copia justa y otra como vista con orla envenenada (§17.3-6, el `Buffer` pooled de Node). Si
//      el escáner se sale del rango o ignora el `byteOffset`, lee el veneno y las dos lecturas
//      dejan de coincidir. Comparar el documento contra sí mismo es lo que vuelve visible lo que de
//      otro modo no tiene síntoma.
//   2. Un presupuesto de TIEMPO por caso, no de iteraciones: un contador de vueltas no distingue
//      "lento" de "colgado" y encima obliga a adivinar cuántas vueltas son demasiadas. Como no se
//      puede interrumpir código síncrono desde el propio hilo, el lote corre en un worker que late
//      en un SharedArrayBuffer antes de cada caso y el hilo del test lo termina si el latido
//      envejece.
//   3. `esErrorDelLector` mira la FORMA (`name`/`code`/`at`) y no `instanceof`: la clase vive en el
//      lector, que todavía no existe.
//   4. Diferencial contra el oráculo, pero sólo donde el oráculo PUEDE arbitrar (ver `arbitroDe`).
//      Corromper bytes fabrica documentos ambiguos gratis —clave duplicada, raíz que deja de ser
//      FeatureCollection, UTF-8 roto—; asertar ahí convertiría un hueco de §17 en contrato por la
//      puerta de atrás, que es justo lo que el corpus evita caso por caso.
//
// SEMILLA FIJA. Nada de `Math.random()`: un fuzzer que no se repite encuentra el bug una vez y
// después no lo puede mostrar. El mutante N de una fixture se deriva de `(SEMILLA, fixture, N)`, así
// que cualquier caso se regenera SUELTO —sin correr los miles anteriores— con `casoDe`.
//
// HOY ESTÁ PENDIENTE. `leer` todavía lanza `LectorNoImplementado`: el lote se marca `skip`, por el
// mismo enganche que el runner del corpus (`./lector.mjs`). Lo que NO necesita al lector —la máquina
// de mutación, el árbitro, el vigía— corre desde hoy: un fuzzer que genera cero casos pasa igual de
// verde que uno que funciona, y ésa es la falla que estos tests vigilan.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { comparar, oraculo } from './oraculo.mjs'
import { esErrorDelLector, leer } from './lector.mjs'
import { fixtures, rutaEsperado } from './esperado.mjs'

// ── parámetros ────────────────────────────────────────────────────────────────────────────────

// El default es FIJO y es el que corre en CI. Las tres variables de entorno existen para ampliar la
// búsqueda a mano (otra semilla = otro corpus de mutantes) sin editar el archivo; mover el default
// se hace en un commit, para que el corpus de mutantes que corrió ayer sea el que corre hoy.
const SEMILLA = Number(process.env.GEOJSON_FUZZ_SEMILLA ?? 0x5EEDC0DE)
const CASOS_POR_SEMILLA = Number(process.env.GEOJSON_FUZZ_CASOS ?? 120)
const PRESUPUESTO_MS = Number(process.env.GEOJSON_FUZZ_MS ?? 2000)

// Techo de tamaño de la SEMILLA (no del mutante). El corpus trae un documento de 100.000 niveles y
// 200 KB: mutarlo 120 veces se lleva el lote entero sin aportar variedad, y encima su veredicto ya
// es 'abierto' (§17 no fija tope de profundidad), así que ni siquiera entraría al diferencial.
const LIMITE_SEMILLA = 64 * 1024

// Tramo máximo que copia la mutación `duplicado`. Sin tope, duplicar un tramo grande crece el
// mutante hacia el doble en cada caso y el fuzzer termina midiendo al asignador de memoria.
const TRAMO_MAX = 512

// ── generador determinista ────────────────────────────────────────────────────────────────────

// FNV-1a sobre el texto `SEMILLA|fixture|indice`: se mezcla la identidad ENTERA del caso y no un
// contador global, así el mutante N de una fixture no depende de cuántas fixtures hubo antes.
// Agregar un documento al corpus no debe mover los mutantes de los demás.
const mezclar = texto =>
  [...texto].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 0x01000193), 0x811C9DC5) >>> 0

// mulberry32: 32 bits de estado, sin dependencias, misma secuencia en cualquier runtime. El `let`
// reasignado es el estado del generador — es lo único que un PRNG es.
const generador = semilla => () => {
  let t = (semilla = (semilla + 0x6D2B79F5) | 0)
  t = Math.imul(t ^ (t >>> 15), 1 | t)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const entero = (rng, n) => Math.floor(rng() * n)

// ── mutaciones ────────────────────────────────────────────────────────────────────────────────

// Corchete, llave, comilla y barra: los bytes que cambian la ESTRUCTURA del documento en vez de su
// contenido. Un byte de texto puesto al azar casi siempre invalida el JSON ahí mismo; uno de éstos
// abre un contenedor que nunca cierra, cierra uno que nunca abrió o parte una cadena al medio — que
// son los caminos donde un escáner de una sola pasada se sale del rango o no termina.
const ESTRUCTURALES = Uint8Array.from([0x5B, 0x5D, 0x7B, 0x7D, 0x22, 0x5C])   // [ ] { } " \

const glifo = b => `«${String.fromCharCode(b)}»`

// Voltea UN bit y no el byte entero: a un bit de distancia el byte se queda en su vecindario ASCII
// (un dígito sigue siendo dígito, una letra sigue siendo letra) y salen los mutantes que siguen
// siendo JSON válido — los únicos sobre los que el diferencial de la promesa 4 tiene algo que decir.
const volteo = (bytes, rng) => {
  const i = entero(rng, bytes.length)
  const bit = entero(rng, 8)
  const salida = Uint8Array.from(bytes)
  salida[i] ^= 1 << bit
  return { bytes: salida, donde: i, detalle: `bit ${bit}` }
}

const truncado = (bytes, rng) => {
  const corte = entero(rng, bytes.length)          // [0, largo-1]: siempre corta algo
  return { bytes: bytes.slice(0, corte), donde: corte, detalle: `-${bytes.length - corte} bytes` }
}

const duplicado = (bytes, rng) => {
  const desde = entero(rng, bytes.length)
  const largo = 1 + entero(rng, Math.min(bytes.length - desde, TRAMO_MAX))
  const salida = new Uint8Array(bytes.length + largo)
  salida.set(bytes.subarray(0, desde + largo), 0)
  salida.set(bytes.subarray(desde, desde + largo), desde + largo)
  salida.set(bytes.subarray(desde + largo), desde + 2 * largo)
  return { bytes: salida, donde: desde, detalle: `tramo de ${largo}` }
}

const insercion = (bytes, rng) => {
  const i = entero(rng, bytes.length + 1)          // el final también es una posición válida
  const byte = ESTRUCTURALES[entero(rng, ESTRUCTURALES.length)]
  const salida = new Uint8Array(bytes.length + 1)
  salida.set(bytes.subarray(0, i), 0)
  salida[i] = byte
  salida.set(bytes.subarray(i), i + 1)
  return { bytes: salida, donde: i, detalle: glifo(byte) }
}

const borrado = (bytes, rng) => {
  const i = entero(rng, bytes.length)
  const salida = new Uint8Array(bytes.length - 1)
  salida.set(bytes.subarray(0, i), 0)
  salida.set(bytes.subarray(i + 1), i)
  return { bytes: salida, donde: i, detalle: glifo(bytes[i]) }
}

const MUTACIONES = { volteo, truncado, duplicado, insercion, borrado }

export const NOMBRES_MUTACION = Object.freeze(Object.keys(MUTACIONES))

export const mutar = (bytes, fixture, indice) => {
  const rng = generador(mezclar(`${SEMILLA}|${fixture}|${indice}`))
  const mutacion = NOMBRES_MUTACION[entero(rng, NOMBRES_MUTACION.length)]
  return { mutacion, ...MUTACIONES[mutacion](bytes, rng) }
}

export const receta = caso =>
  `${caso.fixture} #${caso.indice} [${caso.mutacion} @${caso.donde} ${caso.detalle}] semilla=${SEMILLA}`

// ── semillas: los documentos VÁLIDOS del corpus ───────────────────────────────────────────────

// "Válido" = el oráculo lo derivó (`oraculo: 'ok'`). Un documento que ya era JSON inválido no sirve
// de semilla: corromperlo más no llega a ningún borde nuevo y, sobre todo, no hay línea de base
// contra la cual leer al mutante. Ese lado ya lo cubren los truncados del corpus, y acá se fabrican
// truncados propios a partir de documentos sanos.
const semillasDelCorpus = () => fixtures()
  .map(ruta => ({ ruta, esperado: JSON.parse(readFileSync(rutaEsperado(ruta), 'utf8')) }))
  .filter(({ esperado }) => esperado.oraculo === 'ok' && esperado.bytes > 0 && esperado.bytes <= LIMITE_SEMILLA)
  .map(({ ruta, esperado }) => ({
    ruta,
    fixture: esperado.fixture,
    // Si §17 ya no determinaba la salida de la semilla, tampoco determina la del mutante: el hueco
    // del contrato viaja con el documento. Estas semillas se fuzzean igual —las tres primeras
    // promesas valen sobre TODO— pero quedan fuera del diferencial.
    arbitrable: esperado.veredicto === 'lectura' && !esperado.noAsertar,
  }))

// Los bytes de la semilla se memoizan porque el plan vuelve a la misma fixture 120 veces y ninguna
// mutación escribe sobre ellos (todas devuelven un array nuevo).
const memoria = new Map()
const bytesDe = ruta => memoria.get(ruta) ?? memoria.set(ruta, new Uint8Array(readFileSync(ruta))).get(ruta)

// El plan es la lista de CASOS, no de mutantes: los bytes se fabrican al llegar a cada uno. Tener
// los miles de mutantes vivos a la vez es memoria que ningún test necesita, y el plan tiene que
// poder armarse en el hilo del test para reconstruir un caso colgado sin ejecutar nada.
export const planDe = (semillas, casos) =>
  semillas.flatMap(semilla => Array.from({ length: casos }, (_, indice) => ({ ...semilla, indice })))

export const casoDe = entrada => ({ ...entrada, ...mutar(bytesDe(entrada.ruta), entrada.fixture, entrada.indice) })

// ── el testigo de la lectura fuera de rango ───────────────────────────────────────────────────

// Bytes que cambian el significado del documento si el escáner llega a leerlos: abren y cierran
// contenedores, abren una cadena, meten un dígito y una barra de escape. Un relleno de ceros o de
// espacios no sirve de veneno — un escáner que se pasa del final los saltearía como blanco y la
// lectura fuera de rango quedaría sin síntoma, que es exactamente lo que hay que evitar.
const VENENO = Uint8Array.from([0x7B, 0x22, 0x5B, 0x39, 0x2C, 0x5C, 0x5D, 0x7D])
const ORLA = 8

export const vistaEnvenenada = bytes => {
  const buffer = new Uint8Array(bytes.length + 2 * ORLA)
  buffer.forEach((_, i) => { buffer[i] = VENENO[i % VENENO.length] })
  buffer.set(bytes, ORLA)
  return buffer.subarray(ORLA, ORLA + bytes.length)
}

// ── árbitro: cuándo el oráculo puede juzgar al mutante ────────────────────────────────────────

const decodificador = new TextDecoder('utf-8', { ignoreBOM: true })
const codificador = new TextEncoder()

const intentar = fn => {
  try { return { ok: true, valor: fn() } } catch (error) { return { ok: false, error } }
}

// El oráculo trabaja sobre texto decodificado y el lector sobre bytes. Si los bytes no son UTF-8
// válido los dos ven documentos DISTINTOS —el decodificador mete U+FFFD donde el lector ve la
// secuencia cruda—, así que una diferencia ahí no diría nada del lector. Es la misma salvedad que el
// runner del corpus le aplica a la forma `string`.
const esUtf8Exacto = bytes => {
  const ida = codificador.encode(decodificador.decode(bytes))
  return ida.length === bytes.length && ida.every((b, i) => b === bytes[i])
}

const finDeCadena = (texto, inicio) => {
  let i = inicio + 1
  while (i < texto.length) {
    if (texto[i] === '\\') i += 2
    else if (texto[i] === '"') return i + 1
    else i++
  }
  return texto.length
}

const noBlanco = (texto, i) => {
  let j = i
  while (j < texto.length && ' \t\r\n'.includes(texto[j])) j++
  return j
}

// POR QUÉ UN TOKENIZADOR Y NO `JSON.parse`. Para cuando el reviver ve una clave, el motor ya
// resolvió la duplicada por última-gana y no queda rastro. Y hay que detectarla porque `duplicado`
// fabrica claves repetidas sin esfuerzo (copiar un tramo que contenga `"coordinates": […]`) — que es
// justo el caso que el corpus dejó SIN árbitro: RFC 8259 dice que las claves SHOULD ser únicas, no
// MUST, y §17 no elige quién gana.
// El recorrido es un `while` explícito y no un pipeline porque tokenizar es intrínsecamente
// secuencial: cada paso empieza donde terminó el anterior. Se apoya en que el texto ya pasó por
// `JSON.parse`, así que está bien formado y no hay de qué defenderse.
export const clavesDuplicadas = texto => {
  const pila = []            // un Set por objeto abierto; null por array abierto
  let i = 0
  while (i < texto.length) {
    const c = texto[i]
    if (c === '{') { pila.push(new Set()); i++ }
    else if (c === '[') { pila.push(null); i++ }
    else if (c === '}' || c === ']') { pila.pop(); i++ }
    else if (c !== '"') i++
    else {
      const crudo = texto.slice(i, (i = finDeCadena(texto, i)))
      if (texto[noBlanco(texto, i)] !== ':' || !(pila.at(-1) instanceof Set)) continue
      // §17.3-7: la clave se compara con los escapes DESHECHOS, así que `type` y `type` son la
      // misma clave y duplicarse entre sí cuenta.
      const clave = JSON.parse(crudo)
      if (pila.at(-1).has(clave)) return true
      pila.at(-1).add(clave)
    }
  }
  return false
}

const noJuzga = motivo => ({ juzga: false, motivo })

const arbitroDe = (bytes, arbitrable) => {
  const texto = arbitrable && esUtf8Exacto(bytes) ? decodificador.decode(bytes) : null
  const grafo = texto === null ? null : intentar(() => JSON.parse(texto))
  const derivado = grafo?.ok ? intentar(() => oraculo(bytes)) : null
  return !arbitrable ? noJuzga('la semilla ya era ambigua para §17')
    : texto === null ? noJuzga('el mutante no es UTF-8 válido')
    : !grafo.ok      ? noJuzga('el mutante dejó de ser JSON válido')
    // §17 no dice qué es el nivel feature cuando la raíz es una geometría suelta (el corpus lo tiene
    // declarado como ambigüedad), y una mutación fabrica esa forma desde cualquier semilla.
    : !Array.isArray(grafo.valor?.features) ? noJuzga('la raíz dejó de ser una FeatureCollection')
    : clavesDuplicadas(texto)                ? noJuzga('el mutante tiene una clave duplicada')
    // El oráculo se planta a propósito donde §17 no determina la salida. Cada plantada es una
    // ambigüedad, no una falla: el mutante se sigue midiendo con las tres primeras promesas.
    : !derivado.ok ? noJuzga(`el oráculo se plantó: ${derivado.error.message}`)
    : { juzga: true, tablas: derivado.valor }
}

// ── comparación diferencial ───────────────────────────────────────────────────────────────────

const TABLAS = ['geometryAt', 'partAt', 'ringAt', 'vertexAt', 'kinds', 'featureOf', 'closed', 'xy', 'z']

// El mapeo Multi* → (partes, anillos) no está tabulado en §17: un MultiPoint de N puede salir como
// 1 anillo de N o como N anillos de 1. Una mutación puede meter un MultiPoint donde no había (basta
// duplicar un tramo con ese `type`), así que la exención se decide por lo que el oráculo LEYÓ en el
// mutante y no por la fixture de la que salió.
const MULTI_INDECISO = ['partAt', 'ringAt', 'vertexAt', 'closed']

const fueraDeArbitraje = kinds => ([...kinds].some(k => k === 2 || k === 4) ? MULTI_INDECISO : [])

// §17.1 define `closed` como "el último vértice repite al primero": sobre un anillo de 0 o 1
// vértices la frase es vacua y las dos lecturas son defendibles. Las celdas se quitan de los DOS
// lados —nunca se pisa el valor del lector con el del oráculo—, igual que en el runner del corpus.
const indecisosDe = vertexAt =>
  new Set([...vertexAt].slice(1).flatMap((fin, r) => (fin - vertexAt[r] < 2 ? [r] : [])))

const comoArray = v => (v === null || v === undefined ? v : Array.from(v))

const recortar = (fuente, fuera, indecisos) =>
  Object.fromEntries(TABLAS.filter(t => !fuera.includes(t)).map(t => [
    t,
    t === 'closed' && fuente[t] != null
      ? Array.from(fuente[t]).filter((_, r) => !indecisos.has(r))
      : comoArray(fuente[t]),
  ]))

// §17.2 lista el code `profundidad` pero §17 no fija NINGÚN tope de anidamiento — el corpus ya tiene
// sus dos fixtures de anidamiento en 'abierto' por este mismo hueco. Como `insercion` fabrica
// niveles nuevos con un `[`, plantarse por profundidad sobre un mutante que el oráculo sí deriva es
// una respuesta legítima mientras el contrato no elija. Cuando §17 fije el tope, esto se borra.
const CODIGOS_TOLERADOS = new Set(['profundidad'])

// ── invariantes universales sobre CUALQUIER salida ────────────────────────────────────────────

// Se re-declaran acá en vez de importarse del runner del corpus: `corpus.test.mjs` es un archivo de
// tests e importarlo desde otro registraría sus tests una segunda vez. Cuando el lector exista y las
// dos copias tengan que moverse juntas, el lugar de la unificación es un módulo aparte.
const verificarCSR = (nombre, tabla, total, r) => {
  assert.equal(tabla[0], 0, `${r} · ${nombre}: una tabla CSR arranca en 0`)
  assert.equal(tabla.at(-1), total, `${r} · ${nombre}: una tabla CSR termina en el total del nivel de abajo`)
  assert.ok([...tabla].every((x, i) => i === 0 || x >= tabla[i - 1]), `${r} · ${nombre}: una tabla CSR no decrece`)
}

// No se exige que `xy` sea finito: `1e999` es JSON legal y una mutación lo fabrica cambiando un
// dígito, así que un Infinity en `xy` puede ser la lectura CORRECTA de basura legal. Lo exigible es
// que las tablas cierren entre sí — ahí es donde asoma la cadena CSR corrida por una ranura.
const verificarSellado = (s, entrada, r) => {
  const g = s.kinds.length
  const f = s.geometryAt.length - 1
  assert.equal(s.featureOf.length, g, `${r} · §17.3-3: featureOf.length === g`)
  assert.equal(s.partAt.length, g + 1, `${r} · §17.3-3: partAt.length === g + 1`)
  assert.equal(s.closed.length, s.vertexAt.length - 1, `${r} · §17.1: closed tiene una entrada por anillo`)
  assert.ok([...s.kinds].every(k => k >= 1 && k <= 6), `${r} · §17.1: el 0 no sobrevive al sellado`)
  assert.ok([...s.featureOf].every(i => i < f), `${r} · §17.1: featureOf apunta a un feature que existe`)
  assert.ok(s.z === null || s.z.length === s.xy.length / 2, `${r} · §17.1: z tiene una entrada por vértice`)
  assert.equal(s.propAt.length, 2 * f, `${r} · §17.1: propAt es [2f]`)
  assert.equal(s.idAt.length, 2 * f, `${r} · §17.1: idAt es [2f]`)
  // §17.3-10 retiene la ENTRADA, no el buffer que la contiene: si `bytes` sale más largo que lo que
  // se le pasó, el lector se quedó con el ArrayBuffer entero y `propertiesOf` puede devolver memoria
  // ajena — el mismo agujero que §17.3-6 cierra con el `byteOffset`.
  assert.ok(s.bytes === null || s.bytes.byteLength === entrada.byteLength,
    `${r} · §17.3-6: retuvo ${s.bytes?.byteLength} bytes y la entrada tenía ${entrada.byteLength}`)
  verificarCSR('geometryAt', s.geometryAt, g, r)
  verificarCSR('partAt', s.partAt, s.ringAt.length - 1, r)
  verificarCSR('ringAt', s.ringAt, s.vertexAt.length - 1, r)
  verificarCSR('vertexAt', s.vertexAt, s.xy.length / 2, r)
}

// Un error cuenta como resultado comparable: dos presentaciones de la MISMA entrada que fallan
// distinto son tan desacuerdo como dos que leen distinto.
const resultadoDe = entrada => {
  try {
    const salida = leer(entrada)
    return { salida, comparable: { ok: true, tablas: TABLAS.map(t => comoArray(salida[t])) } }
  } catch (error) {
    return { error, comparable: { ok: false, name: error?.name, code: error?.code, at: error?.at } }
  }
}

// ── el caso ───────────────────────────────────────────────────────────────────────────────────

const asertarCaso = (caso, censo) => {
  const r = receta(caso)
  const justa = resultadoDe(caso.bytes)
  const enOrla = resultadoDe(vistaEnvenenada(caso.bytes))

  // Promesa 1. Las dos entradas son el MISMO documento; lo único distinto es qué hay antes y después
  // en memoria. Cualquier diferencia acá es una lectura fuera de rango o un `byteOffset` ignorado.
  assert.deepEqual(enOrla.comparable, justa.comparable,
    `${r} · §17.3-6: el mismo documento, leído como vista con orla envenenada, dio otro resultado`)

  const arbitro = arbitroDe(caso.bytes, caso.arbitrable)
  censo.casos++
  if (arbitro.juzga) censo.juzgados++

  if (justa.error) {
    // Promesa 3.
    assert.ok(esErrorDelLector(justa.error),
      `${r} · §17.10-3: escapó una excepción cruda (${justa.error?.name}: ${justa.error?.message})`)
    censo.codigos[justa.error.code] = (censo.codigos[justa.error.code] ?? 0) + 1
    // Promesa 4, del lado "se plantó donde el oráculo sí lee".
    assert.ok(!arbitro.juzga || CODIGOS_TOLERADOS.has(justa.error.code),
      `${r} · el mutante sigue siendo JSON válido y el oráculo lo deriva, pero el lector tiró '${justa.error.code}' @ ${justa.error.at}`)
    return
  }

  censo.lecturas++
  verificarSellado(justa.salida, caso.bytes, r)
  if (!arbitro.juzga) return

  // Promesa 4.
  const fuera = fueraDeArbitraje(arbitro.tablas.kinds)
  const indecisos = indecisosDe(arbitro.tablas.vertexAt)
  assert.deepEqual(
    comparar(recortar(arbitro.tablas, fuera, indecisos), recortar(justa.salida, fuera, indecisos)),
    [],
    `${r} · la salida no coincide con el oráculo sobre el mutante`,
  )
}

// ── el lote, adentro del worker ───────────────────────────────────────────────────────────────

const latir = (latido, n, origen) => {
  Atomics.store(latido, 0, n)
  Atomics.store(latido, 1, Date.now() - origen)
}

const correlato = { falla: null }

const correrLote = ({ semillas, casos, sab, origen }) => {
  const latido = new Int32Array(sab)
  const censo = { casos: 0, juzgados: 0, lecturas: 0, codigos: {} }

  // `find` y no `forEach`: el primer caso que rompe CORTA el lote. Seguir fuzzeando después de una
  // falla entierra el caso reproducible abajo de miles de mutantes que ya no significan nada.
  planDe(semillas, casos).find((entrada, n) => {
    latir(latido, n, origen)
    const caso = casoDe(entrada)
    // La falla viaja como DATO: una AssertionError no sobrevive al clonado estructurado entre hilos,
    // y del otro lado lo que importa es la receta para reproducir el caso.
    const fallo = intentar(() => asertarCaso(caso, censo))
    correlato.falla = fallo.ok ? null : { receta: receta(caso), mensaje: fallo.error.message }
    return correlato.falla !== null
  })

  return { falla: correlato.falla, censo }
}

// El worker se auto-hospeda: este mismo archivo es el entry. Un archivo aparte no lo tomaría
// `node --test` (no matchea `*.test.mjs`) y el fuzzer quedaría partido en dos para nada.
if (!isMainThread) {
  parentPort.postMessage({ listo: true })
  const latido = new Int32Array(workerData.sab)
  // Autoprueba del vigía: un caso que no termina. El cuerpo hace trabajo real —un bucle vacío es
  // código que un optimizador puede tratar distinto, y acá se está probando justamente que el hilo
  // NO se interrumpe solo.
  if (workerData.modo === 'colgar') latir(latido, 0, workerData.origen)
  while (workerData.modo === 'colgar') Atomics.load(latido, 0)
  parentPort.postMessage({ fin: correrLote(workerData) })
}

// ── hilo del test ─────────────────────────────────────────────────────────────────────────────

// El presupuesto se vigila desde AFUERA porque desde adentro no se puede: el código síncrono no cede
// el hilo, así que ningún temporizador del propio worker llegaría a dispararse. `terminate()` sí
// corta una ejecución síncrona, y el latido en memoria compartida es lo único que cruza sin que el
// worker tenga que colaborar.
const lanzarWorker = (datos, presupuesto) => new Promise((resolve, reject) => {
  const origen = Date.now()
  const sab = new SharedArrayBuffer(8)
  const latido = new Int32Array(sab)
  const worker = new Worker(new URL(import.meta.url), { workerData: { ...datos, sab, origen } })
  const estado = { vigia: null, cerrado: false }

  const cerrar = (accion, valor) => {
    if (estado.cerrado) return
    estado.cerrado = true
    clearInterval(estado.vigia)
    worker.terminate().then(() => accion(valor))
  }

  worker.on('message', m => {
    // El vigía se arma recién cuando el worker avisa que arrancó: cargar el módulo y leer las
    // fixtures puede tardar más que el presupuesto de UN caso, y eso no es un caso colgado.
    if (m.listo) {
      estado.vigia = setInterval(() => {
        const edad = Date.now() - origen - Atomics.load(latido, 1)
        if (edad > presupuesto) cerrar(resolve, { colgado: Atomics.load(latido, 0), edad })
      }, 25)
      return
    }
    cerrar(resolve, { fin: m.fin })
  })
  worker.on('error', e => cerrar(reject, e))
  worker.on('exit', codigo => {
    if (!estado.cerrado) cerrar(reject, new Error(`el worker del fuzzer salió con código ${codigo} sin reportar`))
  })
})

const SEMILLAS = semillasDelCorpus()

// Una sola sonda al arrancar, igual que el runner del corpus: mientras `leer` sea el stub, `skip`
// recibe el motivo —que node imprime al lado del test— y en cuanto el lector exista el lote se
// prende sin tocar este archivo.
const PENDIENTE = (() => {
  try { leer(codificador.encode('{"type":"FeatureCollection","features":[]}')); return false }
  catch (e) { return e?.name === 'LectorNoImplementado' ? e.message : false }
})()

// Los `describe` quedan detrás del guard porque el worker evalúa ESTE MISMO módulo: sin el guard
// registraría los tests de nuevo del otro lado y cada uno lanzaría su propio worker, en cascada.
if (isMainThread) {
  describe('fuzz §17.8 — la máquina de mutación', () => {
    test('hay semillas y son documentos que el oráculo deriva', () => {
      assert.ok(SEMILLAS.length >= 30, `sólo ${SEMILLAS.length} semillas: el corpus se achicó`)
      assert.ok(SEMILLAS.some(s => s.arbitrable), 'ninguna semilla arbitrable: el diferencial sería vacuo')
    })

    test('la misma semilla da exactamente los mismos mutantes', () => {
      const huella = c => `${c.mutacion}@${c.donde}:${c.detalle}:${c.bytes.length}:${c.bytes.at(-1)}`
      const plan = planDe(SEMILLAS, 8)
      assert.deepEqual(plan.map(e => huella(casoDe(e))), plan.map(e => huella(casoDe(e))))
    })

    test('el mutante N no depende de cuántas semillas hubo antes', () => {
      const [primera, ultima] = [SEMILLAS[0], SEMILLAS.at(-1)]
      const suelto = casoDe({ ...ultima, indice: 3 })
      const enPlan = casoDe(planDe([primera, ultima], 4).at(-1))
      assert.equal(enPlan.indice, 3)
      assert.deepEqual(Array.from(enPlan.bytes), Array.from(suelto.bytes))
    })

    test('las cinco mutaciones aparecen y todas cambian los bytes', () => {
      const casos = planDe(SEMILLAS, 20).map(casoDe)
      assert.deepEqual([...new Set(casos.map(c => c.mutacion))].sort(), [...NOMBRES_MUTACION].sort())
      const intactos = casos.filter(c => {
        const original = bytesDe(c.ruta)
        return c.bytes.length === original.length && c.bytes.every((b, i) => b === original[i])
      })
      assert.deepEqual(intactos.map(receta), [], 'una mutación devolvió el documento intacto')
    })

    // Si esto llegara a 0, las tres primeras promesas seguirían midiendo pero la cuarta —la única
    // que compara CONTENIDO— quedaría vacua sin que nada se ponga rojo. Es el modo de falla
    // silenciosa clásico de un fuzzer, y por eso el censo es una aserción y no un `console.log`.
    test('una parte de los mutantes sigue siendo JSON válido: el diferencial no es vacuo', t => {
      const casos = planDe(SEMILLAS.filter(s => s.arbitrable), 20).map(casoDe)
      const juzgados = casos.filter(c => arbitroDe(c.bytes, c.arbitrable).juzga)
      t.diagnostic(`${juzgados.length} de ${casos.length} mutantes quedan bajo el árbitro del oráculo`)
      assert.ok(juzgados.length >= 20, `sólo ${juzgados.length} mutantes arbitrables sobre ${casos.length}`)
      assert.ok(new Set(juzgados.map(c => c.mutacion)).size >= 2, 'el diferencial cuelga de una sola mutación')
    })

    test('la vista envenenada es una VISTA, con el documento intacto adentro', () => {
      const bytes = bytesDe(SEMILLAS[0].ruta)
      const vista = vistaEnvenenada(bytes)
      assert.equal(vista.byteOffset, ORLA, 'sin byteOffset > 0 la prueba de §17.3-6 no prueba nada')
      assert.equal(vista.byteLength, bytes.length)
      assert.deepEqual(Array.from(vista), Array.from(bytes))
      const crudo = new Uint8Array(vista.buffer)
      assert.ok(crudo.slice(0, ORLA).every(b => VENENO.includes(b)), 'la orla de adelante no quedó envenenada')
      assert.ok(crudo.slice(-ORLA).every(b => VENENO.includes(b)), 'la orla de atrás no quedó envenenada')
    })

    // El árbitro es lo que decide qué se asierta: si el detector de claves duplicadas fallara
    // abierto, el fuzzer empezaría a exigirle al lector una decisión que §17 nunca tomó (quién gana
    // entre dos claves iguales) y el rojo se leería como un bug del lector.
    test('el detector de claves duplicadas ve lo que `duplicado` fabrica', () => {
      assert.equal(clavesDuplicadas('{"type":"Point","coordinates":[1,2]}'), false)
      assert.equal(clavesDuplicadas('{"a":{"type":1},"b":{"type":2}}'), false, 'la misma clave en objetos distintos no se duplica')
      assert.equal(clavesDuplicadas('{"a":["type","type"]}'), false, 'un VALOR de texto no es una clave')
      assert.equal(clavesDuplicadas('{"type":1,"type":2}'), true)
      assert.equal(clavesDuplicadas('{"a":{"x":1,"x":2}}'), true, 'la duplicada estaba anidada')
      assert.equal(clavesDuplicadas('{"type":1,"\\u0074ype":2}'), true, '§17.3-7: la clave se compara con los escapes deshechos')
      assert.equal(clavesDuplicadas('{"a\\"b":1,"c":2}'), false, 'una comilla escapada no cierra la cadena')
    })

    // El presupuesto de tiempo es la única de las cuatro promesas cuyo mecanismo puede fallar EN
    // SILENCIO: si `terminate()` no cortara la ejecución síncrona, el fuzzer no reportaría un caso
    // colgado — se colgaría con él, y un CI colgado se lee como "lento", no como "roto".
    test('el vigía corta un caso que no termina', async () => {
      const arranque = Date.now()
      const r = await lanzarWorker({ modo: 'colgar' }, 200)
      assert.equal(r.colgado, 0, 'el vigía no reportó qué caso se colgó')
      assert.ok(r.edad >= 200, `el vigía cortó a los ${r.edad} ms, antes del presupuesto`)
      assert.ok(Date.now() - arranque < 10_000, 'terminar al worker colgado tardó demasiado')
    })
  })

  describe('fuzz §17.8 — mutación de bytes sobre el lector', () => {
    test('ningún mutante rompe ninguna de las cuatro promesas', { skip: PENDIENTE }, async t => {
      const r = await lanzarWorker({ semillas: SEMILLAS, casos: CASOS_POR_SEMILLA }, PRESUPUESTO_MS)

      if (r.colgado !== undefined) {
        const caso = casoDe(planDe(SEMILLAS, CASOS_POR_SEMILLA)[r.colgado])
        assert.fail(`§17.8: un caso no terminó en ${PRESUPUESTO_MS} ms (${r.edad} ms) — ${receta(caso)}`)
      }

      const { falla, censo } = r.fin
      t.diagnostic(`${censo.casos} mutantes · ${censo.lecturas} leídos · ${censo.juzgados} arbitrados`)
      t.diagnostic(`códigos: ${JSON.stringify(censo.codigos)}`)
      assert.equal(falla, null, falla && `${falla.receta}\n${falla.mensaje}`)

      // El lote pasaría en verde también si el lector rechazara TODO: hay que ver que algo leyó y
      // que el diferencial llegó a comparar.
      assert.equal(censo.casos, SEMILLAS.length * CASOS_POR_SEMILLA, 'el lote no recorrió el plan entero')
      assert.ok(censo.juzgados > 0, 'ningún mutante llegó al diferencial')
      assert.ok(censo.lecturas > 0, 'el lector rechazó todos los mutantes')
    })
  })
}
