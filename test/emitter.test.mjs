// Contrato del Emitter (src/data/Emitter.js) — el coalescing del que depende "1 emit por frame".
// Congela: dirty-skip por versión, defer:'raf' (N notify → 1 emit), orden subscribers → onFlush,
// identidad referencial del snapshot ([0-alloc]), teardown completo de destroy() (frame + timer),
// aislamiento del reparto (un subscriber que lanza no se lleva al resto), modo throttled
// (manda el timer, notify() es no-op) y clamp del intervalo.
// Corre con: node --test test/emitter.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { Emitter } from '../src/data/Emitter.js'

// ── Utilidades de tiempo ──
// El módulo resuelve `raf` UNA vez al cargar: sin requestAnimationFrame global cae a setTimeout(cb,0).
// Por eso un solo turno de macrotask alcanza para vaciar el frame agendado (se verifica más abajo).
const tick = () => new Promise((r) => setTimeout(r, 0))
const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

// Timers vivos del proceso. Sirve de observable del teardown: el frame agendado y el setInterval
// son recursos, y "no emitir" no prueba que se hayan dado de baja. Se mide siempre por DELTA.
const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length

// ── Banco de pruebas ──
// Fuente controlable (versión + dato) + un difusor con un subscriber testigo.
// `mutar()` imita al productor: avanza versión y dato antes del notify().
// `est.versiones` cuenta las lecturas de version(): es el pulso del timer, y lo que debe
// congelarse cuando destroy() apaga el loop.
const banco = (opciones = {}) => {
  const est = { ver: 0, dato: 'd0', sources: 0, versiones: 0, recibido: [], flushes: 0, orden: [] }
  const e = new Emitter({
    source: () => { est.sources++; return est.dato },
    version: () => { est.versiones++; return est.ver },
    interval: 0,
    onFlush: () => { est.flushes++; est.orden.push('flush') },
    ...opciones,
  })
  e.subscribe('a', (d) => { est.recibido.push(d); est.orden.push('sub:a') })
  est.mutar = (dato) => { est.ver++; est.dato = dato ?? `d${est.ver}` }
  return { e, est }
}

/* ── Entorno: el fallback de rAF es setTimeout ── */

test('sin requestAnimationFrame global el frame se agenda con setTimeout (un tick lo vacía)', async () => {
  assert.equal(typeof globalThis.requestAnimationFrame, 'undefined')
  const { e, est } = banco({ defer: 'raf' })
  est.mutar()
  e.notify()
  assert.equal(est.recibido.length, 0)        // nada sincrónico: quedó agendado
  await tick()                                // un solo turno de macrotask
  assert.deepEqual(est.recibido, ['d1'])
})

/* ── Dirty-skip por versión ── */

// El tracker arranca en -1, así que la versión inicial (0) ya cuenta como cambio.
test('el primer check emite el estado inicial aunque nadie haya mutado', () => {
  const { e, est } = banco()
  e.notify()
  assert.deepEqual(est.recibido, ['d0'])
  assert.equal(est.sources, 1)
  assert.equal(est.flushes, 1)
})

test('tras la primera emisión, sin cambio de versión no hay emisión ni lectura de la fuente', () => {
  const { e, est } = banco()
  e.notify()                                  // consume la emisión inicial
  e.notify(); e.notify(); e.notify()
  assert.equal(est.recibido.length, 1)
  assert.equal(est.sources, 1)                // ni siquiera se relee el snapshot
  assert.equal(est.flushes, 1)
})

test('la emisión entrega el snapshot que devolvió source() en ese check', () => {
  const { e, est } = banco()
  est.mutar('uno'); e.notify()
  est.mutar('dos'); e.notify()
  assert.deepEqual(est.recibido, ['uno', 'dos'])
  assert.equal(est.sources, 2)
  e.notify()                                  // versión intacta → no repite
  assert.deepEqual(est.recibido, ['uno', 'dos'])
})

test('sync() adopta la versión vigente sin emitir', () => {
  const { e, est } = banco()
  est.mutar()
  e.sync()
  e.notify()
  assert.equal(est.recibido.length, 0)        // el cambio quedó absorbido
  est.mutar()
  e.notify()
  assert.deepEqual(est.recibido, ['d2'])      // el siguiente cambio sí emite
})

/* ── Identidad del snapshot ([0-alloc]) ── */

