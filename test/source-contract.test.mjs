// Contrato de FORMA de las dos primitivas de Source (src/data/Source.js): qué miembros
// devuelven `createSource` (ruta C, dueña del Store+Emitter) y `defineSource` (ruta B,
// adaptador), con su typeof y su aridad, más los TypeError de configuración.
// Congela la realidad del RUNTIME de v0.13.0 — incluido el desajuste con types/core.d.ts,
// que queda documentado aparte como `todo` (S3).
// Corre con: node --test test/source-contract.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createSource, defineSource } from '../src/data/index.js'

const idOf = it => it.id
const positionOf = it => ({ lat: it.lat, lng: it.lng })
const pathOf = it => it.path

// Config mínima válida de cada ruta (se clona por caso para poder romperla puntualmente).
const configB = (over = {}) => ({
  accessors: { idOf, positionOf },
  getSnapshot: () => [],
  subscribe: () => () => {},
  ...over,
})

const miembros = (obj) => Object.keys(obj).sort()

/* ── createSource: lectura + escritura en un solo objeto ── */

test('createSource devuelve lectura y escritura en el MISMO objeto', () => {
  const variants = ['normal', 'alerta']
  const src = createSource({ idOf, positionOf }, variants)

  assert.deepEqual(miembros(src), [
    'accessors', 'addFilter', 'destroy', 'dirtyIds', 'getSnapshot', 'itemById',
    'move', 'moveDirtyIds', 'patch', 'remove', 'removeFilter', 'set',
    'subscribe', 'variants', 'version',
  ])
  assert.equal(src.variants, variants)   // pasa tal cual, sin copiar
})

test('createSource fija el typeof y la aridad de cada miembro', () => {
  const src = createSource({ idOf, positionOf }, [])
  const aridad = {
    addFilter: 1, destroy: 0, dirtyIds: 0, getSnapshot: 0, itemById: 1,
    move: 3, moveDirtyIds: 0, patch: 2, remove: 1, removeFilter: 1, set: 1,
    subscribe: 1, version: 0,
  }
  for (const [nombre, n] of Object.entries(aridad)) {
    assert.equal(typeof src[nombre], 'function', `${nombre} debe ser función`)
    assert.equal(src[nombre].length, n, `aridad de ${nombre}`)
  }
  assert.equal(typeof src.accessors, 'object')
})

test('createSource envuelve positionOf sólo cuando la fuente tiene geometría de punto', () => {
  // Con positionOf: se envuelve (el override de `move` gana) → objeto nuevo, resto intacto.
  const base = { idOf, positionOf, variantOf: it => it.v }
  const conPunto = createSource(base)
  assert.notEqual(conPunto.accessors, base)
  assert.notEqual(conPunto.accessors.positionOf, positionOf)
  assert.equal(conPunto.accessors.idOf, idOf)
  assert.equal(conPunto.accessors.variantOf, base.variantOf)

  // Sin positionOf (fuente de líneas o de sólo tabla): el objeto pasa por identidad.
  const sinPunto = { idOf, pathOf }
  assert.equal(createSource(sinPunto).accessors, sinPunto)
  assert.equal(createSource(sinPunto).accessors.positionOf, undefined)
})

test('createSource usa idOf como hashOf por default: mutar un ítem sin cambiar su id no lo ensucia', async () => {
  const tick = () => new Promise(r => setTimeout(r, 0))

  const porDefault = createSource({ idOf, positionOf })
  porDefault.set([{ id: 1, lat: 0, lng: 0, v: 1 }])
  await tick()                                          // cierra la ventana
  porDefault.set([{ id: 1, lat: 0, lng: 0, v: 2 }])      // mismo id, otro contenido
  assert.deepEqual([...porDefault.dirtyIds()], [])

  const conHash = createSource({ idOf, positionOf, hashOf: it => it.v })
  conHash.set([{ id: 1, lat: 0, lng: 0, v: 1 }])
  await tick()
  conHash.set([{ id: 1, lat: 0, lng: 0, v: 2 }])
  assert.deepEqual([...conHash.dirtyIds()], [1])
})

/* ── defineSource: adaptador de reactividad ajena (SOLO lectura) ── */

