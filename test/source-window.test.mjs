// Ventana de flush de createSource (src/data/Source.js + Emitter.js): N operaciones en un
// mismo tick colapsan en UN emit que lleva la UNIÓN de los ids tocados, y los acumuladores
// (structDirty / moveDirty) se limpian recién en la operación POSTERIOR al emit — no en el emit.
// Esto es lo que hace correcto el coalescing: el consumidor lee los ids DESPUÉS del callback.
// Corre con: node --test test/source-window.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSource, makeFilter } from '../src/data/index.js'

const idOf = it => it.id
const positionOf = it => ({ lat: it.lat, lng: it.lng })
const nuevo = (variants) => createSource({ idOf, positionOf }, variants)
const punto = (id, lat = 0, lng = 0) => ({ id, lat, lng })
const ids = (set) => [...set].sort((a, b) => a - b)

// En node no hay requestAnimationFrame: el Emitter cae a setTimeout(0), así que un turno de
// macrotarea alcanza para observar el flush. El guard de abajo avisa si eso cambia.
const flush = () => new Promise(r => setTimeout(r, 0))
const timers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length

test('el defer del emitter cae a setTimeout en node (premisa de todo el archivo)', () => {
  assert.equal(typeof globalThis.requestAnimationFrame, 'undefined')
})

/* ── Coalescing: una ventana, un emit, la unión de los ids ── */

test('N operaciones en un mismo tick colapsan en UN emit con la unión de ids', async () => {
  const src = nuevo()
  let emits = 0
  src.subscribe(() => emits++)

  src.set([punto(1), punto(2), punto(3)])
  src.move(1, 5, 5)
  src.move(2, 6, 6)
  src.remove(3)
  assert.equal(emits, 0, 'ninguna op emite de forma síncrona')

  await flush()
  assert.equal(emits, 1)
  assert.deepEqual(ids(src.dirtyIds()), [1, 2, 3])     // set marcó 1..3 + remove marcó 3
  assert.deepEqual(ids(src.moveDirtyIds()), [1, 2])
})

test('todos los suscriptores reciben el mismo snapshot, una sola vez', async () => {
  const src = nuevo()
  const recibido = []
  src.subscribe(d => recibido.push(['a', d]))
  src.subscribe(d => recibido.push(['b', d]))

  src.set([punto(1), punto(2)])
  src.move(1, 9, 9)
  await flush()

  assert.deepEqual(recibido.map(([quien]) => quien), ['a', 'b'])
  const [[, dataA], [, dataB]] = recibido
  assert.equal(dataA, dataB, 'la MISMA referencia a los dos: el emit no copia por suscriptor')
  // Contenido literal (no derivado del módulo): el move NO toca el ítem, vive en el accessor.
  assert.deepEqual(dataA, [punto(1), punto(2)])
  assert.deepEqual(src.accessors.positionOf(dataA[0]), { lat: 9, lng: 9 })
})

test('getSnapshot lee el estado VIVO del store, no el eco del último emit', async () => {
  const src = nuevo()
  assert.deepEqual(src.getSnapshot(), [], 'antes de cualquier op: conjunto vacío, nunca null')

  src.set([punto(1), punto(2)])
  assert.deepEqual(src.getSnapshot().map(idOf), [1, 2], 'visible en el acto, sin esperar al emit')
  src.addFilter(makeFilter('sólo-1', it => it.id === 1))
  assert.deepEqual(src.getSnapshot().map(idOf), [1], 'el filtro también se ve antes del emit')
  await flush()

  src.destroy()
  assert.deepEqual(src.getSnapshot(), [], 'tras destroy: conjunto vacío, nunca null')
})

// El snapshot es una REFERENCIA reusada, no una copia por lectura: el consumidor compara `prev !== next`
// para saltear trabajo, y una copia por lectura lo rompe sin cambiar ningún valor observable.
test('getSnapshot devuelve la MISMA referencia mientras no haya una operación', async () => {
  const src = nuevo()
  src.set([punto(1), punto(2)])

  const primera = src.getSnapshot()
  assert.equal(src.getSnapshot(), primera, 'dos lecturas seguidas: misma referencia, sin copia')

  let emitido = null
  src.subscribe(d => { emitido = d })
  await flush()
  assert.equal(emitido, primera, 'lo emitido es esa misma referencia, no una copia por emit')
  assert.equal(src.getSnapshot(), primera, 'leer después del emit no la reemplaza')

  // Y la contracara: una operación que regenera la vista SÍ produce un arreglo nuevo.
  src.set([punto(3)])
  assert.notEqual(src.getSnapshot(), primera, 'un `set` regenera: referencia nueva')
  src.destroy()
})