// El contrato de la lib es que la MISMA Source alimenta mapa + tabla sin copiar: el dato viaja por
// REFERENCIA de punta a punta. Con snapshots string (el resto de la suite) un clon pasa inadvertido.
test('el dato viaja por referencia: ni el check ni el getter snapshot clonan lo que devolvió source()', async (t) => {
  const dato = { puntos: [1, 2, 3] }
  const recibido = []
  let ver = 0
  const directo = new Emitter({ source: () => dato, version: () => ver, interval: 0, defer: 'none' })
  const diferido = new Emitter({ source: () => dato, version: () => ver, interval: 0, defer: 'raf' })
  t.after(() => { directo.destroy(); diferido.destroy() })
  directo.subscribe('a', (d) => recibido.push(d))
  diferido.subscribe('a', (d) => recibido.push(d))

  ver++
  directo.notify()
  assert.equal(recibido[0], dato, 'el subscriber recibe la MISMA referencia que devolvió source()')
  assert.equal(directo.snapshot, dato, 'el getter snapshot no copia')

  diferido.notify()
  assert.equal(diferido.snapshot, dato, 'el camino diferido tampoco copia al adelantar el snapshot')
  await tick()
  assert.equal(recibido[1], dato, 'la emisión del frame entrega la misma referencia')
})

/* ── Coalescing con defer:'raf' ── */

test('defer:"raf" coalesce N notify del mismo turno en UN emit con el último dato', async () => {
  const { e, est } = banco({ defer: 'raf' })
  for (let i = 0; i < 5; i++) { est.mutar(); e.notify() }
  assert.equal(est.recibido.length, 0)
  assert.equal(est.sources, 5)                // el snapshot se recomputa en cada check…
  await tick()
  assert.deepEqual(est.recibido, ['d5'])      // …pero se emite una sola vez, el último
  assert.equal(est.flushes, 1)
})

// El guard del frame agendado no se ve en las emisiones (el pending sirve de segunda red):
// se mide sobre los timers vivos, que es lo que el coalescing existe para no multiplicar.
test('defer:"raf" agenda UN solo frame para N notify, no N', async () => {
  const { e, est } = banco({ defer: 'raf' })
  const antes = timers()
  for (let i = 0; i < 6; i++) { est.mutar(); e.notify() }
  assert.equal(timers() - antes, 1, 'los notify del mismo turno comparten el frame')
  await tick()
  assert.equal(est.recibido.length, 1)
})

test('defer:"raf" emite una vez por frame, no una sola vez para siempre', async () => {
  const { e, est } = banco({ defer: 'raf' })
  est.mutar(); e.notify()
  await tick()
  est.mutar(); e.notify()
  await tick()
  assert.deepEqual(est.recibido, ['d1', 'd2'])
  assert.equal(est.flushes, 2)
})

test('barrido: raf coalesce a 1 emit y el modo directo emite N, para N = 1..8', async () => {
  for (let n = 1; n <= 8; n++) {
    const conRaf = banco({ defer: 'raf' })
    const directo = banco({ defer: 'none' })
    for (let i = 0; i < n; i++) {
      conRaf.est.mutar(); conRaf.e.notify()
      directo.est.mutar(); directo.e.notify()
    }
    await tick()
    assert.deepEqual(conRaf.est.recibido, [`d${n}`], `raf con n=${n}`)
    assert.equal(directo.est.recibido.length, n, `directo con n=${n}`)
  }
})

test('defer:"raf" adelanta el snapshot al check, aunque la emisión quede para el frame', async () => {
  const { e, est } = banco({ defer: 'raf' })
  est.mutar('fresco'); e.notify()
  assert.equal(e.snapshot, 'fresco')          // visible antes de emitir
  assert.equal(est.recibido.length, 0)
  await tick()
  assert.deepEqual(est.recibido, ['fresco'])
})

// snapshot lee el ÚLTIMO dato chequeado, no el que quedó agendado: son dos ranuras distintas y no
// deben conflacionarse al agrupar el estado interno.
test('snapshot es el último dato chequeado, no el que quedó agendado para el frame', async () => {
  const { e, est } = banco({ defer: 'raf' })
  est.mutar('agendado'); e.notify()           // queda para el frame
  e.defer = 'none'
  est.mutar('directo'); e.notify()            // emite ya, en el mismo turno
  assert.equal(e.snapshot, 'directo')
  assert.deepEqual(est.recibido, ['directo'])
  await tick()
  assert.deepEqual(est.recibido, ['directo', 'agendado'])  // el frame agendado igual entrega lo suyo
})

