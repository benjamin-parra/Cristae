// Prueba de la disciplina del arena (geometry/ChunkedPath.js), no de su fachada: split al desbordar,
// borrow del vecino, merge al quedar corto, free-list que reusa, y el lado MÁS CORTO al desplazar.
// Los chunks se achican con `localBits` para que las tres transiciones caigan con pocos vértices; la
// aritmética es la misma que en producción, incluido el `cap` IMPAR que desacopla la paridad del ref
// de la del local.
// Corre con: node --test test/geometry/chunked-path.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { ChunkedPath, LOCAL_CAP, ROLE } from '../../src/geometry/ChunkedPath.js'

// cap 31 · runCap 30 · 15 parejas · ingest y mínimo en 7 parejas (14 entradas)
const BITS = 5
const CAP  = 31
const FILL = 14
const RUN  = 30

const pares = n => Array.from({ length: n }, (_, i) => [i, i * 10])

const nuevo = (n, extra) => new ChunkedPath({ points: pares(n), localBits: BITS, ...extra })

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

// Recorre hacia adelante y hacia atrás y verifica la disciplina de hoja completa.
const verificar = (path, modelo, nota = '') => {
  assert.deepEqual(path.toPairs(), modelo, `volcado ${nota}`)
  assert.equal(path.length, modelo.length, `length ${nota}`)

  const vivos = cadena(path)
  assert.equal(new Set(vivos).size, vivos.length, `un chunk no puede estar dos veces ${nota}`)
  assert.equal(vivos.length + path.freeChunks, path.chunkCount, `vivos + libres = arena ${nota}`)

  const entradas = vivos.reduce((acc, k) => acc + path.chunkUsed(k), 0)
  assert.equal(entradas, modelo.length * 2, `dos entradas por vértice ${nota}`)

  vivos.forEach((k, i) => {
    assert.equal(path.chunkFirst(k) % 2, 0, `first par en ${k} ${nota}`)
    assert.equal(path.chunkUsed(k) % 2, 0, `used par en ${k} ${nota}`)
    assert.ok(path.chunkUsed(k) > 0, `un chunk vivo no está vacío ${nota}`)
    assert.ok(path.chunkFirst(k) + path.chunkUsed(k) <= RUN, `run dentro del chunk ${k} ${nota}`)
    assert.equal(path.chunkPrev(k), i ? vivos[i - 1] : -1, `prev de ${k} ${nota}`)
  })

  // Ocupación ≥ 50 % salvo UN chunk: el sobrante del ingest, que arranca por debajo del mínimo y sólo
  // se rebalancea cuando alguien lo toca. Es la holgura «+C» de la cota del arena.
  const cortos = vivos.filter(k => path.chunkUsed(k) < FILL)
  assert.ok(cortos.length <= 1, `a lo sumo un chunk por debajo del mínimo: ${cortos} ${nota}`)

  // El recorrido inverso tiene que reproducir el mismo trazo al revés.
  const atras = []
  for (let v = path.lastVertex; v >= 0 && atras.length < modelo.length; v = path.prevVertex(v))
    atras.push([path.xAt(v), path.yAt(v)])
  assert.deepEqual(atras.reverse(), modelo, `recorrido inverso ${nota}`)
}

// ── construcción, volcado y orden de trazo ────────────────────────────────────

test('volcar → construir → volcar es identidad', () => {
  const pts  = pares(23)
  const path = nuevo(23)
  assert.deepEqual(path.toPairs(), pts)
  assert.deepEqual(new ChunkedPath({ points: path.toPairs(), localBits: BITS }).toPairs(), pts)
})

test('el ingest reparte de a medio chunk y deja aire para insertar', () => {
  const path = nuevo(23)
  assert.deepEqual(cadena(path), [0, 1, 2, 3])
  assert.deepEqual([0, 1, 2].map(k => path.chunkUsed(k)), [FILL, FILL, FILL])
  assert.equal(path.chunkUsed(3), 4)                       // el resto se va al último
  assert.ok(path.chunkUsed(0) + 2 <= RUN, 'un chunk recién ingerido acepta inserciones')
})

