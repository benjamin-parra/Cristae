#!/usr/bin/env node
// check-enlaces: los enlaces relativos de los .md del paquete y la estructura del árbol de docs.
//
//   node scripts/check-enlaces.mjs [archivos…]
//
// Sin archivos revisa todo; con archivos, informa sólo lo que les toca (los que no son .md del paquete se
// ignoran en silencio, también los que ya no existen). Exit 1 con bloqueantes, 2 por error de uso.
//
// No usa git: lo corre `npm run lint` dentro de packages/cristae en la imagen del CI, que no lo trae. Recorre el
// disco desde la raíz del paquete y deja fuera node_modules, dist, notas y .git.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const NOMBRE = 'check-enlaces'
const RAIZ = resolve(import.meta.dirname, '..')
const EXCLUIDOS = new Set(['node_modules', 'dist', 'notas', '.git'])
const CHANGELOG = 'CHANGELOG.md'

/** @typedef {'bloqueante' | 'aviso'} Severidad */

// Una regla de aviso pasa a bloqueante cuando el árbol queda sin hallazgos.
export const SEVERIDAD = {
  'enlace-roto': 'bloqueante',
  'ancla-inexistente': 'bloqueante',
  'sin-nexo': 'aviso',
  'nexo-incompleto': 'aviso',
  'nombre-repetido': 'aviso',
  'ida-y-vuelta': 'aviso',
  'transitorio-sin-muere-con': 'bloqueante',
  'ruta-de-maquina': 'bloqueante',
}

const posix = (p) => p.split(sep).join('/')
const leer = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')

/** Rutas relativas (posix) de todos los .md bajo `raiz`, sin las carpetas excluidas. */
export function listarDocs(raiz) {
  const salida = []
  const recorrer = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUIDOS.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) recorrer(p)
      else if (e.name.endsWith('.md')) salida.push(posix(relative(raiz, p)))
    }
  }
  recorrer(raiz)
  return salida.sort()
}

const reemplazarPorBlancos = (s) => s.replace(/[^\n]/g, ' ')

// Abre y cierra con la misma marca y al menos tan larga, como CommonMark; un bloque sin cierre llega al final.
// La sangría es libre: las vallas dentro de un ítem de lista llevan la del ítem (4 espacios o más en una lista numerada).
const RE_VALLA = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\2[`~]*[ \t]*$|(?![\s\S]))/gm

/** El texto sin bloques ni spans de código, con las mismas líneas: lo que se parece a un enlace dentro de código no cuenta. */
export function sinCodigo(texto) {
  return texto
    .replace(RE_VALLA, reemplazarPorBlancos)
    .replace(/(`+)(?!`)[^\n]*?[^`\n]\1(?!`)|(`+)(?!`)[^`\n]\2(?!`)/g, reemplazarPorBlancos)
}

/** Fragmentos de código (bloques y spans) con su línea, para buscar rutas de máquina. */
export function fragmentosDeCodigo(texto) {
  const salida = []
  const linea = (indice) => texto.slice(0, indice).split('\n').length
  for (const m of texto.matchAll(RE_VALLA)) salida.push({ linea: linea(m.index), texto: m[0] })
  const sinValla = texto.replace(RE_VALLA, reemplazarPorBlancos)
  for (const m of sinValla.matchAll(/(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/g)) salida.push({ linea: linea(m.index), texto: m[2] })
  return salida
}

const RE_ENFASIS = /\*|~~|(?<![\p{L}\p{N}])_+(?=\S)|(?<=\S)_+(?![\p{L}\p{N}])/gu

/** Ancla de GitHub de un encabezado: minúsculas, fuera los signos salvo guion y guion bajo, espacios a guion. */
export function anclaDe(encabezado) {
  // El contenido de un code span se conserva tal cual (`<cristae-map>` queda `cristae-map`); fuera de él, el
  // HTML en línea y el énfasis no llegan al texto renderizado. Un `_` es énfasis sólo si abre o cierra una
  // palabra: el de `snake_case` queda.
  const texto = encabezado
    .split(/(`[^`]*`)/)
    .map((trozo, i) => (i % 2 ? trozo.slice(1, -1) : trozo.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '').replace(RE_ENFASIS, '')))
    .join('')
  return texto
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

const RE_ATX = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/
const RE_SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/
const RE_NO_PARRAFO = /^\s*(?:[-*+>|]|\d+[.)]\s|#)/

/** Textos de los encabezados en orden de documento: ATX y setext (un párrafo subrayado con `===` o `---`). */
function encabezados(texto) {
  const lineas = texto.split('\n')
  const salida = []
  let i = 0
  // El front-matter no es contenido: su `---` de cierre subrayaría la última clave.
  if (lineas[0] === '---') {
    const cierre = lineas.indexOf('---', 1)
    if (cierre !== -1) i = cierre + 1
  }
  let parrafo = []
  for (; i < lineas.length; i++) {
    const l = lineas[i]
    const atx = l.match(RE_ATX)
    if (atx) { salida.push(atx[1]); parrafo = []; continue }
    if (RE_SETEXT.test(l) && parrafo.length) { salida.push(parrafo.join(' ')); parrafo = []; continue }
    if (!l.trim() || RE_NO_PARRAFO.test(l) || RE_SETEXT.test(l)) parrafo = []
    else parrafo.push(l.trim())
  }
  return salida
}