// El guard `next != null` del frame conflaciona "no hay nada agendado" con "el dato es null":
// en modo diferido la emisión se pierde entera, en modo directo el mismo null sí se emite.
// Asimetría congelada tal cual está hoy — BUG-EMITTER-NULL-RAF.
test('BUG-EMITTER-NULL-RAF: con snapshot null el modo directo emite y defer:"raf" se traga la emisión', async (t) => {
  const rec = { directo: [], diferido: [], flushDirecto: 0, flushDiferido: 0 }
  let ver = 0
  const directo = new Emitter({
    source: () => null, version: () => ver, interval: 0, defer: 'none',
    onFlush: () => { rec.flushDirecto++ },
  })
  const diferido = new Emitter({
    source: () => null, version: () => ver, interval: 0, defer: 'raf',
    onFlush: () => { rec.flushDiferido++ },
  })
  t.after(() => { directo.destroy(); diferido.destroy() })
  directo.subscribe('a', (d) => rec.directo.push(d))
  diferido.subscribe('a', (d) => rec.diferido.push(d))

  ver++
  directo.notify()
  diferido.notify()
  await tick()
  assert.deepEqual(rec.directo, [null], 'directo: el null es un dato y se emite')
  assert.equal(rec.flushDirecto, 1)
  assert.equal(rec.diferido.length, 0, 'diferido: el guard del frame se lo come')
  assert.equal(rec.flushDiferido, 0)
})

/* ── Orden de la emisión ── */

test('onFlush corre después de todos los subscribers', async () => {
  const { e, est } = banco({ defer: 'raf' })
  e.subscribe('b', () => est.orden.push('sub:b'))
  est.mutar(); e.notify()
  await tick()
  assert.deepEqual(est.orden, ['sub:a', 'sub:b', 'flush'])
})

test('onFlush corre aunque no quede ningún subscriber', () => {
  const { e, est } = banco()
  assert.equal(e.unsubscribe('a'), e)          // encadenable
  est.mutar(); e.notify()
  assert.equal(est.recibido.length, 0)
  assert.equal(est.flushes, 1)
})

test('subscribe con un id ya usado reemplaza el callback en vez de sumar otro', () => {
  const { e, est } = banco()
  assert.equal(e.subscribe('a', () => est.orden.push('sub:a2')), e)  // encadenable
  est.mutar(); e.notify()
  assert.deepEqual(est.orden, ['sub:a2', 'flush'])
  assert.equal(est.recibido.length, 0)         // el callback original quedó fuera
})

// Caso que motiva el test: un subscriber que se da de baja a otro en pleno reparto.
test('desuscribirse dentro del emit saca al que todavía no fue llamado', () => {
  const { e, est } = banco()
  e.unsubscribe('a')
  e.subscribe('x', () => { est.orden.push('sub:x'); e.unsubscribe('y') })
  e.subscribe('y', () => est.orden.push('sub:y'))
  est.mutar(); e.notify()
  assert.deepEqual(est.orden, ['sub:x', 'flush'])
  est.mutar(); e.notify()
  assert.deepEqual(est.orden, ['sub:x', 'flush', 'sub:x', 'flush'])
})

test('notify() dentro del emit con defer:"raf" agenda el frame siguiente, no reentra', async () => {
  const { e, est } = banco({ defer: 'raf' })
  let reenvio = false
  e.subscribe('b', () => {
    if (reenvio) return
    reenvio = true
    est.mutar(); e.notify()
    assert.deepEqual(est.recibido, ['d1'])     // todavía no llegó el segundo
  })
  est.mutar(); e.notify()
  await tick()
  assert.deepEqual(est.recibido, ['d1'])
  await tick()
  assert.deepEqual(est.recibido, ['d1', 'd2'])
})

test('notify() dentro del emit en modo directo reentra en el mismo turno', () => {
  const { e, est } = banco({ defer: 'none' })
  let reenvio = false
  e.subscribe('b', () => {
    if (reenvio) return
    reenvio = true
    est.mutar(); e.notify()
  })
  est.mutar(); e.notify()
  assert.deepEqual(est.recibido, ['d1', 'd2'])
  // la emisión anidada termina antes que la externa: su flush llega primero
  assert.deepEqual(est.orden, ['sub:a', 'sub:a', 'flush', 'flush'])
})

// Cada emisión reparte SU dato: el reparto en curso no adopta el snapshot que dejó la reentrada.
// Con el reentrante en el medio, el subscriber posterior es el testigo.
test('el emit en curso sigue repartiendo SU dato a los subscribers posteriores al que reentra', () => {
  const { e, est } = banco({ defer: 'none' })
  let reenvio = false
  e.subscribe('b', () => {
    if (reenvio) return
    reenvio = true
    est.mutar(); e.notify()
  })
  e.subscribe('c', (d) => est.recibido.push(`c:${d}`))
  est.mutar(); e.notify()
  assert.deepEqual(est.recibido, ['d1', 'd2', 'c:d2', 'c:d1'])
})

