// Tokenizador XML de KML y GPX — contrato: DISENO-INTEROP §2.6 (XML seguro) y XML 1.0 en lo que
// §2.6 cita: buena formación, entidades predefinidas, referencias de carácter, atributos únicos.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { EOF, END, START, TEXT, createXml, names, xmlText } from '../../../src/formats/xml.js'
import { fallaCon } from '../comun.mjs'

const bytes = texto => typeof texto === 'string' ? new TextEncoder().encode(texto) : texto
const NOMBRES = names([['a', 1], ['b', 2], ['c', 3]])

// Los eventos como texto legible: `<a`, `>a`, `"…"`.
const eventos = (texto, maxDepth = 512) => {
  const b = bytes(texto)
  const x = createXml(b, 'kml', maxDepth)
  const out = []
  for (let e; (e = x.next()) !== EOF; ) {
    const nombre = new TextDecoder().decode(b.subarray(x.name0, x.name1))
    out.push(e === START ? `<${nombre}@${x.depth}` : e === END ? `>${nombre}@${x.depth}` : `"${new TextDecoder().decode(b.subarray(x.text0, x.text1))}"`)
  }
  return out
}

const falla = (texto, code, opciones) => fallaCon(() => eventos(texto, opciones), code, 'kml')

describe('XML: eventos', () => {
  test('inicio, texto y fin con profundidad y nombre local', () => {
    assert.deepEqual(eventos('<?xml version="1.0"?><!-- c --><p:a x="1"><b/>t<![CDATA[<x>]]></p:a>'),
      ['<a@1', '<b@2', '>b@2', '"t"', '"<x>"', '>a@1'])
  })

  test('BOM saltado sin desplazar offsets', () => {
    const b = new Uint8Array([0xEF, 0xBB, 0xBF, ...bytes('<a/>')])
    const x = createXml(b, 'kml', 8)
    x.next()
    assert.equal(x.tag0, 3)
  })

  test('atributos por nombre local, con referencias y normalización de espacios (§3.3.3)', () => {
    const b = bytes('<a p:id="x&amp;&#121;" n=\'1\tz\'/>')
    const x = createXml(b, 'kml', 8)
    x.next()
    assert.equal(x.code(NOMBRES), 1)
    assert.equal(x.attrText(x.attr(bytes('id'))), 'x&y')
    assert.equal(x.attrText(x.attr(bytes('n'))), '1 z')
    assert.equal(x.attr(bytes('q')), -1)
  })

  test('text() junta texto y CDATA de los descendientes, sin comentarios', () => {
    const x = createXml(bytes('<a>uno <b>dos</b><!-- no --><![CDATA[&amp;]]>&lt;</a>'), 'kml', 8)
    x.next()
    assert.equal(x.text(), 'uno dos&amp;<')
    assert.equal(x.next(), EOF)
  })

  test('gather() lee en sitio un tramo simple y copia uno partido', () => {
    const b = bytes('<a> 1,2 </a>')
    const x = createXml(b, 'kml', 8)
    x.next()
    x.gather()
    assert.equal(x.gBytes, b)
    assert.equal(new TextDecoder().decode(b.subarray(x.gFrom, x.gTo)), ' 1,2 ')

    const y = createXml(bytes('<a>1<!-- -->2&#44;<![CDATA[3]]></a>'), 'kml', 8)
    y.next()
    y.gather()
    assert.equal(new TextDecoder().decode(y.gBytes.subarray(y.gFrom, y.gTo)), '12,3')
  })

  test('modo fragmento: un elemento y termina', () => {
    const b = bytes('<r><a>x</a><b/></r>')
    const x = createXml(b, 'kml', 8, 3, 11, 'utf-8')
    const tipos = []
    for (let e; (e = x.next()) !== EOF; ) tipos.push(e)
    assert.deepEqual(tipos, [START, TEXT, END])
  })

  test('windows-1252 declarada decodifica el texto materializado', () => {
    const b = new Uint8Array([...bytes('<?xml version="1.0" encoding="windows-1252"?><a>'), 0x80, ...bytes('</a>')])
    const x = createXml(b, 'kml', 8)
    x.next()
    assert.equal(x.text(), '€')
  })

  test('xmlText resuelve las cinco predefinidas y las numéricas', () => {
    const b = bytes('&lt;&gt;&amp;&apos;&quot;&#65;&#x1F600;')
    assert.equal(xmlText(b, 0, b.length, 'utf-8', 'kml'), '<>&\'"A😀')
  })
})

