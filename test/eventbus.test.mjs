// Contrato del EventBus (src/events/EventBus.js) — el ruteo de hits del mapa.
// Congela tres cosas que el resto del motor da por hechas: (a) los dos libros de demanda
// (global y por capa) que deciden qué canales se pickean, con baja idempotente;
// (b) el diffing de hover, que deriva start/end por una clave estable de elemento;
// (c) el filtro por capa del despacho. Todo sincrónico, sin DOM.
// Corre con: node --test test/eventbus.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventBus } from '../src/events/EventBus.js'

// Bits de canal como LITERALES a propósito: importarlos de src/events/events.js haría que
// estos asertos se auto-cumplan si los bits cambian (el esperado se movería con el mutante).
// El contrato de los números en sí vive en events-mask.test.mjs; acá son valores fijos.
const BIT_CLICK = 1
const BIT_HOVER = 2
const BIT_SECONDARY = 4

// ── Banco de pruebas ──
// Bus + libreta de lo que recibió onDemandChange (null = cambió la demanda global).
const banco = () => {
  const avisos = []
  return { bus: new EventBus((layerId) => avisos.push(layerId)), avisos }
}

// Handler testigo: guarda hits y baseEvent de cada invocación.
const testigo = () => {
  const llamadas = []
  const fn = (hits, baseEvent) => llamadas.push({ hits, baseEvent })
  fn.llamadas = llamadas
  fn.ids = () => llamadas.map(({ hits }) => hits.map((h) => h.id))
  return fn
}

// Hit tal como lo entrega el resolver del registro de capas.
const hit = (layerId, id) => ({ layerId, id })
const tick = () => new Promise((r) => setTimeout(r, 0))

/* ── (a) Demand-counting ── */

test('la máscara de una capa acumula un bit por canal suscrito y vuelve a 0 al darlos de baja', () => {
  const { bus } = banco()
  assert.equal(bus.demandMaskFor('L'), 0)
  const bajaClick = bus.on('click', 'L', testigo())
  assert.equal(bus.demandMaskFor('L'), BIT_CLICK)
  const bajaHover = bus.on('hover', 'L', testigo())
  assert.equal(bus.demandMaskFor('L'), BIT_CLICK | BIT_HOVER)
  const bajaSec = bus.on('secondary-click', 'L', testigo())
  assert.equal(bus.demandMaskFor('L'), BIT_CLICK | BIT_HOVER | BIT_SECONDARY)
  bajaClick()
  assert.equal(bus.demandMaskFor('L'), BIT_HOVER | BIT_SECONDARY)
  bajaHover()
  assert.equal(bus.demandMaskFor('L'), BIT_SECONDARY)
  bajaSec()
  assert.equal(bus.demandMaskFor('L'), 0)
})

test('los tres sabores de hover comparten el bit: el canal cae recién con la última baja', () => {
  const { bus } = banco()
  const bajas = ['hover', 'hover:start', 'hover:end'].map((tipo) => bus.on(tipo, 'L', testigo()))
  assert.equal(bus.demandMaskFor('L'), BIT_HOVER)
  bajas[0]()
  assert.equal(bus.demandMaskFor('L'), BIT_HOVER)
  bajas[1]()
  assert.equal(bus.demandMaskFor('L'), BIT_HOVER)
  bajas[2]()
  assert.equal(bus.demandMaskFor('L'), 0)
})

test('la demanda global vale para cualquier capa, incluso una que nunca se suscribió', () => {
  const { bus } = banco()
  bus.on('click', testigo())
  assert.equal(bus.demandMaskFor('L1'), BIT_CLICK)
  assert.equal(bus.demandMaskFor('otra-cualquiera'), BIT_CLICK)
  assert.equal(bus.demandMaskFor(undefined), BIT_CLICK)
})

test('la demanda global y la de capa se combinan con OR', () => {
  const { bus } = banco()
  bus.on('hover', testigo())
  bus.on('click', 'L1', testigo())
  assert.equal(bus.demandMaskFor('L1'), BIT_HOVER | BIT_CLICK)
  assert.equal(bus.demandMaskFor('L2'), BIT_HOVER)
})

