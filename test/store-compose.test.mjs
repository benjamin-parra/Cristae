// Contrato de Store.reactiveCompose — herencia de filtros del padre, regeneración por notify,
// baja limpia del listener en destroy() (la fuga del legado) y patch sobre un Store COMPUESTO
// (las dos capas de membresía: la heredada y la propia).
// Corre con: node --test test/store-compose.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/data/Store.js'
import { makeFilter } from '../src/data/filters.js'

const idOf = it => it.id
const item = (id, activo = true, grupo = 0) => ({ id, activo, grupo })

const HIJOS = [item('h1', true, 0), item('h2', false, 0), item('h3', true, 1)]
const PADRES = [item('p1', true, 0), item('p2', true, 1)]

/* ── Herencia de filtros (no de datos) ── */

test('el hijo filtra SUS datos con los filtros del padre', () => {
  const padre = new Store(PADRES.slice())
  padre.addFilter(makeFilter('activo', it => it.activo))

  const hijo = new Store(HIJOS.slice()).reactiveCompose(padre)

  assert.deepEqual(hijo.filtered.map(idOf), ['h1', 'h3'], 'sus propios datos, no los del padre')
  assert.deepEqual(hijo.activeFilters.map(F => F.id), ['activo'])
})

test('los filtros propios del hijo se componen con los del padre (AND)', () => {
  const padre = new Store(PADRES.slice())
  padre.addFilter(makeFilter('activo', it => it.activo))

  const hijo = new Store(HIJOS.slice()).reactiveCompose(padre)
  hijo.addFilter(makeFilter('grupo0', it => it.grupo === 0))

  assert.deepEqual(hijo.filtered.map(idOf), ['h1'])
  assert.deepEqual(hijo.activeFilters.map(F => F.id), ['activo', 'grupo0'],
    'primero los heredados, después los propios')
})

test('componer notifica al hijo y avanza su dataVersion', () => {
  const padre = new Store(PADRES.slice())
  const hijo = new Store(HIJOS.slice())

  let avisos = 0
  hijo.addListener({ id: 'espia', callback: () => avisos++ })
  const version = hijo.dataVersion

  hijo.reactiveCompose(padre)

  assert.equal(avisos, 1)
  assert.equal(hijo.dataVersion, version + 1)
})

test('componer con algo que no es un Store es inerte', () => {
  const hijo = new Store(HIJOS.slice())
  let avisos = 0
  hijo.addListener({ id: 'espia', callback: () => avisos++ })

  assert.equal(hijo.reactiveCompose(null), hijo)
  assert.equal(hijo.reactiveCompose({ filtered: [] }), hijo)
  assert.equal(avisos, 0)
  assert.deepEqual(hijo.filtered.map(idOf), ['h1', 'h2', 'h3'])
})

/* ── Regeneración: el disparador es el notify del padre ── */

test('el hijo re-evalúa los filtros del padre sobre sus datos en cada notify', () => {
  const vistos = []
  const padre = new Store(PADRES.slice())
  padre.addFilter(makeFilter('activo', it => { vistos.push(it.id); return it.activo }))

  const hijo = new Store(HIJOS.slice()).reactiveCompose(padre)
  vistos.length = 0

  padre.update(PADRES.slice())

  assert.ok(vistos.some(id => id.startsWith('h')), 'el filtro heredado corre sobre los datos del hijo')
  assert.deepEqual(hijo.filtered.map(idOf), ['h1', 'h3'])
})

test('un filtro nuevo del padre llega al hijo en el siguiente notify', () => {
  const padre = new Store(PADRES.slice())
  padre.addFilter(makeFilter('activo', it => it.activo))
  const hijo = new Store(HIJOS.slice()).reactiveCompose(padre)

  // addFilter no notifica: el hijo sigue con la foto de filtros anterior.
  padre.addFilter(makeFilter('grupo0', it => it.grupo === 0))
  assert.deepEqual(hijo.activeFilters.map(F => F.id), ['activo'])
  assert.deepEqual(hijo.filtered.map(idOf), ['h1', 'h3'])

  padre.update(PADRES.slice())
  assert.deepEqual(hijo.activeFilters.map(F => F.id), ['activo', 'grupo0'])
  assert.deepEqual(hijo.filtered.map(idOf), ['h1'])
})

test('quitar un filtro del padre también se propaga en el siguiente notify', () => {
  const padre = new Store(PADRES.slice())
  padre.addFilter(makeFilter('activo', it => it.activo))
  const hijo = new Store(HIJOS.slice()).reactiveCompose(padre)
  assert.deepEqual(hijo.filtered.map(idOf), ['h1', 'h3'])

  padre.removeFilter('activo')
  padre.update(PADRES.slice())

  assert.deepEqual(hijo.filtered.map(idOf), ['h1', 'h2', 'h3'])
  assert.deepEqual(hijo.activeFilters.map(F => F.id), [])
})

test('el notify del padre se encadena hasta los listeners del hijo', () => {
  const padre = new Store(PADRES.slice())
  const hijo = new Store(HIJOS.slice()).reactiveCompose(padre)

  let avisos = 0
  let ultima = null
  hijo.addListener({ id: 'espia', callback: (data) => { avisos++; ultima = data } })

  padre.update(PADRES.slice())

  assert.equal(avisos, 1)
  assert.equal(ultima, hijo.filtered, 'el hijo emite su propia vista, no la del padre')
})

/* ── Baja: el listener del hijo no puede quedar vivo en el padre ── */

