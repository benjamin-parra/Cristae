// Contrato del espejo GPU del arena editable, sobre el espía de subidas del harness: lo que se mide es
// TRABAJO —cuántas subidas, de qué tamaño, a qué offset—, nunca reloj. Cinco invariantes:
//
//   · el commit de un vértice cuesta 1 texel y ≤ 2 rangos, y ese costo NO depende de N;
//   · el pan y el zoom no escriben un solo byte (es lo que prueba el ancla como origen de precisión);
//   · los rangos de dibujo cubren exactamente las entradas vivas, tras split, merge y grow;
//   · el ordinal del trazo sobrevive un `grow` — usar el índice del arena daría hits atribuidos a otro
//     chunk sin ningún error a la vista;
//   · `syncStructure()` encuentra los chunks sucios SOLO, sin que el llamador le diga qué se editó: la
//     firma (first, used) puede volver intacta con todo el contenido corrido.
//
// El harness va primero: instala los globals de módulo que el resto del árbol toca al evaluarse.
import { makeGl } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ChunkedPath, ROLE } from '../../src/geometry/ChunkedPath.js'
import { EditArena } from '../../src/render/EditArena.js'

// cap 31 · runCap 30 · ingest y mínimo en 7 parejas: las tres transiciones del arena caen con pocos
// vértices y el `cap` IMPAR desacopla la paridad del ref de la del local, igual que en producción.
const BITS = 5
const CAP  = 31

const FLOATS = 7
const BYTES  = FLOATS * 4

// world0: el planeta entero mide 256 px a z0. Con esa escala float32 NO alcanza para posiciones
// absolutas a z18 — que es exactamente lo que el ancla existe para resolver.
const W0 = 256 / 360

const project = (lat, lng, out) => {
  out[0] = (lng + 180) * W0
  out[1] = (90 - lat) * W0
}

const SIZE = { x: 800, y: 600 }

const puntos = n => Array.from({ length: n }, (_, i) => [-33.45 + i * 0.0007, -70.66 + i * 0.0011])

const montar = (n, { localBits = BITS, closed = false, ...extra } = {}) => {
  const gl    = makeGl()
  const path  = new ChunkedPath({ points: puntos(n), localBits, closed })
  const arena = new EditArena({ gl, path, project, ...extra })
  return { gl, spy: gl.spy, path, arena }
}

const limpiar = spy => {
  spy.texImages.length = spy.texSubImages.length = 0
  spy.bufferDatas.length = spy.bufferSubDatas.length = spy.uploads.length = 0
  return spy
}

// Las entradas que se subieron al VBO, desarmadas por ref: los rangos son contiguos, así que el payload
// se corta en tramos de 7 floats desde el srcOffset del pedido.
const subidas = spy => new Map(spy.bufferSubDatas.flatMap((s, i) =>
  Array.from({ length: s.length / FLOATS }, (_, j) =>
    [s.srcOffset / FLOATS + j, [...spy.uploads[i].slice(j * FLOATS, (j + 1) * FLOATS)]])))

// Chunks vivos en ORDEN DE TRAZO, que es lo que lleva la lista — no el orden del arena.
const cadena = path => {
  const out = []
  for (let k = path.firstChunk; k >= 0; k = path.chunkNext(k)) out.push(k)
  return out
}

const refs = path => {
  const out = []
  path.forEachVertex((x, y, ref) => out.push(ref))
  return out
}

const rangos = arena => {
  const out = []
  arena.eachRange((ordinal, first, count, chunk) => out.push({ ordinal, first, count, chunk }))
  return out
}

const cubiertas = arena => rangos(arena)
  .flatMap(r => Array.from({ length: r.count }, (_, i) => r.first + i))

const xy = new Float64Array(2)

// La posición que el espejo TENDRÍA que tener para un ref: proyectada, relativa al ancla y en float32.
const esperada = (arena, path, ref) => {
  project(path.xAt(ref), path.yAt(ref), xy)
  return [Math.fround(xy[0] - arena.anchor.x), Math.fround(xy[1] - arena.anchor.y)]
}

