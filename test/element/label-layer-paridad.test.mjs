// <cristae-label-layer> deprecada, traducida a sus reemplazos: paridad con lo que pintaba `addLabelLayer`. Sobre el
// Leaflet REAL, en jsdom, porque la paridad es de píxeles: el mismo `paint` espía recibe lo mismo por los dos
// caminos —el texto, el punto del ítem, el hover y el `style`—. Además el orden de declaración, la
// visibilidad, el hover del handle, el `textOf` en caliente, la baja y la burbuja de rótulo, que ya no gasta
// contexto WebGL. Corre con:
//   nice -n 19 node --test test/element/label-layer-paridad.test.mjs
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { contenedor, prepararDom } from '../../test-helpers/leaflet-real.mjs'

// El DOM va antes que Leaflet; lo demás que Lit toca lo pone el harness de elementos.
const window           = prepararDom()
globalThis.Element     = window.Element
globalThis.HTMLElement = class extends EventTarget {}
await import('../../test-helpers/element-stub.mjs')
const { makeEditGl, makeIconSet } = await import('../../test-helpers/engine-stub.mjs')
const { MapEngine }               = await import('../../src/engine/MapEngine.js')
const { createLeafletHost }       = await import('../../src/host/LeafletHost.js')
const { createSource }            = await import('../../src/data/index.js')
const { DEFAULT_STYLE }           = await import('../../src/render/LabelLayer.js')
const { CristaeLabelLayer }       = await import('../../src/element/CristaeLabelLayer.js')

// jsdom no pinta. El contexto 2D anota el texto de cada `fillText` y cuántos arcos lleva (la píldora los usa);
// el de WebGL es el doble del harness.
const trazo = { fills: [], arcos: 0 }
const ctx2d = new Proxy({
  measureText : text => ({ width: 7 * [...text].length }),
  fillText    : text => trazo.fills.push(text),
  arcTo       : () => trazo.arcos++,
}, { get: (t, p) => t[p] ?? (() => {}), set: () => true })
window.HTMLCanvasElement.prototype.getContext = kind => (kind === 'webgl2' ? makeEditGl() : ctx2d)

// Un cuadro de jsdom, y lo que el pintado agenda en él.
const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))))
mock.method(console, 'warn', () => {})

const FLOTA     = [
  { id: 1, lat: -33, lng: -70, nombre: 'Uno' }, { id: 2, lat: -33.01, lng: -70.02, nombre: 'Dos' },
  { id: 3, lat: -32.95, lng: -69.9, nombre: 'Tres' },
]
const accessors = { idOf: v => v.id, positionOf: v => ({ lat: v.lat, lng: v.lng }) }
const PALETA    = Object.freeze({ surface: '#000000', text: '#ffffff', accent: '#ff0000' })

// Un motor con su mapa propio, ya con vista: (-33, -70) cae en el centro del contenedor de 800×600.
const montar = async () => {
  const container = contenedor()
  const engine    = new MapEngine({ host: createLeafletHost({ container, view: { center: [-33, -70], zoom: 10 } }) })
  await engine.ready
  return { engine, container }
}
const motor = async () => (await montar()).engine

// Un `paint` que guarda, por id, lo último que recibió.
const espia = () => {
  const vistos = new Map()
  const paint  = (ctx, point, label, hovered, style) => {
    vistos.set(label.id, { text: label.text, x: point.x, y: point.y, hovered, style })
  }
  return { vistos, paint }
}

// La capa como la deja el mapa: conectada y montada en el motor por `cristaeMount`.
const capa = props => Object.assign(new CristaeLabelLayer(), {
  isConnected: true, _enclosingModifier: () => null, closest: () => null,
}, props)

// Leaflet entrega el píxel redondeado y la colocación de los rótulos el exacto: menos de un píxel, que
// `drawLabel` vuelve a redondear.
const igual = (viejo, nuevo) => {
  assert.deepEqual([...nuevo.keys()].sort(), [...viejo.keys()].sort(), 'los mismos ítems')
  viejo.forEach((v, id) => {
    const n = nuevo.get(id)
    assert.equal(n.text, v.text, `texto de ${id}`)
    assert.ok(Math.abs(n.x - v.x) < 1 && Math.abs(n.y - v.y) < 1, `punto de ${id}: ${n.x},${n.y} vs ${v.x},${v.y}`)
    assert.equal(n.hovered, v.hovered, `hover de ${id}`)
    assert.equal(n.style, v.style, `style de ${id}`)
  })
}

