// Las reglas del navegador falso (test-helpers/navegador-falso.mjs): lo que los tests de elementos y de capa
// dan por sentado cuando cuentan contextos. Si una regla cambia, cambian todos los números que dependen de ella.
// Casi todo corre sin DOM (un canvas es un EventTarget con `parentNode`); los enchufes usan ventanas de mentira
// y, para el techo del proceso, jsdom. Corre con: node --test test/helpers/navegador-falso.test.mjs
import { conNavegador, crearNavegador, instalarNavegador, navegadorDe } from '../../test-helpers/navegador-falso.mjs'
import { makeIconSet, makeLeaflet, makeMap } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { MapEngine } from '../../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { linkPointProgram } from '../../src/render/point-program.js'

const WAIT_FAILED             = 0x911D
const CONTEXT_LOST_WEBGL      = 37442
const FRAMEBUFFER_COMPLETE    = 0x8CD5
const FRAMEBUFFER_UNSUPPORTED = 0x8CDD
const INVALID_OPERATION       = 0x0502

const canvas = pane => Object.assign(new EventTarget(), {
  parentNode: pane ? { nodeType: 1, className: `leaflet-pane leaflet-${pane}-pane` } : null,
})

// n contextos de la librería, con su canvas; devuelve las entradas del registro.
const crear = (navegador, n) => {
  for (let i = 0; i < n; i++) navegador.getContext(canvas(), 'webgl2')
  return navegador.contextos
}

const perdidos = navegador => navegador.contextos.filter(c => c.estado === 'perdido').map(c => c.id)

// Lo que hace una capa con su contexto, como lo hace la sonda del oráculo: dibujar (un clear) y después vaciar la
// cola, leer píxeles o sólo preguntar. El doble escribe en `readPixels` el parche de 6×6 del picking, de ahí el tamaño.
const usar = ({ gl }, modo) => {
  if (modo === 'getParameter') return gl.getParameter(gl.VERSION)
  if (modo === 'getError') return gl.getError()
  gl.clear(gl.COLOR_BUFFER_BIT)
  modo === 'flush'  && gl.flush()
  modo === 'finish' && gl.finish()
  modo === 'read'   && gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(6 * 6 * 4))
}

/* ── Techo y desalojo ── */

test('el 17.º contexto desaloja al que lleva más tiempo sin flush, que sin usos es el más viejo; el pico no pasa del techo', () => {
  const navegador = crearNavegador()
  const entradas  = crear(navegador, 16)
  assert.deepEqual(navegador.stat(), { creados: 16, vivos: 16, liberados: 0, desalojados: 0, pico: 16 })
  crear(navegador, 1)
  assert.deepEqual(navegador.stat(), { creados: 17, vivos: 16, liberados: 0, desalojados: 1, pico: 16 })
  assert.deepEqual(perdidos(navegador), [0])
  assert.deepEqual(navegador.victimas, [0])
  assert.equal(entradas[0].causa, 'desalojo')
  assert.equal(entradas[0].gl.isContextLost(), true, 'perdido YA, antes de que llegue el evento')
  assert.equal(entradas[16].estado, 'vivo', 'el recién creado nunca es la víctima')
  assert.deepEqual(navegador.avisos, ['WARNING: Too many active WebGL contexts. Oldest context will be lost.'])
})

test('el techo es configurable, y la política también', () => {
  const navegador = crearNavegador({ techo: 4 })
  crear(navegador, 6)
  assert.deepEqual(perdidos(navegador), [0, 1])
  assert.equal(crearNavegador().politica, 'ultimoUso', 'el último flush es la política por defecto')
  assert.throws(() => crearNavegador({ politica: 'lru' }), RangeError)
})

test("manda el último flush: dibujar, leer, subir datos y preguntar no salvan a un contexto; flush() y finish() sí; 'creacion' no mira usos", () => {
  const cae = (politica, hacer) => {
    const navegador = crearNavegador({ techo: 4, politica })
    hacer(crear(navegador, 4)[0])
    crear(navegador, 1)
    return perdidos(navegador)
  }
  for (const modo of ['draw', 'read', 'getParameter', 'getError'])
    assert.deepEqual(cae('ultimoUso', e => usar(e, modo)), [0], `${modo} no renueva`)
  assert.deepEqual(cae('ultimoUso', e => e.gl.drawArrays(0, 0, 3)), [0], 'un draw sin clear tampoco')
  assert.deepEqual(cae('ultimoUso', e => e.gl.bufferData(1, new Float32Array(3))), [0], 'subir datos no es trabajo de flush')
  assert.deepEqual(cae('ultimoUso', e => usar(e, 'flush')), [1], 'flush() lo renueva: cae el siguiente más viejo')
  assert.deepEqual(cae('ultimoUso', e => usar(e, 'finish')), [1], 'finish() también')
  assert.deepEqual(cae('creacion', e => usar(e, 'flush')), [0], "'creacion' ignora los usos")
})

