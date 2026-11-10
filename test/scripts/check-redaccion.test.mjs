import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { desglosar, enAlcance, lineasDe, listarAlcance, oraciones, revisar } from '../../scripts/check-redaccion.mjs'

const SCRIPT  = resolve(import.meta.dirname, '../../scripts/check-redaccion.mjs')
const hayGit  = spawnSync('git', ['--version']).status === 0
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const temporales = []

// Un paquete de juguete: el script se copia a su scripts/ porque resuelve la raíz desde su propia ubicación.
function paquete(archivos) {
  const raiz = mkdtempSync(join(tmpdir(), 'redaccion-'))
  temporales.push(raiz)
  mkdirSync(join(raiz, 'scripts'))
  copyFileSync(SCRIPT, join(raiz, 'scripts/check-redaccion.mjs'))
  for (const [ruta, texto] of Object.entries(archivos)) {
    mkdirSync(dirname(join(raiz, ruta)), { recursive: true })
    writeFileSync(join(raiz, ruta), texto)
  }
  return raiz
}
const correr = (raiz, ...args) => spawnSync('node', ['scripts/check-redaccion.mjs', ...args], { cwd: raiz, encoding: 'utf8', env: GIT_ENV })
const git    = (raiz, ...a) => spawnSync('git', a, { cwd: raiz, encoding: 'utf8', env: GIT_ENV })
const ids    = texto => revisar(texto).map(h => h.r.id)

after(() => temporales.forEach(d => rmSync(d, { recursive: true, force: true })))

describe('alcance', () => {
  test('README, AGENTS, SKILL y docs/**/*.md; sin CHANGELOG ni notas', () => {
    for (const f of ['README.md', 'AGENTS.md', 'SKILL.md', 'docs/a.md', 'docs/x/y/b.md']) assert.ok(enAlcance(f), f)
    for (const f of ['CHANGELOG.md', 'SPECS.md', 'notas/a.md', 'docs/a.txt', 'src/README.md', 'docs/node_modules/a.md']) assert.ok(!enAlcance(f), f)
  })

  test('listarAlcance recorre el disco y salta node_modules, dist y notas', () => {
    const raiz = paquete({ 'README.md': 'x', 'CHANGELOG.md': 'x', 'docs/a.md': 'x', 'docs/dist/b.md': 'x', 'docs/sub/c.md': 'x', 'notas/d.md': 'x', 'node_modules/e/README.md': 'x' })
    assert.deepEqual(listarAlcance(raiz), ['README.md', 'docs/a.md', 'docs/sub/c.md'])
  })
})

describe('reglas', () => {
  test('inciso entre rayas bloquea', () => {
    const [h] = revisar('El motor — que es rápido — dibuja.')
    assert.equal(h.r.id, 'acotación')
    assert.ok(h.r.bloquea)
  })

  test('una sola raya no es inciso', () => assert.deepEqual(ids('Pasa algo — y sigue.'), []))

  test('«es decir» y «o sea» bloquean; «sólo» ya no es regla', () => {
    assert.deepEqual(ids('Es un mapa, es decir un lienzo.'), ['conector'])
    assert.deepEqual(ids('Vale 3, o sea poco.'), ['conector'])
    assert.deepEqual(ids('Sólo se usa en este caso, únicamente aquí.'), [])
  })

  test('dos o más punto y coma bloquean, uno no', () => {
    assert.deepEqual(ids('a; b; c'), ['punto y coma'])
    assert.deepEqual(ids('a; b'), [])
  })

  test('punto y coma se cuenta sobre el párrafo partido en líneas', () => {
    assert.deepEqual(ids('- uno;\n  dos;\n  tres'), ['punto y coma'])
  })

  test('emoji con negrita bloquea; emoji solo avisa', () => {
    const [a] = revisar('**Ojo** ⚠️ cuidado')
    assert.equal(a.r.id, 'doble énfasis')
    assert.ok(a.r.bloquea)
    const [b] = revisar('Cuidado ⚠️ aquí')
    assert.equal(b.r.id, 'énfasis')
    assert.ok(!b.r.bloquea)
  })

  test('largo avisa sobre 400 caracteres visibles, no antes', () => {
    assert.deepEqual(ids(`${'a'.repeat(400)}`), [])
    const [h] = revisar('a'.repeat(401))
    assert.equal(h.r.id, 'largo')
    assert.ok(!h.r.bloquea)
  })

  test('largo mide lo que se lee: el code span cuenta como una letra y el enlace como su texto', () => {
    assert.deepEqual(ids(`\`${'a'.repeat(500)}\` texto`), [])
    assert.deepEqual(ids(`[t](${'u'.repeat(500)}) texto`), [])
  })

  test('tres oraciones avisan, dos no', () => {
    assert.equal(oraciones('Uno. Dos. Tres.'), 3)
    assert.deepEqual(ids('Uno. Dos.'), [])
    const [h] = revisar('Uno. Dos. Tres.')
    assert.equal(h.r.id, 'oraciones')
    assert.ok(!h.r.bloquea)
  })

  test('un punto dentro de un code span no cuenta como oración', () => {
    assert.deepEqual(ids('Se usa `a. B. C.` aquí.'), [])
  })

  test('ignora bloques de código, code spans y front matter', () => {
    assert.deepEqual(ids('```\na; b; c — x — y es decir\n```'), [])
    assert.deepEqual(ids('Mira `a — b — c` y `es decir`.'), [])
    assert.deepEqual(ids('---\ntitulo: a; b; c\n---\nTexto.'), [])
  })

  test('títulos y celdas de tabla se miran por separado', () => {
    assert.deepEqual(ids('# Un — inciso — aquí'), ['acotación'])
    assert.deepEqual(ids('| a | es decir b |\n| --- | --- |'), ['conector'])
  })

  test('el numeral de la línea es el del archivo', () => {
    assert.equal(revisar('ok\n\nVa es decir así').find(h => h.r.id === 'conector').n, 3)
  })
})

