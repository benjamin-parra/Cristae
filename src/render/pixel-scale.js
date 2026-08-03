// Píxeles del DRAWING BUFFER por píxel CSS del canvas. Es la unidad de todo lo que GL expresa en
// píxeles —`gl_PointSize`, el recorte del pase de picking— y NO es `devicePixelRatio`: dice a qué
// resolución rinde ESTA superficie, y en un mismo documento conviven las dos (glify dimensiona su canvas
// en px CSS; la superficie de edición, en px CSS × DPR). Un canvas sin caja en pantalla —aparcado,
// display:none— no tiene escala observable: vale 1, que es la que rige mientras no se dibuja.
export const pixelScaleOf = gl => {
  const css = gl?.canvas?.clientWidth || 0
  return css > 0 ? gl.drawingBufferWidth / css : 1
}
