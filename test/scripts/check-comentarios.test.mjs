// check-comentarios: las reglas puras y, con git de verdad, el recorrido de punta a punta sobre un repo temporal.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enAlcance, formatear, parsearArgs, parsearDiff, proporcion, revisarLineas } from '../../scripts/check-comentarios.mjs'

// La imagen del CI no trae git: las pruebas que lo usan se saltan ahí.
const hayGit = spawnSync('git', ['--version']).status === 0
const todas = L => new Set(L.map((_, i) => i + 1))
const reglas = (...L) => revisarLineas(L, todas(L)).map(h => h.regla)

test('enAlcance: src, react/src y scripts, sólo .js/.mjs/.ts/.tsx y nunca .d.ts', () => {
  assert.ok(enAlcance('src/table/index.js'))
  assert.ok(enAlcance('react/src/index.js'))
  assert.ok(enAlcance('scripts/check-comentarios.mjs'))
  assert.ok(!enAlcance('types/core.d.ts'))
  assert.ok(!enAlcance('src/x.d.ts'))
  assert.ok(!enAlcance('docs/guia.md'))
  assert.ok(!enAlcance('test/a.test.mjs'))
  assert.ok(!enAlcance('src/node_modules/x/index.js'))
})

test('parsearDiff: números de línea del archivo nuevo, sin los archivos fuera de alcance', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js',
    '@@ -3,0 +4,2 @@ x', '+uno', '+dos',
    '@@ -10 +12 @@', '-viejo', '+nuevo',
    'diff --git a/README.md b/README.md', '--- a/README.md', '+++ b/README.md', '@@ -1 +1 @@', '+x',
    'diff --git a/src/b.js b/src/b.js', '--- a/src/b.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-borrada',
  ].join('\n')
  const p = parsearDiff(diff)
  assert.deepEqual([...p.keys()], ['src/a.js'])
  assert.deepEqual([...p.get('src/a.js')], [4, 5, 12])
})

test('parsearDiff: la ruta con espacios que git cierra con un TAB sigue en alcance', () => {
  const diff = ['diff --git a/src/con espacio/x.js b/src/con espacio/x.js', '--- a/src/con espacio/x.js\t', '+++ b/src/con espacio/x.js\t', '@@ -0,0 +1 @@', '+// return 1'].join('\n')
  assert.deepEqual([...parsearDiff(diff).keys()], ['src/con espacio/x.js'])
})

test('parsearDiff: una línea agregada que parece cabecera no cambia de archivo', () => {
  const diff = ['diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js', '@@ -0,0 +1,2 @@', '+++ b/otro.js', '+x'].join('\n')
  assert.deepEqual([...parsearDiff(diff).get('src/a.js')], [1, 2])
})

test('separador y código comentado', () => {
  assert.deepEqual(reglas('// ======== sección ========'), ['separador'])
  assert.deepEqual(reglas('// const x = 1'), ['código comentado'])
  assert.deepEqual(reglas('// Un comentario normal sobre la restricción.', 'const x = 1'), [])
})

test('código comentado: un import de ejemplo en la cabecera se permite, en el cuerpo no', () => {
  const cabecera = ['// Entry point.', '//', "//   import 'cristae/table'", '', 'const a = 1', "// import { b } from './b.js'", 'const c = 2']
  const r = revisarLineas(cabecera, todas(cabecera))
  assert.deepEqual(r.map(h => [h.linea, h.regla]), [[6, 'código comentado']])
})

test('changelog: «antes» y «ya no» lógicos no son historia', () => {
  assert.deepEqual(reglas('// Se limpia antes de pintar, y ya no hay tiles bajo el zoom 4.', 'x()'), [])
  assert.deepEqual(reglas('// Revelar antes mostraría la vista anterior desubicada.', 'x()'), [])
  assert.deepEqual(reglas('// Antes no se rehace en esta pasada.', 'x()'), [])
})

test('changelog: con fecha, versión, «antes se» o el contraste antes/ahora sí', () => {
  assert.deepEqual(reglas('// Antes se retornaba sin aplicarlo.', 'x()'), ['changelog'])
  assert.deepEqual(reglas('// El radio ya no sale del estilo (v0.40).', 'x()'), ['changelog'])
  assert.deepEqual(reglas('// Desde el 06-11 ya no se cachea el atlas.', 'x()'), ['changelog'])
  assert.deepEqual(reglas('// Lo que antes recortaba el scissor ahora lo recorta el borde.', 'x()'), ['changelog'])
  assert.deepEqual(reglas('// Antes, el módulo 4π no se aplicaba.', 'x()'), ['changelog'])
  assert.deepEqual(reglas('// originalmente se cambió a Map en la v0.12.0.', 'x()'), ['changelog'])
})

test('repite la línea de abajo, salvo la continuación de un párrafo envuelto', () => {
  assert.deepEqual(reglas('// ordena los puntos', 'const puntosOrdenados = ordenar(puntos)'), ['repite la línea de abajo'])
  assert.deepEqual(reglas('// Los puntos llegan desordenados por el worker:', '// ordena los puntos', 'const puntosOrdenados = ordenar(puntos)').slice(1), [])
  assert.deepEqual(reglas('// El worker devuelve primero los lejanos por la cola de prioridad.', 'const x = f()'), [])
})

