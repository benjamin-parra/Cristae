import { Store } from './Store.js'
import { Emitter } from './Emitter.js'
import { toUnsub } from './teardown.js'
import { isNested, listOf } from './path.js'
import { accessorsFromFields } from './fields.js'
import { safe } from './safe.js'

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
  // Guard de configuración (Eje 1 — inline, un solo uso): valida el contrato una vez al definir
  // (no es hot path). Geometría: `positionOf` (point/label) o `pathOf` (line). Una de las dos.
  const configOk = typeof getSnapshot === 'function'
    && typeof subscribe === 'function'
    && typeof accessors?.idOf === 'function'
    && (typeof accessors?.positionOf === 'function' || typeof accessors?.pathOf === 'function')
  if (!configOk) throw new TypeError('[defineSource] requiere getSnapshot, subscribe, accessors.idOf y positionOf|pathOf')

  let ticks = 0
  const tick = cb => () => { ticks++; cb() }   // wrapper estable por suscripción (no por notify)

  return {
    accessors,
    variants,
    getSnapshot,
    version:   version ?? (() => ticks),
    subscribe: version
      ? cb => toUnsub(subscribe(cb))           // version propia → notify directo, sin overhead
      : cb => toUnsub(subscribe(tick(cb))),    // version sintética → avanza el contador por notify
    dirtyIds,
    itemById,
  }
}

