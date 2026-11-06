// La transformación proyectiva que lleva una caja de `w × h` px, con su esquina superior izquierda en el
// origen, a un cuadrilátero de destino. Pura y sin DOM: la usa la capa de imagen para su `matrix3d`.
//
// `corners` son las cuatro esquinas de destino en el orden de la caja —superior izquierda, superior
// derecha, inferior derecha, inferior izquierda—, como ocho números planos [x0, y0, … x3, y3]. Devuelve
// los 16 términos de la `matrix3d` de CSS, por columnas. Un cuadrilátero de área cero o no convexo lanza
// `TypeError`: una homografía que lleva un rectángulo a uno no convexo pasa por w = 0 dentro de la imagen,
// y el navegador la dibuja partida o espejada. El sentido inverso es convexo y da la imagen espejada.
//
// La homografía se resuelve con la primera esquina en el origen y su posición se suma al final. Con las
// esquinas a millones de px, restarlas antes conserva los decimales que la perspectiva amplifica.
// Heckbert, «Fundamentals of Texture Mapping and Image Warping» (1989), §2.2.3: cuadrado unidad →
// cuadrilátero.

const cross = (ax, ay, bx, by) => ax * by - ay * bx

export const quadTransform = (w, h, corners) => {
  const [x0, y0] = corners
  const x1 = corners[2] - x0, y1 = corners[3] - y0
  const x2 = corners[4] - x0, y2 = corners[5] - y0
  const x3 = corners[6] - x0, y3 = corners[7] - y0
  // El giro en cada vértice, con la arista que entra y la que sale: convexo si los cuatro tienen el mismo
  // signo y ninguno es cero. Un moño tiene dos de cada signo; uno cóncavo, tres contra uno.
  const t0 = cross(x1, y1, x3, y3)
  const t1 = cross(x2 - x1, y2 - y1, -x1, -y1)
  const t2 = cross(x3 - x2, y3 - y2, x1 - x2, y1 - y2)
  const t3 = cross(-x3, -y3, x2 - x3, y2 - y3)
  if (!(w > 0 && h > 0 && (t0 > 0 && t1 > 0 && t2 > 0 && t3 > 0 || t0 < 0 && t1 < 0 && t2 < 0 && t3 < 0)))
    throw new TypeError('[cristae] las esquinas de la imagen no forman un cuadrilátero convexo con área')

  const sx  = x2 - x1 - x3
  const sy  = y2 - y1 - y3
  const den = cross(x1 - x2, y1 - y2, x3 - x2, y3 - y2)
  const g   = cross(sx, sy, x3 - x2, y3 - y2) / den
  const k   = cross(x1 - x2, y1 - y2, sx, sy) / den
  // x = (a·u + b·v) / (g·u + k·v + 1) con u, v en [0, 1]; dividir por w y h lleva la caja de px a ese
  // cuadrado. Con la traslación (x0, y0) sumada tras la división, la fila de la perspectiva la multiplica.
  const a = (x1 + g * x1) / w, b = (x3 + k * x3) / h
  const d = (y1 + g * y1) / w, e = (y3 + k * y3) / h
  const p = g / w, q = k / h
  return [
    a + x0 * p, d + y0 * p, 0, p,
    b + x0 * q, e + y0 * q, 0, q,
    0, 0, 1, 0,
    x0, y0, 0, 1,
  ]
}
