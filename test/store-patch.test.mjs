// Contrato de Store.patch — equivalencia observacional con update(), identidad del Set de ids
// sucios (reusado, no copiado) y degradaciones (id duplicado / ausente / sin versionTracker).
// También congela: superficie pública, bookkeeping de elementVersions/dataVersion, copia del
// snapshot del constructor y coherencia de get() tras add/removeFilter.
// Corre con: node --test test/store-patch.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/data/Store.js'
import { makeFilter } from '../src/data/filters.js'

/* ── Utilería determinista (sin Math.random ni Date.now) ── */

// LCG de 32 bits: mismo dataset y mismas mutaciones en cada corrida.
const lcg = (semilla) => {
  let s = semilla >>> 0
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296
}
const hasta = (rnd, n) => Math.floor(rnd() * n)

const idOf = it => it.id
const hashOf = it => `${it.n}|${it.grupo}|${it.activo ? 1 : 0}`
const TRACKER = { versionTracker: { idOf, hashOf } }

const item = (id, n, grupo, activo) => ({ id, n, grupo, activo })

const dataset = (rnd, cantidad) =>
  Array.from({ length: cantidad }, (_, i) =>
    item(`e${i}`, hasta(rnd, 100), hasta(rnd, 4), rnd() < 0.7))

// Predicados sobre campos que las mutaciones tocan → la membresía cambia sola.
const CATALOGO_FILTROS = [
  ['activo', it => it.activo],
  ['n_par', it => it.n % 2 === 0],
  ['grupo_no_3', it => it.grupo !== 3],
  ['n_alto', it => it.n >= 20],
]

// Muta un subconjunto CONSERVANDO la disposición id↔índice: el contrato de patch es
// "el mismo snapshot con ítems reemplazados", no un reordenamiento.
const mutar = (items, rnd) => {
  const sucios = new Set()
  const nuevos = items.map(it => {
    if (rnd() < 0.3) return it
    sucios.add(it.id)
    return item(it.id, hasta(rnd, 100), hasta(rnd, 4), rnd() < 0.7)
  })
  return { nuevos, sucios }
}

/* ── Propiedad: patch ≡ update ── */

test('patch y update dejan el mismo filtered, ítem a ítem y por identidad', () => {
  const rnd = lcg(20260721)
  // Se miden las DOS ramas sobre el hecho observable, no sobre un proxy: el regenerado duro
  // reasigna #selfFiltered (referencia nueva), el camino O(k) escribe los slots in situ.
  // Sin la rama incremental el deepEqual de abajo es tautológico (patch llamaría al mismo
  // #hardRegenerate que update sobre el mismo snapshot).
  let regenerados = 0
  let incrementales = 0

  for (let caso = 0; caso < 30; caso++) {
    const base = dataset(rnd, 40)
    const filtros = CATALOGO_FILTROS
      .filter(() => rnd() < 0.5)
      .map(([id, f]) => makeFilter(id, f))

    const conPatch = new Store(base, TRACKER)
    const conUpdate = new Store(base, TRACKER)
    filtros.forEach(F => { conPatch.addFilter(F); conUpdate.addFilter(F) })

    let items = base
    for (let k = 0; k < 6; k++) {
      const { nuevos, sucios } = mutar(items, rnd)
      const vistaPrevia = conPatch.filtered

      conPatch.patch(nuevos, sucios)
      conUpdate.update(nuevos)

      if (conPatch.filtered === vistaPrevia) incrementales++
      else regenerados++

      assert.deepEqual(conPatch.filtered.map(idOf), conUpdate.filtered.map(idOf))
      assert.ok(conPatch.filtered.every((it, i) => it === conUpdate.filtered[i]),
        'ambos caminos deben referenciar los MISMOS objetos del snapshot nuevo')

      // get(id) coherente con la vista: identidad si está, undefined si quedó fuera.
      const enVista = new Set(conPatch.filtered.map(idOf))
      for (const it of conPatch.filtered) assert.equal(conPatch.get(it.id), it)
      for (const it of nuevos) if (!enVista.has(it.id)) assert.equal(conPatch.get(it.id), undefined)

      items = nuevos
    }
  }

  // Guardias simétricas: si el dataset deja de ejercitar una de las dos ramas, la propiedad
  // deja de comparar caminos distintos y hay que avisar.
  assert.ok(regenerados > 0, `el barrido debe ejercitar el regenerado duro (fue ${regenerados})`)
  assert.ok(incrementales > 0, `el barrido debe ejercitar el camino O(k) (fue ${incrementales})`)
})

