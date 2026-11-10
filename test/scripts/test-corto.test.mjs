// test-corto: el grafo de imports y la selección de tests son funciones puras sobre un árbol de fixtures.
// Corre con: node --test test/scripts/test-corto.test.mjs
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import {
  armarPasos, clasificar, construirGrafo, especificadores, listaCambios, mergeBase, parsearResumen,
  referenciasPorTexto, resolverEspecificador, seleccionar,
} from '../../scripts/test-corto.mjs'

const SCRIPT = join(import.meta.dirname, '../../scripts/test-corto.mjs')

// La imagen del CI no trae git: lo que lo necesita se salta allí.
const hayGit = spawnSync('git', ['--version']).status === 0

const temporales = []
after(() => temporales.forEach(d => rmSync(d, { recursive: true, force: true })))

/** Escribe un paquete de mentira (`{ ruta: contenido }`) con el package.json de Cristae en miniatura. */
const paquete = archivos => {
  const raiz = mkdtempSync(join(tmpdir(), 'test-corto-'))
  temporales.push(raiz)
  const todos = {
    'package.json': JSON.stringify({
      name: 'cristae',
      exports: { './core': { default: './src/data/index.js' }, './geometry': './src/geometry/index.js' },
    }),
    ...archivos,
  }
  for (const [ruta, contenido] of Object.entries(todos)) {
    mkdirSync(dirname(join(raiz, ruta)), { recursive: true })
    writeFileSync(join(raiz, ruta), contenido)
  }
  return raiz
}

const BASE = {
  'src/data/index.js'     : "export * from './store.js'\n",
  'src/data/store.js'     : 'export const store = 1\n',
  'src/geometry/index.js' : "import { store } from '../data/store.js'\nexport const g = store\n",
  'src/solo.js'           : 'export const solo = 1\n',
  'test-helpers/stub.mjs' : "import { store } from '../src/data/store.js'\nexport const stub = store\n",
  // cadena src → helper → test
  'test/a.test.mjs'       : "import { stub } from '../test-helpers/stub.mjs'\nexport { stub }\n",
  // el nombre propio del paquete, resuelto por exports
  'test/b.test.mjs'       : "import { g } from 'cristae/geometry'\nimport test from 'node:test'\nexport { g, test }\n",
  // lee un corpus por ruta, sin importarlo
  'test/d.test.mjs'       : "import { readFileSync } from 'node:fs'\nexport const t = readFileSync(new URL('./corpus/x.json', import.meta.url))\n",
  'test/corpus/x.json'    : '{}\n',
  // import() con plantilla que lleva un prefijo de archivo
  'test/e.test.mjs'       : 'export const m = await import(`../src/data/index.js?copia=${Math.random()}`)\n',
}

const elegir = (raiz, cambiados) => seleccionar({ grafo: construirGrafo(raiz), cambiados })

describe('especificadores', () => {
  test('lee imports y exports estáticos, también de varias líneas', () => {
    const { literales, noLiteral } = especificadores([
      "import a from './a.js'",
      "import './efecto.js'",
      "import {",
      "  b,",
      "  c,",
      "} from '../b.js'",
      "export * from './re.js'",
      "export { d } from \"./d.js\"",
      "export const x = 'no-es-import'",
    ].join('\n'))
    assert.deepEqual(literales.toSorted(), ['../b.js', './a.js', './d.js', './efecto.js', './re.js'])
    assert.equal(noLiteral, false)
  })

  test('import() con literal, con plantilla sin interpolar y con plantilla con prefijo de archivo', () => {
    const { literales, noLiteral } = especificadores([
      "await import('leaflet')",
      'await import(`./x.js`)',
      'await import(`../src/r.js?realm=${n}`)',
    ].join('\n'))
    assert.deepEqual(literales, ['leaflet', './x.js', '../src/r.js'])
    assert.equal(noLiteral, false)
  })

  test('un import() cuyo destino no se lee marca noLiteral; uno de data: no depende de ningún archivo', () => {
    assert.equal(especificadores('await import(nombre)').noLiteral, true)
    assert.equal(especificadores('await import(`${DIST}esm/map.js`)').noLiteral, true)
    const embebido = especificadores('await import(`data:text/javascript;base64,${b64}`)')
    assert.deepEqual(embebido, { literales: [], noLiteral: false })
  })

  test('el texto «import()» en prosa no cuenta como import dinámico', () => {
    assert.equal(especificadores('// el import() dinámico carga tarde').noLiteral, false)
  })
})

