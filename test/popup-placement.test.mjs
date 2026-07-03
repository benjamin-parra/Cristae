// Test de popupPlacement.js — geometría pura del keep-in-view de <cristae-popup>.
// Corre con: node test/popup-placement.test.mjs
import { computePlacement, stagesFrom } from '../src/element/popupPlacement.js'

let n = 0, fails = 0
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const check = (name, cond, extra = '') => {
  n++
  if (!cond) { fails++; console.log(`✗ ${name} ${extra}`) }
}

// Viewport canónico 800×600 en (300,100)–(1100,700); caja 300×200; gap 12; padding 20.
const V = { left: 300, top: 100, right: 1100, bottom: 700 }
const SZ = { w: 300, h: 200 }
const ALL = stagesFrom(['flip', 'shift', 'clip'])
const FLIP_CLIP = stagesFrom(['flip', 'clip'])
const CLIP = stagesFrom(['clip'])
const NONE = stagesFrom([])
const base = (over = {}) =>
  ({ anchor: { x: 700, y: 400 }, size: SZ, viewport: V, stages: NONE, gap: 12, paddingX: 20, paddingY: 20, ...over })

// ── stagesFrom: orden irrelevante, tokens desconocidos inertes ──
check('stagesFrom orden irrelevante', eq(stagesFrom(['clip', 'flip']), stagesFrom(['flip', 'clip'])))
check('stagesFrom ignora desconocidos', eq(stagesFrom(['none', 'zzz']), { flip: false, shift: false, clip: false }))

// ── Ancla centrada: abre encima, sin clip ──
{
  const p = computePlacement(base({ stages: ALL }))
  check('centro: side above', p.side === 'above')
  check('centro: left = cx − w/2', p.left === 700 - 150, `got ${p.left}`)
  check('centro: top = y − gap − h', p.top === 400 - 12 - 200, `got ${p.top}`)
  check('centro: sin clip', p.clip === null)
}

// ── Cerca del borde superior: flip a below ──
{
  const p = computePlacement(base({ anchor: { x: 700, y: 200 }, stages: FLIP_CLIP }))
  check('top-edge: side below', p.side === 'below', p.side)
  check('top-edge: top = y + gap', p.top === 200 + 12)
  check('top-edge: sin clip (entra abajo)', p.clip === null)
}

// ── El padding ANTICIPA el flip: entra sin padding pero no con él → voltea ──
{
  const p = computePlacement(base({ anchor: { x: 700, y: 325 }, stages: FLIP_CLIP }))
  check('anticipación: flip antes de tocar el borde', p.side === 'below', p.side)
}

// ── No entra en ningún lado → gana el de más espacio (empate → encima) ──
{
  const vShort = { left: 300, top: 100, right: 1100, bottom: 340 }
  const arriba = computePlacement(base({ anchor: { x: 700, y: 150 }, viewport: vShort, stages: FLIP_CLIP }))
  check('ninguno entra: más espacio abajo → below', arriba.side === 'below', arriba.side)
  const abajo = computePlacement(base({ anchor: { x: 700, y: 320 }, viewport: vShort, stages: FLIP_CLIP }))
  check('ninguno entra: más espacio arriba → above', abajo.side === 'above', abajo.side)
}

// ── Clip: corta EXACTO en el borde real (no en el acolchado) ──
{
  const p = computePlacement(base({ anchor: { x: 320, y: 400 }, stages: CLIP }))
  check('clip.left exacto', p.clip?.left === 130, JSON.stringify(p.clip))
  check('clip no toca otros lados', p.clip?.right === 0 && p.clip?.top === 0 && p.clip?.bottom === 0)
}

// ── Caja totalmente fuera → el inset supera el lado (invisible) ──
{
  const p = computePlacement(base({ anchor: { x: -200, y: 400 }, stages: CLIP }))
  check('fuera total: clip.left ≥ w', p.clip !== null && p.clip.left >= SZ.w, JSON.stringify(p.clip))
}

// ── Shift: clamp al viewport acolchado; tras el clamp no queda clip ──
{
  const p = computePlacement(base({ anchor: { x: 1090, y: 400 }, stages: ALL }))
  check('shift: left clampeado a pR − w', p.left === 1100 - 20 - 300, `got ${p.left}`)
  check('shift: sin clip tras clamp', p.clip === null)
}

// ── Caja más ancha que el viewport → manda el borde de entrada ──
{
  const p = computePlacement(base({ size: { w: 900, h: 200 }, stages: ALL }))
  check('caja ancha: left = pL', p.left === 320, `got ${p.left}`)
  check('caja ancha: clip sólo derecha', p.clip !== null && p.clip.right > 0 && p.clip.left === 0, JSON.stringify(p.clip))
}

// ── offsetX corre el centro; gap gobierna la separación en ambos lados ──
{
  const p = computePlacement(base({ offsetX: 40, gap: 30 }))
  check('offsetX corre el centro', p.left === 700 + 40 - 150)
  check('gap gobierna la separación', p.top === 400 - 30 - 200)
  const pb = computePlacement(base({ anchor: { x: 700, y: 200 }, gap: 30, stages: FLIP_CLIP }))
  check('gap simétrico al voltear', pb.side === 'below' && pb.top === 230, `${pb.side} ${pb.top}`)
}

// ── Determinismo: misma entrada ⇒ misma salida ──
{
  const input = base({ anchor: { x: 333, y: 222 }, stages: ALL })
  check('determinismo', eq(computePlacement(input), computePlacement(input)))
}

// ── INVARIANTE en grilla exhaustiva: clip = residuo exacto de la caja final vs viewport real ──
{
  let bad = 0
  for (const st of [CLIP, FLIP_CLIP, ALL])
    for (let x = -300; x <= 1500; x += 90)
      for (let y = -300; y <= 1000; y += 85) {
        const p = computePlacement(base({ anchor: { x, y }, stages: st }))
        const t = Math.max(0, V.top - p.top)
        const r = Math.max(0, p.left + SZ.w - V.right)
        const b = Math.max(0, p.top + SZ.h - V.bottom)
        const l = Math.max(0, V.left - p.left)
        const exp = (t || r || b || l) ? { top: t, right: r, bottom: b, left: l } : null
        if (!eq(p.clip, exp)) bad++
      }
  check('invariante clip = residuo real (grilla × 3 stage-sets)', bad === 0, `${bad} rotos`)
}

// ── Sin etapas: ancla pura, nada más ──
{
  const p = computePlacement(base({ anchor: { x: -500, y: -500 } }))
  check('sin etapas: no clampa ni clipa', p.clip === null && p.left === -650 && p.side === 'above')
}

console.log(fails === 0 ? `✓ ${n} checks OK` : `✗ ${fails}/${n} FALLARON`)
process.exit(fails ? 1 : 0)