/* ── Aislamiento del reparto ── */

// Cada subscriber corre aislado (safe + onError de módulo): el que lanza no se lleva a los que
// vienen detrás ni al onFlush, y notify() no propaga. El error se REPORTA por console.error —
// mismo canal que Store.notifyChanges — para que un consumidor roto no quede en silencio.
const espiarConsola = (t) => {
  const errores = []
  const original = console.error
  console.error = (...a) => errores.push(a)
  t.after(() => { console.error = original })
  return errores
}

test('un subscriber que lanza no corta el reparto ni se come el onFlush', (t) => {
  const errores = espiarConsola(t)
  const { e, est } = banco({ defer: 'none' })
  e.subscribe('b', () => { throw new Error('boom') })
  e.subscribe('c', () => est.orden.push('sub:c'))
  est.mutar()

  assert.doesNotThrow(() => e.notify())
  assert.deepEqual(est.orden, ['sub:a', 'sub:c', 'flush'])
  assert.equal(est.flushes, 1)
  assert.equal(errores.length, 1, 'el error se reporta, no se traga')
  assert.match(String(errores[0].at(-1)), /boom/)
})

// El aislamiento no resucita la emisión: la versión ya fue consumida por el check.
test('el subscriber que lanza pierde SU dato: la emisión no se reintenta', (t) => {
  espiarConsola(t)
  const { e, est } = banco({ defer: 'none' })
  const vistos = []
  e.subscribe('b', (d) => { if (d === 'd1') throw new Error('boom'); vistos.push(d) })
  est.mutar(); e.notify()
  assert.deepEqual(vistos, [])

  e.notify()                                   // versión intacta → dirty-skip, sin reintento
  assert.deepEqual(vistos, [])
  est.mutar(); e.notify()                      // recién el cambio siguiente le llega
  assert.deepEqual(vistos, ['d2'])
})

// En modo diferido el reparto corre dentro del frame: sin aislamiento la excepción no tiene a
// quién escapar y se vuelve un error no capturado del turno.
test('con defer:"raf" un subscriber que lanza tampoco rompe el frame', async (t) => {
  const errores = espiarConsola(t)
  const { e, est } = banco({ defer: 'raf' })
  e.subscribe('b', () => { throw new Error('boom') })
  e.subscribe('c', () => est.orden.push('sub:c'))
  est.mutar(); e.notify()
  await tick()

  assert.deepEqual(est.orden, ['sub:a', 'sub:c', 'flush'])
  assert.equal(errores.length, 1)
})

/* ── destroy() ── */

// "No emite" lo garantiza el #subs.clear(); que el frame se CANCELE hay que medirlo sobre el recurso.
test('destroy() cancela el frame agendado (da de baja el timer del frame) y no emite', async () => {
  const { e, est } = banco({ defer: 'raf' })
  const antes = timers()
  est.mutar(); e.notify()
  assert.equal(timers() - antes, 1, 'el frame quedó agendado')
  e.destroy()
  assert.equal(timers() - antes, 0, 'destroy() dio de baja el frame agendado')
  await tick()
  assert.equal(est.recibido.length, 0)
  assert.equal(est.flushes, 0)
  assert.equal(e.snapshot, null)               // suelta el último dato
})

// El silencio post-destroy ya lo daría el #subs.clear(): el observable del clearInterval es que el
// loop deje de PULSAR la fuente (version() ya no se llama más).
test('destroy() apaga el loop del modo throttled: la fuente deja de ser consultada', async (t) => {
  const { e, est } = banco({ interval: 10 })
  t.after(() => e.destroy())                   // red: si un aserto falla antes, el timer no queda vivo
  est.mutar()
  await esperar(60)
  assert.deepEqual(est.recibido, ['d1'])       // el timer emitió exactamente una vez (dirty-skip)
  const versionesAntes = est.versiones
  assert.ok(versionesAntes > 0, 'el timer estuvo pulsando antes del destroy')
  e.destroy()
  est.mutar()
  await esperar(60)
  assert.equal(est.versiones, versionesAntes, 'el loop no volvió a consultar version()')
  assert.equal(est.sources, 1)
  assert.deepEqual(est.recibido, ['d1'])
})

test('destroy() deja al difusor mudo para los notify posteriores', () => {
  const { e, est } = banco()
  e.destroy()
  est.mutar(); e.notify()
  assert.equal(est.recibido.length, 0)         // #subs quedó vacío
})

