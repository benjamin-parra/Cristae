// Runner del corpus de conformidad del lector de GeoJSON — contrato: SPECS §17.
//
// CÓMO ESTÁ ARMADO. Los `.esperado.json` los deriva `esperado.mjs` con el oráculo (§17.8); este
// archivo sólo los compara contra lo que devuelve el lector. La separación es el punto: el patrón de
// medida está congelado en disco y versionado, así que un cambio del oráculo se ve como un diff
// —no como un test que cambió de color— y no puede acomodarse a la implementación.
//
// 🔴 QUÉ SE ASIERTA Y QUÉ NO. Cada esperado trae un `veredicto` decidido con el contrato en la mano:
//
//   'lectura'  §17 determina la salida → se comparan las tablas (menos las que `noAsertar` deja
//              afuera: ahí el contrato admite más de una lectura).
//   'error'    §17 nombra el `code` → se asierta el code. El `at` NO: §17.9 pide "con el offset",
//              nunca cuál.
//   'abierto'  §17 no determina la respuesta. Lo único exigible es §17.10-3: si lanza, es un
//              GeoJsonError con `code` y `at`, nunca una excepción cruda.
//
// Un test que eligiera una rama de un caso ambiguo convertiría la ambigüedad en contrato por la
// puerta de atrás, y encima horneando un detalle de JSON.parse (última-gana en claves duplicadas,
// BOM comido por TextDecoder). Por eso el corpus prefiere medir menos antes que medir de más.
//
// HOY ESTÁ PENDIENTE. `leer` todavía lanza `LectorNoImplementado`, así que los tests que necesitan
// al lector se marcan con `skip` y `node --test` queda verde. Los que NO lo necesitan —integridad
// del corpus, sincronía de los esperados, la forma pooled— corren igual desde hoy: son la mitad que
// vigila que el corpus no se pudra mientras el lector se escribe.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { formasDeEntrada, LIMITE_POOL } from './corpus/entradas/formas-de-entrada.mjs'
import { comparar } from './oraculo.mjs'
import { esErrorDelLector, leer } from './lector.mjs'
import { decodificarTabla, esperadoDe, fixtures, rutaEsperado } from './esperado.mjs'

// ── carga del corpus ──────────────────────────────────────────────────────────────────────────

// Los bytes se leen por caso y no se retienen: el corpus trae un documento de 100.000 niveles y
// tenerlos todos vivos a la vez es memoria que ningún test necesita.
const CORPUS = fixtures().map(ruta => ({
  ruta,
  bytesDe: () => new Uint8Array(readFileSync(ruta)),
  esperado: JSON.parse(readFileSync(rutaEsperado(ruta), 'utf8')),
}))

const porCategoria = Object.groupBy(CORPUS, c => c.esperado.fixture.split('/')[0])

// Una sola sonda al arrancar y no una por test: mientras `leer` sea el stub, `skip` recibe el motivo
// —que node imprime al lado del test— y en cuanto el lector exista devuelve `false` y los tests se
// prenden juntos, sin tocar este archivo.
const PENDIENTE = (() => {
  try { leer(new TextEncoder().encode('{"type":"FeatureCollection","features":[]}')); return false }
  catch (e) { return e?.name === 'LectorNoImplementado' ? e.message : false }
})()

// ── comparación contra el esperado ────────────────────────────────────────────────────────────

const TABLAS = ['geometryAt', 'partAt', 'ringAt', 'vertexAt', 'kinds', 'featureOf', 'closed', 'xy', 'z']

const asertadas = ({ noAsertar }) =>
  noAsertar === '*' ? [] : TABLAS.filter(t => !(noAsertar ?? []).includes(t))

// `closed` se compara entera como cualquier otra tabla: §17.3-13 la cerró exigiendo 2 o más vértices,
// así que un anillo de 0 o 1 vale 0 y ya no hay celdas indecisas que apartar.
const comoArray = v => (v === null || v === undefined ? v : Array.from(v))

const tablasDe = (fuente, esperado) =>
  Object.fromEntries(asertadas(esperado).map(t => [t, comoArray(fuente[t])]))

// El esperado guarda NaN y -0 como texto (JSON no los sabe escribir): se restauran antes de
// comparar, porque son justo los valores donde una comparación laxa taparía una diferencia real
// —NaN en `z` significa "la posición era 2D" y -0 es un lng/lat legal.
const esperadoComparable = esperado =>
  Object.fromEntries(Object.entries(tablasDe(esperado.tablas, esperado))
    .map(([k, v]) => [k, v === null || v === undefined ? v : decodificarTabla(v)]))

