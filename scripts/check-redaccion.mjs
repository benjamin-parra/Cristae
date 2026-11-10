#!/usr/bin/env node
// check-redaccion.mjs: las reglas de redacción de los docs que se pueden medir.
// Alcance: README.md, AGENTS.md, SKILL.md y docs/**/*.md. CHANGELOG.md, notas/, node_modules y dist quedan fuera.
//
// Durante el refactor de docs todo avisa y nada bloquea. Los hallazgos se clasifican igual en bloqueante y
// aviso, y `--estricto` hace que los bloqueantes den exit 1: así se endurece después sin reescribir.
// Exit 2 es error de uso o falla del propio script, que ningún hook confunde con 1.
//
//   node scripts/check-redaccion.mjs                    # alcance completo, recorrido desde el disco
//   node scripts/check-redaccion.mjs --todo             # lo mismo, explícito (es lo que corre el CI)
//   node scripts/check-redaccion.mjs docs/a.md          # sólo esos archivos, enteros
//   node scripts/check-redaccion.mjs --base=<ref>       # sólo los párrafos que agrega el diff contra el merge-base
//   node scripts/check-redaccion.mjs --estricto         # los bloqueantes dan exit 1
//   node scripts/check-redaccion.mjs --desglose         # suma el conteo por regla y severidad
//   node scripts/check-redaccion.mjs --todo --resumen   # sólo el desglose: `npm run lint` no vuelca cientos de avisos al log del CI
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const RAIZ_DEFECTO = resolve(import.meta.dirname, '..')
const MAX_SALIDA_GIT = 64 << 20 // execFileSync corta con ENOBUFS al pasar el tope (1 MiB por defecto); holgado para un diff de refactor
const LARGO_CITA = 140 // la cita de un hallazgo cabe en una línea de terminal de 160 columnas con su sangría

// Sin `git`: el CI de winglibraries corre este script dentro de packages/cristae, en una imagen que no lo trae.
const RAICES_ARCHIVO = ['README.md', 'AGENTS.md', 'SKILL.md']
const CARPETA_DOCS   = 'docs'
const EXCLUIDAS      = new Set(['node_modules', 'dist', 'notas', '.git'])

export const enAlcance = f => RAICES_ARCHIVO.includes(f) || (/^docs\/.*\.md$/.test(f) && !f.split('/').some(p => EXCLUIDAS.has(p)))

// Caracteres visibles de un párrafo o bullet a partir de los cuales avisa «largo»; tres oraciones avisan «oraciones».
export const AVISA_LARGO     = 400
export const AVISA_ORACIONES = 3
const ENFASIS_EMOJI = /🔴|🛑|⚠️?|⛔|🥇|❗|‼️|🚨/u
const NEGRITA       = /\*\*[^*]+\*\*/