// La tabla de verdad del oráculo de Chromium: `experimentos/desalojo/casos.mjs` y
// `etapa0/salidas/lru-chromium-*.txt` (headless 151 y 155, tres corridas iguales). Se crean 16 contextos, se aplican
// `usos` ([índice, modo]), y se crean `extra` más de a uno, aplicando `antes` antes de CADA creación. `victimas` es lo
// que cayó en Chromium, EN ORDEN. Los casos `lru-dom*` del oráculo (canvases en el documento, composición del
// cuadro) dan lo mismo que sus pares sin DOM —la composición no renueva nada, medido en headless—, así que el doble,
// que no compone, no los repite.
const ORDEN = [2, 5, 15, 7, 12, 4, 9, 11, 13, 6, 1, 0, 3, 10, 8, 14]
const en    = (modo, ...indices) => indices.map(i => [i, modo])

const ORACULO = {
  'lru-base'         : { extra: 5,  victimas: [0, 1, 2, 3, 4] },
  'lru'              : { usos: en('flush', 0, 8),   extra: 6, victimas: [1, 2, 3, 4, 5, 6] },
  'lru-finish'       : { usos: en('finish', 0, 8),  extra: 6, victimas: [1, 2, 3, 4, 5, 6] },
  'lru-read'         : { usos: en('read', 0, 8),    extra: 6, victimas: [0, 1, 2, 3, 4, 5] },
  'lru-sin-flush'    : { usos: en('draw', 0, 8),    extra: 6, victimas: [0, 1, 2, 3, 4, 5] },
  'lru-getparameter' : { usos: en('getParameter', 0, 8), extra: 6, victimas: [0, 1, 2, 3, 4, 5] },
  'lru-geterror'     : { usos: en('getError', 0, 8),     extra: 6, victimas: [0, 1, 2, 3, 4, 5] },
  'lru-orden'        : { usos: en('flush', ...ORDEN),    extra: 6, victimas: [2, 5, 15, 7, 12, 4] },
  'lru-pares'        : { usos: en('flush', 0, 2, 4, 6, 8, 10, 12, 14), extra: 10, victimas: [1, 3, 5, 7, 9, 11, 13, 15, 0, 2] },
  'lru-repetido'     : { antes: en('flush', 0), extra: 8, victimas: [1, 2, 3, 4, 5, 6, 7, 8] },
  'lru-repetido-8'   : { antes: en('flush', 8), extra: 8, victimas: [0, 1, 2, 3, 4, 5, 6, 7] },
}

for (const [caso, { usos = [], antes = [], extra, victimas }] of Object.entries(ORACULO)) {
  test(`oráculo ${caso}: caen ${victimas.join(', ')}, en ese orden`, () => {
    const navegador = crearNavegador()
    const entradas  = crear(navegador, 16)
    usos.forEach(([i, modo]) => usar(entradas[i], modo))
    for (let k = 0; k < extra; k++) {
      antes.forEach(([i, modo]) => usar(entradas[i], modo))
      crear(navegador, 1)
    }
    assert.deepEqual(navegador.victimas, victimas)
    assert.deepEqual(perdidos(navegador), [...victimas].sort((a, b) => a - b))
    assert.equal(navegador.vivos, 16)
    assert.equal(navegador.pico, 16)
  })
}

test('webglcontextlost llega después, en otra tarea, cancelable y con defaultPrevented observable', async () => {
  const navegador = crearNavegador({ techo: 1 })
  const primero   = canvas()
  const visto     = []
  primero.addEventListener('webglcontextlost', e => visto.push(e))
  navegador.getContext(primero, 'webgl2')
  navegador.getContext(canvas(), 'webgl2')
  assert.equal(visto.length, 0, 'no en la misma pila')
  assert.equal(navegador.pendientes, 1)
  await new Promise(r => setTimeout(r, 5))
  assert.equal(visto.length, 1)
  assert.equal(visto[0].cancelable, true)
  assert.equal(visto[0].defaultPrevented, false, 'sin handler que lo cancele')

  const otro = canvas()
  otro.addEventListener('webglcontextlost', e => e.preventDefault())
  navegador.getContext(otro, 'webgl2')                  // desaloja al #1
  navegador.getContext(canvas(), 'webgl2')              // y éste, al #2 (otro)
  assert.equal(navegador.vaciar(), 2, 'vaciar() despacha ya lo que llegaría en la próxima tarea')
  assert.equal(navegador.contextos[2].eventoPerdida.defaultPrevented, true)
})

/* ── Un contexto perdido ── */

test('sobre un perdido: sin extensiones, buffer 0, atributos null, error 37442, WAIT_FAILED, y dibujar no hace nada', () => {
  const navegador = crearNavegador()
  const { gl }    = crear(navegador, 1)[0]
  assert.equal(gl.drawingBufferWidth, 800)
  gl.getExtension('WEBGL_lose_context').loseContext()
  assert.equal(gl.isContextLost(), true)
  assert.equal(gl.getExtension('WEBGL_lose_context'), null)
  assert.equal(gl.drawingBufferWidth, 0)
  assert.equal(gl.drawingBufferHeight, 0)
  assert.equal(gl.getContextAttributes(), null)
  assert.equal(gl.getError(), CONTEXT_LOST_WEBGL)
  assert.equal(gl.clientWaitSync(null, 0, 0), WAIT_FAILED)
  assert.equal(gl.createBuffer(), null)
  assert.equal(gl.isBuffer({}), false)
  gl.drawArrays(0, 0, 3)
  gl.bufferData(1, new Float32Array(3))
  assert.equal(gl.spy.draws.length, 0, 'las llamadas no llegan al espía')
  assert.equal(gl.spy.bufferDatas.length, 0)
  assert.equal(navegador.contextos[0].llamadasTrasPerdida, 7, 'pero quedan contadas')
})

