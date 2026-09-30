// Eje `focus` por ÍTEM (setLayerFocus): mientras alguna capa lo declare, cada capa salva sus brillantes y
// atenúa el resto. La que sabe resolverlo por ÍTEM lo hace DENTRO de su propio dibujo —la de puntos, en el
// SIGNO del `size` de cada vértice más el uniform `uDim`— y su pane queda pleno; la que no sabe, o la que no
// tiene NADA que salvar, atenúa el pane entero, que da el mismo resultado y es gratis. El eje por CAPA
// (`focus()`) EXIME: la capa que nombra queda plena y FUERA del eje por ítem. `ids` polimórfico: iterable |
// falsy (presente-vacío: participa, nadie brillante) | undefined (retiro).

import '../../test-helpers/engine-stub.mjs'
import { makeGlify, makeMap, makeLeaflet, makeIconSet } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { POINT_VERTEX, POINT_PICKING_FRAGMENT } from '../../src/render/shaders.js'

/* ── Harness ── */

const FLOATS   = 7      // layout de glify por vértice: [x, y, r, g, b, a, size]
const SIZE     = 6      // canal donde vive el eje: la magnitud es el tamaño, el SIGNO es la membresía
const ITEM_DIM = 0.3    // atenuación del eje por ÍTEM (MapEngine); el eje por CAPA trae la suya

// Enums REALES de GL para lo que el eje compone con OR (`clear`) o compara por identidad (`enable`,
// `depthFunc`): el doble los entrega como no-op —una función distinta por lectura—, así que una máscara
// armada con ellos daría 0 y ninguna comparación cerraría.
const GL = { COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x0100, DEPTH_TEST: 0x0B71, LEQUAL: 0x0203, DEPTH_ATTACHMENT: 0x8D00 }

const flushRaf = () => new Promise(r => setTimeout(r, 5))

// Sets de datos como FÁBRICA: los tests mutan ítems (el patch) y compartir los objetos filtraría un test
// en el siguiente.
const FLOTA    = () => Array.from({ length: 6 }, (_, i) => ({ id: i + 1, lat: i * 0.1, lng: i * 0.2, size: 24 }))
const JUNTOS   = () => [[0, 0], [0, 1e-4], [1e-4, 0], [1e-4, 1e-4], [0, 2e-4]].map(([lat, lng], i) => ({ id: i + 1, lat, lng, size: 24 }))
const APILADOS = () => ['abajo', 'arriba'].map(id => ({ id, lat: 0, lng: 0, size: 24 }))

const accessors = { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }), sizeOf: it => it.size }
const ZONAS     = { accessors: { idOf: it => it.id, ringsOf: () => [[[0, 0], [0, 1], [1, 1]]] }, data: [{ id: 'z1' }, { id: 'z2' }] }

// glify del harness + las tres cosas que el eje necesita observar y el doble no trae:
//   · el llenado de `typedVertices` desde los callbacks `color`/`size`, como el render de glify: el eje vive
//     en el SIGNO de ese canal, y sobre un buffer en 0 el flip escribiría −0. x,y quedan en 0 (el harness no
//     proyecta y ningún aserto los lee);
//   · el asiento `drawing` del overlay y un contexto CON profundidad —los dos, reales—, que es lo que
//     enciende la banda de z del foco;
//   · los contadores (redraw / setData) y `uniform1f` por NOMBRE: `getUniformLocation` devuelve el nombre,
//     que es lo único que distingue `uDim` de los uniforms del atlas.
const espiar = () => {
  const capas = new Map()
  const base  = makeGlify()
  return {
    capas,
    points(opts) {
      const l   = base.points(opts)
      const rec = { spy: l.gl.spy, redraws: 0, setData: 0, uniformes: [], clears: [], enables: [], disables: [], depthFuncs: [], verts: () => l.typedVertices }
      const llenar = n => {
        const v = l.typedVertices
        for (let i = 0; i < n; i++) {
          const c = opts.color(i)
          v[i * FLOATS + 2]    = c.r
          v[i * FLOATS + 3]    = c.g
          v[i * FLOATS + 4]    = c.b
          v[i * FLOATS + 5]    = c.a
          v[i * FLOATS + SIZE] = opts.size(i)
        }
      }
      const redraw  = l.layer.redraw
      const setData = l.setData
      l.layer.redraw  = () => { rec.redraws++; redraw() }
      l.layer.drawing = fn => { rec.draw = fn }
      l.setData       = next => { rec.setData++; setData(next); llenar(next.length) }
      l.gl = new Proxy(l.gl, {
        get: (t, p) => {
          if (Object.hasOwn(GL, p)) return GL[p]
          if (p === 'getContextAttributes') return () => ({ depth: true })
          // Fuera del draw el contexto tiene el test APAGADO: así se ve si el pase restaura o se lo deja.
          if (p === 'getParameter')         return param => (param === GL.DEPTH_TEST ? false : t.getParameter?.(param))
          if (p === 'getUniformLocation')   return (_program, name) => name
          if (p === 'uniform1f')            return (name, v) => rec.uniformes.push({ name, v })
          if (p === 'clear')                return mask => rec.clears.push(mask)
          if (p === 'enable')               return cap => rec.enables.push(cap)
          if (p === 'disable')              return cap => rec.disables.push(cap)
          if (p === 'depthFunc')            return fn => rec.depthFuncs.push(fn)
          return t[p]
        },
      })
      llenar(opts.data.length)
      capas.set(opts.pane, rec)
      return l
    },
  }
}

