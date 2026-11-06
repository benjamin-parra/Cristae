// `addLabels` en el motor (DISENO-ROTULOS §1.3, §2 y §4.3): sobre qué capas, cómo siguen a su host —baja,
// visibilidad, cluster, curva y foco—, en qué plano de z van y qué entrega un click sobre ellos. Los
// rótulos se pintan con el canvas real sobre un contexto 2D que mide 7 px por grafema; el miembro se lee
// por `record.labels`, que es estado del host. Corre con:
//   node --test test/engine/labels.test.mjs
import { decorarElementos, makeEditGl, makeIconSet, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { LABEL_RENDERERS } from '../../src/engine/labels.js'
import { tablesFromRings } from '../../src/render/PolygonGpuLayer.js'
import { createSource } from '../../src/data/index.js'

const frame = () => new Promise(resolve => setTimeout(resolve, 5))

// Lo que pinta el canvas de los rótulos, en orden. Los demás 2D (el calor) caen al mismo espía.
const fills = []
const ctx2d = new Proxy({
  measureText  : text => ({ width: 7 * [...text].length }),
  getImageData : (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),   // el atlas rasteriza al primer uso
  fillText     : text => fills.push(text),
}, { get: (t, p) => t[p] ?? (() => {}), set: () => true })
after(decorarElementos((el, tag) => {
  if (tag === 'canvas') el.getContext = kind => (kind === '2d' ? ctx2d : makeEditGl())
  return el
}))

const CLUSTER_PLANE = 1_000_400
const LABEL_PLANE   = 2_000_400
const TOP_PLANE     = 3_000_400

const puntos  = { idOf: v => v.id, positionOf: v => ({ lat: v.lat, lng: v.lng }) }
const lineas  = { idOf: r => r.id, pathOf: r => r.path }
const anillos = { idOf: g => g.id, ringsOf: g => g.rings }
const RUTA    = { id: 'R1', path: [[0, -20], [0, 20]] }
const CAJA    = { id: 'g', rings: [[0, 0], [0, 8], [8, 8], [8, 0]] }

const motor = () => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  return { map, engine, container: map.getContainer() }
}

const miembro = (engine, id, i = 0) => engine.getLayer(id).labels.links[i].member
const idsDe   = member => {
  const ids = []
  member.forEach((acc, item, id) => acc.push(id), ids)
  return ids
}

// Un click del puntero primario en (x, y) del contenedor: lo sintetiza la puerta del puntero.
const clickear = (container, x, y) => {
  container.emitir('pointerdown', { clientX: x, clientY: y })
  container.emitir('pointerup', { clientX: x, clientY: y })
}

test('addLabels rotula cada capa base, y devuelve null sobre editores, calor, imagen y polígonos sin Source', () => {
  const { engine } = motor()
  engine.addPointLayer({ id: 'p', accessors: puntos, iconSet: makeIconSet(), data: [{ id: 'a', lat: 0, lng: 0 }] })
  engine.addHtmlLayer({ id: 'h', accessors: { ...puntos, htmlOf: () => '' }, data: [{ id: 'a', lat: 0, lng: 0 }] })
  engine.addLineLayer({ id: 'l', accessors: lineas, data: [RUTA] })
  engine.addPolygonLayer({ id: 'g', accessors: anillos, data: [CAJA] })
  engine.addShapeLayer({ id: 's', accessors: { ...puntos, radiusOf: () => 1000 }, data: [{ id: 'a', lat: 0, lng: 0 }] })
  engine.addCircleLayer({ id: 'c', accessors: { ...puntos, radiusMetersOf: () => 1000 }, data: [{ id: 'a', lat: 0, lng: 0 }] })
  engine.addEditableLayer({ id: 'e', kind: 'polyline' })
  engine.addHeatLayer({ id: 'calor', accessors: puntos, data: [{ id: 'a', lat: 0, lng: 0 }] })
  engine.addImageLayer({ id: 'img', url: 'x.png', bounds: { south: 0, west: 0, north: 1, east: 1 } })
  engine.addPolygonLayer({ id: 'tipado', geometry: tablesFromRings([CAJA], g => g.rings) })

  const kinds = ['p', 'h', 'l', 'g', 's', 'c'].map(id => engine.addLabels({ hostId: id }) && miembro(engine, id).kind)
  assert.deepEqual(kinds, ['point', 'html', 'line', 'polygon', 'shape', 'shape'])
  assert.deepEqual(['p', 'h', 'l', 'g', 's'].map(id => miembro(engine, id).placement), ['below', 'below', 'along', 'center', 'center'], 'la colocación natural de cada una')
  assert.deepEqual(['e', 'calor', 'img', 'tipado', 'nadie'].map(id => engine.addLabels({ hostId: id })), [null, null, null, null, null])
  engine.destroy()
})

