// `attachSource` con otra fuente y lo que cuelga del host. La capa se reemplaza y conserva lo suyo (attach-source.test.mjs);
// lo que mira la Source del host desde afuera tiene que seguirla, o queda leyendo la vieja: un badge con los datos de
// antes, un cluster que no re-indexa, un realce que dibuja un ítem que ya no existe.
//
//   T1.4  El overlay ligado, el label ligado, el cluster que envuelve al host y el realce de interacción pasan a la
//         fuente nueva: leen sus ítems, oyen sus cambios y dejan de oír a la vieja. Ninguna suscripción queda atrás.
//   T1.5  El overlay nuevo conserva lo suyo: sus accessors de badge, su membresía, su supresión, su foco, su
//         visibilidad y el gate de su host deshabilitado. El recambio no sube el pico de contextos.
//
// Corre con: node --test test/engine/attach-source-colgados.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { makeIconSet, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import { conNavegador, crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { createSource } from '../../src/data/index.js'

const navegador = crearNavegador()
after(conNavegador(navegador))

const flush = () => new Promise(r => setTimeout(r, 5))

const FLOATS = 7
const SIZE   = 6
const puntos = { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }) }
const gruesos = { ...puntos, sizeOf: it => it.size }

// Ítems de `n` en `n`, con ids desde `desde`. Los de `juntos` quedan a un metro: un cluster los agrupa. El resto, lejos.
const juntos = (desde, n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: desde + i, lat: i * 1e-4, lng: i * 1e-4, ...extra }))
const lejos  = (desde, n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: desde + i, lat: 10 + i * 10, lng: 10 + i * 10, ...extra }))

// Una Source de la casa que cuenta sus suscripciones vivas desde que nace: `vivas()` es lo que la oye hoy. Lo que quede
// oyendo a la fuente vieja después del recambio es una fuga.
const fuente = (items, accessors = puntos) => {
  const source    = createSource(accessors)
  const suscribir = source.subscribe
  let vivas = 0
  source.subscribe = notificar => {
    vivas++
    const baja = suscribir(notificar)
    return () => { vivas--; baja() }
  }
  source.vivas = () => vivas
  source.set(items)
  return source
}

// Un motor con la capa `flota` y, si se pide, un cluster que la envuelve.
const montar = async (cfg, { cluster = false } = {}) => {
  const map    = makeMap()
  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: makeLeaflet() }) })
  const flota  = engine.addPointLayer({ id: 'flota', iconSet: makeIconSet(), ...cfg })
  const fold   = cluster ? engine.addClusterFold([{ id: 'flota' }], { radius: 80, maxZoom: 18, minPoints: 2 }) : null
  await flush()
  await flush()
  return { engine, map, flota, fold }
}

const glDe     = (engine, id) => engine.getLayer(id).layer.surface.gl
const idsDe    = layer => Array.from({ length: layer.count }, (_, slot) => layer.idForSlot(slot)).sort((a, b) => a - b)
const signos   = gl => Array.from({ length: gl.spy.array.datos.length / FLOATS }, (_, slot) => Math.sign(gl.spy.array.datos[slot * FLOATS + SIZE]))
const tamanios = gl => Array.from({ length: gl.spy.array.datos.length / FLOATS }, (_, slot) => gl.spy.array.datos[slot * FLOATS + SIZE])

/* ── T1.4: lo que cuelga del host sigue a la fuente nueva ── */