const palabra   = lista => new RegExp(`(?<!\\p{L})(${lista})(?!\\p{L})`, 'iu')
// Un code span nombra, no redacta: cuenta como una «X», que además puede iniciar oración.
export const sinCodigo = l => l.replace(/`[^`]*`/g, 'X')
// Lo que se lee: sin código, de un enlace sólo su texto, sin negrita.
const visible   = l => sinCodigo(l).replace(/\]\([^)]*\)/g, ']').replace(/\*\*|__/g, '')
export const oraciones = t => 1 + (t.match(/[.!?]["»)]*\s+[¿¡«"(]*[A-ZÁÉÍÓÚÑ]/g) ?? []).length
export const largo     = t => t.replace(/^\s*([-*>]|\d+\.)\s+/, '').length

// Se miran por línea, por celda de tabla y por título; las que bloquean, también sobre el párrafo entero.
export const REGLAS = [
  { id: 'acotación', bloquea: true, prueba: t => /—[^—]+—/.test(t), regla: 'un inciso entre rayas es la aclaración que sobra' },
  { id: 'conector', bloquea: true, prueba: t => palabra('es decir|o sea').test(t), regla: 'en `X, es decir Y` sobrevive X' },
  { id: 'doble énfasis', bloquea: true, prueba: t => ENFASIS_EMOJI.test(t) && NEGRITA.test(t), regla: 'emoji y negrita juntos' },
  { id: 'énfasis', bloquea: false, prueba: t => ENFASIS_EMOJI.test(t) && !NEGRITA.test(t), regla: 'un énfasis o ninguno por doc' },
]

// Sólo sobre el párrafo o bullet entero, aunque esté partido en varias líneas.
export const REGLAS_BLOQUE = [
  { id: 'punto y coma', bloquea: true, prueba: t => (visible(t).replace(/&#?\w+;/g, '').match(/;/g) ?? []).length >= 2, regla: 'tres ítems separados por `;` son filas' },
  { id: 'largo', bloquea: false, prueba: t => largo(visible(t)) > AVISA_LARGO, regla: `un párrafo o bullet de más de ${AVISA_LARGO} caracteres` },
  { id: 'oraciones', bloquea: false, prueba: t => oraciones(visible(t)) >= AVISA_ORACIONES, regla: 'tres oraciones son un párrafo; bullet por defecto' },
]

// Líneas agregadas por archivo en un `git diff -U0`, con su número en el archivo nuevo.
export function lineasDe(diff) {
  const porArchivo = new Map()
  let actual = null
  for (const linea of diff.split('\n')) {
    if (linea.startsWith('+++ ')) {
      actual = linea.slice(6).replace(/\t.*$/, '')
      if (enAlcance(actual)) porArchivo.set(actual, new Set())
      continue
    }
    const hunk = linea.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (hunk && porArchivo.has(actual)) {
      const desde = Number(hunk[1])
      for (let n = 0; n < Number(hunk[2] ?? 1); n++) porArchivo.get(actual).add(desde + n)
    }
  }
  return porArchivo
}

// Todos los .md del alcance, con rutas relativas a la raíz y separador `/`.
export function listarAlcance(raiz) {
  const encontrados = RAICES_ARCHIVO.filter(f => existsSync(resolve(raiz, f)))
  const recorrer = dir => {
    for (const e of readdirSync(resolve(raiz, dir), { withFileTypes: true })) {
      if (EXCLUIDAS.has(e.name)) continue
      const ruta = `${dir}/${e.name}`
      if (e.isDirectory()) recorrer(ruta)
      else if (enAlcance(ruta)) encontrados.push(ruta)
    }
  }
  if (existsSync(resolve(raiz, CARPETA_DOCS))) recorrer(CARPETA_DOCS)
  return encontrados.sort()
}

// `soloLineas` null mide el archivo entero; un Set limita los hallazgos a esas líneas y a los párrafos que tocan.
export function revisar(texto, soloLineas = null) {
  const lineas    = texto.split('\n')
  const hallazgos = []
  const bloques   = []
  const anotar    = (n, r, cita) => hallazgos.push({ n, r, texto: cita })
  let enCodigo = null
  let enFront  = lineas[0] === '---'
  let bloque   = null

  lineas.forEach((original, i) => {
    const n = i + 1
    if (enFront) {
      if (i > 0 && original === '---') enFront = false
      return
    }
    // Una valla cierra sólo con la misma marca y al menos tan larga; otra marca dentro del bloque es texto.
    const valla = original.match(/^ {0,3}(`{3,}|~{3,})/)
    if (valla && (!enCodigo || (valla[1][0] === enCodigo[0] && valla[1].length >= enCodigo.length && /^ {0,3}[`~]+\s*$/.test(original)))) {
      enCodigo = enCodigo ? null : valla[1]
      bloque   = null
      return
    }
    const nueva  = !soloLineas || soloLineas.has(n)
    const tabla  = !enCodigo && /^\s*\|/.test(original)
    const titulo = !enCodigo && /^\s*#/.test(original)
    if (tabla || titulo || enCodigo || !original.trim()) {
      bloque = null
      if (!nueva || enCodigo || !original.trim()) return
      const partes = tabla ? sinCodigo(original).split('|') : [sinCodigo(original)]
      REGLAS.forEach(r => partes.some(p => r.prueba(p)) && anotar(n, r, original.trim()))
      return
    }
    if (!bloque || /^\s*([-*]|\d+\.)\s/.test(original)) bloques.push((bloque = { inicio: n, lineas: [], texto: '' }))
    bloque.lineas.push(n)
    bloque.texto += (bloque.texto ? ' ' : '') + original.trim()
    if (nueva) REGLAS.forEach(r => r.prueba(sinCodigo(original)) && anotar(n, r, original.trim()))
  })

  // Un párrafo que el diff toca a medias no se le cobra entero a quien lo editó: avisa.
  const vistos = new Set(hallazgos.map(h => `${h.n}:${h.r.id}`))
  bloques
    .filter(b => !soloLineas || b.lineas.some(n => soloLineas.has(n)))
    .forEach(b => {
      const heredado = soloLineas && b.lineas.some(n => !soloLineas.has(n))
      const cita     = lineas[b.inicio - 1].trim()
      const aplicables = [...REGLAS.filter(r => r.bloquea), ...REGLAS_BLOQUE]
      aplicables.forEach(r => {
        if (b.lineas.some(n => vistos.has(`${n}:${r.id}`)) || !r.prueba(sinCodigo(b.texto))) return
        anotar(b.inicio, heredado && r.bloquea ? { ...r, bloquea: false, regla: `${r.regla} (párrafo heredado)` } : r, cita)
      })
    })
  return hallazgos.sort((a, b) => a.n - b.n)
}

// Conteo por regla y severidad sobre los hallazgos de varios archivos.
export function desglosar(porArchivo) {
  const cuenta = new Map()
  for (const hallazgos of porArchivo.values()) {
    for (const { r } of hallazgos) {
      const clave = `${r.id}|${r.bloquea ? 'bloqueante' : 'aviso'}`
      cuenta.set(clave, (cuenta.get(clave) ?? 0) + 1)
    }
  }
  return [...cuenta].map(([clave, total]) => ({ regla: clave.split('|')[0], severidad: clave.split('|')[1], total })).sort((a, b) => b.total - a.total)
}

const git = (raiz, ...a) => execFileSync('git', a, { cwd: raiz, encoding: 'utf8', maxBuffer: MAX_SALIDA_GIT })

// Con `--base`: las líneas que agrega el árbol de trabajo contra el merge-base, y los archivos sin trackear enteros (null).
function agregadas(raiz, ref) {
  const alcance    = [...RAICES_ARCHIVO, CARPETA_DOCS]
  const base       = git(raiz, 'merge-base', ref, 'HEAD').trim()
  const porArchivo = lineasDe(git(raiz, 'diff', '-U0', '--diff-filter=ACMR', '--src-prefix=a/', '--dst-prefix=b/', base, '--', ...alcance))
  git(raiz, '-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '--', ...alcance).split('\n').filter(enAlcance).forEach(f => porArchivo.set(f, null))
  return porArchivo
}

const USO = 'uso: check-redaccion.mjs [--todo | --base=<ref>] [--estricto] [--desglose | --resumen] [archivos…]'

// Devuelve { codigo, salida, error }: el main imprime y sale; los tests lo llaman sin tocar el proceso.
export function correr(args, raiz = RAIZ_DEFECTO, cwd = process.cwd()) {
  const opciones = args.filter(a => a.startsWith('--'))
  const nombres  = opciones.map(o => o.split('=')[0])
  const invalida = nombres.find(o => !['--todo', '--base', '--estricto', '--desglose', '--resumen'].includes(o))
  if (invalida) return { codigo: 2, error: `opción desconocida ${invalida}. ${USO}` }
  const base = opciones.find(o => o.startsWith('--base'))
  if (base && (!base.includes('=') || base.endsWith('='))) return { codigo: 2, error: `--base pide una referencia: --base=<ref>. ${USO}` }
  if (base && nombres.includes('--todo')) return { codigo: 2, error: `--todo y --base no se combinan. ${USO}` }
  const ref   = base?.split('=').slice(1).join('=')
  const pedidos = args.filter(a => !a.startsWith('--')).map(a => ({ arg: a, ruta: relative(raiz, resolve(cwd, a)).split(sep).join('/') }))
  // Lo que no entra en el alcance se ignora en silencio, exista o no; sólo falta lo que el check iba a leer.
  const enAlcancePedido = pedidos.filter(p => enAlcance(p.ruta))
  const faltan = enAlcancePedido.filter(p => !statSync(resolve(raiz, p.ruta), { throwIfNoEntry: false })?.isFile())
  if (faltan.length) return { codigo: 2, error: `inexistente: ${faltan.map(p => p.arg).join(', ')}` }
  const rutas = pedidos.map(p => p.ruta)

  let objetivo
  if (ref) {
    const diff = agregadas(raiz, ref)
    objetivo = rutas.length ? new Map([...diff].filter(([f]) => rutas.includes(f))) : diff
  } else {
    objetivo = new Map((rutas.length ? enAlcancePedido.map(p => p.ruta) : listarAlcance(raiz)).map(f => [f, null]))
  }

  const resumen = nombres.includes('--resumen')
  const porArchivo = new Map()
  const salida = []
  let bloquean = 0
  let avisos   = 0
  for (const [archivo, soloLineas] of objetivo) {
    const hallazgos = revisar(readFileSync(resolve(raiz, archivo), 'utf8'), soloLineas)
    if (!hallazgos.length) continue
    porArchivo.set(archivo, hallazgos)
    if (!resumen) salida.push(`\n${archivo}`)
    hallazgos.forEach(({ n, r, texto }) => {
      r.bloquea ? bloquean++ : avisos++
      if (!resumen) salida.push(`  ${r.bloquea ? 'bloqueante' : 'aviso'} ${n}  [${r.id}] ${r.regla}\n      ${texto.length > LARGO_CITA ? `${texto.slice(0, LARGO_CITA)}…` : texto}`)
    })
  }
  if (resumen || nombres.includes('--desglose')) {
    salida.push('\ndesglose por regla:')
    desglosar(porArchivo).forEach(d => salida.push(`  ${String(d.total).padStart(5)}  ${d.regla} (${d.severidad})`))
  }
  salida.push(`\ncheck-redaccion: ${bloquean} bloqueantes, ${avisos} avisos`)
  return { codigo: nombres.includes('--estricto') && bloquean ? 1 : 0, salida: salida.join('\n'), bloquean, avisos, archivos: objetivo.size }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let r
  try {
    r = correr(process.argv.slice(2))
  } catch (e) {
    // Una falla del propio script (git, lectura) no es un bloqueante: sale 2.
    r = { codigo: 2, error: e.message.split('\n')[0] }
  }
  if (r.error) console.error(`check-redaccion: ${r.error}`)
  else console.log(r.salida)
  // exitCode y no exit(): con la salida en un pipe, exit() corta lo que aún no se vació.
  process.exitCode = r.codigo
}
