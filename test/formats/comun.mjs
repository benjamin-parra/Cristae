// Ayudas compartidas por los tests de los lectores de formatos (DISENO-INTEROP §5 y §6): el comparador de
// tablas, las invariantes CSR, las cuatro formas de entrada y el arnés de fuzz de mutación.

import assert from 'node:assert/strict'

export const TABLAS = ['geometryAt', 'partAt', 'ringAt', 'vertexAt', 'kinds', 'featureOf', 'closed', 'xy', 'layerOf']
export const CONTEOS = ['featureCount', 'geometryCount', 'partCount', 'ringCount', 'vertexCount']

// La forma del error, no `instanceof`: así un test sirve también contra una segunda implementación.
export const esFormatError = (e, format) =>
  e instanceof Error && e.name === 'FormatError' && typeof e.code === 'string' && Number.isInteger(e.at) &&
  (format === undefined || e.format === format)

// Lanza y verifica código (y formato, si se da). Acepta funciones síncronas y asíncronas.
export const fallaCon = async (fn, code, format) => {
  let error = null
  try { await fn() } catch (e) { error = e }
  assert.ok(error, `se esperaba FormatError('${code}') y no lanzó`)
  assert.ok(esFormatError(error, format), `excepción cruda: ${error?.stack ?? error}`)
  assert.equal(error.code, code, error.message)
  return error
}

// Igualdad con `Object.is` elemento a elemento: NaN es igual a NaN y −0 distinto de 0.
const mismoArreglo = (a, b, nombre) => {
  if (a === null || b === null) return assert.equal(a, b, `${nombre}: ${a} contra ${b}`)
  assert.equal(a.length, b.length, `${nombre}: largo ${a.length} contra ${b.length}`)
  for (let i = 0; i < a.length; i++)
    if (!Object.is(a[i], b[i])) assert.fail(`${nombre}[${i}]: ${a[i]} contra ${b[i]}`)
}

// Compara dos lecturas tabla por tabla. `campos` deja elegir: una lectura de GeoJSON no trae `layerOf`.
export const compararTablas = (a, b, { campos = TABLAS, z = true, stats = false } = {}) => {
  campos.forEach(k => mismoArreglo(a[k] ?? null, b[k] ?? null, k))
  CONTEOS.forEach(k => assert.equal(a[k], b[k], k))
  z && mismoArreglo(a.z, b.z, 'z')
  stats && assert.deepEqual({ ...a.stats }, { ...b.stats })
}

// Las invariantes de SPECS §17.1 y §17.3 sobre cualquier lectura.
export const invariantes = read => {
  const { geometryAt, partAt, ringAt, vertexAt, kinds, featureOf, closed, xy, z } = read
  const monotona = (t, n, nombre) => {
    assert.equal(t.length, n + 1, `${nombre}: largo`)
    assert.equal(t[0], 0, `${nombre}[0]`)
    for (let i = 0; i < n; i++) assert.ok(t[i] <= t[i + 1], `${nombre} no decrece en ${i}`)
  }
  monotona(geometryAt, read.featureCount, 'geometryAt')
  monotona(partAt, read.geometryCount, 'partAt')
  monotona(ringAt, read.partCount, 'ringAt')
  monotona(vertexAt, read.ringCount, 'vertexAt')
  assert.equal(geometryAt[read.featureCount], read.geometryCount, 'cola de geometryAt')
  assert.equal(partAt[read.geometryCount], read.partCount, 'cola de partAt')
  assert.equal(ringAt[read.partCount], read.ringCount, 'cola de ringAt')
  assert.equal(vertexAt[read.ringCount], read.vertexCount, 'cola de vertexAt')
  assert.equal(xy.length, read.vertexCount * 2, 'xy')
  assert.equal(kinds.length, read.geometryCount, 'kinds')
  assert.equal(featureOf.length, read.geometryCount, 'featureOf')
  assert.equal(closed.length, read.ringCount, 'closed')
  z === null || assert.equal(z.length, read.vertexCount, 'z')
  for (let g = 0; g < read.geometryCount; g++) {
    assert.ok(kinds[g] >= 1 && kinds[g] <= 6, `kinds[${g}] = ${kinds[g]}`)
    assert.ok(geometryAt[featureOf[g]] <= g && g < geometryAt[featureOf[g] + 1], `featureOf[${g}]`)
  }
  for (let r = 0; r < read.ringCount; r++) assert.equal(read.featureOfRing(r), featureOf[read.geometryOf(read.partOf(r))])
  for (let i = 0; i < xy.length; i++) assert.ok(Number.isFinite(xy[i]), `xy[${i}] no finito`)
  if (read.layerOf) {
    assert.equal(read.layerOf.length, read.featureCount, 'layerOf')
    read.layerOf.forEach((l, f) => assert.ok(l < read.layers.length, `layerOf[${f}]`))
  }
}

