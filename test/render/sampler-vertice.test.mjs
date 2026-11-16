// Todo sampler que lee un vertex shader declara `highp`. En GLSL ES 3.00 el sampler del vértice es `lowp` por
// defecto y `precision highp float;` no lo cambia: un driver que lo respeta devuelve el texel con mantisa de half,
// y una posición rel-ancla de 0,37 world0 se corre 34 px a z18 (medido en una RTX por ANGLE sobre GL ES).
//
// La prueba lee el texto: arma cada fuente de vértice de `src/` (un literal con `gl_Position`, más los literales
// del mismo archivo que interpola) y exige el calificador en cada sampler, en línea o por un `precision highp` del
// mismo tipo que lo preceda. Los de fragmento quedan fuera.
// Corre con: node --test test/render/sampler-vertice.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = fileURLToPath(new URL('../../', import.meta.url))
const SRC  = join(RAIZ, 'src')

const archivos = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? archivos(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : [])

// Los literales de plantilla de un fuente JS, con la línea de código que los abre. Salta comentarios y cadenas
// fuera de los literales; dentro, sólo sigue los `${…}` para no cortar en una llave de GLSL.
const literales = texto => {
  const out = []
  let i = 0
  const saltarCadena = q => { for (i++; i < texto.length && texto[i] !== q; i++) if (texto[i] === '\\') i++; i++ }
  const leerLiteral = () => {
    const inicio = i++
    let cuerpo = ''
    while (i < texto.length && texto[i] !== '`') {
      if (texto[i] === '\\') { cuerpo += texto.slice(i, i + 2); i += 2; continue }
      if (texto[i] === '$' && texto[i + 1] === '{') {
        let prof = 1, j = i + 2
        while (j < texto.length && prof) { if (texto[j] === '{') prof++; else if (texto[j] === '}') prof--; j++ }
        cuerpo += texto.slice(i, j); i = j; continue
      }
      cuerpo += texto[i++]
    }
    i++
    const linea = texto.slice(texto.lastIndexOf('\n', inicio) + 1, inicio)
    out.push({ linea, cuerpo })
  }
  while (i < texto.length) {
    const c = texto[i]
    if (c === '/' && texto[i + 1] === '/') i = texto.indexOf('\n', i) < 0 ? texto.length : texto.indexOf('\n', i)
    else if (c === '/' && texto[i + 1] === '*') i = texto.indexOf('*/', i) + 2
    else if (c === '"' || c === "'") saltarCadena(c)
    else if (c === '`') leerLiteral()
    else i++
  }
  return out
}

const SAMPLER = /uniform\s+(?:(lowp|mediump|highp)\s+)?((?:[iu])?sampler\w+)\s+(\w+)\s*;/g

// Cada fuente de vértice con sus samplers ya resueltos contra los `${NOMBRE}` del mismo archivo.
const vertices = () => {
  const out = []
  for (const archivo of archivos(SRC)) {
    const lits = literales(readFileSync(archivo, 'utf8'))
    const porNombre = new Map()
    for (const l of lits) {
      const m = l.linea.match(/(?:const|let)\s+(\w+)\s*=\s*(?:\([^)]*\)\s*=>|\w+\s*=>)?\s*$/)
      if (m) porNombre.set(m[1], l.cuerpo)
    }
    const expandir = (cuerpo, vistos = new Set()) => cuerpo.replace(/\$\{\s*(\w+)[^}]*\}/g, (todo, n) =>
      porNombre.has(n) && !vistos.has(n) ? expandir(porNombre.get(n), new Set([...vistos, n])) : todo)
    for (const l of lits) {
      if (!l.cuerpo.includes('gl_Position')) continue
      const fuente = expandir(l.cuerpo)
      const nombre = l.linea.match(/(?:const|let)\s+(\w+)/)?.[1] ?? l.linea.trim()
      out.push({ archivo: relative(RAIZ, archivo), nombre, fuente })
    }
  }
  return out
}

const sinHighp = ({ fuente }) => [...fuente.matchAll(SAMPLER)].filter(m => {
  if (m[1] === 'highp') return false
  if (m[1]) return true
  const antes = fuente.slice(0, m.index)
  return !new RegExp(`precision\\s+highp\\s+${m[2]}\\s*;`).test(antes)
}).map(m => m[3])

test('cada sampler de un vertex shader es highp', () => {
  const faltan = vertices().flatMap(v => sinHighp(v).map(s => `${v.archivo} ${v.nombre}: ${s}`))
  assert.deepEqual(faltan, [])
})

test('la búsqueda ve los samplers de vértice que existen', () => {
  const vistos = new Set(vertices().flatMap(v => [...v.fuente.matchAll(SAMPLER)].map(m => `${v.archivo}:${m[3]}`)))
  for (const esperado of ['src/render/StrokePass.js:positions', 'src/render/StrokePass.js:arcs', 'src/render/StrokePass.js:colors',
    'src/render/EditStrokeLayer.js:positions', 'src/render/EditFillLayer.js:uPos', 'src/render/LabelGl.js:u_meta'])
    assert.ok(vistos.has(esperado), esperado)
})

test('un sampler sin calificador en un vértice se detecta, y uno de fragmento no cuenta', () => {
  const v = { fuente: 'precision highp float;\nuniform sampler2D a;\nuniform highp sampler2D b;\nvoid main() { gl_Position = vec4(0.0); }' }
  assert.deepEqual(sinHighp(v), ['a'])
  assert.deepEqual(sinHighp({ fuente: 'precision highp sampler2D;\nuniform sampler2D a;\nuniform usampler2D c;' }), ['c'])
  assert.deepEqual(sinHighp({ fuente: 'uniform sampler2D a;\nprecision highp sampler2D;' }), ['a'])
  const lits = literales('const A = `uniform sampler2D x;`\n// `no`\nconst V = s => `${A}\ngl_Position ${s}`')
  assert.deepEqual(lits.map(l => l.cuerpo), ['uniform sampler2D x;', '${A}\ngl_Position ${s}'])
})