const mount = async ({ data = FLOTA(), interactive = false, where = null, zonas = false, cluster = false } = {}) => {
  const glify  = espiar()
  const engine = new MapEngine({ leaflet: makeLeaflet(), glify, map: makeMap() })
  const flota  = engine.addPointLayer({ id: 'flota', accessors, iconSet: makeIconSet(), data, interactive, where })
  engine.addPointLayer({ id: 'otra', accessors, iconSet: makeIconSet(), data: FLOTA() })
  zonas && engine.addPolygonLayer({ id: 'zonas', backend: 'leaflet', ...ZONAS })
  cluster && engine.addClusterFold([{ id: 'flota' }], { radius: 80, maxZoom: 18, minPoints: 2 })
  await flushRaf()
  return { engine, glify, flota, datos: data }
}

// Opacidad efectiva del pane de una capa ('' = plena). El nombre sale del record: no se calca a mano.
const opacidad = (h, id) => h.engine.getLeafletMap().getPane(h.engine.getLayer(id).paneName)?.style.opacity ?? ''
const capa     = (h, id) => h.glify.capas.get(h.engine.getLayer(id).paneName)
const uDim     = rec => rec.uniformes.filter(u => u.name === 'uDim').map(u => u.v)

// Tamaño SIGNADO por id, leído del vértice: + pleno, − atenuado.
const signos = (h, id) => {
  const layer = h.engine.getLayer(id).layer
  const v     = capa(h, id).verts()
  return new Map(Array.from({ length: layer.count }, (_, s) => [layer.idForSlot(s), v[s * FLOATS + SIZE]]))
}

// Lo que la GPU va a leer: el espejo del ARRAY_BUFFER que mantiene el doble (`bufferData` lo estrena,
// `bufferSubData` le parcha el rango).
const enGpu = (h, id) => capa(h, id).spy.array.datos

/* ── Tests ── */

// 1 · sin eje activo el buffer queda idéntico y el draw es uno solo.
test('sin eje por ÍTEM el buffer queda IDÉNTICO y no se pide un repinte de más', async () => {
  const h   = await mount()
  const rec = capa(h, 'flota')
  const { redraws } = rec
  assert.equal(rec.spy.bufferSubDatas.length, 0, 'el alta no escribe rangos: el buffer entero viajó en el bufferData del build')

  h.engine.focus(['flota'])                                 // eje por CAPA: el eje por ítem sigue dormido
  assert.equal(opacidad(h, 'flota'), '', 'la enfocada queda plena')
  assert.notEqual(opacidad(h, 'otra'), '', 'y el resto se atenúa por PANE')
  h.engine.unfocusAll()

  assert.equal(rec.spy.bufferSubDatas.length, 0, 'sin eje por ítem no se toca un byte del buffer')
  assert.equal(capa(h, 'otra').spy.bufferSubDatas.length, 0, 'ni el de la atenuada: el pane no cuesta buffer')
  assert.equal(rec.redraws, redraws, '`applyFocus(null)` sobre una capa sin foco es no-op: ni un draw extra')
  assert.deepEqual(uDim(rec), [], 'y `uDim` no se sube: sin foco el shader no lo lee')
  h.engine.destroy()
})