const espejo = (arena, ref) => [arena.relX(ref), arena.relY(ref)]

const contieneEstricto = (a, b) => a[0] < b[0] || a[1] < b[1] || a[2] > b[2] || a[3] > b[3]

const cajaExacta = (arena, path, k) => {
  const from = k * path.entriesPerChunk + path.chunkFirst(k)
  const to   = from + path.chunkUsed(k)
  return Array.from({ length: to - from }, (_, i) => from + i).reduce(
    (b, ref) => [Math.min(b[0], arena.relX(ref)), Math.min(b[1], arena.relY(ref)),
      Math.max(b[2], arena.relX(ref)), Math.max(b[3], arena.relY(ref))],
    [Infinity, Infinity, -Infinity, -Infinity])
}

/* ── 1. Ingesta: el ancla, el espejo y una sola subida ── */

test('el ancla es el centro del bbox proyectado y el espejo guarda las posiciones relativas a ella', () => {
  const { path, arena } = montar(23)
  const caja = refs(path).reduce((b, ref) => {
    project(path.xAt(ref), path.yAt(ref), xy)
    return [Math.min(b[0], xy[0]), Math.min(b[1], xy[1]), Math.max(b[2], xy[0]), Math.max(b[3], xy[1])]
  }, [Infinity, Infinity, -Infinity, -Infinity])

  assert.equal(arena.anchor.x, (caja[0] + caja[2]) / 2)
  assert.equal(arena.anchor.y, (caja[1] + caja[3]) / 2)
  cubiertas(arena).forEach(ref =>
    assert.deepEqual(espejo(arena, ref), esperada(arena, path, ref), `entrada ${ref}`))
})

test('un trazo vacío no tiene ancla que congelar y no rompe la ingesta', () => {
  const { arena } = montar(0)
  assert.deepEqual(arena.anchor, { x: 0, y: 0 })
  assert.deepEqual(rangos(arena), [{ ordinal: 0, first: 0, count: 0, chunk: 0 }])
})

test('la ingesta sube la textura y el VBO UNA vez cada uno, y ningún rango', () => {
  const { spy, path, arena } = montar(23)
  assert.deepEqual(spy.texImages, [{ width: arena.textureWidth, height: arena.textureHeight }])
  assert.deepEqual(spy.bufferDatas, [{ length: path.chunkCount * path.entriesPerChunk * FLOATS }])
  assert.deepEqual([spy.texSubImages.length, spy.bufferSubDatas.length], [0, 0])
})

test('el VBO lleva el encoding de PointLayer: id = local + 1 en b,a, y el ROL elige tile y tamaño', () => {
  const { spy, path, arena } = montar(23, { tiles: [7, 8, 9], sizes: [1, 2, 3] })
  const v   = refs(path)[3]
  const mid = path.midOf(v)
  limpiar(spy)
  arena.writeEntry(v)

  const id     = ref => path.localOf(ref) + 1
  const modelo = (ref, tile, size) => [...esperada(arena, path, ref), tile, 0,
    Math.fround((id(ref) >> 8) / 255), Math.fround((id(ref) & 255) / 255), size]
  const subido = subidas(spy)

  assert.deepEqual(subido.get(v),   modelo(v, 8, 2),   'vértice: el tile y el tamaño de su rol')
  assert.deepEqual(subido.get(mid), modelo(mid, 9, 3), 'midpoint: los suyos, y la paridad del local es el kind')
  assert.equal(Math.round(subido.get(v)[4] * 255) * 256 + Math.round(subido.get(v)[5] * 255), id(v))
})

