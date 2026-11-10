#!/usr/bin/env node
// test-corto.mjs — los gates de Cristae sobre lo que cambió la rama, no sobre el repo entero.
// Es el ciclo rápido de segundos: no reemplaza a `npm run gate` (ci-local: lint + suite + build en las imágenes Node 24 y 26).
//
//   node scripts/test-corto.mjs                      # árbol de trabajo + archivos nuevos, contra el merge-base con origin/main
//   node scripts/test-corto.mjs --base=<ref>         # contra otra ref
//   node scripts/test-corto.mjs --push --base=<sha>  # el pre-push: sólo los commits base..HEAD
//   node scripts/test-corto.mjs --push --head=<sha>  # ídem con otra punta: `git push origin otra-rama` estando en esta
//   node scripts/test-corto.mjs --sin-tests --sin-lint
//   node scripts/test-corto.mjs --solo-seleccion     # imprime qué tests elegiría y sale, sin correr nada
//
// Los tests se eligen por un grafo estático de imports: corre cada test cuyo cierre transitivo contiene un archivo
// cambiado. Lo que ese grafo no puede ver (un import que no resuelve, un cambio en package.json o en la
// configuración de build o de lint) manda a la suite entera. Los avisos se muestran pero no cuentan como rojo.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const RAIZ = resolve(import.meta.dirname, '..')

// Una modificación aquí cambia cómo corre o qué ve la suite entera, y el grafo de imports no lo expresa.
const ARCHIVOS_SUITE_ENTERA = new Set(['package.json', 'build.mjs', 'eslint.config.js'])
// Carpetas con JS que entra al grafo de imports.
const DIRS_GRAFO     = ['test', 'react/test', 'test-helpers', 'src', 'react/src']
// Un cambio fuera de estas carpetas (y de ARCHIVOS_SUITE_ENTERA) no puede afectar a un test; scripts/ entra por los tests de test/scripts.
const PREFIJOS_TESTS = [...DIRS_GRAFO, 'types', 'react/types', 'scripts'].map(d => `${d}/`)
// Los tests leen corpus, tipos y fuentes por ruta en vez de importarlos; sólo el lado de pruebas tiene esas lecturas.
const PREFIJOS_LECTORES = ['test/', 'react/test/', 'test-helpers/']
// Las pruebas de los propios scripts arman paquetes de mentira con código en cadenas: sus rutas e imports no son del repo.
// Sólo cuentan sus imports reales de scripts/, que no están en cadenas.
const PREFIJOS_FIXTURES = ['test/scripts/']
const ES_TEST        = /^(?:react\/)?test\/.*\.test\.mjs$/
const ES_JS          = /\.m?js$/
const OMITIR_DIRS    = new Set(['node_modules', 'dist', '.git'])
// Los mismos globs que `npm test`.
const GLOBS_SUITE    = ['test/**/*.test.mjs', 'react/test/**/*.test.mjs']
const MAX_BUFFER     = 64 << 20 // execFileSync corta con ENOBUFS al pasar el tope (1 MiB por defecto); holgado para un diff de refactor o la salida de la suite

// ── Grafo de imports ─────────────────────────────────────────────────────────────────────────────