// Caso que motiva el test: un consumidor que llama a su unsub en cleanup y otra vez al destruirse
// no puede llevarse por delante la demanda de OTRO handler del mismo canal y capa.
test('el unsub es idempotente: repetirlo no descuenta la demanda de otro handler', () => {
  const { bus, avisos } = banco()
  const baja1 = bus.on('click', 'L', testigo())
  bus.on('click', 'L', testigo())
  baja1()
  assert.equal(bus.demandMaskFor('L'), BIT_CLICK)
  baja1(); baja1(); baja1()
  assert.equal(bus.demandMaskFor('L'), BIT_CLICK, 'el segundo handler sigue sosteniendo el canal')
  assert.deepEqual(avisos, ['L', 'L', 'L'], 'la baja repetida tampoco vuelve a avisar')
})

test('un tipo de evento sin canal no genera demanda ni avisa al motor', () => {
  const { bus, avisos } = banco()
  bus.on('pointer:move', 'L', testigo())
  bus.on('hover:out', 'L', testigo())
  bus.on('inventado', 'L', testigo())
  bus.on('pointer:move', testigo())
  assert.equal(bus.demandMaskFor('L'), 0)
  assert.deepEqual(avisos, [])
})

test('onDemandChange recibe null en los handlers globales y el layerId en los filtrados', () => {
  const { bus, avisos } = banco()
  bus.on('click', testigo())
  assert.deepEqual(avisos, [null])
  bus.on('hover', 'L1', testigo())
  assert.deepEqual(avisos, [null, 'L1'])
  const baja = bus.on('click', ['L1', 'L2'], testigo())   // un aviso por capa de la suscripción
  assert.deepEqual(avisos, [null, 'L1', 'L1', 'L2'])
  baja()
  assert.deepEqual(avisos, [null, 'L1', 'L1', 'L2', 'L1', 'L2'], 'la baja avisa las mismas capas')
})

// Caso que motiva el test: el consumidor real (el motor) lee demandMaskFor DENTRO del aviso
// para recalcular la máscara de picking de la capa. Si el aviso saliera ANTES de aplicar el
// conteo, leería la máscara vieja y el picking quedaría un alta/baja atrasado.
test('onDemandChange avisa DESPUÉS de aplicar el conteo: la máscara leída en el aviso ya es la nueva', () => {
  const vistas = []
  let bus = null
  bus = new EventBus((layerId) => vistas.push([layerId, bus.demandMaskFor(layerId ?? 'L')]))

  const bajaGlobal = bus.on('hover', testigo())
  assert.deepEqual(vistas.at(-1), [null, BIT_HOVER], 'el aviso global ya ve el canal recién dado de alta')
  const bajaCapa = bus.on('click', 'L', testigo())
  assert.deepEqual(vistas.at(-1), ['L', BIT_HOVER | BIT_CLICK], 'el aviso de capa ya ve su canal')
  bajaCapa()
  assert.deepEqual(vistas.at(-1), ['L', BIT_HOVER], 'y en la baja el canal ya está descontado')
  bajaGlobal()
  assert.deepEqual(vistas.at(-1), [null, 0], 'lo mismo en la baja global')
})

test('las capas repetidas o nulas de la suscripción se colapsan en una sola', () => {
  const { bus, avisos } = banco()
  const baja = bus.on('click', ['L', 'L', null, undefined], testigo())
  assert.deepEqual(avisos, ['L'])
  assert.equal(bus.demandMaskFor('L'), BIT_CLICK)
  baja()
  assert.deepEqual(avisos, ['L', 'L'])
  assert.equal(bus.demandMaskFor('L'), 0, 'una sola alta ⇒ una sola baja lo apaga')
})

test('una lista de capas vacía no crea demanda en ninguna capa', () => {
  const { bus, avisos } = banco()
  bus.on('click', [], testigo())
  assert.deepEqual(avisos, [])
  assert.equal(bus.demandMaskFor('L'), 0)
})

// Lo que este test observa es que al llegar a 0 no queda RESIDUO DEL CANAL viejo: la
// re-suscripción reconstruye la máscara desde cero. (Que además se borre la entrada de la
// capa del libro interno —el Map vacío colgado— no es observable desde la API pública.)
test('al llegar a 0 la capa queda limpia y una re-suscripción reconstruye la máscara desde cero', () => {
  const { bus } = banco()
  const baja = bus.on('click', 'L', testigo())
  baja()
  assert.equal(bus.demandMaskFor('L'), 0)
  bus.on('hover', 'L', testigo())
  assert.equal(bus.demandMaskFor('L'), BIT_HOVER, 'sin residuo del click dado de baja')
})

