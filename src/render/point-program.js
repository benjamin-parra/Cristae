import { POINT_FRAGMENT, POINT_VERTEX } from './shaders.js'

// El programa de los sprites y el VAO que lee un VBO con su layout. Lo comparten la capa de puntos y los
// handles de edición: el mismo vértice, el mismo atlas y el mismo pase de picking.
//
// Layout por entrada: [x, y, tile, angle, b, a, size] (ver shaders.js).
export const POINT_FLOATS = 7

const STRIDE = POINT_FLOATS * 4
const ATTRS  = [
  { name: 'vertex',    size: 2, offset: 0 },
  { name: 'color',     size: 4, offset: 8 },
  { name: 'pointSize', size: 1, offset: 24 },
]

// El programa es de quien lo pide: los uniformes del atlas y la matriz son de cada capa. El VAO se arma
// una vez sobre un VBO ESTABLE —crecerlo reasigna su almacenamiento, no el buffer— y sobrevive a eso.
export const linkPointProgram = (gl, vbo) => {
  const program = gl.createProgram()
  ;[[gl.VERTEX_SHADER, POINT_VERTEX], [gl.FRAGMENT_SHADER, POINT_FRAGMENT]].forEach(([type, source]) => {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    gl.attachShader(program, shader)
    gl.deleteShader(shader)                  // el programa las retiene hasta el link
  })
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(`[cristae] el programa de los sprites no linkea: ${gl.getProgramInfoLog(program)}`)

  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  ATTRS.forEach(({ name, size, offset }) => {
    const loc = gl.getAttribLocation(program, name)
    if (loc < 0) return
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE, offset)
  })
  gl.bindVertexArray(null)
  return { program, vao }
}
