// Contrato de los handles como sprites: el pase jerárquico tiene que devolver el ref EXACTO del
// `ChunkedPath` —vértice y midpoint, cruzando de chunk—, el ordinal que no entra en los 6 bits del pase
// tiene que degradar a «no pickeable» y NUNCA a un ref ajeno, y el vecindario que el banco DOM promueve
// tiene que salir del VISUAL como un agujero de cinco entradas repartido entre los draws que lo contienen
// —y seguir ENTERO en el pase, que es lo único que sabe direccionar al handle bajo el dedo—.
//
// El pick se ejerce por su doble DERIVADO (`spy.bajoElCursor`): se declara qué entrada hay bajo el cursor y
// el parche sale de los draws que la capa emitió. El `spy.frame` crudo queda para el DECODE, donde la
// entrada de verdad son bytes que no corresponden a ningún draw.
//
// El invariante que cierra la tanda: el apagado NO es estado residente. Se mide como trabajo —cuántas
// escrituras al VBO cuesta prender y apagar handles— y como comportamiento: un chunk que se va de la
// vista con un agujero vuelve con el de la promoción VIGENTE, no con el suyo de entonces.
//
// El harness va primero: instala los globals de módulo que el árbol toca al evaluarse.
import { makeGl } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ChunkedPath, ROLE } from '../../src/geometry/ChunkedPath.js'
import { EditArena } from '../../src/render/EditArena.js'
import { defineEditIconSet, editHandleChannels, EditHandleLayer } from '../../src/render/EditHandleLayer.js'
import { CHUNK_BITS, packTag, Picking } from '../../src/render/Picking.js'

// cap 31 · siete vértices por chunk al ingerir: el trazo cruza de chunk con pocos puntos y el `cap`
// IMPAR desacopla la paridad del ref de la del local, igual que en producción.
const BITS      = 5
const CAP       = 31
const POR_CHUNK = 7
const ORDINALES = 1 << CHUNK_BITS

const OBJ    = 300                       // la identidad que le asigna el motor
const PATCH  = 6
const CENTRO = (PATCH >> 1) * PATCH + (PATCH >> 1)

const W0 = 256 / 360                     // el planeta entero mide 256 px a z0

const project = (lat, lng, out) => {
  out[0] = (lng + 180) * W0
  out[1] = (90 - lat) * W0
}

const SIZE = { x: 800, y: 600 }

const puntos = n => Array.from({ length: n }, (_, i) => [-33.45 + i * 0.0007, -70.66 + i * 0.0011])

const ATTR_INDEX = { vertex: 0, color: 1, pointSize: 2 }

// Espías de programa y VAO que el stub compartido no trae. Envoltorio LOCAL: el harness del repo queda
// intacto y ningún otro test cambia de comportamiento.
const conPrograma = (gl, log) => {
  const extra = {
    getAttribLocation   : (_p, name) => ATTR_INDEX[name] ?? -1,
    createVertexArray   : () => ({ vao: true }),
    bindVertexArray     : vao => log.vaos.push(vao),
    vertexAttribPointer : (index, size, _tipo, _norm, stride, offset) =>
      log.attribs.push({ index, size, stride, offset }),
  }
  return new Proxy(gl, { get: (t, p) => (p in extra ? extra[p] : t[p]) })
}

const montar = (n, { closed = false } = {}) => {
  const log     = { vaos: [], attribs: [] }
  const gl      = conPrograma(makeGl(), log)
  const path    = new ChunkedPath({ points: puntos(n), localBits: BITS, closed })
  const iconSet = defineEditIconSet()
  const arena   = new EditArena({ gl, path, project, ...editHandleChannels(iconSet) })
  const layer   = new EditHandleLayer({ gl, arena, path, picking: new Picking(), iconSet })
  layer.pickObject = OBJ
  return { gl, spy: gl.spy, log, path, iconSet, arena, layer, vista: vistaSobre(arena, 8) }
}

// Vista centrada en el ancla: a z8 el viewport mide 3,1 px world0 y el trazo entero entra holgado.
const vistaSobre = (arena, zoom) => ({ zoom, center: { x: arena.anchor.x, y: arena.anchor.y }, size: SIZE })

const limpiar = spy => {
  spy.draws.length = spy.tags.length = 0
  spy.texImages.length = spy.texSubImages.length = 0
  spy.bufferDatas.length = spy.bufferSubDatas.length = spy.uploads.length = 0
  return spy
}

const refs = path => {
  const out = []
  path.forEachVertex((x, y, ref) => out.push(ref))
  return out
}