test('la baja corta la entrega sin afectar al resto', async () => {
  const src = nuevo()
  let vivos = 0, dado = 0
  const baja = src.subscribe(() => dado++)
  src.subscribe(() => vivos++)
  baja()

  src.set([punto(1)])
  await flush()
  assert.equal(dado, 0)
  assert.equal(vivos, 1)
})

/* ── Límites de la ventana ── */

test('los acumuladores siguen legibles tras el emit y se limpian en la op POSTERIOR', async () => {
  const src = nuevo()
  const enElCallback = []
  src.subscribe(() => enElCallback.push([ids(src.dirtyIds()), ids(src.moveDirtyIds())]))

  src.set([punto(1), punto(2)])
  src.move(2, 1, 1)
  await flush()

  // Durante el emit ya están completos, y siguen ahí después (el consumidor los lee al recibir).
  assert.deepEqual(enElCallback, [[[1, 2], [2]]])
  assert.deepEqual(ids(src.dirtyIds()), [1, 2])
  assert.deepEqual(ids(src.moveDirtyIds()), [2])

  // Pasar de tick NO los limpia: los limpia la próxima operación.
  await flush()
  assert.deepEqual(ids(src.dirtyIds()), [1, 2])

  src.move(1, 3, 3)
  assert.deepEqual(ids(src.dirtyIds()), [], 'la op posterior abre ventana limpia')
  assert.deepEqual(ids(src.moveDirtyIds()), [1])
})

test('dirtyIds/moveDirtyIds devuelven el MISMO Set reusado, no una copia por lectura', async () => {
  const src = nuevo()
  const struct = src.dirtyIds()
  const movidos = src.moveDirtyIds()
  assert.equal(src.dirtyIds(), struct, 'dirtyIds no aloca por llamada')
  assert.equal(src.moveDirtyIds(), movidos, 'moveDirtyIds no aloca por llamada')
  assert.notEqual(struct, movidos, 'son dos acumuladores distintos')

  src.set([punto(1), punto(2)])
  await flush()
  assert.deepEqual(ids(struct), [1, 2], 'la referencia tomada antes ve la ventana en curso')

  src.move(2, 1, 1)                                   // op posterior al emit: ventana nueva
  assert.equal(src.dirtyIds(), struct, 'abrir ventana LIMPIA el Set, no lo reasigna')
  assert.deepEqual(ids(struct), [])
  assert.deepEqual(ids(movidos), [2])
  src.destroy()
})

test('cada tick abre una ventana nueva: los ids no se arrastran entre emits', async () => {
  const src = nuevo()
  const porEmit = []
  src.subscribe(() => porEmit.push([ids(src.dirtyIds()), ids(src.moveDirtyIds())]))

  src.set([punto(1), punto(2)])
  await flush()
  src.move(2, 4, 4)
  await flush()

  assert.deepEqual(porEmit, [[[1, 2], []], [[], [2]]])
})

test('una op disparada desde el callback cae en la ventana que se está cerrando', async () => {
  // `windowClosed` se marca DESPUÉS de correr los suscriptores: lo que el callback mutó viaja
  // con los ids del emit anterior, no en una ventana propia.
  const src = nuevo()
  const porEmit = []
  let reentrado = false
  src.subscribe(() => {
    porEmit.push([ids(src.dirtyIds()), ids(src.moveDirtyIds())])
    if (!reentrado) { reentrado = true; src.move(2, 9, 9) }
  })

  src.set([punto(1), punto(2)])
  await flush()
  await flush()

  assert.deepEqual(porEmit, [[[1, 2], []], [[1, 2], [2]]])
})

test('los filtros participan de la misma ventana que el resto de las ops', async () => {
  const src = nuevo()
  let emits = 0
  src.subscribe(() => emits++)

  src.set([{ ...punto(1), ok: true }, { ...punto(2), ok: false }])
  src.addFilter(makeFilter('sólo-ok', it => it.ok))
  await flush()

  assert.equal(emits, 1)
  assert.deepEqual(src.getSnapshot().map(idOf), [1])
})