describe('resolverEspecificador', () => {
  const raiz = paquete(BASE)
  const paq  = { name: 'cristae', exports: { './core': { default: './src/data/index.js' }, './geometry': './src/geometry/index.js' } }
  const ctx  = { raiz, paquete: paq }

  test('relativo existente, con consulta, y relativo inexistente', () => {
    assert.deepEqual(resolverEspecificador('../src/data/store.js', 'test/a.test.mjs', ctx), { ruta: 'src/data/store.js' })
    assert.deepEqual(resolverEspecificador('./store.js?copia', 'src/data/index.js', ctx), { ruta: 'src/data/store.js' })
    assert.deepEqual(resolverEspecificador('./nada.js', 'src/data/index.js', ctx), { sinResolver: 'src/data/nada.js' })
  })

  test('una cadena relativa a la raíz (código embebido) resuelve contra la raíz del paquete', () => {
    assert.deepEqual(resolverEspecificador('./src/solo.js', 'test/b.test.mjs', ctx), { ruta: 'src/solo.js' })
  })

  test('el nombre propio del paquete sale del campo exports', () => {
    assert.deepEqual(resolverEspecificador('cristae/core', 'test/a.test.mjs', ctx), { ruta: 'src/data/index.js' })
    assert.deepEqual(resolverEspecificador('cristae/geometry', 'test/a.test.mjs', ctx), { ruta: 'src/geometry/index.js' })
    assert.deepEqual(resolverEspecificador('cristae/inexistente', 'test/a.test.mjs', ctx), { sinResolver: 'cristae/inexistente' })
    assert.deepEqual(resolverEspecificador('cristae', 'test/a.test.mjs', ctx), { sinResolver: 'cristae' })
  })

  test('un export cuyo destino ya no existe devuelve el destino como candidato', () => {
    const exports = { ...paq.exports, './borrado': './src/borrado.js' }
    assert.deepEqual(resolverEspecificador('cristae/borrado', 'test/a.test.mjs', { raiz, paquete: { ...paq, exports } }), { sinResolver: 'src/borrado.js' })
  })

  test('nativos y paquetes de node_modules quedan fuera del grafo', () => {
    assert.deepEqual(resolverEspecificador('node:test', 'test/a.test.mjs', ctx), { externo: true })
    assert.deepEqual(resolverEspecificador('leaflet', 'test/a.test.mjs', ctx), { externo: true })
    assert.deepEqual(resolverEspecificador('lit/directives/unsafe-html.js', 'test/a.test.mjs', ctx), { externo: true })
  })
})

describe('referenciasPorTexto', () => {
  const raiz = paquete({ ...BASE, 'types/core.d.ts': 'export {}\n', 'test/corpus/y.kml': '<kml/>\n' })

  test('un archivo nombrado en una cadena, relativo al lector o a la raíz', () => {
    const codigo = "readFileSync(raiz('types/core.d.ts')); new URL('./corpus/x.json', import.meta.url)"
    assert.deepEqual([...referenciasPorTexto(codigo, 'test/d.test.mjs', raiz)].toSorted(), ['test/corpus/x.json', 'types/core.d.ts'])
  })

  test('un directorio nombrado trae todos sus archivos, pero el prefijo de una ruta de archivo no es un directorio', () => {
    assert.deepEqual([...referenciasPorTexto("new URL('corpus/', import.meta.url)", 'test/d.test.mjs', raiz)].toSorted(), ['test/corpus/x.json', 'test/corpus/y.kml'])
    assert.deepEqual([...referenciasPorTexto("'src/data/store.js'", 'test/d.test.mjs', raiz)], ['src/data/store.js'])
  })

  test('lo que no existe se ignora', () => {
    assert.equal(referenciasPorTexto("assert.equal(a.length, 'nada/x.js')", 'test/d.test.mjs', raiz).size, 0)
  })
})