test('un trazo vacío conserva un chunk y acepta append', () => {
  const path = nuevo(0)
  assert.equal(path.length, 0)
  assert.equal(path.firstVertex, -1)
  assert.deepEqual(path.toPairs(), [])
  assert.equal(path.chunkCount, 1)
  const ref = path.append(4, 5)
  assert.deepEqual(path.toPairs(), [[4, 5]])
  assert.equal(path.roleAt(ref), ROLE.vertex)
  assert.equal(path.roleAt(path.midOf(ref)), ROLE.free, 'un vértice solo no tiene segmento')
})

// ── refs: chunk, local y la trampa de la paridad ──────────────────────────────

test('el ref decodifica a (chunk, local) — el mismo par que lee el picking', () => {
  const path = nuevo(23)
  const v    = refs(path)[FILL / 2]                         // primer vértice del chunk 1
  assert.equal(path.chunkOf(v), 1)
  assert.equal(path.localOf(v), 0)
  assert.equal(path.refOf(1, 0), v)
  assert.equal(v, 1 * CAP + 0)
})

test('la paridad del REF no distingue vértice de midpoint: manda la del LOCAL', () => {
  const path = nuevo(23)
  const v    = path.refOf(1, 0)
  assert.equal(v % 2, 1, 'cap impar ⇒ el chunk 1 arranca en un ref impar')
  assert.equal(path.roleAt(v), ROLE.vertex)
  assert.equal(path.roleAt(path.midOf(v)), ROLE.midpoint)
  assert.equal(path.moveVertex(v, 7, 7), true, 'es un vértice aunque su ref sea impar')
  assert.equal(path.moveVertex(path.midOf(v), 7, 7), false, 'un midpoint no se mueve como vértice')
})

test('LOCAL_CAP deja lugar al +1 del packer de picking', () => {
  assert.equal(LOCAL_CAP, 4095)
  assert.ok(LOCAL_CAP < 1 << 12, 'local+1 tiene que entrar en LOCAL_BITS bits')
  assert.equal(new ChunkedPath().entriesPerChunk, LOCAL_CAP)
})

// ── prev / next cruzando chunks ───────────────────────────────────────────────

test('prev/next cruzan el borde de chunk por la lista, no por aritmética', () => {
  const path  = nuevo(23)
  const orden = refs(path)
  const borde = orden.findIndex((ref, i) => i > 0 && path.chunkOf(ref) !== path.chunkOf(orden[i - 1]))
  assert.ok(borde > 0, 'el trazo tiene que cruzar al menos un chunk')

  const previo = orden[borde - 1]
  const cruce  = orden[borde]
  assert.notEqual(path.chunkOf(previo), path.chunkOf(cruce))
  assert.equal(path.nextVertex(previo), cruce)
  assert.equal(path.prevVertex(cruce), previo)
  assert.notEqual(cruce - previo, 2, 'el vecino no es contiguo en el arena')
})

test('en trazo abierto los extremos no tienen vecino', () => {
  const path = nuevo(23)
  assert.equal(path.prevVertex(path.firstVertex), -1)
  assert.equal(path.nextVertex(path.lastVertex), -1)
})

test('en anillo cerrado el prev del primero es el último, en el chunk más lejano', () => {
  const path = nuevo(23, { closed: true })
  assert.equal(path.prevVertex(path.firstVertex), path.lastVertex)
  assert.equal(path.nextVertex(path.lastVertex), path.firstVertex)
  assert.notEqual(path.chunkOf(path.firstVertex), path.chunkOf(path.lastVertex))
})

test('el anillo sólo cierra con dos vértices o más', () => {
  const path = new ChunkedPath({ points: [[1, 1]], closed: true, localBits: BITS })
  assert.equal(path.nextVertex(path.firstVertex), -1)
  assert.equal(path.prevVertex(path.firstVertex), -1)
})

