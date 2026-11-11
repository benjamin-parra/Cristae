// Matrices 4×4 en float64 para la cámara agnóstica. Column-major y con el mismo clip (z en [-1, 1],
// mano derecha, la cámara mira hacia -z) que gl-matrix, de donde salen las fórmulas. Cada función escribe
// en `out` y lo devuelve: cero asignaciones por llamada. `out` puede ser también una de las entradas.

export const create = () => {
  const out = new Float64Array(16)
  out[0] = out[5] = out[10] = out[15] = 1
  return out
}

export const multiply = (out, a, b) => {
  const a00 = a[0],  a01 = a[1],  a02 = a[2],  a03 = a[3]
  const a10 = a[4],  a11 = a[5],  a12 = a[6],  a13 = a[7]
  const a20 = a[8],  a21 = a[9],  a22 = a[10], a23 = a[11]
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15]

  for (let i = 0; i < 16; i += 4) {
    const b0 = b[i], b1 = b[i + 1], b2 = b[i + 2], b3 = b[i + 3]
    out[i]     = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
    out[i + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
    out[i + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
    out[i + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33
  }
  return out
}

// Inversa por cofactores. Devuelve null, sin tocar `out`, si la matriz es singular.
export const invert = (out, a) => {
  const a00 = a[0],  a01 = a[1],  a02 = a[2],  a03 = a[3]
  const a10 = a[4],  a11 = a[5],  a12 = a[6],  a13 = a[7]
  const a20 = a[8],  a21 = a[9],  a22 = a[10], a23 = a[11]
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15]

  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32

  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (!det) return null

  const inv = 1 / det
  out[0]  = (a11 * b11 - a12 * b10 + a13 * b09) * inv
  out[1]  = (a02 * b10 - a01 * b11 - a03 * b09) * inv
  out[2]  = (a31 * b05 - a32 * b04 + a33 * b03) * inv
  out[3]  = (a22 * b04 - a21 * b05 - a23 * b03) * inv
  out[4]  = (a12 * b08 - a10 * b11 - a13 * b07) * inv
  out[5]  = (a00 * b11 - a02 * b08 + a03 * b07) * inv
  out[6]  = (a32 * b02 - a30 * b05 - a33 * b01) * inv
  out[7]  = (a20 * b05 - a22 * b02 + a23 * b01) * inv
  out[8]  = (a10 * b10 - a11 * b08 + a13 * b06) * inv
  out[9]  = (a01 * b08 - a00 * b10 - a03 * b06) * inv
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * inv
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * inv
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * inv
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * inv
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * inv
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * inv
  return out
}

// `far` puede ser Infinity: da la proyección con plano lejano en el infinito.
export const perspective = (out, fovy, aspect, near, far) => {
  const f = 1 / Math.tan(fovy / 2)
  out.fill(0)
  out[0]  = f / aspect
  out[5]  = f
  out[11] = -1
  if (far === Infinity) {
    out[10] = -1
    out[14] = -2 * near
  } else {
    const nf = 1 / (near - far)
    out[10] = (far + near) * nf
    out[14] = 2 * far * near * nf
  }
  return out
}

export const ortho = (out, l, r, b, t, n, f) => {
  const lr = 1 / (l - r)
  const bt = 1 / (b - t)
  const nf = 1 / (n - f)
  out.fill(0)
  out[0]  = -2 * lr
  out[5]  = -2 * bt
  out[10] = 2 * nf
  out[12] = (l + r) * lr
  out[13] = (t + b) * bt
  out[14] = (f + n) * nf
  out[15] = 1
  return out
}

// lookAt: la matriz de vista de un ojo en `eye` que mira a `target`, con `up` aproximado. Los tres son
// [x, y, z]. Si el ojo coincide con el objetivo, o `up` es paralelo a la mirada, devuelve la identidad.
export const fromPose = (out, eye, target, up) => {
  const ex = eye[0], ey = eye[1], ez = eye[2]

  let z0 = ex - target[0], z1 = ey - target[1], z2 = ez - target[2]
  let len = Math.hypot(z0, z1, z2)
  if (!len) return identity(out)
  z0 /= len; z1 /= len; z2 /= len

  let x0 = up[1] * z2 - up[2] * z1
  let x1 = up[2] * z0 - up[0] * z2
  let x2 = up[0] * z1 - up[1] * z0
  len = Math.hypot(x0, x1, x2)
  if (!len) return identity(out)
  x0 /= len; x1 /= len; x2 /= len

  const y0 = z1 * x2 - z2 * x1
  const y1 = z2 * x0 - z0 * x2
  const y2 = z0 * x1 - z1 * x0

  out[0]  = x0; out[1]  = y0; out[2]  = z0; out[3]  = 0
  out[4]  = x1; out[5]  = y1; out[6]  = z1; out[7]  = 0
  out[8]  = x2; out[9]  = y2; out[10] = z2; out[11] = 0
  out[12] = -(x0 * ex + x1 * ey + x2 * ez)
  out[13] = -(y0 * ex + y1 * ey + y2 * ez)
  out[14] = -(z0 * ex + z1 * ey + z2 * ez)
  out[15] = 1
  return out
}

const identity = out => {
  out.fill(0)
  out[0] = out[5] = out[10] = out[15] = 1
  return out
}

// out4 = m · (x, y, z, w)
export const transform = (out4, m, x, y, z, w) => {
  out4[0] = m[0] * x + m[4] * y + m[8]  * z + m[12] * w
  out4[1] = m[1] * x + m[5] * y + m[9]  * z + m[13] * w
  out4[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w
  out4[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w
  return out4
}
