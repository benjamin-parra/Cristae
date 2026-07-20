import { Store } from './Store.js'
import { Emitter } from './Emitter.js'

const NOOP = () => {}

// Normaliza el teardown que devuelve una librería de reactividad a una función de baja.
// Tolera: función (Preact effect, Zustand), objeto con `unsubscribe()` (RxJS), objeto con
// `dispose()` (Solid root) o nada (la baja queda en no-op).
const toUnsub = (teardown) =>
  typeof teardown === 'function' ? teardown
  : teardown && typeof teardown.unsubscribe === 'function' ? () => teardown.unsubscribe()
  : teardown && typeof teardown.dispose === 'function' ? () => teardown.dispose()
  : NOOP

// Guard de configuración: valida el contrato del Source una sola vez al definirlo (no es hot path).
const requireSourceConfig = ({ accessors, getSnapshot, subscribe }) => {
  // Geometría: `positionOf` (point/label) o `pathOf` (line). Una de las dos.
  const ok = typeof getSnapshot === 'function'
    && typeof subscribe === 'function'
    && typeof accessors?.idOf === 'function'
    && (typeof accessors?.positionOf === 'function' || typeof accessors?.pathOf === 'function')
  if (!ok) throw new TypeError('[defineSource] requiere getSnapshot, subscribe, accessors.idOf y positionOf|pathOf')
}

// Ruta B genérica: adapta CUALQUIER librería de reactividad a un Source, sin Store/Emitter
// propios del motor. El emitter deja de ser house-first — `subscribe` ES el punto de
// intercepción de señales: lo que la librería invoque al cambiar un dato se traduce en un
// re-read del motor.
//
// `subscribe(notify)` recibe una función sin args; debe invocarla tras cada cambio observable
// y devolver su teardown (función | objeto con `unsubscribe`/`dispose` | void) → `toUnsub` lo
// normaliza. Si no se provee `version`, se sintetiza una monótona que avanza en cada notify
// (el motor relee el snapshot ante cada notify igual; la version sirve a consumidores que sí la
// observan). Sin `dirtyIds`/`itemById` el motor cae a rebuild-on-notify (correcto, O(n)); con
// ellos hace patch O(k).
export const defineSource = ({ accessors, variants, getSnapshot, subscribe, version, dirtyIds, itemById }) => {
  requireSourceConfig({ accessors, getSnapshot, subscribe })

  let ticks = 0
  const tick = (cb) => () => { ticks++; cb() }   // wrapper estable por suscripción (no por notify)

  return {
    accessors,
    variants,
    getSnapshot,
    version: version ?? (() => ticks),
    subscribe: version
      ? (cb) => toUnsub(subscribe(cb))           // version propia → notify directo, sin overhead
      : (cb) => toUnsub(subscribe(tick(cb))),    // version sintética → avanza el contador por notify
    dirtyIds,
    itemById,
  }
}