test('T1.4 el overlay ligado lee la fuente nueva, oye sus cambios y deja de oír a la vieja', async () => {
  const vieja = fuente(juntos(1, 3, { badge: true }))
  const nueva = fuente([...lejos(101, 3, { badge: true }), ...lejos(104, 2, { badge: false })])
  const { engine } = await montar({ source: vieja })
  const badge = engine.addOverlay({ id: 'badge', hostId: 'flota', iconSet: makeIconSet(), where: it => it.badge })
  await flush()
  assert.deepEqual(idsDe(badge.layer), [1, 2, 3])
  const antes = navegador.stat()
  assert.equal(vieja.vivas(), 2, 'la oyen la capa del host y el overlay')

  engine.attachSource('flota', nueva)
  assert.equal(badge.source, nueva, 'el handle del overlay expone la fuente que lee')
  assert.deepEqual(idsDe(badge.layer), [101, 102, 103], 'los ítems de la nueva que pasan su where, no los de antes')
  assert.equal(engine.getLayer('flota').layer.count, 5)

  nueva.set([...lejos(101, 3, { badge: true }), { id: 110, lat: 5, lng: 5, badge: true }])
  await flush()
  assert.deepEqual(idsDe(badge.layer), [101, 102, 103, 110], 'oye los cambios de la nueva')

  vieja.set([])
  await flush()
  assert.deepEqual(idsDe(badge.layer), [101, 102, 103, 110], 'y los de la vieja ya no le llegan')
  assert.equal(vieja.vivas(), 0, 'nada queda suscrito a la fuente vieja')
  assert.equal(nueva.vivas(), 2, 'la nueva la oyen la capa y el overlay')

  const despues = navegador.stat()
  assert.equal(despues.vivos, antes.vivos, 'el recambio de las dos capas no sube el pico de contextos')
  assert.equal(despues.desalojados, antes.desalojados)
  engine.destroy()
})

test('T1.4 el overlay conserva sus accessors propios y su membresía, y el handle sigue operando sobre la capa nueva', async () => {
  const vieja = fuente(juntos(1, 4, { badge: true, size: 24 }), gruesos)
  const nueva = fuente(lejos(101, 4, { badge: true, size: 24 }), gruesos)
  const { engine, flota } = await montar({ source: vieja })
  const badge = engine.addOverlay({ id: 'badge', hostId: 'flota', iconSet: makeIconSet(), where: it => it.badge, sizeOf: () => 10 })
  await flush()
  assert.deepEqual(tamanios(glDe(engine, 'badge')), [10, 10, 10, 10], 'el badge se dibuja con su sizeOf, no con el del host')

  engine.attachSource('flota', nueva)
  assert.notEqual(badge.layer, engine.getLayer('flota').layer)
  assert.deepEqual(tamanios(glDe(engine, 'badge')), [10, 10, 10, 10], 'la capa nueva del badge sigue con su sizeOf')
  assert.deepEqual(tamanios(glDe(engine, 'flota')), [24, 24, 24, 24], 'y el host, con el suyo')

  const abiertos = new Set([102])
  badge.setWhere(it => abiertos.has(it.id))
  assert.deepEqual(idsDe(badge.layer), [102], 'setWhere compone con la membresía del host sobre la capa nueva')
  abiertos.add(103)                                       // cambia afuera, sin avisar a nadie
  badge.refresh()
  assert.deepEqual(idsDe(badge.layer), [102, 103], 'refresh rehace la capa nueva, no la que se soltó')

  badge.setWhere(null)
  assert.deepEqual(idsDe(badge.layer), [101, 102, 103, 104])
  flota.setWhere(it => it.id > 101)
  assert.deepEqual(idsDe(badge.layer), [102, 103, 104], 'y la membresía del host la arrastra, sin que nadie la espeje')
  engine.destroy()
})

test('T1.4 el label ligado rotula con la fuente nueva, oye sus cambios y deja de oír a la vieja', async () => {
  const vieja = fuente(juntos(1, 3))
  const nueva = fuente(lejos(101, 4))
  const { engine } = await montar({ source: vieja })
  engine.addLabelLayer({ id: 'rotulos', bindTo: 'flota', textOf: it => `v${it.id}` })
  const capa = engine.getLayer('rotulos').layer
  const real = capa.setLabels.bind(capa)
  const capturas = []
  capa.setLabels = labels => { capturas.push(labels.map(l => l.id).sort((a, b) => a - b)); return real(labels) }
  await flush()
  assert.equal(vieja.vivas(), 2, 'la oyen la capa del host y el label')

  engine.attachSource('flota', nueva)
  assert.deepEqual(capturas.at(-1), [101, 102, 103, 104], 'rotula los ítems de la nueva')
  assert.equal(vieja.vivas(), 0)
  assert.equal(nueva.vivas(), 2, 'la nueva la oyen la capa y el label')

  nueva.set(lejos(201, 2))
  await flush()
  assert.deepEqual(capturas.at(-1), [201, 202], 'y oye sus cambios')

  const n = capturas.length
  vieja.set(juntos(1, 5))
  await flush()
  assert.equal(capturas.length, n, 'los de la vieja ya no lo despiertan')
  engine.destroy()
})