test('patch incremental (membresía congelada) coincide con update ítem a ítem', () => {
  // Gemelo del barrido anterior con los filtros mirando campos que la mutación NO toca:
  // patch toma SIEMPRE el camino O(k), así que la comparación contra update() es real
  // (en el barrido general la mayoría de las rondas regeneran y comparan lo mismo consigo mismo).
  const rnd = lcg(31071973)
  let rondas = 0

  for (let caso = 0; caso < 20; caso++) {
    const base = dataset(rnd, 30)
    const conPatch = new Store(base, TRACKER)
    const conUpdate = new Store(base, TRACKER)
    const F = makeFilter('grupo_no_3', it => it.grupo !== 3)
    conPatch.addFilter(F)
    conUpdate.addFilter(F)

    let items = base
    for (let k = 0; k < 6; k++) {
      const sucios = new Set()
      const nuevos = items.map(it => {
        if (rnd() < 0.5) return it
        sucios.add(it.id)
        return item(it.id, hasta(rnd, 100), it.grupo, it.activo)   // sólo n → membresía estable
      })

      const vistaPrevia = conPatch.filtered
      conPatch.patch(nuevos, sucios)
      conUpdate.update(nuevos)
      rondas++

      assert.equal(conPatch.filtered, vistaPrevia, 'el camino O(k) no reasigna la vista')
      assert.deepEqual(conPatch.filtered.map(it => `${it.id}:${it.n}`),
        conUpdate.filtered.map(it => `${it.id}:${it.n}`),
        'cada slot sucio quedó con el ítem FRESCO del snapshot')
      assert.ok(conPatch.filtered.every((it, i) => it === conUpdate.filtered[i]),
        'mismos objetos, no copias equivalentes')
      for (const it of conPatch.filtered) assert.equal(conPatch.get(it.id), it)

      items = nuevos
    }
  }

  assert.equal(rondas, 120, 'el barrido incremental debe correr sus 120 rondas')
})

test('un ítem sucio que cambia de membresía regenera y deja la vista exacta', () => {
  const base = [item('a', 1, 0, true), item('b', 1, 0, true), item('c', 1, 0, true)]
  const s = new Store(base, TRACKER)
  s.addFilter(makeFilter('activo', it => it.activo))
  assert.deepEqual(s.filtered.map(idOf), ['a', 'b', 'c'])

  // 'b' sale del filtro → el camino incremental no alcanza, se regenera todo.
  const nuevos = [item('a', 2, 0, true), item('b', 2, 0, false), item('c', 2, 0, true)]
  s.patch(nuevos, new Set(['b']))
  assert.deepEqual(s.filtered.map(idOf), ['a', 'c'])
  assert.equal(s.get('b'), undefined)
  assert.equal(s.get('c'), nuevos[2])

  // Y al volver a entrar, reaparece en su posición de origen.
  const vuelven = [nuevos[0], item('b', 3, 0, true), nuevos[2]]
  s.patch(vuelven, new Set(['b']))
  assert.deepEqual(s.filtered.map(idOf), ['a', 'b', 'c'])
})

test('patch sin cambio de membresía escribe en el mismo arreglo (no lo reasigna)', () => {
  const base = [item('a', 1, 0, true), item('b', 1, 0, true)]
  const s = new Store(base, TRACKER)
  const vista = s.filtered

  const nuevos = [item('a', 9, 0, true), base[1]]
  s.patch(nuevos, new Set(['a']))

  assert.equal(s.filtered, vista, 'la referencia de filtered se conserva entre flushes')
  assert.equal(vista[0], nuevos[0], 'el slot del id sucio se reescribe in situ')
  assert.equal(vista[1], base[1], 'los ítems no sucios conservan su referencia')
})

/* ── Degradaciones ── */

test('patch sin ids sucios cae a update completo', () => {
  const base = [item('a', 1, 0, true), item('b', 1, 0, true)]
  const s = new Store(base, TRACKER)
  const nuevos = [item('a', 5, 0, true), item('b', 5, 0, true)]

  s.patch(nuevos, new Set())
  assert.equal(s.filtered[0], nuevos[0])
  assert.equal(s.filtered[1], nuevos[1])

  const masNuevos = [item('a', 7, 0, true), item('b', 7, 0, true)]
  s.patch(masNuevos, undefined)          // sin Set → misma caída a update
  assert.equal(s.filtered[0], masNuevos[0])
})