const expandir = ds => ds.flatMap(d => Array.from({ length: d.count }, (_, i) => d.first + i))

const rangos = arena => {
  const out = []
  arena.eachRange((ordinal, first, count) => out.push({ first, count }))
  return out
}

// Las entradas vivas en orden de TRAZO: vértice y midpoint entrelazados, que es lo que los rangos del
// arena cubren cuando no hay nada promovido.
const vivas = arena => expandir(rangos(arena))
const dibujadas = spy => expandir(spy.draws)
const chunksDe  = (ds, path) => [...new Set(ds.map(d => path.chunkOf(d.first)))]
const delBatch  = batch => batch.draws.slice(0, batch.length)

const byte = x => Math.round(x * 255)

// Pinta el texel central como lo compone el fragment: el vértice aporta el índice local (`local + 1`) en
// b,a y el pase le SUMA el tag del draw en R, B y A.
const pintar = (frame, obj, ordinal, local) => {
  const tag = packTag(obj, ordinal)
  const id  = local + 1
  frame.fill(0)
  frame.set([byte((id >> 8) / 255 + tag[0]), byte((id & 255) / 255), byte(tag[1]), byte(tag[2])], CENTRO * 4)
}

// Lo que HAY bajo el cursor: la entrada del arena y su índice local. El ordinal —y con él el tag— sale del
// draw que la capa emitió, no de acá; si no la dibujó, el pase contesta «nada».
const apuntar = (spy, path, ref) => { spy.bajoElCursor = { obj: OBJ, entrada: ref, local: path.localOf(ref) } }

/* ── 1. El pase devuelve el ref del trazo ── */

test('el hit vuelve al ref EXACTO del `ChunkedPath`: vértice y midpoint, cruzando de chunk', () => {
  const { spy, path, arena, layer, vista } = montar(23)
  layer.draw(vista)

  const entradas = refs(path).flatMap(ref => [ref, path.midOf(ref)])
  const ordinales = new Set()
  entradas.forEach(ref => {
    ordinales.add(arena.ordinalOfChunk(path.chunkOf(ref)))
    apuntar(spy, path, ref)
    assert.equal(layer.pickRef(10, 10), ref, `entrada ${ref}`)
  })

  assert.ok(ordinales.size > 1, 'el trazo tiene que repartirse en varios chunks')
  assert.ok(entradas.some(ref => path.roleAt(ref) === ROLE.midpoint), 'y traer midpoints vivos')
})

// Un chunk liberado y reusado al final: el orden del TRAZO deja de coincidir con el del arena, que es
// justo donde numerar el draw por índice daría un hit atribuido a otro chunk sin ningún error a la vista.
test('con el arena desordenado el ref sale del ORDINAL, no del índice del chunk', () => {
  const { spy, path, arena, layer, vista } = montar(23)
  path.remove(refs(path)[7])                       // merge: deja un chunk en la free-list
  while (path.chunkUsed(path.lastChunk) < CAP - 1)
    path.insertAfter(path.lastVertex, -33.4 - path.length * 0.0004, -70.5)
  path.insertAfter(path.lastVertex, -33.5, -70.55) // split: toma el chunk liberado, al final del trazo
  arena.syncStructure()

  const vivos = rangos(arena).map(r => path.chunkOf(r.first))
  assert.ok(vivos.some((k, o) => k !== o), 'el orden del trazo no es el del arena')

  limpiar(spy)
  layer.draw(vista)
  assert.equal(spy.draws.length, arena.ordinalCount, 'y el trazo entero sigue en vista')

  const batch = delBatch(layer.pickBatch())
  assert.ok(batch.some(d => d.chunk !== path.chunkOf(d.first)), 'y algún draw tiene ordinal ≠ índice')
  assert.ok(batch.every(d => d.chunk === arena.ordinalOfChunk(path.chunkOf(d.first))),
    'el `chunk` que tagea el draw ES el ordinal del trazo')

  refs(path).forEach(ref => {
    apuntar(spy, path, ref)
    assert.equal(layer.pickRef(10, 10), ref, `vértice ${ref} (chunk ${path.chunkOf(ref)})`)
  })
})