// Ventana de flush (Eje 7 — estado + acciones). Junta el estado que beginOp/commit/onFlush
// manipulaban suelto: los dos acumuladores de ids (`structs`/`moves`), el flag de ventana cerrada
// y la version monótona. `abrir` es el beginOp (limpia SÓLO si la anterior ya emitió); `commit`
// avanza la version y dispara el emit; `cerrar` es el onFlush (marca cerrada tras el reparto, así
// una op del callback cae en la ventana que se cierra); `limpiar` es la baja (destroy). Los Sets se
// vacían IN-PLACE, nunca se reasignan: las vistas toman la referencia una vez (dirtyIds/moveDirtyIds/
// appendedPoints) y la conservan mientras viva la Source.
const crearVentana = emitter => {
  const moves = new Set()      // ids movidos en la ventana actual (la capa los escribe por slot)
  const structs = new Set()    // ids con cambio estructural en la ventana actual
  const appends = new Map()    // id → puntos sumados a su path en la ventana actual
  let cerrada = false          // tras un emit, la próxima op abre ventana nueva
  let version = 0              // monótona; el emitter hace dirty-skip contra ésta
  return {
    moves,
    structs,
    appends,
    version: () => version,
    abrir:   () => {
      if (!cerrada) return
      moves.clear()
      structs.clear()
      appends.clear()
      cerrada = false
    },
    marcarMove:   id => moves.add(id),
    marcarStruct: id => structs.add(id),
    commit:       () => { version++; emitter.notify() },
    cerrar:       () => cerrada = true,          // onFlush: los acumuladores ya se consumieron
    limpiar:      () => { moves.clear(); structs.clear(); appends.clear() },
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
// Los acumuladores (move/estructural) se juntan por VENTANA de flush (ver `crearVentana`) y solo se
// limpian al abrir la siguiente (tras un emit) → correctos bajo coalescing: N ops en un tick
// colapsan en un emit con todos sus ids.
export const createSource = (input, variants) => {
  // `fields` es el gemelo serializable de los accessors: se compila a funciones antes del guard, y una
  // función propia gana sobre su campo.
  const accessors = input?.fields ? accessorsFromFields(input.fields, input) : input
  // `idOf` es lo ÚNICO universal: el Store indexa por id. La geometría la exige cada capa que la
  // consuma (`positionOf` para punto/label, `pathOf` para línea) — pedirla acá dejaría fuera a una
  // Source que sólo alimenta una tabla, que es un uso legítimo y no tiene geometría.
  if (typeof accessors?.idOf !== 'function')
    throw new TypeError('[createSource] requiere accessors.idOf')

  const idOf = accessors.idOf
  const basePositionOf = accessors.positionOf
  const baseHeadingOf  = accessors.headingOf

  const overrides = new Map()           // id → { lat, lng, heading, hasHeading } (posición y rumbo vivos por move)
  let current = []                      // set completo actual → base correcta para remove

  const store = new Store([], {
    versionTracker: { idOf, hashOf: accessors.hashOf ?? idOf },
  })
  let ventana
  const emitter = new Emitter({
    source:   () => store.filtered,
    version:  () => ventana.version(),
    interval: 0,
    defer:    'raf',
    onFlush:  () => ventana.cerrar(),
  })
  ventana = crearVentana(emitter)

  // positionOf efectivo: usa el override si el id fue movido. Sólo para fuentes con geometría de
  // punto (point/label); una fuente de líneas (pathOf, sin positionOf) no lo expone ni usa `move`.
  const positionOf = basePositionOf
    ? item => overrides.get(idOf(item)) ?? basePositionOf(item)
    : undefined

  // headingOf efectivo: el rumbo que dejó `move` si el id lo trae, si no el del consumidor, y sin ese 0.
  // Existe en toda fuente con posición, aunque la capa no declare canal de rumbo: así `move` con rumbo gira
  // un set que rota. Sólo lo llama la capa cuando el set rota, así que el 2D sin rotación no gana llamadas.
  // Sin ningún move vivo no consulta `overrides`: el rebuild de un set que rota no paga un Map.get por ítem.
  const headingOf = positionOf
    ? item => {
      if (!overrides.size) return baseHeadingOf ? baseHeadingOf(item) : 0
      const pos = overrides.get(idOf(item))
      return pos?.hasHeading ? pos.heading : baseHeadingOf ? baseHeadingOf(item) : 0
    }
    : undefined

  // pathOf efectivo: el del consumidor más los puntos que `append` sumó a ese id. Siguen al final del
  // path si es plano, y a su última parte no vacía si es anidado: las vacías del final no aportan
  // índice, así que el tramo abierto es el que termina donde termina el path. Un punto que no es punto
  // corta, como en cualquier path. Leer un path con lo sumado lo copia: O(path), como quien lo recorre.
  const tails      = new Map()          // id → puntos sumados desde el último set/patch/remove del id
  const basePathOf = accessors.pathOf
  const pathOf     = basePathOf
    ? item => {
      const tail = tails.get(idOf(item))
      if (!tail) return basePathOf(item)
      const top = listOf(basePathOf(item))
      if (!isNested(top)) return top.concat(tail)
      const parts = top.map(listOf)
      let k = parts.length - 1
      while (k > 0 && !parts[k].length) k--
      parts[k] = parts[k].concat(tail)
      return parts
    }
    : undefined
  const readAccessors = positionOf || pathOf
    ? { ...accessors, ...(positionOf && { positionOf, headingOf }), ...(pathOf && { pathOf }) }
    : accessors

  // Un único objeto: lectura (contrato Source) + escritura (dueño). El motor solo lee.
  return {
    /* ── Lectura: contrato Source ── */
    accessors: readAccessors,
    variants,
    getSnapshot: () => store.filtered,
    version:     () => ventana.version(),
    subscribe:   cb => {
      const id = Symbol('sub')
      emitter.subscribe(id, cb)
      return () => emitter.unsubscribe(id)
    },
    itemById:     id => store.get(id),
    dirtyIds:     () => ventana.structs,  // cambios estructurales de la ventana (acumulados)
    moveDirtyIds: () => ventana.moves,    // moves de la ventana (la capa los escribe por slot)
    appendedPoints: () => ventana.appends, // id → puntos que `append` sumó en la ventana

    /* ── Escritura: dueño ── */
    set(items) {
      ventana.abrir()
      current = items
      overrides.clear()
      tails.forEach((_, id) => ventana.marcarStruct(id))   // volvieron al path del consumidor: reescritura
      tails.clear()
      ventana.appends.clear()
      store.update(items)
      const d = store.dirtyIds
      if (d) { const { structs } = ventana; for (const id of d) structs.add(id) }
      ventana.commit()
    },

    patch(items, dirtyIds) {
      ventana.abrir()
      current = items
      // El patch es autoritativo sobre moves previos de los mismos ids.
      const { structs } = ventana
      for (const id of dirtyIds) { overrides.delete(id); tails.delete(id); ventana.appends.delete(id); structs.add(id) }
      store.patch(items, dirtyIds)
      ventana.commit()
    },

    remove(id) {
      ventana.abrir()
      overrides.delete(id)
      tails.delete(id)
      ventana.moves.delete(id)
      ventana.appends.delete(id)
      current = current.filter(it => idOf(it) !== id)   // base completa, no la vista filtrada
      store.update(current)
      ventana.marcarStruct(id)
      ventana.commit()
    },

    // O(1): registra el override y marca el id; la capa escribe el slot (sin rebuild). Con `heading` finito
    // (grados) el ítem también gira; sin él, o con uno que no es finito, se conserva el rumbo anterior del
    // override. El objeto del override se reusa: no asigna tras el primer move del id.
    move(id, lat, lng, heading) {
      ventana.abrir()
      const pos = overrides.get(id)
      if (pos) {
        pos.lat = lat
        pos.lng = lng
        if (Number.isFinite(heading)) { pos.heading = heading; pos.hasHeading = true }
      } else {
        const hasHeading = Number.isFinite(heading)
        overrides.set(id, { lat, lng, heading: hasHeading ? heading : 0, hasHeading })
      }
      ventana.marcarMove(id)
      ventana.commit()
    },

    // Suma `points` al final del path del id, en O(points): la capa escribe sólo lo agregado. El path
    // del consumidor no se toca; `set`/`patch`/`remove` del id descartan lo sumado.
    append(id, ...points) {
      if (!pathOf) throw new TypeError('[createSource] append requiere accessors.pathOf')
      if (store.get(id) === undefined) throw new RangeError(`[createSource] append: no hay un ítem con id ${String(id)}`)
      if (!points.length) return
      ventana.abrir()
      for (const map of [tails, ventana.appends]) (map.get(id) ?? map.set(id, []).get(id)).push(...points)
      ventana.commit()
    },

    // Filtros: cambian la membresía → el snapshot cambia de tamaño → la capa rebuildea
    // (la ruta incremental no aplica). abrir+commit los integran al ciclo de flush.
    addFilter(filter) { ventana.abrir(); store.addFilter(filter); ventana.commit() },
    removeFilter(filterId) { ventana.abrir(); store.removeFilter(filterId); ventana.commit() },

    destroy() {
      emitter.destroy()
      store.destroy()
      overrides.clear()
      tails.clear()
      ventana.limpiar()
    },
  }
}

// Símbolo con que una capa liga la Source pendiente a sus accessors. INTERNO: no sale por `src/data/index.js`.
export const BIND = Symbol('cristae.source.bind')

const SIN_ITEMS = Object.freeze([])   // el snapshot de toda Source pendiente: vacío y compartido

// Una op encolada que lanza (un `append` a un id que aún no existe) no corta el resto de la cola.
const ignorarOp = () => {}

// La Source que existe antes de su capa (`el.source` disponible desde la construcción, antes de `ready`).
// Hasta que una capa la liga no tiene accessors: encola en orden lo que se le escribe, responde lo neutro a
// las lecturas y guarda los suscriptores. `source[BIND](accessors, variants, { hold })` crea la Source real
// con `createSource` y copia sus miembros SOBRE ESTE MISMO objeto: son cierres sin `this`, así que la
// identidad del objeto que ya circula no cambia, y tras ligarse no queda ninguna rama en sus métodos (el hot
// path de `move` es el de siempre). Devuelve `release()`, que reproduce lo retenido por `hold` una sola vez.
// Ya ligada, BIND no hace nada: los accessors quedan fijados en el primer montaje, como `id-of`.
export const createPendingSource = () => {
  let queue    = []              // { name, args } en orden de llegada
  let moves    = new Map()       // id → op de move aún sin una op que no sea move después: se colapsan
  let subs     = []              // { cb, off, vivo }
  let ligada   = false
  const dirty     = new Set()
  const moveDirty = new Set()
  const appended  = new Map()

  const encolar = (name, args) => {
    if (name === 'set') {
      // Un `set` reemplaza todo y descarta moves, appends y overrides previos: sólo importan los filtros, que son
      // de la Source y no de los ítems. Así un elemento que no monta nunca no retiene cada array que se le escribió.
      queue = queue.filter(op => op.name === 'addFilter' || op.name === 'removeFilter')
    }
    if (name !== 'move') { moves.clear(); queue.push({ name, args }); return }
    const previa = moves.get(args[0])
    if (previa) {
      // El último gana; un move sin rumbo conserva el del anterior, como lo haría ya ligado.
      const [, lat, lng, heading] = args
      previa.args[1] = lat
      previa.args[2] = lng
      if (Number.isFinite(heading)) previa.args[3] = heading
      return
    }
    const op = { name, args }
    moves.set(args[0], op)
    queue.push(op)
  }

  const pendiente = {
    getSnapshot:    () => SIN_ITEMS,
    version:        () => 0,
    itemById:       () => undefined,
    dirtyIds:       () => dirty,
    moveDirtyIds:   () => moveDirty,
    appendedPoints: () => appended,
    subscribe: cb => {
      const sub = { cb, off: null, vivo: true }
      subs.push(sub)
      return () => {
        if (!sub.vivo) return
        sub.vivo = false
        sub.off?.()
        subs = subs.filter(s => s !== sub)
      }
    },
    set:          (...args) => encolar('set', args),
    patch:        (...args) => encolar('patch', args),
    remove:       (...args) => encolar('remove', args),
    move:         (...args) => encolar('move', args),
    append:       (...args) => encolar('append', args),
    addFilter:    (...args) => encolar('addFilter', args),
    removeFilter: (...args) => encolar('removeFilter', args),
    destroy() {
      queue = []
      moves.clear()
      for (const sub of subs) { sub.vivo = false; sub.off?.() }
      subs = []
    },

    [BIND](accessors, variants, { hold = false } = {}) {
      if (ligada) return ignorarRelease
      ligada = true
      const real = createSource(accessors, variants)
      Object.assign(pendiente, real)
      for (const sub of subs) if (sub.vivo) sub.off = real.subscribe(sub.cb)
      const cola = queue
      queue = []
      moves.clear()
      const aplicar   = op => real[op.name](...op.args)   // una por ligadura, no por op
      let reproducida = false
      const release = () => {
        if (reproducida) return
        reproducida = true
        for (const op of cola) safe(aplicar, op, ignorarOp)
      }
      if (!hold) release()
      return release
    },
  }
  return pendiente
}

const ignorarRelease = () => {}
