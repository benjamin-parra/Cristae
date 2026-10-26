// `attachSource` y la visibilidad de las capas de puntos, contados por un navegador falso que respeta el techo
// de contextos de Chromium.
//
//   T1.1  La misma `source` no crea ni libera nada: `attachSource` con la que la capa ya tiene es una identidad.
//   T1.2  Otra `source` es un intercambio legítimo y la capa nueva hereda lo que la vieja tenía: la supresión
//         del cluster, el foco por ítem y el gate de visibilidad.
//   T1.3  Una capa de puntos oculta no dibuja al mover; al mostrarla pinta en la misma tarea. «Oculta» es lo que
//         el motor compone —visible ∧ habilitada—, también al nacer. Repetir el estado no repinta, y habilitar una
//         capa que cambió mientras estaba deshabilitada pinta lo nuevo, una sola vez y con la supresión puesta.
//
// Lo que cuelga del host (overlays, labels, cluster y realce) está en attach-source-colgados.test.mjs.
//
// Corre con: node --test test/engine/attach-source.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { makeEditGl, makeIconSet, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import { conNavegador, crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { createSource } from '../../src/data/index.js'

// Cada contexto lleva, además del espía del doble, lo que se le dio al uniform `uDim` (el `dim` del foco).
const conDim = () => {
  const dims = []
  return new Proxy(makeEditGl(), { get: (t, p) =>
    p === 'dims'               ? dims
    : p === 'getUniformLocation' ? (_programa, nombre) => ({ nombre })
    : p === 'uniform1f'          ? (loc, v) => loc?.nombre === 'uDim' && dims.push(v)
    : t[p] })
}

const navegador = crearNavegador({ crearGl: conDim })
after(conNavegador(navegador))

const flush = () => new Promise(r => setTimeout(r, 5))

const FLOATS = 7
const SIZE   = 6
const puntos = { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }) }
const JUNTOS = () => [[0, 0], [0, 1e-4], [1e-4, 0], [1e-4, 1e-4], [0, 2e-4]].map(([lat, lng], i) => ({ id: i + 1, lat, lng }))

const llena = (items = JUNTOS()) => {
  const source = createSource(puntos)
  source.set(items)
  return source
}

// Un motor con la capa `flota`. `gl(n)` es el contexto de la n-ésima capa que el montaje tomó.
const montar = async (cfg = {}, { cluster = false } = {}) => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  const base   = navegador.contextos.length
  engine.addPointLayer({ id: 'flota', source: llena(), iconSet: makeIconSet(), ...cfg })
  cluster && engine.addClusterFold([{ id: 'flota' }], { radius: 80, maxZoom: 18, minPoints: 2 })
  await flush()
  await flush()
  return { engine, map, gl: n => navegador.contextos[base + n].gl, ultimo: () => navegador.contextos.at(-1).gl }
}

// Los tamaños del buffer que la capa SUBIÓ a la GPU, por slot: el signo es la membresía del foco.
const signos = gl => {
  const datos = gl.spy.array.datos
  return Array.from({ length: datos.length / FLOATS }, (_, slot) => Math.sign(datos[slot * FLOATS + SIZE]))
}

/* ── T1.1 ── */

test('T1.1 attachSource con la misma source no crea ni libera, y la capa sigue siendo la misma', async () => {
  const source = llena()
  const { engine } = await montar({ source })

  const antes = navegador.stat()
  const capa  = engine.getLayer('flota').layer
  engine.attachSource('flota', source)
  engine.attachSource('flota', source)
  const despues = navegador.stat()

  assert.equal(engine.getLayer('flota').layer, capa, 'no se reconstruyó')
  assert.deepEqual(despues, antes, 'ni un contexto creado, devuelto ni vivo de más')
  engine.destroy()
})

test('T1.1 una source distinta sí es un intercambio: se reconstruye y el contexto viejo se devuelve antes de tomar el nuevo', async () => {
  const { engine } = await montar()

  const antes = navegador.stat()
  const capa  = engine.getLayer('flota').layer
  engine.attachSource('flota', llena())
  const despues = navegador.stat()

  assert.notEqual(engine.getLayer('flota').layer, capa)
  assert.equal(despues.creados - antes.creados, 1)
  assert.equal(despues.liberados - antes.liberados, 1)
  assert.equal(despues.vivos, antes.vivos, 'el recambio no sube el pico')
  assert.equal(despues.desalojados, antes.desalojados)
  engine.destroy()
})

/* ── T1.2 ── */

