// Las opciones de `<cristae-labeled>` y de `addLabels`: la mezcla con la validación que depende sólo de
// las props, y la colocación que resulta sobre cada tipo de capa. Puro: sin DOM, sin motor.

// La fuente y los colores de `<cristae-label-layer>`: una línea y un punto rotulados se ven iguales.
export const LABEL_DEFAULTS = Object.freeze({
  textOf      : null,
  htmlOf      : null,
  renderer    : 'canvas',
  placement   : 'auto',
  repeat      : null,
  offset      : 0,
  orientation : 'auto',
  font        : '700 10.5px Inter, ui-sans-serif, system-ui, -apple-system, sans-serif',
  color       : '#0f172a',
  halo        : '#ffffff',
  paint       : null,
  interactive : false,
  visible     : true,
})

const RENDERERS    = new Set(['canvas', 'html'])
const PLACEMENTS   = new Set(['auto', 'along', 'center', 'above', 'below', 'right'])
const ORIENTATIONS = new Set(['auto', 'path'])
const FUNCTIONS    = ['textOf', 'htmlOf', 'paint']
const STRINGS      = ['font', 'color', 'halo']
const BOOLEANS     = ['interactive', 'visible']
const KEYS         = Object.keys(LABEL_DEFAULTS)

// El renderer declarado, aparte del vigente: sin declarar, lo decide `htmlOf` en cada mezcla.
const DECLARED = Symbol('renderer declarado')

// Sobre puntos, HTML y burbujas, `auto` deja el texto debajo del ícono, que en una burbuja ya pinta el
// conteo. Las líneas lo llevan por el trazo y los polígonos y las formas en su centro.
const NATURAL = { point: 'below', html: 'below', bubble: 'below', line: 'along', polygon: 'center', shape: 'center' }
const AROUND  = ['center', 'above', 'below', 'right']
const ADMITS  = {
  point   : AROUND,
  html    : AROUND,
  bubble  : AROUND,
  line    : ['along', 'center'],
  polygon : ['along', 'center'],
  shape   : ['center'],
}

const fail = message => { throw new TypeError(`[cristae] ${message}`) }

/** Mezcla `patch` sobre `prev` (o sobre los defectos, si `prev` es null) y devuelve un objeto nuevo:
 *  `undefined` no cambia y `null` vuelve al defecto. Las claves que no son opciones se ignoran. Lanza
 *  `TypeError` por lo que depende sólo de las props antes de devolver, así quien la llama no tocó su
 *  estado. */
export const mergeLabelOptions = (prev, patch = {}) => {
  const next = { ...(prev ?? LABEL_DEFAULTS) }
  KEYS.forEach(key => patch[key] !== undefined && (next[key] = patch[key] ?? LABEL_DEFAULTS[key]))
  if (patch.renderer !== undefined) next[DECLARED] = patch.renderer ?? undefined
  const { htmlOf, interactive, paint, placement, repeat, offset, orientation } = next
  const declared = next[DECLARED]
  const renderer = next.renderer = declared ?? (htmlOf ? 'html' : 'canvas')

  FUNCTIONS.forEach(key => next[key] === null || typeof next[key] === 'function' || fail(`${key}: se espera una función, o null`))
  STRINGS.forEach(key => typeof next[key] === 'string' || fail(`${key} ${next[key]}: se espera un string`))
  BOOLEANS.forEach(key => typeof next[key] === 'boolean' || fail(`${key} ${next[key]}: se espera un booleano`))
  if (renderer === 'gl') fail(`renderer 'gl': está pendiente; por ahora 'canvas' o 'html'`)
  if (!RENDERERS.has(renderer)) fail(`renderer '${renderer}': se espera 'canvas' o 'html'`)
  if (!PLACEMENTS.has(placement)) fail(`placement '${placement}': se espera ${[...PLACEMENTS].map(p => `'${p}'`).join(', ')}`)
  if (!ORIENTATIONS.has(orientation)) fail(`orientation '${orientation}': se espera 'auto' o 'path'`)
  if (repeat !== null && !(Number.isFinite(repeat) && repeat > 0)) fail(`repeat ${repeat}: se espera un número finito > 0, o null`)
  if (!Number.isFinite(offset)) fail(`offset ${offset}: se espera un número finito`)
  if (htmlOf && renderer !== 'html') fail(`htmlOf pide renderer 'html', no '${renderer}'`)
  if (interactive && renderer !== 'html') fail(`interactive pide renderer 'html', no '${renderer}'`)
  if (paint && renderer !== 'canvas') fail(`paint pide renderer 'canvas', no '${renderer}'`)
  if (paint && placement !== 'auto' && placement !== 'center') fail(`paint pide placement 'auto' o 'center', no '${placement}'`)
  if (placement !== 'auto' && placement !== 'along' && (repeat !== null || orientation !== 'auto'))
    fail(`repeat y orientation sólo valen sobre el trazo: placement '${placement}' no es 'along'`)
  return next
}

/** La colocación de un rótulo sobre una capa de tipo `kind`, con las opciones ya mezcladas. `auto` da la
 *  natural de la capa, o `center` con `paint`, que pone el rótulo donde quiere respecto de su punto. Un
 *  `placement` explícito que la capa no admite lanza `TypeError`. */
export const resolvePlacement = (kind, opts) => {
  const admits = ADMITS[kind] ?? fail(`no se rotula una capa de tipo '${kind}'`)
  const asked  = opts.placement
  return asked === 'auto' ? (opts.paint ? 'center' : NATURAL[kind])
    : admits.includes(asked) ? asked
    : fail(`placement '${asked}' no aplica a una capa de tipo '${kind}': admite ${admits.map(p => `'${p}'`).join(', ')}`)
}