test('las opciones inválidas lanzan TypeError sin dejar nada; un update inválido no cambia nada', () => {
  const { engine, map } = motor()
  engine.addPointLayer({ id: 'p', accessors: puntos, iconSet: makeIconSet(), data: [{ id: 'a', lat: 0, lng: 0 }] })
  assert.throws(() => engine.addLabels({ hostId: 'p', placement: 'along' }), TypeError)
  assert.throws(() => engine.addLabels({ hostId: 'p', renderer: 'gl' }), TypeError)
  assert.equal(engine.getLayer('p').labels, undefined, 'sin grupo')
  assert.equal(map.getPane('cristae-labels'), null, 'ni canvas')

  const labels = engine.addLabels({ hostId: 'p', offset: 4 })
  const member = miembro(engine, 'p')
  const antes  = member.opts
  assert.throws(() => labels.update({ placement: 'along' }), TypeError)
  assert.throws(() => labels.update({ repeat: -1 }), TypeError)
  assert.equal(member.opts, antes)
  labels.update({ placement: 'right', offset: null })
  assert.deepEqual([member.placement, member.opts.offset], ['right', 0], '`null` vuelve al defecto')
  engine.destroy()
})

test('mueren con el host: la baja del host suelta el canvas, y el handle queda inerte', () => {
  const { engine, map } = motor()
  engine.addLineLayer({ id: 'l', accessors: lineas, data: [RUTA] })
  const labels = engine.addLabels({ hostId: 'l' })
  assert.ok(map.getPane('cristae-labels'), 'el canvas compartido nace con el primer rótulo canvas')
  engine.removeLayer('l')
  assert.equal(map.getPane('cristae-labels'), null, 'y se va con el último')
  assert.doesNotThrow(() => { labels.update({ offset: 2 }); labels.remove(); labels.remove() })

  engine.addLineLayer({ id: 'l', accessors: lineas, data: [RUTA] })
  assert.equal(engine.getLayer('l').labels, undefined, 'un host nuevo con el mismo id nace sin rótulos')
  engine.destroy()
})

test('dos labeled sobre el mismo host comparten grupo; remove saca sólo el suyo', () => {
  const { engine } = motor()
  engine.addLineLayer({ id: 'l', accessors: lineas, data: [RUTA] })
  const arriba = engine.addLabels({ hostId: 'l', offset: 8 })
  engine.addLabels({ hostId: 'l', offset: -8, textOf: r => `${r.id} km` })
  assert.equal(engine.getLayer('l').labels.links.length, 2)
  arriba.remove()
  assert.deepEqual(engine.getLayer('l').labels.links.map(({ member }) => member.opts.offset), [-8])
  engine.destroy()
})

test('visibilidad compuesta: la propia, la del host y su habilitación', async () => {
  const { engine, map } = motor()
  engine.addPointLayer({ id: 'p', accessors: puntos, iconSet: makeIconSet(), data: [{ id: 'a', lat: 0, lng: 0 }] })
  const labels = engine.addLabels({ hostId: 'p' })
  const member = miembro(engine, 'p')
  await frame()
  assert.ok(member.visible && fills.includes('a'))

  // Al asentar la vista el canvas repinta en el acto.
  const pinta = () => {
    fills.length = 0
    map.fire('moveend')
    return fills.includes('a')
  }
  engine.setLayerVisibility('p', false)
  assert.equal(member.visible, false)
  assert.equal(pinta(), false, 'host oculto: el rótulo no se pinta')
  engine.setLayerVisibility('p', true)
  engine.setLayerEnabled('p', false)
  assert.equal(member.visible, false, 'host deshabilitado')
  engine.setLayerEnabled('p', true)
  labels.update({ visible: false })
  assert.equal(member.visible, false, 'el propio')
  labels.update({ visible: null })
  assert.equal(member.visible, true)
  assert.equal(pinta(), true)
  engine.destroy()
})

