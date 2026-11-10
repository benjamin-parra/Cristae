// Prueba de humo del diagnóstico: las medidas sobre un texto armado y que el árbol real se recorre sin frenar.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { analizarTexto, moduloDe, porModulo } from '../../scripts/diagnostico-comentarios.mjs'

const comentario = n => Array.from({ length: n }, (_, i) => `// línea ${i}`).join('\n')

test('moduloDe: carpeta de primer nivel bajo src, react aparte y lo suelto en la raíz', () => {
  assert.equal(moduloDe('src/render/PointLayer.js'), 'render')
  assert.equal(moduloDe('src/index.js'), '(raíz)')
  assert.equal(moduloDe('react/src/index.js'), 'react')
})

test('analizarTexto: cabecera de más de 8 líneas, línea larga y bloque de 12', () => {
  const texto = `${comentario(9)}\nimport { a } from './a.js'\n\nconst x = 1\n// ${'x'.repeat(120)}\nconst y = 2\n${comentario(12)}\nconst z = 3\n`
  const m = analizarTexto(texto)
  assert.equal(m.cabecera, 9)
  assert.equal(m.largas, 1)
  assert.equal(m.bloques, 1)
})

test('analizarTexto: la cabecera también cuenta después de los imports', () => {
  assert.equal(analizarTexto(`import { a } from './a.js'\n\n${comentario(10)}\nconst x = 1\n`).cabecera, 10)
})

test('analizarTexto: un bloque con @typedef de grammar es contrato, no deuda', () => {
  const texto = `/**\n * @typedef {object} T\n${' * campo\n'.repeat(12)} */\nconst x = 1\n`
  const sin = analizarTexto(texto, { esGrammar: false })
  const con = analizarTexto(texto, { esGrammar: true })
  assert.equal(sin.bloques, 1)
  assert.equal(con.bloques, 0)
  assert.equal(con.bloquesContrato, 1)
})

test('porModulo: agrupa y ordena por hallazgos', () => {
  const fila = (modulo, cabecera, largas) => ({ modulo, lineas: 10, comentario: 2, cabecera, largas, bloques: 0 })
  const r = porModulo([fila('a', 0, 1), fila('b', 9, 5), fila('a', 0, 0)])
  assert.deepEqual(r.map(m => [m.modulo, m.archivos, m.cabeceras, m.largas]), [['b', 1, 1, 5], ['a', 2, 0, 1]])
})

test('el diagnóstico completo corre sobre el árbol real y sale 0', () => {
  const r = spawnSync('node', ['scripts/diagnostico-comentarios.mjs'], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /^archivos \d+/)
  assert.match(r.stdout, /contrato público/)
})