test('defineSource devuelve los 7 miembros de LECTURA y ninguno de dueño', () => {
  const src = defineSource(configB())
  assert.deepEqual(miembros(src), [
    'accessors', 'dirtyIds', 'getSnapshot', 'itemById', 'subscribe', 'variants', 'version',
  ])
  for (const dueño of ['set', 'move', 'patch', 'remove', 'addFilter', 'removeFilter', 'destroy'])
    assert.equal(src[dueño], undefined, `${dueño} no existe en la ruta B`)
})

test('defineSource pasa por identidad lo que recibe y sólo envuelve subscribe', () => {
  const cfg = {
    accessors: { idOf, positionOf },
    variants: ['a'],
    getSnapshot: () => [],
    subscribe: () => () => {},
    version: () => 7,
    dirtyIds: () => new Set([1]),
    itemById: (id) => ({ id }),
  }
  const src = defineSource(cfg)
  for (const k of ['accessors', 'variants', 'getSnapshot', 'version', 'dirtyIds', 'itemById'])
    assert.equal(src[k], cfg[k], `${k} pasa por identidad`)
  assert.notEqual(src.subscribe, cfg.subscribe)   // normaliza el teardown
  assert.equal(src.subscribe.length, 1)
})

test('defineSource sin los opcionales los deja undefined (el motor cae a rebuild-on-notify)', () => {
  const src = defineSource(configB())
  assert.equal(src.variants, undefined)
  assert.equal(src.dirtyIds, undefined)
  assert.equal(src.itemById, undefined)
  assert.equal(typeof src.version, 'function')     // la versión sintética SIEMPRE está
  assert.equal(src.version.length, 0)
})

test('defineSource sin version sintetiza una monótona que avanza en cada notify', () => {
  let notificar = null
  const src = defineSource(configB({ subscribe: (cb) => { notificar = cb; return () => {} } }))
  assert.equal(src.version(), 0)
  src.subscribe(() => {})
  notificar(); notificar()
  assert.equal(src.version(), 2)
})

test('defineSource normaliza cualquier teardown a una función de baja', () => {
  const bajas = []
  const casos = [
    ['función', () => () => bajas.push('función')],
    ['unsubscribe', () => ({ unsubscribe: () => bajas.push('unsubscribe') })],
    ['dispose', () => ({ dispose: () => bajas.push('dispose') })],
  ]
  for (const [nombre, subscribe] of casos) {
    const unsub = defineSource(configB({ subscribe })).subscribe(() => {})
    assert.equal(typeof unsub, 'function', `${nombre}: devuelve función de baja`)
    unsub()
  }
  assert.deepEqual(bajas, ['función', 'unsubscribe', 'dispose'])

  // Sin teardown (o con uno que no se sabe cerrar): la baja queda en no-op, no explota.
  for (const teardown of [undefined, 42]) {
    const unsub = defineSource(configB({ subscribe: () => teardown })).subscribe(() => {})
    assert.equal(typeof unsub, 'function')
    assert.equal(unsub(), undefined)
  }
})

/* ── Contrato de entrada: qué se exige al definir ── */

test('defineSource exige getSnapshot, subscribe, accessors.idOf y positionOf|pathOf', () => {
  const rotos = {
    'sin getSnapshot': { getSnapshot: undefined },
    'sin subscribe': { subscribe: undefined },
    'sin accessors': { accessors: undefined },
    'sin idOf': { accessors: { positionOf } },
    'sin geometría': { accessors: { idOf } },
    'getSnapshot no-función': { getSnapshot: 'nope' },
    'subscribe no-función': { subscribe: {} },
  }
  for (const [caso, over] of Object.entries(rotos))
    assert.throws(() => defineSource(configB(over)), { name: 'TypeError', message: /\[defineSource\]/ }, caso)

  // `pathOf` sola alcanza: una fuente de líneas no tiene posición de punto.
  const soloLinea = { idOf, pathOf }
  const linea = defineSource(configB({ accessors: soloLinea }))
  assert.equal(linea.accessors, soloLinea, 'la ruta B nunca envuelve accessors')
  assert.equal(linea.accessors.positionOf, undefined, 'una fuente de líneas no expone positionOf')

  // Sin config: rompe al desestructurar (no llega al guard).
  assert.throws(() => defineSource(), TypeError)
})