/* ── (b) Diffing de hover ── */

test('el primer frame emite el estado y abre hover:start de cada elemento', () => {
  const { bus } = banco()
  const estado = testigo(); const start = testigo(); const end = testigo()
  bus.on('hover', estado); bus.on('hover:start', start); bus.on('hover:end', end)
  bus.dispatch('hover', [hit('L', 1), hit('L', 2)], null)
  assert.deepEqual(estado.ids(), [[1, 2]])
  assert.deepEqual(start.ids(), [[1, 2]])
  assert.deepEqual(end.ids(), [])
})

// Caso que motiva el test: el consumidor pinta el estado (foto del frame) y después reacciona
// a los deltas. El estado va PRIMERO y, entre los deltas, start precede a end.
test('en un mismo frame el orden de emisión es estado → hover:start → hover:end', () => {
  const { bus } = banco()
  const orden = []
  bus.on('hover', () => orden.push('estado'))
  bus.on('hover:start', () => orden.push('start'))
  bus.on('hover:end', () => orden.push('end'))
  bus.dispatch('hover', [hit('L', 1)], null)
  assert.deepEqual(orden, ['estado', 'start'], 'primer frame: no hay nada que cerrar')
  orden.length = 0
  bus.dispatch('hover', [hit('L', 2)], null)   // entra el 2, sale el 1: los tres canales en un frame
  assert.deepEqual(orden, ['estado', 'start', 'end'])
})

test('el elemento que sigue presente entre frames no vuelve a abrir start', () => {
  const { bus } = banco()
  const start = testigo(); const end = testigo()
  bus.on('hover:start', start); bus.on('hover:end', end)
  bus.dispatch('hover', [hit('L', 1)], null)
  bus.dispatch('hover', [hit('L', 1), hit('L', 2)], null)   // hits nuevos, misma identidad
  assert.deepEqual(start.ids(), [[1], [2]])
  assert.deepEqual(end.ids(), [])
})

test('el elemento que desaparece del frame cierra con hover:end', () => {
  const { bus } = banco()
  const start = testigo(); const end = testigo()
  bus.on('hover:start', start); bus.on('hover:end', end)
  bus.dispatch('hover', [hit('L', 1), hit('L', 2)], null)
  bus.dispatch('hover', [hit('L', 2), hit('L', 3)], null)
  assert.deepEqual(start.ids(), [[1, 2], [3]])
  assert.deepEqual(end.ids(), [[1]])
})

test('un frame sin hits no emite el estado pero cierra todo lo que estaba abierto', () => {
  const { bus } = banco()
  const estado = testigo(); const end = testigo()
  bus.on('hover', estado); bus.on('hover:end', end)
  bus.dispatch('hover', [hit('L', 1)], null)
  bus.dispatch('hover', [], null)
  assert.deepEqual(estado.ids(), [[1]], 'el frame vacío no despacha estado')
  assert.deepEqual(end.ids(), [[1]])
})

// Sin id del resolver, la identidad sale del ref: el mismo objeto en dos frames es el mismo elemento.
test('sin id, el mismo ref entre frames no re-dispara start', () => {
  const { bus } = banco()
  const start = testigo(); const end = testigo()
  bus.on('hover:start', start); bus.on('hover:end', end)
  const ref = { nombre: 'punto' }
  bus.dispatch('hover', [{ layerId: 'L', ref }], null)
  bus.dispatch('hover', [{ layerId: 'L', ref }], null)     // otro hit, mismo ref
  assert.equal(start.llamadas.length, 1)
  assert.equal(end.llamadas.length, 0)
})

test('sin id, dos refs distintos con la misma forma son elementos distintos', () => {
  const { bus } = banco()
  const start = testigo(); const end = testigo()
  bus.on('hover:start', start); bus.on('hover:end', end)
  bus.dispatch('hover', [{ layerId: 'L', ref: { nombre: 'punto' } }], null)
  bus.dispatch('hover', [{ layerId: 'L', ref: { nombre: 'punto' } }], null)
  assert.equal(start.llamadas.length, 2, 'el ref nuevo abre otro hover')
  assert.equal(end.llamadas.length, 1, 'y el anterior se cierra')
})