test('getError da CONTEXT_LOST_WEBGL una sola vez por pérdida y NO_ERROR después; un contexto vivo da NO_ERROR', () => {
  const navegador = crearNavegador()
  const lienzo    = canvas()
  lienzo.addEventListener('webglcontextlost', e => e.preventDefault())
  const gl  = navegador.getContext(lienzo, 'webgl2')
  const ext = gl.getExtension('WEBGL_lose_context')
  assert.equal(gl.NO_ERROR, 0)
  assert.equal(gl.CONTEXT_LOST_WEBGL, CONTEXT_LOST_WEBGL)
  assert.equal(gl.getError(), gl.NO_ERROR, 'vivo y sin error')

  ext.loseContext()
  assert.deepEqual([gl.getError(), gl.getError(), gl.getError()], [CONTEXT_LOST_WEBGL, 0, 0])
  navegador.vaciar()
  ext.restoreContext()
  navegador.vaciar()
  assert.equal(gl.getError(), gl.NO_ERROR, 'restaurado, vuelve a no tener error')

  ext.loseContext()
  assert.deepEqual([gl.getError(), gl.getError()], [CONTEXT_LOST_WEBGL, 0], 'otra pérdida, otra primera vez')
})

test('sobre un perdido getAttribLocation y getFragDataLocation dan -1 y checkFramebufferStatus da FRAMEBUFFER_UNSUPPORTED', () => {
  const navegador = crearNavegador()
  const { gl }    = crear(navegador, 1)[0]
  assert.equal(gl.checkFramebufferStatus(gl.FRAMEBUFFER), FRAMEBUFFER_COMPLETE, 'vivo, el doble no tiene framebuffers incompletos')
  assert.equal(gl.FRAMEBUFFER_COMPLETE, FRAMEBUFFER_COMPLETE)
  assert.equal(gl.FRAMEBUFFER_UNSUPPORTED, FRAMEBUFFER_UNSUPPORTED)

  gl.getExtension('WEBGL_lose_context').loseContext()
  assert.equal(gl.getAttribLocation(null, 'aPos'), -1)
  assert.equal(gl.getFragDataLocation(null, 'oColor'), -1)
  assert.equal(gl.checkFramebufferStatus(gl.FRAMEBUFFER), FRAMEBUFFER_UNSUPPORTED)
  assert.equal(gl.getUniformLocation(null, 'u'), null, 'el resto de los get* siguen dando null')
  assert.equal(gl.getParameter(gl.VERSION), null)
})

test('loseContext() libera el cupo en el acto; soltar uno y crear otro no desaloja, crear sin soltar sí', () => {
  const navegador = crearNavegador()
  const entradas  = crear(navegador, 16)
  entradas[3].gl.getExtension('WEBGL_lose_context').loseContext()
  assert.equal(navegador.vivos, 15, 'el cupo vuelve antes de que llegue el evento')
  crear(navegador, 1)
  assert.deepEqual(navegador.stat(), { creados: 17, vivos: 16, liberados: 1, desalojados: 0, pico: 16 })
  crear(navegador, 1)
  assert.equal(navegador.desalojados, 1, 'ahora sí está lleno')
  assert.deepEqual(perdidos(navegador), [0, 3])
})

