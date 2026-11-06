// Los pases que comparten las capas de líneas, polígonos y el editor —el contorno (`StrokePass`) y el relleno
// (`EditFillLayer`)— pasan de un contexto a otro con `dropGl()` y `buildGl(gl)`: enlazan sus programas en el nuevo
// (la caché es por contexto), conservan su estilo y no vuelven a tocar el viejo. Con el navegador falso, que
// lanza si un recurso de un contexto se usa en otro. Corre con: node --test test/render/pases-readquirir.test.mjs
import { makeEditGl } from '../../test-helpers/engine-stub.mjs'
import { crearNavegador } from '../../test-helpers/navegador-falso.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { EditFillLayer } from '../../src/render/EditFillLayer.js'
import { StrokePass } from '../../src/render/StrokePass.js'

// Cada contexto anota lo que le piden; los arrays, copiados en el momento.
const grabar = base => {
  const llamadas = []
  return new Proxy(base, {
    get: (t, p) => {
      if (p === 'llamadas') return llamadas
      const v = t[p]
      return typeof v === 'function' ? (...args) => (llamadas.push([p, ...args.map(a => (ArrayBuffer.isView(a) ? Array.from(a) : a))]), v(...args)) : v
    },
  })
}

// Dos contextos: el viejo, que se pierde después del `dropGl`, y el nuevo.
const contextos = () => {
  const navegador = crearNavegador({ crearGl: () => grabar(makeEditGl()) })
  const viejo     = navegador.getContext({}, 'webgl2')
  const nuevo     = navegador.getContext({}, 'webgl2')
  return { navegador, viejo, nuevo, perderViejo: () => navegador.contextos[0].extension.loseContext() }
}

const llamados = (gl, metodo) => gl.llamadas.filter(([m]) => m === metodo)

// Un anillo de cuatro vértices sobre una textura de posiciones del contexto dado: lo que el store de la capa
// rehace en el contexto nuevo, y que el pase sólo lee.
const anillo = gl => ({
  firstVertex  : 0,
  lastVertex   : 3,
  textureWidth : 256,
  texture      : gl.createTexture(),
  anchor       : { x: 0, y: 0 },
  matrixFor    : () => Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1),
  eachRange    : cb => cb(0, 0, 4, 0),
  boxOfChunk   : (_chunk, box) => (box.set([-0.5, -0.5, 0.5, 0.5]), box),
})
const VISTA = { zoom: 0, center: { x: 0, y: 0 }, size: { x: 800, y: 600 } }

test('StrokePass: en el contexto nuevo enlaza su programa y dibuja con el mismo estilo, sin tocar el viejo', () => {
  const { navegador, viejo, nuevo, perderViejo } = contextos()
  const pase = new StrokePass({ gl: viejo, color: '#ff0000', width: 4, opacity: 0.5, dash: [4, 2], cap: 'round' })
  pase.draw([{ arena: { ...anillo(viejo), arcTexture: viejo.createTexture() } }], VISTA)
  const estilo = gl => llamados(gl, 'uniform4fv').map(([, , rgba]) => rgba)
  const antes  = estilo(viejo)

  assert.equal(pase.dropGl(), pase)
  perderViejo()
  assert.equal(pase.buildGl(nuevo), pase)
  assert.equal(llamados(nuevo, 'linkProgram').length, 1)
  assert.equal(pase.draw([{ arena: { ...anillo(nuevo), arcTexture: nuevo.createTexture() } }], VISTA), true)
  assert.deepEqual(estilo(nuevo), antes, 'el color y la opacidad del trazo sobreviven')
  assert.deepEqual(llamados(nuevo, 'uniform1fv').map(([, , dash]) => dash.slice(0, 2)), [[4, 2]], 'y el patrón')

  pase.destroy()
  assert.equal(llamados(nuevo, 'deleteVertexArray').length, 1)
  assert.equal(navegador.contextos[0].llamadasTrasPerdida, 0)
  assert.deepEqual(navegador.violaciones, [])
})

test('StrokePass: dos pases sobre el mismo contexto nuevo comparten un solo enlace', () => {
  const { nuevo } = contextos()
  const a = new StrokePass({})
  const b = new StrokePass({ closed: false })
  a.buildGl(nuevo)
  b.buildGl(nuevo)
  assert.equal(llamados(nuevo, 'linkProgram').length, 1)
})

test('StrokePass: sin contexto, destroy no tiene nada que borrar', () => {
  const { navegador, viejo, perderViejo } = contextos()
  const pase = new StrokePass({ gl: viejo })
  pase.dropGl()
  perderViejo()
  assert.doesNotThrow(() => pase.destroy())
  assert.equal(navegador.contextos[0].llamadasTrasPerdida, 0)
})

test('EditFillLayer: en el contexto nuevo enlaza sus tres programas, les fija la unidad de posiciones y rellena con el mismo color', () => {
  const { navegador, viejo, nuevo, perderViejo } = contextos()
  const relleno = new EditFillLayer({ gl: viejo, rings: [{ arena: anillo(viejo) }], color: '#00ff00', opacity: 0.3, step: 1 })
  assert.equal(relleno.draw(VISTA), true)
  const color = gl => llamados(gl, 'uniform4f').map(([, , ...rgba]) => rgba)
  const antes = color(viejo)

  assert.equal(relleno.dropGl(), relleno)
  perderViejo()
  relleno.rings = [{ arena: anillo(nuevo) }]              // el store de la capa, rehecho en el contexto nuevo
  assert.equal(relleno.buildGl(nuevo), relleno)
  assert.equal(llamados(nuevo, 'linkProgram').length, 3, 'paridad, vivas y cobertura')
  assert.equal(llamados(nuevo, 'uniform1i').length, 2, 'uPos en la unidad 0, en la paridad y en las vivas')
  assert.equal(relleno.draw(VISTA), true)
  assert.deepEqual(color(nuevo), antes)

  relleno.destroy()
  assert.equal(llamados(nuevo, 'deleteVertexArray').length, 1)
  assert.equal(navegador.contextos[0].llamadasTrasPerdida, 0)
  assert.deepEqual(navegador.violaciones, [])
})

test('EditFillLayer: soltada, destroy no toca el contexto viejo', () => {
  const { navegador, viejo, perderViejo } = contextos()
  const relleno = new EditFillLayer({ gl: viejo, rings: [] })
  relleno.dropGl()
  perderViejo()
  relleno.destroy()
  assert.equal(navegador.contextos[0].llamadasTrasPerdida, 0)
})

test('EditFillLayer: nace sin contexto si no se le da uno, y sin él destroy no borra nada', () => {
  const { nuevo } = contextos()
  const relleno = new EditFillLayer({ rings: [] })
  assert.doesNotThrow(() => relleno.destroy())
  relleno.buildGl(nuevo)
  assert.equal(llamados(nuevo, 'linkProgram').length, 3)
})