describe('seleccionar', () => {
  const raiz = paquete(BASE)

  test('src → helper → test: tocar la fuente elige al test que la alcanza por el helper y por la re-exportación', () => {
    const r = elegir(raiz, ['src/data/store.js'])
    assert.deepEqual(r.tests, ['test/a.test.mjs', 'test/b.test.mjs', 'test/e.test.mjs'])
    assert.equal(r.completa, false)
    assert.deepEqual(r.sinTest, [])
  })

  test('el nombre propio del paquete cuenta como import', () => {
    assert.deepEqual(elegir(raiz, ['src/geometry/index.js']).tests, ['test/b.test.mjs'])
  })

  test('tocar un helper elige a quien lo importa', () => {
    assert.deepEqual(elegir(raiz, ['test-helpers/stub.mjs']).tests, ['test/a.test.mjs'])
  })

  test('un test cambiado entra aunque no lo alcance nada', () => {
    assert.deepEqual(elegir(raiz, ['test/d.test.mjs']).tests, ['test/d.test.mjs'])
  })

  test('un corpus que un test lee por ruta elige a ese test', () => {
    assert.deepEqual(elegir(raiz, ['test/corpus/x.json']).tests, ['test/d.test.mjs'])
  })

  test('un archivo de src que ningún test alcanza se lista como aviso', () => {
    const r = elegir(raiz, ['src/solo.js'])
    assert.deepEqual(r.tests, [])
    assert.deepEqual(r.sinTest, ['src/solo.js'])
  })

  test('lo que no puede afectar a un test no elige ninguno', () => {
    const r = elegir(raiz, ['README.md', 'docs/guia.md'])
    assert.deepEqual(r, { completa: false, razon: '', tests: [], siempre: [], sinTest: [] })
  })

  for (const f of ['package.json', 'build.mjs', 'eslint.config.js']) {
    test(`cambiar ${f} manda a la suite entera`, () => {
      const r = elegir(raiz, [f])
      assert.equal(r.completa, true)
      assert.match(r.razon, new RegExp(f.replace('.', '\\.')))
      assert.deepEqual(r.tests, ['test/a.test.mjs', 'test/b.test.mjs', 'test/d.test.mjs', 'test/e.test.mjs'])
    })
  }

  test('un test con import() no literal entra siempre, y lo que lo cargue también', () => {
    const conDinamico = paquete({
      ...BASE,
      'test-helpers/cargador.mjs' : 'export const cargar = n => import(n)\n',
      'test/c.test.mjs'           : "import { cargar } from '../test-helpers/cargador.mjs'\nexport { cargar }\n",
    })
    const r = elegir(conDinamico, ['src/solo.js'])
    assert.deepEqual(r.siempre, ['test/c.test.mjs'])
    assert.deepEqual(r.tests, ['test/c.test.mjs'])
    assert.deepEqual(elegir(conDinamico, ['src/geometry/index.js']).tests, ['test/b.test.mjs', 'test/c.test.mjs'])
    // sin cambios que puedan afectar a un test, tampoco corre
    assert.deepEqual(elegir(conDinamico, ['README.md']).tests, [])
  })

  test('un import que no se resuelve en lo alcanzado manda a la suite entera', () => {
    const roto = paquete({ ...BASE, 'test/g.test.mjs': "import '../src/data/store.js'\nimport './nada.js'\n" })
    const r = elegir(roto, ['src/data/store.js'])
    assert.equal(r.completa, true)
    assert.match(r.razon, /nada\.js/)
    // un cambio que el import roto no alcanza sigue acotado
    assert.equal(elegir(roto, ['src/geometry/index.js']).completa, false)
  })

  test('borrar un archivo que alguien importaba manda a la suite entera', () => {
    const huerfano = paquete({ ...BASE, 'test/h.test.mjs': "import '../src/borrado.js'\n" })
    const r = elegir(huerfano, ['src/borrado.js'])
    assert.equal(r.completa, true)
    assert.match(r.razon, /borrado\.js, que ya no existe/)
  })
})

describe('parsearResumen y clasificar', () => {
  test('lee la última línea «<check>: N bloqueantes, M avisos»', () => {
    assert.deepEqual(parsearResumen('x\ncheck-enlaces: 0 bloqueantes, 3 avisos\n'), { bloqueantes: 0, avisos: 3 })
    assert.deepEqual(parsearResumen('check-x: 1 bloqueante, 1 aviso'), { bloqueantes: 1, avisos: 1 })
    assert.equal(parsearResumen('sin resumen'), null)
  })

  test('un check bloqueante: exit 1 es FALLA, exit 0 con avisos es aviso, exit 2 es FALLA', () => {
    const paso = {}
    assert.equal(clasificar(paso, { status: 0, salida: 'c: 0 bloqueantes, 0 avisos' }), 'OK')
    assert.equal(clasificar(paso, { status: 0, salida: 'c: 0 bloqueantes, 2 avisos' }), 'aviso')
    assert.equal(clasificar(paso, { status: 1, salida: 'c: 1 bloqueantes, 0 avisos' }), 'FALLA')
    assert.equal(clasificar(paso, { status: 2, salida: 'uso' }), 'FALLA')
    assert.equal(clasificar(paso, { status: null, error: new Error('x'), salida: '' }), 'FALLA')
  })

  test('un paso que avisa nunca frena por sus bloqueantes, pero sí por un error de uso', () => {
    const paso = { avisa: true }
    assert.equal(clasificar(paso, { status: 1, salida: 'c: 5 bloqueantes, 0 avisos' }), 'aviso')
    assert.equal(clasificar(paso, { status: 0, salida: 'c: 0 bloqueantes, 0 avisos' }), 'OK')
    assert.equal(clasificar(paso, { status: 2, salida: 'uso' }), 'FALLA')
  })

  test('un proceso sin resumen (eslint, node --test) se juzga por su exit', () => {
    assert.equal(clasificar({}, { status: 0, salida: '' }), 'OK')
    assert.equal(clasificar({}, { status: 1, salida: '' }), 'FALLA')
  })
})