test('T1.2 otra source conserva la supresión del cluster: lo clusterizado no se dibuja bajo la burbuja', async () => {
  const lejos = () => [...JUNTOS(), { id: 6, lat: 40, lng: 40 }]          // cuatro juntos hacen burbuja; el sexto queda solo
  const { engine } = await montar({ source: llena(lejos()) }, { cluster: true })

  const suprimidos = engine.getLayer('flota').suppressed
  assert.ok(suprimidos?.size > 0, 'el cluster suprime puntos del host')
  const visibles = engine.getLayer('flota').layer.count
  assert.equal(visibles, lejos().length - suprimidos.size)
  assert.ok(visibles > 0, 'y deja alguno suelto')

  engine.attachSource('flota', llena(lejos()))
  assert.equal(engine.getLayer('flota').layer.count, visibles, 'la capa nueva excluye los mismos ids, sin esperar al próximo apply')
  engine.destroy()
})

test('T1.2 otra source conserva el foco por ítem: los atenuados nacen atenuados', async () => {
  const { engine, gl, ultimo } = await montar()
  engine.setLayerFocus('flota', [1, 2])
  assert.deepEqual(signos(gl(0)), [1, 1, -1, -1, -1], 'el foco está aplicado en la capa vieja')

  engine.attachSource('flota', llena())
  assert.notEqual(ultimo(), gl(0), 'es la capa nueva')
  assert.deepEqual(signos(ultimo()), [1, 1, -1, -1, -1], 'sube los tamaños ya firmados, sin pasar por un cuadro sin atenuar')
  engine.destroy()
})

test('T1.2 otra source conserva la atenuación del foco: el `dim` es el mismo', async () => {
  const { engine, gl, ultimo } = await montar()
  engine.focus(['otra'], { opacity: 0.5 })          // atenúa lo que no nombra a ese `dim`
  engine.setLayerFocus('flota', [1])
  engine.getLayer('flota').layer.redraw()
  await flush()
  assert.equal(gl(0).dims.at(-1), 0.5, 'la capa vieja dibuja con el dim del foco por capa')

  engine.attachSource('flota', llena())
  await flush()
  assert.equal(ultimo().dims.at(-1), 0.5, 'la nueva también, no el 0.3 por defecto')
  engine.destroy()
})

test('T1.2 una capa oculta que cambia de source sigue sin dibujar', async () => {
  const { engine, map, ultimo } = await montar({ visible: false })
  engine.attachSource('flota', llena())
  await flush()
  ultimo().spy.draws.length = 0
  map.fire('moveend')
  assert.equal(ultimo().spy.draws.length, 0, 'el recambio no la prende')

  engine.setLayerVisibility('flota', true)
  assert.equal(ultimo().spy.draws.length, 1, 'y al mostrarla pinta')
  engine.destroy()
})

/* ── T1.3 ── */

test('T1.3 una capa de puntos oculta hace 0 drawArrays al mover, y al mostrarla pinta en la misma tarea', async () => {
  const { engine, map, gl } = await montar()
  const { draws } = gl(0).spy
  draws.length = 0
  map.fire('moveend')
  assert.equal(draws.length, 1, 'visible, el paneo la repinta')

  engine.setLayerVisibility('flota', false)
  draws.length = 0
  map.fire('moveend')
  map.fire('moveend')
  engine.getLayer('flota').layer.redraw()
  await flush()
  assert.equal(draws.length, 0, 'oculta, ni el paneo ni un repintado agendado dibujan')

  engine.setLayerVisibility('flota', true)
  assert.equal(draws.length, 1, 'mostrada, pinta ahora y no en el cuadro siguiente')
  engine.destroy()
})

test('T1.3 al mostrarla pinta lo que hay ahora, aunque los datos hayan cambiado mientras estaba oculta', async () => {
  const source = llena()
  const { engine, gl } = await montar({ source })
  const { draws } = gl(0).spy

  engine.setLayerVisibility('flota', false)
  source.set([{ id: 9, lat: 0, lng: 0 }])
  await flush()
  draws.length = 0
  engine.setLayerVisibility('flota', true)
  assert.deepEqual(draws.map(d => d.count), [1], 'un draw, con el único punto que quedó')
  engine.destroy()
})

test('T1.3 una capa que nace oculta nunca dibuja', async () => {
  const { engine, map, gl } = await montar({ visible: false })
  const { draws } = gl(0).spy
  map.fire('moveend')
  await flush()
  assert.equal(draws.length, 0)

  engine.setLayerVisibility('flota', true)
  assert.equal(draws.length, 1, 'y al mostrarla pinta')
  engine.destroy()
})

test('T1.3 una capa deshabilitada tampoco dibuja, y al habilitarla pinta en la misma tarea', async () => {
  const { engine, map, gl } = await montar()
  const { draws } = gl(0).spy
  engine.setLayerEnabled('flota', false)
  draws.length = 0
  map.fire('moveend')
  assert.equal(draws.length, 0, 'su pane está oculto: dibujar sería trabajo perdido')

  engine.setLayerEnabled('flota', true)
  assert.ok(draws.length >= 1, 'habilitada, pinta en la misma tarea')
  await flush()
  draws.length = 0
  map.fire('moveend')
  assert.equal(draws.length, 1, 'y vuelve a seguir al mapa')
  engine.destroy()
})