// Cinco puntos juntos que el cluster agrupa a zoom 3, y uno lejos que queda suelto.
const FLOTA = [
  { id: 1, lat: 0, lng: 0 }, { id: 2, lat: 0, lng: 0.0001 }, { id: 3, lat: 0.0001, lng: 0 },
  { id: 4, lat: 0.0001, lng: 0.0001 }, { id: 5, lat: 0, lng: 0.0002 }, { id: 6, lat: 40, lng: 60 },
]

test('la supresión del cluster en los dos órdenes: los agrupados no llevan rótulo', () => {
  for (const antes of [true, false]) {
    const { engine } = motor()
    engine.addPointLayer({ id: 'flota', accessors: puntos, iconSet: makeIconSet(), data: FLOTA })
    antes && engine.addLabels({ hostId: 'flota' })
    const fold = engine.addClusterFold([{ id: 'flota' }], { radius: 80, maxZoom: 18, minPoints: 2 })
    antes || engine.addLabels({ hostId: 'flota' })
    const member = miembro(engine, 'flota')
    const v      = member.version
    assert.deepEqual(idsDe(member), [6], `sólo el suelto (labels ${antes ? 'antes' : 'después'} del cluster)`)

    fold.handle.control.dispose()
    assert.ok(member.version > v, 'el recluster avisa')
    assert.deepEqual(idsDe(member), [1, 2, 3, 4, 5, 6])
    engine.destroy()
  }
})

test('la membresía `where` del host también deja sin rótulo', () => {
  const { engine } = motor()
  const flota = engine.addPointLayer({ id: 'flota', accessors: puntos, iconSet: makeIconSet(), data: FLOTA })
  engine.addLabels({ hostId: 'flota' })
  flota.setWhere(v => v.id > 4)
  assert.deepEqual(idsDe(miembro(engine, 'flota')), [5, 6])
  engine.destroy()
})

test('attachSource: los rótulos pasan a la Source nueva y dejan de oír la vieja', () => {
  const { engine } = motor()
  engine.addPointLayer({ id: 'flota', accessors: puntos, iconSet: makeIconSet(), data: FLOTA })
  engine.addLabels({ hostId: 'flota' })
  const vieja  = engine.getLayer('flota').source
  const nueva  = createSource(puntos)
  nueva.set([{ id: 'n', lat: 1, lng: 1 }])
  const member = miembro(engine, 'flota')
  const antes  = member.version
  engine.attachSource('flota', nueva)
  assert.deepEqual(idsDe(member), ['n'])
  assert.ok(member.version > antes, 'se recoloca')

  const tras = member.version
  vieja.set([{ id: 'x', lat: 0, lng: 0 }])
  assert.equal(member.version, tras, 'la vieja ya no avisa')
  nueva.set([{ id: 'n', lat: 1, lng: 1 }, { id: 'm', lat: 2, lng: 2 }])
  assert.deepEqual(idsDe(member), ['n', 'm'])
  engine.destroy()
})

test('la curva de la geodésica, en los dos órdenes, y su baja', () => {
  const { engine } = motor()
  engine.addLineLayer({ id: 'l', accessors: lineas, data: [RUTA] })
  engine.addLabels({ hostId: 'l' })
  const member = miembro(engine, 'l')
  const v0     = member.version
  assert.equal(member.curve, null)
  const off = engine.addGeodesic({ hostId: 'l' })
  assert.ok(member.curve && member.version > v0, 'la geodésica por fuera avisa al alta')
  const v1 = member.version
  off()
  assert.ok(member.curve === null && member.version > v1, 'y a la baja')

  engine.addLineLayer({ id: 'm', accessors: lineas, data: [RUTA] })
  engine.addGeodesic({ hostId: 'm' })
  engine.addLabels({ hostId: 'm' })
  assert.ok(miembro(engine, 'm').curve, 'con la geodésica por dentro, la curva ya está')
  engine.destroy()
})

