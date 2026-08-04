// Contrato del trazo en GPU. Lo que se caracteriza no es el píxel —eso no existe sin GPU— sino la
// COBERTURA: qué segmento dibuja cada draw y de dónde saca sus dos extremos. El pase estático fija el
// otro extremo por contigüidad (`entrada + 2`), así que un rango de más ya no es «un draw extra» sino un
// segmento con el extremo EQUIVOCADO, y el test lo ve.
//
// Tres invariantes cierran la tanda:
//
//   · los rangos del pase estático más los SUELTOS —costura entre chunks, cierre del anillo y los dos
//     vivos del arrastre— cubren el trazo exacto: ni un segmento de menos (agujero visible) ni uno
//     repetido (doble AA en el mismo píxel), tras split, merge y reuso de chunk;
//   · el segmento de cierre existe si y sólo si `path.closed`;
//   · el arrastre no escribe un solo byte: el vértice en movimiento viaja como uniform.
//
// El harness va primero: instala los globals de módulo que el árbol toca al evaluarse.
import { makeGl } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ChunkedPath, ROLE } from '../../src/geometry/ChunkedPath.js'
import { EditArena } from '../../src/render/EditArena.js'
import { RingStore } from '../../src/render/RingStore.js'
import { EditStrokeLayer } from '../../src/render/EditStrokeLayer.js'

// cap 31 · siete vértices por chunk al ingerir: el trazo cruza de chunk con pocos puntos y el `cap`
// IMPAR desacopla la paridad del ref de la del local, igual que en producción.
const BITS = 5
const CAP  = 31

const ESQUINAS = 6                       // dos triángulos por segmento
const POR_ENTRADA = ESQUINAS / 2         // vértices de draw por entrada del arena
const TRIANGLES   = 4                    // el stub no trae el enum, y el modo del draw se compara

const ANCHO = 4
const SIZE  = { x: 800, y: 600 }

const W0 = 256 / 360                     // el planeta entero mide 256 px a z0

const project = (lat, lng, out) => {
  out[0] = (lng + 180) * W0
  out[1] = (90 - lat) * W0
}

const puntos = n => Array.from({ length: n }, (_, i) => [-33.45 + i * 0.0007, -70.66 + i * 0.0011])

// Espías de programa, uniformes y draws. Envoltorio LOCAL: el harness del repo queda intacto y ningún
// otro test cambia de comportamiento. El `useLoose` vigente clasifica cada draw —del arena o suelto— y
// `loose` le adjunta los extremos que viajaron por uniform.
const conPrograma = (gl, log) => {
  const anotar = (name, ...args) => { log.uniformes[name] = args.length > 1 ? args : args[0] }
  const extra  = {
    TRIANGLES,
    getUniformLocation : (_p, name) => name,
    createVertexArray  : () => ({ vao: true }),
    uniform1i          : anotar,
    uniform1f          : anotar,
    uniform2i          : anotar,
    uniform2f          : anotar,
    uniform4f          : anotar,
    drawArrays         : (mode, first, count) => {
      const loose = log.uniformes.useLoose ? [...log.uniformes.loose] : null
      log.draws.push({ mode, first, count, loose, base: log.uniformes.base })
      gl.drawArrays(mode, first, count)
    },
  }
  return new Proxy(gl, { get: (t, p) => (p in extra ? extra[p] : t[p]) })
}

const montar = (n, { closed = false, width = ANCHO } = {}) => {
  const log   = { draws: [], uniformes: {} }
  const gl    = conPrograma(makeGl(), log)
  const path  = new ChunkedPath({ points: puntos(n), localBits: BITS, closed })
  const arena = new EditArena({ gl, path, project })
  const layer = new EditStrokeLayer({ gl, arena, path, project, width })
  return { gl, spy: gl.spy, log, path, arena, layer, vista: vistaSobre(arena, 8) }
}

// Vista centrada en el ancla: a z8 el viewport mide 3,1 px world0 y el trazo entero entra holgado.
const vistaSobre = (arena, zoom) => ({ zoom, center: { x: arena.anchor.x, y: arena.anchor.y }, size: SIZE })

