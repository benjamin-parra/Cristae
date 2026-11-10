// check-refs-seccion: las citas «SPECS §N» y «MODELO §N» apuntan a encabezados que existen.
// Corre con: node --test test/scripts/check-refs-seccion.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { extraerCitas, numerosDeEncabezados, revisar, seccionesPorDocumento, seleccionar } from '../../scripts/check-refs-seccion.mjs'

const SCRIPT = join(import.meta.dirname, '../../scripts/check-refs-seccion.mjs')
const temporales = []
after(() => temporales.forEach((d) => rmSync(d, { recursive: true, force: true })))

const SPECS = '# SPECS\n\n## 1. Uno\n\n### 1.1 Sub\n\n## 20. Veinte\n\n### 20.15 Formato\n'
const MODELO = '# MODELO\n\n## 5. Datos\n\n### 5.4 Reactivo\n'

/** Paquete de mentira con SPECS y MODELO mínimos, más los archivos dados, y una copia del check en `scripts/`. */
function paquete(archivos = {}, base = { 'SPECS.md': SPECS, 'MODELO.md': MODELO }) {
  const raiz = mkdtempSync(join(tmpdir(), 'check-refs-'))
  temporales.push(raiz)
  for (const [ruta, contenido] of Object.entries({ ...base, ...archivos })) {
    mkdirSync(dirname(join(raiz, ruta)), { recursive: true })
    writeFileSync(join(raiz, ruta), contenido)
  }
  mkdirSync(join(raiz, 'scripts'))
  cpSync(SCRIPT, join(raiz, 'scripts/check-refs-seccion.mjs'))
  return raiz
}

const correr = (raiz, ...args) => spawnSync(process.execPath, [join(raiz, 'scripts/check-refs-seccion.mjs'), ...args], { cwd: raiz, encoding: 'utf8' })

describe('extraerCitas', () => {
  test('reconoce SPECS §N, SPECS.md §N y MODELO §N.M con su línea', () => {
    const t = '// ver SPECS §9\n// y SPECS.md §20, MODELO §17.3\n'
    assert.deepEqual(extraerCitas(t), [
      { documento: 'SPECS', seccion: '9', linea: 1 },
      { documento: 'SPECS', seccion: '20', linea: 2 },
      { documento: 'MODELO', seccion: '17.3', linea: 2 },
    ])
  })

  test('el punto final de una oración no es parte del número, ni el ítem que sigue a un guion', () => {
    assert.deepEqual(extraerCitas('(SPECS §8.6.) y (SPECS §20.15-7)').map((c) => c.seccion), ['8.6', '20.15'])
  })

  test('un § suelto o de otro documento no es una cita', () => {
    assert.deepEqual(extraerCitas('ver §4 y OTRO §3 y SPECS sin número'), [])
  })
})

describe('numerosDeEncabezados', () => {
  test('toma los encabezados numerados, con o sin punto, y deja los demás', () => {
    const t = '# Título\n\n## 1. Uno\n\n### 1.1 Sub\n\n## Sin número\n\n#### 2.3.4 Hondo\n'
    assert.deepEqual([...numerosDeEncabezados(t)], ['1', '1.1', '2.3.4'])
  })

  test('un encabezado dentro de un bloque de código no cuenta', () => {
    assert.deepEqual([...numerosDeEncabezados('```md\n## 7. Falso\n```\n\n## 8. Cierto\n')], ['8'])
  })

  test('un número que sólo aparece en prosa no es un encabezado', () => {
    assert.equal(numerosDeEncabezados('Ver la sección 3.\n\n- 4.1 item\n').size, 0)
  })
})