test('textOf nuevo con el mismo texto no recoloca; con otro, sí', async () => {
  const { engine } = motor()
  engine.addLineLayer({ id: 'l', accessors: lineas, data: [RUTA] })
  const labels = engine.addLabels({ hostId: 'l', textOf: r => r.id })
  const member = miembro(engine, 'l')
  await frame()
  const v = member.version
  labels.update({ textOf: r => `${r.id}` })
  assert.equal(member.version, v, 'misma salida')
  labels.update({ textOf: r => `ruta ${r.id}` })
  assert.ok(member.version > v)
  const textos = []
  member.forEach((acc, item, id, text) => acc.push(text), textos)
  assert.deepEqual(textos, ['ruta R1'])
  engine.destroy()
})

test('un click en el rótulo es un click del ítem del host, con el z del rótulo', async () => {
  const { engine, container } = motor()
  engine.addLineLayer({ id: 'rutas', accessors: lineas, data: [RUTA], interactive: true })
  engine.addLabels({ hostId: 'rutas' })
  const vistos = []
  engine.on('click', hits => vistos.push(hits))
  await frame()

  clickear(container, 400, 300)
  const [hit] = vistos.at(-1)
  assert.deepEqual([hit.layerId, hit.kind, hit.id, hit.ref, hit.zIndex], ['rutas', 'line', 'R1', 'R1', LABEL_PLANE])
  engine.destroy()
})

test('un host que no es interactivo no se pica por su rótulo', async () => {
  const { engine, container } = motor()
  engine.addLineLayer({ id: 'rutas', accessors: lineas, data: [RUTA] })
  engine.addLabels({ hostId: 'rutas' })
  const vacios = []
  engine.on('map:click', e => vacios.push(e))
  await frame()
  clickear(container, 400, 300)
  assert.equal(vacios.length, 1, 'el click cae al vacío')
  engine.destroy()
})

test('el rótulo de una capa de orden bajo dentro de un polígono interactivo de orden mayor entrega su host', async () => {
  const { engine, container } = motor()
  engine.addPointLayer({ id: 'p', accessors: puntos, iconSet: makeIconSet(), data: [{ id: 'a', lat: 0, lng: 0 }], interactive: true })
  engine.addPolygonLayer({ id: 'geocerca', accessors: anillos, data: [CAJA], interactive: true })
  engine.addLabels({ hostId: 'p' })
  const vistos = []
  engine.on('click', hits => vistos.push(hits))
  await frame()

  // El ícono mide 24 px: el texto va 12 + 4 px bajo el punto, y su caja mide 10,5 px de alto.
  clickear(container, 400, 322)
  assert.deepEqual(vistos.at(-1).map(h => h.layerId), ['p', 'geocerca'], 'la geocerca también está, debajo')
  engine.destroy()
})

test('una capa base remontada veinte veces sigue bajo los rótulos; las capas HTML, encima', () => {
  const { engine, map } = motor()
  engine.addLineLayer({ id: 'l', accessors: lineas, data: [RUTA] })
  engine.addLabels({ hostId: 'l' })
  for (let i = 0; i < 20; i++) {
    engine.addLineLayer({ id: 'x', accessors: lineas, data: [RUTA] })
    engine.removeLayer('x')
  }
  engine.addLineLayer({ id: 'x', accessors: lineas, data: [RUTA] })
  engine.addHtmlLayer({ id: 'h', accessors: { ...puntos, htmlOf: () => '' }, data: [] })
  const z = name => Number(map.getPane(name).style.zIndex)
  assert.equal(z('cristae-labels'), LABEL_PLANE)
  assert.ok(z('cristae-line-x') < z('cristae-labels'))
  assert.ok(z('cristae-html-h') > z('cristae-labels'))
  assert.ok(z('cristae-html-h') >= TOP_PLANE)
  engine.destroy()
})