// El aserto del bug, aislado: hoy el check post-destroy sigue corriendo y dispara onFlush.
test('tras destroy() el emitter queda inerte: notify() no emite ni dispara onFlush', () => {
  const { e, est } = banco()
  e.destroy()
  est.mutar(); e.notify()
  assert.equal(est.flushes, 0)
})

test('destroy() es idempotente y conserva la configuración del difusor', async () => {
  const { e, est } = banco({ interval: 10, defer: 'raf' })
  e.destroy()
  e.destroy()                                  // segunda pasada: sin excepción ni efectos
  assert.equal(e.interval, 10)
  assert.equal(e.defer, 'raf')
  assert.equal(e.reactive, false)
  assert.equal(e.snapshot, null)
  est.mutar(); e.notify()                      // en throttled notify() sigue siendo no-op
  assert.equal(est.sources, 0)
  await esperar(40)
  assert.equal(est.recibido.length, 0)
})

/* ── Modo throttled (interval > 0) ── */

test('con interval > 0 emite por timer y notify() es no-op', async (t) => {
  const { e, est } = banco({ interval: 10 })
  t.after(() => e.destroy())
  assert.equal(e.reactive, false)
  est.mutar('porTimer')
  e.notify(); e.notify()
  assert.equal(est.recibido.length, 0)         // el tunnel reactivo está apagado
  assert.equal(est.sources, 0)
  await esperar(60)
  assert.deepEqual(est.recibido, ['porTimer']) // una emisión por cambio de versión, no una por tick
  assert.equal(est.sources, 1)
})

test('el timer respeta el dirty-skip: sin cambios emite sólo el estado inicial', async (t) => {
  const { e, est } = banco({ interval: 10 })
  t.after(() => e.destroy())
  await esperar(60)                            // muchos ticks del timer, una sola emisión
  assert.deepEqual(est.recibido, ['d0'])
  assert.equal(est.sources, 1)
  assert.ok(est.versiones > 1, 'el timer sí siguió pulsando la versión')
})

test('pasar el intervalo a 0 enciende el tunnel reactivo y apaga el timer', async (t) => {
  const { e, est } = banco({ interval: 10 })
  t.after(() => e.destroy())
  e.interval = 0
  assert.equal(e.reactive, true)
  est.mutar(); e.notify()
  assert.deepEqual(est.recibido, ['d1'])       // ahora manda el productor
  est.mutar()
  await esperar(60)
  assert.deepEqual(est.recibido, ['d1'])       // y el timer ya no corre
})

/* ── Clamp del intervalo ── */

test('clamp: el intervalo cae en [0, maxInterval] y lo no numérico vale 0', (t) => {
  const casos = [
    { opciones: {}, esperado: 100 },                                  // default
    { opciones: { interval: 250 }, esperado: 250 },
    { opciones: { interval: 5000, maxInterval: 250 }, esperado: 250 },
    { opciones: { interval: 250, maxInterval: 5000 }, esperado: 250 },
    { opciones: { interval: -5 }, esperado: 0 },
    { opciones: { interval: NaN }, esperado: 0 },
    { opciones: { interval: '80' }, esperado: 80 },                   // coerción numérica
    { opciones: { interval: 0, maxInterval: 250 }, esperado: 0 },
  ]
  for (const { opciones, esperado } of casos) {
    const e = new Emitter({ source: () => null, version: () => 0, ...opciones })
    t.after(() => e.destroy())
    assert.equal(e.interval, esperado, `interval=${String(opciones.interval)} max=${String(opciones.maxInterval)}`)
  }
})

test('el setter de interval aplica el mismo clamp que el constructor', (t) => {
  const e = new Emitter({ source: () => null, version: () => 0, interval: 10, maxInterval: 250 })
  t.after(() => e.destroy())
  e.interval = 5000
  assert.equal(e.interval, 250)
  e.interval = -1
  assert.equal(e.interval, 0)
  assert.equal(e.reactive, true)
})

test('defer es lectura/escritura y cambia el modo de emisión en caliente', async () => {
  const { e, est } = banco({ defer: 'none' })
  assert.equal(e.defer, 'none')
  est.mutar(); e.notify()
  assert.deepEqual(est.recibido, ['d1'])       // directo
  e.defer = 'raf'
  assert.equal(e.defer, 'raf')
  est.mutar(); e.notify()
  assert.deepEqual(est.recibido, ['d1'])       // ahora queda para el frame
  await tick()
  assert.deepEqual(est.recibido, ['d1', 'd2'])
})
