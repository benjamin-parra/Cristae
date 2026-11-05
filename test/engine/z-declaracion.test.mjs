// El z por defecto de una capa sale de su lugar en el orden de declaración, no de cuándo montó. Una capa declarada antes
// que monta tarde cae debajo, remontar no la sube, el z explícito gana y ocupa lugar, las dependientes (badge, pliegue)
// siguen a su ancla, y el picking y la puerta del puntero siguen al reasiento. Las bajas no escriben z en caliente: el
// hueco se compacta en la próxima alta o en una microtarea. Contrato en SPECS §6, §7.3, §8 y §8.3.
//
// Cada capa declarada lleva su nodo en `[STACK]`, como lo hace `_placement` de los elementos. Los nodos son de un
// jsdom propio: el motor sólo los compara.

import '../../test-helpers/engine-stub.mjs'
import { conGlDeEdicion, makeEditGl, makeIconSet, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import { JSDOM } from 'jsdom'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { Interaction } from '../../src/engine/Interaction.js'
import { LayerRegistry } from '../../src/interaction/LayerRegistry.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { STACK } from '../../src/engine/stack.js'

// Las patas del pliegue y el editor toman una superficie WebGL2.
after(conGlDeEdicion(() => makeEditGl()))

// El registro de picking del motor, con resolvers que siempre aciertan: así `resolveHits` muestra sólo el orden.
let registro = null
const upsert = LayerRegistry.prototype.upsertResolver
LayerRegistry.prototype.upsertResolver = function (entry) {
  registro = this
  const acierto = () => [{ ref: entry.layerId, distancePx: 0 }]
  return upsert.call(this, { ...entry, resolveClick: acierto, resolveHover: acierto })
}
after(() => { LayerRegistry.prototype.upsertResolver = upsert })
const arriba = () => registro.resolveHits('click', {}).map(hit => hit.layerId)

const FLOTA     = [{ id: 1, lat: 0, lng: 0 }, { id: 2, lat: 0, lng: 0.0001 }, { id: 3, lat: 0.0001, lng: 0 }]
const accessors = { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }) }

// Un documento con `n` nodos en orden, conectados.
const nodos = n => {
  const { document } = new JSDOM('<!doctype html><body></body>').window
  return Array.from({ length: n }, () => document.body.appendChild(document.createElement('div')))
}

const montar = () => {
  const map    = makeMap()
  const host   = adoptLeafletHost(map, { leaflet: makeLeaflet() })
  const setZ   = []
  const write  = host.surface.setZ
  host.surface.setZ = (name, z) => { setZ.push([name, z]); return write(name, z) }
  const engine = new MapEngine({ host })
  // Cada capa oye el click: el registro sólo entrega hits de las capas con demanda en el canal.
  const punto  = (id, at, cfg) => {
    const handle = engine.addPointLayer({ id, accessors, iconSet: makeIconSet(), interactive: true, [STACK]: at, ...cfg })
    engine.on('click', id, () => {})
    return handle
  }
  // El z del pane de una capa, que tiene que coincidir con el de su record.
  const z      = id => {
    const record = engine.getLayer(id)
    const pane   = +map.getPane(record.paneName).style.zIndex
    assert.equal(pane, record.zIndex, `el pane de ${id} lleva el z de su record`)
    return pane
  }
  return { map, host, engine, punto, z, setZ }
}

const microtarea = () => Promise.resolve()

test('declarada antes y montada después queda abajo, también para el picking', () => {
  const { engine, punto, z } = montar()
  const [a, b] = nodos(2)
  punto('b', b)
  punto('a', a)

  assert.deepEqual([z('a'), z('b')], [400, 410])
  assert.deepEqual(arriba(), ['b', 'a'], 'el picking pone primero a la de arriba')
  engine.destroy()
})

test('remontar no sube: con el mismo nodo, con uno nuevo en su lugar y en las imperativas', async () => {
  const { engine, punto, z } = montar()
  const [a, b] = nodos(2)
  punto('a', a)
  punto('b', b)

  for (let i = 0; i < 5; i++) {
    engine.removeLayer('a')
    punto('a', a)
    assert.deepEqual([z('a'), z('b')], [400, 410], `vuelta ${i}`)
  }
  await microtarea()
  assert.deepEqual([z('a'), z('b')], [400, 410], 'y la microtarea no cambia nada')

  // Hijo condicional: el elemento viejo sale y uno nuevo entra en la misma posición.
  engine.removeLayer('a')
  const nuevo = a.ownerDocument.createElement('div')
  a.replaceWith(nuevo)
  punto('a', nuevo)
  assert.deepEqual([z('a'), z('b')], [400, 410], 'un nodo nuevo en el mismo lugar cae en el mismo rango')

  punto('x')
  punto('y')
  assert.deepEqual([z('x'), z('y')], [420, 430], 'las imperativas van encima, en orden de alta')
  engine.removeLayer('x')
  punto('x')
  assert.deepEqual([z('y'), z('x')], [420, 430], 'la re-alta queda sobre `y` con el z que tenía `y`: no crece')
  engine.destroy()
})