// Caso que motiva el test: el guard de identidad es `hit.id != null` — un id NULO no
// identifica, cae al ref. Si el guard mirara sólo undefined, los dos hits de abajo
// colapsarían en la clave 'L#null' y serían un solo elemento.
test('un id null no identifica: dos hits sin id del mismo frame se distinguen por su ref', () => {
  const { bus } = banco()
  const start = testigo()
  bus.on('hover:start', start)
  bus.dispatch('hover', [
    { layerId: 'L', id: null, ref: { n: 'a' } },
    { layerId: 'L', id: null, ref: { n: 'b' } },
  ], null)
  assert.equal(start.llamadas[0].hits.length, 2, 'son dos elementos, no uno')
})

test('un ref primitivo identifica por valor entre frames', () => {
  const { bus } = banco()
  const start = testigo()
  bus.on('hover:start', start)
  bus.dispatch('hover', [{ layerId: 'L', ref: 'a' }], null)
  bus.dispatch('hover', [{ layerId: 'L', ref: 'a' }], null)
  assert.equal(start.llamadas.length, 1)
  bus.dispatch('hover', [{ layerId: 'L', ref: 'b' }], null)
  assert.equal(start.llamadas.length, 2)
})

test('el mismo id en capas distintas son dos elementos independientes', () => {
  const { bus } = banco()
  const start = testigo(); const end = testigo()
  bus.on('hover:start', start); bus.on('hover:end', end)
  bus.dispatch('hover', [hit('L1', 7), hit('L2', 7)], null)
  assert.equal(start.llamadas[0].hits.length, 2)
  bus.dispatch('hover', [hit('L2', 7)], null)
  assert.deepEqual(end.llamadas[0].hits.map((h) => h.layerId), ['L1'])
})

test('los hits duplicados de un mismo frame colapsan en una entrada y gana el último', () => {
  const { bus } = banco()
  const start = testigo()
  bus.on('hover:start', start)
  const primero = { layerId: 'L', id: 1, orden: 'primero' }
  const ultimo = { layerId: 'L', id: 1, orden: 'ultimo' }
  bus.dispatch('hover', [primero, ultimo], null)
  assert.equal(start.llamadas.length, 1)
  assert.deepEqual(start.llamadas[0].hits, [ultimo])
})

test('los tres canales de hover viajan con el baseEvent del despacho', () => {
  const { bus } = banco()
  const estado = testigo(); const start = testigo(); const end = testigo()
  bus.on('hover', estado); bus.on('hover:start', start); bus.on('hover:end', end)
  const ev1 = { tag: 'ev1' }; const ev2 = { tag: 'ev2' }
  bus.dispatch('hover', [hit('L', 1)], ev1)
  bus.dispatch('hover', [], ev2)
  assert.equal(estado.llamadas[0].baseEvent, ev1, 'el estado también lo lleva, no null')
  assert.equal(start.llamadas[0].baseEvent, ev1)
  assert.equal(end.llamadas[0].baseEvent, ev2)
})

// Caso que motiva el test: una capa que se oculta o se remueve deja de ser resoluble; sin este
// cierre forzado el estado de hover de sus elementos sobreviviría a la capa.
test('clearLayer cierra sólo el hover de esa capa, con baseEvent nulo', () => {
  const { bus } = banco()
  const end = testigo(); const start = testigo()
  bus.on('hover:end', end); bus.on('hover:start', start)
  bus.dispatch('hover', [hit('L1', 1), hit('L2', 2)], { tag: 'ev' })
  bus.clearLayer('L1')
  assert.deepEqual(end.ids(), [[1]])
  assert.equal(end.llamadas[0].baseEvent, null)
  bus.dispatch('hover', [hit('L2', 2)], null)
  assert.equal(start.llamadas.length, 1, 'el hover vivo de la otra capa no se reabre')
})

test('clearLayer de una capa sin hover abierto no emite nada', () => {
  const { bus } = banco()
  const end = testigo()
  bus.on('hover:end', end)
  bus.clearLayer('L1')
  bus.dispatch('hover', [hit('L1', 1)], null)
  bus.clearLayer('L2')
  assert.equal(end.llamadas.length, 0)
})

