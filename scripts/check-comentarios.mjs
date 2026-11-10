#!/usr/bin/env node
// Mira los comentarios que AGREGA un diff, no los que ya hay: la deuda vieja no frena a nadie y lo nuevo sí.
// Alta precisión a propósito: un gate ruidoso se ignora, y éste puede frenar el push.
//
//   node scripts/check-comentarios.mjs                       # working tree contra el merge-base con origin/main
//   node scripts/check-comentarios.mjs --base=origin/main    # otra base
//   node scripts/check-comentarios.mjs --staged              # sólo lo indexado, contra HEAD
//   node scripts/check-comentarios.mjs src/table/index.js    # sólo esos archivos (los fuera de alcance se ignoran)
//
// Exit 1 con bloqueantes, 2 por error de uso, o sin git, o sin base. Los avisos nunca cambian el exit.
// Necesita git: no corre en el CI, cuya imagen no lo trae y cuyo clon superficial no tiene base.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const RAIZ = resolve(import.meta.dirname, '..')
const BASE_POR_DEFECTO = 'origin/main'
const ALCANCE = ['src', 'react/src', 'scripts']
const EXTENSION = /\.(tsx?|m?js)$/
const MAX_DIFF = 64 << 20 // execFileSync corta con ENOBUFS al pasar el tope (1 MiB por defecto); holgado para un diff de refactor
const LARGO_MAX_TEXTO = 100 // la cita de un hallazgo cabe en una línea de terminal de 120 columnas con su sangría
// Un diff que es la mitad comentario se mira; con pocas líneas el cociente no dice nada.
const UMBRAL_PROPORCION = 0.5
const MIN_LINEAS_PROPORCION = 30