test('T1.4 el cluster re-indexa sobre los ids de la fuente nueva, oye sus cambios y deja de oír a la vieja', async () => {
  const vieja = fuente([...juntos(1, 4), ...lejos(5, 1)])
  const nueva = fuente([...juntos(101, 4), ...lejos(105, 1)])
  const { engine, fold } = await montar({ source: vieja }, { cluster: true })
  const burbujas = () => engine.getLayer(fold.handle.control.bubbleLayerId).layer.count
  const host = () => engine.getLayer('flota')
  assert.deepEqual([...host().suppressed].sort((a, b) => a - b), [1, 2, 3, 4])
  assert.equal(burbujas(), 1)
  assert.equal(vieja.vivas(), 2, 'la oyen la capa del host y el cluster')

  engine.attachSource('flota', nueva)
  assert.deepEqual([...host().suppressed].sort((a, b) => a - b), [101, 102, 103, 104], 'la supresión es sobre los ids nuevos, sin esperar a que la fuente nueva emita')
  assert.deepEqual(idsDe(host().layer), [105], 'y la capa nueva dibuja sólo el suelto')
  assert.equal(burbujas(), 1)

  nueva.set(lejos(201, 5))                                // ítems nuevos y sin nada cerca: ya no hay cluster
  await flush()
  await flush()
  assert.equal(host().suppressed.size, 0, 'oye los cambios de la nueva y recalcula la supresión')
  assert.equal(burbujas(), 0)
  assert.deepEqual(idsDe(host().layer), [201, 202, 203, 204, 205])

  assert.equal(vieja.vivas(), 0, 'ninguna suscripción del cluster queda en la fuente vieja')
  assert.equal(nueva.vivas(), 2, 'la nueva la oyen la capa y el cluster')

  vieja.set(juntos(1, 5))                                 // si el cluster la siguiera oyendo, re-indexaría
  await flush()
  await flush()
  assert.equal(host().suppressed.size, 0)
  assert.equal(burbujas(), 0)
  engine.destroy()
})

test('T1.4 el cluster indexa con los accessors de la fuente nueva: otra forma de ítem, otros ids', async () => {
  const otros = { idOf: it => it.clave, positionOf: it => ({ lat: it.y, lng: it.x }) }
  const vieja = fuente([...juntos(1, 4), ...lejos(5, 1)])
  const nueva = fuente([...juntos(0, 4), ...lejos(4, 1)].map(({ id, lat, lng }) => ({ clave: `v${id}`, y: lat, x: lng })), otros)
  const { engine } = await montar({ source: vieja }, { cluster: true })
  assert.equal(engine.getLayer('flota').suppressed.size, 4)

  engine.attachSource('flota', nueva)
  assert.deepEqual([...engine.getLayer('flota').suppressed].sort(), ['v0', 'v1', 'v2', 'v3'], 'agrupó por la clave y la posición de la fuente nueva')
  assert.deepEqual(idsDe(engine.getLayer('flota').layer), ['v4'])
  engine.destroy()
})

test('T1.4 el cluster, al destruirse tras el recambio, suelta la suscripción de la fuente nueva', async () => {
  const nueva = fuente([...juntos(101, 4), ...lejos(105, 1)])
  const { engine, fold } = await montar({ source: fuente(juntos(1, 3)) }, { cluster: true })
  engine.attachSource('flota', nueva)
  assert.equal(nueva.vivas(), 2)

  fold.handle.control.dispose()
  assert.equal(nueva.vivas(), 1, 'queda sólo la de la capa del host')
  engine.destroy()
  assert.equal(nueva.vivas(), 0)
})

