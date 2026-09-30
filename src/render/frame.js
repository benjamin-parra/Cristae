// El transform con que un nodo cuelga del marco que sigue al paneo: su posición en el marco —la del
// origen del contenedor es `camera.frameOrigin()`— y, en un frame de zoom animado, la escala que lo lleva
// al destino.
export const frameTransform = (x, y, scale = 1) =>
  `translate3d(${x}px, ${y}px, 0)${scale === 1 ? '' : ` scale(${scale})`}`