const diferencias = (esperado, salida) => comparar(esperadoComparable(esperado), tablasDe(salida, esperado))

// ── invariantes que el lector debe cumplir sobre CUALQUIER documento ───────────────────────────

const verificarCSR = (nombre, tabla, total) => {
  assert.equal(tabla[0], 0, `${nombre}: una tabla CSR arranca en 0`)
  assert.equal(tabla.at(-1), total, `${nombre}: una tabla CSR termina en el total del nivel de abajo`)
  assert.ok([...tabla].every((x, i) => i === 0 || x >= tabla[i - 1]), `${nombre}: una tabla CSR no decrece`)
}

// §17.3-3 al sellar, verificada sobre la salida REAL y no sobre el esperado: es la aserción que
// atrapa la cadena CSR corrida por una ranura huérfana, y por eso se exige incluso en los documentos
// donde el contrato no determina qué tablas salen.
const verificarSellado = s => {
  const g = s.kinds.length
  const f = s.geometryAt.length - 1
  assert.equal(s.featureOf.length, g, '§17.3-3: featureOf.length === g')
  assert.equal(s.partAt.length, g + 1, '§17.3-3: partAt.length === g + 1')
  assert.equal(s.closed.length, s.vertexAt.length - 1, '§17.1: closed tiene una entrada por anillo')
  assert.ok([...s.kinds].every(k => k >= 1 && k <= 6), '§17.1: el 0 no sobrevive al sellado')
  assert.ok([...s.featureOf].every(i => i < f), '§17.1: featureOf apunta a un feature que existe')
  assert.ok(s.z === null || s.z.length === s.xy.length / 2, '§17.1: z tiene una entrada por vértice')
  assert.equal(s.propAt.length, 2 * f, '§17.1: propAt es [2f]')
  assert.equal(s.idAt.length, 2 * f, '§17.1: idAt es [2f]')
  verificarCSR('geometryAt', s.geometryAt, g)
  verificarCSR('partAt', s.partAt, s.ringAt.length - 1)
  verificarCSR('ringAt', s.ringAt, s.vertexAt.length - 1)
  verificarCSR('vertexAt', s.vertexAt, s.xy.length / 2)
}

// `assert.throws` devuelve `undefined`, no el error: usarlo para inspeccionar el `code` deja pasar
// cualquier excepción con tal de que sea una. Se captura a mano, que además permite distinguir "no
// lanzó" de "lanzó mal" en el mensaje.
const capturar = fn => {
  try { return { lanzo: false, valor: fn() } } catch (error) { return { lanzo: true, error } }
}

// El resultado de leer un documento, en una forma comparable entre presentaciones (§17.8). Un error
// cuenta como resultado: dos formas que fallan distinto son tan desacuerdo como dos que leen
// distinto, y ése es el bug de normalización que §17.3-6 existe para matar.
const resultadoDe = entrada => {
  try {
    const s = leer(entrada)
    return { ok: true, tablas: TABLAS.map(t => comoArray(s[t])) }
  } catch (e) {
    return { ok: false, name: e?.name, code: e?.code, at: e?.at }
  }
}

// ── tests que corren HOY, sin lector ──────────────────────────────────────────────────────────