test('bind-to: lo mismo que addLabelLayer, por los rótulos del host y sin capa propia', async () => {
  const engine = await motor()
  engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: FLOTA })
  const viejo = espia()
  const nuevo = espia()
  engine.addLabelLayer({ id: 'viejo', bindTo: 'flota', textOf: v => v.nombre, paint: viejo.paint, style: PALETA })
  const el = capa({ id: 'rotulos', bindTo: 'flota', textOf: v => v.nombre, paint: nuevo.paint, style: PALETA })
  el.cristaeMount(engine)
  await frame()

  igual(viejo.vistos, nuevo.vistos)
  assert.equal(nuevo.vistos.get(1).text, 'Uno')
  assert.equal(engine.getLayer('rotulos'), null, 'sin registro propio')
  assert.equal(engine.getLayer('flota').labels.links.length, 1, 'los rótulos son del host')
  assert.equal(el.controls.source, undefined, 'el mapa no la cuenta entre las capas de datos')
  engine.destroy()
})

test('bind-to sin paint ni style: la píldora de drawLabel con la paleta por defecto', async () => {
  const engine = await motor()
  engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: FLOTA })
  const el = capa({ bindTo: 'flota', textOf: v => v.nombre })
  el.cristaeMount(engine)
  trazo.fills.length = 0
  trazo.arcos        = 0
  await frame()
  assert.deepEqual(trazo.fills.filter(t => /^(Uno|Dos|Tres)$/.test(t)).sort(), ['Dos', 'Tres', 'Uno'])
  assert.ok(trazo.arcos >= 12, 'cuatro arcos por píldora')
  engine.destroy()
})

test('sin textOf, el texto es el id del ítem, como antes', async () => {
  const engine = await motor()
  engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: FLOTA })
  const viejo = espia()
  const nuevo = espia()
  engine.addLabelLayer({ id: 'viejo', bindTo: 'flota', paint: viejo.paint })
  capa({ bindTo: 'flota', paint: nuevo.paint }).cristaeMount(engine)
  await frame()
  igual(viejo.vistos, nuevo.vistos)
  assert.equal(nuevo.vistos.get(2).text, '2')
  assert.equal(nuevo.vistos.get(2).style, DEFAULT_STYLE)
  engine.destroy()
})

test('en cualquier orden: declarada antes que su host, se liga en el cuadro siguiente al alta', async () => {
  const engine = await motor()
  const nuevo  = espia()
  const el     = capa({ bindTo: 'flota', textOf: v => v.nombre, paint: nuevo.paint })
  el.cristaeMount(engine)
  await frame()
  assert.equal(nuevo.vistos.size, 0)

  engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: FLOTA })
  await frame()
  await frame()
  assert.equal(nuevo.vistos.size, 3)
  engine.destroy()
})

test('desmontada mientras espera al host, deja de reintentar', async () => {
  const engine = await motor()
  const nuevo  = espia()
  const el     = capa({ bindTo: 'flota', paint: nuevo.paint })
  el.cristaeMount(engine)
  el.cristaeUnmount()
  engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: FLOTA })
  await frame()
  await frame()
  assert.ok(!engine.getLayer('flota').labels)
  engine.destroy()
})

test('visible: declarada oculta no pinta; el handle y la prop la encienden y apagan', async () => {
  const engine = await motor()
  engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: FLOTA })
  const nuevo = espia()
  const el    = capa({ bindTo: 'flota', paint: nuevo.paint, visible: false })
  el.cristaeMount(engine)
  await frame()
  assert.equal(nuevo.vistos.size, 0, 'oculta desde el montaje')

  el.controls.setVisible(true)
  await frame()
  assert.equal(nuevo.vistos.size, 3)

  nuevo.vistos.clear()
  el.visible = false
  el.updated(new Map([['visible', true]]))
  engine.getLayer('flota').labels.invalidate('style')
  await frame()
  assert.equal(nuevo.vistos.size, 0, 'la prop la apaga')
  engine.destroy()
})

test('setHovered del handle: el painter recibe hovered en esos ids, como antes', async () => {
  const engine = await motor()
  engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: FLOTA })
  const viejo  = espia()
  const nuevo  = espia()
  const handle = engine.addLabelLayer({ id: 'viejo', bindTo: 'flota', paint: viejo.paint })
  const el     = capa({ bindTo: 'flota', paint: nuevo.paint })
  el.cristaeMount(engine)
  handle.setHovered(new Set([2]))
  el.controls.setHovered(new Set([2]))
  await frame()
  igual(viejo.vistos, nuevo.vistos)
  assert.equal(nuevo.vistos.get(2).hovered, true)
  assert.equal(nuevo.vistos.get(1).hovered, false)
  engine.destroy()
})

test('textOf, paint y style en caliente viajan por los rótulos, sin remontar', async () => {
  const engine = await motor()
  engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: FLOTA })
  const nuevo = espia()
  const el    = capa({ bindTo: 'flota', textOf: v => v.nombre, paint: nuevo.paint })
  el.cristaeMount(engine)
  await frame()
  const links = engine.getLayer('flota').labels.links

  el.textOf = v => `#${v.id}`
  el.style  = PALETA
  el.updated(new Map([['textOf', null], ['style', null]]))
  await frame()
  assert.equal(nuevo.vistos.get(3).text, '#3')
  assert.equal(nuevo.vistos.get(3).style, PALETA)
  assert.equal(engine.getLayer('flota').labels.links, links, 'el mismo grupo de rótulos')
  engine.destroy()
})