test('el midpoint inactivo del último vértice de un trazo abierto se apaga con el tile transparente', () => {
  const { spy, path, arena } = montar(23, { tiles: [7, 8, 9], sizes: [1, 2, 3] })
  const v = path.lastVertex
  assert.equal(path.roleAt(path.midOf(v)), ROLE.free, 'existe, vive dentro del run, y no dibuja segmento')
  limpiar(spy)
  arena.writeEntry(v)

  const mid = subidas(spy).get(path.midOf(v))
  assert.deepEqual([mid[2], mid[6]], [7, 1], 'una escritura, sin excepción en el batch')
})

/* ── 2. Commit de un vértice: 1 texel, ≤ 2 rangos, independiente de N ── */

const trabajo = (spy, path, arena, v) => {
  limpiar(spy)
  path.moveVertex(v, path.xAt(v) - 0.02, path.yAt(v) + 0.03)
  assert.equal(arena.writeEntry(v), true)
  return { texels: [...spy.texSubImages], rangos: [...spy.bufferSubDatas] }
}

test('el commit sube UN texel de 1×1 y UN rango contiguo cuando el anterior vive en su mismo chunk', () => {
  const { spy, path, arena } = montar(23)
  const v = refs(path)[3]
  assert.equal(path.chunkOf(path.prevVertex(v)), path.chunkOf(v))

  const { texels, rangos: subidas } = trabajo(spy, path, arena, v)
  assert.deepEqual(texels, [{ x: v & (arena.textureWidth - 1), y: v >> Math.log2(arena.textureWidth), width: 1, height: 1, srcOffset: v * 2 }])
  assert.deepEqual(subidas, [{ offset: (v - 1) * BYTES, srcOffset: (v - 1) * FLOATS, length: 3 * FLOATS }],
    'el vértice, su midpoint y el del anterior son tres entradas contiguas del arena')
  assert.deepEqual(espejo(arena, v), esperada(arena, path, v))
  assert.deepEqual(espejo(arena, path.midOf(v)), esperada(arena, path, path.midOf(v)))
})

test('con el anterior en OTRO chunk el commit parte la subida del VBO en dos, y el texel sigue siendo uno', () => {
  const { spy, path, arena } = montar(23)
  const orden = refs(path)
  const borde = orden.findIndex((ref, i) => i > 0 && path.chunkOf(ref) !== path.chunkOf(orden[i - 1]))
  assert.ok(borde > 0, 'el trazo tiene que cruzar al menos un chunk')
  const v = orden[borde]
  const p = orden[borde - 1]

  const { texels, rangos: subidas } = trabajo(spy, path, arena, v)
  assert.equal(texels.length, 1)
  assert.deepEqual(subidas, [
    { offset: v * BYTES,       srcOffset: v * FLOATS,       length: 2 * FLOATS },
    { offset: (p + 1) * BYTES, srcOffset: (p + 1) * FLOATS, length: FLOATS },
  ])
  assert.deepEqual(espejo(arena, p + 1), esperada(arena, path, p + 1), 'el midpoint que LLEGA es del anterior')
})

test('el primer vértice de un trazo abierto no arrastra midpoint anterior: un solo rango de dos entradas', () => {
  const { spy, path, arena } = montar(23)
  const v = path.firstVertex
  const { rangos: subidas } = trabajo(spy, path, arena, v)
  assert.deepEqual(subidas, [{ offset: v * BYTES, srcOffset: v * FLOATS, length: 2 * FLOATS }])
})

test('en un anillo cerrado el primer vértice sí lo arrastra, desde el chunk más lejano del arena', () => {
  const { spy, path, arena } = montar(23, { closed: true })
  const v = path.firstVertex
  const p = path.lastVertex
  assert.notEqual(path.chunkOf(p), path.chunkOf(v))
  const { texels, rangos: subidas } = trabajo(spy, path, arena, v)
  assert.equal(texels.length, 1)
  assert.deepEqual(subidas.map(s => s.offset), [v * BYTES, (p + 1) * BYTES])
})