// ── entrelazado vértice/midpoint ──────────────────────────────────────────────

test('el midpoint impar es el del segmento que ARRANCA en su vértice, aun cruzando chunks', () => {
  const path  = nuevo(23)
  const orden = refs(path)
  orden.slice(0, -1).forEach((v, i) => {
    const n = orden[i + 1]
    const m = path.midOf(v)
    assert.equal(path.roleAt(m), ROLE.midpoint)
    assert.equal(path.xAt(m), (path.xAt(v) + path.xAt(n)) / 2, `midpoint x de ${i}`)
    assert.equal(path.yAt(m), (path.yAt(v) + path.yAt(n)) / 2, `midpoint y de ${i}`)
    assert.equal(path.chunkOf(m), path.chunkOf(v), 'el midpoint viaja pegado a su vértice')
  })
})

test('en trazo abierto el midpoint del último existe pero queda inactivo', () => {
  const path = nuevo(23)
  assert.equal(path.roleAt(path.midOf(path.lastVertex)), ROLE.free)
  assert.equal(path.chunkUsed(path.lastChunk) % 2, 0, 'la entrada inactiva igual ocupa lugar')
})

test('setClosed prende y apaga el midpoint de cierre, O(1)', () => {
  const path = nuevo(23)
  const rev  = path.structRev
  path.setClosed(true)
  const m = path.midOf(path.lastVertex)
  assert.equal(path.roleAt(m), ROLE.midpoint)
  assert.equal(path.xAt(m), (path.xAt(path.lastVertex) + path.xAt(path.firstVertex)) / 2)
  assert.equal(path.structRev, rev, 'cerrar no es un cambio estructural')
  path.setClosed(false)
  assert.equal(path.roleAt(m), ROLE.free)
})

// ── mover: O(1), dos chunks, refs estables ────────────────────────────────────

test('mover un vértice reescribe su midpoint y el del anterior, cruzando chunks', () => {
  const path  = nuevo(23)
  const orden = refs(path)
  const borde = orden.findIndex((ref, i) => i > 0 && path.chunkOf(ref) !== path.chunkOf(orden[i - 1]))
  const v     = orden[borde]
  const p     = orden[borde - 1]

  assert.equal(path.moveVertex(v, 100, 200), true)
  assert.equal(path.xAt(v), 100)
  assert.equal(path.xAt(path.midOf(p)), (path.xAt(p) + 100) / 2, 'el midpoint que LLEGA es del anterior')
  assert.equal(path.xAt(path.midOf(v)), (100 + path.xAt(orden[borde + 1])) / 2)
  assert.notEqual(path.chunkOf(path.midOf(p)), path.chunkOf(path.midOf(v)), 'la escritura tocó dos chunks')
})

test('mover no desplaza nada: los refs y la estructura sobreviven al gesto', () => {
  const path   = nuevo(23)
  const antes  = refs(path)
  const sello  = path.structRev
  const v      = antes[9]
  Array.from({ length: 2000 }, (_, i) => i).forEach(i => path.moveVertex(v, i, -i))
  assert.deepEqual(refs(path), antes, 'el arrastre no renumera')
  assert.equal(path.structRev, sello, 'mover no sube structRev: el pick en vuelo sigue valiendo')
  assert.ok(path.rev > sello, 'pero sí sube rev')
  assert.deepEqual(path.toPairs()[9], [1999, -1999])
})

test('mover rechaza lo que no es un vértice vivo', () => {
  const path = nuevo(23)
  assert.equal(path.moveVertex(path.midOf(path.firstVertex), 0, 0), false)
  assert.equal(path.moveVertex(-1, 0, 0), false)
  assert.equal(path.moveVertex(CAP - 2, 0, 0), false, 'entrada muerta del arena')
  assert.equal(path.moveVertex(1e9, 0, 0), false)
})

// ── insertar y borrar ─────────────────────────────────────────────────────────