test('el explícito gana, no se mueve y ocupa rango; setLayerZ(null) vuelve al derivado actual', async () => {
  const { engine, punto, z } = montar()
  const [antes, a, p, c] = nodos(4)
  punto('a', a)
  punto('p', p, { z: 378 })
  punto('c', c)
  assert.deepEqual([z('a'), z('p'), z('c')], [400, 378, 420], 'la siguiente derivada salta el rango del explícito')

  punto('antes', antes)
  assert.deepEqual([z('a'), z('p'), z('c')], [410, 378, 430], 'una alta tardía corre a las derivadas, no al explícito')
  engine.removeLayer('antes')
  await microtarea()
  assert.deepEqual([z('a'), z('p'), z('c')], [400, 378, 420])

  engine.setLayerZ('p', null)
  assert.equal(z('p'), 410, 'sin explícito, el derivado de su rango, no el z del alta')
  engine.destroy()
})

test('el badge sigue el z efectivo de su host: derivado, explícito y tras setLayerZ', () => {
  const { engine, punto, z } = montar()
  const [antes, h, g] = nodos(3)
  punto('h', h)
  engine.addOverlay({ id: 'badge', hostId: 'h', iconSet: makeIconSet() })
  assert.equal(z('badge'), 407)

  punto('antes', antes)
  assert.deepEqual([z('h'), z('badge')], [410, 417], 'el host corre 10 y el badge con él')

  engine.setLayerZ('h', 500)
  assert.equal(z('badge'), 507, 'tras setLayerZ')

  punto('g', g, { z: 450 })
  engine.addOverlay({ id: 'badge-g', hostId: 'g', iconSet: makeIconSet() })
  assert.equal(z('badge-g'), 457, 'con un host explícito desde el alta')
  engine.destroy()
})

test('el pliegue abierto conserva su apilado interno sobre el rango de su host', () => {
  const { engine, punto, z } = montar()
  const [antes, flota] = nodos(2)
  punto('flota', flota, { data: FLOTA, interactive: false })
  const { control }  = engine.addClusterFold([{ id: 'flota' }], { radius: 80, maxZoom: 18, minPoints: 2 }).handle
  const burbujas     = control.bubbleLayerId
  const [burbuja]    = engine.getLayer(burbujas).source.getSnapshot()
  control.expand(burbuja.id)
  const ids          = ['legs', 'clusters', 'spider', 'spider-sub'].map(sufijo => burbujas.replace(':clusters', `:${sufijo}`))
  const apilado      = () => ids.map(z)

  assert.deepEqual(apilado(), [604, 605, 607, 608], 'patas < burbujas < espiral < sub-espiral, sobre los labels')
  punto('antes', antes)
  assert.equal(z('flota'), 410)
  assert.deepEqual(apilado(), [614, 615, 617, 618], 'y siguen al host cuando cambia de rango')
  engine.destroy()
})

test('el picking y la puerta del puntero siguen al reasiento y a setLayerZ', () => {
  const corridos = []
  const restack  = Interaction.prototype.restack
  Interaction.prototype.restack = function (participant, zIndex, order) {
    corridos.push([zIndex, order])
    return restack.call(this, participant, zIndex, order)
  }
  try {
    const { engine, punto, z } = montar()
    const [a, b, e] = nodos(3)
    punto('b', b)
    engine.addEditableLayer({ id: 'editor', kind: 'polygon', [STACK]: e })
    assert.equal(z('editor'), 610)

    punto('a', a)
    assert.deepEqual(arriba(), ['b', 'a'], 'el registro tiene el z nuevo de `b`')
    assert.equal(z('editor'), 620)
    assert.deepEqual(corridos.at(-1), [620, 2], 'la puerta reubica al participante con su z y su rango')

    engine.setLayerZ('a', 900)
    assert.deepEqual(arriba(), ['a', 'b'], 'setLayerZ también llega al picking')
    engine.setLayerZ('editor', 950)
    assert.deepEqual(corridos.at(-1), [950, 2], 'y a la puerta')
    engine.destroy()
  } finally {
    Interaction.prototype.restack = restack
  }
})