test('un recurso pertenece a su contexto y a su época: en uno vivo, el de otro lanza; en uno perdido se cuenta y no lanza; borrar nunca', () => {
  const navegador = crearNavegador()
  const [a, b]    = crear(navegador, 2).map(c => c.gl)
  const buffer    = a.createBuffer()
  a.bindBuffer(a.ARRAY_BUFFER, buffer)
  assert.throws(() => b.bindBuffer(b.ARRAY_BUFFER, buffer), /del contexto #0 y éste es el #1/)

  const programa = a.createProgram()
  const lugar    = a.getUniformLocation(programa, 'u')
  a.uniform1f(lugar, 1)
  a.getExtension('WEBGL_lose_context').loseContext()
  assert.doesNotThrow(() => { a.useProgram(programa); a.uniform1f(lugar, 1) }, 'perdido, como Chromium: no hace nada')
  navegador.vaciar()                                    // y tampoco después de oír el evento
  assert.doesNotThrow(() => a.bindBuffer(a.ARRAY_BUFFER, buffer))
  assert.doesNotThrow(() => { a.deleteBuffer(buffer); a.deleteProgram(programa) })
  assert.doesNotThrow(() => a.bindVertexArray(null))
  assert.equal(a.createBuffer(), null)

  const ajeno = b.createBuffer()
  assert.doesNotThrow(() => a.bindBuffer(a.ARRAY_BUFFER, ajeno), 'el de otro contexto sobre uno perdido tampoco lanza')
  assert.throws(() => b.bindBuffer(b.ARRAY_BUFFER, buffer), /del contexto #0 y éste es el #1/, 'pero el recurso de un perdido sobre uno vivo sí')

  assert.deepEqual(navegador.violaciones.map(v => [v.contexto, v.metodo, v.perdido]), [
    [1, 'bindBuffer', false],
    [0, 'useProgram', true], [0, 'uniform1f', true], [0, 'bindBuffer', true], [0, 'bindBuffer', true],
    [1, 'bindBuffer', false],
  ])
  assert.equal(navegador.contextos[0].llamadasTrasPerdida, 8, 'los borrados y el createBuffer también cuentan')
})

test('con estricto: false el uso inválido no lanza, queda en violaciones y contesta como un perdido', () => {
  const navegador = crearNavegador({ estricto: false })
  const [a, b]    = crear(navegador, 2).map(c => c.gl)
  const buffer    = a.createBuffer()
  assert.doesNotThrow(() => b.bindBuffer(b.ARRAY_BUFFER, buffer))
  assert.equal(navegador.violaciones.length, 1)
  assert.equal(navegador.violaciones[0].perdido, false, 'estaba vivo: con estricto habría lanzado')
})

test('los canvases 2D no cuentan; el mismo canvas da el mismo contexto y otro tipo da null', () => {
  const navegador = crearNavegador()
  for (let i = 0; i < 40; i++) assert.ok(navegador.getContext(canvas(), '2d'))
  assert.equal(navegador.creados, 0)

  const uno = canvas()
  const gl  = navegador.getContext(uno, 'webgl2')
  assert.equal(navegador.getContext(uno, 'webgl2', { stencil: false }), gl, 'los atributos nuevos se ignoran')
  assert.equal(navegador.getContext(uno, 'webgl'), null)
  assert.equal(navegador.getContext(uno, '2d'), null)
  assert.equal(navegador.creados, 1)

  const plano = canvas()
  navegador.getContext(plano, '2d')
  assert.equal(navegador.getContext(plano, 'webgl2'), null)
  assert.equal(navegador.getContext(canvas(), 'webgpu'), null)
})

test('restoreContext: exige el evento ya despachado y cancelado; sin eso avisa y no restaura', () => {
  const navegador = crearNavegador()
  const entrada   = crear(navegador, 1)[0]
  const { gl }    = entrada
  const ext       = gl.getExtension('WEBGL_lose_context')
  ext.loseContext()
  ext.restoreContext()                                  // en la misma pila que loseContext
  assert.match(navegador.avisos.at(-1), /esperar a webglcontextlost/)
  navegador.vaciar()                                    // llega el evento y nadie lo cancela
  ext.restoreContext()
  assert.match(navegador.avisos.at(-1), /restoration not allowed/)
  assert.equal(navegador.vaciar(), 0)
  assert.equal(entrada.estado, 'perdido')
  assert.equal(navegador.restaurados, 0)
})

test('restoreContext con preventDefault: el mismo gl, recursos nuevos sí y los de antes no', () => {
  const navegador = crearNavegador()
  const lienzo    = canvas()
  const eventos   = []
  lienzo.addEventListener('webglcontextlost', e => e.preventDefault())
  lienzo.addEventListener('webglcontextrestored', e => eventos.push(e.type))
  const gl     = navegador.getContext(lienzo, 'webgl2')
  const viejo  = gl.createBuffer()
  const ext    = gl.getExtension('WEBGL_lose_context')
  ext.loseContext()
  navegador.vaciar()
  ext.restoreContext()
  assert.equal(gl.isContextLost(), true, 'restaurar tarda una tarea')
  navegador.vaciar()

  assert.equal(gl.isContextLost(), false)
  assert.equal(navegador.getContext(lienzo, 'webgl2'), gl, 'el mismo objeto gl')
  assert.deepEqual(eventos, ['webglcontextrestored'])
  assert.equal(navegador.restaurados, 1)
  assert.equal(gl.drawingBufferWidth, 800)
  assert.throws(() => gl.bindBuffer(gl.ARRAY_BUFFER, viejo), /se perdió/, 'restaurado es vivo: el recurso de antes sí lanza')
  assert.doesNotThrow(() => gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()))
})

test('restaurar con el techo lleno desaloja al siguiente más viejo, como Chromium', () => {
  const navegador = crearNavegador({ techo: 4 })
  const lienzos   = Array.from({ length: 5 }, () => {
    const c = canvas()
    c.addEventListener('webglcontextlost', e => e.preventDefault())
    return c
  })
  lienzos.forEach(c => navegador.getContext(c, 'webgl2'))   // el 5.º desaloja al #0
  navegador.vaciar()                                        // llega el evento y se cancela
  assert.deepEqual(perdidos(navegador), [0])
  navegador.contextos[0].extension.restoreContext()
  navegador.vaciar()
  assert.equal(navegador.contextos[0].estado, 'vivo')
  assert.deepEqual(perdidos(navegador), [1], 'el #0 volvió con el techo lleno y cayó el siguiente más viejo')
  assert.deepEqual(navegador.victimas, [0, 1])
})

test('cada entrada guarda el pane de Leaflet donde quedó su canvas, aunque ya no esté colgado', () => {
  const navegador = crearNavegador()
  const lienzo    = canvas('cristae-point-veh')
  const gl        = navegador.getContext(lienzo, 'webgl2')
  const entrada   = navegador.contextos[0]
  gl.viewport(0, 0, 1, 1)                               // la primera llamada ya con el canvas colgado
  lienzo.parentNode = null                              // destroy() saca el canvas del DOM antes de soltar el contexto
  gl.getExtension('WEBGL_lose_context').loseContext()
  assert.equal(entrada.pane, 'cristae-point-veh')
  assert.equal(navegador.contextos[0].paneEl.className, 'leaflet-pane leaflet-cristae-point-veh-pane')
  navegador.getContext(canvas(), 'webgl2')
  assert.equal(navegador.contextos[1].pane, '?', 'sin pane mientras no está colgado')
})

test('el nombre del pane admite los dos puntos de los panes del cluster', () => {
  const navegador = crearNavegador()
  const nombres   = ['cristae-point-cluster-3:spider', 'cristae-point-cluster-3:spider-sub', 'cristae-polygon-geo', 'cristae-edit']
  nombres.forEach(nombre => navegador.getContext(canvas(nombre), 'webgl2'))
  assert.deepEqual(navegador.contextos.map(c => c.pane), nombres)
})

test('un ajeno ocupa cupo y compite; desalojar() simula que el navegador se lo quita a uno', () => {
  const navegador = crearNavegador({ techo: 3 })
  crear(navegador, 2)
  const ajeno = navegador.ajeno()
  assert.equal(ajeno.ajeno, true)
  navegador.ajeno()
  assert.deepEqual(perdidos(navegador), [0], 'el ajeno compite con los de la librería')
  assert.equal(navegador.desalojar(navegador.contextos[1]), true)
  assert.equal(navegador.desalojar(navegador.contextos[1]), false, 'ya estaba perdido')
  assert.equal(navegador.desalojados, 2)
  assert.deepEqual(navegador.victimas, [0, 1])
})

/* ── El buffer de dibujo sigue al canvas ── */

test('drawingBufferWidth y drawingBufferHeight siguen al canvas: crecen, se achican, valen 0 en 0×0 y en un perdido', () => {
  const navegador = crearNavegador()
  const lienzo    = Object.assign(canvas(), { width: 300, height: 150 })
  lienzo.addEventListener('webglcontextlost', e => e.preventDefault())
  const gl        = navegador.getContext(lienzo, 'webgl2')
  const medida    = () => [gl.drawingBufferWidth, gl.drawingBufferHeight]
  assert.deepEqual(medida(), [300, 150])

  Object.assign(lienzo, { width: 1600, height: 900 })
  assert.deepEqual(medida(), [1600, 900])
  Object.assign(lienzo, { width: 0, height: 0 })
  assert.deepEqual(medida(), [0, 0], 'un contenedor de 0×0 da un buffer de 0×0')

  Object.assign(lienzo, { width: 640, height: 480 })
  const ext = gl.getExtension('WEBGL_lose_context')
  ext.loseContext()
  assert.deepEqual(medida(), [0, 0], 'perdido, 0 aunque el canvas mida')
  navegador.vaciar()
  ext.restoreContext()
  navegador.vaciar()
  assert.deepEqual(medida(), [640, 480], 'restaurado, vuelve a seguir al canvas')
  lienzo.width = 320
  assert.deepEqual(medida(), [320, 480])
})

test('un canvas sin medidas, un objeto pelado de un test, deja la del doble base', () => {
  const navegador = crearNavegador()
  const gl        = navegador.getContext({}, 'webgl2')
  assert.deepEqual([gl.drawingBufferWidth, gl.drawingBufferHeight], [800, 600])
})

/* ── El ARRAY_BUFFER enlazado: un puntero de atributos sin buffer es INVALID_OPERATION ── */

// Un VAO armado sobre un VBO que todavía no existe (`linkPointProgram(gl, null)`) es el error que el doble tapaba: el
// `null` no lleva sello, así que ninguna validación lo miraba. Chromium lo rechaza con «no ARRAY_BUFFER is bound and
// offset is non-zero» y los handles no se ven ni se pican.
test('vertexAttribPointer sin ARRAY_BUFFER enlazado y con offset: INVALID_OPERATION, queda en violaciones y lanza con estricto', () => {
  const navegador = crearNavegador()
  const { gl }    = crear(navegador, 1)[0]
  gl.bindVertexArray(gl.createVertexArray())
  assert.equal(gl.getError(), gl.NO_ERROR)
  assert.equal(gl.INVALID_OPERATION, INVALID_OPERATION)

  assert.throws(() => gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 8), /sin buffer enlazado a ARRAY_BUFFER y con el offset 8/)
  assert.deepEqual(navegador.violaciones.map(v => [v.contexto, v.metodo, v.perdido]), [[0, 'vertexAttribPointer', false]])
  assert.equal(gl.getError(), INVALID_OPERATION, 'el contexto retiene el error hasta que se lee')
  assert.equal(gl.getError(), gl.NO_ERROR, 'getError lo borra')
  assert.equal(gl.spy.vao.buffer, undefined, 'y la llamada no llegó al doble: el VAO no tiene de dónde leer')
})