// Vista de un punto en rel-ancla. A z22 el viewport mide 1,9·10⁻⁴ px world0: más chico que un paso del
// trazo, que es lo que hace falta para cullear de verdad.
const vistaEn = (arena, x, y, zoom = 22) =>
  ({ zoom, center: { x: x + arena.anchor.x, y: y + arena.anchor.y }, size: SIZE })

const limpiar = log => {
  log.draws.length = 0
  return log
}

const refs = path => {
  const out = []
  path.forEachVertex((x, y, ref) => out.push(ref))
  return out
}

// La verdad: cada vértice con siguiente aporta UN segmento, en orden de trazo.
const segmentos = path => refs(path).map(a => [a, path.nextVertex(a)]).filter(([, b]) => b >= 0)

// Los segmentos del pase estático. El otro extremo NO se pregunta: se deriva como lo deriva el shader
// —`entrada + 2` desde el arranque del rango—, así que un rango que se pase de largo aparece con el
// extremo equivocado.
const estaticos = log => log.draws.filter(d => !d.loose).flatMap(d =>
  Array.from({ length: d.count / ESQUINAS }, (_, i) => {
    const a = d.base + i * 2
    return [a, a + 2]
  }))

const clave = (x, y) => `${x},${y}`

// Los sueltos, resueltos a refs por su posición en el espejo. `null` = una posición que no es la de
// ningún vértice commiteado, o sea la que arrastra el usuario.
const sueltos = (log, arena, path) => {
  const porPos = new Map(refs(path).map(ref => [clave(arena.relX(ref), arena.relY(ref)), ref]))
  return log.draws.filter(d => d.loose).map(d =>
    [porPos.get(clave(d.loose[0], d.loose[1])) ?? null, porPos.get(clave(d.loose[2], d.loose[3])) ?? null])
}

const par       = ([a, b]) => `${a}→${b}`
const dibujados = (log, arena, path) => [...estaticos(log), ...sueltos(log, arena, path)].map(par)

// El trazo con `v` en arrastre: los mismos segmentos, pero los dos que lo tocan llevan su posición VIVA
// —que no está en el espejo— en lugar del ref.
const conVivo = (path, v) => segmentos(path).map(([a, b]) => [a === v ? null : a, b === v ? null : b])

const verificar = (log, arena, path, esperado = segmentos(path), nota = '') =>
  assert.deepEqual(dibujados(log, arena, path).sort(), esperado.map(par).sort(), `cobertura exacta ${nota}`)

// `a` aparece dentro de `b`, completa y en el mismo orden.
const esSubsecuencia = (a, b) => b.reduce((i, x) => i + (a[i] === x ? 1 : 0), 0) === a.length

/* ── 1. Cobertura: los rangos más los sueltos son el trazo ── */

test('los rangos del pase estático más las costuras cubren cada segmento exactamente una vez', () => {
  const { log, path, arena, layer, vista } = montar(23)
  layer.draw(vista)

  assert.equal(segmentos(path).length, path.length - 1, 'trazo abierto: un segmento menos que vértices')
  verificar(log, arena, path)
  assert.ok(log.draws.some(d => !d.loose), 'con rangos del arena')
  assert.ok(log.draws.some(d => d.loose),  'y con costuras sueltas: el trazo cruza de chunk')
})

test('el pase estático recorre el trazo EN ORDEN, y deja afuera sólo lo que no es contiguo en el run', () => {
  const { log, path, arena, layer, vista } = montar(23)
  layer.draw(vista)

  const propios = estaticos(log).map(par)
  assert.ok(esSubsecuencia(propios, segmentos(path).map(par)), 'los rangos van en orden de trazo')
  assert.deepEqual(sueltos(log, arena, path).map(par).sort(),
    segmentos(path).map(par).filter(s => !propios.includes(s)).sort(),
    'y lo que no cubren es exactamente lo que sale suelto')
})

