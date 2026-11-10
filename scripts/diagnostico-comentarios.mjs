#!/usr/bin/env node
// Mapa de la deuda de comentarios por módulo, para ordenar el pase de reescritura. Nunca frena: sale 0 siempre.
// A diferencia de check-comentarios, que mira el diff, éste mira el árbol entero y no usa git.
//
//   node scripts/diagnostico-comentarios.mjs             # una fila por módulo
//   node scripts/diagnostico-comentarios.mjs --archivos  # además, los archivos con hallazgos
//
// Módulo = carpeta de primer nivel bajo src/ (react/src es el módulo `react`; lo suelto en src/, `(raíz)`).
// Los .d.ts y los @typedef de src/grammar son contrato público: se cuentan aparte, no como deuda.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const RAIZ = resolve(import.meta.dirname, '..')
const LARGO_CABECERA_MAX = 8      // la guía de estilo de comentarios no admite cabeceras más largas
const COLUMNAS_MAX = 115          // ancho de las líneas de comentario del repo
const BLOQUE_MAX = 12             // desde ahí, un bloque seguido de comentario es un muro
const CARPETAS_FUENTE = ['src', 'react/src']
const CARPETAS_CONTRATO = ['types', 'src', 'react/src']
const SALTAR = new Set(['node_modules', 'dist', '.git'])