test('el pick de un objeto ajeno, o del objeto sin entrada, no inventa un ref', () => {
  const { spy, path, arena, layer, vista } = montar(23)
  layer.draw(vista)
  const v = refs(path)[3]

  pintar(spy.frame, OBJ + 1, arena.ordinalOfChunk(path.chunkOf(v)), path.localOf(v))
  assert.equal(layer.pickRef(10, 10), -1, 'otro objeto no es un handle de esta capa')

  // Local 0 en el pase: el objeto, pero ninguna entrada. El ordinal 1 en adelante lo hace visible — en el
  // 0 el ref degenerado que saldría de no filtrarlo coincide con el -1 de «nada».
  pintar(spy.frame, OBJ, 1, -1)
  assert.equal(layer.pickRef(10, 10), -1, 'el cuerpo del objeto no es un handle')

  spy.frame.fill(0)
  assert.equal(layer.pickRef(10, 10), -1, 'el parche limpio es lo único que significa «nada»')
})

/* ── 2. El techo de los 6 bits del chunk ── */

test('un chunk con ordinal ≥ 64 no entra al batch: degrada a «no pickeable», nunca a un ref ajeno', () => {
  const { spy, path, arena, layer, vista } = montar((ORDINALES + 1) * POR_CHUNK)
  assert.equal(arena.ordinalCount, ORDINALES + 1, 'el trazo tiene que pasarse del techo del pase')

  limpiar(spy)
  layer.draw(vista)
  assert.equal(spy.draws.length, arena.ordinalCount, 'el visual los dibuja TODOS: el techo es del pase')

  const batch = delBatch(layer.pickBatch())
  assert.deepEqual(batch.map(d => d.chunk), [...Array(ORDINALES).keys()],
    'el batch corta en el último ordinal direccionable, y el chunk del draw ES el ordinal')

  const afuera = arena.chunkOfOrdinal(ORDINALES)
  const suyas  = vivas(arena).filter(ref => path.chunkOf(ref) === afuera)
  assert.ok(suyas.length > 0)
  assert.deepEqual(expandir(batch).filter(ref => suyas.includes(ref)), [],
    'ninguna entrada del ordinal 64 se dibuja al parche: sin impacto no hay ref que atribuir')

  apuntar(spy, path, suyas[0])
  assert.equal(layer.pickRef(10, 10), -1, 'y el pick sobre una de ellas contesta «nada», no un ref ajeno')
})

/* ── 3. El agujero del vecindario promovido ── */

// Las cinco entradas que el banco DOM ya dibuja: prev, su midpoint, v, su midpoint y next.
const vecindario = (path, v) => {
  const prev = path.prevVertex(v)
  const next = path.nextVertex(v)
  return [...(prev >= 0 ? [prev, path.midOf(prev)] : []), v, path.midOf(v), ...(next >= 0 ? [next] : [])]
}

test('el agujero cubre exactamente las cinco entradas del vecindario, y nada más', () => {
  const { spy, path, arena, layer, vista } = montar(23)
  const v = refs(path)[3]
  assert.equal(path.chunkOf(path.prevVertex(v)), path.chunkOf(path.nextVertex(v)),
    'el vecindario entero vive en un solo chunk')

  layer.promote(v)
  limpiar(spy)
  layer.draw(vista)

  const ocultas = vecindario(path, v)
  assert.equal(ocultas.length, 5)
  assert.deepEqual(dibujadas(spy), vivas(arena).filter(ref => !ocultas.includes(ref)))
  assert.equal(spy.draws.filter(d => path.chunkOf(d.first) === path.chunkOf(v)).length, 2,
    'el chunk del promovido se parte en dos draws alrededor del agujero')
})

test('con el vértice en el borde del chunk, el draw VECINO recibe SU propio rango', () => {
  const { spy, path, arena, layer, vista } = montar(23)
  const v    = refs(path).find(ref => path.localOf(ref) === path.chunkFirst(path.chunkOf(ref)) && path.prevVertex(ref) >= 0)
  const prev = path.prevVertex(v)
  assert.notEqual(path.chunkOf(prev), path.chunkOf(v), 'el vecino tiene que vivir en otro chunk')

  layer.promote(v)
  limpiar(spy)
  layer.draw(vista)

  const ocultas = vecindario(path, v)
  assert.deepEqual(dibujadas(spy), vivas(arena).filter(ref => !ocultas.includes(ref)),
    'el agujero se reparte entre los dos draws, sin tapar nada de lo que hay en medio')

  const k       = path.chunkOf(prev)
  const arranca = path.refOf(k, path.chunkFirst(k))
  assert.deepEqual(spy.draws.filter(d => path.chunkOf(d.first) === k).map(d => [d.first, d.count]),
    [[arranca, prev - arranca]],
    'el chunk anterior dibuja UN tramo: el que arranca en su run y muere en `prev`')
})