test('insertar en el medio conserva el orden y recalcula los dos midpoints vecinos', () => {
  const path   = nuevo(23)
  const modelo = pares(23)
  const v      = refs(path)[9]
  const nuevoR = path.insertAfter(v, 900, 901)
  modelo.splice(10, 0, [900, 901])
  verificar(path, modelo, 'tras insertar')
  assert.equal(path.xAt(path.midOf(nuevoR)), (900 + modelo[11][0]) / 2)
  assert.equal(path.xAt(path.midOf(nuevoR - 2)), (modelo[9][0] + 900) / 2)
})

test('insertar desplaza el lado MÁS CORTO del run', () => {
  const path   = nuevo(23)
  const modelo = pares(23)

  // Un chunk gordo con aire de los dos lados: el merge lo engorda y borrar su primer vértice
  // (0 entradas movidas) le corre el `first` a 2.
  path.remove(refs(path)[7])
  modelo.splice(7, 1)
  path.remove(refs(path)[0])
  modelo.splice(0, 1)
  const k = path.firstChunk
  assert.equal(path.chunkFirst(k), 2, 'hay aire a la izquierda')
  assert.ok(path.chunkFirst(k) + path.chunkUsed(k) + 2 <= RUN, 'y también a la derecha')

  const frente = refs(path)[0]
  assert.equal(path.chunkOf(path.insertAfter(frente, -1, -1)), k)
  modelo.splice(1, 0, [-1, -1])
  assert.equal(path.chunkFirst(k), 0, 'cerca del frente mueve 2 entradas hacia la izquierda')
  verificar(path, modelo, 'tras insertar por izquierda')

  const cola = refs(path)[path.chunkUsed(k) / 2 - 2]
  assert.equal(path.chunkOf(cola), k)
  const primero = path.chunkFirst(k)
  path.insertAfter(cola, -2, -2)
  modelo.splice(path.chunkUsed(k) / 2 - 2, 0, [-2, -2])
  assert.equal(path.chunkFirst(k), primero, 'cerca de la cola mueve el bloque de la derecha')
  verificar(path, modelo, 'tras insertar por derecha')
})

test('insertar hasta desbordar parte el chunk a la mitad y toma uno de la free-list', () => {
  const path   = nuevo(7)                                  // un solo chunk vivo, 7 parejas
  const modelo = pares(7)
  assert.equal(path.chunkUsed(0), FILL)
  assert.equal(path.chunkCount, 1)

  // Hasta llenar el run: 15 parejas en 30 entradas.
  Array.from({ length: 8 }, (_, i) => i).forEach(i => {
    path.insertAfter(path.lastVertex, 500 + i, 0)
    modelo.push([500 + i, 0])
  })
  assert.deepEqual(cadena(path), [0])
  assert.equal(path.chunkUsed(0), RUN, 'el run llegó al tope')
  verificar(path, modelo, 'chunk lleno')

  path.insertAfter(path.lastVertex, 999, 0)
  modelo.push([999, 0])
  const vivos = cadena(path)
  assert.equal(vivos.length, 2, 'desbordar partió el chunk')
  assert.equal(path.chunkUsed(vivos[0]) + path.chunkUsed(vivos[1]), (RUN + 2))
  assert.ok(path.chunkUsed(vivos[0]) >= FILL, 'la mitad baja queda por encima del mínimo')
  assert.ok(path.chunkUsed(vivos[1]) >= FILL, 'la mitad alta también')
  verificar(path, modelo, 'tras el split')
})