const COMENTARIO = /^\s*(\/\/|\/\*|\*(?!\/)|\*\/)/
const IMPORT = /^import\b/
const IMPORT_COMPLETO = /from\s+['"]|^import\s+['"]/

const archivosDe = (dir, aceptar, salida = []) => {
  let entradas
  try { entradas = readdirSync(dir, { withFileTypes: true }) } catch { return salida }   // una carpeta que no existe no es error
  for (const e of entradas) {
    if (SALTAR.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) archivosDe(p, aceptar, salida)
    else if (aceptar(e.name)) salida.push(p)
  }
  return salida
}

/** Carpeta de primer nivel bajo src/ de una ruta relativa a la raíz del paquete. */
export const moduloDe = ruta => {
  const p = ruta.split(sep).join('/')
  if (p.startsWith('react/src/')) return 'react'
  const partes = p.replace(/^src\//, '').split('/')
  return partes.length > 1 ? partes[0] : '(raíz)'
}

/** Tramos seguidos de líneas de comentario: { ini, fin } con índices base 0, fin exclusivo. */
const tramos = L => {
  const out = []
  let ini = -1
  L.forEach((l, i) => {
    if (COMENTARIO.test(l)) { if (ini < 0) ini = i }
    else if (ini >= 0) { out.push({ ini, fin: i }); ini = -1 }
  })
  if (ini >= 0) out.push({ ini, fin: L.length })
  return out
}

/** Primera línea de código que no es un import: donde termina lo que se considera cabecera. */
const finPreambulo = L => {
  let enImport = false
  for (let i = 0; i < L.length; i++) {
    const t = L[i].trim()
    if (enImport) { if (/from\s+['"]/.test(t)) enImport = false; continue }
    if (t === '' || COMENTARIO.test(t)) continue
    if (IMPORT.test(t)) { enImport = !IMPORT_COMPLETO.test(t); continue }
    return i
  }
  return L.length
}

/**
 * Medidas de un archivo. Cabecera: el bloque de comentario más largo del preámbulo (antes del primer código que no
 * es un import), venga antes o después de los imports. Con `esGrammar`, un bloque con @typedef es contrato y no suma
 * a ninguna medida de deuda.
 */
export const analizarTexto = (texto, { esGrammar = false } = {}) => {
  const L = texto.split('\n')
  const todos = tramos(L)
  const contrato = todos.filter(t => esGrammar && L.slice(t.ini, t.fin).some(l => l.includes('@typedef')))
  const deuda = todos.filter(t => !contrato.includes(t))
  const preambulo = finPreambulo(L)
  const cabecera = Math.max(0, ...deuda.filter(t => t.fin <= preambulo).map(t => t.fin - t.ini))
  const lineasDeuda = deuda.flatMap(t => L.slice(t.ini, t.fin))
  return {
    lineas: L.length,
    comentario: lineasDeuda.length,
    comentarioContrato: contrato.reduce((a, t) => a + t.fin - t.ini, 0),
    bloquesContrato: contrato.length,
    cabecera,
    largas: lineasDeuda.filter(l => l.length > COLUMNAS_MAX).length,
    bloques: deuda.filter(t => t.fin - t.ini >= BLOQUE_MAX).length,
  }
}

const sumar = (filas, campo) => filas.reduce((a, f) => a + f[campo], 0)
const pct = (parte, todo) => (todo ? (100 * parte / todo).toFixed(0) : '0')

/** Una fila por módulo con los totales de sus archivos. */
export const porModulo = filas => {
  const mods = new Map()
  for (const f of filas) mods.set(f.modulo, [...(mods.get(f.modulo) ?? []), f])
  return [...mods].map(([modulo, fs]) => ({
    modulo,
    archivos: fs.length,
    lineas: sumar(fs, 'lineas'),
    comentario: sumar(fs, 'comentario'),
    cabeceras: fs.filter(f => f.cabecera > LARGO_CABECERA_MAX).length,
    largas: sumar(fs, 'largas'),
    bloques: sumar(fs, 'bloques'),
  })).sort((a, b) => (b.cabeceras + b.largas + b.bloques) - (a.cabeceras + a.largas + a.bloques) || a.modulo.localeCompare(b.modulo))
}

const leerFilas = () => CARPETAS_FUENTE
  .flatMap(d => archivosDe(join(RAIZ, d), n => /\.m?js$/.test(n)))
  .map(abs => {
    const ruta = relative(RAIZ, abs).split(sep).join('/')
    return { archivo: ruta, modulo: moduloDe(ruta), ...analizarTexto(readFileSync(abs, 'utf8'), { esGrammar: ruta.startsWith('src/grammar/') }) }
  })

const leerDeclaraciones = () => [...new Set(CARPETAS_CONTRATO.flatMap(d => archivosDe(join(RAIZ, d), n => n.endsWith('.d.ts'))))]
  .map(abs => {
    const L = readFileSync(abs, 'utf8').split('\n')
    return { lineas: L.length, comentario: L.filter(l => COMENTARIO.test(l)).length }
  })

export const main = argv => {
  const filas = leerFilas()
  const mods = porModulo(filas)
  const T = campo => sumar(filas, campo)
  const cabeceras = filas.filter(f => f.cabecera > LARGO_CABECERA_MAX)
  console.log(`archivos ${filas.length} · líneas ${T('lineas')} · comentario ${T('comentario')} (${pct(T('comentario'), T('lineas'))} %)`)
  console.log(`cabeceras de más de ${LARGO_CABECERA_MAX} líneas ${cabeceras.length} · líneas de comentario de más de ${COLUMNAS_MAX} columnas ${T('largas')} · bloques de ${BLOQUE_MAX} líneas o más ${T('bloques')}\n`)
  console.log(['modulo', 'arch', 'lineas', 'com', '%', 'cabeceras', 'largas', 'bloques'].join('\t'))
  for (const m of mods) console.log([m.modulo, m.archivos, m.lineas, m.comentario, pct(m.comentario, m.lineas), m.cabeceras, m.largas, m.bloques].join('\t'))

  if (argv.includes('--archivos')) {
    console.log('\narchivo\tcabecera\tlargas\tbloques')
    for (const f of filas.filter(f => f.cabecera > LARGO_CABECERA_MAX || f.largas || f.bloques)
      .sort((a, b) => (b.largas + b.bloques + b.cabecera) - (a.largas + a.bloques + a.cabecera)))
      console.log([f.archivo, f.cabecera > LARGO_CABECERA_MAX ? f.cabecera : '', f.largas || '', f.bloques || ''].join('\t'))
  }

  const dts = leerDeclaraciones()
  console.log('\ncontrato público, aparte y no cuenta como deuda')
  console.log(`.d.ts ${dts.length} archivos · ${sumar(dts, 'lineas')} líneas · comentario ${sumar(dts, 'comentario')} (${pct(sumar(dts, 'comentario'), sumar(dts, 'lineas'))} %)`)
  console.log(`@typedef de src/grammar ${T('bloquesContrato')} bloques · ${T('comentarioContrato')} líneas`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2))