describe('armarPasos', () => {
  const sel = { completa: false, razon: '', tests: ['test/a.test.mjs'], siempre: [], sinTest: [] }
  const aplican = (cambiados, extra = {}) => armarPasos({ cambiados, base: 'abc', seleccion: sel, sinTests: false, sinLint: false, ...extra })
    .filter(p => p.aplica).map(p => p.nombre)

  test('cada paso aplica sólo si hay archivos de su tipo', () => {
    assert.deepEqual(aplican(['src/render/X.js']), ['eslint', 'enlaces', 'refs de sección', 'comentarios', 'tests'])
    assert.deepEqual(aplican(['docs/guia.md']), ['redacción', 'enlaces', 'refs de sección', 'tests'])
    assert.deepEqual(aplican(['scripts/test-corto.mjs']), ['eslint', 'tests'])
    assert.deepEqual(aplican(['scripts/test-corto.mjs'], { lintCubreScripts: false }), ['tests'])
    assert.deepEqual(aplican(['CHANGELOG.md']), ['redacción', 'enlaces', 'refs de sección', 'tests'])
    assert.deepEqual(aplican(['types/core.d.ts']), ['enlaces', 'refs de sección', 'tests'])
    assert.deepEqual(aplican(['LICENSE']), ['tests'])
  })

  test('--sin-tests y --sin-lint quitan sus pasos; la suite entera pasa los globs de npm test', () => {
    assert.deepEqual(aplican(['src/x.js'], { sinTests: true, sinLint: true }), ['enlaces', 'refs de sección', 'comentarios'])
    const entera = armarPasos({ cambiados: ['package.json'], base: 'abc', seleccion: { ...sel, completa: true }, sinTests: false, sinLint: false })
    assert.deepEqual(entera.find(p => p.tests).argv.slice(2), ['test/**/*.test.mjs', 'react/test/**/*.test.mjs'])
  })

  test('check-comentarios recibe la base y la redacción los .md', () => {
    const pasos = armarPasos({ cambiados: ['src/x.js', 'docs/a.md', 'README.md'], base: 'abc123', seleccion: sel, sinTests: false, sinLint: false })
    assert.deepEqual(pasos.find(p => p.nombre === 'comentarios').argv, ['scripts/check-comentarios.mjs', '--base=abc123'])
    assert.deepEqual(pasos.find(p => p.nombre === 'redacción').argv, ['scripts/check-redaccion.mjs', 'docs/a.md', 'README.md'])
  })
})