test('el commit mide lo MISMO con 400, 5.000 y 50.000 vértices: se mide trabajo, no reloj', () => {
  const medir = n => {
    const { spy, path, arena } = montar(n, { localBits: 12 })      // el chunk de producción
    return trabajo(spy, path, arena, refs(path)[3])
  }
  const chico = medir(400)
  assert.equal(chico.texels.length, 1)
  assert.equal(chico.rangos.length, 1)
  assert.deepEqual(medir(5000), chico)
  assert.deepEqual(medir(50000), chico)
})

test('el commit rechaza lo que no es un vértice vivo y no escribe nada', () => {
  const { spy, path, arena } = montar(23)
  limpiar(spy)
  assert.equal(arena.writeEntry(path.midOf(path.firstVertex)), false)
  assert.equal(arena.writeEntry(-1), false)
  assert.equal(arena.writeEntry(CAP - 2), false, 'entrada muerta del arena')
  assert.equal(arena.writeEntry(1e9), false)
  assert.deepEqual([spy.texSubImages.length, spy.bufferSubDatas.length], [0, 0])
})

/* ── 3. El bbox de chunk: monótono al mover, exacto tras la operación estructural ── */

test('mover agranda el bbox del chunk y NO lo encoge al volver: sobredimensionar es correcto', () => {
  const { path, arena } = montar(23)
  const v      = refs(path)[3]
  const k      = path.chunkOf(v)
  const origen = [path.xAt(v), path.yAt(v)]

  path.moveVertex(v, -34.9, -71.9)
  arena.writeEntry(v)
  const crecido = [...arena.boxOfChunk(k)]

  path.moveVertex(v, origen[0], origen[1])
  arena.writeEntry(v)
  assert.deepEqual([...arena.boxOfChunk(k)], crecido, 'el bbox de un chunk nunca encoge al mover')
  assert.ok(contieneEstricto(crecido, cajaExacta(arena, path, k)), 'y quedó estrictamente sobredimensionado')
})

test('la operación estructural vuelve exacto el bbox de los chunks que tocó', () => {
  const { path, arena } = montar(23)
  const v = refs(path)[3]
  path.moveVertex(v, -34.9, -71.9)
  arena.writeEntry(v)
  path.moveVertex(v, -33.45, -70.66)
  arena.writeEntry(v)
  assert.ok(contieneEstricto([...arena.boxOfChunk(path.chunkOf(v))], cajaExacta(arena, path, path.chunkOf(v))))

  path.insertAfter(v, -33.46, -70.67)
  arena.syncStructure()
  cadena(path).forEach(k =>
    assert.deepEqual([...arena.boxOfChunk(k)], cajaExacta(arena, path, k), `bbox exacto del chunk ${k}`))
})

/* ── 4. Operación estructural: ≤ 2 rangos de chunk, y el espejo encuentra SOLO los chunks sucios ── */

// Las subidas de TEXTURA son exactamente los rangos de chunk: la textura sólo lleva vértices, así que un
// refresco de midpoint (afordancia) se ve en el VBO y no ahí.
const rangosDeChunk = (spy, path) => {
  assert.ok(spy.texSubImages.length <= 2, `rangos de chunk: ${spy.texSubImages.length}`)
  spy.texSubImages.forEach(t => assert.ok(t.width * t.height <= path.entriesPerChunk,
    'un rango no puede exceder el chunk'))
  return spy.texSubImages.length
}

const insertar = (path, arena, tras, lat, lng) => {
  const nuevo = path.insertAfter(tras, lat, lng)
  arena.syncStructure()
  return nuevo
}

const borrar = (path, arena, ref) => {
  path.remove(ref)
  arena.syncStructure()
}

test('partir un chunk sube DOS rangos —el partido y el nuevo— y ninguno excede el chunk', () => {
  const { spy, path, arena } = montar(23)
  borrar(path, arena, refs(path)[7])               // merge: deja un chunk en la free-list
  while (path.chunkUsed(path.lastChunk) < CAP - 1)
    insertar(path, arena, path.lastVertex, -33.4 - path.length * 0.0004, -70.5)
  const antes = path.chunkCount

  limpiar(spy)
  insertar(path, arena, path.lastVertex, -33.9, -70.9)
  assert.equal(path.chunkCount, antes, 'el split tomó el chunk de la free-list, sin crecer el arena')
  assert.equal(rangosDeChunk(spy, path), 2)
  assert.deepEqual(spy.texImages, [], 'y sin realocar la textura')
})

