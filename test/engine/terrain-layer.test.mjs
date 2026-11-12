// addTerrainLayer: el alta con preset y con objeto, la validación, el orden de declaración, que la capa no se pique, el
// `clipTo` resuelto por id en cualquier orden, los eventos por la vía de los datos y la baja. El dem es un mundo de
// teselas sin red (test-helpers/terreno.mjs) y el GL, el doble de la superficie de edición.
// Corre con: node --test test/engine/terrain-layer.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { conGlDeEdicion, makeEditGl, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import { conNavegador, crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import { hasta } from '../../test-helpers/datos-remotos.mjs'
import { latDe, lngDe, mundo } from '../../test-helpers/terreno.mjs'
import { after, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

after(conNavegador(crearNavegador({ crearGl: () => makeEditGl() })))
after(conGlDeEdicion(() => makeEditGl()))

// Tesela de 64 px al zoom 14, y un viewport de 800 × 600 al zoom 17 sobre un punto de su grilla.
const DEM  = { url: 'https://t.test/{z}/{x}/{y}.png', encoding: 'terrarium', zoom: 14, tileSize: 64 }
const PX   = 4869 * 64 + 20
const PY   = 10007 * 64 + 20
const LAT  = latDe(PY)
const LNG  = lngDe(PX)
const ZOOM = 17

const rings   = { idOf: i => i.id, ringsOf: i => i.rings }
const puntos  = { idOf: i => i.id, positionOf: i => ({ lat: i.lat, lng: i.lng }) }
const cuadro  = (lat, lng, d) => [[lat, lng], [lat, lng + d], [lat + d, lng + d], [lat + d, lng], [lat, lng]]
const PREDIO  = { id: 'p', rings: [cuadro(LAT - 0.0005, LNG - 0.0005, 0.001)] }

const montar = () => {
  const map = makeMap({ zoom: ZOOM })
  map._center = { lat: LAT, lng: LNG }
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  const eventos = { load: [], error: [] }
  engine.on('dataload', d => eventos.load.push(d))
  engine.on('dataerror', d => eventos.error.push(d))
  return { engine, eventos, map, world: mundo({ h: () => 500, lado: 64 }) }
}

// El alta con el fetch del mundo. Resuelve cuando llegó el primer mosaico.
const conTerreno = async (extra = {}) => {
  const esc = montar()
  const handle = esc.engine.addTerrainLayer({ id: 't', dem: DEM, fetch: esc.world.fetch, ...extra })
  await hasta(() => esc.eventos.load.length || esc.eventos.error.length)
  return { ...esc, handle }
}

test('el alta con un preset por nombre y con un objeto devuelve el handle y deja el record', async () => {
  const { engine, handle, eventos } = await conTerreno()
  assert.deepEqual(Object.keys(handle).sort(), ['elevationAt', 'id', 'measure', 'setOpacity', 'setVisible', 'update'])
  assert.equal(handle.id, 't')
  assert.equal(engine.getLayer('t').kind, 'terrain')
  assert.equal(eventos.load[0].layerId, 't')

  const preset = engine.addTerrainLayer({ id: 'aws', dem: 'aws', fetch: montar().world.fetch })
  assert.equal(engine.getLayer('aws').kind, 'terrain')
  assert.equal(engine.getLayer('aws').paneName, 'cristae-terrain-aws')
  assert.equal(typeof preset.update, 'function')
  engine.destroy()
})

test('sin dem es TypeError y no queda una capa a medias', () => {
  const { engine } = montar()
  assert.throws(() => engine.addTerrainLayer({ id: 't' }), TypeError)
  assert.throws(() => engine.addTerrainLayer({ id: 't', dem: 'no-existe' }), TypeError)
  assert.equal(engine.getLayer('t'), null)
  engine.destroy()
})

test('update inválido lanza TypeError y no cambia nada; uno válido reestila', async () => {
  const { engine, handle } = await conTerreno()
  const capa = engine.getLayer('t').layer
  const configure = mock.method(capa, 'configure')

  assert.throws(() => handle.update({ colorBy: 'otro' }), TypeError)
  assert.throws(() => handle.update({ slopeBreaks: [0.3, 0.1] }), TypeError)
  assert.throws(() => handle.update({ id: 'x' }), TypeError)
  assert.equal(configure.mock.callCount(), 0, 'la capa no se tocó')

  handle.update({ colorBy: 'slope', slopeBreaks: [0.1, 0.3] })
  assert.equal(configure.mock.callCount(), 1)
  assert.equal(configure.mock.calls[0].arguments[0].colorBy, 'slope')
  assert.equal(configure.mock.calls[0].arguments[0].dem.url, DEM.url, 'dem es la fuente resuelta')
  engine.destroy()
})

test('el orden de declaración da el z de la capa entre las demás', () => {
  const { engine, world } = montar()
  engine.addPolygonLayer({ id: 'abajo', accessors: rings, data: [PREDIO] })
  engine.addTerrainLayer({ id: 't', dem: DEM, fetch: world.fetch })
  engine.addPolygonLayer({ id: 'arriba', accessors: rings, data: [PREDIO] })
  const z = id => engine.getLayer(id).zIndex
  assert.ok(z('abajo') < z('t') && z('t') < z('arriba'), `${z('abajo')} < ${z('t')} < ${z('arriba')}`)
  engine.destroy()
})

test('la capa no se pica: ni resolver en el registro ni hit en on(click)', async () => {
  const { engine, map } = await conTerreno()
  engine.addPolygonLayer({ id: 'predios', accessors: rings, data: [PREDIO] })
  const clicks = []
  engine.on('click', hits => clicks.push(hits))
  assert.equal(engine.getLayer('t').layer.resolveClick, undefined)
  assert.equal(engine.getLayer('t').layer.resolveHover, undefined)
  assert.equal(engine.pickLayerOf(1), null)

  await new Promise(r => setTimeout(r, 5))
  map.getContainer().emitir('pointerdown', { clientX: 400, clientY: 300 })
  map.getContainer().emitir('pointerup', { clientX: 400, clientY: 300 })
  assert.ok(clicks.every(hits => !JSON.stringify(hits ?? []).includes('"t"')), 'ningún hit del terreno')
  engine.destroy()
})

/* ── clipTo ── */

// Lo que la capa de terreno recibió como recorte, espiando su setClip.
const espiarClip = (engine, id = 't') => mock.method(engine.getLayer(id).layer, 'setClip')
const ultimo = espia => espia.mock.calls.at(-1).arguments[0]

test('clipTo declarado antes del polígono espera y entrega las tablas cuando llega', async () => {
  const { engine, world } = montar()
  const handle = engine.addTerrainLayer({ id: 't', dem: DEM, fetch: world.fetch, clipTo: 'predios' })
  const clip = espiarClip(engine)
  engine.addPolygonLayer({ id: 'predios', accessors: rings, data: [PREDIO] })
  assert.equal(clip.mock.callCount(), 1)
  const tablas = ultimo(clip)
  assert.equal(tablas.partCount, 1)
  assert.equal(tablas.ringCount, 1)
  assert.equal(handle.id, 't')
  engine.destroy()
})

test('clipTo declarado después del polígono lo resuelve en el alta', () => {
  const { engine, world } = montar()
  engine.addPolygonLayer({ id: 'predios', accessors: rings, data: [PREDIO] })
  const capa = engine.addTerrainLayer({ id: 't', dem: DEM, fetch: world.fetch, clipTo: 'predios' })
  assert.ok(capa)
  assert.equal(engine.getLayer('t').terrain.clipSource, engine.getLayer('predios').source, 'sigue la Source del destino')
  engine.destroy()
})

test('un destino sin partes todavía deja el recorte en pending, y un cambio de su Source lo rehace', async () => {
  const { engine, world } = montar()
  const predios = engine.addPolygonLayer({ id: 'predios', accessors: rings, data: [] })
  engine.addTerrainLayer({ id: 't', dem: DEM, fetch: world.fetch, clipTo: 'predios' })
  const clip = espiarClip(engine)
  predios.set([PREDIO])
  await hasta(() => clip.mock.callCount() >= 1)
  assert.equal(ultimo(clip).partCount, 1)
  predios.set([PREDIO, { id: 'q', rings: [cuadro(LAT, LNG, 0.0002)] }])
  await hasta(() => clip.mock.callCount() >= 2)
  assert.equal(ultimo(clip).partCount, 2, 'cada cambio de la Source del destino rehace el recorte')
  predios.set([])
  await hasta(() => clip.mock.callCount() >= 3)
  assert.equal(ultimo(clip), 'pending')
  engine.destroy()
})

test('la ruta de tablas del destino entrega sus tablas tal cual', () => {
  const { engine, world } = montar()
  const tablas = {
    xy: Float64Array.of(LNG, LAT, LNG + 0.001, LAT, LNG + 0.001, LAT + 0.001, LNG, LAT),
    vertexAt: Uint32Array.of(0, 4), ringAt: Uint32Array.of(0, 1), closed: Uint8Array.of(1), ringCount: 1, partCount: 1,
    owner: Uint32Array.of(0),
  }
  engine.addPolygonLayer({ id: 'predios', geometry: tablas })
  engine.addTerrainLayer({ id: 't', dem: DEM, fetch: world.fetch, clipTo: 'predios' })
  const clip = espiarClip(engine)
  engine.addPolygonLayer({ id: 'otro', geometry: tablas })
  assert.equal(clip.mock.callCount(), 0, 'otra capa no toca el recorte')
  engine.removeLayer('predios')
  assert.equal(ultimo(clip), 'pending')
  engine.destroy()
})

test('la baja del destino devuelve el terreno a pending y la nueva alta lo recorta de nuevo', () => {
  const { engine, world } = montar()
  engine.addPolygonLayer({ id: 'predios', accessors: rings, data: [PREDIO] })
  engine.addTerrainLayer({ id: 't', dem: DEM, fetch: world.fetch, clipTo: 'predios' })
  const clip = espiarClip(engine)
  engine.removeLayer('predios')
  assert.equal(ultimo(clip), 'pending')
  assert.equal(engine.getLayer('t').terrain.clipSource, null, 'suelta la suscripción')
  engine.addPolygonLayer({ id: 'predios', accessors: rings, data: [PREDIO] })
  assert.equal(ultimo(clip).partCount, 1)
  engine.destroy()
})

test('un destino que no es de polígonos avisa una vez por par y deja pending', () => {
  const { engine, world } = montar()
  const avisos = mock.method(console, 'warn', () => {})
  engine.addPointLayer({ id: 'flota', accessors: puntos, data: [{ id: 'a', lat: 1, lng: 2 }] })
  const capa = engine.addTerrainLayer({ id: 't', dem: DEM, fetch: world.fetch, clipTo: 'flota' })
  const clip = espiarClip(engine)
  capa.update({ opacity: 0.5, clipTo: 'flota' })
  engine.removeLayer('flota')
  engine.addPointLayer({ id: 'flota', accessors: puntos, data: [{ id: 'a', lat: 1, lng: 2 }] })
  assert.equal(avisos.mock.calls.filter(c => /no es de polígonos/.test(c.arguments[0])).length, 1)
  assert.ok(clip.mock.calls.every(c => c.arguments[0] === 'pending'))
  avisos.mock.restore()
  engine.destroy()
})

test('update de clipTo rebinda el recorte, y sin clipTo lo quita', () => {
  const { engine, world } = montar()
  engine.addPolygonLayer({ id: 'predios', accessors: rings, data: [PREDIO] })
  const capa = engine.addTerrainLayer({ id: 't', dem: DEM, fetch: world.fetch })
  const clip = espiarClip(engine)
  capa.update({ clipTo: 'predios' })
  assert.equal(ultimo(clip).partCount, 1)
  capa.update({ clipTo: 'predios', contours: 10 })
  assert.equal(clip.mock.callCount(), 1, 'sin cambio de clipTo no se rehace')
  assert.throws(() => capa.update({ clipTo: '' }), TypeError)
  engine.destroy()
})

/* ── Eventos y baja ── */

test('dataload sale con layerId, url y count por la vía de los datos', async () => {
  const { eventos } = await conTerreno()
  assert.equal(eventos.load.length, 1)
  assert.deepEqual(Object.keys(eventos.load[0]).sort(), ['count', 'layerId', 'url'])
  assert.equal(eventos.load[0].url, DEM.url)
  assert.ok(eventos.load[0].count > 0)
})

test('un 403 sale como dataerror con código y status', async () => {
  const esc = montar()
  const fetch = async (url, init) => ({ ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0), url, init })
  esc.engine.addTerrainLayer({ id: 't', dem: DEM, fetch })
  await hasta(() => esc.eventos.error.length)
  const [error] = esc.eventos.error
  assert.equal(error.layerId, 't')
  assert.equal(error.code, 'forbidden')
  assert.equal(error.status, 403)
  assert.equal(typeof error.message, 'string')
  assert.equal(esc.eventos.load.length, 0)
  esc.engine.destroy()
})