test('tras clearLayer la capa arranca de cero: el mismo elemento vuelve a abrir start', () => {
  const { bus } = banco()
  const start = testigo()
  bus.on('hover:start', start)
  bus.dispatch('hover', [hit('L', 1)], null)
  bus.clearLayer('L')
  bus.dispatch('hover', [hit('L', 1)], null)
  assert.deepEqual(start.ids(), [[1], [1]])
})

test('hover:out cierra todo lo abierto de una vez y no repite si ya no queda nada', () => {
  const { bus } = banco()
  const end = testigo()
  bus.on('hover:end', end)
  bus.dispatch('hover', [hit('L1', 1), hit('L2', 2)], null)
  bus.dispatch('hover:out', null, { tag: 'salida' })
  assert.deepEqual(end.ids(), [[1, 2]])
  assert.equal(end.llamadas[0].baseEvent.tag, 'salida')
  bus.dispatch('hover:out', null, null)
  assert.equal(end.llamadas.length, 1, 'sin hover abierto no hay segundo cierre')
})

/* ── (c) Ruteo por capa ── */

test('un handler filtrado recibe sólo los hits de sus capas', () => {
  const { bus } = banco()
  const cb = testigo()
  bus.on('click', ['L1', 'L3'], cb)
  bus.dispatch('click', [hit('L1', 1), hit('L2', 2), hit('L3', 3)], null)
  assert.deepEqual(cb.ids(), [[1, 3]])
})

// Caso que motiva el test: el ruteo mira EXCLUSIVAMENTE hit.layerId. Un id de elemento que
// coincide con el nombre de una capa no puede colar el hit en un handler de esa capa.
test('el filtro por capa mira sólo hit.layerId, nunca hit.id', () => {
  const { bus } = banco()
  const cb = testigo()
  bus.on('click', 'L1', cb)
  bus.dispatch('click', [{ layerId: 'L2', id: 'L1' }], null)
  assert.equal(cb.llamadas.length, 0)
})

test('un handler filtrado no se invoca si ningún hit es de sus capas', () => {
  const { bus } = banco()
  const cb = testigo()
  bus.on('click', 'L1', cb)
  bus.dispatch('click', [hit('L2', 2)], null)
  assert.equal(cb.llamadas.length, 0)
})

test('un handler global recibe el despacho completo, sin filtrar', () => {
  const { bus } = banco()
  const cb = testigo()
  bus.on('click', cb)
  bus.dispatch('click', [hit('L1', 1), hit('L2', 2)], { tag: 'ev' })
  assert.deepEqual(cb.ids(), [[1, 2]])
  assert.equal(cb.llamadas[0].baseEvent.tag, 'ev')
})

// Caso que motiva el test: el camino global es 0-alloc — reparte a todos sus handlers el MISMO
// array que llegó al dispatch. El filtrado, por definición, arma su propia lista (subconjunto),
// pero con los hits originales adentro (no copias del hit).
test('el handler global recibe el array del despacho por referencia; el filtrado, uno propio', () => {
  const { bus } = banco()
  const g1 = testigo(); const g2 = testigo(); const filtrado = testigo()
  bus.on('click', g1); bus.on('click', g2); bus.on('click', 'L1', filtrado)
  const hits = [hit('L1', 1), hit('L2', 2)]
  bus.dispatch('click', hits, null)
  assert.equal(g1.llamadas[0].hits, hits, 'sin copia: es la lista del despacho')
  assert.equal(g2.llamadas[0].hits, hits, 'y es la misma para todos los globales')
  assert.notEqual(filtrado.llamadas[0].hits, hits, 'el filtrado no puede compartirla: es un subconjunto')
  assert.equal(filtrado.llamadas[0].hits[0], hits[0], 'pero adentro van los hits originales')
})

// Caso que motiva el test: los handlers filtrados reciben la MISMA aridad que los globales.
// Los demás tests de baseEvent usan handlers globales, así que este camino queda sin red.
test('el handler filtrado recibe (hits, baseEvent), igual que el global', () => {
  const { bus } = banco()
  const filtrado = testigo()
  bus.on('click', 'L1', filtrado)
  const ev = { tag: 'ev' }
  bus.dispatch('click', [hit('L1', 1)], ev)
  assert.equal(filtrado.llamadas[0].baseEvent, ev)
})