// 2 · el signo ES la membresía y `#sizeFor` es el punto único: lo que entra con el foco activo nace atenuado.
test('el SIGNO del `size` es la membresía, y todo lo que entra después nace con el signo puesto', async () => {
  const h = await mount()
  h.engine.setLayerFocus('flota', [2])

  assert.deepEqual([...signos(h, 'flota')], [[1, -24], [2, 24], [3, -24], [4, -24], [5, -24], [6, -24]],
    'el enfocado conserva su magnitud en +; el resto, la MISMA magnitud en −')
  assert.equal(enGpu(h, 'flota')[SIZE], -24, 'y es lo que viajó al buffer, no sólo el espejo CPU')
  assert.equal(opacidad(h, 'flota'), '', 'su pane queda PLENO: atenúa por ÍTEM, no apagando la capa entera')
  assert.notEqual(opacidad(h, 'otra'), '', 'y la que no declara nada sí se atenúa por pane')

  h.datos.push({ id: 7, lat: 1, lng: 1, size: 24 })
  h.flota.set(h.datos)                                      // rebuild (set / filtro / cluster / regrow)
  await flushRaf()
  assert.equal(signos(h, 'flota').get(7), -24, 'el que entra por `set()` NACE atenuado: el rebuild repone el eje')
  assert.equal(signos(h, 'flota').get(2), 24, 'y el enfocado sigue pleno tras la reconstrucción')

  h.datos[4].size = 30
  h.flota.patch(h.datos, new Set([5]))                      // camino incremental (7 floats del slot)
  await flushRaf()
  assert.equal(signos(h, 'flota').get(5), -30, 'el patch pasa por el mismo `#sizeFor`: magnitud nueva, signo del eje')
  h.engine.destroy()
})

// 3 · `dim` es un número honrado exacto y vive en un uniform: cambiarlo NO escribe el buffer.
test('`dim` viaja como uniform: llega exacto, cambiarlo no escribe un byte y el mismo valor no se re-sube', async () => {
  const h     = await mount()
  const rec   = capa(h, 'flota')
  const antes = rec.redraws
  h.engine.setLayerFocus('flota', [2])
  const escrituras = rec.spy.bufferSubDatas.length
  assert.deepEqual(uDim(rec), [ITEM_DIM], 'el eje por ítem atenúa con SU constante')
  assert.ok(escrituras > 0, 'firmar los 5 atenuados sí costó buffer')
  assert.equal(rec.redraws, antes + 1, 'y UN solo repinte para los 5, no uno por ítem')

  h.engine.focus(['otra'], { opacity: 0.137 })              // el eje por capa impone su dim sobre el por ítem
  assert.deepEqual(uDim(rec), [ITEM_DIM, 0.137], 'llega exacto, sin redondeos: es un float, no una opacidad de CSS')
  assert.equal(rec.spy.bufferSubDatas.length, escrituras, 'mover `dim` no toca el buffer: la membresía no cambió')

  const repintes = rec.redraws
  h.engine.setLayerFocus('flota', [2])                      // mismos ids, mismo dim
  assert.deepEqual(uDim(rec), [ITEM_DIM, 0.137], 'el mismo valor no se re-sube')
  assert.equal(rec.redraws, repintes, 'y sin nada que cambiar no se pide repinte')
  assert.equal(rec.spy.bufferSubDatas.length, escrituras, 'ni se reescribe el rango')
  h.engine.destroy()
})

// 4 · el foco no toca la Source: cero `setData` tras N toggles.
test('el foco no toca la Source: N toggles sin un solo rebuild ni un ítem mutado', async () => {
  const h    = await mount()
  const rec  = capa(h, 'flota')
  const src  = h.engine.getLayer('flota').source
  const snap = src.getSnapshot()
  const { setData } = rec
  const enteras = rec.spy.bufferDatas.length

  h.datos.forEach(it => h.engine.setLayerFocus('flota', [it.id]))
  h.engine.setLayerFocus('flota', undefined)                // …y el retiro del eje

  assert.equal(rec.setData, setData, 'ni un rebuild: el eje no reconstruye el set')
  assert.equal(rec.spy.bufferDatas.length, enteras, 'ni una re-subida entera del buffer')
  assert.equal(src.getSnapshot(), snap, 'el snapshot sigue siendo el MISMO array')
  assert.deepEqual(h.datos.map(it => it.size), [24, 24, 24, 24, 24, 24], 'y ningún ítem quedó mutado')
  h.engine.destroy()
})

