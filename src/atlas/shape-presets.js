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

// Flecha de un color con la punta al NORTE del tile (rumbo 0), para rotar por `headingOf`. Es una punta de
// flecha con muesca en la cola (chevron relleno). Anclaje como `dot`: el centro del tile es el punto, y la
// flecha queda centrada en él para que al rotar gire sobre su centro. Las fracciones de `size` salen de
// dejar el mismo margen que `dot` (0.42 de radio → 0.08 libre) y de una base más angosta que el largo,
// que es lo que hace legible el rumbo a tamaños chicos.
const ARROW_TIP_Y   = -0.42   // punta, sobre el centro (el margen del dot)
const ARROW_WING_Y  = 0.42    // esquinas de la cola, bajo el centro (simétrico a la punta)
const ARROW_WING_X  = 0.32    // semiancho de la base: ~0.76 del largo
const ARROW_NOTCH_Y = 0.2     // muesca de la cola: a ~3/4 del largo desde la punta
const arrow = (ctx, size, d) => {
  const c = size / 2
  ctx.beginPath()
  ctx.moveTo(c, c + size * ARROW_TIP_Y)
  ctx.lineTo(c + size * ARROW_WING_X, c + size * ARROW_WING_Y)
  ctx.lineTo(c, c + size * ARROW_NOTCH_Y)
  ctx.lineTo(c - size * ARROW_WING_X, c + size * ARROW_WING_Y)
  ctx.closePath()
  ctx.fillStyle = d.color
  ctx.fill()
}

// Mapa forma → renderer. Exportado para que un consumidor COMPONGA su propio IconSet reusando una forma
// (p. ej. mezclar `dot` con un renderer propio) sin re-implementarla.
export const RENDERERS = { dot, pin, circle, arrow }

// Formas que ofrecen los sets de fábrica, en orden estable.
export const FACTORY_SHAPES = ['dot', 'pin', 'circle', 'arrow']

// Color de respaldo de los sets de fábrica cuando el dato no trae variante: el azul de las burbujas de
// cluster del motor (`#2563eb`), para que un marcador sin color se vea de la misma familia.
export const DEFAULT_SHAPE_COLOR = '#2563eb'

// Fabrica un IconSet de forma fija donde la variante es el color de relleno. `size` = tamaño en pantalla
// por defecto del sprite (default del IconSet). El tile del canvas queda en el default del IconSet.
// `fallback` (opcional): color para la variante vacía. Sin él, el descriptor es el de siempre. Sólo `arrow`
// rota: es la única forma con rumbo.
export const shapePresetIconSet = ({ shape = 'dot', size, fallback } = {}) => {
  const render = RENDERERS[shape]
  if (!render) throw new Error(`[shapePresetIconSet] forma desconocida '${shape}' (usar ${Object.keys(RENDERERS).join('/')})`)
  return defineIconSet({
    rotates:   shape === 'arrow',      // la flecha apunta al norte y rota por rumbo; el resto no tiene rumbo
    sizes:     size ? { default: size } : undefined,
    describe:  fallback ? variant => ({ shape, color: variant || fallback }) : variant => ({ shape, color: variant }),
    renderers: { [shape]: render },
  })
}