test('borrar con borrow y borrar con merge suben a lo sumo dos rangos de chunk', () => {
  const { spy, path, arena } = montar(23)

  limpiar(spy)
  borrar(path, arena, refs(path)[7])               // merge: el chunk corto se fusiona con el vecino
  assert.equal(path.freeChunks, 1)
  rangosDeChunk(spy, path)

  const flaco  = cadena(path)[1]
  const cabeza = refs(path).findIndex(ref => path.chunkOf(ref) === flaco)
  limpiar(spy)
  borrar(path, arena, refs(path)[cabeza])          // borrow: le pide una pareja al vecino más gordo
  assert.equal(path.freeChunks, 1, 'un borrow no libera ningún chunk')
  rangosDeChunk(spy, path)
})

// El caso que ningún hint del llamador tendría por qué cubrir, y que la firma no ve: borrar el ARRANQUE
// del run corre el `first` dos entradas y el borrow del chunk ANTERIOR lo devuelve, así que (first, used)
// queda idéntico con el run entero corrido y un vértice ajeno al frente.
test('el borrow desde el chunk anterior deja la firma intacta, y el espejo sube el chunk igual', () => {
  const { spy, path, arena } = montar(23)
  borrar(path, arena, refs(path)[7])               // merge: el vecino de la izquierda queda gordo
  const flaco  = cadena(path)[1]
  const cabeza = refs(path).findIndex(ref => path.chunkOf(ref) === flaco)
  const firma  = [path.chunkFirst(flaco), path.chunkUsed(flaco)]
  const cedido = path.prevVertex(refs(path)[cabeza])
  assert.notEqual(path.chunkOf(cedido), flaco, 'el vértice que va a migrar todavía vive en el anterior')

  limpiar(spy)
  borrar(path, arena, refs(path)[cabeza])

  const arranque = path.refOf(flaco, path.chunkFirst(flaco))
  assert.deepEqual([path.chunkFirst(flaco), path.chunkUsed(flaco)], firma,
    'la firma vuelve al mismo par: sola no delata nada')
  assert.equal(path.xAt(arranque), path.xAt(cedido), 'y sin embargo el frente del run es otro vértice')
  assert.deepEqual(espejo(arena, arranque), esperada(arena, path, arranque),
    'el espejo lo detectó por revisión de contenido, sin que nadie le diga qué se editó')
  assert.ok(subidas(spy).has(arranque), 'y la entrada viajó al VBO')
  cubiertas(arena).forEach(ref =>
    assert.deepEqual(espejo(arena, ref), esperada(arena, path, ref), `entrada ${ref}`))
})

// Con el hueco en la mitad BAJA, la copia del split es el único contacto que el chunk nuevo tiene con
// la edición: nadie vuelve a tocarlo.
test('la mitad que migra en el split llega al espejo aunque el hueco se abra en el chunk viejo', () => {
  const { path, arena } = montar(7)
  while (path.chunkUsed(path.firstChunk) < CAP - 1)
    insertar(path, arena, path.lastVertex, -33.4 - path.length * 0.0004, -70.5)
  assert.equal(cadena(path).length, 1, 'un solo chunk, con el run al tope')

  insertar(path, arena, refs(path)[2], -33.9, -70.9)
  const [viejo, nuevo] = cadena(path)
  assert.equal(path.chunkOf(refs(path)[3]), viejo, 'el hueco se abrió en el chunk viejo')
  assert.ok(path.chunkUsed(nuevo) > 0, 'y la mitad alta migró al nuevo')
  cubiertas(arena).forEach(ref =>
    assert.deepEqual(espejo(arena, ref), esperada(arena, path, ref), `entrada ${ref}`))
})