test('createSource exige SÓLO idOf: la geometría la pide cada capa que consuma', () => {
  for (const accessors of [undefined, {}, { positionOf }, { idOf: 'nope' }])
    assert.throws(() => createSource(accessors), { name: 'TypeError', message: /\[createSource\]/ })

  // Fuente de sólo tabla: sin geometría, pero Source completa y usable.
  const soloTabla = { idOf }
  const tabla = createSource(soloTabla)
  assert.equal(tabla.accessors, soloTabla, 'sin positionOf no hay wrapper: pasa por identidad')
  tabla.set([{ id: 7, nombre: 'a' }])
  assert.deepEqual(tabla.getSnapshot(), [{ id: 7, nombre: 'a' }])
  assert.equal(tabla.itemById(7).nombre, 'a')
  tabla.destroy()

  // Fuente de líneas: idem, `pathOf` no participa del override de posición.
  const soloLinea = { idOf, pathOf }
  const lineas = createSource(soloLinea)
  assert.equal(lineas.accessors, soloLinea)
  assert.equal(lineas.accessors.pathOf, pathOf)
  lineas.destroy()
})

test('patch itera dirtyIds sin guard: omitirlo es un TypeError', () => {
  const src = createSource({ idOf, positionOf })
  src.set([{ id: 1, lat: 0, lng: 0 }])
  assert.throws(() => src.patch([{ id: 1, lat: 1, lng: 1 }]), TypeError)
})

/* ── S3: types/core.d.ts describe otra cosa que el runtime ── */

// Miembros declarados en la interfaz CristaeSource del .d.ts (lectura, nunca escritura).
// El match se asevera: si el .d.ts cambia de forma, esto FALLA en vez de tirar TypeError adentro
// de un `todo` (que node computa como fail 0 y deja el error invisible).
const miembrosDeclarados = () => {
  const d = readFileSync(new URL('../types/core.d.ts', import.meta.url), 'utf8')
  const m = d.match(/interface CristaeSource<[^>]*>\s*\{([\s\S]*?)\n\}/)
  assert.ok(m, 'types/core.d.ts ya no declara `interface CristaeSource<…> { … }` con esta forma')
  const cuerpo = m[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  return [...cuerpo.matchAll(/^\s*(\w+)\s*[(:]/gm)].map(m => m[1]).sort()
}

// El parseo del .d.ts vive fuera de los `todo`: es lo que HOY pasa y debe tener red propia.
test('S3 — el .d.ts declara exactamente estos miembros en CristaeSource', () => {
  assert.deepEqual(miembrosDeclarados(), [
    'accessors', 'addFilter', 'destroy', 'getSnapshot', 'itemById', 'move',
    'patch', 'remove', 'removeFilter', 'set', 'subscribe',
  ])
})

// Aserto POSITIVO sobre el desajuste vigente: falla el día que el .d.ts se arregle (a diferencia
// del `todo` de abajo, que node reporta `ok # TODO` sin avisar que empezó a pasar).
test('S3 — createSource devuelve 4 miembros que el .d.ts NO declara (desajuste vigente)', () => {
  const declarados = new Set(miembrosDeclarados())
  const faltantes = miembros(createSource({ idOf, positionOf }, [])).filter(k => !declarados.has(k))
  assert.deepEqual(faltantes, ['dirtyIds', 'moveDirtyIds', 'variants', 'version'],
    'si el .d.ts se arregló: borrar este test y sacarle el `todo` a "S3 — el .d.ts declara los miembros…"')
})

test('S3 — el .d.ts declara los miembros que createSource devuelve de verdad',
  { todo: 'S3 — el tipo omite version/variants/dirtyIds/moveDirtyIds' }, () => {
    const declarados = new Set(miembrosDeclarados())
    assert.deepEqual(miembros(createSource({ idOf, positionOf }, [])).filter(k => !declarados.has(k)), [])
  })

// El aserto que HOY pasa (la ruta B no expone ninguno de los 7 métodos de dueño) ya tiene su test
// normal arriba: 'defineSource devuelve los 7 miembros de LECTURA y ninguno de dueño'.
test('S3 — defineSource devuelve los métodos de dueño que el .d.ts promete',
  { todo: 'S3 — el .d.ts la tipa como CristaeSource pero la ruta B es sólo lectura' }, () => {
    const src = defineSource(configB())
    for (const dueño of ['set', 'move', 'patch', 'remove', 'addFilter', 'removeFilter', 'destroy'])
      assert.equal(typeof src[dueño], 'function', `${dueño} declarado en CristaeSource`)
  })
