// Píxeles del DRAWING BUFFER por píxel CSS del canvas. Es la unidad de todo lo que GL expresa en
// píxeles —`gl_PointSize`, el recorte del pase de picking— y NO es `devicePixelRatio`: dice a qué
// resolución rinde ESTA superficie, y en un mismo documento conviven superficies de distinta densidad.
// Un canvas sin caja en pantalla —aparcado, display:none— o sin buffer —un contexto perdido dice 0— no tiene
// escala observable: vale 1, que es la que rige mientras no se dibuja. Un 0 anularía todo lo que se multiplique
// por ella: el tamaño de los sprites, el origen del recorte del pase de picking.
export const pixelScaleOf = gl => {
  const css = gl?.canvas?.clientWidth || 0
  const px  = gl?.drawingBufferWidth || 0
  return css > 0 && px > 0 ? px / css : 1
}