test('borrar por debajo del mínimo le pide una pareja al vecino más gordo', () => {
  const path   = nuevo(23)
  const modelo = pares(23)

  path.remove(refs(path)[7])                               // merge: chunk 0 queda gordo
  modelo.splice(7, 1)
  const vivos = cadena(path)
  assert.equal(vivos.length, 3)
  const gordo = vivos[0], flaco = vivos[1]
  assert.ok(path.chunkUsed(gordo) > FILL)
  assert.equal(path.chunkUsed(flaco), FILL)

  const libres = path.freeChunks
  const cabeza = refs(path).findIndex(ref => path.chunkOf(ref) === flaco)
  path.remove(refs(path)[cabeza])
  modelo.splice(cabeza, 1)
  assert.equal(path.freeChunks, libres, 'un borrow no libera ningún chunk')
  assert.equal(path.chunkUsed(flaco), FILL, 'el flaco vuelve al mínimo')
  assert.equal(path.chunkUsed(gordo), 26 - 2, 'la pareja salió del vecino gordo')
  verificar(path, modelo, 'tras el borrow')
})

test('cuando ningún vecino puede prestar, los dos chunks se fusionan y uno vuelve a la free-list', () => {
  const path   = nuevo(23)
  const modelo = pares(23)
  const antes  = cadena(path)
  assert.equal(path.freeChunks, 0)

  path.remove(refs(path)[7])                               // chunk 1 cae a 12 entradas, nadie presta
  modelo.splice(7, 1)
  const vivos = cadena(path)
  assert.equal(vivos.length, antes.length - 1, 'un chunk salió de la lista')
  assert.equal(path.freeChunks, 1, 'y está en la free-list')
  assert.equal(path.chunkCount, antes.length, 'el arena no creció')
  assert.equal(path.chunkUsed(vivos[0]), FILL + 12, 'el vecino absorbió el run entero')
  verificar(path, modelo, 'tras el merge')
})

test('la free-list se reusa: el chunk liberado vuelve en el próximo split', () => {
  const path   = nuevo(23)
  const modelo = pares(23)
  path.remove(refs(path)[7])
  modelo.splice(7, 1)
  const liberado = [0, 1, 2, 3].find(k => !cadena(path).includes(k))
  assert.equal(path.freeChunks, 1)

  const cola = path.lastChunk
  while (path.chunkUsed(cola) < RUN) {
    path.insertAfter(path.lastVertex, path.length, 0)
    modelo.push([path.length - 1, 0])
  }
  const arena = path.chunkCount
  path.insertAfter(path.lastVertex, 777, 0)
  modelo.push([777, 0])

  assert.ok(cadena(path).includes(liberado), 'el split tomó el chunk liberado')
  assert.equal(path.freeChunks, 0)
  assert.equal(path.chunkCount, arena, 'sin crecer el arena')
  verificar(path, modelo, 'tras reusar')
})

test('el orden del trazo no es el del arena', () => {
  const path   = nuevo(23)
  const modelo = pares(23)
  path.remove(refs(path)[7])                               // libera el chunk 1
  modelo.splice(7, 1)

  while (path.chunkUsed(path.lastChunk) < RUN) {           // desborda la COLA: reusa el 1 al final
    path.insertAfter(path.lastVertex, path.length, 0)
    modelo.push([path.length - 1, 0])
  }
  path.insertAfter(path.lastVertex, 888, 0)
  modelo.push([888, 0])

  const vivos = cadena(path)
  assert.deepEqual(vivos, [0, 2, 3, 1], 'la lista lleva el orden, no el índice del arena')
  assert.notDeepEqual(vivos, [...vivos].sort((a, b) => a - b))
  verificar(path, modelo, 'con el arena desordenado')
})

test('borrar el último vértice de un trazo abierto apaga el midpoint del que queda último', () => {
  const path   = nuevo(23)
  const modelo = pares(23)
  path.remove(path.lastVertex)
  modelo.pop()
  verificar(path, modelo, 'tras borrar la cola')
  assert.equal(path.roleAt(path.midOf(path.lastVertex)), ROLE.free)
})

test('borrar hasta vaciar deja la lista con un chunk y el trazo vuelve a aceptar append', () => {
  const path = nuevo(23)
  while (path.length) path.remove(path.firstVertex)
  assert.equal(path.length, 0)
  assert.equal(path.firstVertex, -1)
  assert.deepEqual(path.toPairs(), [])
  assert.equal(cadena(path).length, 1, 'la lista nunca se queda sin chunks')
  path.append(1, 2)
  path.append(3, 4)
  assert.deepEqual(path.toPairs(), [[1, 2], [3, 4]])
  assert.equal(path.xAt(path.midOf(path.firstVertex)), 2)
})

