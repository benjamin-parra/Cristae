// Geometría PURA del keep-in-view de un overlay anclado: sin DOM, sin estado, misma
// entrada ⇒ misma salida. Coordenadas de página (px). La usa <cristae-popup> para su
// encuadre `fit`; sirve para cualquier overlay anclado a un punto.
//
// MODELO. Una caja de tamaño `size` se ancla a un punto `anchor` y convive con una
// región visible `viewport` (contenedor menos insets). Tres etapas en orden fijo —
// `stages` sólo activa cada una, así el orden de los tokens del atributo es irrelevante:
//
//   1. LADO (flip)    La caja abre ENCIMA del ancla; si no entra encima y sí debajo,
//                     abre debajo; si no entra en ninguno, gana el lado con más espacio
//                     (empate → encima). Sin memoria: sólo la geometría del frame.
//   2. CLAMP (shift)  Desliza la caja lo mínimo para entrar en el viewport acolchado.
//                     Si la caja es más grande, manda el borde de entrada (izq/arriba).
//   3. CLIP           El residuo contra el viewport REAL (sin padding) se reporta como
//                     insets para clip-path: el corte cae exactamente en el borde. El
//                     padding sólo anticipa flip/clamp, nunca corre el corte.
//
// La caja resultante es literal: `left/top` es su esquina superior-izquierda final.

/** Etapas activas a partir de los tokens de `fit` (orden irrelevante). */
export function stagesFrom(tokens) {
  const t = new Set(tokens)
  return { flip: t.has('flip'), shift: t.has('shift'), clip: t.has('clip') }
}

/**
 * @param {object}   input
 * @param {{x: number, y: number}} input.anchor    punto anclado
 * @param {{w: number, h: number}} input.size      tamaño real de la caja
 * @param {{left: number, top: number, right: number, bottom: number}} input.viewport región visible
 * @param {{flip: boolean, shift: boolean, clip: boolean}} input.stages etapas activas
 * @param {number} [input.offsetX]  corrimiento horizontal del ancla
 * @param {number} [input.gap]      separación vertical ancla↔caja, simétrica en ambos lados
 * @param {number} [input.paddingX] colchón de anticipación de flip/clamp
 * @param {number} [input.paddingY]
 * @returns {{left: number, top: number, side: 'above'|'below',
 *            clip: {top: number, right: number, bottom: number, left: number} | null}}
 */
export function computePlacement({ anchor, size, viewport, stages, offsetX = 0, gap = 12, paddingX = 20, paddingY = 20 }) {
  const { w, h } = size
  // Viewport acolchado: sólo para flip/clamp. El clip usa el real.
  const pL = viewport.left + paddingX, pR = viewport.right - paddingX
  const pT = viewport.top + paddingY, pB = viewport.bottom - paddingY

  // 1. LADO
  const cx = anchor.x + offsetX
  const topAbove = anchor.y - gap - h
  const topBelow = anchor.y + gap
  let side = 'above'
  if (stages.flip) {
    const fitsAbove = topAbove >= pT
    const fitsBelow = topBelow + h <= pB
    if (!fitsAbove && (fitsBelow || pB - topBelow > anchor.y - gap - pT)) side = 'below'
  }
  let left = cx - w / 2
  let top = side === 'above' ? topAbove : topBelow

  // 2. CLAMP
  if (stages.shift) {
    if (left + w > pR) left = pR - w
    if (left < pL) left = pL
    if (top + h > pB) top = pB - h
    if (top < pT) top = pT
  }

  // 3. CLIP
  let clip = null
  if (stages.clip) {
    const cTop = Math.max(0, viewport.top - top)
    const cRight = Math.max(0, left + w - viewport.right)
    const cBottom = Math.max(0, top + h - viewport.bottom)
    const cLeft = Math.max(0, viewport.left - left)
    if (cTop || cRight || cBottom || cLeft) clip = { top: cTop, right: cRight, bottom: cBottom, left: cLeft }
  }

  return { left, top, side, clip }
}