test('en un anillo el vecino del primer vértice es el último, y el agujero NO tapa lo que hay en medio', () => {
  const { spy, path, arena, layer, vista } = montar(23, { closed: true })
  const v    = path.firstVertex
  const prev = path.prevVertex(v)
  assert.equal(prev, path.lastVertex)
  assert.notEqual(path.chunkOf(prev), path.chunkOf(v), 'y vive en el chunk más lejano del arena')

  layer.promote(v)
  limpiar(spy)
  layer.draw(vista)
  assert.deepEqual(dibujadas(spy), vivas(arena).filter(ref => !vecindario(path, v).includes(ref)))
})

// `setClosed` no mueve una sola entrada —no es edición estructural— y sin embargo le ESTRENA vecino al
// primer vértice. Guardar el recálculo por revisión estructural dejaría al vecino nuevo encendido bajo su
// nodo DOM, que es el mismo fantasma por la puerta de al lado.
test('cerrar el trazo le estrena vecino al primer vértice, y el agujero lo toma sin re-promover', () => {
  const { spy, path, arena, layer, vista } = montar(23)
  const v = path.firstVertex
  layer.promote(v)
  limpiar(spy)
  layer.draw(vista)
  assert.equal(vecindario(path, v).length, 3, 'abierto: el primer vértice no tiene anterior')
  assert.deepEqual(dibujadas(spy), vivas(arena).filter(ref => !vecindario(path, v).includes(ref)))

  path.setClosed(true)
  limpiar(spy)
  layer.draw(vista)
  const ocultas = vecindario(path, v)
  assert.equal(ocultas.length, 5)
  assert.deepEqual(dibujadas(spy), vivas(arena).filter(ref => !ocultas.includes(ref)))
})

// La asimetría ES el contrato. El nodo que repone el banco es afordancia —`pointer-events: none` y cero
// listeners, nunca pickea—, así que el pase es lo ÚNICO que sabe direccionar al vecindario promovido:
// apagarlo también ahí lo vuelve inagarrable y realimenta al hover, que lo suelta para volver a
// encontrarlo al frame siguiente. Vale igual para prev y next, que se apagan por el mismo motivo.
test('el agujero NO alcanza al pase: el vecindario promovido sigue siendo pickeable', () => {
  const { spy, path, layer, vista } = montar(23)
  const v = refs(path)[3]
  layer.draw(vista)

  layer.promote(v)
  const cubiertas = expandir(delBatch(layer.pickBatch()))
  assert.deepEqual(vecindario(path, v).filter(ref => !cubiertas.includes(ref)), [],
    'las cinco entradas que el visual apaga entran ENTERAS al batch')

  vecindario(path, v).forEach(ref => {
    apuntar(spy, path, ref)
    assert.equal(layer.pickRef(10, 10), ref, `el promovido y su vecindario se direccionan igual (${ref})`)
  })
})

/* ── 4. El fantasma: el apagado no es estado residente ── */

// Vista centrada en el bbox de un chunk. A z18 el viewport mide 3·10⁻³ px world0: alcanza para un chunk
// del trazo y deja al vecino afuera, que es lo que hace falta para culearlo de verdad.
const vistaSobreChunk = (arena, chunk) => {
  const b = arena.boxOfChunk(chunk)
  return { zoom: 18, center: { x: (b[0] + b[2]) / 2 + arena.anchor.x, y: (b[1] + b[3]) / 2 + arena.anchor.y }, size: SIZE }
}

test('un chunk culleado no dibuja, y vuelve a la vista con el agujero de la promoción VIGENTE', () => {
  const { spy, path, arena, layer, vista } = montar(23)
  const primero = arena.chunkOfOrdinal(0)
  const v       = refs(path).findLast(ref => path.chunkOf(ref) === primero)
  const vecino  = path.nextVertex(v)
  assert.equal(path.chunkOf(vecino), arena.chunkOfOrdinal(1), 'el vecino vive en el chunk de al lado')

  layer.promote(v)
  limpiar(spy)
  layer.draw(vista)
  const conAgujero = spy.draws.filter(d => path.chunkOf(d.first) === path.chunkOf(vecino))
  assert.deepEqual(expandir(conAgujero).filter(ref => ref === vecino), [], 'el vecino sale apagado')

  limpiar(spy)
  layer.draw(vistaSobreChunk(arena, primero))
  assert.deepEqual(chunksDe(spy.draws, path), [primero], 'fuera de la vista, el chunk del vecino no dibuja')

  layer.promote(refs(path)[0])                     // la promoción se muda MIENTRAS el chunk está afuera
  limpiar(spy)
  layer.draw(vista)
  const devuelta = spy.draws.filter(d => path.chunkOf(d.first) === path.chunkOf(vecino))
  assert.deepEqual(expandir(devuelta), vivas(arena).filter(ref => path.chunkOf(ref) === path.chunkOf(vecino)),
    'vuelve entero: no había nada apagado que restaurar, así que no hay sprite que quede pegado')
})

