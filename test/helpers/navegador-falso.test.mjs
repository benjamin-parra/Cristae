// Las reglas del navegador falso (test-helpers/navegador-falso.mjs): lo que los tests de elementos y de capa
// dan por sentado cuando cuentan contextos. Si una regla cambia, cambian todos los números que dependen de ella.
// Sin DOM: un canvas es un EventTarget con `parentNode`. Corre con: node --test test/helpers/navegador-falso.test.mjs
import { conNavegador, crearNavegador, instalarNavegador, navegadorDe } from '../../test-helpers/navegador-falso.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'

const WAIT_FAILED = 0x911D

const canvas = pane => Object.assign(new EventTarget(), {
  parentNode: pane ? { nodeType: 1, className: `leaflet-pane leaflet-${pane}-pane` } : null,
})

// n contextos de la librería, con su canvas; devuelve las entradas del registro.
const crear = (navegador, n) => {
  for (let i = 0; i < n; i++) navegador.getContext(canvas(), 'webgl2')
  return navegador.contextos
}

const perdidos = navegador => navegador.contextos.filter(c => c.estado === 'perdido').map(c => c.id)

test('el 17.º contexto desaloja al más viejo por creación, y el pico no pasa del techo', () => {
  const navegador = crearNavegador()
  const entradas  = crear(navegador, 16)
  assert.deepEqual(navegador.stat(), { creados: 16, vivos: 16, liberados: 0, desalojados: 0, pico: 16 })
  crear(navegador, 1)
  assert.deepEqual(navegador.stat(), { creados: 17, vivos: 16, liberados: 0, desalojados: 1, pico: 16 })
  assert.deepEqual(perdidos(navegador), [0])
  assert.equal(entradas[0].causa, 'desalojo')
  assert.equal(entradas[0].gl.isContextLost(), true, 'perdido YA, antes de que llegue el evento')
  assert.equal(entradas[16].estado, 'vivo', 'el recién creado nunca es la víctima')
  assert.deepEqual(navegador.avisos, ['WARNING: Too many active WebGL contexts. Oldest context will be lost.'])
})

test('el techo es configurable, y la política también', () => {
  const navegador = crearNavegador({ techo: 4 })
  crear(navegador, 6)
  assert.deepEqual(perdidos(navegador), [0, 1])
  assert.throws(() => crearNavegador({ politica: 'lru' }), RangeError)
})

test("política 'creacion': usar un contexto no lo salva; 'ultimoUso': sí", () => {
  const porCreacion = crearNavegador({ techo: 4 })
  const entradas    = crear(porCreacion, 4)
  entradas[0].gl.drawArrays(0, 0, 3)
  crear(porCreacion, 1)
  assert.deepEqual(perdidos(porCreacion), [0])

  const porUso = crearNavegador({ techo: 4, politica: 'ultimoUso' })
  const otras  = crear(porUso, 4)
  otras[0].gl.drawArrays(0, 0, 3)
  otras[1].gl.bufferData(1, new Float32Array(3))       // subir no es trabajo de flush
  crear(porUso, 1)
  assert.deepEqual(perdidos(porUso), [1], 'el #0 dibujó; subir datos no cuenta como trabajo, así que cae el #1')
})

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
  assert.equal(gl.getError(), 37442)
  assert.equal(gl.clientWaitSync(null, 0, 0), WAIT_FAILED)
  assert.equal(gl.createBuffer(), null)
  assert.equal(gl.isBuffer({}), false)
  gl.drawArrays(0, 0, 3)
  gl.bufferData(1, new Float32Array(3))
  assert.equal(gl.spy.draws.length, 0, 'las llamadas no llegan al espía')
  assert.equal(gl.spy.bufferDatas.length, 0)
  assert.equal(navegador.contextos[0].llamadasTrasPerdida, 7, 'pero quedan contadas')
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

test('un recurso pertenece a su contexto y a su época: otro contexto o uno perdido lanza; borrar no', () => {
  const navegador = crearNavegador()
  const [a, b]    = crear(navegador, 2).map(c => c.gl)
  const buffer    = a.createBuffer()
  a.bindBuffer(a.ARRAY_BUFFER, buffer)
  assert.throws(() => b.bindBuffer(b.ARRAY_BUFFER, buffer), /del contexto #0 y éste es el #1/)

  const programa = a.createProgram()
  const lugar    = a.getUniformLocation(programa, 'u')
  a.uniform1f(lugar, 1)
  a.getExtension('WEBGL_lose_context').loseContext()
  assert.throws(() => a.useProgram(programa), /época 0.*se perdió/)
  assert.throws(() => a.uniform1f(lugar, 1), /se perdió/)
  assert.doesNotThrow(() => { a.deleteBuffer(buffer); a.deleteProgram(programa) })
  assert.doesNotThrow(() => a.bindVertexArray(null))
  assert.deepEqual(navegador.violaciones.map(v => v.metodo), ['bindBuffer', 'useProgram', 'uniform1f'])
})

test('con estricto: false el uso inválido no lanza, queda en violaciones y contesta como un perdido', () => {
  const navegador = crearNavegador({ estricto: false })
  const [a, b]    = crear(navegador, 2).map(c => c.gl)
  const buffer    = a.createBuffer()
  assert.doesNotThrow(() => b.bindBuffer(b.ARRAY_BUFFER, buffer))
  assert.equal(navegador.violaciones.length, 1)
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
  assert.throws(() => gl.bindBuffer(gl.ARRAY_BUFFER, viejo), /se perdió/)
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
})

/* ── Enchufes ── */

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