// Un chunk liberado y reusado al final: el orden del TRAZO deja de coincidir con el del arena, que es
// justo donde derivar el segmento de la aritmética del ref daría un contorno con el extremo cambiado.
test('con el arena desordenado la cobertura y el orden del trazo se sostienen', () => {
  const { log, path, arena, layer, vista } = montar(23)
  path.remove(refs(path)[7])                       // merge: deja un chunk en la free-list
  while (path.chunkUsed(path.lastChunk) < CAP - 1)
    path.insertAfter(path.lastVertex, -33.4 - path.length * 0.0004, -70.5)
  path.insertAfter(path.lastVertex, -33.5, -70.55) // split: toma el chunk liberado, al final del trazo
  arena.syncStructure()

  limpiar(log)
  layer.draw(vista)
  const vivos = []
  arena.eachRange((_o, first) => vivos.push(path.chunkOf(first)))
  assert.ok(vivos.some((k, o) => k !== o), 'el orden del trazo no es el del arena')
  verificar(log, arena, path)
  assert.ok(esSubsecuencia(estaticos(log).map(par), segmentos(path).map(par)))
})

test('un trazo vacío, y uno de un solo vértice, no dibujan un segmento', () => {
  const solo = montar(1)
  solo.layer.draw(solo.vista)
  assert.deepEqual(solo.log.draws, [])

  const vacio = montar(0)
  vacio.layer.draw(vacio.vista)
  assert.deepEqual(vacio.log.draws, [])
})

/* ── 2. El cierre del anillo ── */

test('el segmento de cierre existe si y sólo si `path.closed`', () => {
  const { log, path, arena, layer, vista } = montar(23)
  const cierre = [path.lastVertex, path.firstVertex]

  layer.draw(vista)
  assert.ok(!dibujados(log, arena, path).includes(par(cierre)), 'abierto: el último vértice no cierra')

  path.setClosed(true)
  limpiar(log)
  layer.draw(vista)
  assert.equal(segmentos(path).length, path.length, 'anillo: un segmento por vértice')
  assert.equal(dibujados(log, arena, path).filter(s => s === par(cierre)).length, 1, 'y el cierre va UNA vez')
  verificar(log, arena, path, segmentos(path), 'cerrado')

  path.setClosed(false)
  limpiar(log)
  layer.draw(vista)
  assert.ok(!dibujados(log, arena, path).includes(par(cierre)), 'reabierto: el cierre se va')
  verificar(log, arena, path, segmentos(path), 'reabierto')
})

test('el anillo entero en UN chunk también cierra, y el cierre sale suelto', () => {
  const { log, path, arena, layer, vista } = montar(7, { closed: true })
  layer.draw(vista)
  assert.equal(path.chunkOf(path.firstVertex), path.chunkOf(path.lastVertex), 'un solo chunk')
  verificar(log, arena, path)
  assert.deepEqual(sueltos(log, arena, path).map(par), [par([path.lastVertex, path.firstVertex])],
    'el último vértice no tiene al primero contiguo, aunque compartan chunk')
})

/* ── 3. Split, merge y grow: la cobertura aguanta ── */

test('tras 1.500 ediciones al azar la cobertura sigue exacta, y el pase estático sigue en orden', () => {
  let semilla = 0x9e3779b9
  const azar = () => {
    semilla = (semilla ^ (semilla << 13)) >>> 0
    semilla = (semilla ^ (semilla >>> 17)) >>> 0
    semilla = (semilla ^ (semilla << 5)) >>> 0
    return semilla / 0x100000000
  }

  const { log, path, arena, layer, vista } = montar(11, { closed: true })
  let splits = 0
  let merges = 0

  Array.from({ length: 1500 }, (_, paso) => paso).forEach(paso => {
    const vivos = path.chunkCount - path.freeChunks
    const ref   = refs(path)[Math.min(path.length - 1, Math.floor(azar() * path.length))]
    const dado  = azar()
    const lat   = -33.4 - (paso % 97) * 0.002
    const lng   = -70.6 + (paso % 89) * 0.003

    if (dado < 0.42 || path.length < 20) path.insertAfter(ref, lat, lng)
    else if (dado < 0.9) path.remove(ref)
    else path.moveVertex(ref, lat, lng)
    arena.syncStructure()

    const ahora = path.chunkCount - path.freeChunks
    splits += Math.max(0, ahora - vivos)
    merges += Math.max(0, vivos - ahora)

    limpiar(log)
    layer.draw(vista)
    verificar(log, arena, path, segmentos(path), `paso ${paso}`)
    assert.ok(esSubsecuencia(estaticos(log).map(par), segmentos(path).map(par)), `orden en el paso ${paso}`)
  })

  assert.ok(splits > 5, `la corrida tiene que haber partido chunks (${splits})`)
  assert.ok(merges > 5, `y haber fusionado (${merges})`)
})

