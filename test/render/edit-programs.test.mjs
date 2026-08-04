// Los programas de las capas de edición son del CONTEXTO, no de la instancia: el fuente es idéntico entre
// capas y sólo `paso` lo parametriza. Lo que se caracteriza acá es el COSTE DE MONTAJE —cuántas veces se
// compila, se enlaza y sobre todo se CONSULTA el estado, que es la barrera síncrona con la GPU— y que
// compartir los programas no acople los ciclos de vida: la capa que se destruye no puede dejar mudas a
// las otras.
//
// El harness va primero: instala los globals de módulo que el resto del árbol toca al evaluarse.
import { makeGl } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ChunkedPath } from '../../src/geometry/ChunkedPath.js'
import { EditArena } from '../../src/render/EditArena.js'
import { EditFillLayer } from '../../src/render/EditFillLayer.js'
import { EditStrokeLayer } from '../../src/render/EditStrokeLayer.js'

const BITS = 5
const SIZE = { x: 800, y: 600 }
const W0   = 256 / 360

const project = (lat, lng, out) => {
  out[0] = (lng + 180) * W0
  out[1] = (90 - lat) * W0
}

const PUNTOS = Array.from({ length: 12 }, (_, i) => [-33.45 + i * 0.0007, -70.66 + i * 0.0011])

/* ── Doble de gl: cuenta las llamadas del montaje y modela el borrado de un programa ── */

// Las llamadas que el defecto multiplicaba por geometría. `getShaderParameter` y `getProgramParameter`
// son las SÍNCRONAS: cada una cruza el command buffer y espera al proceso GPU.
const OPS = ['createProgram', 'linkProgram', 'compileShader', 'getShaderParameter', 'getProgramParameter',
  'deleteProgram', 'deleteVertexArray']

const doble = () => {
  const cuenta = Object.fromEntries(OPS.map(op => [op, 0]))
  const estado = { actual: null, draws: 0 }
  const base   = makeGl()

  // Lo que el doble del repo no modela y este contrato necesita: la identidad del programa y su borrado.
  // Dibujar con un programa borrado es una operación inválida en GL, y es lo que le da dientes al test de
  // ciclo de vida — sin esto, una caché que se llevara los programas ajenos pasaría igual.
  const semantica = {
    createProgram : () => ({ borrado: false }),
    deleteProgram : programa => { programa.borrado = true },
    useProgram    : programa => { estado.actual = programa },
    drawArrays    : () => {
      if (estado.actual?.borrado) throw new Error('[test] draw con un programa borrado')
      estado.draws++
    },
  }
  // `true` es lo que esperan los checks de COMPILE_STATUS y LINK_STATUS.
  const contado = Object.fromEntries(OPS.map(op => [op, (...args) => {
    cuenta[op]++
    return semantica[op]?.(...args) ?? true
  }]))
  const propio = { ...semantica, ...contado }

  return { gl: new Proxy(base, { get: (t, p) => propio[p] ?? base[p] }), cuenta, estado }
}

/* ── Montaje: una geometría editable es su trazo más su relleno, cada una con su arena ── */

const montar = (gl, n) => Array.from({ length: n }, () => {
  const path  = new ChunkedPath({ points: PUNTOS, localBits: BITS })
  const arena = new EditArena({ gl, path, project })
  return {
    arena,
    trazo   : new EditStrokeLayer({ gl, arena, path, project }),
    relleno : new EditFillLayer({ gl, rings: [{ path, arena }] }),
  }
})

const vista = arena => ({ zoom: 13, center: { x: arena.anchor.x, y: arena.anchor.y }, size: SIZE })

/* ── 1. El conteo no se mueve con N ── */

// Tres programas del relleno (paridad, vivas, cobertura) más uno del trazo, con dos shaders cada uno. Las
// DIEZ consultas síncronas —seis de compilación, cuatro de enlace— son las que el defecto pagaba POR
// geometría: con mil geocercas eran 10.000 bloqueos del hilo principal.
const POR_CONTEXTO = {
  createProgram       : 4,
  linkProgram         : 4,
  compileShader       : 8,
  getShaderParameter  : 6,
  getProgramParameter : 4,
  deleteProgram       : 0,
  deleteVertexArray   : 0,
}

;[1, 10, 200].forEach(n => test(`montar ${n} geometrías sobre el mismo contexto cuesta lo que montar una`, () => {
  const { gl, cuenta } = doble()

  montar(gl, n)

  assert.deepEqual(cuenta, POR_CONTEXTO)
  assert.equal(cuenta.getShaderParameter + cuenta.getProgramParameter, 10,
    'las diez consultas síncronas son del contexto, no de la geometría')
}))

test('la caché es POR contexto: dos superficies no se prestan programas', () => {
  const uno = doble()
  const dos = doble()

  montar(uno.gl, 3)
  montar(dos.gl, 3)

  assert.deepEqual([uno.cuenta.createProgram, dos.cuenta.createProgram], [4, 4],
    'un programa de otro contexto no es usable: cada uno enlaza los suyos')
})

test('el paso entra en la clave: el relleno con midpoints y el estático no comparten programa', () => {
  const { gl, cuenta } = doble()
  const path  = new ChunkedPath({ points: PUNTOS, localBits: BITS })
  const arena = new EditArena({ gl, path, project })

  new EditFillLayer({ gl, rings: [{ path, arena }] })
  new EditFillLayer({ gl, rings: [{ path, arena }] })
  assert.equal(cuenta.createProgram, 3, 'dos capas del mismo paso enlazan una vez')

  new EditFillLayer({ gl, rings: [{ path, arena }], paso: 1 })
  assert.equal(cuenta.createProgram, 6, 'el paso está horneado en el vertex shader: otro paso es otro pase')
})

/* ── 2. Ciclo de vida: destruir una capa no toca a las otras ── */

test('destruir una capa no invalida las otras: la que queda sigue dibujando', () => {
  const { gl, cuenta, estado } = doble()
  const [uno, dos] = montar(gl, 2)

  uno.trazo.destroy()
  uno.relleno.destroy()

  estado.draws = 0
  assert.equal(dos.relleno.draw({ ...vista(dos.arena), drag: null }), true,
    'el relleno de la capa viva sigue en pantalla')
  dos.trazo.draw(vista(dos.arena))
  assert.ok(estado.draws > 0, 'y sus draws siguen saliendo')

  assert.equal(cuenta.deleteProgram, 0,
    'el programa vive con el contexto: ninguna capa lo borra al destruirse')
  assert.equal(cuenta.deleteVertexArray, 2, 'el VAO sí es de la capa, y se va con ella')
})

test('una capa montada DESPUÉS de destruir otra reusa el programa, no lo re-enlaza', () => {
  const { gl, cuenta } = doble()
  const [uno] = montar(gl, 1)

  uno.trazo.destroy()
  uno.relleno.destroy()
  const [dos] = montar(gl, 1)

  assert.deepEqual([cuenta.createProgram, cuenta.linkProgram], [4, 4],
    'la caché no se vació con la capa: el contexto sigue vivo')
  assert.equal(dos.relleno.draw({ ...vista(dos.arena), drag: null }), true,
    'y el programa que reusa sirve para dibujar')
})