// ── Las formas de entrada (SPECS §17.3-6 y §17.8) ─────────────────────────────────────────────────

// Una vista con orla envenenada a los dos lados, como un `Buffer` del pool de Node: un lector que ignora
// el `byteOffset` o se sale del rango lee el veneno.
export const vistaEnvenenada = (bytes, veneno = 0x7B) => {
  const pool = new Uint8Array(bytes.length + 64).fill(veneno)
  pool.set(bytes, 32)
  return pool.subarray(32, 32 + bytes.length)
}

// Las formas binarias: `Uint8Array` justo, `ArrayBuffer`, `Buffer` del pool y `DataView`.
export const formasBinarias = bytes => [
  ['Uint8Array', bytes.slice()],
  ['ArrayBuffer', bytes.slice().buffer],
  ['Buffer', Buffer.from(vistaEnvenenada(bytes))],
  ['DataView', (v => new DataView(v.buffer, v.byteOffset, v.byteLength))(vistaEnvenenada(bytes, 0x30))],
]

// Las cuatro de §17.8 para un formato de texto: `string`, `ArrayBuffer`, `Uint8Array` y `Buffer` pooled.
export const formasTexto = texto => {
  const bytes = new TextEncoder().encode(texto)
  return [['string', texto], ...formasBinarias(bytes).slice(0, 3)]
}

// ── Fuzz de mutación (§5-6) ───────────────────────────────────────────────────────────────────────

// xorshift32 con semilla fija: un mutante se regenera suelto desde `(semilla, n)`.
const azar = semilla => {
  let s = semilla >>> 0 || 1
  return n => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s % n
  }
}

const BYTES_DE_INTERES = [0, 1, 0xFF, 0x7F, 0x80, 0x22, 0x2C, 0x3C, 0x3E, 0x5B, 0x5D, 0x7B, 0x7D, 0x2D, 0x2E, 0x30, 0x39, 0x65]

export const mutante = (bytes, semilla, n) => {
  const r   = azar((semilla ^ Math.imul(n + 1, 0x9E3779B1)) >>> 0)
  const out = Array.from(bytes)
  for (let k = 1 + r(4); k > 0; k--) {
    const at = out.length ? r(out.length) : 0
    switch (r(6)) {
      case 0: out[at] = r(256); break
      case 1: out[at] = BYTES_DE_INTERES[r(BYTES_DE_INTERES.length)]; break
      case 2: out.splice(at, 1 + r(8)); break
      case 3: out.splice(at, 0, ...out.slice(r(out.length || 1), r(out.length || 1) + 1 + r(16))); break
      case 4: out.length = at; break
      default: out[at] ^= 1 << r(8)
    }
  }
  return Uint8Array.from(out, b => b & 0xFF)
}

// Lee cada mutante dos veces —copia justa y vista envenenada— y exige que sólo salga FormatError y que
// las dos lecturas coincidan (`comparar`, por defecto tabla por tabla). Un cuelgue lo corta el `timeout` del test que llama [inf.: sin worker, no
// se puede interrumpir código síncrono desde el mismo hilo].
export const fuzz = async (leer, semillas, { casos = 100, semilla = 0x5EEDC0DE, formato, comparar = compararTablas } = {}) => {
  let leidos = 0, rechazados = 0
  for (const [nombre, bytes] of semillas)
    for (let n = 0; n < casos; n++) {
      const m = mutante(bytes, semilla ^ nombre.length, n)
      const resultados = []
      for (const entrada of [m.slice(), vistaEnvenenada(m)]) {
        try { resultados.push(await leer(entrada)) } catch (e) {
          assert.ok(esFormatError(e, formato), `${nombre} #${n}: excepción cruda ${e?.stack ?? e}`)
          resultados.push(e.code)
        }
      }
      const [a, b] = resultados
      if (typeof a === 'string' || typeof b === 'string') assert.equal(a, b, `${nombre} #${n}: la vista envenenada cambia el error`)
      else comparar(a, b)
      typeof a === 'string' ? rechazados++ : leidos++
    }
  return { leidos, rechazados }
}