test('addFilter y removeFilter ABREN ventana: no arrastran los ids del emit anterior', async () => {
  const src = nuevo()
  src.set([{ ...punto(1), ok: true }, { ...punto(2), ok: false }])
  await flush()
  assert.deepEqual(ids(src.dirtyIds()), [1, 2], 'ventana del set, ya emitida')

  src.addFilter(makeFilter('sólo-ok', it => it.ok))         // 1ra op después del emit
  assert.deepEqual(ids(src.dirtyIds()), [], 'addFilter limpió la ventana anterior')
  await flush()

  src.move(1, 5, 5)
  await flush()
  assert.deepEqual(ids(src.moveDirtyIds()), [1], 'ventana del move, ya emitida')

  src.removeFilter('sólo-ok')                               // 1ra op después del emit
  assert.deepEqual(ids(src.moveDirtyIds()), [], 'removeFilter limpió la ventana anterior')
  assert.deepEqual(ids(src.dirtyIds()), [])
})

test('removeFilter es una operación del ciclo: emite y avanza la version', async () => {
  const src = nuevo()
  src.set([{ ...punto(1), ok: true }, { ...punto(2), ok: false }])
  src.addFilter(makeFilter('sólo-ok', it => it.ok))
  await flush()

  let emits = 0
  const vistos = []
  src.subscribe(d => { emits++; vistos.push(d.map(idOf)) })
  const antes = src.version()

  src.removeFilter('sólo-ok')
  assert.equal(src.version(), antes + 1)
  await flush()
  assert.equal(emits, 1, 'las vistas se enteran de que se soltó el filtro')
  assert.deepEqual(vistos, [[1, 2]])

  // Soltar un filtro inexistente NO hace short-circuit: sigue siendo una op del ciclo.
  src.removeFilter('no-existe')
  assert.equal(src.version(), antes + 2)
  await flush()
  assert.equal(emits, 2)
})

/* ── Autoridad entre operaciones sobre el mismo id ── */

test('patch es autoritativo sobre un move previo del mismo id', async () => {
  const src = nuevo()
  src.set([punto(1, 0, 0)])
  await flush()

  src.move(1, 9, 9)
  assert.deepEqual(src.accessors.positionOf(src.itemById(1)), { lat: 9, lng: 9 })

  src.patch([punto(1, 2, 2)], new Set([1]))
  assert.deepEqual(src.accessors.positionOf(src.itemById(1)), { lat: 2, lng: 2 }, 'el override murió')
  assert.deepEqual(ids(src.dirtyIds()), [1])
  assert.deepEqual(ids(src.moveDirtyIds()), [1], 'el id sigue marcado como movido en la ventana')
})

test('patch actualiza la base completa: un remove posterior NO revierte lo parcheado', async () => {
  const src = nuevo()
  src.set([punto(1, 0, 0), punto(2, 0, 0)])
  await flush()

  src.patch([punto(1, 7, 7), punto(2, 0, 0)], new Set([1]))
  await flush()
  assert.deepEqual(src.getSnapshot(), [punto(1, 7, 7), punto(2, 0, 0)], 'el patch se ve en el snapshot')

  // El remove rebuildea desde la base: si el patch no la escribió, acá revierte al valor viejo.
  src.remove(2)
  await flush()
  assert.deepEqual(src.getSnapshot(), [punto(1, 7, 7)])
})

test('patch procesa TODO el lote de ids sucios, no sólo el primero', async () => {
  const src = nuevo()
  src.set([punto(1), punto(2), punto(3)])
  await flush()

  src.move(2, 9, 9)
  src.move(3, 9, 9)
  const filas = [punto(1, 1, 1), punto(2, 2, 2), punto(3, 3, 3)]
  src.patch(filas, new Set([1, 2, 3]))

  assert.deepEqual(ids(src.dirtyIds()), [1, 2, 3], 'los 3 quedan marcados como estructurales')
  for (const it of filas)
    assert.deepEqual(src.accessors.positionOf(src.itemById(it.id)), { lat: it.lat, lng: it.lng },
      `el patch mató el override del id ${it.id}`)
})

test('patch es incremental: un id ausente del snapshot vigente NO se incorpora', async () => {
  const src = nuevo()
  src.set([punto(1), punto(2)])
  await flush()

  src.patch([punto(1), punto(2), punto(3)], new Set([3]))
  await flush()
  assert.deepEqual(src.getSnapshot().map(idOf), [1, 2], 'sólo `set` da de alta ids nuevos')
  assert.equal(src.itemById(3), undefined)
})