test('sin oyentes de dataerror el fallo se vuelca a la consola una sola vez', async () => {
  const map = makeMap({ zoom: ZOOM })
  map._center = { lat: LAT, lng: LNG }
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  const consola = mock.method(console, 'error', () => {})
  const fetch = async () => ({ ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) })
  const capa = engine.addTerrainLayer({ id: 't', dem: DEM, fetch })
  await hasta(() => consola.mock.callCount() > 0)
  capa.update({ dem: { ...DEM, zoom: 13 } })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(consola.mock.callCount(), 1)
  assert.match(consola.mock.calls[0].arguments[0], /la capa 't' no cargó/)
  consola.mock.restore()
  engine.destroy()
})

test('removeLayer aborta la carga en vuelo, suelta el recorte y no deja la capa', async () => {
  const esc = montar()
  const senales = []
  const fetch = (url, { signal }) => new Promise((_, rechazar) => {
    senales.push(signal)
    signal.addEventListener('abort', () => rechazar(signal.reason), { once: true })
  })
  esc.engine.addPolygonLayer({ id: 'predios', accessors: rings, data: [PREDIO] })
  esc.engine.addTerrainLayer({ id: 't', dem: DEM, fetch, clipTo: 'predios' })
  await hasta(() => senales.length)
  assert.ok(senales.every(s => !s.aborted))

  assert.equal(esc.engine.removeLayer('t'), true)
  assert.ok(senales.every(s => s.aborted), 'el fetch registró el abort')
  assert.equal(esc.engine.getLayer('t'), null)
  assert.equal(esc.engine.removeLayer('t'), false)
  esc.engine.destroy()
  assert.equal(esc.eventos.error.length, 0, 'abortar no es un error')
})

test('un handle de una capa quitada no hace nada', async () => {
  const { engine, handle } = await conTerreno()
  engine.removeLayer('t')
  assert.doesNotThrow(() => handle.update({ opacity: 0.2 }))
  engine.destroy()
})

test('setVisible y setOpacity pasan por el motor', async () => {
  const { engine, handle } = await conTerreno()
  const visible = mock.method(engine, 'setLayerVisibility')
  const opacidad = mock.method(engine, 'setLayerOpacity')
  handle.setVisible(false)
  handle.setOpacity(0.4)
  assert.deepEqual(visible.mock.calls[0].arguments, ['t', false])
  assert.equal(opacidad.mock.calls.length, 0, 'la opacidad es del uniforme, no del pane')
  engine.destroy()
})

test('elevationAt es síncrona: NaN sin mosaico y la altura del dem con él', async () => {
  const { engine, handle } = await conTerreno()
  assert.ok(Math.abs(handle.elevationAt({ lat: LAT, lng: LNG }) - 500) < 1)
  const sin = montar().engine.addTerrainLayer({ id: 'u', dem: DEM, fetch: () => new Promise(() => {}) })
  assert.ok(Number.isNaN(sin.elevationAt({ lat: LAT, lng: LNG })))
  engine.destroy()
})