test('tras destroy() el padre ya no invoca al hijo', () => {
  const padre = new Store(PADRES.slice())
  const hijo = new Store(HIJOS.slice()).reactiveCompose(padre)

  let avisos = 0
  hijo.addListener({ id: 'espia', callback: () => avisos++ })
  padre.update(PADRES.slice())
  assert.equal(avisos, 1, 'referencia: con el vínculo vivo el notify llega')

  hijo.destroy()
  // destroy() limpia los listeners del hijo → se re-instala uno para detectar la invocación.
  let despues = 0
  hijo.addListener({ id: 'post-baja', callback: () => despues++ })
  padre.update(PADRES.slice())

  assert.equal(despues, 0, 'el listener del hijo quedó dado de baja en el padre')
})

test('dar de baja un hijo no afecta al otro', () => {
  const padre = new Store(PADRES.slice())
  padre.addFilter(makeFilter('activo', it => it.activo))
  const hijoA = new Store(HIJOS.slice()).reactiveCompose(padre)
  const hijoB = new Store(HIJOS.slice()).reactiveCompose(padre)

  let avisosA = 0, avisosB = 0
  hijoA.addListener({ id: 'a', callback: () => avisosA++ })
  hijoB.addListener({ id: 'b', callback: () => avisosB++ })

  hijoA.destroy()
  padre.removeFilter('activo')
  padre.update(PADRES.slice())

  assert.equal(avisosA, 0)
  assert.equal(avisosB, 1)
  assert.deepEqual(hijoB.filtered.map(idOf), ['h1', 'h2', 'h3'], 'el hijo vivo sigue heredando')
  assert.deepEqual(hijoA.filtered, [], 'el hijo dado de baja queda vacío')
})

test('destroy() vacía el hijo y es idempotente', () => {
  const padre = new Store(PADRES.slice())
  const hijo = new Store(HIJOS.slice()).reactiveCompose(padre)

  hijo.destroy()
  assert.deepEqual(hijo.filtered, [])

  assert.doesNotThrow(() => hijo.destroy())
  assert.doesNotThrow(() => padre.update(PADRES.slice()))
  assert.deepEqual(hijo.filtered, [])
})

/* ── patch sobre un Store COMPUESTO: las dos capas de membresía ── */

// Ítem con un campo `n` para que el hash cambie sin tocar la membresía de ningún filtro.
const itemT = (id, n, activo, grupo = 0) => ({ id, n, activo, grupo })
const TRACKER = {
  versionTracker: { idOf, hashOf: it => `${it.n}|${it.activo ? 1 : 0}|${it.grupo}` },
}
const padreActivo = () =>
  new Store(PADRES.slice()).addFilter(makeFilter('activo', it => it.activo))

test('un cambio de membresía en la capa HEREDADA regenera el hijo, no sólo el de la capa propia', () => {
  const padre = padreActivo()
  const base = [itemT('a', 1, true, 1), itemT('b', 1, true, 0)]
  const hijo = new Store(base, TRACKER).reactiveCompose(padre)
  hijo.addFilter(makeFilter('grupo0', it => it.grupo === 0))
  assert.deepEqual(hijo.filtered.map(idOf), ['b'], "'a' está en la capa heredada pero no en la propia")

  // 'a' sale del filtro HEREDADO estando ya fuera de la vista propia: sólo cambia esa capa.
  const vistaPrevia = hijo.filtered
  hijo.patch([itemT('a', 2, false, 1), base[1]], new Set(['a']))

  assert.notEqual(hijo.filtered, vistaPrevia, 'el cambio en la capa heredada obliga a regenerar')
  assert.deepEqual(hijo.filtered.map(idOf), ['b'])
  assert.equal(hijo.get('a'), undefined)

  // Quitar el filtro propio regenera desde la capa heredada: ahí 'a' ya no puede estar.
  hijo.removeFilter('grupo0')
  assert.deepEqual(hijo.filtered.map(idOf), ['b'], "'a' salió del filtro del padre")
})

test('un ítem que falla el filtro HEREDADO no dispara regenerado aunque pase los propios', () => {
  const padre = padreActivo()
  const base = [itemT('a', 1, false, 0), itemT('b', 1, true, 0)]
  const hijo = new Store(base, TRACKER).reactiveCompose(padre)
  hijo.addFilter(makeFilter('grupo0', it => it.grupo === 0))
  assert.deepEqual(hijo.filtered.map(idOf), ['b'])

  const vistaPrevia = hijo.filtered
  hijo.patch([itemT('a', 2, false, 0), base[1]], new Set(['a']))   // sigue fuera de ambas capas

  assert.equal(hijo.filtered, vistaPrevia, 'la membresía propia se evalúa CON la heredada (AND)')
  assert.deepEqual(hijo.filtered.map(idOf), ['b'])
})

test('el índice de membresía heredada no acumula ids que ya salieron de esa capa', () => {
  const padre = padreActivo()
  const base = [itemT('a', 1, true, 0), itemT('b', 1, true, 0)]
  const hijo = new Store(base, TRACKER).reactiveCompose(padre)
  assert.deepEqual(hijo.filtered.map(idOf), ['a', 'b'])

  hijo.update([itemT('a', 1, false, 0), base[1]])   // 'a' sale de la capa heredada
  assert.deepEqual(hijo.filtered.map(idOf), ['b'])

  const vistaPrevia = hijo.filtered
  hijo.patch([itemT('a', 2, false, 0), base[1]], new Set(['a']))   // sigue afuera

  assert.equal(hijo.filtered, vistaPrevia, "'a' ya estaba fuera: no hay cambio de membresía")
  assert.deepEqual(hijo.filtered.map(idOf), ['b'])
})