/** Anclas de un .md, con los duplicados numerados (`-1`, `-2`) y los `id`/`name` de HTML en línea. */
export function anclasDe(texto) {
  const anclas = new Set()
  const vistos = new Map()
  const limpio = texto.replace(RE_VALLA, reemplazarPorBlancos)
  for (const encabezado of encabezados(limpio)) {
    const base = anclaDe(encabezado)
    const n = vistos.get(base) ?? 0
    vistos.set(base, n + 1)
    anclas.add(n === 0 ? base : `${base}-${n}`)
  }
  for (const m of limpio.matchAll(/<a\s[^>]*?(?:id|name)\s*=\s*["']([^"']+)["']/gi)) anclas.add(m[1].toLowerCase())
  return anclas
}

const RE_ESQUEMA = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

/** Enlaces relativos de un .md: `{ linea, destino, ancla }`, sin http(s), mailto ni nada con esquema. */
export function enlacesDe(texto) {
  const salida = []
  const limpio = sinCodigo(texto)
  const agregar = (indice, crudo) => {
    let dest = crudo.trim()
    if (dest.startsWith('<') && dest.endsWith('>')) dest = dest.slice(1, -1)
    if (RE_ESQUEMA.test(dest)) return
    const almohadilla = dest.indexOf('#')
    const ruta = almohadilla === -1 ? dest : dest.slice(0, almohadilla)
    const ancla = almohadilla === -1 ? '' : dest.slice(almohadilla + 1)
    if (!ruta && !ancla) return
    salida.push({ linea: limpio.slice(0, indice).split('\n').length, destino: ruta, ancla })
  }
  for (const m of limpio.matchAll(/\]\(\s*(<[^>\n]*>|[^)\s]*)/g)) agregar(m.index, m[1])
  for (const m of limpio.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm)) agregar(m.index, m[1])
  return salida
}

/** Campos `clave: valor` del front-matter, o `null` si el archivo no lo tiene. */
export function frontMatter(texto) {
  const m = texto.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  if (!m) return null
  const campos = {}
  for (const l of m[1].split('\n')) {
    const c = l.match(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/)
    if (c) campos[c[1]] = c[2].trim()
  }
  return campos
}

const decodificar = (s) => {
  try { return decodeURIComponent(s) } catch { return s }
}

// `/home/` y `/Users/` abren la ruta: `src/home/Page.js` o `api/Users/1` son rutas del repo.
const RE_RUTA_MAQUINA = /(?<![\w.~-])\/(?:home|Users)\/|\b[A-Za-z]:\\/

/**
 * Revisa el árbol de `raiz`. Devuelve los hallazgos `{ regla, severidad, archivo, linea, mensaje, afecta }`,
 * donde `afecta` lista los docs a los que el hallazgo les toca (la carpeta entera, en las reglas de estructura).
 */