test('un explícito dentro del tramo de los derivados se cruza con ellos en vivo', async () => {
  const { engine, punto, z } = montar()
  const [hoja, a, p] = nodos(3)
  punto('a', a)
  punto('p', p, { z: 405 })
  assert.ok(z('a') < z('p'))

  punto('hoja', hoja)
  assert.deepEqual([z('a'), z('p')], [410, 405], 'la alta tardía de una hoja anterior pone a `a` sobre `p`')
  engine.removeLayer('hoja')
  await microtarea()
  assert.deepEqual([z('a'), z('p')], [400, 405], 'y su baja la devuelve abajo')
  engine.destroy()
})

test('las bajas no escriben z en caliente: remontar cuesta 0 escrituras y un lote, un pase', async () => {
  const { engine, punto, z, setZ } = montar()
  const ns = nodos(5)
  ns.forEach((n, i) => punto(`n${i}`, n))
  assert.equal(setZ.length, 0, 'montar en orden no reasienta nada')

  engine.removeLayer('n0')
  punto('n0', ns[0])
  assert.equal(setZ.length, 0, 'baja y alta del mismo nodo en la misma tarea')
  await microtarea()
  assert.equal(setZ.length, 0, 'ni después')

  engine.removeLayer('n0')
  engine.removeLayer('n1')
  assert.deepEqual(['n2', 'n3', 'n4'].map(z), [420, 430, 440], 'hasta la microtarea, el hueco queda')
  assert.equal(setZ.length, 0)
  await microtarea()
  assert.deepEqual(['n2', 'n3', 'n4'].map(z), [400, 410, 420], 'y se compacta en un pase')
  assert.equal(setZ.length, 3, 'una escritura por capa corrida')
  engine.destroy()
})

test('el hueco se abre antes de construir, y una construcción que lanza no deja su rango', async () => {
  const { map, engine, punto, z } = montar()
  const [a, n, b, c] = nodos(4)
  punto('a', a)
  punto('b', b)

  const vistos = []
  const create = map.createPane
  map.createPane = name => {
    vistos.push([name, z('b')])
    return create(name)
  }
  punto('n', n)
  map.createPane = create
  assert.deepEqual(vistos, [['cristae-point-n', 420]], 'al montarse el pane de la nueva, la vecina ya está corrida')
  assert.deepEqual([z('n'), z('b')], [410, 420], 'y la nueva nace con su z final')

  engine.removeLayer('n')
  await microtarea()
  const rampa = () => { throw new Error('rampa') }
  assert.throws(() => engine.addHeatLayer({ id: 'calor', accessors, colorRamp: rampa, [STACK]: n }), /rampa/)
  assert.equal(z('b'), 420, 'la vecina queda corrida hasta la microtarea')
  await microtarea()
  assert.equal(z('b'), 410, 'y vuelve')
  punto('c', c)
  assert.equal(z('c'), 420, 'la alta siguiente no ve el rango de la que lanzó')
  engine.destroy()
})

test('un pane compartido toma el z del miembro de mayor rango, sin importar el orden de alta', async () => {
  for (const orden of [['p1', 'p2'], ['p2', 'p1']]) {
    const { map, engine, punto } = montar()
    const [n1, n2] = nodos(2)
    const cfg      = { p1: [n1, { pane: 'comun', z: 500 }], p2: [n2, { pane: 'comun', z: 450 }] }
    orden.forEach(id => punto(id, ...cfg[id]))
    const zComun = () => +map.getPane('comun').style.zIndex

    assert.equal(zComun(), 450, `alta ${orden.join(', ')}: manda p2, declarada después`)
    assert.deepEqual(arriba(), ['p1', 'p2'], 'el picking sigue usando el z de cada capa')
    engine.removeLayer('p2')
    await microtarea()
    assert.equal(zComun(), 500, 'al irse, manda el siguiente')
    engine.destroy()
  }
})

test('un alta con un id que sigue montado corre a las que estaban entre su rango viejo y el nuevo', () => {
  const { engine, punto, z } = montar()
  const [a, b, c, d] = nodos(4)
  punto('a', a)
  punto('b', b)
  punto('c', c)

  punto('a', d)
  assert.deepEqual([z('b'), z('c'), z('a')], [400, 410, 420], 'sin dos capas en el mismo z')
  engine.destroy()
})
