// El estilo de capa de <cristae-polygon-layer> y <cristae-shape-layer>: las mismas siete props, que llegan al
// alta como `PolygonLayerConfig`, con `stroke` y `fill` encendidos salvo que se apaguen, y que al cambiar
// se reenvían a `handle.style` sin tocar el resto. Un objeto con el prototipo de la clase alcanza: ni el
// alta ni la sincronización leen más que `this.*`.
import '../../test-helpers/element-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { CristaePolygonLayer } from '../../src/element/CristaePolygonLayer.js'
import { CristaeShapeLayer } from '../../src/element/CristaeShapeLayer.js'

const CAPAS = [
  ['polígonos', CristaePolygonLayer, 'addPolygonLayer'],
  ['formas', CristaeShapeLayer, 'addShapeLayer'],
]
const capa = (Clase, props) => Object.assign(Object.create(Clase.prototype), { visible: true, accessors: {}, ...props })

CAPAS.forEach(([nombre, Clase, alta]) => {
  const eco = { [alta]: cfg => cfg }

  test(`${nombre}: sin declarar estilo el alta lo recibe ausente, con trazo y relleno encendidos`, () => {
    const cfg = capa(Clase, {}).mountLayer(eco)
    assert.deepEqual([cfg.stroke, cfg.fill], [true, true])
    assert.deepEqual(
      ['color', 'weight', 'opacity', 'fillColor', 'fillOpacity'].map(k => cfg[k]), [undefined, undefined, undefined, undefined, undefined])
  })

  test(`${nombre}: el alta recibe el estilo declarado, y \`fill\` y \`stroke\` se apagan por propiedad o por atributo`, () => {
    const declarado = { color: '#0f766e', weight: 2, opacity: 0.5, fillColor: '#ff0000', fillOpacity: 0.1 }
    const cfg = capa(Clase, { ...declarado, fill: false, stroke: 'false' }).mountLayer(eco)
    assert.deepEqual(cfg, { ...cfg, ...declarado, fill: false, stroke: false })

    const { fill, stroke } = Clase.properties
    assert.deepEqual([fill.converter.fromAttribute('false'), fill.converter.fromAttribute(''), stroke.converter.fromAttribute('0')], [false, true, false])
    assert.deepEqual([Clase.properties.fillColor.attribute, Clase.properties.fillOpacity.attribute], ['fill-color', 'fill-opacity'])
  })

  test(`${nombre}: cambiar un estilo de capa lo reenvía al handle junto con los demás, y otro cambio no lo toca`, () => {
    const llamadas = []
    const el = capa(Clase, { _handle: { style: o => llamadas.push(o) }, color: '#ff0000', weight: 4 })

    el.syncLayer(new Map([['weight', 3]]))
    assert.deepEqual(llamadas, [{ color: '#ff0000', weight: 4, opacity: undefined, fillColor: undefined, fillOpacity: undefined }])

    el.syncLayer(new Map([['stroke', true], ['fill', true], ['interactive', true]]))
    assert.equal(llamadas.length, 1, '`stroke` y `fill` se leen al montar: no repintan')
  })
})