test('patch sin versionTracker cae a update y no hay índice por id', () => {
  const base = [item('a', 1, 0, true), item('b', 1, 0, true)]
  const s = new Store(base)             // sin versionTracker
  const nuevos = [item('a', 5, 0, true), item('b', 5, 0, true)]

  s.patch(nuevos, new Set(['a']))
  assert.equal(s.filtered[0], nuevos[0], 'debe haberse regenerado con el snapshot nuevo')
  assert.equal(s.get('a'), undefined, 'sin tracker no se construye el índice id → posición')
  assert.equal(s.dirtyIds, null)
})

test('un id sucio ausente del snapshot se ignora sin romper la vista', () => {
  const base = [item('a', 1, 0, true), item('b', 1, 0, true)]
  const s = new Store(base, TRACKER)
  const vista = s.filtered
  const version = s.dataVersion

  s.patch(base, new Set(['fantasma']))

  assert.equal(s.filtered, vista)
  assert.deepEqual(s.filtered.map(idOf), ['a', 'b'])
  assert.equal(s.get('fantasma'), undefined)
  assert.equal(s.dataVersion, version + 1, 'igual avanza la versión y notifica')
})

test('con id duplicado el patch resuelve por la PRIMERA aparición', () => {
  // Caso degenerado que motivó el "id duplicado → primero" del índice base.
  const base = [item('a', 1, 0, true), item('b', 1, 0, true), item('a', 3, 0, true)]
  const s = new Store(base, TRACKER)

  const nuevos = [item('a', 10, 0, true), base[1], item('a', 30, 0, true)]
  s.patch(nuevos, new Set(['a']))

  assert.equal(s.get('a').n, 10, 'el ítem resuelto es el de la primera posición del id')
  assert.ok(s.filtered.some(it => it.n === 10))
  assert.ok(!s.filtered.some(it => it.n === 30))
})

/* ── Notificación y versiones ── */

test('patch avanza dataVersion y notifica con la vista vigente', () => {
  const base = [item('a', 1, 0, true)]
  const s = new Store(base, TRACKER)
  let avisos = 0
  let ultima = null
  s.addListener({ id: 'espia', callback: (data) => { avisos++; ultima = data } })

  const version = s.dataVersion
  const nuevos = [item('a', 2, 0, true)]
  s.patch(nuevos, new Set(['a']))

  assert.equal(avisos, 1)
  assert.equal(ultima, s.filtered)
  assert.equal(s.dataVersion, version + 1)
})

test('dirtyIds es el MISMO Set entre scans, no una copia', () => {
  // Identidad, no contenido: el Set es reusable ([0-alloc]) y nunca se reasigna.
  const s = new Store([item('a', 1, 0, true), item('b', 1, 0, true)], TRACKER)
  const s1 = s.dirtyIds
  const versiones1 = s.elementVersions
  assert.deepEqual([...s1].sort(), ['a', 'b'])

  s.update([item('a', 2, 0, true), item('b', 1, 0, true)])
  const s2 = s.dirtyIds

  assert.equal(s1, s2, 'update no puede reemplazar el Set de ids sucios')
  assert.equal(s.elementVersions, versiones1, 'tampoco el Map de versiones')
  assert.deepEqual([...s2], ['a'], 'el mismo Set queda con los sucios del último scan')

  s.update([item('a', 2, 0, true), item('b', 1, 0, true)])
  assert.equal(s.dirtyIds, s2)
  assert.equal(s.dirtyIds.size, 0, 'sin cambios de hash el scan lo deja vacío')
})

test('el regenerado duro deja filtered correcto aunque se corten los bumps', () => {
  const base = ['a', 'b', 'c', 'd'].map(id => item(id, 1, 0, true))
  const s = new Store(base, TRACKER)
  s.addFilter(makeFilter('activo', it => it.activo))

  const nuevos = [item('a', 2, 0, true), item('b', 2, 0, false), item('c', 2, 0, true), item('d', 2, 0, true)]
  s.patch(nuevos, new Set(['a', 'b', 'c', 'd']))

  assert.deepEqual(s.filtered.map(idOf), ['a', 'c', 'd'])
  assert.equal(s.get('c'), nuevos[2], 'el ítem fresco entra a la vista aunque su versión no se bumpee')
})