// Ruta C: el consumidor no trae reactividad propia. `createSource` devuelve UN objeto que ES el
// Source (cumple el contrato: getSnapshot/subscribe/version/…) y además expone los métodos de
// dueño (set/patch/move/remove/addFilter/…). Se adjunta tal cual a las vistas (`layer.source =
// fleet`) y el motor solo llama a los miembros de lectura; se muta por los de escritura. Una
// sola fuente compartible por N vistas → el filtro se computa una vez, no por componente.
//
// Posee un Store + Emitter internos (tunnel reactivo, defer rAF). `move` es O(1) lado-dato:
// actualiza un override de posición y marca el id; la capa hace el slot-write en el buffer GL.
// Los acumuladores (move/estructural) se juntan por VENTANA de flush y solo se limpian al abrir la
// siguiente (tras un emit) → correctos bajo coalescing: N ops en un tick colapsan en un emit con
// todos sus ids.
export const createSource = (accessors, variants) => {
  // `idOf` es lo ÚNICO universal: el Store indexa por id. La geometría la exige cada capa que la
  // consuma (`positionOf` para punto/label, `pathOf` para línea) — pedirla acá dejaría fuera a una
  // Source que sólo alimenta una tabla, que es un uso legítimo y no tiene geometría.
  if (typeof accessors?.idOf !== 'function')
    throw new TypeError('[createSource] requiere accessors.idOf')

  const idOf = accessors.idOf
  const basePositionOf = accessors.positionOf

  const overrides = new Map()           // id → { lat, lng } (posición viva por move)
  const moveDirty = new Set()           // ids movidos en la ventana actual
  const structDirty = new Set()         // ids con cambio estructural en la ventana actual
  let current = []                      // set completo actual → base correcta para remove
  let version = 0                       // monótona; el emitter hace dirty-skip contra esta
  let windowClosed = false              // tras un emit, la próxima op abre ventana nueva

  const store = new Store([], {
    versionTracker: { idOf, hashOf: accessors.hashOf ?? idOf },
  })
  const emitter = new Emitter({
    source: () => store.filtered,
    version: () => version,
    interval: 0,
    defer: 'raf',
    onFlush: () => { windowClosed = true },   // los acumuladores ya se consumieron en este emit
  })

  // Abre ventana: si la anterior ya emitió, los acumuladores arrancan limpios.
  const beginOp = () => {
    if (!windowClosed) return
    moveDirty.clear()
    structDirty.clear()
    windowClosed = false
  }
  const commit = () => { version++; emitter.notify() }

  // positionOf efectivo: usa el override si el id fue movido. Sólo para fuentes con geometría de
  // punto (point/label); una fuente de líneas (pathOf, sin positionOf) no lo expone ni usa `move`.
  const positionOf = basePositionOf
    ? (item) => overrides.get(idOf(item)) ?? basePositionOf(item)
    : undefined
  const readAccessors = positionOf ? { ...accessors, positionOf } : accessors

  // Un único objeto: lectura (contrato Source) + escritura (dueño). El motor solo lee.
  return {
    /* ── Lectura: contrato Source ── */
    accessors: readAccessors,
    variants,
    getSnapshot: () => store.filtered,
    version: () => version,
    subscribe: (cb) => {
      const id = Symbol('sub')
      emitter.subscribe(id, cb)
      return () => emitter.unsubscribe(id)
    },
    itemById: (id) => store.get(id),
    dirtyIds: () => structDirty,          // cambios estructurales de la ventana (acumulados)
    moveDirtyIds: () => moveDirty,        // moves de la ventana (la capa los escribe por slot)

    /* ── Escritura: dueño ── */
    set(items) {
      beginOp()
      current = items
      overrides.clear()
      store.update(items)
      const d = store.dirtyIds
      if (d) for (const id of d) structDirty.add(id)
      commit()
    },

    patch(items, dirtyIds) {
      beginOp()
      current = items
      // El patch es autoritativo sobre moves previos de los mismos ids.
      for (const id of dirtyIds) { overrides.delete(id); structDirty.add(id) }
      store.patch(items, dirtyIds)
      commit()
    },

    remove(id) {
      beginOp()
      overrides.delete(id)
      moveDirty.delete(id)
      current = current.filter(it => idOf(it) !== id)   // base completa, no la vista filtrada
      store.update(current)
      structDirty.add(id)
      commit()
    },

    // O(1): registra el override y marca el id; la capa escribe el slot (sin rebuild).
    move(id, lat, lng) {
      beginOp()
      const pos = overrides.get(id)
      if (pos) { pos.lat = lat; pos.lng = lng }
      else overrides.set(id, { lat, lng })
      moveDirty.add(id)
      commit()
    },

    // Filtros: cambian la membresía → el snapshot cambia de tamaño → la capa rebuildea
    // (la ruta incremental no aplica). beginOp+commit los integran al ciclo de flush.
    addFilter(filter) { beginOp(); store.addFilter(filter); commit() },
    removeFilter(filterId) { beginOp(); store.removeFilter(filterId); commit() },

    destroy() {
      emitter.destroy()
      store.destroy()
      overrides.clear()
      moveDirty.clear()
      structDirty.clear()
    },
  }
}
