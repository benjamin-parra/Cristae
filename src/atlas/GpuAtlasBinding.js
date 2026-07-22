// Espejo GPU del Atlas para UN contexto GL. Posee una WebGLTexture y un cursor.
// Sin flag mutable compartido: las dos señales son intrínsecas y describen estado real —
//   regrow  → identidad de objeto distinta (this.#atlas !== atlas)
//   append  → uploaded < atlas.count
// Por eso un 2º/3er mapa montado tarde arranca en cursor 0 y converge solo (multi-mapa gratis). (SPECS §4.2.)

const setF = (gl, program, name, v) => gl.uniform1f(gl.getUniformLocation(program, name), v)

export class GpuAtlasBinding {

  #gl
  #texture
  #programs = []          // programas que muestrean el atlas (visual + picking)
  #atlas = null
  #uploaded = 0

  constructor(gl) {
    this.#gl = gl
    this.#texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.#texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  get texture() { return this.#texture }

  // Registra un programa que muestrea el atlas; le empuja las dims actuales si ya hay generación.
  register(program) {
    this.#programs.push(program)
    if (this.#atlas) this.#applyDims(program, this.#atlas)
    return this
  }

  // Antes de dibujar. Estable = 2 comparaciones [0-alloc]; append = O(Δ); regrow = O(C).
  sync(atlas) {
    const gl = this.#gl
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.#texture)

    if (this.#atlas !== atlas) {                 // regrow / primera generación → re-sube todo
      this.#allocate(atlas)
      for (let i = 0; i < atlas.count; i++) this.#upload(atlas, i)
      this.#atlas = atlas
      this.#uploaded = atlas.count
      this.#programs.forEach(p => this.#applyDims(p, atlas))   // dims → uniforms, sin recompilar
      return
    }
    while (this.#uploaded < atlas.count) {        // append → cursor sobre el log append-only
      this.#upload(atlas, this.#uploaded)
      this.#uploaded++
    }
  }

  destroy() {
    this.#gl.deleteTexture(this.#texture)
    this.#texture = null
    this.#programs = []
    this.#atlas = null
  }

  // Textura del tamaño de la grilla, vacía; los tiles entran por texSubImage2D.
  #allocate(atlas) {
    const gl = this.#gl
    const w = atlas.cols * atlas.tileSize
    const h = atlas.rows * atlas.tileSize
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  }

  #upload(atlas, index) {
    const gl = this.#gl
    const t = atlas.tileSize
    const cell = atlas.cellOf(index)             // scratch [0-alloc]
    gl.texSubImage2D(gl.TEXTURE_2D, 0, cell.col * t, cell.row * t, gl.RGBA, gl.UNSIGNED_BYTE, atlas.tileAt(index))
  }

  // Setea las dims en un programa. Guarda y restaura el programa activo: glify dibuja contra SU
  // programa (set una vez, no por draw); dejar otro activo rompe su uniformMatrix4fv del siguiente
  // frame. Fuera del hot-path (solo en register/regrow) → el getParameter es despreciable.
  #applyDims(program, atlas) {
    const gl = this.#gl
    const prev = gl.getParameter(gl.CURRENT_PROGRAM)
    gl.useProgram(program)
    gl.uniform1i(gl.getUniformLocation(program, 'uAtlas'), 0)
    setF(gl, program, 'uCols', atlas.cols)
    setF(gl, program, 'uRows', atlas.rows)
    setF(gl, program, 'uTileSize', atlas.tileSize)
    setF(gl, program, 'uMaxIndex', Math.max(atlas.capacity - 1, 1))
    gl.useProgram(prev)
  }
}