test('sin ARRAY_BUFFER enlazado también falla vertexAttribIPointer, y con offset 0 no: es lo que Chromium acepta', () => {
  const navegador = crearNavegador()
  const { gl }    = crear(navegador, 1)[0]
  assert.throws(() => gl.vertexAttribIPointer(2, 1, gl.FLOAT, 4, 12), /offset 12/)
  assert.doesNotThrow(() => gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 28, 0), 'offset 0: el puntero nulo no es un error')
  assert.equal(navegador.violaciones.length, 1)
})

test('con un buffer enlazado a ARRAY_BUFFER el puntero vale; si se desenlaza, o se borra el enlazado, vuelve a fallar', () => {
  const navegador = crearNavegador()
  const { gl }    = crear(navegador, 1)[0]
  const buffer    = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  assert.doesNotThrow(() => gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 8))
  assert.doesNotThrow(() => gl.vertexAttribIPointer(2, 1, gl.FLOAT, 4, 12))
  assert.equal(gl.getError(), gl.NO_ERROR)

  gl.bindBuffer(gl.ARRAY_BUFFER, null)
  assert.throws(() => gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 8), /sin buffer enlazado/)

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.deleteBuffer(buffer)                               // borrar el enlazado lo desenlaza
  assert.throws(() => gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 8), /sin buffer enlazado/)

  const otro = gl.createBuffer()
  gl.deleteBuffer(otro)                                 // borrar uno que no está enlazado no desenlaza nada
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.deleteBuffer(otro)
  assert.doesNotThrow(() => gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 8))
  assert.equal(navegador.violaciones.length, 2)
})

