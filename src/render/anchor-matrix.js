// Matriz rel-ancla → clip. `center` va en world0 px y `size` en px CSS. La aritmética es float64 y sólo
// el resultado baja a float32: la traslación es una diferencia world0 que a z18 no entra en 24 bits de
// mantisa.
export const anchorMatrix = (m, anchorX, anchorY, zoom, center, size) => {
  const scale   = 2 ** zoom
  const sx      =  2 * scale / size.x
  const sy      = -2 * scale / size.y
  const originX = center.x - size.x / (2 * scale)          // esquina NW del viewport, en world0
  const originY = center.y - size.y / (2 * scale)
  m.fill(0)
  m[0]  = sx
  m[5]  = sy
  m[10] = 1
  m[12] = sx * (anchorX - originX) - 1
  m[13] = sy * (anchorY - originY) + 1
  m[15] = 1
  return m
}