const COMENTARIO = /^\s*(\/\/|\/\*|\*(?!\/)|\*\/)/
const SEPARADOR = /^\s*(?:\/\/|\/\*+|\*)[\s*]*[-=_*#~]{6,}/
const MUERTO = /^\s*(?:\/\/|\*)\s*(const |let |var |if\s*\(|for\s*\(|while\s*\(|return\b|import |export |function |class |await |console\.)/
const IMPORT = /^\s*(?:\/\/|\*)\s*import /

// «antes» y «ya no» dicen lógica tanto como historia ("ya no hay clusters bajo el zoom 4"), así que por sí
// solos no alcanzan: el disparador necesita además un dato de historia.
const DISPARADOR_HISTORIA = /\b(?:antes(?!\s+(?:de|que)\b)|anteriormente|ya no|originalmente|en su momento|solía|solia|en la versión anterior|cuando (?:eran|era|estaba|había|habia))/i
const CONTEXTO_HISTORIA = new RegExp([
  String.raw`\bantes se\b`,
  String.raw`\bse (?:cambi|mov|renombr|elimin|reemplaz|quit|agreg|añad|sac|pas)(?:ó|o|aron)`,
  String.raw`\bv\d+\.\d+`,
  String.raw`\b\d+\.\d+\.\d+\b`,
  String.raw`\b\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?\b`,   // 06-11, 06/11, 06-11-2026
  String.raw`\b20\d{2}-\d{2}`,                          // 2026-11
  String.raw`\bversión anterior\b`,
  String.raw`\bantes\b[^.]*\bahora\b`,                 // el contraste entre el antes y el ahora es historia
].join('|'), 'i')

// Una oración que abre con «Antes,» cuenta cómo era algo, no una precedencia lógica ("antes de", "antes que" y "antes no" son lógica).
const ANTES_INICIAL = /(?:^\s*(?:\/\/|\*)\s*|[.:;]\s+)Antes\b(?!\s+(?:de|que|no)\b)/

const STOP = new Set('el la los las un una de del al y o que se es son para por con sin en su sus lo le no si mas cada como cuando donde pero este esta estos estas ya solo sólo the of to and is are this that it its a'.split(' '))
const quitarTildes = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
const palabras = s => quitarTildes(s.toLowerCase()).replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 2 && !STOP.has(w))
const tokens = s => new Set(quitarTildes(s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()).replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean))
const COBERTURA_REPETIDO = 0.7
const PALABRAS_REPETIDO = [2, 8]

const esComentario = linea => linea !== undefined && COMENTARIO.test(linea)

/** ¿Entra la ruta (relativa a la raíz del paquete) en lo que el check mira? */
export const enAlcance = ruta => {
  const p = ruta.split(sep).join('/')
  return ALCANCE.some(d => p.startsWith(`${d}/`)) && EXTENSION.test(p) && !p.endsWith('.d.ts') && !p.includes('node_modules/')
}

/** Líneas agregadas por archivo (número en el archivo nuevo) a partir de un `git diff -U0`. */
export const parsearDiff = texto => {
  const porArchivo = new Map()
  let archivo = null
  let linea = 0
  let enCabecera = false
  for (const l of texto.split('\n')) {
    // Una línea agregada que empieza con "++ " se vería como "+++ ": sólo es cabecera antes del primer hunk.
    if (l.startsWith('diff --git ')) { enCabecera = true; archivo = null; continue }
    if (enCabecera && l.startsWith('+++ ')) {
      // Git agrega un TAB tras la ruta cuando ésta tiene espacios.
      const ruta = l.slice(4).replace(/\t.*$/, '')
      archivo = ruta.startsWith('b/') && enAlcance(ruta.slice(2)) ? ruta.slice(2) : null
      if (archivo && !porArchivo.has(archivo)) porArchivo.set(archivo, new Set())
      continue
    }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (h) { enCabecera = false; linea = +h[1]; continue }
    if (!archivo || enCabecera) continue
    if (l.startsWith('+')) porArchivo.get(archivo).add(linea++)
  }
  return porArchivo
}

/** Índice de la última línea de la cabecera: el bloque de comentario que abre el archivo. */
const finCabecera = L => {
  let i = 0
  if (L[0]?.startsWith('#!')) i++
  while (i < L.length && L[i].trim() === '') i++
  const ini = i
  while (esComentario(L[i])) i++
  return i > ini ? i : 0
}

/** Los comentarios agregados que sobran. `L` son las líneas del archivo nuevo; `agregadas`, los números (base 1) que el diff agrega. */
export const revisarLineas = (L, agregadas) => {
  const hallazgos = []
  const fallo = (n, regla, txt) => hallazgos.push({ linea: n, regla, texto: txt.trim().slice(0, LARGO_MAX_TEXTO) })
  const cabecera = finCabecera(L)
  for (const n of [...agregadas].sort((a, b) => a - b)) {
    const l = L[n - 1]
    if (!esComentario(l)) continue

    if (SEPARADOR.test(l)) { fallo(n, 'separador', l); continue }
    // Un import de ejemplo en la cabecera es documentación de uso, no código muerto.
    if (MUERTO.test(l) && !(n <= cabecera && IMPORT.test(l))) { fallo(n, 'código comentado', l); continue }
    if ((DISPARADOR_HISTORIA.test(l) && CONTEXTO_HISTORIA.test(l)) || ANTES_INICIAL.test(l)) { fallo(n, 'changelog', l); continue }

    // Repite la línea de abajo: la mayoría de sus palabras ya están en el código que comenta. La segunda línea
    // de un párrafo envuelto no se mira: su coincidencia es con el propio párrafo, no con el código.
    const sigueParrafo = /^\s*\/\//.test(L[n - 2] ?? '')
    if (/^\s*\/\//.test(l) && !sigueParrafo && L[n] && !COMENTARIO.test(L[n])) {
      const w = palabras(l.replace(/^\s*\/\/+/, ''))
      if (w.length >= PALABRAS_REPETIDO[0] && w.length <= PALABRAS_REPETIDO[1]) {
        const tk = tokens(L[n])
        const raices = new Set([...tk].map(x => x.slice(0, 4)))
        const cubre = w.filter(x => tk.has(x) || raices.has(x.slice(0, 4))).length / w.length
        if (cubre >= COBERTURA_REPETIDO) fallo(n, 'repite la línea de abajo', l)
      }
    }
  }
  return hallazgos
}

/** Cuántas de las líneas agregadas son comentario. */
export const proporcion = (L, agregadas) => {
  let comentario = 0
  for (const n of agregadas) if (esComentario(L[n - 1])) comentario++
  return { comentario, total: agregadas.size }
}

export const formatear = porArchivo => {
  const salida = []
  for (const [archivo, hallazgos] of porArchivo) {
    salida.push(archivo)
    for (const h of hallazgos) salida.push(`  ${h.linea}  ${h.regla}\n      ${h.texto}`)
  }
  return salida
}

export const parsearArgs = argv => {
  const o = { base: BASE_POR_DEFECTO, staged: false, archivos: [] }
  for (const a of argv) {
    if (a === '--staged') o.staged = true
    else if (a.startsWith('--base=')) { o.base = a.slice(7); if (!o.base) return { error: '--base= necesita una referencia' } }
    else if (a.startsWith('--')) return { error: `opción desconocida: ${a}` }
    else o.archivos.push(a)
  }
  return o
}

const git = (args, opciones = {}) => execFileSync('git', args, { cwd: RAIZ, encoding: 'utf8', maxBuffer: MAX_DIFF, stdio: ['ignore', 'pipe', 'pipe'], ...opciones })

// Git exporta estas variables a los hooks; apuntarían a otro repo si se heredaran en un subproceso.
for (const v of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete process.env[v]

const salir = (mensaje, codigo) => { console.error(`check-comentarios: ${mensaje}`); return codigo }

export const main = argv => {
  const o = parsearArgs(argv)
  if (o.error) return salir(o.error, 2)

  try { git(['rev-parse', '--is-inside-work-tree']) }
  catch { return salir('necesita git y un repositorio: sin ellos no hay diff que mirar (el CI no lo corre)', 2) }

  let desde = null
  if (!o.staged) {
    try { desde = git(['merge-base', o.base, 'HEAD']).trim() }
    catch { return salir(`no hay base «${o.base}»: pasar --base=<ref> o traerla con git fetch (un clon superficial no la tiene)`, 2) }
  }

  const pedidos = o.archivos.map(a => relative(RAIZ, resolve(a)).split(sep).join('/'))
  const archivos = pedidos.length ? pedidos.filter(enAlcance) : ALCANCE
  let porArchivo = new Map()
  if (archivos.length) {
    // El pathspec es siempre el alcance entero: acotado a un archivo, git no empareja su origen y un renombrado
    // saldría como archivo nuevo. Los pedidos se filtran después.
    const diff = git(['-c', 'core.quotepath=off', 'diff', '-U0', '--relative', '--no-color', '--no-ext-diff', ...(o.staged ? ['--cached'] : [desde]), '--', ...ALCANCE])
    porArchivo = parsearDiff(diff)
    if (pedidos.length) porArchivo = new Map([...porArchivo].filter(([f]) => archivos.includes(f)))
    if (!o.staged) {
      // Un archivo nuevo sin indexar no sale en el diff: todas sus líneas son agregadas.
      const nuevos = git(['-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard', '--', ...archivos]).split('\n').filter(enAlcance)
      for (const f of nuevos) porArchivo.set(f, new Set(Array.from({ length: leer(f, false).length }, (_, i) => i + 1)))
    }
  }

  const resultado = new Map()
  let bloqueantes = 0
  let comentario = 0
  let total = 0
  for (const [archivo, agregadas] of [...porArchivo].sort(([a], [b]) => a.localeCompare(b))) {
    if (!agregadas.size || (!o.staged && !existsSync(resolve(RAIZ, archivo)))) continue
    const L = leer(archivo, o.staged)
    const hallazgos = revisarLineas(L, agregadas)
    if (hallazgos.length) resultado.set(archivo, hallazgos)
    bloqueantes += hallazgos.length
    const p = proporcion(L, agregadas)
    comentario += p.comentario
    total += p.total
  }

  for (const l of formatear(resultado)) console.log(l)
  let avisos = 0
  if (total >= MIN_LINEAS_PROPORCION && comentario / total >= UMBRAL_PROPORCION) {
    avisos++
    console.log(`\naviso: ${comentario} de ${total} líneas agregadas son comentario (${Math.round(100 * comentario / total)} %)`)
  }
  console.log(`\ncheck-comentarios: ${bloqueantes} bloqueantes, ${avisos} avisos`)
  return bloqueantes ? 1 : 0
}

// El indexado se lee del índice (`:./` es relativo a la raíz del paquete); lo demás, del disco.
const leer = (archivo, indexado) => (indexado ? git(['show', `:./${archivo}`]) : readFileSync(resolve(RAIZ, archivo), 'utf8')).split('\n')

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2))