test('el ARRAY_BUFFER es el único destino que cuenta: enlazar otro target no habilita el puntero', () => {
  const navegador = crearNavegador()
  const { gl }    = crear(navegador, 1)[0]
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, gl.createBuffer())
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer())
  assert.throws(() => gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 8), /sin buffer enlazado/)
})

test('el enlace de ARRAY_BUFFER es del contexto, no del VAO: bindVertexArray no lo toca', () => {
  const navegador = crearNavegador()
  const { gl }    = crear(navegador, 1)[0]
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bindVertexArray(gl.createVertexArray())
  assert.doesNotThrow(() => gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 8))
  gl.bindVertexArray(null)
  assert.doesNotThrow(() => gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 8))
})

test('con estricto: false el puntero sin buffer no lanza, deja el error pendiente y la violación en el registro', () => {
  const navegador = crearNavegador({ estricto: false })
  const { gl }    = crear(navegador, 1)[0]
  assert.doesNotThrow(() => gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 8))
  assert.doesNotThrow(() => gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 24))
  assert.equal(navegador.violaciones.length, 2)
  assert.equal(gl.getError(), INVALID_OPERATION)
  assert.equal(gl.getError(), gl.NO_ERROR)
})

test('el enlace y el error pendiente no sobreviven a una pérdida: un contexto restaurado empieza sin buffer enlazado y sin error', () => {
  const navegador = crearNavegador({ estricto: false })
  const lienzo    = canvas()
  lienzo.addEventListener('webglcontextlost', e => e.preventDefault())
  const gl  = navegador.getContext(lienzo, 'webgl2')
  const ext = gl.getExtension('WEBGL_lose_context')
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 8)
  assert.equal(navegador.violaciones.length, 0)

  ext.loseContext()
  navegador.vaciar()
  ext.restoreContext()
  navegador.vaciar()
  assert.equal(gl.getError(), gl.NO_ERROR)
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 8)
  assert.equal(navegador.violaciones.length, 1, 'restaurado no tiene el buffer de antes enlazado')
  assert.equal(gl.getError(), INVALID_OPERATION)
})

test('sobre un perdido el puntero no se valida: la llamada no hace nada y sólo se cuenta', () => {
  const navegador = crearNavegador()
  const entrada   = crear(navegador, 1)[0]
  entrada.gl.getExtension('WEBGL_lose_context').loseContext()
  assert.doesNotThrow(() => entrada.gl.vertexAttribPointer(1, 4, entrada.gl.FLOAT, false, 28, 8))
  assert.equal(entrada.llamadasTrasPerdida, 1)
  assert.deepEqual(navegador.violaciones, [])
})

test('linkPointProgram sobre el VBO del arena armado no falla; sobre uno que todavía no existe (null) sí', () => {
  const navegador = crearNavegador()
  const { gl }    = crear(navegador, 1)[0]
  assert.doesNotThrow(() => linkPointProgram(gl, gl.createBuffer()))
  assert.throws(() => linkPointProgram(gl, null), /vertexAttribPointer\(\) se llamó sin buffer enlazado/)
  assert.equal(navegador.violaciones.length, 1)
})

/* ── Enchufes ── */

// Una ventana de mentira: su propio document, su propio Event y su propia clase de canvas.
const ventana = () => {
  const document = {}
  class Canvas extends EventTarget {
    ownerDocument = document
    getContext() { return 'original' }
  }
  const window = { document, Event: class extends Event {}, HTMLCanvasElement: Canvas }
  document.defaultView = window
  return window
}