test('T1.3 mandan las dos: mostrar una capa deshabilitada no la hace dibujar, ni al mostrarla ni al mover el mapa', async () => {
  const { engine, map, gl } = await montar()
  const { draws } = gl(0).spy
  engine.setLayerEnabled('flota', false)
  draws.length = 0
  engine.setLayerVisibility('flota', true)
  assert.equal(draws.length, 0, 'visible ∧ habilitada es falso')

  map.fire('moveend')
  await flush()
  assert.equal(draws.length, 0, 'y el paneo tampoco la dibuja: el gate de la entidad sigue en pie')

  engine.setLayerEnabled('flota', true)
  assert.ok(draws.length >= 1, 'habilitada, ahora sí')
  engine.destroy()
})

test('T1.3 repetir el estado no repinta: mostrar la que ya se ve, ni ocultar la que ya está oculta', async () => {
  const { engine, gl } = await montar()
  const { draws } = gl(0).spy
  draws.length = 0
  engine.setLayerVisibility('flota', true)
  engine.setLayerVisibility('flota', true)
  assert.equal(draws.length, 0, 'visible ya, no hay nada que pintar')

  engine.setLayerVisibility('flota', false)
  engine.setLayerVisibility('flota', false)
  engine.setLayerVisibility('flota', true)
  assert.equal(draws.length, 1, 'sólo pasar de oculta a visible pinta, y una vez')
  engine.destroy()
})

test('T1.3 al habilitarla pinta lo que hay ahora, aunque los datos hayan cambiado mientras estaba deshabilitada', async () => {
  const source = llena()
  const { engine, gl } = await montar({ source })
  const { draws } = gl(0).spy

  engine.setLayerEnabled('flota', false)
  source.set([{ id: 9, lat: 0, lng: 0 }])            // deshabilitada no reacciona a la Source: su buffer sigue con cinco
  await flush()
  draws.length = 0
  engine.setLayerEnabled('flota', true)
  assert.deepEqual(draws.map(d => d.count), [1], 'un draw, con el único punto que quedó y no con los cinco de antes')

  await flush()
  assert.equal(draws.length, 1, 'y ningún cuadro agendado detrás')
  engine.destroy()
})

test('T1.3 habilitar un host clusterizado pinta una sola vez, con la supresión puesta y sin un dibujo intermedio de todos los puntos', async () => {
  const lejos = () => [...JUNTOS(), { id: 6, lat: 40, lng: 40 }]
  const { engine, gl } = await montar({ source: llena(lejos()) }, { cluster: true })
  const { draws } = gl(0).spy
  const visibles = engine.getLayer('flota').layer.count
  assert.ok(visibles > 0 && visibles < lejos().length, 'el cluster suprime una parte y deja otra suelta')

  engine.setLayerEnabled('flota', false)             // deshabilitado aporta ∅ al cluster: su supresión queda vacía
  draws.length = 0
  engine.setLayerEnabled('flota', true)
  await flush()
  await flush()
  assert.deepEqual(draws.map(d => d.count), [visibles], 'un solo draw, el de la supresión vigente; no uno con los seis y otro con los sueltos')
  engine.destroy()
})

test('T1.3 el overlay ligado sigue a su host: con el host deshabilitado no dibuja, y al habilitarlo pinta en la misma tarea', async () => {
  const { engine, map, gl } = await montar()
  engine.addOverlay({ id: 'badge', hostId: 'flota', iconSet: makeIconSet() })
  await flush()
  const { draws } = gl(1).spy                       // el contexto del overlay: el segundo de la pila

  draws.length = 0
  map.fire('moveend')
  assert.equal(draws.length, 1, 'habilitado, el overlay sigue al paneo')

  engine.setLayerEnabled('flota', false)
  draws.length = 0
  map.fire('moveend')
  assert.equal(draws.length, 0, 'su pane se oculta con el host')

  engine.setLayerEnabled('flota', true)
  assert.ok(draws.length >= 1, 'y vuelve a pintar al habilitarlo')
  engine.destroy()
})

test('T1.3 un overlay que nace oculto no dibuja', async () => {
  const { engine, map, gl } = await montar()
  engine.addOverlay({ id: 'badge', hostId: 'flota', iconSet: makeIconSet(), visible: false })
  await flush()
  const { draws } = gl(1).spy
  draws.length = 0
  map.fire('moveend')
  assert.equal(draws.length, 0)

  engine.setLayerVisibility('badge', true)
  assert.equal(draws.length, 1)
  engine.destroy()
})