test('itemById resuelve por el índice de la vista FILTRADA, no escaneando el conjunto', async () => {
  const src = nuevo()
  src.set([{ ...punto(1), ok: true }, { ...punto(2), ok: false }])
  src.addFilter(makeFilter('sólo-ok', it => it.ok))
  await flush()

  assert.equal(idOf(src.itemById(1)), 1, 'el visible se resuelve')
  assert.equal(src.itemById(2), undefined, 'lo que el filtro esconde no es visible por id')
  assert.equal(src.itemById(404), undefined, 'id inexistente')

  src.removeFilter('sólo-ok')
  await flush()
  assert.equal(idOf(src.itemById(2)), 2, 'al soltar el filtro vuelve a resolverse')
})

test('set descarta todos los overrides vivos', async () => {
  const src = nuevo()
  src.set([punto(1), punto(2)])
  src.move(1, 9, 9)
  src.move(2, 8, 8)
  await flush()

  src.set([punto(1, 1, 1), punto(2, 2, 2)])
  assert.deepEqual(src.accessors.positionOf(src.itemById(1)), { lat: 1, lng: 1 })
  assert.deepEqual(src.accessors.positionOf(src.itemById(2)), { lat: 2, lng: 2 })
})

test('remove desmarca el move pendiente del mismo id', async () => {
  const src = nuevo()
  src.set([punto(1), punto(2)])
  await flush()

  src.move(1, 5, 5)
  src.remove(1)
  assert.deepEqual(ids(src.moveDirtyIds()), [], 'no se escribe el slot de un id que ya no está')
  assert.deepEqual(ids(src.dirtyIds()), [1])
  assert.deepEqual(src.getSnapshot().map(idOf), [2])
})

/* ── remove opera sobre el conjunto completo, no sobre la vista filtrada ── */

test('remove bajo un filtro activo no resucita a los ítems que el filtro escondía', async () => {
  const src = nuevo()
  src.set([{ ...punto(1), ok: true }, { ...punto(2), ok: false }, { ...punto(3), ok: true }])
  src.addFilter(makeFilter('sólo-ok', it => it.ok))
  await flush()
  assert.deepEqual(src.getSnapshot().map(idOf), [1, 3])

  src.remove(1)
  await flush()
  assert.deepEqual(src.getSnapshot().map(idOf), [3])

  // Al soltar el filtro vuelve el 2 (nunca se fue del conjunto) y el 1 sigue eliminado.
  src.removeFilter('sólo-ok')
  await flush()
  assert.deepEqual(src.getSnapshot().map(idOf), [2, 3])
})

test('remove de un id ausente no altera el conjunto pero marca el id', async () => {
  const src = nuevo()
  src.set([punto(1)])
  await flush()

  src.remove(99)
  assert.deepEqual(src.getSnapshot().map(idOf), [1])
  assert.deepEqual(ids(src.dirtyIds()), [99])
})

/* ── move: O(1), tolerante y sin alocar por update ── */

test('move sobre un id inexistente no rompe: registra el override igual', async () => {
  const src = nuevo()
  src.set([punto(1)])
  await flush()

  assert.doesNotThrow(() => src.move(404, 10, 10))
  assert.deepEqual(ids(src.moveDirtyIds()), [404])
  assert.deepEqual(src.getSnapshot().map(idOf), [1])
  assert.equal(src.itemById(404), undefined)
})

test('move repetido sobre el mismo id muta el override in-place', async () => {
  const src = nuevo()
  src.set([punto(1)])
  await flush()

  src.move(1, 5, 5)
  const pos = src.accessors.positionOf(src.itemById(1))
  src.move(1, 6, 7)
  assert.equal(src.accessors.positionOf(src.itemById(1)), pos, 'misma referencia: cero alloc por update')
  assert.deepEqual(pos, { lat: 6, lng: 7 })
  assert.deepEqual(ids(src.moveDirtyIds()), [1])
})

test('la version avanza exactamente una vez por operación', async () => {
  const src = nuevo()
  assert.equal(src.version(), 0)
  src.set([punto(1)])
  src.move(1, 1, 1)
  src.patch([punto(1, 2, 2)], new Set([1]))
  src.remove(1)
  assert.equal(src.version(), 4)
  await flush()
  assert.equal(src.version(), 4, 'el emit no toca la version')
})