describe('revisar', () => {
  test('citas válidas: nada que reportar y las cuenta', () => {
    const raiz = paquete({ 'src/a.js': '// SPECS §1.1 y MODELO §5.4 y SPECS §20.15-7\n', 'README.md': 'SPECS §20\n' })
    const r = revisar(raiz)
    assert.equal(r.citas, 4)
    assert.deepEqual(r.hallazgos, [])
  })

  test('una sección inexistente se reporta con archivo y línea, y una de MODELO no se busca en SPECS', () => {
    const raiz = paquete({ 'src/a.js': '// ok SPECS §1\n// roto SPECS §99\n// cruzado MODELO §1\n' })
    const r = revisar(raiz)
    assert.deepEqual(r.hallazgos.map((h) => [h.archivo, h.linea, h.mensaje]), [
      ['src/a.js', 2, 'SPECS §99 no existe como encabezado'],
      ['src/a.js', 3, 'MODELO §1 no existe como encabezado'],
    ])
  })

  test('revisa src, react/src, types, docs, README, AGENTS y SKILL, y nada más', () => {
    const roto = '// SPECS §99\n'
    const raiz = paquete({
      'src/a.js': roto, 'react/src/b.jsx': roto, 'types/c.d.ts': roto, 'docs/d.md': roto,
      'README.md': roto, 'AGENTS.md': roto, 'SKILL.md': roto,
      'examples/e.js': roto, 'bench/f.js': roto, 'node_modules/x/g.js': roto, 'CHANGELOG.md': roto,
    })
    assert.deepEqual(revisar(raiz).hallazgos.map((h) => h.archivo).sort(),
      ['AGENTS.md', 'README.md', 'SKILL.md', 'docs/d.md', 'react/src/b.jsx', 'src/a.js', 'types/c.d.ts'])
  })

  test('encuentra las secciones en docs/contrato y docs/modelo.md además de SPECS.md y MODELO.md', () => {
    const raiz = paquete({
      'docs/contrato/nucleo.md': '## 30. Nuevo\n\n### 30.2 Más\n',
      'docs/modelo.md': '## 40. Nuevo\n',
      'src/a.js': '// SPECS §30.2 y MODELO §40 y SPECS §1 y MODELO §5\n',
    })
    assert.deepEqual(revisar(raiz).hallazgos, [])
    assert.deepEqual([...seccionesPorDocumento(raiz).SPECS].sort(), ['1', '1.1', '20', '20.15', '30', '30.2'])
  })

  test('sin SPECS.md ni MODELO.md no revienta: toda cita falta', () => {
    const raiz = paquete({ 'src/a.js': '// SPECS §1\n' }, {})
    assert.equal(revisar(raiz).hallazgos.length, 1)
  })

  test('con una lista de archivos revisa sólo esos', () => {
    const raiz = paquete({ 'src/a.js': '// SPECS §99\n', 'src/b.js': '// SPECS §1\n' })
    const r = revisar(raiz, ['src/b.js'])
    assert.equal(r.citas, 1)
    assert.deepEqual(r.hallazgos, [])
  })
})

describe('seleccionar', () => {
  test('descarta lo que no está en el alcance, relativo al cwd', () => {
    const raiz = paquete({ 'src/a.js': '', 'examples/e.js': '' })
    assert.deepEqual(seleccionar(['a.js', '../examples/e.js', 'no.js'], raiz, join(raiz, 'src')), ['src/a.js'])
  })

  test('si entre los archivos hay uno que define encabezados, pide revisar todo', () => {
    const raiz = paquete({ 'src/a.js': '' })
    assert.equal(seleccionar(['src/a.js', 'SPECS.md'], raiz, raiz), null)
    assert.equal(seleccionar(['docs/contrato/x.md'], raiz, raiz), null)
    assert.equal(seleccionar(['docs/modelo.md'], raiz, raiz), null)
  })
})

describe('CLI', () => {
  test('todo en orden: exit 0, citas revisadas y última línea con los conteos', () => {
    const r = correr(paquete({ 'src/a.js': '// SPECS §1 y MODELO §5.4\n' }))
    assert.equal(r.status, 0)
    const lineas = r.stdout.trim().split('\n')
    assert.equal(lineas.at(-2), '2 citas revisadas en 1 archivos')
    assert.equal(lineas.at(-1), 'check-refs-seccion: 0 bloqueantes, 0 avisos')
  })

  test('una cita rota: exit 1 con archivo, línea y regla', () => {
    const r = correr(paquete({ 'src/a.js': '\n// SPECS §99\n' }))
    assert.equal(r.status, 1)
    assert.match(r.stdout, /src\/a\.js\n\s+2\s+bloqueante\s+seccion-inexistente: SPECS §99/)
    assert.equal(r.stdout.trim().split('\n').at(-1), 'check-refs-seccion: 1 bloqueantes, 0 avisos')
  })

  test('con archivos fuera del alcance: nada que revisar, exit 0', () => {
    const r = correr(paquete({ 'examples/e.js': '// SPECS §99\n' }), 'examples/e.js', 'no-existe.js')
    assert.equal(r.status, 0)
    assert.match(r.stdout, /^0 citas revisadas en 0 archivos/)
  })

  test('tocar SPECS.md revisa todo y encuentra las citas que quedaron colgando', () => {
    const r = correr(paquete({ 'src/a.js': '// SPECS §99\n' }), 'SPECS.md')
    assert.equal(r.status, 1)
  })

  test('una opción desconocida es error de uso: exit 2', () => {
    assert.equal(correr(paquete(), '--nada').status, 2)
  })
})