/* ── 4. El arrastre: dos rangos, dos segmentos vivos y cero escrituras ── */

test('el promovido saca sus dos segmentos del pase estático, y vuelven con su posición VIVA', () => {
  const { log, path, arena, layer, vista } = montar(23)
  const v = refs(path)[3]
  layer.promote(v).live(-34.9, -71.9)
  layer.draw(vista)

  const vivos = sueltos(log, arena, path).filter(s => s.includes(null))
  assert.equal(vivos.length, 2, 'los dos segmentos que tocan al promovido')
  assert.deepEqual(vivos.map(par).sort(), [par([null, path.nextVertex(v)]), par([path.prevVertex(v), null])].sort())
  assert.deepEqual(estaticos(log).filter(([a, b]) => a === v || b === v), [],
    'y ninguno de los dos quedó también en un rango: el doble AA sería visible')
  verificar(log, arena, path, conVivo(path, v), 'con el promovido en arrastre')
})

test('el rango del chunk del promovido se parte en DOS alrededor de su segmento', () => {
  const { log, path, arena, layer, vista } = montar(23)
  const v = refs(path).find(ref => {
    const k = path.chunkOf(ref)
    return path.chunkOf(path.prevVertex(ref)) === k && path.chunkOf(path.nextVertex(ref)) === k
      && ref > path.refOf(k, path.chunkFirst(k)) + 2
  })
  assert.ok(v > 0, 'hace falta un vértice con los dos vecinos adentro del run y con lugar antes')

  layer.promote(v)
  limpiar(log)
  layer.draw(vista)
  const propios = log.draws.filter(d => !d.loose && path.chunkOf(d.base) === path.chunkOf(v))
  assert.equal(propios.length, 2, 'dos rangos, no uno con el segmento adentro')
  verificar(log, arena, path, segmentos(path), 'promovido sin mover')
})

test('promover el primer vértice de un anillo cerrado parte los rangos y se lleva el cierre', () => {
  const { log, path, arena, layer, vista } = montar(23, { closed: true })
  const v = path.firstVertex
  assert.equal(path.prevVertex(v), path.lastVertex)
  assert.notEqual(path.chunkOf(path.lastVertex), path.chunkOf(v), 'y vive en el chunk más lejano del arena')

  layer.promote(v).live(-34.9, -71.9)
  layer.draw(vista)
  const vivos = sueltos(log, arena, path).filter(s => s.includes(null))
  assert.deepEqual(vivos.map(par).sort(), [par([path.lastVertex, null]), par([null, path.nextVertex(v)])].sort(),
    'el cierre del anillo es uno de los dos segmentos vivos')
  verificar(log, arena, path, conVivo(path, v), 'con el primer vértice del anillo en arrastre')
})

test('en un trazo abierto la punta arrastra UN solo segmento, y no inventa el que no existe', () => {
  const primero = montar(23)
  primero.layer.promote(primero.path.firstVertex).live(-34.9, -71.9)
  primero.layer.draw(primero.vista)
  const vivosPrimero = sueltos(primero.log, primero.arena, primero.path).filter(s => s.includes(null))
  assert.deepEqual(vivosPrimero, [[null, primero.path.nextVertex(primero.path.firstVertex)]])
  verificar(primero.log, primero.arena, primero.path, conVivo(primero.path, primero.path.firstVertex), 'primero')

  const ultimo = montar(23)
  ultimo.layer.promote(ultimo.path.lastVertex).live(-34.9, -71.9)
  ultimo.layer.draw(ultimo.vista)
  const vivosUltimo = sueltos(ultimo.log, ultimo.arena, ultimo.path).filter(s => s.includes(null))
  assert.deepEqual(vivosUltimo, [[ultimo.path.prevVertex(ultimo.path.lastVertex), null]])
  verificar(ultimo.log, ultimo.arena, ultimo.path, conVivo(ultimo.path, ultimo.path.lastVertex), 'último')
})

