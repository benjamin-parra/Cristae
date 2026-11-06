// Canvas 2D de utilería para los tests del IconSet y del atlas: no dibuja, pero devuelve píxeles como el
// real, que es lo que el IconSet lee de cada tile. El renderer de prueba declara qué tile está pintando con
// `ctx.marca` (0–255) y `getImageData` devuelve esos bytes; `reset()` la borra como el contexto real borra
// el lienzo, así que un tile que no la pone sale en 0 y el contexto no arrastra la marca del anterior.
//
//   const { document, contextos, imagenes } = instalarCanvas2d()   // deja `document` e `ImageData` globales
//
// `contextos` lista los contextos de trabajo creados (uno por canvas con `getContext('2d')`), y `imagenes`
// los `putImageData` recibidos (lo que arma `sprite()`).
export const instalarCanvas2d = () => {
  const contextos = []
  const imagenes  = []
  const nuevoCtx  = (canvas, opciones) => {
    const ctx = {
      canvas, opciones, marca: undefined, resets: 0, lecturas: 0,
      reset() { ctx.marca = undefined; ctx.resets++ },
      getImageData(_x, _y, w, h) { ctx.lecturas++; return { data: new Uint8ClampedArray(w * h * 4).fill(ctx.marca ?? 0) } },
      putImageData: (img, x, y) => imagenes.push({ canvas, img, x, y }),
    }
    contextos.push(ctx)
    return ctx
  }
  const document = {
    createElement: () => {
      const canvas = { width: 0, height: 0, getContext: (_tipo, opciones) => (canvas.ctx ??= nuevoCtx(canvas, opciones)) }
      return canvas
    },
  }
  globalThis.document  = document
  globalThis.ImageData = class ImageData { constructor(data, width, height) { Object.assign(this, { data, width, height }) } }
  return { document, contextos, imagenes }
}
