// check-enlaces: anclas de GitHub, enlaces rotos y las reglas de estructura del árbol de docs.
// Corre con: node --test test/scripts/check-enlaces.test.mjs
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { anclaDe, anclasDe, enlacesDe, formatear, frontMatter, revisar, seleccionar, SEVERIDAD } from '../../scripts/check-enlaces.mjs'

const SCRIPT = join(import.meta.dirname, '../../scripts/check-enlaces.mjs')
const temporales = []
after(() => temporales.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** Crea un paquete de mentira con los archivos dados (`{ ruta: contenido }`) y un `scripts/` con una copia del check. */
function paquete(archivos) {
  const raiz = mkdtempSync(join(tmpdir(), 'check-enlaces-'))
  temporales.push(raiz)
  for (const [ruta, contenido] of Object.entries(archivos)) {
    mkdirSync(dirname(join(raiz, ruta)), { recursive: true })
    writeFileSync(join(raiz, ruta), contenido)
  }
  mkdirSync(join(raiz, 'scripts'))
  cpSync(SCRIPT, join(raiz, 'scripts/check-enlaces.mjs'))
  return raiz
}

const reglas = (hallazgos) => hallazgos.map((h) => h.regla).sort()
const correr = (raiz, ...args) => spawnSync(process.execPath, [join(raiz, 'scripts/check-enlaces.mjs'), ...args], { cwd: raiz, encoding: 'utf8' })

describe('anclas de GitHub', () => {
  test('minúsculas, sin signos salvo guion y guion bajo, espacios a guion', () => {
    assert.equal(anclaDe('Hola, Mundo: v1.2 (nuevo)'), 'hola-mundo-v12-nuevo')
    assert.equal(anclaDe('snake_case y kebab-case'), 'snake_case-y-kebab-case')
  })

  test('conserva tildes y eñe, y deja doble guion donde había una raya rodeada de espacios', () => {
    assert.equal(anclaDe('Geodésica — año'), 'geodésica--año')
  })

  test('el contenido de un code span se conserva, también si parece una etiqueta', () => {
    assert.equal(anclaDe('`<cristae-map>`'), 'cristae-map')
    assert.equal(anclaDe('`<cristae-labeled>` — rótulos'), 'cristae-labeled--rótulos')
  })

  test('fuera del código, énfasis, HTML y enlaces dan su texto', () => {
    assert.equal(anclaDe('**Negrita** y [un enlace](x.md) <b>html</b>'), 'negrita-y-un-enlace-html')
  })

  test('los duplicados llevan -1, -2 y los encabezados dentro de un bloque no cuentan', () => {
    const t = '# Uso\n\n## Uso\n\n## Uso\n\n```md\n# Falso\n```\n\n## Cierre ##\n'
    assert.deepEqual([...anclasDe(t)], ['uso', 'uso-1', 'uso-2', 'cierre'])
  })

  test('un ancla HTML explícita cuenta', () => {
    assert.ok(anclasDe('<a id="Manual"></a>\n\ntexto').has('manual'))
  })
})

describe('anclas: énfasis, setext y vallas sangradas', () => {
  test('el énfasis con guion bajo no llega al ancla, el snake_case sí', () => {
    assert.equal(anclaDe('Uso de _cache_'), 'uso-de-cache')
    assert.equal(anclaDe('Un ~~viejo~~ `snake_case` y snake_case'), 'un-viejo-snake_case-y-snake_case')
  })

  test('los encabezados setext generan ancla y respetan el orden de los duplicados', () => {
    const anclas = anclasDe('Heading setext\n--------------\n\n# Heading setext\n\nTítulo\nen dos líneas\n===\n')
    assert.deepEqual([...anclas], ['heading-setext', 'heading-setext-1', 'título-en-dos-líneas'])
  })

  test('el front-matter no subraya su última clave', () => {
    assert.deepEqual([...anclasDe('---\ntipo: x\n---\n\n# A\n')], ['a'])
  })

  test('una valla dentro de un ítem de lista con 4 espacios es código', () => {
    const texto = '1. paso\n\n    ```bash\n    # no es ancla\n    [roto](nada.md)\n    ```\n'
    assert.deepEqual(enlacesDe(texto), [])
    assert.deepEqual([...anclasDe(texto)], [])
  })
})

describe('enlacesDe', () => {
  test('ignora http, https, mailto y todo lo que lleva esquema', () => {
    const t = '[a](https://x.dev/a.md) [b](http://x) [c](mailto:a@b.c) [d](//cdn/x) [e](otro.md#s)'
    assert.deepEqual(enlacesDe(t).map((e) => e.destino), ['otro.md'])
  })

  test('ignora los enlaces dentro de código, en bloque o en línea', () => {
    const t = '`[a](a.md)` y\n\n```\n[b](b.md)\n```\n\n~~~\n[c](c.md)\n~~~\n\n[real](d.md)'
    assert.deepEqual(enlacesDe(t).map((e) => e.destino), ['d.md'])
  })

  test('separa ruta y ancla, y cuenta bien la línea', () => {
    assert.deepEqual(enlacesDe('uno\n\n[x](a.md#sec) [y](#aqui)'), [
      { linea: 3, destino: 'a.md', ancla: 'sec' },
      { linea: 3, destino: '', ancla: 'aqui' },
    ])
  })

  test('toma las definiciones de enlace por referencia', () => {
    assert.deepEqual(enlacesDe('[x][1]\n\n[1]: ./otro.md#a\n').map((e) => e.destino), ['./otro.md'])
  })
})

describe('frontMatter', () => {
  test('lee campos y devuelve null si no hay bloque', () => {
    assert.deepEqual(frontMatter('---\ntipo: transitorio\nmuere_con: v1\n---\n# T'), { tipo: 'transitorio', muere_con: 'v1' })
    assert.equal(frontMatter('# T\n'), null)
  })
})

describe('enlaces rotos (bloqueantes)', () => {
  test('un archivo inexistente y un ancla inexistente bloquean; uno bueno no', () => {
    const raiz = paquete({
      'README.md': '# Hola\n\n[bien](docs/a.md#titulo) [mal](docs/no.md) [ancla](docs/a.md#otro) [propia](#hola) [rota](#nada)\n',
      'docs/a.md': '# Titulo\n',
    })
    const h = revisar(raiz).filter((x) => x.severidad === 'bloqueante')
    assert.deepEqual(reglas(h), ['ancla-inexistente', 'ancla-inexistente', 'enlace-roto'])
    assert.ok(h.every((x) => x.archivo === 'README.md' && x.linea === 3))
  })

  test('un enlace a una carpeta existente es válido', () => {
    const raiz = paquete({ 'README.md': '[docs](docs/)\n', 'docs/a.md': '# A\n' })
    assert.deepEqual(revisar(raiz).filter((h) => h.severidad === 'bloqueante'), [])
  })

  test('CHANGELOG cuenta para enlaces rotos y no para la estructura', () => {
    const raiz = paquete({
      'README.md': '# R\n',
      'CHANGELOG.md': '[roto](nada.md)\n\n`/home/alguien/x`\n',
      'sub/CHANGELOG.md': '# otro\n',
    })
    const h = revisar(raiz)
    assert.deepEqual(reglas(h.filter((x) => x.archivo === 'CHANGELOG.md')), ['enlace-roto'])
    assert.deepEqual(h.filter((x) => x.regla === 'nombre-repetido'), [])
  })

  test('los nodos excluidos (node_modules, dist, notas) no se recorren', () => {
    const raiz = paquete({
      'README.md': '# R\n',
      'notas/plan.md': '[roto](nada.md)\n',
      'node_modules/x/README.md': '[roto](nada.md)\n',
      'dist/a.md': '[roto](nada.md)\n',
    })
    assert.deepEqual(revisar(raiz), [])
  })
})

describe('estructura (avisos)', () => {
  test('una carpeta con dos docs y sin nexo avisa', () => {
    const raiz = paquete({ 'docs/a.md': '# A\n', 'docs/b.md': '# B\n' })
    const h = revisar(raiz)
    assert.deepEqual(reglas(h), ['sin-nexo'])
    assert.equal(h[0].severidad, 'aviso')
  })

  test('un nexo que enlaza a todos limpia el aviso; si falta uno, lo nombra', () => {
    const completo = paquete({ 'docs/docs.md': '[a](a.md) [b](b.md)\n', 'docs/a.md': '# A\n', 'docs/b.md': '# B\n' })
    assert.deepEqual(revisar(completo), [])
    const corto = paquete({ 'docs/docs.md': '[a](a.md)\n', 'docs/a.md': '# A\n', 'docs/b.md': '# B\n' })
    const h = revisar(corto)
    assert.deepEqual(reglas(h), ['nexo-incompleto'])
    assert.match(h[0].mensaje, /b\.md/)
  })

  test('un doc solo en su carpeta y los de la raíz no piden nexo', () => {
    const raiz = paquete({ 'README.md': '# R\n', 'SPECS.md': '# S\n', 'docs/a.md': '# A\n' })
    assert.deepEqual(revisar(raiz), [])
  })

  test('nombres de archivo repetidos', () => {
    const raiz = paquete({ 'a/uno.md': '# 1\n', 'b/uno.md': '# 2\n' })
    assert.deepEqual(reglas(revisar(raiz)), ['nombre-repetido'])
  })

  test('enlaces de ida y vuelta entre dos docs, pero no entre un nexo y su doc', () => {
    const par = paquete({ 'A.md': '[b](B.md)\n', 'B.md': '[a](A.md)\n' })
    assert.deepEqual(reglas(revisar(par)), ['ida-y-vuelta'])
    const nexo = paquete({ 'docs/docs.md': '[a](a.md) [b](b.md)\n', 'docs/a.md': '[n](docs.md)\n', 'docs/b.md': '# B\n' })
    assert.deepEqual(revisar(nexo), [])
  })

  test('un enlace de A a B sin vuelta no avisa', () => {
    assert.deepEqual(revisar(paquete({ 'A.md': '[b](B.md)\n', 'B.md': '# B\n' })), [])
  })
})

describe('transitorios y rutas de máquina', () => {
  test('un transitorio sin muere_con bloquea; con él pasa', () => {
    const sin = paquete({ 'X.md': '---\ntipo: transitorio\n---\n# X\n' })
    assert.deepEqual(reglas(revisar(sin)), ['transitorio-sin-muere-con'])
    const con = paquete({ 'X.md': '---\ntipo: transitorio\nmuere_con: la rama\n---\n# X\n' })
    assert.deepEqual(revisar(con), [])
  })

  test('las rutas de máquina en un code span, o en un bloque, se marcan con su línea; en prosa no', () => {
    const raiz = paquete({
      'README.md': 'En prosa /home/x no cuenta.\n\nUsa `/home/sera/p` o `C:\\Users\\x`.\n\n```sh\ncd /Users/ana\n```\n',
    })
    const h = revisar(raiz)
    assert.deepEqual(reglas(h), ['ruta-de-maquina', 'ruta-de-maquina', 'ruta-de-maquina'])
    assert.deepEqual(h.map((x) => x.linea).sort(), [3, 3, 6])
  })

  test('una ruta del repo en código no se marca', () => {
    assert.deepEqual(revisar(paquete({ 'README.md': 'Mira `src/index.js` y `docs/a.md`.\n' })), [])
    assert.deepEqual(revisar(paquete({ 'README.md': 'Mira `src/home/Page.js` y `api/Users/1`.\n' })), [])
  })
})

describe('severidad por regla', () => {
  test('las reglas con deuda hoy avisan y el resto bloquea', () => {
    for (const r of ['sin-nexo', 'nexo-incompleto', 'nombre-repetido', 'ida-y-vuelta']) assert.equal(SEVERIDAD[r], 'aviso', r)
    for (const r of ['enlace-roto', 'ancla-inexistente', 'transitorio-sin-muere-con', 'ruta-de-maquina']) assert.equal(SEVERIDAD[r], 'bloqueante', r)
  })
})

describe('CLI', () => {
  test('árbol limpio: exit 0 y última línea con los conteos', () => {
    const r = correr(paquete({ 'README.md': '# R\n' }))
    assert.equal(r.status, 0)
    assert.equal(r.stdout.trim().split('\n').at(-1), 'check-enlaces: 0 bloqueantes, 0 avisos')
  })

  test('con un bloqueante: exit 1, el archivo y la línea en la salida', () => {
    const r = correr(paquete({ 'README.md': '# R\n\n[x](nada.md)\n' }))
    assert.equal(r.status, 1)
    assert.match(r.stdout, /README\.md\n\s+3\s+bloqueante\s+enlace-roto/)
    assert.equal(r.stdout.trim().split('\n').at(-1), 'check-enlaces: 1 bloqueantes, 0 avisos')
  })

  test('los avisos no cambian el exit', () => {
    const r = correr(paquete({ 'A.md': '[b](B.md)\n', 'B.md': '[a](A.md)\n' }))
    assert.equal(r.status, 0)
    assert.match(r.stdout, /check-enlaces: 0 bloqueantes, 1 avisos/)
  })

  test('con archivos informa sólo de ellos e ignora en silencio los que no son .md revisados', () => {
    const raiz = paquete({ 'README.md': '[x](nada.md)\n', 'GUIA.md': '# bien\n', 'src/a.js': '// [x](nada.md)\n' })
    const bueno = correr(raiz, 'GUIA.md', 'src/a.js', 'no-existe.md')
    assert.equal(bueno.status, 0)
    assert.equal(bueno.stdout.trim(), 'check-enlaces: 0 bloqueantes, 0 avisos')
    const malo = correr(raiz, 'README.md')
    assert.equal(malo.status, 1)
  })

  test('una opción desconocida es error de uso: exit 2', () => {
    assert.equal(correr(paquete({ 'README.md': '# R\n' }), '--nada').status, 2)
  })

  test('funciona sin git: el paquete de prueba no es un repositorio', () => {
    const r = correr(paquete({ 'README.md': '# R\n' }))
    assert.equal(r.stderr, '')
  })
})

describe('seleccionar y formatear', () => {
  test('seleccionar resuelve rutas relativas al cwd y descarta lo ajeno', () => {
    const raiz = paquete({ 'docs/a.md': '# A\n', 'src/x.js': '' })
    const dentro = join(raiz, 'docs')
    assert.deepEqual([...seleccionar(['a.md', '../src/x.js', 'zz.md'], raiz, dentro)], ['docs/a.md'])
  })

  test('formatear siempre termina en la línea de conteos', () => {
    assert.equal(formatear([]).texto, 'check-enlaces: 0 bloqueantes, 0 avisos')
  })
})