test('borrar en un anillo cerrado re-enlaza el midpoint que cruza el cierre', () => {
  const path   = nuevo(23, { closed: true })
  const modelo = pares(23)
  path.remove(path.firstVertex)
  modelo.shift()
  verificar(path, modelo, 'anillo tras borrar el primero')
  const m = path.midOf(path.lastVertex)
  assert.equal(path.xAt(m), (path.xAt(path.lastVertex) + path.xAt(path.firstVertex)) / 2)
  assert.equal(path.prevVertex(path.firstVertex), path.lastVertex)
})

test('insertar y borrar rechazan lo que no es un vértice vivo', () => {
  const path = nuevo(23)
  assert.equal(path.insertAfter(path.midOf(path.firstVertex), 0, 0), -1)
  assert.equal(path.insertAfter(-1, 0, 0), -1)
  assert.equal(path.remove(path.midOf(path.firstVertex)), false)
  assert.equal(path.remove(1e9), false)
  assert.deepEqual(path.toPairs(), pares(23))
})

// ── revisión de contenido por chunk ──────────────────────────────────────────

test('chunkRev delata el traslado que la firma (first, used) no ve', () => {
  const path   = nuevo(23)
  const modelo = pares(23)
  path.remove(refs(path)[7])                               // merge: el vecino de la izquierda queda gordo
  modelo.splice(7, 1)

  const flaco  = cadena(path)[1]
  const cabeza = refs(path).findIndex(ref => path.chunkOf(ref) === flaco)
  const firma  = [path.chunkFirst(flaco), path.chunkUsed(flaco)]
  const rev    = path.chunkRev(flaco)
  const cedido = path.prevVertex(refs(path)[cabeza])
  assert.notEqual(path.chunkOf(cedido), flaco, 'el vértice que va a migrar todavía vive en el anterior')

  path.remove(refs(path)[cabeza])                          // borra el ARRANQUE del run: el borrow sale del anterior
  modelo.splice(cabeza, 1)

  assert.deepEqual([path.chunkFirst(flaco), path.chunkUsed(flaco)], firma,
    'el borrado corre el `first` dos entradas y el borrow lo devuelve')
  assert.equal(path.xAt(path.refOf(flaco, path.chunkFirst(flaco))), path.xAt(cedido),
    'con el run entero corrido y un vértice ajeno al frente')
  assert.notEqual(path.chunkRev(flaco), rev, 'y la revisión es lo único que lo cuenta')
  verificar(path, modelo, 'tras el borrow')
})

test('mover un vértice no toca la revisión de ningún chunk: cambia el valor, no el lugar', () => {
  const path  = nuevo(23)
  const antes = cadena(path).map(k => path.chunkRev(k))
  path.moveVertex(refs(path)[9], 100, 200)
  assert.deepEqual(cadena(path).map(k => path.chunkRev(k)), antes)
})

test('el chunk que vuelve de la free-list no puede reestrenar la revisión con la que se fue', () => {
  const path = nuevo(23)
  path.remove(refs(path)[7])                               // merge: libera un chunk
  const liberado = [0, 1, 2, 3].find(k => !cadena(path).includes(k))
  const rev      = path.chunkRev(liberado)

  while (path.chunkUsed(path.lastChunk) < RUN) path.insertAfter(path.lastVertex, path.length, 0)
  path.insertAfter(path.lastVertex, 777, 0)                // desborda: el split lo toma de la free-list

  assert.ok(cadena(path).includes(liberado), 'volvió a la lista')
  assert.ok(path.chunkRev(liberado) > rev, 'con la revisión adelantada: sólo sube')
})

// ── cursor ───────────────────────────────────────────────────────────────────