describe('git', { skip: !hayGit }, () => {
  const git = (raiz, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: raiz, encoding: 'utf8' })

  /** Un repo con BASE commiteado, el script copiado y una rama con un commit propio. */
  const repo = () => {
    const raiz = paquete({ ...BASE, 'scripts/.gitkeep': '' })
    cpSync(SCRIPT, join(raiz, 'scripts/test-corto.mjs'))
    git(raiz, 'init', '-q', '-b', 'main')
    git(raiz, 'add', '-A')
    git(raiz, 'commit', '-q', '-m', 'base')
    git(raiz, 'checkout', '-q', '-b', 'rama')
    return raiz
  }

  test('sin --push entran lo sin commitear y lo nuevo; con --push, sólo los commits', () => {
    const raiz = repo()
    writeFileSync(join(raiz, 'src/solo.js'), 'export const solo = 2\n')
    git(raiz, 'commit', '-q', '-am', 'toca solo')
    writeFileSync(join(raiz, 'src/data/store.js'), 'export const store = 2\n')
    writeFileSync(join(raiz, 'src/nuevo.js'), 'export {}\n')
    const base = mergeBase(raiz, 'main')
    assert.deepEqual(listaCambios({ raiz, base, push: false }).cambiados, ['src/data/store.js', 'src/nuevo.js', 'src/solo.js'])
    assert.deepEqual(listaCambios({ raiz, base, push: true }).cambiados, ['src/solo.js'])
  })

  test('un archivo borrado va a eliminados, y un renombre cuenta como alta más baja', () => {
    const raiz = repo()
    git(raiz, 'rm', '-q', 'src/solo.js')
    git(raiz, 'mv', 'test/d.test.mjs', 'test/d2.test.mjs')
    const r = listaCambios({ raiz, base: mergeBase(raiz, 'main'), push: false })
    assert.deepEqual(r.cambiados, ['test/d2.test.mjs'])
    assert.deepEqual(r.eliminados, ['src/solo.js', 'test/d.test.mjs'])
  })

  test('el CLI de punta a punta lista la selección sin correr nada', () => {
    const raiz = repo()
    writeFileSync(join(raiz, 'test-helpers/stub.mjs'), 'export const stub = 2\n')
    const r = spawnSync(process.execPath, ['scripts/test-corto.mjs', '--solo-seleccion', '--base=main'], { cwd: raiz, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /tests elegidos: 1 de 4/)
    assert.match(r.stdout, /^ {2}test\/a\.test\.mjs$/m)
  })

  test('--head elige los archivos de esa punta, no los del HEAD del árbol de trabajo', () => {
    const raiz = repo()
    git(raiz, 'checkout', '-q', '-b', 'otra', 'main')
    writeFileSync(join(raiz, 'src/solo.js'), 'export const solo = 3\n')
    git(raiz, 'commit', '-q', '-am', 'toca solo en otra')
    git(raiz, 'checkout', '-q', 'rama')
    writeFileSync(join(raiz, 'src/data/store.js'), 'export const store = 2\n')
    git(raiz, 'commit', '-q', '-am', 'toca store en rama')
    const correr = (...a) => spawnSync(process.execPath, ['scripts/test-corto.mjs', '--solo-seleccion', '--push', '--base=main', ...a], { cwd: raiz, encoding: 'utf8' })
    assert.match(correr().stdout, /1 archivo\(s\)/)
    assert.match(correr().stdout, /test\/a\.test\.mjs/)
    const otra = correr('--head=otra')
    assert.equal(otra.status, 0, otra.stderr)
    assert.match(otra.stdout, /aviso: --head no es el HEAD/)
    assert.match(otra.stdout, /tests elegidos: 0 de 4/)
    assert.equal(spawnSync(process.execPath, ['scripts/test-corto.mjs', '--head=otra'], { cwd: raiz }).status, 2)
    assert.equal(correr('--head=no-existe').status, 2)
  })

  test('un export borrado, importado por el nombre del paquete, manda a la suite entera', () => {
    const raiz = repo()
    git(raiz, 'rm', '-q', 'src/geometry/index.js')
    const r = spawnSync(process.execPath, ['scripts/test-corto.mjs', '--solo-seleccion', '--base=main'], { cwd: raiz, encoding: 'utf8' })
    assert.match(r.stdout, /suite entera \(test\/b\.test\.mjs importa cristae\/geometry, que ya no existe\)/)
  })

  test('sin git en el PATH el mensaje dice que falta git, no que falta la base', () => {
    const raiz = repo()
    const r = spawnSync(process.execPath, ['scripts/test-corto.mjs'], { cwd: raiz, encoding: 'utf8', env: { ...process.env, PATH: dirname(process.execPath) } })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /No se encuentra git/)
  })

  test('un argumento desconocido y una base inexistente salen con 2', () => {
    const raiz = repo()
    assert.equal(spawnSync(process.execPath, ['scripts/test-corto.mjs', '--nada'], { cwd: raiz }).status, 2)
    assert.equal(spawnSync(process.execPath, ['scripts/test-corto.mjs', '--base=no-existe'], { cwd: raiz }).status, 2)
  })

  test('sin tests que correr ni scripts a invocar, el CLI termina en verde; un script ausente se reporta como falta', () => {
    const raiz = repo()
    mkdirSync(join(raiz, 'docs'))
    writeFileSync(join(raiz, 'docs/guia.md'), '# guia\n')
    const r = spawnSync(process.execPath, ['scripts/test-corto.mjs', '--base=main', '--sin-tests'], { cwd: raiz, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /falta {2}redacción · falta el script check-redaccion\.mjs/)
    assert.match(r.stdout, /test-corto: en verde/)
  })
})