test('un despacho sin hits no invoca a ningún handler', () => {
  const { bus } = banco()
  const global = testigo(); const filtrado = testigo()
  bus.on('click', global); bus.on('click', 'L1', filtrado)
  bus.dispatch('click', [], { tag: 'ev' })
  assert.equal(global.llamadas.length, 0)
  assert.equal(filtrado.llamadas.length, 0)
})

test('un kind de despacho desconocido no invoca a nadie', () => {
  const { bus } = banco()
  const cb = testigo()
  bus.on('click', cb); bus.on('hover', cb); bus.on('inventado', cb)
  bus.dispatch('inventado', [hit('L', 1)], null)
  bus.dispatch('', [hit('L', 1)], null)
  assert.equal(cb.llamadas.length, 0)
})

test('el click contextual va por su propio canal y no despierta a los de click', () => {
  const { bus } = banco()
  const click = testigo(); const secundario = testigo()
  bus.on('click', click); bus.on('secondary-click', secundario)
  bus.dispatch('secondary-click', [hit('L', 1)], null)
  assert.deepEqual(secundario.ids(), [[1]])
  assert.equal(click.llamadas.length, 0)
})

test('pointer:move entrega el evento crudo con lista vacía e ignora el filtro por capa', () => {
  const { bus } = banco()
  const global = testigo(); const otroGlobal = testigo(); const filtrado = testigo()
  bus.on('pointer:move', global); bus.on('pointer:move', otroGlobal); bus.on('pointer:move', ['L1'], filtrado)
  const ev = { x: 10, y: 20 }
  const hits = [hit('L2', 2)]
  bus.dispatch('pointer:move', hits, ev)
  assert.equal(global.llamadas[0].baseEvent, ev, 'el evento crudo mismo, no una copia estructural')
  assert.deepEqual(global.llamadas[0].hits, [])
  assert.notEqual(global.llamadas[0].hits, hits, 'los hits del despacho se descartan, no se reenvían')
  // Cada handler recibe SU lista: nadie puede ensuciar la del siguiente empujando adentro.
  assert.notEqual(global.llamadas[0].hits, otroGlobal.llamadas[0].hits, 'una lista por handler, no una alias')
  assert.equal(filtrado.llamadas.length, 1, 'el evento crudo no se rutea por capa')
})

test('los handlers de un tipo se invocan en orden de suscripción', () => {
  const { bus } = banco()
  const orden = []
  bus.on('click', () => orden.push('a'))
  bus.on('click', 'L', () => orden.push('b'))
  bus.on('click', () => orden.push('c'))
  bus.dispatch('click', [hit('L', 1)], null)
  assert.deepEqual(orden, ['a', 'b', 'c'])
})

test('cada tipo de evento tiene su propia lista: un handler de click no ve el hover', () => {
  const { bus } = banco()
  const click = testigo()
  bus.on('click', click)
  bus.dispatch('hover', [hit('L', 1)], null)
  assert.equal(click.llamadas.length, 0)
})

test('el handler dado de baja deja de recibir y los demás siguen', () => {
  const { bus } = banco()
  const a = testigo(); const b = testigo()
  const bajaA = bus.on('click', a)
  bus.on('click', b)
  bus.dispatch('click', [hit('L', 1)], null)
  bajaA()
  bus.dispatch('click', [hit('L', 2)], null)
  assert.deepEqual(a.ids(), [[1]])
  assert.deepEqual(b.ids(), [[1], [2]])
})

// Caso que motiva el test: un handler que da de baja a otro en pleno reparto del mismo despacho.
test('dar de baja dentro del despacho saca al handler que todavía no fue llamado', () => {
  const { bus } = banco()
  const orden = []
  let bajaB = null
  bus.on('click', () => { orden.push('a'); bajaB() })
  bajaB = bus.on('click', () => orden.push('b'))
  bus.dispatch('click', [hit('L', 1)], null)
  assert.deepEqual(orden, ['a'])
  bus.dispatch('click', [hit('L', 1)], null)
  assert.deepEqual(orden, ['a', 'a'])
})

test('el despacho invoca a los handlers sincrónicamente, sin diferir a un frame', async () => {
  const { bus } = banco()
  const cb = testigo()
  bus.on('click', cb)
  bus.dispatch('click', [hit('L', 1)], null)
  assert.equal(cb.llamadas.length, 1)      // ya ocurrió al volver de dispatch
  await tick()
  assert.equal(cb.llamadas.length, 1)      // y no hay una segunda pasada diferida
})