// Sólo se quitan las líneas que son enteras comentario: un ejemplo de uso en una cabecera no es un import. Quitar
// bloques `/* */` con una expresión regular no sirve: los globs de las cadenas (`'test/**/*.js'`) la rompen.
const sinLineasDeComentario = codigo => codigo.replace(/^[ \t]*(?:\/\/|\/\*|\*).*$/gm, '')
const RE_ESTATICO  = /\b(?:import|export)\s+(?:[^'"`;()]*?\sfrom\s*)?['"]([^'"\n]+)['"]/g
const RE_DINAMICO  = /\bimport\s*\(\s*(?:'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`|([\w$(]))/g
// Un archivo o directorio nombrado en una cadena: relativo al archivo que lo lee o a la raíz del paquete.
const RE_RUTA_ARCHIVO = /(?:\.{1,2}\/)*\w[\w.-]*(?:\/\w[\w.-]*)*\.[a-z0-9]{1,8}\b/g
// El lookahead descarta el prefijo de una ruta de archivo: `src/data/` dentro de `src/data/Store.js` no es un directorio.
const RE_RUTA_DIR     = /(?:\.{1,2}\/)*\w[\w.-]*(?:\/\w[\w.-]*)*\/(?![\w.-])/g

/** Qué importa un archivo: especificadores literales y si hay un import() que no se puede leer. */
export const especificadores = codigo => {
  const literales = []
  let noLiteral = false
  for (const m of codigo.matchAll(RE_ESTATICO)) literales.push(m[1])
  for (const m of codigo.matchAll(RE_DINAMICO)) {
    if (m[4] !== undefined) { noLiteral = true; continue }
    const texto = m[1] ?? m[2] ?? m[3]
    if (m[3] === undefined) { literales.push(texto); continue }
    const corte = texto.indexOf('${')
    if (corte < 0) { literales.push(texto); continue }
    // `data:` es código embebido: no depende de ningún archivo. Una plantilla con prefijo de archivo
    // (`../src/x.js?copia=${n}`) importa ese archivo; cualquier otra no se puede resolver.
    const prefijo = texto.slice(0, corte).replace(/[?#].*$/, '')
    if (texto.startsWith('data:')) continue
    if (/^\.{1,2}\/.*\.m?js$/.test(prefijo)) literales.push(prefijo)
    else noLiteral = true
  }
  return { literales, noLiteral }
}

// Se prueba mucha ruta que no existe: sin `throwIfNoEntry` cada una paga una excepción y el grafo tarda el triple.
const estado = (raiz, ruta) => statSync(resolve(raiz, ruta), { throwIfNoEntry: false })
const esArchivo    = (raiz, ruta) => estado(raiz, ruta)?.isFile() ?? false
const esDirectorio = (raiz, ruta) => estado(raiz, ruta)?.isDirectory() ?? false

const destinoExport = (exportaciones, sub) => {
  const e = exportaciones?.[sub]
  const destino = typeof e === 'string' ? e : e?.default
  return destino ? posix.normalize(destino) : null
}

/**
 * Resuelve un especificador a una ruta relativa a la raíz. Devuelve `{ ruta }`, `{ externo: true }` (nativo o
 * de node_modules, que no entran al grafo) o `{ sinResolver: <candidato> }` si apunta a algo que no existe.
 */
export const resolverEspecificador = (spec, desde, { raiz, paquete }) => {
  const limpio = spec.replace(/[?#].*$/, '')
  if (limpio.startsWith('.')) {
    const candidato = posix.normalize(posix.join(posix.dirname(desde), limpio))
    if (esArchivo(raiz, candidato)) return { ruta: candidato }
    // Una cadena de código embebido (la entrada virtual de esbuild en un test) se resuelve contra la raíz del paquete.
    const desdeRaiz = posix.normalize(limpio)
    return !desdeRaiz.startsWith('..') && esArchivo(raiz, desdeRaiz) ? { ruta: desdeRaiz } : { sinResolver: candidato }
  }
  if (limpio === paquete.name || limpio.startsWith(`${paquete.name}/`)) {
    const destino = destinoExport(paquete.exports, `.${limpio.slice(paquete.name.length)}`)
    if (destino && esArchivo(raiz, destino)) return { ruta: destino }
    // El destino borrado es el candidato: así casa con el archivo eliminado, como un import relativo.
    return { sinResolver: destino ?? limpio }
  }
  return { externo: true }
}

const listarArchivos = (raiz, dir, filtro = () => true) => {
  const salida = []
  const recorrer = rel => {
    let entradas
    try { entradas = readdirSync(resolve(raiz, rel), { withFileTypes: true }) } catch { return }
    for (const e of entradas) {
      if (OMITIR_DIRS.has(e.name)) continue
      const ruta = posix.join(rel, e.name)
      if (e.isDirectory()) recorrer(ruta)
      else if (filtro(ruta)) salida.push(ruta)
    }
  }
  recorrer(dir)
  return salida
}

/** Archivos y directorios que el código nombra en una cadena y existen: lecturas de corpus, tipos o fuentes. */
export const referenciasPorTexto = (codigo, desde, raiz) => {
  const rutas = new Set()
  const candidatos = ruta => [posix.normalize(posix.join(posix.dirname(desde), ruta)), posix.normalize(ruta)]
  for (const m of codigo.matchAll(RE_RUTA_ARCHIVO)) {
    if (m[0].includes('node_modules')) continue
    for (const c of candidatos(m[0])) if (!c.startsWith('..') && esArchivo(raiz, c)) rutas.add(c)
  }
  for (const m of codigo.matchAll(RE_RUTA_DIR)) {
    if (m[0].includes('node_modules')) continue
    for (const c of candidatos(m[0])) {
      if (c.startsWith('..') || !esDirectorio(raiz, c)) continue
      for (const f of listarArchivos(raiz, c.replace(/\/$/, ''))) rutas.add(f)
    }
  }
  return rutas
}

/**
 * Lee el disco y arma el grafo: `nodos` (ruta → { deps, sinResolver, noLiteral }) e `inverso` (ruta → quién la
 * usa). Los archivos de datos que un test lee por ruta son hojas del grafo.
 */
export const construirGrafo = raiz => {
  const manifiesto = JSON.parse(readFileSync(resolve(raiz, 'package.json'), 'utf8'))
  const paquete    = { name: manifiesto.name, exports: manifiesto.exports }
  const nodos      = new Map()
  const inverso    = new Map()
  const unir       = (de, a) => {
    nodos.get(de).deps.add(a)
    if (!inverso.has(a)) inverso.set(a, new Set())
    inverso.get(a).add(de)
  }
  for (const dir of DIRS_GRAFO) {
    for (const ruta of listarArchivos(raiz, dir, f => ES_JS.test(f))) {
      const codigo = sinLineasDeComentario(readFileSync(resolve(raiz, ruta), 'utf8'))
      const fixtures = PREFIJOS_FIXTURES.some(p => ruta.startsWith(p))
      const { literales, noLiteral } = especificadores(codigo)
      nodos.set(ruta, { deps: new Set(), sinResolver: [], noLiteral: noLiteral && !fixtures })
      for (const spec of literales) {
        const r = resolverEspecificador(spec, ruta, { raiz, paquete })
        if (r.ruta) unir(ruta, r.ruta)
        else if (r.sinResolver && !fixtures) nodos.get(ruta).sinResolver.push({ spec, candidato: r.sinResolver })
      }
      if (!fixtures && PREFIJOS_LECTORES.some(p => ruta.startsWith(p))) {
        for (const r of referenciasPorTexto(codigo, ruta, raiz)) if (r !== ruta) unir(ruta, r)
      }
    }
  }
  return { nodos, inverso }
}

/** Todo lo que depende, directa o transitivamente, de `origen` (incluido él). */
const dependientes = (inverso, origen) => {
  const visto = new Set([origen])
  const cola  = [origen]
  while (cola.length) {
    for (const quien of inverso.get(cola.pop()) ?? []) {
      if (visto.has(quien)) continue
      visto.add(quien)
      cola.push(quien)
    }
  }
  return visto
}

/**
 * Qué tests correr para un conjunto de archivos cambiados (existentes o eliminados).
 * `completa` manda a la suite entera, con su `razon`; `sinTest` lista los archivos de src que ningún test alcanza.
 */
export const seleccionar = ({ grafo, cambiados }) => {
  const { nodos, inverso } = grafo
  const todosTests = [...nodos.keys()].filter(f => ES_TEST.test(f))
  const esTest     = new Set(todosTests)
  const cambiadosSet = new Set(cambiados)
  const relevante  = cambiados.some(f => ARCHIVOS_SUITE_ENTERA.has(f) || PREFIJOS_TESTS.some(p => f.startsWith(p)))
  const vacio      = { completa: false, razon: '', tests: [], siempre: [], sinTest: [] }
  if (!relevante) return vacio

  const completa = razon => ({ ...vacio, completa: true, razon, tests: todosTests.toSorted() })
  const duro = cambiados.find(f => ARCHIVOS_SUITE_ENTERA.has(f))
  if (duro) return completa(`cambió ${duro}`)

  // Un import que apuntaba a un archivo que ya no está: lo ve sólo quien lo importaba.
  for (const [ruta, nodo] of nodos) {
    const roto = nodo.sinResolver.find(s => cambiadosSet.has(s.candidato))
    if (roto) return completa(`${ruta} importa ${roto.spec}, que ya no existe`)
  }

  const elegidos = new Set(cambiados.filter(f => esTest.has(f)))
  const sinTest  = []
  for (const f of cambiados) {
    const alcance = dependientes(inverso, f)
    for (const x of alcance) {
      const roto = nodos.get(x)?.sinResolver[0]
      if (roto) return completa(`${x} importa ${roto.spec}, que no se resuelve`)
    }
    const tests = [...alcance].filter(x => esTest.has(x))
    tests.forEach(t => elegidos.add(t))
    if ((f.startsWith('src/') || f.startsWith('react/src/')) && nodos.has(f) && !tests.length) sinTest.push(f)
  }

  // Un import() cuyo destino no se lee puede traer cualquier archivo: quien lo cargue, transitivamente, corre siempre.
  const siempre = new Set()
  for (const [ruta, nodo] of nodos) {
    if (!nodo.noLiteral) continue
    for (const x of dependientes(inverso, ruta)) if (esTest.has(x)) siempre.add(x)
  }
  siempre.forEach(t => elegidos.add(t))
  return { ...vacio, tests: [...elegidos].toSorted(), siempre: [...siempre].toSorted(), sinTest: sinTest.toSorted() }
}

// ── Git ──────────────────────────────────────────────────────────────────────────────────────────

const git = (raiz, ...a) => execFileSync('git', a, { cwd: raiz, encoding: 'utf8', maxBuffer: MAX_BUFFER }).trim()
const lineas = texto => texto.split('\n').filter(Boolean)

export const mergeBase = (raiz, ref, head = 'HEAD') => git(raiz, 'merge-base', ref, head)

/** `cambiados` existen hoy (agregados, copiados o modificados; un renombre cuenta como alta); `eliminados` ya no. */
export const listaCambios = ({ raiz, base, push, head = 'HEAD' }) => {
  const dif = filtro => lineas(git(raiz, 'diff', '--name-only', '--no-renames', `--diff-filter=${filtro}`, base, ...(push ? [head] : [])))
  const nuevos = push ? [] : lineas(git(raiz, 'ls-files', '--others', '--exclude-standard'))
  return { cambiados: [...new Set([...dif('ACM'), ...nuevos])].toSorted(), eliminados: dif('D').toSorted() }
}

// ── Pasos ────────────────────────────────────────────────────────────────────────────────────────

/** Lee la última línea de resumen de un check-*: «<check>: N bloqueantes, M avisos». */
export const parsearResumen = salida => {
  const m = [...salida.matchAll(/:\s*(\d+) bloqueantes?, (\d+) avisos?\s*$/gm)].at(-1)
  return m ? { bloqueantes: Number(m[1]), avisos: Number(m[2]) } : null
}

const esFuente = f => ES_JS.test(f) && (f.startsWith('src/') || f.startsWith('react/src/'))

/**
 * Los pasos y cuándo aplica cada uno, dado lo que cambió. Sin un bloque para scripts/ en eslint.config.js, ESLint
 * los juzgaría sin los globals de Node y marcaría `process` y `console`: por eso `lintCubreScripts`.
 */
export const armarPasos = ({ cambiados, base, seleccion, sinTests, sinLint, lintCubreScripts = true }) => {
  const js    = cambiados.filter(f => ES_JS.test(f))
  const lint  = js.filter(f => esFuente(f) || (lintCubreScripts && f.startsWith('scripts/')) || f === 'build.mjs')
  const md    = cambiados.filter(f => f.endsWith('.md'))
  const arbol = md.length > 0 || cambiados.some(f => f.startsWith('src/') || f.startsWith('types/'))
  const tests = seleccion.completa ? GLOBS_SUITE : seleccion.tests
  return [
    { nombre: 'eslint',            aplica: lint.length > 0 && !sinLint, argv: ['node_modules/eslint/bin/eslint.js', '--no-warn-ignored', ...lint] },
    { nombre: 'redacción',         aplica: md.length > 0,               script: 'check-redaccion.mjs', argv: ['scripts/check-redaccion.mjs', ...md], avisa: true },
    { nombre: 'enlaces',           aplica: arbol,                       script: 'check-enlaces.mjs',      argv: ['scripts/check-enlaces.mjs'] },
    { nombre: 'refs de sección',   aplica: arbol,                       script: 'check-refs-seccion.mjs', argv: ['scripts/check-refs-seccion.mjs'] },
    { nombre: 'comentarios',       aplica: js.some(esFuente),           script: 'check-comentarios.mjs',  argv: ['scripts/check-comentarios.mjs', `--base=${base}`] },
    { nombre: 'tests',             aplica: tests.length > 0 && !sinTests, tests: true, argv: ['--test', '--test-reporter=dot', ...tests] },
  ]
}

/** Clasifica el resultado de un proceso: OK, aviso o FALLA, según el contrato común de los check-*. */
export const clasificar = (paso, { status, error, salida }) => {
  if (error || status === null || status === 2) return 'FALLA'
  const resumen = parsearResumen(salida)
  if (paso.avisa) return resumen && (resumen.bloqueantes || resumen.avisos) ? 'aviso' : status === 0 ? 'OK' : 'aviso'
  if (status !== 0) return 'FALLA'
  return resumen?.avisos ? 'aviso' : 'OK'
}

const SIMBOLO = { OK: 'OK   ', aviso: 'aviso', FALLA: 'FALLA', falta: 'falta', omitido: '–    ' }

const ayuda = 'uso: node scripts/test-corto.mjs [--base=<ref>] [--push [--head=<sha>]] [--sin-tests] [--sin-lint] [--solo-seleccion]'

/** Devuelve el exit code; main no llama a process.exit para no cortar la salida que aún no se vació. */
const main = (args = process.argv.slice(2)) => {
  const conocidos = ['--push', '--sin-tests', '--sin-lint', '--solo-seleccion']
  const raro = args.find(a => !a.startsWith('--base=') && !a.startsWith('--head=') && !conocidos.includes(a))
  if (raro) { console.error(`argumento desconocido: ${raro}\n${ayuda}`); return 2 }
  const ref  = args.find(a => a.startsWith('--base='))?.slice('--base='.length) ?? 'origin/main'
  const push = args.includes('--push')
  const headArg = args.find(a => a.startsWith('--head='))?.slice('--head='.length)
  if (headArg !== undefined && !push) { console.error(`--head sólo se combina con --push\n${ayuda}`); return 2 }
  const head = headArg ?? 'HEAD'

  let base
  try {
    if (headArg !== undefined) git(RAIZ, 'rev-parse', '--verify', '--quiet', `${head}^{commit}`)
    base = mergeBase(RAIZ, ref, head)
  } catch (e) {
    if (e.code === 'ENOENT') console.error('No se encuentra git: hace falta en el PATH para saber qué cambió')
    else console.error(`No hay merge-base entre ${ref} y ${head} (${e.message.split('\n')[0]}). Si es origin/main: git fetch origin main`)
    return 2
  }
  if (headArg !== undefined && git(RAIZ, 'rev-parse', head) !== git(RAIZ, 'rev-parse', 'HEAD')) {
    console.log(`aviso: --head no es el HEAD del árbol de trabajo: la lista de archivos sale de ${head}, pero el grafo de imports y los chequeos leen el árbol de trabajo\n`)
  }
  const { cambiados, eliminados } = listaCambios({ raiz: RAIZ, base, push, head })
  const grafo     = construirGrafo(RAIZ)
  const seleccion = seleccionar({ grafo, cambiados: [...cambiados, ...eliminados] })

  console.log(`test-corto · ${cambiados.length + eliminados.length} archivo(s) ${push ? 'en los commits que se suben' : 'cambiados'} desde ${base.slice(0, 8)} (${ref})`)
  const motivo = seleccion.completa ? `suite entera (${seleccion.razon})` : `${seleccion.tests.length} de ${[...grafo.nodos.keys()].filter(f => ES_TEST.test(f)).length}`
  console.log(`tests elegidos: ${motivo}${seleccion.siempre.length ? ` · ${seleccion.siempre.length} entran siempre por un import() dinámico` : ''}\n`)
  if (args.includes('--solo-seleccion')) {
    if (!seleccion.completa) for (const t of seleccion.tests) console.log(`  ${t}`)
    if (seleccion.sinTest.length) console.log(`\naviso, sin test que los alcance: ${seleccion.sinTest.join(', ')}`)
    return 0
  }

  const configLint = resolve(RAIZ, 'eslint.config.js')
  const lintCubreScripts = existsSync(configLint) && readFileSync(configLint, 'utf8').includes('scripts/')
  const pasos = armarPasos({ cambiados, base, seleccion, lintCubreScripts, sinTests: args.includes('--sin-tests'), sinLint: args.includes('--sin-lint') })
  const detalle = []
  let fallas = 0
  for (const paso of pasos) {
    if (!paso.aplica) { console.log(`  ${SIMBOLO.omitido}  ${paso.nombre}`); continue }
    if (paso.script && !existsSync(resolve(RAIZ, 'scripts', paso.script))) {
      console.log(`  ${SIMBOLO.falta}  ${paso.nombre} · falta el script ${paso.script}`)
      continue
    }
    const inicio = Date.now()
    const r      = spawnSync(process.execPath, paso.argv, { cwd: RAIZ, encoding: 'utf8', maxBuffer: MAX_BUFFER })
    const salida = `${r.stdout ?? ''}${r.stderr ?? ''}`
    let estado   = clasificar(paso, { status: r.status, error: r.error, salida })
    const aparte = paso.tests && estado === 'OK' && seleccion.sinTest.length
    if (aparte) estado = 'aviso'
    console.log(`  ${SIMBOLO[estado]}  ${paso.nombre} · ${((Date.now() - inicio) / 1000).toFixed(1)} s${paso.tests ? ` · ${seleccion.completa ? 'suite entera' : `${seleccion.tests.length} archivo(s)`}` : ''}`)
    const texto = aparte ? `sin test que los alcance: ${seleccion.sinTest.join(', ')}` : salida.trim()
    if (estado === 'FALLA') { fallas++; detalle.push(`── ${paso.nombre} ──\n${texto || String(r.error ?? `terminó con ${r.status}`)}`) }
    else if (estado === 'aviso' && texto) detalle.push(`── ${paso.nombre} (aviso) ──\n${texto}`)
  }
  if (detalle.length) console.log(`\n${detalle.join('\n\n')}`)
  console.log(fallas ? `\ntest-corto: ${fallas} paso(s) en rojo.` : `\ntest-corto: en verde${detalle.length ? `, ${detalle.length} aviso(s)` : ''}.`)
  return fallas ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main()