export function revisar(raiz) {
  const docs = listarDocs(raiz)
  const textos = new Map(docs.map((d) => [d, leer(join(raiz, d))]))
  const anclas = new Map()
  const anclasEn = (d) => {
    if (!anclas.has(d)) anclas.set(d, anclasDe(textos.get(d)))
    return anclas.get(d)
  }
  const hallazgos = []
  const hallar = (regla, archivo, linea, mensaje, afecta = [archivo]) =>
    hallazgos.push({ regla, severidad: SEVERIDAD[regla], archivo, linea, mensaje, afecta })

  // Destinos .md de cada doc, para las reglas de estructura. El CHANGELOG no entra: sus enlaces no son estructura.
  const salientes = new Map(docs.map((d) => [d, new Set()]))

  for (const doc of docs) {
    const base = dirname(join(raiz, doc))
    for (const e of enlacesDe(textos.get(doc))) {
      const destino = e.destino ? resolve(base, decodificar(e.destino)) : join(raiz, doc)
      const rel = posix(relative(raiz, destino))
      if (e.destino && !existsSync(destino)) {
        hallar('enlace-roto', doc, e.linea, `enlace a un archivo que no existe: ${e.destino}`)
        continue
      }
      if (!rel.startsWith('..') && docs.includes(rel) && doc !== CHANGELOG) salientes.get(doc).add(rel)
      if (!e.ancla || !docs.includes(rel)) continue
      if (!anclasEn(rel).has(decodificar(e.ancla).toLowerCase())) {
        hallar('ancla-inexistente', doc, e.linea, `ancla inexistente: ${e.destino}#${e.ancla}`)
      }
    }
  }

  const estructurales = docs.filter((d) => d !== CHANGELOG)

  // Carpeta con dos o más docs: un nexo con su nombre los enlaza a todos. La raíz tiene el README.
  const porCarpeta = new Map()
  for (const d of estructurales) {
    const carpeta = dirname(d)
    if (carpeta === '.') continue
    if (!porCarpeta.has(carpeta)) porCarpeta.set(carpeta, [])
    porCarpeta.get(carpeta).push(d)
  }
  for (const [carpeta, lista] of porCarpeta) {
    if (lista.length < 2) continue
    const nexo = `${carpeta}/${basename(carpeta)}.md`
    if (!lista.includes(nexo)) {
      hallar('sin-nexo', carpeta, 0, `${lista.length} docs sin nexo ${nexo} que los enlace`, lista)
      continue
    }
    const faltan = lista.filter((d) => d !== nexo && !salientes.get(nexo).has(d))
    if (faltan.length) {
      hallar('nexo-incompleto', nexo, 0, `no enlaza a ${faltan.map((d) => basename(d)).join(', ')}`, lista)
    }
  }

  // Un nombre de archivo que aparece en dos rutas: el lector no sabe a cuál se refiere un nombre pelado.
  const porNombre = new Map()
  for (const d of estructurales) {
    const n = basename(d)
    if (!porNombre.has(n)) porNombre.set(n, [])
    porNombre.get(n).push(d)
  }
  for (const [nombre, lista] of porNombre) {
    if (lista.length < 2) continue
    hallar('nombre-repetido', lista[1], 0, `${nombre} también está en ${lista.filter((d) => d !== lista[1]).join(', ')}`, lista)
  }

  // Ida y vuelta entre dos docs: ninguno es dueño de la regla. Un nexo enlaza a los suyos y ellos a él: no cuenta.
  const esNexo = (d) => dirname(d) !== '.' && basename(d, '.md') === basename(dirname(d))
  for (const a of estructurales) {
    for (const b of salientes.get(a)) {
      if (b <= a || b === CHANGELOG || !salientes.get(b)?.has(a)) continue
      if (esNexo(a) || esNexo(b)) continue
      hallar('ida-y-vuelta', a, 0, `se enlaza de ida y vuelta con ${b}`, [a, b])
    }
  }

  for (const d of estructurales) {
    const fm = frontMatter(textos.get(d))
    if (fm?.tipo === 'transitorio' && !fm.muere_con) {
      hallar('transitorio-sin-muere-con', d, 1, 'transitorio sin `muere_con` en el front-matter')
    }
    for (const f of fragmentosDeCodigo(textos.get(d))) {
      const hit = f.texto.split('\n').findIndex((l) => RE_RUTA_MAQUINA.test(l))
      if (hit !== -1) hallar('ruta-de-maquina', d, f.linea + hit, 'ruta de máquina en código: lo versionado sólo nombra rutas del repo')
    }
  }

  return hallazgos
}

/** `archivos` (relativos a `cwd`) como rutas del paquete; descarta lo que no es un .md revisado. */
export function seleccionar(archivos, raiz, cwd = process.cwd()) {
  const docs = new Set(listarDocs(raiz))
  const salida = new Set()
  for (const a of archivos) {
    const rel = posix(relative(raiz, resolve(cwd, a)))
    if (docs.has(rel)) salida.add(rel)
  }
  return salida
}

export function formatear(hallazgos) {
  const porArchivo = new Map()
  for (const h of hallazgos) {
    if (!porArchivo.has(h.archivo)) porArchivo.set(h.archivo, [])
    porArchivo.get(h.archivo).push(h)
  }
  const lineas = []
  for (const [archivo, lista] of [...porArchivo].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lineas.push(archivo)
    for (const h of lista.sort((x, y) => x.linea - y.linea)) {
      const donde = h.linea ? String(h.linea).padStart(5) : '    -'
      lineas.push(`${donde}  ${h.severidad === 'bloqueante' ? 'bloqueante' : 'aviso     '}  ${h.regla}: ${h.mensaje}`)
    }
  }
  const b = hallazgos.filter((h) => h.severidad === 'bloqueante').length
  lineas.push(`${NOMBRE}: ${b} bloqueantes, ${hallazgos.length - b} avisos`)
  return { texto: lineas.join('\n'), bloqueantes: b }
}

function main(argv) {
  if (argv.some((a) => a.startsWith('-'))) {
    console.error(`uso: node scripts/${NOMBRE}.mjs [archivos…]`)
    return 2
  }
  let hallazgos = revisar(RAIZ)
  if (argv.length) {
    const elegidos = seleccionar(argv, RAIZ)
    hallazgos = hallazgos.filter((h) => h.afecta.some((a) => elegidos.has(a)))
  }
  const { texto, bloqueantes } = formatear(hallazgos)
  console.log(texto)
  return bloqueantes ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2))