describe('corpus §17 — integridad del corpus', () => {
  test('toda fixture tiene su .esperado.json y su veredicto', () => {
    assert.ok(CORPUS.length >= 60, `el corpus trae ${CORPUS.length} fixtures`)
    CORPUS.forEach(({ ruta, esperado }) => {
      assert.ok(esperado.fixture, `sin esperado: ${ruta}`)
      assert.ok(['lectura', 'error', 'abierto'].includes(esperado.veredicto), `${esperado.fixture}: veredicto raro`)
    })
  })

  // Sin esto, editar el oráculo y olvidar regenerar deja al corpus midiendo contra una vara vieja en
  // silencio — la misma falla que congelar la salida esperada contra la implementación, un paso más
  // atrás.
  test('los .esperado.json están sincronizados con el oráculo', () => {
    const desfasados = CORPUS
      .filter(({ ruta, esperado }) => JSON.stringify(esperadoDe(ruta)) !== JSON.stringify(esperado))
      .map(({ esperado }) => esperado.fixture)
    assert.deepEqual(desfasados, [], 'correr `node test/geojson/esperado.mjs`')
  })

  // La cuarta presentación del §17.8 sólo prueba lo que dice probar si el documento entra al pool:
  // por encima del límite `Buffer.concat` devuelve un buffer dedicado con byteOffset 0 y el caso más
  // caro se vuelve decorativo sin avisar.
  test('las fixtures de `entradas/` entran en el pool de Node', () => {
    porCategoria.entradas.forEach(({ esperado, bytesDe }) => {
      assert.ok(esperado.bytes < LIMITE_POOL, `${esperado.fixture}: ${esperado.bytes} bytes ≥ ${LIMITE_POOL}`)
      assert.notEqual(formasDeEntrada(bytesDe()).bufferPooled.byteOffset, 0, `${esperado.fixture}: no cayó pooled`)
    })
  })

  // El listado de lo que el corpus NO asierta viaja como test para que sea visible en la salida de
  // `node --test` y no sólo en un comentario: una ambigüedad que nadie ve deja de presionar para
  // cerrarse, y ésta es la fase que existe para cerrarlas.
  test('las ambigüedades del contrato están declaradas con su motivo', () => {
    const abiertas = CORPUS.filter(({ esperado }) => esperado.veredicto === 'abierto' || esperado.noAsertar)
    abiertas.forEach(({ esperado }) => assert.ok(esperado.porque, `${esperado.fixture}: sin motivo declarado`))
    assert.ok(abiertas.length > 0, 'si esto llega a 0, §17 se cerró y el corpus puede endurecerse')
  })
})

// ── tests que se prenden cuando exista el lector ───────────────────────────────────────────────

Object.entries(porCategoria).forEach(([categoria, casos]) => {
  describe(`corpus §17 — ${categoria}`, () => {
    casos.forEach(({ esperado, bytesDe }) => {
      test(`${esperado.fixture} — ${esperado.veredicto}`, { skip: PENDIENTE }, () => {
        const r = capturar(() => leer(bytesDe()))

        if (r.lanzo) {
          // §17.10-3 antes que nada: la promesa de que ninguna excepción cruda escapa vale sobre
          // TODO el corpus, incluso donde el contrato no decide si este documento debía fallar.
          assert.ok(esErrorDelLector(r.error), `§17.10-3: excepción cruda ${r.error?.name}`)
          if (esperado.veredicto === 'error') return assert.equal(r.error.code, esperado.code)
          // En 'abierto' §17 no elige entre leer y fallar: fallar bien es una respuesta válida. La
          // aserción es DÉBIL a propósito — la fuerte llega cuando §17 elija (ver las ambigüedades
          // reportadas en la fase 0).
          return assert.equal(esperado.veredicto, 'abierto', `no debía fallar: ${r.error.code} @ ${r.error.at}`)
        }

        assert.notEqual(esperado.veredicto, 'error', `§17 manda GeoJsonError('${esperado.code}') y leyó`)
        verificarSellado(r.valor)
        if (esperado.veredicto === 'lectura') assert.deepEqual(diferencias(esperado, r.valor), [])
      })

      // §17.8: la misma invariante para TODO el corpus, no sólo para `entradas/`. Vale incluso donde
      // el veredicto es 'abierto' —ahí el acuerdo entre formas es lo único exigible— y es la única
      // aserción que atrapa un `byteOffset` ignorado, porque las otras tres formas arrancan en 0.
      test(`${esperado.fixture} — las 4 formas de entrada coinciden (§17.8)`, { skip: PENDIENTE }, () => {
        const bytes = bytesDe()
        const formas = formasDeEntrada(bytes)
        // Si los bytes no son UTF-8 válido, la forma `string` es OTRO documento (el decodificador
        // mete U+FFFD) y compararla mediría una diferencia que el corpus no plantó.
        const ida = new TextEncoder().encode(formas.texto)
        const candidatas = ida.length === bytes.length && ida.every((b, i) => b === bytes[i])
          ? Object.entries(formas)
          : Object.entries(formas).filter(([nombre]) => nombre !== 'texto')

        const resultados = candidatas.map(([nombre, entrada]) => [nombre, resultadoDe(entrada)])
        resultados.slice(1).forEach(([nombre, r]) =>
          assert.deepEqual(r, resultados[0][1], `${nombre} difiere de ${resultados[0][0]}`))
      })
    })
  })
})
