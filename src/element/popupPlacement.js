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

// Las tres etapas como lambdas de módulo (no se recrean por llamada): reciben la caja en curso + el
// contexto derivado, la mutan y la devuelven. `computePlacement` las encadena con un reduce.

// 1. LADO — la caja abre encima por defecto; sólo baja si no entra encima y (entra abajo o hay más
// espacio abajo). `above` es el desempate, así que aquí basta con detectar el vuelco a `below`.
const flipStage = (box, ctx) => {
  const fitsAbove = ctx.topAbove >= ctx.pT
  const fitsBelow = ctx.topBelow + ctx.h <= ctx.pB
  if (!fitsAbove && (fitsBelow || ctx.pB - ctx.topBelow > ctx.anchorY - ctx.gap - ctx.pT)) {
    box.side = 'below'
    box.top = ctx.topBelow
  }
  return box
}

// 2. CLAMP — desliza la caja lo mínimo para entrar en el viewport acolchado; si es más grande que él,
// manda el borde de entrada (izquierda / arriba).
const shiftStage = (box, ctx) => {
  if (box.left + ctx.w > ctx.pR) box.left = ctx.pR - ctx.w
  if (box.left < ctx.pL) box.left = ctx.pL
  if (box.top + ctx.h > ctx.pB) box.top = ctx.pB - ctx.h
  if (box.top < ctx.pT) box.top = ctx.pT
  return box
}

// 3. CLIP — residuo de la caja final contra el viewport REAL (sin padding), como insets para clip-path.
const clipStage = (box, ctx) => {
  const { viewport, w, h } = ctx
  const cTop = Math.max(0, viewport.top - box.top)
  const cRight = Math.max(0, box.left + w - viewport.right)
  const cBottom = Math.max(0, box.top + h - viewport.bottom)
  const cLeft = Math.max(0, viewport.left - box.left)
  if (cTop || cRight || cBottom || cLeft) box.clip = { top: cTop, right: cRight, bottom: cBottom, left: cLeft }
  return box
}

// Pipeline en orden fijo LADO → CLAMP → CLIP. `stages` sólo prende cada etapa (por eso el orden de los
// tokens del atributo es irrelevante); el reduce aplica las prendidas sobre la caja inicial.
const PLACEMENT_STAGES = [
  ['flip', flipStage],
  ['shift', shiftStage],
  ['clip', clipStage],
]

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
  // Contexto derivado que comparten las etapas. Viewport acolchado (pL/pR/pT/pB): sólo para
  // flip/clamp; el clip usa el `viewport` real.
  const ctx = {
    w, h,
    topAbove: anchor.y - gap - h,
    topBelow: anchor.y + gap,
    anchorY: anchor.y, gap, viewport,
    pL: viewport.left + paddingX, pR: viewport.right - paddingX,
    pT: viewport.top + paddingY, pB: viewport.bottom - paddingY,
  }
  // Caja inicial: anclada, lado `above` (default y desempate del flip), sin clip.
  const box0 = { left: anchor.x + offsetX - w / 2, top: ctx.topAbove, side: 'above', clip: null }
  return PLACEMENT_STAGES.reduce((box, [name, stage]) => (stages[name] ? stage(box, ctx) : box), box0)
}
