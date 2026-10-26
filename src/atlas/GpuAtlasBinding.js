// Espejo GPU del Atlas para UN contexto GL. Posee una WebGLTexture y un cursor.
// Sin flag mutable compartido: las dos señales son intrínsecas y describen estado real —
//   regrow  → identidad de objeto distinta (this.#atlas !== atlas)
//   append  → uploaded < atlas.count
// Por eso un 2º/3er mapa montado tarde arranca en cursor 0 y converge solo (multi-mapa gratis). (SPECS §4.2.)
//
// Etapa 4 del pipeline del atlas (ver IconSet): lo que se sube son las celdas PEDIDAS (`count`), nunca el espacio
// declarado, y los tiles son píxeles RGBA contiguos, así que cada subida es una copia de memoria sin conversión:
//   adquirir / regrow  → una reserva (`texImage2D` sin datos) + UNA `texSubImage2D` por fila ocupada de la grilla
//                        (en Firefox, 199 subidas desde canvases sueltos eran ~440 ms; así son decenas)
//   variante nueva     → UNA `texSubImage2D` de su tile, en el `sync` del dibujo que la pidió

const setF = (gl, program, name, v) => gl.uniform1f(gl.getUniformLocation(program, name), v)

export class GpuAtlasBinding {

  #gl
  #texture
  #programs = []          // programas que muestrean el atlas (visual + picking)
  #atlas    = null
  #uploaded = 0

  constructor(gl) {
    this.#gl      = gl
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

    if (this.#atlas !== atlas) {                 // regrow / primera generación → re-sube lo pedido
      this.#allocate(atlas)
      // Las celdas ocupadas, una subida por fila de la grilla: las filas de píxeles de los tiles de la fila se
      // juntan en una banda de `n·t` px de ancho (una copia de memoria por tile) y la banda sube de una vez. Una
      // fila de un solo tile sube el tile tal cual. La banda de trabajo mide una fila de la grilla, no el atlas,
      // y no sobrevive a la subida.
      const { cols, count, tileSize: t } = atlas
      const rowBytes = t * 4
      let band = null
      for (let first = 0; first < count; first += cols) {
        const n = Math.min(cols, count - first)
        let pixels = atlas.tileAt(first)
        if (n > 1) {
          band ??= new Uint8Array(cols * t * rowBytes)
          for (let c = 0; c < n; c++) {
            const tile = atlas.tileAt(first + c)
            for (let y = 0; y < t; y++) band.set(tile.subarray(y * rowBytes, (y + 1) * rowBytes), (y * n * t + c * t) * 4)
          }
          pixels = band.subarray(0, n * t * rowBytes)
        }
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, first / cols * t, n * t, t, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      }
      this.#atlas    = atlas
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
    this.#texture  = null
    this.#programs = []
    this.#atlas    = null
  }

  // Textura del tamaño de la grilla, vacía; los tiles entran por texSubImage2D (sólo los pedidos).
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
    gl.texSubImage2D(gl.TEXTURE_2D, 0, cell.col * t, cell.row * t, t, t, gl.RGBA, gl.UNSIGNED_BYTE, atlas.tileAt(index))
  }

  // Setea las dims en un programa. Deja ese programa activo: cada draw fija el suyo antes de dibujar.
  #applyDims(program, atlas) {
    const gl = this.#gl
    gl.useProgram(program)
    gl.uniform1i(gl.getUniformLocation(program, 'uAtlas'), 0)
    setF(gl, program, 'uCols', atlas.cols)
    setF(gl, program, 'uRows', atlas.rows)
    setF(gl, program, 'uTileSize', atlas.tileSize)
    setF(gl, program, 'uMaxIndex', Math.max(atlas.capacity - 1, 1))
  }
}