test('el `append` sobre el trazo vacío llega al espejo: estrena contenido sin moverlo', () => {
  const { path, arena } = montar(0)
  const ref = path.append(-33.45, -70.66)
  arena.syncStructure()
  assert.deepEqual(espejo(arena, ref), esperada(arena, path, ref))
})

/* ── 5. Pan y zoom: CERO escrituras ── */

test('un guion de pan y zoom no escribe un solo byte: el desplazamiento lo absorbe la matriz', () => {
  const { spy, arena } = montar(230)
  limpiar(spy)

  const vistas = Array.from({ length: 200 }, (_, i) => ({
    zoom   : 4 + (i % 15),
    center : { x: 77.7 + i * 0.0001, y: 63.2 - i * 0.00013 },
  }))
  const matrices = vistas.map(v => [...arena.matrixFor(v.zoom, v.center, SIZE)])

  assert.deepEqual({
    textura : spy.texImages.length + spy.texSubImages.length,
    buffer  : spy.bufferDatas.length + spy.bufferSubDatas.length,
  }, { textura: 0, buffer: 0 })
  assert.equal(new Set(matrices.map(m => m.join())).size, vistas.length, 'y la vista cambió en cada paso')
})

test('la matriz lleva el rel-ancla al píxel de pantalla que le corresponde', () => {
  const { path, arena } = montar(230)
  const zoom   = 14
  const scale  = 2 ** zoom
  const center = { x: arena.anchor.x, y: arena.anchor.y }
  const origen = { x: center.x - SIZE.x / (2 * scale), y: center.y - SIZE.y / (2 * scale) }
  const m      = arena.matrixFor(zoom, center, SIZE)

  refs(path).forEach(ref => {
    project(path.xAt(ref), path.yAt(ref), xy)
    const px = (m[0] * arena.relX(ref) + m[12] + 1) / 2 * SIZE.x
    const py = (1 - (m[5] * arena.relY(ref) + m[13])) / 2 * SIZE.y
    assert.ok(Math.abs(px - (xy[0] - origen.x) * scale) < 0.01, `x del ref ${ref}`)
    assert.ok(Math.abs(py - (xy[1] - origen.y) * scale) < 0.01, `y del ref ${ref}`)
  })
})

test('a z18 el rel-ancla conserva el subpíxel y la posición ABSOLUTA en float32 ya no', () => {
  const { path, arena } = montar(230)
  const zoom   = 18
  const scale  = 2 ** zoom
  const center = { x: arena.anchor.x, y: arena.anchor.y }
  const origen = center.x - SIZE.x / (2 * scale)
  const m      = arena.matrixFor(zoom, center, SIZE)

  const errores = refs(path).map(ref => {
    project(path.xAt(ref), path.yAt(ref), xy)
    const exacto   = (xy[0] - origen) * scale
    const relativo = (m[0] * arena.relX(ref) + m[12] + 1) / 2 * SIZE.x
    const absoluto = (Math.fround(xy[0]) - origen) * scale
    return [Math.abs(relativo - exacto), Math.abs(absoluto - exacto)]
  })

  assert.ok(Math.max(...errores.map(e => e[0])) < 0.02, 'relativo al ancla: subpíxel')
  assert.ok(Math.max(...errores.map(e => e[1])) > 0.5, 'absoluto: el error es VISIBLE al arrastrar')
})

/* ── 6. Ordinal ↔ chunk, y el grow ── */

const verificarOrdinales = (arena, path, nota = '') => {
  const vivos = cadena(path)
  assert.equal(arena.ordinalCount, vivos.length, `ordinales densos ${nota}`)
  vivos.forEach((k, o) => {
    assert.equal(arena.chunkOfOrdinal(o), k, `ordinal ${o} ${nota}`)
    assert.equal(arena.ordinalOfChunk(k), o, `inverso de ${k} ${nota}`)
    assert.equal(arena.refAt(o, path.chunkFirst(k)), path.refOf(k, path.chunkFirst(k)), `ref de ${o} ${nota}`)
  })
  assert.equal(arena.chunkOfOrdinal(vivos.length), -1, `sin ordinal de más ${nota}`)
}