// `setClosed` no mueve una sola entrada y sin embargo le ESTRENA anterior al primer vértice: guardar el
// recálculo por revisión estructural dejaría el cierre dibujado dos veces —suelto y vivo—.
test('cerrar el trazo con el primer vértice ya promovido le estrena segmento vivo', () => {
  const { log, path, arena, layer, vista } = montar(23)
  const v = path.firstVertex
  layer.promote(v).live(-34.9, -71.9)
  layer.draw(vista)
  assert.equal(sueltos(log, arena, path).filter(s => s.includes(null)).length, 1)

  path.setClosed(true)
  limpiar(log)
  layer.draw(vista)
  assert.equal(sueltos(log, arena, path).filter(s => s.includes(null)).length, 2, 'ahora también arrastra el cierre')
  verificar(log, arena, path, conVivo(path, v), 'tras cerrar')
})

test('el promovido que no es un vértice no abre ningún agujero', () => {
  const { log, path, arena, layer, vista } = montar(23)
  layer.promote(path.midOf(refs(path)[3]))
  layer.draw(vista)
  assert.equal(layer.promoted, path.midOf(refs(path)[3]))
  verificar(log, arena, path, segmentos(path), 'con un midpoint promovido')
  assert.deepEqual(sueltos(log, arena, path).filter(s => s.includes(null)), [], 'y no dibuja ningún vivo')
})

test('promover, arrastrar y soltar no escribe un solo byte a la GPU', () => {
  const { spy, path, layer, vista } = montar(23)
  const v = refs(path)[3]
  spy.texImages.length = spy.texSubImages.length = 0
  spy.bufferDatas.length = spy.bufferSubDatas.length = spy.uploads.length = 0

  layer.promote(v)
  Array.from({ length: 50 }, (_, i) => i).forEach(i => {
    layer.live(-33.4 - i * 0.001, -70.6 + i * 0.001)
    layer.draw(vista)
  })
  layer.promote(-1)
  layer.draw(vista)

  assert.deepEqual({
    textura : spy.texImages.length + spy.texSubImages.length,
    buffer  : spy.bufferDatas.length + spy.bufferSubDatas.length,
  }, { textura: 0, buffer: 0 }, 'el vértice en movimiento viaja como uniform')
})

/* ── 5. Geometría del draw y culleo ── */

// El ref de un vértice NO tiene paridad fija —`entriesPerChunk` es impar—, así que la entrada donde
// arranca el rango no se puede leer del `first` del draw: viaja por uniform y el shader la suma.
test('cada draw son quads enteros y arranca en una ENTRADA de vértice, que viaja por uniform', () => {
  const { log, path, arena, layer, vista } = montar(23, { closed: true })
  layer.draw(vista)

  assert.ok(path.entriesPerChunk & 1, 'el chunk impar es lo que desacopla la paridad del ref')
  log.draws.forEach(d => {
    assert.equal(d.mode, TRIANGLES)
    assert.equal(d.first, 0, 'el arranque no va en el draw')
    assert.equal(d.count % ESQUINAS, 0, 'quads enteros')
  })
  assert.ok(log.draws.filter(d => !d.loose).every(d => path.roleAt(d.base) === ROLE.vertex),
    'y el arranque del rango es siempre el vértice de un segmento')
  assert.deepEqual([...new Set(log.draws.filter(d => d.loose).map(d => d.count))], [ESQUINAS],
    'el suelto es UN quad, con los extremos por uniform')
  assert.equal(log.uniformes.halfWidth, ANCHO / 2)
  assert.deepEqual(log.uniformes.texGeom, [arena.textureWidth - 1, Math.log2(arena.textureWidth)],
    'el índice de entrada llega al texel por máscara y corrimiento')
  assert.deepEqual(log.uniformes.pixel, [2 / SIZE.x, 2 / SIZE.y], 'el ancho se expande en píxeles CSS')
  assert.ok(path.chunkCount > 1)
})