test('el cursor recorre en orden de trazo sin materializar el array, y se reusa', () => {
  const path = nuevo(23, { closed: true })
  const cur  = path.cursor()
  const uno  = []
  while (cur.next()) uno.push([cur.index, cur.ref, cur.x, cur.y])
  assert.equal(uno.length, 23, 'el anillo no da la vuelta de más')
  assert.deepEqual(uno.map(([, , x, y]) => [x, y]), pares(23))
  assert.deepEqual(uno.map(([i]) => i), Array.from({ length: 23 }, (_, i) => i))
  assert.deepEqual(uno.map(([, ref]) => ref), refs(path))

  cur.reset()
  const dos = []
  while (cur.next()) dos.push([cur.x, cur.y])
  assert.deepEqual(dos, pares(23))
  assert.equal(cur.next(), false, 'agotado se queda agotado')
})

test('el cursor de un trazo vacío no entrega nada', () => {
  assert.equal(nuevo(0).cursor().next(), false)
})

// ── fuzz con semilla fija contra un array plano ──────────────────────────────

test('mil ediciones al azar dejan la estructura coherente contra un array plano', () => {
  let semilla = 0x9e3779b9
  const azar = () => {
    semilla = (semilla ^ (semilla << 13)) >>> 0
    semilla = (semilla ^ (semilla >>> 17)) >>> 0
    semilla = (semilla ^ (semilla << 5)) >>> 0
    return semilla / 0x100000000
  }
  const indice = n => Math.min(n - 1, Math.floor(azar() * n))
  const refAt  = (path, i) => {
    const cur = path.cursor()
    while (cur.next()) if (cur.index === i) return cur.ref
    return -1
  }

  const path   = nuevo(11, { closed: true })
  const modelo = pares(11)
  let splits   = 0
  let merges   = 0

  Array.from({ length: 1000 }, (_, paso) => paso).forEach(paso => {
    const vivos = cadena(path).length
    const dado  = azar()
    if (dado < 0.45 || modelo.length < 2) {
      const i = indice(modelo.length)
      const p = [paso, -paso]
      path.insertAfter(refAt(path, i), p[0], p[1])
      modelo.splice(i + 1, 0, p)
    } else if (dado < 0.8) {
      const i = indice(modelo.length)
      path.remove(refAt(path, i))
      modelo.splice(i, 1)
    } else {
      const i = indice(modelo.length)
      const p = [paso * 2, paso * 3]
      path.moveVertex(refAt(path, i), p[0], p[1])
      modelo[i] = p
    }
    splits += Math.max(0, cadena(path).length - vivos)
    merges += Math.max(0, vivos - cadena(path).length)
    verificar(path, modelo, `paso ${paso}`)
  })

  assert.ok(splits > 5, `la corrida tiene que haber partido chunks (${splits})`)
  assert.ok(merges > 5, `y haber fusionado (${merges})`)
  assert.deepEqual(new ChunkedPath({ points: path.toPairs(), localBits: BITS }).toPairs(), modelo)
})

test('el arena crece por duplicación y conserva el trazo', () => {
  const path   = nuevo(0)
  const modelo = Array.from({ length: 400 }, (_, i) => [i, -i])
  modelo.forEach(([x, y]) => path.append(x, y))
  assert.ok(path.chunkCount >= 32, 'hubo varios grow')
  assert.equal(path.chunkCount & (path.chunkCount - 1), 0, 'el arena duplica')
  verificar(path, modelo, 'tras 400 appends')
})

test('con el tamaño de chunk de producción el trazo largo entra en pocos chunks', () => {
  const path = new ChunkedPath({ points: pares(5000) })
  assert.equal(path.entriesPerChunk, LOCAL_CAP)
  assert.equal(cadena(path).length, 5, '1023 vértices por chunk al ingerir')
  assert.equal(path.toPairs().length, 5000)
  const v = path.refOf(cadena(path)[3], 0)
  assert.equal(path.prevVertex(path.nextVertex(v)), v)
})