test('T1.4 el realce de interacción dibuja con la fuente nueva —su ítem y su tamaño—, la oye y deja de oír a la vieja', async () => {
  const vieja = fuente(juntos(1, 3, { tag: 'vieja' }))
  const nueva = fuente(juntos(1, 3, { tag: 'nueva', size: 40 }), gruesos)
  const { engine } = await montar({ source: vieja })
  const dibujos = []
  const realce = engine.addHighlightOverlay({
    id: 'hl', layerId: 'flota', drawHighlight: (_ctx, size, key, item) => dibujos.push({ key, size, tag: item.tag }),
  })
  realce.setHighlighted(new Map([[2, 'sel']]))
  await flush()
  assert.deepEqual(dibujos.at(-1), { key: 'sel', size: 24, tag: 'vieja' })
  assert.equal(vieja.vivas(), 2, 'la oyen la capa del host y el realce')

  engine.attachSource('flota', nueva)
  await flush()
  assert.deepEqual(dibujos.at(-1), { key: 'sel', size: 40, tag: 'nueva' }, 'redibuja con el ítem y el sizeOf de la nueva')
  assert.equal(vieja.vivas(), 0)
  assert.equal(nueva.vivas(), 2, 'la nueva la oyen la capa y el realce')

  let n = dibujos.length
  nueva.move(2, 5, 5)                                     // un resaltado que se mueve en la nueva
  await flush()
  assert.ok(dibujos.length > n, 'el realce acompaña a su sprite en la fuente nueva')

  n = dibujos.length
  vieja.move(2, 9, 9)
  await flush()
  assert.equal(dibujos.length, n, 'y lo que pase en la vieja no lo mueve')

  realce.destroy()
  assert.equal(nueva.vivas(), 1, 'destruido, suelta la suscripción de la fuente nueva')
  engine.destroy()
})

test('T1.4 cada pieza que cuelga del host, a la vez: tras el recambio nadie queda oyendo a la vieja', async () => {
  const vieja = fuente([...juntos(1, 4, { badge: true }), ...lejos(5, 1, { badge: true })])
  const nueva = fuente([...juntos(101, 4, { badge: true }), ...lejos(105, 1, { badge: true })])
  const { engine } = await montar({ source: vieja }, { cluster: true })
  engine.addOverlay({ id: 'badge', hostId: 'flota', iconSet: makeIconSet(), where: it => it.badge })
  engine.addLabelLayer({ id: 'rotulos', bindTo: 'flota' })
  engine.addHighlightOverlay({ id: 'hl', layerId: 'flota', drawHighlight: () => {} })
  await flush()
  assert.equal(vieja.vivas(), 5, 'la capa, el overlay, el label, el cluster y el realce')

  engine.attachSource('flota', nueva)
  await flush()
  assert.equal(vieja.vivas(), 0)
  assert.equal(nueva.vivas(), 5, 'las mismas cinco, ahora en la nueva')
  engine.destroy()
  assert.equal(nueva.vivas(), 0, 'y destruido el motor no queda ninguna')
})

/* ── T1.5: el overlay nuevo conserva lo suyo ── */

test('T1.5 el overlay conserva la supresión del cluster: lo clusterizado sigue sin dibujarse bajo la burbuja', async () => {
  const vieja = fuente([...juntos(1, 4, { badge: true }), ...lejos(5, 1, { badge: true })])
  const nueva = fuente([...juntos(101, 4, { badge: true }), ...lejos(105, 1, { badge: true })])
  const { engine } = await montar({ source: vieja }, { cluster: true })
  const badge = engine.addOverlay({ id: 'badge', hostId: 'flota', iconSet: makeIconSet(), where: it => it.badge })
  await flush()
  assert.deepEqual(idsDe(badge.layer), [5])

  engine.attachSource('flota', nueva)
  assert.deepEqual(idsDe(badge.layer), [105], 'el overlay nuevo excluye los clusterizados de la fuente nueva')
  engine.destroy()
})