const tomar = (window, n) => {
  for (let i = 0; i < n; i++) new window.HTMLCanvasElement().getContext('webgl2')
}

const deDoc = (navegador, window, estado) =>
  navegador.contextos.filter(c => c.documento === window.document && c.estado === estado).map(c => c.id)

test('instalarNavegador: un registro por documento, el canvas pide su contexto a él, y se desinstala', () => {
  class Canvas extends EventTarget { getContext() { return 'original' } }
  const original = Canvas.prototype.getContext
  const window   = { document: {}, Event, HTMLCanvasElement: Canvas }

  const uno = instalarNavegador(window, { techo: 2 })
  assert.equal(navegadorDe(window.document), uno)
  const lienzo = new Canvas()
  assert.ok(lienzo.getContext('webgl2'))
  assert.equal(uno.creados, 1)

  const dos = instalarNavegador(window)
  assert.equal(navegadorDe(window.document), dos, 'el segundo reemplaza al primero')
  assert.notEqual(Canvas.prototype.getContext, original)
  dos.desinstalar()
  assert.equal(Canvas.prototype.getContext, original, 'el getContext original vuelve')
  assert.equal(lienzo.getContext('webgl2'), 'original')
  assert.equal(navegadorDe(window.document), undefined)
})

test('un navegador compartido entre ventanas es un proceso de render: el techo es de todas y se desalojan entre sí', () => {
  const [padre, hijo] = [ventana(), ventana()]
  const navegador     = instalarNavegador(padre)
  assert.equal(instalarNavegador(hijo, { navegador }), navegador, 'devuelve el mismo navegador')
  assert.equal(navegadorDe(hijo.document), navegador)

  tomar(padre, 16)
  tomar(hijo, 4)
  assert.deepEqual(deDoc(navegador, padre, 'perdido'), [0, 1, 2, 3], 'el hijo desaloja a los más viejos del padre')
  assert.deepEqual(deDoc(navegador, hijo, 'perdido'), [])
  assert.equal(navegador.vivos, 16)
  assert.equal(navegador.pico, 16)
  navegador.desinstalar()
})

test('dos navegadores son dos procesos: una ventana noopener no comparte el techo', () => {
  const [padre, aparte] = [ventana(), ventana()]
  const proceso         = instalarNavegador(padre)
  const otro            = instalarNavegador(aparte)
  assert.notEqual(proceso, otro)

  tomar(padre, 16)
  tomar(aparte, 4)
  assert.equal(proceso.desalojados, 0)
  assert.equal(otro.desalojados, 0)
  assert.deepEqual([proceso.vivos, otro.vivos], [16, 4])
  proceso.desinstalar()
  otro.desinstalar()
})

test('desinstalar() suelta todas las ventanas del navegador; con un document, sólo esa', () => {
  const [padre, hijo] = [ventana(), ventana()]
  const navegador     = instalarNavegador(padre)
  instalarNavegador(hijo, { navegador })
  const original = ventana().HTMLCanvasElement.prototype.getContext

  navegador.desinstalar(hijo.document)
  assert.equal(navegadorDe(hijo.document), undefined)
  assert.equal(new hijo.HTMLCanvasElement().getContext('webgl2'), 'original', 'el hijo volvió a su getContext')
  assert.ok(new padre.HTMLCanvasElement().getContext('webgl2').isContextLost, 'el padre sigue enchufado')
  assert.equal(navegadorDe(padre.document), navegador)

  navegador.desinstalar()
  assert.equal(navegadorDe(padre.document), undefined)
  assert.equal(new padre.HTMLCanvasElement().getContext('webgl2'), 'original')
  assert.equal(padre.HTMLCanvasElement.prototype.getContext.toString(), original.toString())
})

test('en un navegador compartido cada canvas oye el evento de su propia ventana', () => {
  const [padre, hijo] = [ventana(), ventana()]
  const navegador     = instalarNavegador(padre, { techo: 1 })
  instalarNavegador(hijo, { navegador })
  const lienzo = new padre.HTMLCanvasElement()
  const visto  = []
  lienzo.addEventListener('webglcontextlost', e => visto.push(e))
  lienzo.getContext('webgl2')
  new hijo.HTMLCanvasElement().getContext('webgl2')     // desaloja al del padre
  navegador.vaciar()
  assert.equal(visto.length, 1)
  assert.ok(visto[0] instanceof padre.Event, 'el evento nace del realm de la ventana del canvas')
  assert.ok(!(visto[0] instanceof hijo.Event))
  navegador.desinstalar()
})

