#!/usr/bin/env node
// check-refs-seccion: cada «SPECS §N» y «MODELO §N» citado existe como encabezado numerado.
//
//   node scripts/check-refs-seccion.mjs [archivos…]
//
// Revisa src/, react/src/, types/, docs/, README.md, AGENTS.md y SKILL.md. Sin archivos revisa todo; con archivos,
// sólo las citas de esos. Si entre ellos hay un documento que define encabezados (SPECS, MODELO, docs/contrato,
// docs/modelo.md), revisa todo: cambiar un encabezado rompe las citas de otros archivos. Exit 1 con bloqueantes,
// 2 por error de uso.
//
// Los encabezados se buscan en SPECS.md y docs/contrato/ para SPECS, y en MODELO.md y docs/modelo.md para MODELO:
// la sección sobrevive a partir los documentos en docs/ sin tocar el chequeo. Sin git, para correr en el CI.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const NOMBRE = 'check-refs-seccion'
const RAIZ = resolve(import.meta.dirname, '..')
const DIRS = ['src', 'react/src', 'types', 'docs']
const SUELTOS = ['README.md', 'AGENTS.md', 'SKILL.md']
const EXTENSIONES = /\.(?:[mc]?js|jsx|ts|tsx|md)$/
const EXCLUIDOS = new Set(['node_modules', 'dist', 'notas', '.git'])

// Dónde están los encabezados de cada documento citado, hoy y tras el refactor de docs.
const FUENTES = {
  SPECS: ['SPECS.md', 'docs/contrato'],
  MODELO: ['MODELO.md', 'docs/modelo.md'],
}

const posix = (p) => p.split(sep).join('/')
const leer = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')

/** Archivos revisados (rutas relativas, posix). */
export function listarArchivos(raiz) {
  const salida = []
  const recorrer = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUIDOS.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) recorrer(p)
      else if (EXTENSIONES.test(e.name)) salida.push(posix(relative(raiz, p)))
    }
  }
  for (const d of DIRS) if (existsSync(join(raiz, d))) recorrer(join(raiz, d))
  for (const f of SUELTOS) if (existsSync(join(raiz, f))) salida.push(f)
  return salida.sort()
}

// `SPECS §9`, `SPECS.md §20`, `MODELO §17.3`. Un punto final de oración no es parte del número, y lo que sigue a
// `§20.15-7` es un ítem dentro de la sección, que no es un encabezado.
const RE_CITA = /\b(SPECS|MODELO)(?:\.md)?[ \t]*§[ \t]*(\d+(?:\.\d+)*)/g

/** Citas de un texto: `{ documento, seccion, linea }`. */
export function extraerCitas(texto) {
  const salida = []
  for (const m of texto.matchAll(RE_CITA)) {
    salida.push({ documento: m[1], seccion: m[2], linea: texto.slice(0, m.index).split('\n').length })
  }
  return salida
}

/** Números de los encabezados `## 4.1 Título` de un .md, fuera de los bloques de código. */
export function numerosDeEncabezados(texto) {
  const sinBloques = texto.replace(/^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\2[`~]*[ \t]*$|(?![\s\S]))/gm, '')
  const numeros = new Set()
  for (const m of sinBloques.matchAll(/^ {0,3}#{1,6}[ \t]+(\d+(?:\.\d+)*)\.?(?=[ \t]|$)/gm)) numeros.add(m[1])
  return numeros
}

/** Secciones existentes de cada documento citado, buscadas en todos sus sitios posibles. */
export function seccionesPorDocumento(raiz) {
  const salida = {}
  for (const [doc, sitios] of Object.entries(FUENTES)) {
    const numeros = new Set()
    const sumar = (ruta) => {
      for (const n of numerosDeEncabezados(leer(ruta))) numeros.add(n)
    }
    for (const sitio of sitios) {
      const ruta = join(raiz, sitio)
      if (!existsSync(ruta)) continue
      if (sitio.endsWith('.md')) sumar(ruta)
      else for (const f of listarArchivos(raiz).filter((a) => a.startsWith(`${sitio}/`))) sumar(join(raiz, f))
    }
    salida[doc] = numeros
  }
  return salida
}

/** Revisa `archivos` (todos, si es `null`): `{ citas, archivos, hallazgos }`. */
export function revisar(raiz, archivos = null) {
  const secciones = seccionesPorDocumento(raiz)
  const lista = archivos ?? listarArchivos(raiz)
  const hallazgos = []
  let citas = 0
  for (const archivo of lista) {
    for (const c of extraerCitas(leer(join(raiz, archivo)))) {
      citas++
      if (!secciones[c.documento].has(c.seccion)) {
        hallazgos.push({ archivo, linea: c.linea, mensaje: `${c.documento} §${c.seccion} no existe como encabezado` })
      }
    }
  }
  return { citas, archivos: lista.length, hallazgos }
}

/** `archivos` (relativos a `cwd`) que la revisión cubre, o `null` si alguno define encabezados y hay que revisar todo. */
export function seleccionar(archivos, raiz, cwd = process.cwd()) {
  const rel = archivos.map((a) => posix(relative(raiz, resolve(cwd, a))))
  const definen = (r) => r === 'SPECS.md' || r === 'MODELO.md' || r === 'docs/modelo.md' || r.startsWith('docs/contrato/')
  if (rel.some(definen)) return null
  const cubiertos = new Set(listarArchivos(raiz))
  return rel.filter((r) => cubiertos.has(r))
}

export function formatear({ citas, archivos, hallazgos }) {
  const lineas = []
  let actual = null
  for (const h of hallazgos) {
    if (h.archivo !== actual) lineas.push(h.archivo)
    actual = h.archivo
    lineas.push(`${String(h.linea).padStart(5)}  bloqueante  seccion-inexistente: ${h.mensaje}`)
  }
  lineas.push(`${citas} citas revisadas en ${archivos} archivos`)
  lineas.push(`${NOMBRE}: ${hallazgos.length} bloqueantes, 0 avisos`)
  return lineas.join('\n')
}

function main(argv) {
  if (argv.some((a) => a.startsWith('-'))) {
    console.error(`uso: node scripts/${NOMBRE}.mjs [archivos…]`)
    return 2
  }
  const resultado = revisar(RAIZ, argv.length ? seleccionar(argv, RAIZ) : null)
  console.log(formatear(resultado))
  return resultado.hallazgos.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2))