describe('modo diff, sin git', () => {
  test('lineasDe lee las líneas agregadas de un diff -U0 y filtra por alcance', () => {
    const diff = 'diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1,0 +5,2 @@\n+x\n+y\n@@ -9 +12 @@\n+z\n+++ b/src/x.js\n@@ -1 +1 @@\n+w'
    const r = lineasDe(diff)
    assert.deepEqual([...r.get('docs/a.md')], [5, 6, 12])
    assert.ok(!r.has('src/x.js'))
  })

  test('un párrafo tocado a medias baja sus bloqueantes a aviso', () => {
    const hs = revisar('Primera línea;\nsegunda; tercera;', new Set([2]))
    const h = hs.find(x => x.r.id === 'punto y coma')
    assert.ok(h && !h.r.bloquea)
    assert.match(h.r.regla, /heredado/)
  })

  test('sólo se miden las líneas indicadas', () => {
    assert.deepEqual(revisar('Va es decir así\n\nok', new Set([3])), [])
  })

  test('desglosar cuenta por regla y severidad', () => {
    const m = new Map([['a.md', revisar('a; b; c\n\nUno. Dos. Tres.\n\nx — y — z')]])
    const d = Object.fromEntries(desglosar(m).map(x => [`${x.regla}/${x.severidad}`, x.total]))
    assert.deepEqual(d, { 'punto y coma/bloqueante': 1, 'oraciones/aviso': 1, 'acotación/bloqueante': 1 })
  })
})

describe('vallas y rarezas', () => {
  test('una valla de otra marca dentro de un bloque no lo cierra', () => {
    assert.deepEqual(ids('~~~\n```\n~~~\n\nOtra, o sea, mala.\n'), ['conector'])
    assert.deepEqual(ids('````\n```\nViejo es decir mal.\n````\n'), [])
    assert.deepEqual(ids('~~~\n```\n    ```\no sea\n~~~\n'), [])
  })

  test('las entidades HTML y los destinos de enlace no cuentan como punto y coma', () => {
    assert.deepEqual(ids('Usar &lt;div&gt; y &amp; algo.\n'), [])
    assert.deepEqual(ids('[x](y;z;w)\n'), [])
    assert.deepEqual(ids('uno; dos; tres\n'), ['punto y coma'])
  })
})