test('prender y apagar handles no escribe un solo byte al VBO', () => {
  const { spy, path, arena, layer, vista } = montar(23)
  limpiar(spy)

  refs(path).forEach(ref => {
    layer.promote(ref)
    layer.draw(vista)
    layer.draw(vistaSobreChunk(arena, path.chunkOf(ref)))
  })
  layer.promote(-1)
  layer.draw(vista)

  assert.deepEqual({
    rangos : spy.bufferSubDatas.length,
    entero : spy.bufferDatas.length,
  }, { rangos: 0, entero: 0 }, 'el apagado vive en el rango del draw, no en el buffer')
  assert.deepEqual(dibujadas(spy).slice(-vivas(arena).length), vivas(arena),
    'y sin promoción el último frame vuelve a cubrir las entradas vivas')
})

/* ── 5. La costura con el arena y con el atlas ── */

test('sin promoción hay UN draw por chunk, y cubre el run entero: vértices y midpoints juntos', () => {
  const { spy, arena, layer, vista } = montar(23)
  limpiar(spy)
  layer.draw(vista)

  assert.equal(spy.draws.length, arena.ordinalCount)
  assert.deepEqual(dibujadas(spy), vivas(arena))
  assert.ok(spy.draws.every(d => d.mode === 0), 'POINTS')
})

test('el canal del rol `free` es el tile TRANSPARENTE, que apaga visual y picking a la vez', () => {
  const iconSet  = defineEditIconSet()
  const { tiles, sizes } = editHandleChannels(iconSet)
  const canal    = variante => iconSet.atlas.tileChannel(iconSet.resolve(variante))

  assert.deepEqual(tiles, [canal('off'), canal('vertex'), canal('midpoint')], 'indexados por ROL')
  assert.equal(tiles[ROLE.free], canal('off'))
  assert.equal(sizes.length, 3)
  assert.notEqual(canal('vertex'), canal('midpoint'), 'y cada rol tiene el suyo')
})

// `gl_PointSize` se mide en píxeles del FRAMEBUFFER: sobre una superficie a DPR 2 el sprite declarado en
// px CSS sale a la mitad de tamaño —y el pase, que lee el MISMO atributo, con la mitad de silueta—,
// mientras el nodo del banco DOM que lo releva sigue midiendo lo declarado.
test('el tamaño del handle se declara en px CSS y baja a la superficie en px del FRAMEBUFFER', () => {
  const iconSet = defineEditIconSet()
  const css     = editHandleChannels(iconSet).sizes
  const doble   = editHandleChannels(iconSet, 2)

  assert.deepEqual(doble.sizes, css.map(s => s * 2))
  assert.deepEqual(doble.tiles, editHandleChannels(iconSet).tiles, 'el tile no depende de la resolución')
})

test('el VAO lee el buffer del arena con el layout de los sprites, una sola vez', () => {
  const { log } = montar(23)
  assert.deepEqual(log.attribs, [
    { index: 0, size: 2, stride: 28, offset: 0 },
    { index: 1, size: 4, stride: 28, offset: 8 },
    { index: 2, size: 1, stride: 28, offset: 24 },
  ])
})

test('el `bind` de cada PickDraw es ESTABLE y bindea nuestro VAO', () => {
  const { log, layer, vista } = montar(23)
  layer.draw(vista)
  const primero = delBatch(layer.pickBatch())
  const segundo = delBatch(layer.pickBatch())

  assert.ok(primero.length > 1)
  assert.equal(new Set(primero.map(d => d.bind)).size, 1, 'una sola función para todos los draws')
  assert.deepEqual(primero.map(d => d.bind), segundo.map(d => d.bind), 'y la misma en el batch siguiente')
  assert.ok(primero.every(d => d.obj === OBJ), 'con el objeto que asignó el motor')

  log.vaos.length = 0
  primero[0].bind()
  assert.equal(log.vaos.length, 1)
  assert.equal(log.vaos[0]?.vao, true, 'el VAO de la capa, no el default')
})