test('con jsdom: un iframe del mismo sitio comparte el techo con su página, y su canvas mide 300×150 hasta que se lo cambian', () => {
  const dom       = new JSDOM('<!doctype html><body><iframe></iframe></body>')
  const padre     = dom.window
  const hijo      = padre.document.querySelector('iframe').contentWindow
  const navegador = instalarNavegador(padre)
  instalarNavegador(hijo, { navegador })
  try {
    const tomarDe = (window, n) => Array.from({ length: n }, () => {
      const lienzo = window.document.createElement('canvas')
      return [lienzo, lienzo.getContext('webgl2')]
    })
    const [[, primero]] = tomarDe(padre, 16)
    const [[lienzo, gl]] = tomarDe(hijo, 4)
    assert.equal(primero.isContextLost(), true, 'el hijo, con sus 4, desaloja al primero de la página')
    assert.deepEqual(deDoc(navegador, padre, 'perdido'), [0, 1, 2, 3])
    assert.equal(navegador.vivos, 16)

    assert.deepEqual([gl.drawingBufferWidth, gl.drawingBufferHeight], [300, 150], 'lo que mide un canvas recién creado')
    lienzo.width = 1280
    assert.equal(gl.drawingBufferWidth, 1280)
    lienzo.width = 0
    assert.equal(gl.drawingBufferWidth, 0)
  } finally {
    navegador.desinstalar()
    dom.window.close()
  }
})

test('con jsdom: otra página, sin opener, es otro proceso y sus contextos no tocan a los de la primera', () => {
  const [uno, dos] = [new JSDOM(), new JSDOM()]
  const proceso    = instalarNavegador(uno.window)
  const otro       = instalarNavegador(dos.window)
  try {
    for (let i = 0; i < 16; i++) uno.window.document.createElement('canvas').getContext('webgl2')
    for (let i = 0; i < 4; i++) dos.window.document.createElement('canvas').getContext('webgl2')
    assert.deepEqual([proceso.desalojados, otro.desalojados], [0, 0])
  } finally {
    proceso.desinstalar()
    otro.desinstalar()
    uno.window.close()
    dos.window.close()
  }
})

test('conNavegador: los canvases del document del shim piden su contexto al registro', () => {
  const navegador = crearNavegador()
  const restaurar = conNavegador(navegador)
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    assert.ok(gl.isContextLost)
    assert.equal(navegador.creados, 1)
    assert.ok(document.createElement('canvas').getContext('2d'))
    assert.equal(navegador.creados, 1, 'el 2D no cuenta')
  } finally { restaurar() }
})

test('conNavegador entrega webglcontextlost y webglcontextrestored a los canvases del shim, con oyentes que se quitan', () => {
  const navegador = crearNavegador()
  const restaurar = conNavegador(navegador)
  try {
    const lienzo = document.createElement('canvas')
    const vistos = []
    const oyente = e => { vistos.push(e.type); e.preventDefault() }
    lienzo.addEventListener('webglcontextlost', oyente)
    lienzo.addEventListener('webglcontextrestored', oyente)
    lienzo.getContext('webgl2')

    navegador.desalojar(navegador.contextos[0])
    assert.deepEqual(vistos, [], 'no en la misma pila')
    assert.equal(navegador.vaciar(), 1)
    assert.deepEqual(vistos, ['webglcontextlost'])
    assert.equal(navegador.contextos[0].eventoPerdida.defaultPrevented, true)

    navegador.contextos[0].extension.restoreContext()
    navegador.vaciar()
    assert.deepEqual(vistos, ['webglcontextlost', 'webglcontextrestored'])

    lienzo.removeEventListener('webglcontextlost', oyente)
    navegador.desalojar(navegador.contextos[0])
    navegador.vaciar()
    assert.equal(vistos.length, 2, 'el oyente que se quitó ya no oye')
  } finally { restaurar() }
})

test('conNavegador: el buffer de los canvases del shim sigue a su width y height', () => {
  const navegador = crearNavegador()
  const restaurar = conNavegador(navegador)
  try {
    const lienzo = document.createElement('canvas')
    const gl     = lienzo.getContext('webgl2')
    assert.deepEqual([gl.drawingBufferWidth, gl.drawingBufferHeight], [0, 0], 'el shim nace de 0×0, como su canvas')
    Object.assign(lienzo, { width: 640, height: 360 })
    assert.deepEqual([gl.drawingBufferWidth, gl.drawingBufferHeight], [640, 360])
  } finally { restaurar() }
})

test('conNavegador en el motor: la pérdida llega a la superficie de la capa, en otra tarea', () => {
  const navegador = crearNavegador()
  const restaurar = conNavegador(navegador)
  const engine    = new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }) })
  try {
    const señales = []
    engine.on('surfacechange', fila => señales.push(fila.state))
    engine.addPointLayer({
      id: 'p', iconSet: makeIconSet(), data: [{ id: 1, lat: 0, lng: 0 }],
      accessors: { idOf: it => it.id, positionOf: it => ({ lat: it.lat, lng: it.lng }) },
    })
    const superficie = engine.getLayer('p').layer.surface

    navegador.desalojar(navegador.contextos[0])
    assert.equal(superficie.contextLost, false, 'perdido YA, pero la superficie se entera con el evento')
    assert.equal(navegador.pendientes, 1)
    navegador.vaciar()
    assert.equal(superficie.contextLost, true, 'el evento llegó al canvas de la capa')
    assert.deepEqual(señales, ['lost'])
    assert.equal(engine.surfaces()[0].state, 'lost')
  } finally {
    engine.destroy()
    restaurar()
  }
})