describe('CLI', () => {
  const sucio = 'Un mapa, es decir un lienzo.\n'

  test('sin archivos mide el alcance completo y exit 0 aunque haya bloqueantes', () => {
    const raiz = paquete({ 'README.md': sucio, 'docs/a.md': sucio, 'CHANGELOG.md': sucio })
    const r = correrOk(raiz)
    assert.match(r.stdout, /README\.md/)
    assert.match(r.stdout, /docs\/a\.md/)
    assert.doesNotMatch(r.stdout, /CHANGELOG/)
    assert.match(r.stdout, /check-redaccion: 2 bloqueantes, 0 avisos\n$/)
  })

  test('--todo equivale al alcance completo', () => {
    const raiz = paquete({ 'README.md': sucio })
    assert.match(correrOk(raiz, '--todo').stdout, /1 bloqueantes, 0 avisos/)
  })

  test('--estricto da exit 1 sólo con bloqueantes', () => {
    const raiz = paquete({ 'README.md': sucio })
    assert.equal(correr(raiz, '--estricto').status, 1)
    const limpia = paquete({ 'README.md': 'Texto sano.\n' })
    assert.equal(correr(limpia, '--estricto').status, 0)
    const aviso = paquete({ 'README.md': 'Uno. Dos. Tres.\n' })
    const r = correr(aviso, '--estricto')
    assert.equal(r.status, 0)
    assert.match(r.stdout, /0 bloqueantes, 1 avisos/)
  })

  test('con archivos mide sólo esos y ignora en silencio los fuera de alcance', () => {
    const raiz = paquete({ 'README.md': sucio, 'docs/a.md': sucio, 'CHANGELOG.md': sucio })
    const r = correrOk(raiz, 'docs/a.md', 'CHANGELOG.md')
    assert.match(r.stdout, /1 bloqueantes/)
    assert.doesNotMatch(r.stdout, /README/)
  })

  test('--desglose agrega el conteo y deja el resumen como última línea', () => {
    const raiz = paquete({ 'README.md': sucio })
    const r = correrOk(raiz, '--desglose')
    assert.match(r.stdout, /desglose por regla:\n\s+1 {2}conector \(bloqueante\)/)
    assert.match(r.stdout.trimEnd().split('\n').at(-1), /^check-redaccion: 1 bloqueantes, 0 avisos$/)
  })

  test('--resumen deja el desglose y la última línea, sin los hallazgos', () => {
    const raiz = paquete({ 'README.md': sucio })
    const r = correrOk(raiz, '--todo', '--resumen')
    assert.match(r.stdout, /desglose por regla:/)
    assert.doesNotMatch(r.stdout, /README\.md|bloqueante \d/)
    assert.match(r.stdout.trimEnd().split('\n').at(-1), /^check-redaccion: 1 bloqueantes, 0 avisos$/)
  })

  test('errores de uso salen 2', () => {
    const raiz = paquete({ 'README.md': 'x\n' })
    for (const args of [['--nada'], ['--base'], ['--todo', '--base=main'], ['docs/no-existe.md']]) {
      const r = correr(raiz, ...args)
      assert.equal(r.status, 2, args.join(' '))
      assert.match(r.stderr, /^check-redaccion: /)
    }
  })

  test('lo fuera del alcance se ignora en silencio, exista o no', () => {
    const raiz = paquete({ 'README.md': 'x\n', 'docs/a.md': 'x\n' })
    for (const arg of ['src/x.js', 'no-existe.md', 'docs', 'CHANGELOG.md']) {
      const r = correr(raiz, arg)
      assert.equal(r.status, 0, arg)
      assert.match(r.stdout, /0 bloqueantes, 0 avisos/)
    }
  })

  test('no necesita git: --todo funciona en un árbol sin .git', () => {
    const raiz = paquete({ 'README.md': sucio })
    assert.equal(correr(raiz, '--todo').status, 0)
  })
})

describe('--base', { skip: !hayGit }, () => {
  test('mide sólo lo que agrega el diff contra el merge-base', () => {
    const raiz = paquete({ 'docs/a.md': 'Viejo es decir mal.\n\nok\n', 'docs/b.md': 'limpio\n' })
    git(raiz, 'init', '-q', '-b', 'main')
    git(raiz, 'add', '.'); // scripts/ queda fuera del alcance, no importa
    git(raiz, 'commit', '-q', '-m', 'base')
    git(raiz, 'checkout', '-q', '-b', 'rama')
    writeFileSync(join(raiz, 'docs/a.md'), 'Viejo es decir mal.\n\nok\n\nNuevo o sea peor.\n')
    writeFileSync(join(raiz, 'docs/nuevo.md'), 'Otro es decir.\n')
    const r = correr(raiz, '--base=main')
    assert.equal(r.status, 0)
    assert.match(r.stdout, /docs\/a\.md\n\s+bloqueante 5 /)
    assert.match(r.stdout, /docs\/nuevo\.md/)
    assert.doesNotMatch(r.stdout, /Viejo/)
    assert.match(r.stdout, /2 bloqueantes, 0 avisos/)
    assert.equal(correr(raiz, '--base=main', '--estricto').status, 1)
  })

  test('una referencia inexistente sale 2', () => {
    const raiz = paquete({ 'docs/a.md': 'x\n' })
    git(raiz, 'init', '-q', '-b', 'main')
    const r = correr(raiz, '--base=no-existe')
    assert.equal(r.status, 2)
  })
})

function correrOk(raiz, ...args) {
  const r = correr(raiz, ...args)
  assert.equal(r.status, 0, r.stderr)
  return r
}
