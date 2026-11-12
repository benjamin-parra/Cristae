import { anchorMatrix } from './anchor-matrix.js'

// El plano afín de hoy: sin inclinación ni giro, y la proyección mercator con `t` en 0 (el cero es «plano»).
const PITCH_PLANO   = 0
const BEARING_PLANO = 0
const T_PLANO       = 0

// El portador de la vista de una capa GPU: lo que `readView(camera, frame)` llena (zoom, centro en world0 y
// tamaño en px CSS) más lo constante de este plano. Lo reusa quien lo crea, porque la vista se lee por frame.
// Los métodos viven en el prototipo y `bind` no crea objetos: la matriz es del portador.
class FrameView {
  zoom       = 0
  center     = { x: 0, y: 0 }
  size       = { x: 0, y: 0 }
  pitch      = PITCH_PLANO
  bearing    = BEARING_PLANO
  projection = { name: 'mercator', variant: 'mercator', t: T_PLANO }
  affine     = true
  matrix     = new Float32Array(16)

  // Escribe la matriz rel-ancla → clip de este frame y la sube, con la escala si el programa la declara.
  // `locs` trae `matrix` y, opcional, `scale` (la ubicación de `u_projection_scale`). El ancla viaja en un objeto
  // con `anchorX` y `anchorY` (world0 px, fraccionarios): como argumento suelto, V8 boxea cada double si no inlinea
  // la llamada, y la prueba de cero asignaciones dependería de eso.
  bind(gl, locs, placed) {
    anchorMatrix(this.matrix, placed.anchorX, placed.anchorY, this.zoom, this.center, this.size)
    gl.uniformMatrix4fv(locs.matrix, false, this.matrix)
    if (locs.scale) gl.uniform1f(locs.scale, 2 ** this.zoom)
  }

  // Px CSS por world0: lo que el shader lee como `projectScale`.
  pixelScaleAt() {
    return 2 ** this.zoom
  }
}

export const createFrameView = () => new FrameView()
