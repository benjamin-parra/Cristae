// Apilado declarativo `pane` / `z`: vive en la base (como `focus-ids`), así que toda capa HOJA lo
// hereda sin declararlo, y cada `mountLayer` lo pasa al alta del motor. Sin declararlo, el motor
// deriva el z del ORDEN de declaración — las mismas capas montadas en otro orden apilan distinto.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CristaeLayerElement } from '../../src/element/base.js'
import { CristaePointLayer } from '../../src/element/CristaePointLayer.js'
import { CristaeLineLayer } from '../../src/element/CristaeLineLayer.js'
import { CristaePolygonLayer } from '../../src/element/CristaePolygonLayer.js'
import { CristaeHtmlLayer } from '../../src/element/CristaeHtmlLayer.js'
import { CristaeLabelLayer } from '../../src/element/CristaeLabelLayer.js'

const CAPAS = [
  ['point', CristaePointLayer],
  ['line', CristaeLineLayer],
  ['polygon', CristaePolygonLayer],
  ['html', CristaeHtmlLayer],
  ['label', CristaeLabelLayer],
]

// Sin DOM: `mountLayer` sólo lee `this.*` y llama al alta, así que alcanza un objeto con el prototipo
// de la clase (de ahí sale el getter `_placement` de la base). El motor eco devuelve la config recibida.
const capa = (Clase, props) => Object.assign(Object.create(Clase.prototype), { visible: true, ...props })
const eco = {
  addPointLayer: cfg => cfg, addLineLayer: cfg => cfg, addPolygonLayer: cfg => cfg,
  addHtmlLayer: cfg => cfg, addLabelLayer: cfg => cfg,
}

test('toda capa hoja pasa el `pane`/`z` declarado al alta del motor', () => {
  CAPAS.forEach(([kind, Clase]) => {
    const cfg = capa(Clase, { id: kind, pane: 'cristae-ruta', z: 378 }).mountLayer(eco)
    assert.equal(cfg.pane, 'cristae-ruta', `${kind}: el pane declarado llega al alta`)
    assert.equal(cfg.z, 378, `${kind}: el z declarado llega al alta`)
  })
})

test('sin declararlo, el alta los recibe ausentes (el motor conserva su z por orden)', () => {
  CAPAS.forEach(([kind, Clase]) => {
    const cfg = capa(Clase, { id: kind }).mountLayer(eco)
    assert.equal(cfg.z, undefined, `${kind}: z ausente → el motor hace z ?? BASE_Z + orden·Z_STEP`)
    assert.equal(cfg.pane, undefined, `${kind}: pane ausente → el motor le crea uno propio`)
  })
})

// `z` es reactivo: la base lo reenvía al motor por el ciclo de Lit. `pane` no — mudar de pane exigiría
// recrear la capa, y a una capa dentro de un modificador la monta la gramática, no ella misma.
test('cambiar `z` reapila por el motor; cambiar `pane` no toca nada', () => {
  const reapilados = []
  const capa = Object.assign(Object.create(CristaePointLayer.prototype), {
    _handle: { id: 'flota' },
    _engine: { setLayerZ: (id, z) => reapilados.push([id, z]) },
    z: 620,
    pane: 'otro',
    syncLayer() {},
  })

  CristaeLayerElement.prototype.updated.call(capa, new Map([['z', 378]]))
  assert.deepEqual(reapilados, [['flota', 620]], 'el z nuevo llega al motor')

  CristaeLayerElement.prototype.updated.call(capa, new Map([['pane', 'previo']]))
  assert.equal(reapilados.length, 1, 'cambiar el pane no reapila')
})

// La base los declara en `static properties`; Lit acumula las de toda la cadena de herencia, así que
// una subclase que declara las suyas NO las pierde.
test('las props las heredan las capas sin declararlas', () => {
  assert.equal(CristaeLayerElement.properties.z.type, Number, 'z es numérico (atributo `z`)')
  assert.ok('pane' in CristaeLayerElement.properties, 'la base declara pane')
  CAPAS.forEach(([kind, Clase]) => {
    Clase.finalize()                     // Lit resuelve la cadena de herencia de props de forma perezosa
    assert.equal(Clase.elementProperties.has('z'), true, `${kind} hereda z`)
    assert.equal(Clase.elementProperties.has('pane'), true, `${kind} hereda pane`)
  })
})