describe('XML: lo que no se acepta (§2.6)', () => {
  test('DOCTYPE, con o sin subconjunto interno, es dtd', async () => {
    await falla('<!DOCTYPE a><a/>', 'dtd')
    await falla('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>', 'dtd')
    await falla('<a><!DOCTYPE a></a>', 'dtd')
  })

  test('entidad no declarada y referencias a no-Char son sintaxis (XML 1.0 §4.1, §2.2)', async () => {
    await falla('<a>&foo;</a>', 'sintaxis')
    await falla('<a>&#0;</a>', 'sintaxis')
    await falla('<a>&#xD800;</a>', 'sintaxis')
    await falla('<a>&#x110000;</a>', 'sintaxis')
    await falla('<a>&#;</a>', 'sintaxis')
    await falla('<a>& </a>', 'sintaxis')
    await falla('<a x="&bar;"/>', 'sintaxis')
  })

  test('atributo repetido, aun con el mismo valor, es sintaxis (XML 1.0 §3.1)', async () => {
    await falla('<a x="1" x="1"/>', 'sintaxis')
    await falla('<a p:x="1" p:x="2"/>', 'sintaxis')
  })

  test('buena formación', async () => {
    await falla('<a><b></a></b>', 'sintaxis')
    await falla('<a/><b/>', 'sintaxis')
    await falla('texto<a/>', 'sintaxis')
    await falla('<a/>texto', 'sintaxis')
    await falla('</a>', 'sintaxis')
    await falla('<a x=1/>', 'sintaxis')
    await falla('<a x="1"y="2"/>', 'sintaxis')
    await falla('<a x="<"/>', 'sintaxis')
    await falla('<![CDATA[x]]><a/>', 'sintaxis')
    await falla('<a><?xml version="1.0"?></a>', 'sintaxis')
    await falla('<a><!ELEMENT a ANY></a>', 'sintaxis')
    await falla('', 'sintaxis')
    await falla('  <!-- sólo un comentario -->  ', 'sintaxis')
  })

  test('lo que empieza y no cierra es truncado', async () => {
    await falla('<a>', 'truncado')
    await falla('<a', 'truncado')
    await falla('<a x="1', 'truncado')
    await falla('<a><!-- sin fin', 'truncado')
    await falla('<a><![CDATA[sin fin', 'truncado')
    await falla('<a></a', 'truncado')
  })

  test('maxDepth corta el anidamiento con profundidad', async () => {
    await falla('<a><a><a/></a></a>', 'profundidad', 2)
    assert.equal(eventos('<a><a><a/></a></a>', 3).length, 6)
  })

  test('UTF-16 y codificaciones no soportadas son codificacion', async () => {
    await falla(new Uint8Array([0xFF, 0xFE, 60, 0, 97, 0, 47, 0, 62, 0]), 'codificacion')
    await falla(new Uint8Array([60, 0, 97, 0]), 'codificacion')
    await falla('<?xml version="1.0" encoding="Shift_JIS"?><a/>', 'codificacion')
  })

  test('una referencia dentro de un número sólo vale espacio o un carácter numérico', async () => {
    const x = createXml(bytes('<a>1&#65;</a>'), 'kml', 8)
    x.next()
    await fallaCon(() => x.gather(), 'numero', 'kml')
  })
})