test('la baja de la capa se lleva sus rótulos y deja al host', async () => {
  const engine = await motor()
  engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: FLOTA })
  const el = capa({ bindTo: 'flota' })
  el.cristaeMount(engine)
  assert.ok(engine.getLayer('flota').labels)
  el.cristaeUnmount()
  assert.equal(engine.getLayer('flota').labels, null)
  assert.ok(engine.getLayer('flota'))
  engine.destroy()
})

test('source propio: una capa de texto con el id de la capa, igual a addLabelLayer', async () => {
  const engine = await motor()
  const viejo  = espia()
  const nuevo  = espia()
  const source = createSource(accessors)
  source.set(FLOTA)
  engine.addLabelLayer({ id: 'viejo', source, accessors, textOf: v => v.nombre, paint: viejo.paint, style: PALETA })
  const el = capa({ id: 'ciudades', source, accessors, textOf: v => v.nombre, paint: nuevo.paint, style: PALETA })
  el.cristaeMount(engine)
  await frame()

  igual(viejo.vistos, nuevo.vistos)
  assert.equal(engine.getLayer('ciudades').kind, 'text')
  assert.equal(el.controls.source, undefined)

  el.controls.setVisible(false)
  nuevo.vistos.clear()
  engine.getLayer('ciudades').labels.invalidate('style')
  await frame()
  assert.equal(nuevo.vistos.size, 0, 'el handle la oculta')

  el.cristaeUnmount()
  assert.equal(engine.getLayer('ciudades'), null, 'la baja se lleva la capa de texto')
  engine.destroy()
})

// Cinco puntos a metros unos de otros: a zoom 10 son una burbuja de 5 en el centro del contenedor (400, 300).
const JUNTOS = [
  { id: 1, lat: -33, lng: -70 }, { id: 2, lat: -33, lng: -70.0001 }, { id: 3, lat: -33.0001, lng: -70 },
  { id: 4, lat: -33.0001, lng: -70.0001 }, { id: 5, lat: -33, lng: -70.0002 },
]
const burbujas = async bubble => {
  const { engine, container } = await montar()
  const flota = engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data: JUNTOS })
  const unit  = engine.addClusterFold([{ id: 'flota' }], { radius: 80, maxZoom: 18, minPoints: 2, bubble })
  return { engine, container, flota, bubbleId: unit.id }
}

const clickear = (container, x, y) => ['pointerdown', 'pointerup'].forEach(tipo =>
  container.dispatchEvent(new window.PointerEvent(tipo, { clientX: x, clientY: y, bubbles: true, cancelable: true })))

test('slot="bubble": la píldora con el conteo sobre la burbuja, sin capa GL ni picking', async () => {
  const nuevo = espia()
  const { engine, container, bubbleId } = await burbujas({ kind: 'label', textOf: n => `${n} camiones`, paint: nuevo.paint, style: PALETA })
  const expandidas = []
  engine.on('cluster:expand', e => expandidas.push(e))
  await frame()

  const [pintada] = [...nuevo.vistos.values()]
  assert.equal(nuevo.vistos.size, 1)
  assert.equal(pintada.text, '5 camiones', 'textOf recibe el conteo, como antes')
  assert.ok(Math.abs(pintada.x - 400) < 1 && Math.abs(pintada.y - 300) < 1, `en el punto de la burbuja: ${pintada.x},${pintada.y}`)
  assert.equal(pintada.hovered, false)
  assert.equal(pintada.style, PALETA)
  assert.equal(engine.getLayer(bubbleId).layer, undefined, 'sin capa de puntos: no gasta contexto WebGL')

  clickear(container, 400, 333)
  assert.equal(expandidas.length, 0, 'la píldora no se pica, como antes')
  engine.destroy()
})

test('slot="bubble" sin textOf ni paint: el conteo en la píldora de drawLabel', async () => {
  const { engine } = await burbujas({ kind: 'label' })
  trazo.fills.length = 0
  trazo.arcos        = 0
  await frame()
  assert.ok(trazo.fills.includes('5'))
  assert.ok(trazo.arcos >= 4)
  engine.destroy()
})

test('slot="bubble": la burbuja sigue al recluster y se va con el cluster', async () => {
  const nuevo = espia()
  const { engine, flota, bubbleId } = await burbujas({ kind: 'label', paint: nuevo.paint })
  await frame()
  assert.equal(nuevo.vistos.size, 1)
  nuevo.vistos.clear()
  flota.setWhere(v => v.id <= 3)
  await frame()
  assert.deepEqual([...nuevo.vistos.values()].map(v => v.text), ['3'])
  engine.removeLayer('flota')
  assert.equal(engine.getLayer(bubbleId), null)
  engine.destroy()
})