test('la espiral queda sobre los rótulos canvas y html; las burbujas, bajo los dos', () => {
  const z = (map, name) => Number(map.getPane(name).style.zIndex)
  const zDeHtml = []
  const real    = LABEL_RENDERERS.html
  LABEL_RENDERERS.html = ({ zIndex }) => {
    zDeHtml.push(zIndex)
    return { zIndex, attach() {}, invalidate() {}, detach() {}, hitsAt: (m, s, out) => out, destroy() {} }
  }
  try {
    const { engine, map } = motor()
    engine.addPointLayer({ id: 'flota', accessors: puntos, iconSet: makeIconSet(), data: FLOTA })
    const fold = engine.addClusterFold([{ id: 'flota' }], { radius: 80, maxZoom: 18, minPoints: 2 })
    engine.addPointLayer({ id: 'otros', accessors: puntos, iconSet: makeIconSet(), data: [{ id: 'o', lat: 1, lng: 1 }] })
    engine.addLabels({ hostId: 'otros', htmlOf: () => '<b>o</b>' })
    engine.addLabels({ hostId: 'flota' })

    const bubbleId = fold.handle.control.bubbleLayerId
    const spiderZ  = engine.getLayer(bubbleId.replace(':clusters', ':spider')).zIndex
    const canvasZ  = LABEL_PLANE
    assert.equal(zDeHtml.length, 1)
    assert.ok(zDeHtml[0] > canvasZ, 'el pane html de un host va sobre el canvas compartido')
    assert.ok(spiderZ > zDeHtml[0] && spiderZ > canvasZ, 'la espiral, sobre los dos')
    assert.ok(z(map, bubbleId.replace(':clusters', '-bubbles')) < canvasZ, 'las burbujas, bajo el canvas compartido')
    engine.destroy()
  } finally {
    LABEL_RENDERERS.html = real
  }
})

test('los planos no dependen de la declaración: base < burbujas < rótulos de burbujas < rótulos < HTML, editores y espiral', () => {
  const pane = (map, name) => Number(map.getPane(name).style.zIndex)
  const { engine, map } = motor()
  // Lo de encima se declara primero y una capa base al final: el plano manda sobre el orden.
  engine.addHtmlLayer({ id: 'h', accessors: { ...puntos, htmlOf: () => '' }, data: [] })
  engine.addEditableLayer({ id: 'editor', kind: 'polygon' })
  engine.addPointLayer({ id: 'flota', accessors: puntos, iconSet: makeIconSet(), data: FLOTA })
  const { control } = engine.addClusterFold([{ id: 'flota' }], { radius: 80, maxZoom: 18, minPoints: 2 }).handle
  const bubbleId    = control.bubbleLayerId
  engine.addLabels({ hostId: bubbleId })
  engine.addLabels({ hostId: 'flota' })
  engine.addTextLayer({ id: 'texto', accessors: puntos, data: [{ id: 't', lat: 1, lng: 1 }], htmlOf: () => '<b>t</b>' })
  engine.addLineLayer({ id: 'tarde', accessors: lineas, data: [RUTA] })
  engine.addLineLayer({ id: 'fija', accessors: lineas, data: [RUTA], z: 2_500_000 })
  const [burbuja] = engine.getLayer(bubbleId).source.getSnapshot()
  control.expand(burbuja.id)

  const capa   = sufijo => engine.getLayer(bubbleId.replace(':clusters', sufijo)).zIndex
  const orden  = [
    ['base declarada al final', engine.getLayer('tarde').zIndex],
    ['patas', capa(':legs')],
    ['burbujas', capa(':clusters')],
    ['rótulos de las burbujas', pane(map, `${bubbleId}-labels-canvas`)],
    ['canvas de rótulos', pane(map, 'cristae-labels')],
    ['pane html de la capa de texto', pane(map, 'cristae-labels-html-texto')],
    ['capa HTML declarada primero', engine.getLayer('h').zIndex],
    ['editor', engine.getLayer('editor').zIndex],
    ['espiral', capa(':spider')],
    ['sub-espiral', capa(':spider-sub')],
  ]
  for (let i = 1; i < orden.length; i++)
    assert.ok(orden[i - 1][1] < orden[i][1], `${orden[i - 1][0]} (${orden[i - 1][1]}) < ${orden[i][0]} (${orden[i][1]})`)
  assert.ok(capa(':clusters') >= CLUSTER_PLANE && capa(':clusters') < LABEL_PLANE, 'las burbujas, en el plano del cluster')
  assert.ok(engine.getLayer('h').zIndex >= TOP_PLANE, 'la capa HTML, en el de encima')

  const fija = engine.getLayer('fija').zIndex
  assert.equal(fija, 2_500_000, 'el z explícito gana sobre el plano de su kind')
  assert.ok(pane(map, 'cristae-labels-html-texto') < fija && fija < engine.getLayer('h').zIndex, 'y cae donde lo ponen')
  engine.destroy()
})

