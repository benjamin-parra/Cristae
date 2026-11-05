// La medida de los rótulos: cada texto partido en grafemas y el ancho de cada uno en su fuente. Sin DOM
// propio: mide con el contexto 2D que recibe, del que sólo usa `font` y `measureText`.
//
// La unidad es el grafema y no el punto de código: una vocal con su tilde combinante, una bandera o un
// emoji unido con ZWJ se colocan como uno. Cada grafema se mide suelto, así que con `along` se pierden el
// kerning y las ligaduras entre ellos.

const MAX_LAYOUTS = 4096                  // textos distintos cacheados por fuente antes de vaciar
const SEGMENTER   = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// El alto de la fuente cuando el contexto no informa su caja: el tamaño en px que declara la fuente.
const sizeOf = font => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10)

/** La medida sobre `ctx`. `glyphs(font, text)` devuelve un `Glyphs` inmutable, el mismo objeto mientras
 *  la fuente no se olvide; `forget(font)` vacía lo de esa fuente, por ejemplo cuando termina de cargar. */
export const createMeasure = ctx => {
  const fonts = new Map()                 // font → { widths: grafema → ancho, layouts: texto → Glyphs }

  const glyphs = (font, text) => {
    let known = fonts.get(font)
    known || fonts.set(font, known = { widths: new Map(), layouts: new Map() })
    const hit = known.layouts.get(text)
    if (hit) return hit

    known.layouts.size >= MAX_LAYOUTS && known.layouts.clear()
    ctx.font = font
    const units  = Array.from(SEGMENTER.segment(text), s => s.segment)
    const widths = new Float64Array(units.length)
    units.forEach((unit, i) => {
      let w = known.widths.get(unit)
      w === undefined && known.widths.set(unit, w = ctx.measureText(unit).width)
      widths[i] = w
    })
    const box    = ctx.measureText(text)
    const size   = sizeOf(font)
    const layout = Object.freeze({
      text,
      units   : Object.freeze(units),
      widths,
      total   : widths.reduce((sum, w) => sum + w, 0),
      ascent  : box.fontBoundingBoxAscent ?? box.actualBoundingBoxAscent ?? size * 0.8,
      descent : box.fontBoundingBoxDescent ?? box.actualBoundingBoxDescent ?? size * 0.2,
    })
    known.layouts.set(text, layout)
    return layout
  }

  return { glyphs, forget: font => fonts.delete(font) }
}
