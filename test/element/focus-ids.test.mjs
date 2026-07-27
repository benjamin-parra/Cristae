// Eje declarativo `focus-ids`: vive en la base, así que TODA capa lo hereda sin declararlo. Se
// verifica el parser (los tres estados) y que la base lo reenvíe al motor por el ciclo de Lit.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFocusIds } from '../../src/element/attrs.js'

test('parseFocusIds distingue AUSENTE de PRESENTE-vacío (no los colapsa)', () => {
  assert.equal(parseFocusIds(undefined), undefined, 'ausente → la capa no participa del eje')
  assert.deepEqual(parseFocusIds(null), [], 'presente sin ids → participa, todo atenuado')
  assert.deepEqual(parseFocusIds(''), [], 'atributo vacío → participa, todo atenuado')
  assert.deepEqual(parseFocusIds([]), [], 'array vacío → participa, todo atenuado')
})

test('parseFocusIds acepta token-list (atributo) y array (propiedad)', () => {
  assert.deepEqual(parseFocusIds('a b  c'), ['a', 'b', 'c'], 'token-list separada por espacios')
  assert.deepEqual(parseFocusIds(['a', 'b']), ['a', 'b'], 'array por propiedad pasa tal cual')
  assert.deepEqual(parseFocusIds([1, 2]), [1, 2], 'conserva ids numéricos (no los stringifica)')
})

// La base declara `focusIds` en `static properties`; Lit acumula las de toda la cadena de herencia,
// así que una subclase que declara las suyas NO la pierde.
test('la prop focusIds la heredan las capas sin declararla', async () => {
  const { CristaeLayerElement } = await import('../../src/element/base.js')
  const { CristaePointLayer } = await import('../../src/element/CristaePointLayer.js')

  assert.ok('focusIds' in CristaeLayerElement.properties, 'la base la declara')
  assert.equal(CristaeLayerElement.properties.focusIds.attribute, 'focus-ids',
    'el atributo es focus-ids (no `focus`, que pisaría HTMLElement.focus())')

  CristaePointLayer.finalize()          // Lit resuelve la cadena de herencia de props de forma perezosa
  assert.equal(CristaePointLayer.elementProperties.has('focusIds'), true, 'la subclase la hereda')
  assert.equal(CristaePointLayer.elementProperties.has('data'), true, 'y conserva las propias')
})