test('la tabla ordinal↔chunk sobrevive un grow: densa, invertible y con el ref bien reconstruido', () => {
  const gl    = makeGl()
  const path  = new ChunkedPath({ points: [], localBits: BITS })
  const arena = new EditArena({ gl, path, project })

  Array.from({ length: 400 }, (_, i) => i).forEach(i => {
    path.append(-33.4 + i * 0.0005, -70.6 + i * 0.0009)
    arena.syncStructure()
  })
  assert.ok(path.chunkCount >= 32, 'hubo varios grow')
  assert.equal(path.chunkCount & (path.chunkCount - 1), 0, 'el arena duplica')
  verificarOrdinales(arena, path, 'tras 400 appends')

  // Un chunk liberado y reusado al final: el orden del TRAZO deja de coincidir con el del arena, que es
  // justo donde numerar por índice daría un hit atribuido a otro chunk.
  borrar(path, arena, refs(path)[7])
  while (path.chunkUsed(path.lastChunk) < CAP - 1)
    insertar(path, arena, path.lastVertex, -34 + path.length * 0.0003, -71)
  insertar(path, arena, path.lastVertex, -34.5, -71.5)

  const vivos = cadena(path)
  assert.ok(vivos.some((k, o) => k !== o), 'el orden del trazo no es el del arena')
  verificarOrdinales(arena, path, 'con el arena desordenado')
  assert.equal(arena.ordinalOfChunk([...Array(path.chunkCount).keys()].find(k => !vivos.includes(k))), -1,
    'un chunk de la free-list no tiene ordinal')
})

test('el grow realoca textura y VBO enteros y conserva el contenido del espejo', () => {
  const gl    = makeGl()
  const path  = new ChunkedPath({ points: puntos(7), localBits: BITS })
  const arena = new EditArena({ gl, path, project })
  const antes = refs(path).map(ref => espejo(arena, ref))

  limpiar(gl.spy)
  while (path.chunkCount === 1)
    insertar(path, arena, path.lastVertex, -33.4 + path.length * 0.0006, -70.5)
  assert.equal(arena.capacity, path.chunkCount * path.entriesPerChunk)
  assert.deepEqual(gl.spy.texImages.at(-1), { width: arena.textureWidth, height: arena.textureHeight })
  assert.equal(gl.spy.bufferDatas.at(-1).length, arena.capacity * FLOATS)
  assert.deepEqual(refs(path).slice(0, antes.length).map(ref => espejo(arena, ref)), antes,
    'los refs vivos no se mueven: el stride es fijo')
})

/* ── 7. Oráculo diferencial ── */