test('lo que no se ve no se dibuja: el rango por la caja del chunk y la costura por la suya', () => {
  const { log, path, arena, layer } = montar(23)
  const salida  = refs(path).find(ref => path.chunkOf(path.nextVertex(ref)) !== path.chunkOf(ref))
  const llegada = path.nextVertex(salida)
  const medio   = refs(path)[10]                 // el del medio del segundo chunk: sus dos costuras lejos

  layer.draw(vistaEn(arena, arena.relX(medio), arena.relY(medio)))
  assert.deepEqual([...new Set(estaticos(log).map(([a]) => path.chunkOf(a)))], [path.chunkOf(medio)],
    'sólo el chunk bajo la vista pone su rango')
  assert.deepEqual(sueltos(log, arena, path), [], 'y ninguna costura cruza esa vista')

  limpiar(log)
  layer.draw(vistaEn(arena, (arena.relX(salida) + arena.relX(llegada)) / 2,
    (arena.relY(salida) + arena.relY(llegada)) / 2))
  assert.deepEqual(sueltos(log, arena, path).map(par), [par([salida, llegada])],
    'sobre la costura, la costura')

  // Los dos ejes por separado: el trazo de prueba avanza en diagonal, así que una vista corrida en un
  // solo eje es lo único que distingue el recorte en x del recorte en y.
  limpiar(log)
  layer.draw(vistaEn(arena, arena.relX(salida) + 1, arena.relY(salida)))
  assert.deepEqual(log.draws, [], 'corrido sólo en x, nada')

  limpiar(log)
  layer.draw(vistaEn(arena, arena.relX(salida), arena.relY(salida) + 1))
  assert.deepEqual(log.draws, [], 'corrido sólo en y, nada')
})

// El programa se comparte por (contexto, paso) y muere con el contexto, así que borrarlo desde una capa
// dejaría mudas a las demás. El ciclo de vida compartido está en `edit-programs.test.mjs`.
test('destroy libera el VAO, que es de la capa, y no el programa, que es del contexto', () => {
  const gl      = makeGl()
  const borrado = { programas: 0, vaos: 0 }
  gl.deleteProgram      = () => { borrado.programas++ }
  gl.deleteVertexArray  = () => { borrado.vaos++ }
  const path  = new ChunkedPath({ points: puntos(23), localBits: BITS })
  const arena = new EditArena({ gl, path, project })

  new EditStrokeLayer({ gl, arena, path, project }).destroy()
  assert.deepEqual(borrado, { programas: 0, vaos: 1 })
})

// El trazo consume del almacén `relX`/`relY`/`textureWidth` y la topología `rev`/`roleAt`/`nextVertex`.
// Un anillo estático los cumple con aritmética y sin chunks, de donde el pase es un span y un cierre.
test('anillo estático: un span contiguo de n-1 segmentos y el cierre del anillo suelto', () => {
  const log   = { draws: [], uniformes: {} }
  const gl    = conPrograma(makeGl(), log)
  const N     = 6
  const store = new RingStore({ gl, points: puntos(N), project })
  const layer = new EditStrokeLayer({ gl, arena: store, path: store, project, paso: 1, width: ANCHO })

  layer.draw(vistaSobre(store, 8))

  const contiguos = log.draws.filter(d => !d.loose)
  const sueltos   = log.draws.filter(d => d.loose)
  assert.deepEqual(contiguos.map(d => [d.base, d.count]), [[0, (N - 1) * 6]],
    'sin chunks el rango no se parte: un span con los n-1 segmentos contiguos')
  assert.equal(sueltos.length, 1, 'y un único suelto')
  assert.deepEqual(sueltos[0].loose, [store.relX(N - 1), store.relY(N - 1), store.relX(0), store.relY(0)],
    'que es el cierre: del último vértice al primero')
})