test('las reglas sólo miran las líneas agregadas', () => {
  const L = ['// ======== viejo ========', '// const x = 1', 'x()']
  assert.deepEqual(revisarLineas(L, new Set([3])), [])
  assert.equal(revisarLineas(L, new Set([1, 2])).length, 2)
})

test('proporción y formato de salida', () => {
  const L = ['// a', 'x()', '/** b */', 'y()']
  assert.deepEqual(proporcion(L, todas(L)), { comentario: 2, total: 4 })
  const salida = formatear(new Map([['src/a.js', [{ linea: 3, regla: 'separador', texto: '// ====' }]]]))
  assert.deepEqual(salida, ['src/a.js', '  3  separador\n      // ===='])
})

test('parsearArgs: base por defecto, --base=, --staged, archivos y opciones desconocidas', () => {
  assert.deepEqual(parsearArgs([]), { base: 'origin/main', staged: false, archivos: [] })
  assert.deepEqual(parsearArgs(['--base=v1', '--staged', 'src/a.js']), { base: 'v1', staged: true, archivos: ['src/a.js'] })
  assert.match(parsearArgs(['--base=']).error, /referencia/)
  assert.match(parsearArgs(['--rara']).error, /desconocida/)
})

// Recorrido real: el script se copia a un repo temporal porque su raíz es la de su propio paquete.
const conRepo = (nombre, cuerpo) => test(nombre, { skip: !hayGit }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-com-'))
  try {
    const git = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' })
    mkdirSync(join(dir, 'scripts'))
    mkdirSync(join(dir, 'src'))
    copyFileSync(new URL('../../scripts/check-comentarios.mjs', import.meta.url), join(dir, 'scripts/check-comentarios.mjs'))
    writeFileSync(join(dir, 'src/a.js'), '// Restricción que el código no dice.\nexport const a = 1\n')
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    const correr = (...a) => spawnSync('node', ['scripts/check-comentarios.mjs', ...a], { cwd: dir, encoding: 'utf8' })
    cuerpo({ dir, git, correr })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

conRepo('git: lo agregado desde la base frena, lo que ya estaba no, y sin base es error de uso', ({ dir, git, correr }) => {
  const limpio = correr('--base=main')
  assert.equal(limpio.status, 0)
  assert.match(limpio.stdout, /check-comentarios: 0 bloqueantes, 0 avisos\n$/)

  writeFileSync(join(dir, 'src/a.js'), '// ======== separador ========\n// Restricción que el código no dice.\nexport const a = 1\n')
  const sucio = correr('--base=main')
  assert.equal(sucio.status, 1)
  assert.match(sucio.stdout, /src\/a\.js\n {2}1 {2}separador/)
  assert.match(sucio.stdout, /check-comentarios: 1 bloqueantes, 0 avisos\n$/)

  assert.equal(correr('--base=main', 'src/otro.js', 'README.md').status, 0)   // fuera de alcance o sin cambios: se ignoran
  assert.equal(correr('--staged').status, 0)                                  // nada indexado todavía
  git('add', '.')
  assert.equal(correr('--staged').status, 1)
  git('commit', '-q', '-m', 'sube')
  assert.equal(correr('--base=main').status, 0)                               // HEAD es main: no queda nada por delante
  assert.equal(correr('--base=no-existe').status, 2)
  assert.match(correr('--base=no-existe').stderr, /no hay base/)
})

conRepo('git: un archivo nuevo sin indexar cuenta entero', ({ dir, correr }) => {
  writeFileSync(join(dir, 'src/nuevo.js'), '// const viejo = 1\nexport const b = 2\n')
  const r = correr('--base=main')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /src\/nuevo\.js\n {2}1 {2}código comentado/)
})

conRepo('git: un archivo renombrado sólo cobra lo agregado, pidan o no el archivo', ({ dir, git, correr }) => {
  const viejo = Array.from({ length: 6 }, (_, i) => `// const viejo${i} = 1\nexport const v${i} = ${i}\n`).join('')
  writeFileSync(join(dir, 'src/a.js'), viejo)
  git('add', '.')
  git('commit', '-q', '-m', 'más comentarios')
  git('mv', 'src/a.js', 'src/b.js')
  writeFileSync(join(dir, 'src/b.js'), `${viejo}// const q = 1\n`)
  git('add', '.')
  for (const args of [[], ['src/b.js']]) {
    const r = correr('--base=main', ...args)
    assert.match(r.stdout, /check-comentarios: 1 bloqueantes/, args.join(' '))
  }
})

test('fuera de un repo git: exit 2 con mensaje claro', { skip: !hayGit }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-com-sin-git-'))
  try {
    mkdirSync(join(dir, 'scripts'))
    copyFileSync(new URL('../../scripts/check-comentarios.mjs', import.meta.url), join(dir, 'scripts/check-comentarios.mjs'))
    const r = spawnSync('node', ['scripts/check-comentarios.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /necesita git/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