test('tras 10.000 ediciones al azar los rangos cubren exactamente las entradas vivas, y el espejo calza', () => {
  let semilla = 0x9e3779b9
  const azar = () => {
    semilla = (semilla ^ (semilla << 13)) >>> 0
    semilla = (semilla ^ (semilla >>> 17)) >>> 0
    semilla = (semilla ^ (semilla << 5)) >>> 0
    return semilla / 0x100000000
  }
  const indice = n => Math.min(n - 1, Math.floor(azar() * n))
  const refAt  = (p, i) => {
    const cur = p.cursor()
    while (cur.next()) if (cur.index === i) return cur.ref
    return -1
  }

  const { path, arena } = montar(11, { closed: true })
  let splits = 0
  let merges = 0
  let grows  = 0

  const verificar = nota => {
    const vivas = cubiertas(arena)
    assert.equal(vivas.length, path.length * 2, `dos entradas por vértice ${nota}`)
    assert.deepEqual(vivas.filter(ref => (path.localOf(ref) & 1) === 0), refs(path),
      `los rangos enumeran el trazo en orden ${nota}`)
    vivas.forEach(ref => assert.deepEqual(espejo(arena, ref), esperada(arena, path, ref),
      `espejo de la entrada ${ref} ${nota}`))
    verificarOrdinales(arena, path, nota)
  }

  Array.from({ length: 10000 }, (_, paso) => paso).forEach(paso => {
    const vivos  = cadena(path).length
    const arenas = path.chunkCount
    const dado   = azar()
    const i      = indice(path.length)
    const ref    = refAt(path, i)
    const lat    = -33.4 - (paso % 97) * 0.002
    const lng    = -70.6 + (paso % 89) * 0.003

    if (dado < 0.45 || path.length < 3) insertar(path, arena, ref, lat, lng)
    else if (dado < 0.8) borrar(path, arena, ref)
    else {
      path.moveVertex(ref, lat, lng)
      arena.writeEntry(ref)
    }

    splits += Math.max(0, cadena(path).length - vivos)
    merges += Math.max(0, vivos - cadena(path).length)
    grows  += path.chunkCount > arenas ? 1 : 0
    if (paso % 25 === 0) verificar(`paso ${paso}`)
  })

  verificar('final')
  assert.ok(splits > 5, `la corrida tiene que haber partido chunks (${splits})`)
  assert.ok(merges > 5, `y haber fusionado (${merges})`)
  assert.ok(grows > 0, `y haber crecido el arena (${grows})`)
})

/* ── 8. Textura: geometría del pedido ── */

test('el ancho de la textura tiene que ser potencia de dos: el índice→texel es una máscara', () => {
  const gl   = makeGl()
  const path = new ChunkedPath({ points: puntos(7), localBits: BITS })
  assert.throws(() => new EditArena({ gl, path, project, textureWidth: 300 }), /potencia de dos/)
})

test('un rango que cruza la frontera de fila sube FILAS ENTERAS en UNA llamada', () => {
  const { spy, path, arena } = montar(23, { textureWidth: 8 })
  const k = cadena(path)[1]
  limpiar(spy)
  arena.writeRange(k, path.chunkFirst(k), path.chunkFirst(k) + path.chunkUsed(k))

  assert.equal(spy.texSubImages.length, 1)
  const t = spy.texSubImages[0]
  assert.deepEqual([t.x, t.width], [0, 8], 'filas enteras: sin UNPACK_ROW_LENGTH no hay rect parcial')
  assert.ok(t.height > 1, 'y el tramo de verdad cruzó la frontera')
  assert.equal(t.srcOffset, t.y * 8 * 2)
})

test('el tramo se acota al chunk: un `hi` de más sería contenido ajeno', () => {
  const { spy, path, arena } = montar(23)
  limpiar(spy)
  arena.writeRange(1, 0, path.entriesPerChunk * 3)
  assert.equal(spy.texSubImages[0].width, path.entriesPerChunk)
  assert.equal(spy.bufferSubDatas[0].length, path.entriesPerChunk * FLOATS)
  assert.equal(arena.writeRange(1, 4, 4), false, 'un tramo vacío no sube nada')
})

/* ── 9. Teardown ── */

test('destroy libera la textura y el buffer, y es idempotente', () => {
  const gl      = makeGl()
  const borrado = { texturas: 0, buffers: 0 }
  gl.deleteTexture = () => { borrado.texturas++ }
  gl.deleteBuffer  = () => { borrado.buffers++ }
  const path  = new ChunkedPath({ points: puntos(23), localBits: BITS })
  const arena = new EditArena({ gl, path, project })

  arena.destroy()
  assert.deepEqual(borrado, { texturas: 1, buffers: 1 })
  assert.equal(arena.texture, null)
  arena.destroy()
  assert.deepEqual(borrado, { texturas: 1, buffers: 1 }, 'un segundo destroy no vuelve a pedirlo')
})