// 5 · lo que se ve es lo que se pickea: el pleno va a la banda de adelante y el pase hereda la profundidad.
// El ganador lo resuelve la GPU (no hay contexto en node), así que lo que se congela son los tres eslabones
// que apuntan al mismo lado; con el orden de slot —lo único que decidía antes— ganaría el ATENUADO.
test('lo que se ve es lo que se pickea: el pleno cae en la banda de ADELANTE y el pase hereda la profundidad', async () => {
  const h   = await mount({ data: APILADOS(), interactive: true })
  const rec = capa(h, 'flota')
  h.engine.setLayerFocus('flota', ['abajo'])                // el pleno es el de slot MENOR: sin z, pierde

  assert.deepEqual([...signos(h, 'flota')], [['abajo', 24], ['arriba', -24]],
    'mismo píxel, signos opuestos: el signo del vértice ES la banda')
  assert.ok(POINT_VERTEX.includes('gl_Position.z = (0.5 - pleno) * gl_Position.w'),
    'la banda sale del MISMO `pleno` que el alfa: una sola fuente para los dos')
  assert.ok(rec.depthFuncs.includes(GL.LEQUAL),
    'el orden lo decide la banda, no el slot: dentro de una banda LEQUAL deja ganar al último')
  assert.ok(rec.spy.attachments.includes(GL.DEPTH_ATTACHMENT),
    'el destino del pase de picking lleva profundidad: espeja el orden del visual')

  h.engine.getLayer('flota').layer.resolveClick({ x: 10, y: 10 })
  assert.ok(rec.clears.some(mask => mask & GL.DEPTH_BUFFER_BIT),
    'y cada pick la limpia: sin eso el z del pick anterior decidiría éste')
  assert.ok(rec.enables.includes(GL.DEPTH_TEST) && rec.disables.includes(GL.DEPTH_TEST),
    'el pase la enciende y restaura el estado previo: el contexto no queda tocado para las otras capas')
  h.engine.destroy()
})

// 6 · atenuado ≠ no interactivo: pick sobre un atenuado sin nada encima → hit.
test('atenuado ≠ no interactivo: el pick sobre un atenuado sigue devolviendo su id', async () => {
  const h     = await mount({ interactive: true })
  const rec   = capa(h, 'flota')
  const layer = h.engine.getLayer('flota').layer
  h.engine.setLayerFocus('flota', [2])                      // el 4 queda atenuado

  const slot = 3
  assert.equal(layer.idForSlot(slot), 4, 'el slot 3 es el id 4')
  assert.equal(signos(h, 'flota').get(4), -24, 'y está atenuado')

  rec.spy.bajoElCursor = { obj: layer.pickObject, entrada: slot, local: slot }
  assert.deepEqual(layer.resolveClick({ x: 10, y: 10 }).map(p => p.id), [4],
    'la silueta del atenuado escribe en el pase igual que la de un pleno (el vértice le da `abs(size)`)')
  const { first, count } = rec.spy.draws.at(-1)
  assert.deepEqual({ first, count }, { first: 0, count: 6 }, 'y el pase dibuja los 6: atenuar no saca a nadie del batch')
  assert.ok(!POINT_PICKING_FRAGMENT.includes('vAlpha'), 'el fragment del pase no declara el alfa: el id no se atenúa')
  h.engine.destroy()
})

// 7 · membresía manda sobre foco: enfocar un id ajeno (`where`) o clusterizado no lo trae de vuelta.
test('membresía manda sobre foco: el id que la capa no muestra no vuelve al buffer por estar enfocado', async () => {
  const h     = await mount({ where: it => it.id !== 4 })
  const layer = h.engine.getLayer('flota').layer
  h.engine.setLayerFocus('flota', [4])                      // el enfocado es justo el que la capa no muestra

  assert.equal(layer.count, 5, 'sigue afuera: el foco no es membresía')
  assert.ok(!signos(h, 'flota').has(4), 'ningún slot le corresponde')
  assert.deepEqual([...signos(h, 'flota').values()], [-24, -24, -24, -24, -24], 'y los presentes quedan todos atenuados')
  h.engine.destroy()

  const c   = await mount({ data: JUNTOS(), cluster: true })
  const rec = capa(c, 'flota')
  assert.equal(c.engine.getLayer('flota').layer.count, 0, 'clusterizados: el host no dibuja ninguno')
  const escrituras = rec.spy.bufferSubDatas.length
  c.engine.setLayerFocus('flota', [1])
  assert.equal(rec.spy.bufferSubDatas.length, escrituras, 'foco sobre un clusterizado: cero escrituras (nada que dibujar)')
  c.engine.destroy()
})