/* ── Lifecycle ── */

test('N ops en una misma ventana agendan UN SOLO flush, no un timer por operación', async () => {
  const antes = timers()
  const src = nuevo()
  src.subscribe(() => {})

  src.set([punto(1), punto(2)])
  src.move(1, 1, 1)
  src.move(2, 2, 2)
  src.patch([punto(1, 3, 3), punto(2, 2, 2)], new Set([1]))
  src.remove(2)
  assert.equal(timers(), antes + 1, '5 ops, un solo flush agendado')

  await flush()
  src.destroy()
})

test('destroy no deja el flush pendiente agendado ni entrega su callback', async () => {
  const antes = timers()
  const src = nuevo()
  let emits = 0
  src.subscribe(() => emits++)

  src.set([punto(1)])
  assert.equal(timers(), antes + 1, 'la op dejó un flush agendado que hay que cancelar')

  src.destroy()
  assert.equal(timers(), antes, 'destroy lo canceló')

  await flush()
  assert.equal(emits, 0)
  assert.doesNotThrow(() => src.destroy(), 'destroy es idempotente')
})

test('destroy vacía acumuladores y overrides: una Source muerta no retiene la flota', async () => {
  const src = nuevo()
  src.set([punto(1), punto(2)])
  src.move(1, 5, 5)
  const struct = src.dirtyIds()
  const movidos = src.moveDirtyIds()
  assert.equal(struct.size, 2)
  assert.equal(movidos.size, 1)
  assert.deepEqual(src.accessors.positionOf(punto(1)), { lat: 5, lng: 5 }, 'override vivo')

  src.destroy()
  assert.equal(struct.size, 0, 'structDirty vaciado')
  assert.equal(movidos.size, 0, 'moveDirty vaciado')
  assert.equal(src.dirtyIds().size, 0)
  assert.equal(src.moveDirtyIds().size, 0)
  assert.deepEqual(src.accessors.positionOf(punto(1)), { lat: 0, lng: 0 }, 'overrides vaciado')
})

/* ── Barrido determinista contra un oráculo de la ventana ── */

test('invariante en barrido: un tick = un emit con la unión exacta de ids tocados', async () => {
  // LCG (determinista, sin Math.random): secuencias reproducibles de ops en una misma ventana.
  const lcg = (semilla) => () => (semilla = (semilla * 1103515245 + 12345) % 2147483648) / 2147483648
  const UNIVERSO = [1, 2, 3, 4, 5, 6]

  for (let semilla = 1; semilla <= 40; semilla++) {
    const azar = lcg(semilla)
    const src = nuevo()
    let emits = 0
    src.subscribe(() => emits++)

    let filas = UNIVERSO.map(id => punto(id))
    src.set(filas)
    await flush()                                  // arranca con la ventana cerrada
    emits = 0

    // Oráculo: mismas reglas que Source.js, calculadas aparte.
    const struct = new Set(), movidos = new Set()
    for (let op = 0; op < 12; op++) {
      const id = UNIVERSO[Math.floor(azar() * UNIVERSO.length)]
      const cual = Math.floor(azar() * 3)
      if (cual === 0) {
        src.move(id, id * 10, id * 10)
        movidos.add(id)
      } else if (cual === 1) {
        filas = filas.filter(it => it.id !== id)
        src.remove(id)
        movidos.delete(id)
        struct.add(id)
      } else {
        const i = filas.findIndex(it => it.id === id)
        if (i < 0) continue                        // patch exige el id en el snapshot vigente
        filas = filas.map((it, j) => (j === i ? punto(id, op, op) : it))
        src.patch(filas, new Set([id]))
        struct.add(id)
      }
    }

    await flush()
    const ctx = `semilla ${semilla}`
    assert.equal(emits, 1, `${ctx}: un solo emit por ventana`)
    assert.deepEqual(ids(src.dirtyIds()), ids(struct), `${ctx}: ids estructurales`)
    assert.deepEqual(ids(src.moveDirtyIds()), ids(movidos), `${ctx}: ids movidos`)
    assert.deepEqual(src.getSnapshot().map(idOf), filas.map(idOf), `${ctx}: conjunto resultante`)
    src.destroy()
  }
})
