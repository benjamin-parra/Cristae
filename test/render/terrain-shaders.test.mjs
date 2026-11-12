// Los fuentes del terreno con el preludio: válidos en forma, un uniforme una declaración, la clave por
// variante, un programa por contexto, y ninguna lectura filtrada de las texturas flotantes.
// Corre con: node --test test/render/terrain-shaders.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  terrainSources, terrainPrograms, HILLSHADE_UNIFORMS, COLOR_UNIFORMS, MAX_SLOPE_BREAKS, NO_DATA,
  HILLSHADE_AZIMUTH, HILLSHADE_ALTITUDE, CONTOUR_PX,
} from '../../src/render/terrain-shaders.js'
import { projectionKey } from '../../src/render/projection-prelude.js'

const fuentes = terrainSources()
const declarados = source => [...source.matchAll(/^\s*uniform\s+\w+\s+(\w+)/gm)].map(m => m[1])

test('la versión va primero y la cabecera fija la precisión de los samplers', () => {
  for (const { vertex, fragment } of [fuentes.hillshade, fuentes.color])
    for (const source of [vertex, fragment]) {
      assert.ok(source.startsWith('#version 300 es\n'))
      assert.match(source, /precision highp sampler2D;/)
    }
})

test('el preludio entra sólo en el vértice, después de la cabecera', () => {
  const { vertex, fragment } = fuentes.color
  assert.ok(vertex.indexOf('projectRel') > vertex.indexOf('precision highp sampler2D;'))
  assert.ok(vertex.includes('uniform float u_projection_scale;'))
  assert.ok(!fragment.includes('u_projection_scale'))
  assert.ok(vertex.includes('gl_Position = projectRel(uMatrix, rel);'))
})

test('cada uniforme se declara una vez y los de la lista son los del fuente', () => {
  for (const [programa, lista] of [['hillshade', HILLSHADE_UNIFORMS], ['color', COLOR_UNIFORMS]]) {
    const { vertex, fragment } = fuentes[programa]
    const nombres = [...declarados(vertex), ...declarados(fragment)].filter(n => n !== 'u_projection_scale')
    assert.equal(new Set(nombres).size, nombres.length, `${programa}: un nombre repetido`)
    assert.deepEqual([...nombres].sort(), [...lista].sort())
  }
})

test('no hay texture( sobre las texturas flotantes: todo es texelFetch', () => {
  for (const { vertex, fragment } of [fuentes.hillshade, fuentes.color])
    for (const source of [vertex, fragment]) assert.doesNotMatch(source, /\btexture\s*\(/)
})

test('las constantes del fuente salen de las exportadas', () => {
  assert.equal(MAX_SLOPE_BREAKS, 15)
  assert.ok(fuentes.color.fragment.includes(`const int  MAX_BREAKS    = ${MAX_SLOPE_BREAKS};`))
  assert.ok(fuentes.color.fragment.includes(`const float CONTOUR_PX   = ${CONTOUR_PX.toFixed(1)};`))
  assert.ok(fuentes.hillshade.fragment.includes(`const float NO_DATA = ${NO_DATA.toFixed(1)};`))
  const [x, y, z] = fuentes.hillshade.fragment.match(/LIGHT = vec3\(([^)]*)\)/)[1].split(',').map(Number)
  assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-12)
  assert.ok(x < 0 && y > 0, 'la luz viene del noroeste')
  assert.ok(Math.abs(z - Math.sin(HILLSHADE_ALTITUDE * Math.PI / 180)) < 1e-12)
  assert.equal(HILLSHADE_AZIMUTH, 315)
})

test('una variante desconocida lanza y la clave distingue la variante', () => {
  assert.throws(() => terrainSources('nada'), /Variante/)
  assert.equal(projectionKey('terrain', 'mercator'), 'terrain:mercator')
})

const glContador = () => {
  const gl = { programas: 0, usos: [], unidades: [] }
  Object.assign(gl, {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    createProgram      : () => ({ id: ++gl.programas }),
    createShader       : () => ({}),
    shaderSource       : () => {},
    compileShader      : () => {},
    getShaderParameter : () => true,
    getProgramParameter: () => true,
    attachShader       : () => {},
    linkProgram        : () => {},
    deleteShader       : () => {},
    getUniformLocation : (_p, nombre) => ({ nombre }),
    useProgram         : () => gl.usos.push('use'),
    uniform1i          : (loc, v) => gl.unidades.push([loc.nombre, v]),
  })
  return gl
}

test('sharedProgram: los dos programas se compilan una vez por contexto', () => {
  const gl = glContador()
  const a  = terrainPrograms(gl)
  assert.equal(terrainPrograms(gl), a)
  assert.equal(gl.programas, 2)
  const otro = glContador()
  assert.notEqual(terrainPrograms(otro), a)
  assert.equal(otro.programas, 2)
})

test('los samplers quedan en las unidades 0 y 1 y matrix y scale son los que busca bind', () => {
  const gl = glContador()
  const { hillshade, color } = terrainPrograms(gl)
  assert.deepEqual(gl.unidades, [['uHeights', 0], ['uRows', 1], ['uHeights', 0], ['uRows', 1]])
  for (const p of [hillshade, color]) {
    assert.equal(p.matrix, p.uMatrix)
    assert.equal(p.scale.nombre, 'u_projection_scale')
  }
  assert.ok(color.uBreaks && color.uColors && color.uRange && color.uInterval)
})