test('T1.5 un overlay cuyos ítems están todos clusterizados no está vacío: la Source se los entrega', async () => {
  const vieja = fuente(juntos(1, 4, { badge: true }))
  const nueva = fuente(juntos(101, 4, { badge: true }))
  const { engine } = await montar({ source: vieja }, { cluster: true })
  const badge = engine.addOverlay({ id: 'badge', hostId: 'flota', iconSet: makeIconSet(), where: it => it.badge })
  await flush()

  engine.attachSource('flota', nueva)
  const fila = id => engine.surfaces().find(s => s.layerId === id)
  assert.equal(badge.layer.count, 0, 'bajo la burbuja no hay nada en el buffer')
  assert.equal(fila('badge').hasContent, true, 'pero tiene contenido, y el zoom que deshace la burbuja lo muestra')
  assert.equal(fila('flota').hasContent, true)
  engine.destroy()
})

test('T1.5 el overlay conserva su foco por ítem: los atenuados nacen atenuados', async () => {
  const { engine } = await montar({ source: fuente(juntos(1, 5, { badge: true })) })
  engine.addOverlay({ id: 'badge', hostId: 'flota', iconSet: makeIconSet(), where: it => it.badge })
  engine.setLayerFocus('flota', [1, 2])
  await flush()
  assert.deepEqual(signos(glDe(engine, 'badge')), [1, 1, -1, -1, -1], 'el foco del host llega al overlay')

  engine.attachSource('flota', fuente(juntos(1, 5, { badge: true })))
  assert.deepEqual(signos(glDe(engine, 'badge')), [1, 1, -1, -1, -1], 'la capa nueva del overlay sube los tamaños ya firmados')
  engine.destroy()
})

test('T1.5 un overlay oculto por el consumidor sigue sin dibujar tras el recambio, y al mostrarlo pinta', async () => {
  const { engine, map } = await montar({ source: fuente(juntos(1, 3, { badge: true })) })
  const badge = engine.addOverlay({ id: 'badge', hostId: 'flota', iconSet: makeIconSet(), where: it => it.badge })
  await flush()
  badge.setVisible(false)

  engine.attachSource('flota', fuente(juntos(1, 3, { badge: true })))
  await flush()
  const { draws } = glDe(engine, 'badge').spy
  draws.length = 0
  map.fire('moveend')
  await flush()
  assert.equal(draws.length, 0, 'el recambio no lo prende')

  badge.setVisible(true)
  assert.equal(draws.length, 1, 'y mostrarlo pinta en la misma tarea')
  engine.destroy()
})

test('T1.5 con el host deshabilitado, el overlay nuevo nace gateado: no dibuja ni reacciona a la fuente, y al habilitar el host se pone al día', async () => {
  const nueva = fuente(juntos(101, 3, { badge: true }))
  const { engine, map } = await montar({ source: fuente(juntos(1, 3, { badge: true })) })
  const badge = engine.addOverlay({ id: 'badge', hostId: 'flota', iconSet: makeIconSet(), where: it => it.badge })
  await flush()
  engine.setLayerEnabled('flota', false)

  engine.attachSource('flota', nueva)
  await flush()
  const { draws } = glDe(engine, 'badge').spy
  draws.length = 0
  map.fire('moveend')
  nueva.set(juntos(101, 5, { badge: true }))                // el dato sigue vivo mientras el host está deshabilitado
  await flush()
  assert.equal(draws.length, 0, 'el pane de un host deshabilitado no se pinta')
  assert.equal(badge.layer.count, 3, 'y el overlay gateado no procesa lo que emite la fuente')

  engine.setLayerEnabled('flota', true)
  assert.deepEqual(idsDe(badge.layer), [101, 102, 103, 104, 105], 'habilitar el host lo pone al día con la fuente nueva')
  assert.ok(draws.length >= 1)
  engine.destroy()
})
