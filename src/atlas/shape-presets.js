import { defineIconSet } from './IconSet.js'

// Presets de FORMA — paridad de presets para no exigir la autoría de un IconSet por un marcador simple.
// El consumidor sólo elige una forma (`dot`/`pin`/`circle`) y mapea `variantOf => hex`; obtiene esa forma
// pintada en ese color, sin escribir un renderer canvas. Todo agnóstico: la VARIANTE es el color de
// relleno (un hex opaco), el core no interpreta dominio.
//
// La variante ES el color: `describe(variant) => { shape, color: variant }` es TOTAL por construcción
// (cualquier string entra como color; un hex inválido degrada al negro del canvas, nunca lanza — el
// mismo contrato de degradación silenciosa que documenta IconSet). `shape` queda cerrado por preset.

// Cada renderer pinta UNA forma sobre el tile cuadrado de lado `size` (el canvas del atlas), centrada,
// con un margen para que el sprite no toque el borde. Reciben el descriptor `{ shape, color }` y leen
// sólo `color`. Puros: nada de estado, nada de dominio.

// Disco relleno que ocupa casi todo el tile.
const dot = (ctx, size, d) => {
  const c = size / 2
  ctx.beginPath()
  ctx.arc(c, c, size * 0.42, 0, Math.PI * 2)
  ctx.fillStyle = d.color
  ctx.fill()
}

// Anillo (círculo hueco): trazo grueso, centro transparente.
const circle = (ctx, size, d) => {
  const c      = size / 2
  const grosor = size * 0.16
  ctx.beginPath()
  ctx.arc(c, c, size * 0.42 - grosor / 2, 0, Math.PI * 2)
  ctx.lineWidth = grosor
  ctx.strokeStyle = d.color
  ctx.stroke()
}

// Gota/teardrop: bulbo redondo arriba + punta abajo (el "pin" de mapa clásico). Los flancos son las
// tangentes desde la punta al bulbo, así el contorno es continuo sin quiebre. El semiángulo de la
// tangente sale del triángulo rectángulo punta-centro-tangente: acos(radio / distancia).
//
// Anclaje: el atlas centra el sprite en la coordenada (no hay anchor-offset), así que la PUNTA — el
// vértice que marca el punto — debe caer en el CENTRO del tile (size/2, size/2), igual que el dot/circle
// se centran ahí. El bulbo queda ARRIBA de la punta, dentro de la mitad superior del tile.
const pin = (ctx, size, d) => {
  const cx    = size / 2
  const tipY  = size / 2               // la punta marca el punto → centro exacto del tile
  const cy    = size * 0.24            // bulbo arriba de la punta
  const r     = size * 0.2
  const alpha = Math.acos(Math.min(1, r / (tipY - cy)))
  ctx.beginPath()
  // Arco mayor: del flanco izquierdo por arriba al derecho (sentido horario cubre el tope del bulbo).
  ctx.arc(cx, cy, r, Math.PI / 2 + alpha, Math.PI / 2 - alpha)
  ctx.lineTo(cx, tipY)                 // baja a la punta
  ctx.closePath()                      // cierra contra el flanco izquierdo
  ctx.fillStyle = d.color
  ctx.fill()
}

// Mapa forma → renderer. Exportado para que un consumidor COMPONGA su propio IconSet reusando una forma
// (p. ej. mezclar `dot` con un renderer propio) sin re-implementarla.
export const RENDERERS = { dot, pin, circle }

// Fabrica un IconSet de forma fija donde la variante es el color de relleno. `size` = tamaño en pantalla
// por defecto del sprite (default del IconSet). El tile del canvas queda en el default del IconSet.
export const shapePresetIconSet = ({ shape = 'dot', size } = {}) => {
  const render = RENDERERS[shape]
  if (!render) throw new Error(`[shapePresetIconSet] forma desconocida '${shape}' (usar ${Object.keys(RENDERERS).join('/')})`)
  return defineIconSet({
    rotates:   false,                  // una forma coloreada no tiene rumbo: nunca rota
    sizes:     size ? { default: size } : undefined,
    describe:  (variant) => ({ shape, color: variant }),
    renderers: { [shape]: render },
  })
}