test('los panes de rótulos siguen el rango de su host: el html de la capa y el del pliegue', async () => {
  const z = (map, name) => Number(map.getPane(name).style.zIndex)
  const { engine, map } = motor()
  engine.addPointLayer({ id: 'antes', accessors: puntos, iconSet: makeIconSet(), data: [] })
  engine.addPointLayer({ id: 'flota', accessors: puntos, iconSet: makeIconSet(), data: FLOTA })
  engine.addLabels({ hostId: 'flota', htmlOf: v => `<b>${v.id}</b>` })
  const bubbleId = engine.addClusterFold([{ id: 'flota' }], { radius: 80, maxZoom: 18, minPoints: 2 }).handle.control.bubbleLayerId
  engine.addLabels({ hostId: bubbleId })
  const html     = 'cristae-labels-html-flota'
  const pliegue  = `${bubbleId}-labels-canvas`
  assert.deepEqual([z(map, html), z(map, pliegue)], [LABEL_PLANE + 20, CLUSTER_PLANE + 16], 'rango 1: html en +1, pliegue en +6')

  engine.removeLayer('antes')
  await Promise.resolve()                            // el hueco se compacta en una microtarea
  assert.deepEqual([z(map, html), z(map, pliegue)], [LABEL_PLANE + 10, CLUSTER_PLANE + 6], 'rango 0: los dos bajan con su host')
  assert.equal(engine.getLayer(bubbleId).zIndex, CLUSTER_PLANE + 5, 'sobre las burbujas, que bajan igual')
  engine.destroy()
})

test('foco por capa: con `label` en kinds se atenúan aunque el kind del host no esté; sin él, siguen al host', () => {
  const { engine } = motor()
  engine.addPointLayer({ id: 'p', accessors: puntos, iconSet: makeIconSet(), data: [{ id: 'a', lat: 0, lng: 0 }, { id: 'b', lat: 1, lng: 1 }] })
  engine.addPolygonLayer({ id: 'g', accessors: anillos, data: [CAJA] })
  engine.addLabels({ hostId: 'p' })
  const member = miembro(engine, 'p')

  engine.focus(['g'], { kinds: ['polygon', 'label'] })
  assert.equal(member.alphaOf('a'), 0.3, "'label' en kinds")
  engine.focus(['g'], { kinds: ['polygon'] })
  assert.equal(member.alphaOf('a'), 1, 'sin label y con el host fuera de kinds: el host no se atenúa, el rótulo tampoco')
  engine.focus(['g'], { kinds: ['point'], opacity: 0.5 })
  assert.equal(member.alphaOf('a'), 0.5, 'sin label, siguen al host')
  engine.focus(['p'])
  assert.equal(member.alphaOf('a'), 1, 'el host enfocado queda pleno')
  engine.unfocusAll()
  assert.equal(member.alphaOf('a'), 1)

  engine.setLayerFocus('p', ['a'])
  assert.deepEqual([member.alphaOf('a'), member.alphaOf('b')], [1, 0.3], 'por ítem, brilla lo que brilla en el host')
  engine.setLayerFocus('p', undefined)
  assert.equal(member.alphaOf('b'), 1)
  engine.destroy()
})

test('los rótulos nacen con el foco vigente', () => {
  const { engine } = motor()
  engine.addPointLayer({ id: 'p', accessors: puntos, iconSet: makeIconSet(), data: [{ id: 'a', lat: 0, lng: 0 }] })
  engine.focus(['otra'])
  engine.addLabels({ hostId: 'p' })
  assert.equal(miembro(engine, 'p').alphaOf('a'), 0.3)
  engine.destroy()
})

test('htmlOf monta el renderer html en un pane propio del host, sobre el canvas compartido', () => {
  const { engine, map } = motor()
  engine.addPointLayer({ id: 'p', accessors: puntos, iconSet: makeIconSet(), data: [{ id: 'a', lat: 0, lng: 0 }] })
  assert.ok(engine.addLabels({ hostId: 'p', htmlOf: v => `<b>${v.id}</b>` }))
  assert.ok(Number(map.getPane('cristae-labels-html-p').style.zIndex) > LABEL_PLANE)
  engine.destroy()
})