test('update() y patch bumpean elementVersions sólo del id cuyo hash cambió', () => {
  // Esta cobertura vivía dentro del test {todo} de S6 y quedaba desactivada entera: sin ella,
  // romper por completo el bookkeeping de versiones pasaba verde.
  const base = ['a', 'b', 'c', 'd'].map(id => item(id, 1, 0, true))
  const s = new Store(base, TRACKER)
  for (const id of ['a', 'b', 'c', 'd']) {
    assert.equal(s.elementVersions.get(id), 1, `el scan del constructor bumpea ${id} a 1`)
  }

  // update(): sólo 'a' cambia de hash.
  s.update([item('a', 2, 0, true), base[1], base[2], base[3]])
  assert.equal(s.elementVersions.get('a'), 2)
  assert.equal(s.elementVersions.get('b'), 1, 'un ítem con el mismo hash no se bumpea')

  // patch SIN cambio de membresía: recorre todos los sucios (no hay break) y bumpea sólo esos.
  s.patch([item('a', 2, 0, true), item('b', 3, 0, true), base[2], base[3]], new Set(['b', 'c']))
  assert.equal(s.elementVersions.get('b'), 2, 'patch bumpea el id sucio cuyo hash cambió')
  assert.equal(s.elementVersions.get('c'), 1, 'un id sucio cuyo hash NO cambió no se bumpea')
  assert.equal(s.elementVersions.get('a'), 2, 'un id que no vino en dirtyIds queda como estaba')
})

/* ── Bug S6: el break del recorrido corta los version-bumps posteriores ── */

// Escenario compartido: 'b' cambia de membresía en la 2ª posición del recorrido de dirtyIds.
const escenarioS6 = () => {
  const base = ['a', 'b', 'c', 'd'].map(id => item(id, 1, 0, true))
  const s = new Store(base, TRACKER)
  s.addFilter(makeFilter('activo', it => it.activo))
  const nuevos = [item('a', 2, 0, true), item('b', 2, 0, false), item('c', 2, 0, true), item('d', 2, 0, true)]
  s.patch(nuevos, new Set(['a', 'b', 'c', 'd']))
  return s
}

test('S6 — patch bumpea la versión de TODOS los ids sucios, no sólo hasta el primer cambio de membresía',
  { todo: 'bug S6 — el break del recorrido corta los version-bumps posteriores' }, () => {
    const s = escenarioS6()
    assert.equal(s.elementVersions.get('c'), 2)
    assert.equal(s.elementVersions.get('d'), 2)
  })

test('S6 sigue vigente: los ids sucios posteriores al break quedan sin bumpear', () => {
  // Fija el comportamiento ACTUAL para que el refactor no lo cambie de callado. Si este test
  // falla, S6 se arregló → sacar el {todo} de arriba (node:test no avisa cuando un todo pasa).
  const s = escenarioS6()
  assert.equal(s.elementVersions.get('a'), 2, 'antes del break sí se bumpea')
  assert.equal(s.elementVersions.get('b'), 2, 'el ítem que dispara el break también')
  assert.equal(s.elementVersions.get('c'), 1)
  assert.equal(s.elementVersions.get('d'), 1)
})

/* ── dataVersion, notificación y orden de efectos ── */

test('update() avanza dataVersion en 1 y notifica una sola vez con la vista regenerada', () => {
  const base = [item('a', 1, 0, true), item('b', 1, 0, true)]
  const s = new Store(base, TRACKER)
  s.addFilter(makeFilter('activo', it => it.activo))

  const vistas = []   // se assertea AFUERA: safeDispatch se traga lo que tire el callback
  s.addListener({ id: 'espia', callback: (data) => vistas.push(data.map(idOf).join('|')) })
  const version = s.dataVersion

  s.update([item('a', 2, 0, true), item('b', 2, 0, false)])

  assert.equal(s.dataVersion, version + 1)
  assert.deepEqual(vistas, ['a'], 'un solo aviso, con la vista ya regenerada')
})

test('en un patch que regenera, el payload del listener es la vista YA regenerada', () => {
  const base = [item('a', 1, 0, true), item('b', 1, 0, true)]
  const s = new Store(base, TRACKER)
  s.addFilter(makeFilter('activo', it => it.activo))

  const vistas = []
  s.addListener({ id: 'espia', callback: (data) => vistas.push(data.map(idOf).join('|')) })

  s.patch([base[0], item('b', 1, 0, false)], new Set(['b']))

  assert.deepEqual(vistas, ['a'], 'notificar antes del regenerado mostraría la vista vieja a|b')
  assert.deepEqual(s.filtered.map(idOf), ['a'])
})

