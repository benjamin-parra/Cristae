// La capa de líneas sobre una superficie que pierde su contexto, o lo suelta, y lo vuelve a tomar en otro: rehace el
// pase del trazo y las texturas de su store desde el espejo de CPU y dibuja lo mismo, sin tocar el contexto viejo.
// Con el navegador falso (test-helpers/navegador-falso.mjs), que desaloja como Chromium y lanza si un recurso de un
// contexto se usa en otro. Los cuadros de la política los corre el test (`cuadro()`), y los eventos del navegador
// llegan con `navegador.vaciar()`. La capa pinta en el acto, sin cuadro propio, y pica en CPU.
// Corre con: node --test test/render/linegpulayer-readquirir.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { makeEditGl, makeLeaflet, makeMap, makePickSpy } from '../../test-helpers/engine-stub.mjs'
import { conNavegador, crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import { after, afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { LineGpuLayer } from '../../src/render/LineGpuLayer.js'
import { glBudget } from '../../src/render/gl-budget.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { createSource } from '../../src/data/Source.js'

/* ── Cuadros a mano, y un reloj que avanza entre test y test ── */

const rafPrevio    = globalThis.requestAnimationFrame
const cancelPrevio = globalThis.cancelAnimationFrame
const agendados    = new Map()
let serie          = 0
globalThis.requestAnimationFrame = cb => (agendados.set(++serie, cb), serie)
globalThis.cancelAnimationFrame  = id => agendados.delete(id)

// Corre lo agendado hasta ahora: lo que se agenda durante el cuadro va al siguiente.
const cuadro = () => {
  const ahora = [...agendados.values()]
  agendados.clear()
  ahora.forEach(cb => cb(0))
}

// La política no recupera una pérdida que llega hasta un segundo después de otra recuperación: cada test empieza
// lejos de la del anterior.
const reloj   = performance.now.bind(performance)
let   desfase = 0
performance.now = () => reloj() + desfase
beforeEach(() => { desfase += 10_000 })

after(() => {
  globalThis.requestAnimationFrame = rafPrevio
  globalThis.cancelAnimationFrame  = cancelPrevio
  performance.now                  = reloj
})

/* ── Harness ── */

// Cada contexto anota lo que le piden, con los datos copiados en el momento: lo que viajó, no el espejo vivo.
const copia  = v => (ArrayBuffer.isView(v) ? Array.from(v) : v)
const grabar = base => {
  const llamadas = []
  return new Proxy(base, {
    get: (t, p) => {
      if (p === 'llamadas') return llamadas
      const v = t[p]
      return typeof v === 'function' ? (...args) => (llamadas.push([p, ...args.map(copia)]), v(...args)) : v
    },
  })
}

// El doble no define el lado máximo de textura: con un tope, `MAX_TEXTURE_SIZE` es un enum real y `getParameter` lo contesta.
const MAX_TEXTURE_SIZE = 0x0D33
const conTope = (gl, tope) => (tope === null ? gl : new Proxy(gl, {
  get: (t, p) => (p === 'MAX_TEXTURE_SIZE' ? MAX_TEXTURE_SIZE : p === 'getParameter' ? q => (q === MAX_TEXTURE_SIZE ? tope : t.getParameter(q)) : t[p]),
}))

const llamados = (contexto, metodo) => contexto.gl.llamadas.filter(([m]) => m === metodo)
// Lo que se dibuja: primer vértice y cantidad, sin el modo (un enum del doble, distinto en cada contexto).
const dibujos  = contexto => llamados(contexto, 'drawArrays').map(([, , primero, cuenta]) => [primero, cuenta])

// El contenido final de una textura, como lo dejaría la GPU: la última imagen entera y las filas que se le subieron
// después. [formato interno, formato de las filas, canales por texel]
const { RG32F, RG, R32F, RED, RGBA8, RGBA } = makeEditGl()
const TEXTURAS = { posiciones: [RG32F, RG, 2], arcos: [R32F, RED, 1], colores: [RGBA8, RGBA, 4] }
const textura  = (contexto, [interno, formato, canales]) => {
  let datos = null
  for (const [metodo, ...a] of contexto.gl.llamadas) {
    if (metodo === 'texImage2D' && a[2] === interno) datos = Array.from(a[8])
    if (metodo === 'texSubImage2D' && a[6] === formato && datos) {
      const [, , , , ancho, filas, , , fuente, desde] = a
      datos.splice(desde, ancho * filas * canales, ...fuente.slice(desde, desde + ancho * filas * canales))
    }
  }
  return datos
}

// Lo que quedó agendado corre antes de soltar el navegador: una recuperación que no corre deja a la política
// esperando un cuadro que no llega.
let soltar = null
afterEach(() => {
  for (let i = 0; agendados.size && i < 20; i++) cuadro()
  agendados.clear()
  soltar?.()
  soltar = null
})

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

const recorrido = (n, lat = 0, lng = 0) => Array.from({ length: n }, (_, i) => [lat + i * 0.001, lng + i * 0.001])
const items     = () => [{ id: 1, path: recorrido(50) }, { id: 2, path: recorrido(20, 1, 1) }]

// Cada variante agrega una textura al store: la de posiciones es de todas, la de arcos es del dash y la de colores del gradiente.
const VARIANTES = {
  'continua'      : { accessors: {}, texturas: ['posiciones'] },
  'con dash'      : { accessors: { styleOf: () => ({ dash: [6, 6], cap: 'round' }) }, texturas: ['posiciones', 'arcos'] },
  'con gradiente' : { accessors: { scalarOf: (_item, i) => i, colorRamp: v => [v / 100, 0, 1 - v / 100, 1] }, texturas: ['posiciones', 'colores'] },
}

const nuevoNavegador = ({ tope = null, ...opciones } = {}) =>
  crearNavegador({ crearGl: canvas => conTope(grabar(makeEditGl(makePickSpy(), canvas)), tope), ...opciones })

// `source` propia: una Source a mano que no pasa por `set`. La Source real reparte su primer `set` en el turno siguiente:
// el test que después le cambia datos espera un `tick()` para asentar esa ventana.
const montar = ({ navegador = nuevoNavegador(), source: propia, accessors = {}, lista = items(), ...opciones } = {}) => {
  soltar ??= conNavegador(navegador)
  const map    = makeMap()
  const host   = adoptLeafletHost(map, { leaflet: makeLeaflet() })
  const source = propia ?? createSource({ idOf: r => r.id, pathOf: r => r.path, ...accessors })
  propia || source.set(lista)
  const layer = new LineGpuLayer({ host, pane: 'p', source, ...opciones })
  return { layer, source, map, lista, navegador, contexto: i => navegador.contextos[i] }
}

// Un contexto viejo intacto: ni una llamada después de perderse y ningún recurso suyo usado en otro.
const intacto = (navegador, i) => {
  assert.equal(navegador.contextos[i].llamadasTrasPerdida, 0, `ninguna llamada al contexto #${i} después de perderse`)
  assert.deepEqual(navegador.violaciones, [], 'ningún recurso de un contexto usado en otro')
}

/* ── T2.1 · adquirir → soltar → adquirir dibuja lo mismo ── */

for (const [nombre, { accessors, texturas }] of Object.entries(VARIANTES)) {
  test(`T2.1 ${nombre}: re-adquirida sube las mismas texturas y dibuja lo mismo, y el contexto viejo no se toca`, async () => {
    const { layer, navegador, contexto } = montar({ accessors })
    assert.equal(dibujos(contexto(0)).length, 2, 'el constructor pinta una vez: buildGl sin datos no dibuja')

    assert.equal(layer.surface.release(), true)
    assert.equal(navegador.vivos, 0, 'soltarla devuelve el cupo en el acto')
    layer.surface.acquire()
    for (const t of texturas) assert.deepEqual(textura(contexto(1), TEXTURAS[t]), textura(contexto(0), TEXTURAS[t]), `la textura de ${t}`)
    assert.deepEqual(dibujos(contexto(1)), dibujos(contexto(0)), 'los mismos tramos, en la misma tarea')
    assert.equal(agendados.size, 0, 'sin cuadro propio')

    // Lo que sigue va al contexto nuevo: un repintado, el reasentado de la vista.
    layer.resetCanvasReference()
    layer.redraw()
    navegador.vaciar()                                    // el `webglcontextlost` que deja `loseContext`
    assert.equal(layer.surface.state, 'live', 'el aviso de soltar no es una pérdida')
    assert.equal(navegador.creados, 2)
    assert.equal(dibujos(contexto(1)).length, 6)
    intacto(navegador, 0)
    layer.destroy()
  })
}

// El foco es estado de la capa: está en el estilo de cada entidad y llega al trazo del contexto nuevo.
test('T2.1: el foco aplicado llega al trazo del contexto nuevo', async () => {
  const { layer, contexto } = montar()
  layer.applyFocus(new Set([1]), 0.25)
  const colores = c => llamados(c, 'uniform4fv').map(([, , rgba]) => rgba[3])
  assert.deepEqual(colores(contexto(0)).slice(-2), [1, 0.25])
  layer.surface.release()
  layer.surface.acquire()
  assert.deepEqual(colores(contexto(1)), [1, 0.25])
  layer.destroy()
})

// Sin contexto, cada camino que toca GL sale sin tocarlo: la vista, el foco, ocultarla y mostrarla, un repintado.
// Lo de CPU sigue: los datos que llegan quedan en el espejo, y al volver a tener contexto suben enteros. La gemela
// recibe lo mismo con su contexto vivo, y sus texturas, ya con todo adentro, son las que tiene que dejar la re-adquirida.
// Los datos llegan en pleno gesto: fuera de él, el primero le pediría el contexto a la política en esa tarea.
const GESTO = {}
const incremental = async ({ layer, source, lista }) => {
  source.append(1, [0.2, 0.2], [0.21, 0.21])             // el tramo abierto crece más allá de su hueco
  await tick()
  source.patch([lista[0], { ...lista[1], path: recorrido(35, 3, 3) }], new Set([2]))
  await tick()
  layer.applyFocus(new Set([2]), 0.4)
}

const membresia = async ({ layer, source, lista }) => {
  source.set([...lista, { id: 3, path: recorrido(10, 7, 7) }])
  await tick()
  layer.refresh()
}

for (const [cambio, hacer] of Object.entries({ 'un append y un patch': incremental, 'un cambio de membresía y un refresh': membresia })) {
  for (const [nombre, { accessors, texturas }] of Object.entries(VARIANTES)) {
    test(`T2.1 ${nombre}: ${cambio} sin contexto quedan en el espejo y suben enteros al volver a tenerlo`, async () => {
      const navegador = nuevoNavegador()
      const a = montar({ navegador, accessors })
      const b = montar({ navegador, accessors })    // la gemela, con contexto vivo
      await tick()
      a.layer.surface.release()
      glBudget.motion(GESTO, true)

      await hacer(a)
      await hacer(b)
      // Sin contexto, nada toca GL ni agenda nada
      assert.equal(a.layer.redraw(), false)
      assert.equal(a.layer.resetCanvasReference(), false)
      a.map.fire('moveend')
      a.map.fire('zoom', { pinch: true })
      assert.equal(a.layer.setVisible(false), false)
      assert.equal(a.layer.setVisible(true), false)
      assert.equal(a.layer.applyFocus(new Set([1])), true)
      a.layer.applyFocus(new Set([2]), 0.4)
      assert.equal(agendados.size, 0, 'sin contexto no se agenda ningún cuadro')
      assert.equal(a.layer.surface.state, 'released')

      a.layer.surface.acquire()
      glBudget.motion(GESTO, false)
      const re = a.contexto(2), viva = b.contexto(1)
      for (const t of texturas) assert.deepEqual(textura(re, TEXTURAS[t]), textura(viva, TEXTURAS[t]), `la textura de ${t}`)
      const tramos = dibujos(re)
      assert.ok(tramos.length >= 2)
      assert.deepEqual(tramos, dibujos(viva).slice(-tramos.length), 'y dibuja los mismos tramos')
      intacto(navegador, 0)
      a.layer.destroy()
      b.layer.destroy()
    })
  }
}

/* ── T2.2 · el trazo y las texturas, en el contexto nuevo ── */

for (const [nombre, { accessors, texturas }] of Object.entries(VARIANTES)) {
  test(`T2.2 ${nombre}: enlaza el programa del trazo en el contexto nuevo y crea sus texturas y su VAO`, async () => {
    const { layer, contexto } = montar({ accessors })
    layer.surface.release()
    layer.surface.acquire()
    const nuevo = contexto(1)
    assert.equal(llamados(nuevo, 'linkProgram').length, 1, 'el programa compartido se enlaza otra vez: la caché es del contexto')
    assert.equal(llamados(nuevo, 'getUniformLocation').length, 17, 'y sus uniformes se piden de nuevo')
    assert.equal(llamados(nuevo, 'createVertexArray').length, 1)
    assert.equal(llamados(nuevo, 'createTexture').length, texturas.length, `una textura por ${texturas.join(' y ')}`)
    layer.destroy()
  })
}

/* ── T2.3 · un desalojo se re-adquiere y pinta en el cuadro siguiente ── */

test('T2.3: desalojada, se re-adquiere en el cuadro siguiente al aviso y pinta en ese mismo cuadro', async () => {
  const { layer, navegador, contexto } = montar()
  navegador.desalojar(contexto(0))
  assert.equal(layer.surface.state, 'lost', 'perdida en el acto')
  navegador.vaciar()
  assert.equal(navegador.creados, 1, 'no en la tarea del aviso')
  assert.deepEqual([layer.redraw(), layer.resetCanvasReference()], [false, false], 'mientras tanto no dibuja')

  cuadro()
  assert.equal(navegador.creados, 2)
  assert.equal(layer.surface.state, 'live')
  assert.deepEqual(dibujos(contexto(1)), dibujos(contexto(0)))
  assert.deepEqual(textura(contexto(1), TEXTURAS.posiciones), textura(contexto(0), TEXTURAS.posiciones))
  intacto(navegador, 0)
  layer.destroy()
})

test('T2.3: oculta, se re-adquiere y sube sin dibujar; mostrarla pinta en el acto, y el canvas nuevo sigue oculto', async () => {
  const { layer, navegador, contexto } = montar()
  layer.setVisible(false)
  navegador.desalojar(contexto(0))
  navegador.vaciar()
  cuadro()
  assert.equal(layer.surface.state, 'live')
  assert.equal(layer.surface.canvas.style.display, 'none', 'el canvas nuevo hereda del marcador que la capa ocultó')
  assert.equal(llamados(contexto(1), 'texImage2D').length, 1, 'la textura sube')
  assert.equal(llamados(contexto(1), 'drawArrays').length, 0)
  assert.equal(layer.setVisible(true), true)
  assert.equal(layer.surface.canvas.style.display, '')
  assert.deepEqual(dibujos(contexto(1)), dibujos(contexto(0)).slice(0, 2))
  layer.destroy()
})

test('T2.3: vacía, no toma contexto al construirse; lo toma un rato ocioso sin subir ni dibujar, y desalojada queda soltada', async () => {
  await tick()                                            // los ratos ociosos que pidieron los tests de antes ya pasaron
  const ociosos = []
  globalThis.requestIdleCallback = cb => ociosos.push(cb)
  try {
    const { layer, navegador, contexto } = montar({ lista: [] })
    assert.deepEqual([navegador.creados, layer.surface.state], [0, 'none'])
    ociosos.splice(0).forEach(cb => cb())
    assert.equal(layer.surface.state, 'live')
    assert.deepEqual([llamados(contexto(0), 'texImage2D').length, llamados(contexto(0), 'drawArrays').length], [0, 0])

    navegador.desalojar(contexto(0))
    navegador.vaciar()
    cuadro()
    assert.equal(layer.surface.state, 'released', 'vacía es prescindible: no se recupera')
    assert.equal(navegador.creados, 1)
    layer.destroy()
  } finally {
    delete globalThis.requestIdleCallback
  }
})

/* ── T2.5 · nadie cancela la pérdida ── */

test('T2.5: ni el desalojo ni la liberación se cancelan con preventDefault', async () => {
  const { layer, navegador, contexto } = montar()
  navegador.desalojar(contexto(0))
  navegador.vaciar()
  cuadro()
  layer.surface.release()
  navegador.vaciar()
  assert.deepEqual([contexto(0), contexto(1)].map(c => c.eventoPerdida.defaultPrevented), [false, false])
  layer.destroy()
})

/* ── T2.6 · destruirla durante la pérdida o después deja 0 vivos ── */

test('T2.6: destruida mientras espera su turno, no se re-adquiere', async () => {
  const { layer, navegador, contexto } = montar()
  navegador.desalojar(contexto(0))
  navegador.vaciar()
  layer.destroy()
  cuadro()
  assert.deepEqual([navegador.creados, navegador.vivos], [1, 0])
  intacto(navegador, 0)
})

test('T2.6: destruida después de re-adquirir, devuelve el contexto nuevo sin borrar nada de a uno', async () => {
  const { layer, navegador, contexto } = montar()
  navegador.desalojar(contexto(0))
  navegador.vaciar()
  cuadro()
  layer.destroy()
  assert.deepEqual([navegador.creados, navegador.vivos, navegador.liberados], [2, 0, 1])
  for (const c of [contexto(0), contexto(1)])
    assert.deepEqual(['deleteTexture', 'deleteVertexArray'].map(m => llamados(c, m).length), [0, 0], 'loseContext libera todo de una vez')
  intacto(navegador, 0)
})

test('T2.6: soltada, un cambio de membresía no borra texturas del contexto que ya no está', async () => {
  const { layer, source, lista, navegador, contexto } = montar()
  layer.surface.release()
  source.set([...lista, { id: 3, path: recorrido(10, 7, 7) }])
  await tick()
  layer.refresh()
  layer.destroy()
  assert.equal(llamados(contexto(0), 'deleteTexture').length, 0)
  intacto(navegador, 0)
})

test('T2.6: con el contexto vivo, un cambio de membresía devuelve las texturas del store que reemplaza', async () => {
  const { layer, source, lista, contexto } = montar()
  source.set([...lista, { id: 3, path: recorrido(10, 7, 7) }])
  await tick()
  assert.equal(llamados(contexto(0), 'deleteTexture').length, 1)
  layer.destroy()
})

/* ── T2.7 · el picking es de CPU: no depende del contexto ── */

test('T2.7: pica igual con el contexto, sin él y en el nuevo, también lo que llegó mientras tanto', async () => {
  const { layer, source, lista, navegador, contexto } = montar({ lista: [{ id: 1, path: recorrido(50) }, { id: 2, path: recorrido(20, 40, 40) }] })
  await tick()
  const click  = { lat: 0.0025, lng: 0.0025 }
  const antes  = layer.resolveClick(click)
  assert.deepEqual(antes.map(h => [h.id, h.partIndex, h.vertexIndex]), [[1, 0, 2]])
  assert.deepEqual(layer.resolveHover(click), antes)

  navegador.desalojar(contexto(0))
  navegador.vaciar()
  assert.deepEqual(layer.resolveClick(click), antes, 'sin contexto')
  assert.deepEqual(layer.resolveHover(click), antes)

  source.patch([{ id: 1, path: recorrido(50, -30, -30) }, lista[1]], new Set([1]))
  await tick()
  assert.deepEqual(layer.resolveClick(click), [], 'el patch quitó el recorrido de antes')
  assert.deepEqual(layer.resolveClick({ lat: -29.9975, lng: -29.9975 }).map(h => h.id), [1], 'y se pica el nuevo, sin contexto')

  cuadro()
  assert.equal(layer.surface.state, 'live')
  assert.deepEqual(layer.resolveClick({ lat: -29.9975, lng: -29.9975 }).map(h => h.id), [1])
  intacto(navegador, 0)
  layer.destroy()
})

/* ── El tope de textura sobrevive al contexto ── */

// Una Source a mano, sin `set`: cambia la lista y la capa la relee con `refresh()`.
const conLista = () => {
  const lista = items()
  return { lista, source: { accessors: { idOf: r => r.id, pathOf: r => r.path }, getSnapshot: () => lista, subscribe: () => () => {} } }
}
const ENORME = { id: 3, path: recorrido(5000) }

test('sin contexto, el store sigue creciendo contra el último tope de textura que midió', () => {
  const navegador = nuevoNavegador({ tope: 1 })
  const viva  = conLista()
  const suelta = conLista()
  const a = montar({ navegador, source: viva.source })
  const b = montar({ navegador, source: suelta.source })
  b.layer.surface.release()
  viva.lista.push(ENORME)
  suelta.lista.push(ENORME)
  const falla = /8192 vértices no entran en una textura de 1×1/
  assert.throws(() => a.layer.refresh(), falla, 'con contexto, el tope lo lee del contexto')
  assert.throws(() => b.layer.refresh(), falla, 'sin él, el del contexto que tuvo')
  intacto(navegador, 1)
  a.layer.destroy()
  b.layer.destroy()
})