// 8 · `focus()` EXIME: la capa que nombra queda plena y el eje por ítem no la pisa.
test('`focus()` EXIME: la capa nombrada queda plena y el eje por ítem no la pisa', async () => {
  const h = await mount()
  h.engine.setLayerFocus('flota', [2])
  assert.equal(signos(h, 'flota').get(1), -24, 'con el eje por ítem, el no enfocado está atenuado')

  h.engine.focus(['flota'])
  assert.deepEqual([...signos(h, 'flota').values()], [24, 24, 24, 24, 24, 24],
    'exenta: TODOS sus ítems vuelven a pleno, aunque la capa siga declarando foco por ítem')
  assert.equal(opacidad(h, 'flota'), '', 'y su pane también queda pleno')
  assert.notEqual(opacidad(h, 'otra'), '', 'el resto sigue atenuado por el eje por capa')

  h.engine.unfocusAll()
  assert.equal(signos(h, 'flota').get(1), -24, 'al morir el eje por capa, el por ítem vuelve a mandar')
  h.engine.destroy()
})

// 9 · `kinds` no deja estado rancio: la capa fuera de alcance vuelve a plena.
test('`kinds` no deja estado rancio: la capa fuera de alcance vuelve a plena', async () => {
  const h = await mount({ zonas: true })
  h.engine.focus(['flota'])
  assert.notEqual(opacidad(h, 'zonas'), '', 'sin `kinds`, el eje por capa atenúa también al polígono')

  h.engine.focus(['flota'], { kinds: ['point'] })
  assert.equal(opacidad(h, 'zonas'), '', 'fuera de alcance se RESTAURA: no queda con la opacidad de la vuelta anterior')
  assert.notEqual(opacidad(h, 'otra'), '', 'y dentro del alcance sigue atenuando')
  h.engine.destroy()
})

// 10 · el `dimOpacity` del eje por capa no se filtra al eje por ítem cuando ese eje muere.
test('el `dimOpacity` del eje por capa no se filtra al eje por ítem', async () => {
  const h   = await mount({ zonas: true })
  const rec = capa(h, 'flota')
  h.engine.setLayerFocus('flota', [2])
  h.engine.focus(['otra'], { opacity: 0.05 })
  assert.equal(uDim(rec).at(-1), 0.05, 'mientras vive, el eje por capa impone su opacidad')

  h.engine.unfocusAll()
  assert.equal(uDim(rec).at(-1), ITEM_DIM, 'al morir, el eje por ítem vuelve a SU constante: no hereda el 0.05')
  assert.equal(opacidad(h, 'zonas'), String(ITEM_DIM), 'y el pane de la que no tiene nada que salvar, igual')
  h.engine.destroy()
})

// 11 · sin nada que salvar se atenúa el PANE (declare el set vacío, o no declare nada) y el buffer no se toca.
test('sin nada que salvar se atenúa el PANE, no el buffer: capa que no declara, o set VACÍO', async () => {
  const h   = await mount({ zonas: true })
  const rec = capa(h, 'flota')

  h.engine.setLayerFocus('zonas', ['z1'])                   // el declarante es OTRA capa
  assert.equal(opacidad(h, 'zonas'), '', 'la que salva los suyos los resuelve en su dibujo: pane pleno')
  assert.notEqual(opacidad(h, 'flota'), '', 'la de puntos no tiene NADA que salvar → pane (no porque no sepa)')
  assert.equal(rec.spy.bufferSubDatas.length, 0, 'y sin firmar un vértice: el pane es gratis')

  h.engine.setLayerFocus('flota', null)                     // presente-vacío (`focus-ids=""` del elemento)
  assert.notEqual(opacidad(h, 'flota'), '', 'declarar el set VACÍO es lo mismo: todo atenuado, por pane')
  assert.equal(rec.spy.bufferSubDatas.length, 0, 'tampoco cuesta buffer')
  assert.deepEqual([...signos(h, 'flota').values()], [24, 24, 24, 24, 24, 24], 'el buffer sigue todo en pleno')
  h.engine.destroy()
})