/* ── Snapshot propio: el Store no aliasea el arreglo del caller ── */

test('el Store copia el snapshot: patch nunca escribe en el arreglo del caller', () => {
  const base = [item('a', 1, 0, true), item('b', 1, 0, true)]
  const original = base[0]
  const s = new Store(base, TRACKER)

  assert.notEqual(s.filtered, base, 'la vista arranca como COPIA del arreglo recibido')

  s.patch([item('a', 99, 0, true), base[1]], new Set(['a']))

  assert.equal(base[0], original, 'el slot del caller conserva su ítem')
  assert.equal(base.length, 2)
  assert.equal(s.get('a').n, 99, 'la vista sí ve el ítem fresco')
})

/* ── Capas: la vista heredada también recibe el ítem fresco ── */

test('tras un patch, quitar un filtro propio deja en la vista los ítems FRESCOS', () => {
  // Quitar el filtro regenera desde la capa heredada: si patch no escribió ese slot,
  // el ítem VIEJO resucita.
  const base = [item('a', 1, 0, true), item('b', 1, 0, true)]
  const s = new Store(base, TRACKER)
  s.addFilter(makeFilter('activo', it => it.activo))

  s.patch([item('a', 99, 0, true), base[1]], new Set(['a']))
  assert.equal(s.get('a').n, 99)

  s.removeFilter('activo')
  assert.deepEqual(s.filtered.map(it => it.n), [99, 1], 'la capa heredada quedó con el ítem fresco')
  assert.equal(s.get('a').n, 99)
})

/* ── Filtros: efecto inmediato sobre la vista y los índices ── */

test('get(id) queda coherente con filtered inmediatamente después de addFilter/removeFilter', () => {
  const base = ['a', 'b', 'c', 'd'].map((id, i) => item(id, i, 0, i !== 0))   // 'a' inactivo
  const s = new Store(base, TRACKER)

  s.addFilter(makeFilter('activo', it => it.activo))
  assert.deepEqual(s.filtered.map(idOf), ['b', 'c', 'd'])
  for (const it of s.filtered) assert.equal(s.get(it.id), it, 'addFilter reconstruye el índice')
  assert.equal(s.get('a'), undefined, 'el excluido no resuelve')

  s.removeFilter('activo')
  assert.deepEqual(s.filtered.map(idOf), ['a', 'b', 'c', 'd'], 'removeFilter regenera la vista YA')
  for (const it of s.filtered) assert.equal(s.get(it.id), it)

  s.addFilter(makeFilter('activo', it => it.activo))
  s.clearFilters()
  assert.deepEqual(s.filtered.map(idOf), ['a', 'b', 'c', 'd'], 'clearFilters también regenera YA')
  for (const it of s.filtered) assert.equal(s.get(it.id), it)
})

test('hasFilter refleja el alta y la baja del filtro propio', () => {
  const s = new Store([item('a', 1, 0, true)], TRACKER)
  assert.equal(s.hasFilter('activo'), false)

  s.addFilter(makeFilter('activo', it => it.activo))
  assert.equal(s.hasFilter('activo'), true)
  assert.equal(s.hasFilter('otro'), false)

  s.removeFilter('activo')
  assert.equal(s.hasFilter('activo'), false)
})

test('version() devuelve el mismo contador que avanzan las mutaciones', () => {
  const s = new Store([item('a', 1, 0, true)], TRACKER)
  assert.equal(s.version(), 0, 'un Store recién construido arranca en 0')

  s.addFilter(makeFilter('activo', it => it.activo))
  assert.equal(s.version(), 1)

  s.update([item('a', 2, 0, true)])
  assert.equal(s.version(), 2)
})

/* ── Superficie pública (golden LITERAL, no derivado del módulo) ── */

test('la superficie pública de Store es exactamente la esperada', () => {
  const ESPERADA = [
    'activeFilters', 'addFilter', 'addListener', 'clearFilters', 'constructor', 'dataVersion',
    'destroy', 'dirtyIds', 'elementVersions', 'filtered', 'get', 'hasFilter', 'notifyChanges',
    'patch', 'reactiveCompose', 'removeFilter', 'removeListener', 'update', 'version',
  ]
  assert.deepEqual(Object.getOwnPropertyNames(Store.prototype).sort(), ESPERADA,
    'quitar o agregar un miembro público rompe el contrato congelado en v0.13.0')
})
