import { anchorMatrix } from './anchor-matrix.js'
import { EditSurface } from './EditSurface.js'
import { sharedProgram } from './gl-programs.js'
import { anchorAt, midAlong, poleOf } from './labelAnchor.js'
import { CORTE, GROSOR, HALO_PX, META_ANCHO, RADIO, STRIDE, createGlyphAtlas, dirtyRows, isEmoji, needsRun } from './labelGlyphs.js'
import { PART, createRun, projectPath, projectRings } from './labelPath.js'
import { createMeasure } from './labelText.js'
import { projX0, projY0, readView } from './project.js'

// LabelGl — los rótulos `gl` de varios miembros como glifos instanciados que leen su forma del atlas de campos de
// distancia (labelGlyphs.js). Es un miembro de tramo de Stroma: dibuja en el FBO que le enlaza `begin()` y avisa
// `end(view)`, sin contexto propio cuando hay una capa GPU debajo.
//
// La colocación es de CPU y no depende de la vista: cada rótulo guarda su ancla en world0, relativa al ancla del miembro,
// y el corrimiento de cada glifo en px CSS. El shader proyecta el ancla con la matriz de la vista y suma el corrimiento,
// así que paneo, zoom y el zoom animado sólo cambian uniformes: el cuadro no recoloca ni sube nada. Se recoloca un
// miembro cuando cambian sus datos, su fuente o su colocación; el foco y el hover reescriben alfa y banderas.
//
// Cada miembro va en dos pases, primero los halos de todos sus rótulos y después los rellenos, y los del ítem bajo el
// puntero al final, encima de todos: el orden de `LabelCanvas`. El emoji en color sale de la página de color del atlas,
// en el pase de relleno.

// Bytes de cada campo de la instancia de STRIDE bytes: posición world0 relativa al ancla (2 × f32), corrimiento en px
// (2 × f32), id del glifo (u16), un u16 reservado para el ángulo sobre el trazo, alfa (u8) y banderas (u8).
const F32   = STRIDE / 4
const U16   = STRIDE / 2
const GLIFO = 8                            // en u16
const ALFA  = 20                           // en u8
const FLAGS = 21
const HOVER = 1                            // bandera: el ítem bajo el puntero, que se pinta al final

// Lo que guarda el picking por colocación: ancla world0 relativa (x, y), centro de la caja en px respecto del ancla
// (x, y) y medio ancho y medio alto. La caja es la de `labelLayout`, así los dos renderers pican lo mismo.
const PICK = 6

// Una vista en world0 con escala 1: la que coloca polígonos y líneas fuera de la vista.
const WORLD0 = Object.freeze({ cx: 0, cy: 0, scale: 1, hw: 0, hh: 0 })

const VERTEX = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_off;
layout(location = 2) in uint a_glyph;
layout(location = 3) in float a_alpha;
layout(location = 4) in uint a_flags;
uniform mat4 u_matrix;
uniform vec2 u_size;
uniform float u_dpr;
uniform float u_scale;
uniform float u_alfa;
uniform int u_hover;
uniform int u_pass;
uniform highp sampler2D u_meta;
uniform vec2 u_sdfInv;
uniform vec2 u_colorInv;
out vec2 v_uv;
out float v_alpha;
out float v_px;
flat out int v_color;
const vec4 HIDDEN = vec4(2.0, 2.0, 2.0, 1.0);
void main() {
  if (int(a_flags & ${HOVER}u) != u_hover) { gl_Position = HIDDEN; return; }
  int t = int(a_glyph) * 2;
  ivec2 at = ivec2(t % ${META_ANCHO}, t / ${META_ANCHO});
  vec4 cell = texelFetch(u_meta, at, 0);
  vec4 org  = texelFetch(u_meta, at + ivec2(1, 0), 0);
  bool color = org.w > 0.5;
  if (cell.z <= 0.0 || color && u_pass == 0) { gl_Position = HIDDEN; return; }
  vec4 c = u_matrix * vec4(a_pos, 0.0, 1.0);
  vec2 base = (c.xy / c.w * vec2(0.5, -0.5) + 0.5) * u_size + a_off;
  base.y = floor(base.y * u_dpr + 0.5) / u_dpr;
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 local  = (org.xy + corner * cell.zw) * u_scale;
  local.y -= u_alfa * u_scale;
  vec2 px = base + local;
  gl_Position = vec4(px / u_size * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
  v_uv    = (cell.xy + corner * cell.zw) * (color ? u_colorInv : u_sdfInv);
  v_alpha = a_alpha;
  v_px    = u_scale * u_dpr;
  v_color = color ? 1 : 0;
}`

// `d` es la distancia al contorno en px de dispositivo, positiva afuera; la cobertura es la de un filtro caja de 1 px. La
// salida es premultiplicada, como la página de color.
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_sdf;
uniform sampler2D u_colorPage;
uniform vec4 u_color;
uniform float u_edge;
uniform float u_grosor;
in vec2 v_uv;
in float v_alpha;
in float v_px;
flat in int v_color;
out vec4 frag;
void main() {
  if (v_color == 1) {
    frag = texture(u_colorPage, v_uv) * (v_alpha * u_color.a);
    if (frag.a <= 0.0) discard;
    return;
  }
  float d = (${(1 - CORTE).toFixed(4)} - texture(u_sdf, v_uv).r) * ${RADIO.toFixed(1)} * v_px;
  float a = clamp(0.5 - d + u_edge + u_grosor, 0.0, 1.0) * v_alpha * u_color.a;
  if (a <= 0.0) discard;
  frag = vec4(u_color.rgb * a, a);
}`

const ATTRIBS  = ['a_pos', 'a_off', 'a_glyph', 'a_alpha', 'a_flags']
const UNIFORMS = ['u_matrix', 'u_size', 'u_dpr', 'u_scale', 'u_alfa', 'u_hover', 'u_pass', 'u_meta', 'u_sdfInv', 'u_colorInv',
  'u_sdf', 'u_colorPage', 'u_color', 'u_edge', 'u_grosor']

const programOf = gl => sharedProgram(gl, 'cristae:labels-sdf', () => {
  const program = gl.createProgram()
  ;[[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]].forEach(([type, source]) => {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    gl.attachShader(program, shader)
    gl.deleteShader(shader)
  })
  ATTRIBS.forEach((name, loc) => gl.bindAttribLocation(program, loc, name))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost())
    throw new Error(`[cristae] el programa de los rótulos no linkea: ${gl.getProgramInfoLog(program)}`)
  const u = { program }
  UNIFORMS.forEach(name => (u[name] = gl.getUniformLocation(program, name)))
  return u
})

/* ── El realm: un atlas, la cola de rasterizado y las fuentes, compartidos por los renderers de la página ── */

const realms = new WeakMap()               // atlas → { atlas, renderers, frame, fonts }
let shared   = null

const realmOf = atlas => {
  let realm = realms.get(atlas)
  realm || realms.set(atlas, realm = { atlas, renderers: new Set(), frame: 0, fonts: new Set(), run: null })
  realm.run ??= () => flushRealm(realm)
  return realm
}

// Una vez por cuadro y por realm: el tope de tiempo del atlas es de la página, no de cada mapa. Lo que se rasterizó se
// pinta en el mismo cuadro.
const flushRealm = realm => {
  realm.frame = 0
  const stamp = realm.atlas.stamp
  const left  = realm.atlas.flush()
  stamp === realm.atlas.stamp || realm.renderers.forEach(repaint)
  left && requestFlush(realm)
}
const repaint = renderer => renderer.repaint()
const requestFlush = realm => realm.frame || (realm.frame = requestAnimationFrame(realm.run))

// Una fuente que termina de cargar cambia la forma de los glifos y los anchos medidos con la de reemplazo: el atlas la
// rasteriza de nuevo con los mismos ids, y cada renderer la vuelve a medir y recoloca lo que la usa.
const watchFont = (realm, font) => {
  if (realm.fonts.has(font)) return
  realm.fonts.add(font)
  globalThis.document?.fonts?.load(font).then(() => {
    realm.atlas.forget(font)
    realm.renderers.forEach(r => r.fontLoaded(font))
    requestFlush(realm)
  }, () => {})
}

/* ── Las texturas del atlas en cada contexto ── */

// Por contexto y atlas: la textura de cada página, su generación y el sello de la última subida. Un contexto nuevo
// (A2) estrena entrada; uno restaurado sobre el mismo objeto la pierde con `webglcontextlost`.
const uploads = new WeakMap()              // gl → Map(atlas → entrada)
const rows    = { y0: 0, y1: 0 }

const texture = (gl, filter) => {
  const t = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return t
}

const texturesOf = (gl, atlas) => {
  let byAtlas = uploads.get(gl)
  if (!byAtlas) {
    uploads.set(gl, byAtlas = new Map())
    gl.canvas?.addEventListener?.('webglcontextlost', () => uploads.delete(gl), { once: true })
  }
  let entry = byAtlas.get(atlas)
  entry || byAtlas.set(atlas, entry = {
    stamp : -1,
    sdf   : { tex: texture(gl, gl.LINEAR), gen: -1, height: 0, internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE },
    color : { tex: texture(gl, gl.LINEAR), gen: -1, height: 0, internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE },
    meta  : { tex: texture(gl, gl.NEAREST), gen: -1, height: 0, internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT },
  })
  return entry
}

// Una página a su unidad: entera si creció o se compactó, si no las filas escritas después de la última subida. [0-alloc]
const syncPage = (gl, slot, page, unit, since) => {
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(gl.TEXTURE_2D, slot.tex)
  if (slot.gen !== page.gen || slot.height !== page.height) {
    gl.texImage2D(gl.TEXTURE_2D, 0, slot.internal, page.width, page.height, 0, slot.format, slot.type, page.pixels)
    slot.gen    = page.gen
    slot.height = page.height
    return
  }
  dirtyRows(page, since, rows)
  rows.y1 > rows.y0 && gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, rows.y0, page.width, rows.y1 - rows.y0, slot.format, slot.type,
    page.pixels, rows.y0 * page.width * page.channels)
}

const UNIT_SDF = 0, UNIT_COLOR = 1, UNIT_META = 2

// Las tres páginas en sus unidades, subiendo sólo si el atlas escribió algo desde la última vez. [0-alloc]
const syncAtlas = (gl, entry, atlas) => {
  if (entry.stamp === atlas.stamp) {
    gl.activeTexture(gl.TEXTURE0 + UNIT_SDF)
    gl.bindTexture(gl.TEXTURE_2D, entry.sdf.tex)
    gl.activeTexture(gl.TEXTURE0 + UNIT_COLOR)
    gl.bindTexture(gl.TEXTURE_2D, entry.color.tex)
    gl.activeTexture(gl.TEXTURE0 + UNIT_META)
    gl.bindTexture(gl.TEXTURE_2D, entry.meta.tex)
    return
  }
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  syncPage(gl, entry.sdf, atlas.sdf, UNIT_SDF, entry.stamp)
  syncPage(gl, entry.color, atlas.color, UNIT_COLOR, entry.stamp)
  syncPage(gl, entry.meta, atlas.meta, UNIT_META, entry.stamp)
  entry.stamp = atlas.stamp
}

/* ── Colores ── */

const RGBA = /^rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?:,\s*([\d.]+))?\)$/

// Un color CSS como lo toma el canvas: lo normaliza un contexto 2D, que da `#rrggbb` o `rgba(…)`.
const parseColor = (ctx, css) => {
  ctx.fillStyle = '#000'
  ctx.fillStyle = css
  const s = String(ctx.fillStyle)
  const m = RGBA.exec(s)
  return m ? new Float32Array([+m[1] / 255, +m[2] / 255, +m[3] / 255, m[4] === undefined ? 1 : +m[4]])
    : new Float32Array([parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255, 1])
}

/* ── Estado de un miembro ── */

const newState = () => ({
  version : -1,
  ax      : 0, ay: 0,                     // ancla del miembro en world0: el centro de la vista al colocar
  count   : 0,                            // glifos
  cap     : 0,
  buf     : null, f32: null, u16: null, u8: null,
  prev    : new Uint16Array(64),          // los ids de la colocación anterior, que se sueltan después de la nueva
  uploaded: false,
  gpuCap  : 0,
  vbo     : null, vao: null,
  hovered : 0,
  font    : '',
  scale   : 1,                            // px de la fuente / BASE_PX
  alfa    : 0,                            // de la línea media a la alfabética, en px de la base
  color   : null, halo: null,
  pick    : new Float64Array(64 * PICK),
  spans   : new Int32Array(128),          // primer glifo y cantidad por colocación
  pickIds : [],
  pickN   : 0,
})

/** Un renderer `gl` en el pane `pane`, a `zIndex`. `host` es el del motor (cámara y superficie), `surface` la fábrica de
 *  superficies de tramo (sin ella, una `EditSurface` propia) y `track`, si llega, inscribe el renderer en el ciclo de
 *  render del motor, que lo reasienta en cada movimiento y lo dibuja en cada cuadro del zoom animado. Lanza en el acto
 *  si no hay WebGL2. `atlas` se inyecta en los tests; por omisión es el del realm. */
export const createLabelGl = ({ host, pane, zIndex, surface = opts => new EditSurface(opts), track = null, atlas = null }) => {
  const { camera } = host
  const realm   = realmOf(atlas ?? (shared ??= createGlyphAtlas()))
  const glyphs  = realm.atlas
  const raster  = (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : document.createElement('canvas')).getContext('2d')
  const measure = createMeasure(raster)
  const members = []                      // en orden de attach, que es el de pintado
  const states  = new Map()
  const colors  = new Map()               // CSS → RGBA
  const m64     = new Float64Array(16)
  const m32     = new Float32Array(16)
  const view    = { zoom: 0, center: { x: 0, y: 0 }, size: { x: 0, y: 0 } }
  const last    = { zoom: 0, center: { x: 0, y: 0 }, size: { x: 0, y: 0 }, valid: false }
  const icon    = { lat: 0, lng: 0, w: 0, h: 0, ax: NaN, ay: NaN, x: 0, y: 0, offset: 0 }
  const anchor  = { x: 0, y: 0, sx: 0, sy: 0 }
  const mid     = { x: 0, y: 0, ux: 1, uy: 0 }
  const run     = createRun()
  const pool    = []                      // partes de hit reusadas
  let ids       = new Uint16Array(64)     // los glifos de un texto, de trabajo
  let gl        = null
  let u         = null
  let textures  = null
  let frame     = 0
  let injected  = false
  let stale     = true                    // algo cambió desde el último dibujo: datos, estilo, foco, atlas o contexto
  let drawnW    = 0, drawnH = 0           // el drawing buffer del último dibujo
  let alive     = true
  let offView   = null
  let renderer  = null
  let visiting  = null                    // el miembro que se coloca, y su fuente
  let font      = null

  const colorOf = css => colors.get(css) ?? colors.set(css, parseColor(raster, css)).get(css)

  host.surface.mount(pane, zIndex, { pointer: false })

  const reserve = (st, n) => {
    if (st.cap >= n) return
    const cap = Math.max(n, st.cap * 2, 256)
    const buf = new ArrayBuffer(cap * STRIDE)
    st.buf && new Uint8Array(buf).set(new Uint8Array(st.buf, 0, st.count * STRIDE))
    st.buf = buf
    st.f32 = new Float32Array(buf)
    st.u16 = new Uint16Array(buf)
    st.u8  = new Uint8Array(buf)
    st.cap = cap
  }

  const grow = (arr, need) => {
    if (arr.length >= need) return arr
    const next = new arr.constructor(Math.max(arr.length * 2, need))
    next.set(arr)
    return next
  }

  // Un glifo más del rótulo de la colocación en curso, con su referencia en el atlas.
  const put = (st, wx, wy, ox, oy, glyph, alpha, flags) => {
    reserve(st, st.count + 1)
    const i = st.count++
    const f = i * F32, b = i * STRIDE
    st.f32[f]     = wx
    st.f32[f + 1] = wy
    st.f32[f + 2] = ox
    st.f32[f + 3] = oy
    st.u16[i * U16 + GLIFO] = glyph
    st.u8[b + ALFA]  = Math.round(alpha * 255)
    st.u8[b + FLAGS] = flags
    glyphs.ref(glyph)
  }

  // Una colocación más: su ancla, su caja y desde qué glifo empieza.
  const open = (st, id, wx, wy, cx, cy, hw, hh) => {
    const n = st.pickN++
    st.pick  = grow(st.pick, (n + 1) * PICK)
    st.spans = grow(st.spans, (n + 1) * 2)
    const p = n * PICK
    st.pick[p]     = wx
    st.pick[p + 1] = wy
    st.pick[p + 2] = cx
    st.pick[p + 3] = cy
    st.pick[p + 4] = hw
    st.pick[p + 5] = hh
    st.spans[2 * n]     = st.count
    st.spans[2 * n + 1] = 0
    st.pickIds[n] = id
    return n
  }

  // Una corrida que mezcla un sistema complejo con emoji: las partes sin emoji van enteras, cada emoji suelto y en color,
  // en orden lógico de izquierda a derecha, que es como las ordena el canvas con su dirección `ltr`. Cada parte se mide
  // con el modelado del navegador.
  const placeMixed = (st, key, font, text, wx, wy, cx, gy, alpha, flags) => {
    const units = text.units
    raster.font = font
    let total = 0, from = 0
    const parts = []
    for (let i = 0; i <= units.length; i++) {
      if (i < units.length && !isEmoji(units[i])) continue
      if (i > from) {
        const s = units.slice(from, i).join('')
        const w = raster.measureText(s).width
        parts.push(glyphs.run(key, s), w)
        total += w
      }
      if (i < units.length) {
        parts.push(glyphs.glyph(key, units[i]), text.widths[i])
        total += text.widths[i]
      }
      from = i + 1
    }
    let pen = cx - total / 2
    for (let k = 0; k < parts.length; k += 2) {
      put(st, wx, wy, pen + parts[k + 1] / 2, gy, parts[k], alpha, flags)
      pen += parts[k + 1]
    }
  }

  // El rótulo de un ítem ya anclado: `anchor` en px respecto del ancla world0 (wx, wy), y hacia dónde crece su caja.
  const placeText = (st, member, id, raw, wx, wy, key, k, alfaPedido) => {
    const text  = measure.glyphs(member.opts.font, raw)
    const hw    = text.total / 2
    const hh    = (text.ascent + text.descent) / 2
    const cx    = anchor.x + anchor.sx * hw
    const cy    = anchor.y + anchor.sy * hh
    const gy    = cy + alfaPedido
    const alpha = member.alphaOf(id)
    const flags = member.isHovered(id) ? HOVER : 0
    const n     = open(st, id, wx, wy, cx, cy, hw, hh)
    flags && st.hovered++
    if (needsRun(raw)) {
      text.units.some(isEmoji) ? placeMixed(st, key, member.opts.font, text, wx, wy, cx, gy, alpha, flags)
        : put(st, wx, wy, cx, gy, glyphs.run(key, raw), alpha, flags)
    } else {
      const units = text.units
      ids = grow(ids, units.length)
      let total = 0
      for (let i = 0; i < units.length; i++) {
        ids[i] = glyphs.glyph(key, units[i])
        total += text.widths[i] + (i > 0 ? glyphs.kern(ids[i - 1], ids[i]) * k : 0)
      }
      let pen = cx - total / 2
      for (let i = 0; i < units.length; i++) {
        i > 0 && (pen += glyphs.kern(ids[i - 1], ids[i]) * k)
        put(st, wx, wy, pen + text.widths[i] / 2, gy, ids[i], alpha, flags)
        pen += text.widths[i]
      }
    }
    st.spans[2 * n + 1] = st.count - st.spans[2 * n]
  }

  // Lo que se rotula de un ítem, con la misma regla que `labelLayout` pero en world0: el ícono de un punto, el polo de un
  // polígono o la mitad del largo de cada tramo de una línea.
  const visit = (st, item, id, raw) => {
    const member = visiting
    const where  = member.placement
    const kind   = member.kind
    const offset = member.opts.offset ?? 0
    if (kind === 'line' || kind === 'polygon') {
      if (kind === 'polygon') {
        const at = poleOf(projectRings(run, member.pathOf(item), WORLD0, member.curve))
        if (!at) return
        anchor.x = anchor.sx = anchor.sy = 0
        anchor.y = -offset
        return placeText(st, member, id, raw, at.x - st.ax, at.y - st.ay, font.key, font.scale, font.alfaPedido)
      }
      projectPath(run, member.pathOf(item), WORLD0, member.curve)
      for (let p = 0; p < run.count * PART; p += PART) {
        midAlong(run.xy, run.cum, run.parts[p], run.parts[p + 1], mid)
        anchor.x = anchor.sx = anchor.sy = 0
        anchor.y = -offset
        placeText(st, member, id, raw, mid.x - st.ax, mid.y - st.ay, font.key, font.scale, font.alfaPedido)
      }
      return
    }
    icon.w = icon.h = 0
    icon.ax = icon.ay = NaN
    if (!member.anchorOf(item, icon)) return
    icon.x = icon.y = 0
    icon.offset = offset
    anchorAt(where, icon, anchor)
    placeText(st, member, id, raw, projX0(icon.lng) - st.ax, projY0(icon.lat) - st.ay, font.key, font.scale, font.alfaPedido)
  }

  // Coloca de nuevo `member`: la colocación nueva toma sus referencias antes de soltar las de la anterior, así un glifo
  // que sigue no queda un instante sin dueño.
  const place = (member, st, at) => {
    const old = st.count
    st.prev = grow(st.prev, old)
    for (let i = 0; i < old; i++) st.prev[i] = st.u16[i * U16 + GLIFO]
    st.count   = 0
    st.pickN   = 0
    st.hovered = 0
    st.ax      = at.center.x
    st.ay      = at.center.y
    font       = glyphs.fontOf(member.opts.font)
    st.font    = member.opts.font
    st.scale   = font.scale
    st.alfa    = font.alfaBase
    st.color   = colorOf(member.opts.color)
    st.halo    = member.opts.halo === 'none' ? null : colorOf(member.opts.halo)
    visiting   = member
    member.forEach(visit, st)
    visiting   = null
    for (let i = 0; i < old; i++) glyphs.unref(st.prev[i])
    st.pickIds.length = st.pickN
    st.version  = member.version
    st.uploaded = false
    watchFont(realm, member.opts.font)
    glyphs.pending && requestFlush(realm)
  }

  // Alfa y banderas de cada glifo, por colocación: el foco y el hover no recolocan.
  const restyle = (member, st) => {
    st.hovered = 0
    for (let n = 0; n < st.pickN; n++) {
      const id    = st.pickIds[n]
      const alpha = Math.round(member.alphaOf(id) * 255)
      const flags = member.isHovered(id) ? HOVER : 0
      flags && st.hovered++
      const end = st.spans[2 * n] + st.spans[2 * n + 1]
      for (let g = st.spans[2 * n]; g < end; g++) {
        st.u8[g * STRIDE + ALFA]  = alpha
        st.u8[g * STRIDE + FLAGS] = flags
      }
    }
    st.uploaded = false
  }

  const upload = st => {
    gl.bindBuffer(gl.ARRAY_BUFFER, st.vbo)
    const bytes = st.count * STRIDE
    if (st.gpuCap < bytes) {
      gl.bufferData(gl.ARRAY_BUFFER, st.u8, gl.DYNAMIC_DRAW, 0, st.cap * STRIDE)
      st.gpuCap = st.cap * STRIDE
    } else if (bytes) gl.bufferSubData(gl.ARRAY_BUFFER, 0, st.u8, 0, bytes)
    st.uploaded = true
  }

  const buildMember = st => {
    st.vbo = gl.createBuffer()
    st.vao = gl.createVertexArray()
    st.gpuCap   = 0
    st.uploaded = false
    gl.bindVertexArray(st.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, st.vbo)
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE, 0); gl.vertexAttribDivisor(0, 1)
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE, 8); gl.vertexAttribDivisor(1, 1)
    gl.enableVertexAttribArray(2); gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_SHORT, STRIDE, 2 * GLIFO); gl.vertexAttribDivisor(2, 1)
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.UNSIGNED_BYTE, true, STRIDE, ALFA); gl.vertexAttribDivisor(3, 1)
    gl.enableVertexAttribArray(4); gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_BYTE, STRIDE, FLAGS); gl.vertexAttribDivisor(4, 1)
    gl.bindVertexArray(null)
  }

  // Un pase de un miembro: los halos (`edge` = el halo en px de dispositivo, sin el emoji) o los rellenos.
  const pass = (st, color, edge, kind) => {
    gl.uniform4fv(u.u_color, color)
    gl.uniform1f(u.u_edge, edge)
    gl.uniform1i(u.u_pass, kind)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, st.count)
  }

  // Dibuja con `at` (la vista de la cámara, o la inyectada en el zoom animado) y avisa la vista al tramo. Oculto todo, o
  // sin contexto, no dibuja. Recoloca lo que cambió. Con la misma vista, el mismo buffer y nada nuevo, la textura del
  // miembro ya vale: el `move` y el `moveend` de un mismo paso, o el `zoomend` y el `moveend`, dibujan una vez.
  // [0-alloc] sin recolocar.
  const draw = at => {
    const same = last.valid && last.zoom === at.zoom && last.center.x === at.center.x && last.center.y === at.center.y
      && last.size.x === at.size.x && last.size.y === at.size.y
    last.zoom = at.zoom
    last.center.x = at.center.x
    last.center.y = at.center.y
    last.size.x = at.size.x
    last.size.y = at.size.y
    last.valid = true
    if (!gl || gl.isContextLost()) return false
    if (same && !stale && drawnW === gl.drawingBufferWidth && drawnH === gl.drawingBufferHeight) return true
    stale  = false
    drawnW = gl.drawingBufferWidth
    drawnH = gl.drawingBufferHeight
    for (let i = 0; i < members.length; i++) {
      const member = members[i], st = states.get(member)
      member.visible && st.version !== member.version && place(member, st, at)
    }
    const dpr = globalThis.devicePixelRatio || 1
    renderer.surface.begin()
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    syncAtlas(gl, textures, glyphs)
    gl.useProgram(u.program)
    gl.uniform1i(u.u_sdf, UNIT_SDF)
    gl.uniform1i(u.u_colorPage, UNIT_COLOR)
    gl.uniform1i(u.u_meta, UNIT_META)
    gl.uniform2f(u.u_sdfInv, 1 / glyphs.sdf.width, 1 / glyphs.sdf.height)
    gl.uniform2f(u.u_colorInv, 1 / glyphs.color.width, 1 / glyphs.color.height)
    gl.uniform2f(u.u_size, at.size.x, at.size.y)
    gl.uniform1f(u.u_dpr, dpr)
    gl.uniform1f(u.u_grosor, GROSOR / dpr)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    for (let hover = 0; hover < 2; hover++) {
      gl.uniform1i(u.u_hover, hover)
      for (let i = 0; i < members.length; i++) {
        const member = members[i], st = states.get(member)
        if (!member.visible || !st.count || hover && !st.hovered) continue
        st.uploaded || upload(st)
        m32.set(anchorMatrix(m64, st.ax, st.ay, at.zoom, at.center, at.size))
        gl.uniformMatrix4fv(u.u_matrix, false, m32)
        gl.uniform1f(u.u_scale, st.scale)
        gl.uniform1f(u.u_alfa, st.alfa)
        gl.bindVertexArray(st.vao)
        st.halo && pass(st, st.halo, HALO_PX * dpr, 0)
        pass(st, st.color, 0, 1)
      }
    }
    gl.bindVertexArray(null)
    renderer.surface.end(at)
    return true
  }

  const live = () => (injected ? view : readView(camera, view))

  const paint = () => {
    frame = 0
    alive && camera.hasView() && draw(live())
  }

  // El px CSS de la posición world0 relativa (x, y) con la matriz `m`, en `hit`: el gemelo del shader. [0-alloc]
  const hit = { x: 0, y: 0 }
  const project = (m, W, H, x, y) => {
    hit.x = ((m[0] * x + m[12]) * 0.5 + 0.5) * W
    hit.y = (0.5 - (m[5] * y + m[13]) * 0.5) * H
  }

  renderer = {
    surface: null,

    get zIndex() { return zIndex },

    // Lo lee el tramo: algún miembro visible tiene algo que dibujar.
    get hasContent() {
      for (let i = 0; i < members.length; i++) if (members[i].visible) return true
      return false
    },

    setZ(z) {
      if (z === zIndex) return false
      zIndex = z
      host.surface.setZ(pane, z)
      return true
    },

    // El contexto del tramo, al tomarlo y cada vez que vuelve: programa, texturas e instancias desde la copia de CPU, y
    // un dibujo en el acto, que el contexto nace en blanco.
    buildGl(context) {
      gl       = context
      u        = programOf(gl)
      textures = texturesOf(gl, glyphs)
      states.forEach(buildMember)
      stale = true
      alive && camera.hasView() && draw(live())
    },

    // El contexto se perdió o se suelta: se olvida lo GL; la CPU queda.
    dropGl() {
      frame && cancelAnimationFrame(frame)
      frame    = 0
      injected = false
      gl = u = textures = null
      states.forEach(st => (st.vbo = st.vao = null))
    },

    // Repinta en el próximo cuadro; los pedidos de un cuadro son un solo dibujo.
    redraw() {
      stale = true
      alive && gl && !frame && (frame = requestAnimationFrame(paint))
    },

    // Pinta ya: lo pide el realm en el cuadro en que rasterizó glifos.
    repaint() {
      frame && cancelAnimationFrame(frame)
      stale = true
      paint()
    },

    // El motor lo reasienta en cada movimiento y al asentar: la vista viva, dibujada en el acto.
    resetCanvasReference() {
      injected = false
      if (!gl || !alive) return
      renderer.surface.resetCanvasReference()
      camera.hasView() && draw(readView(camera, view))
    },

    // Un cuadro del zoom animado, con `center` en grados: el ancla se proyecta con la vista inyectada, la misma con que
    // pintan los íconos, así el rótulo no se despega del suyo. [0-alloc]
    renderAtView(zoom, center) {
      if (!gl || !alive) return
      view.zoom     = zoom
      view.center.x = projX0(center.lng)
      view.center.y = projY0(center.lat)
      const size    = camera.size()
      view.size.x   = size.x
      view.size.y   = size.y
      injected      = true
      draw(view)
    },

    fontLoaded(css) {
      measure.forget(css)
      let stale = false
      states.forEach(st => {
        if (st.font !== css) return
        st.version = -1
        stale = true
      })
      stale && renderer.redraw()
    },

    attach(member) {
      if (!alive || states.has(member)) return
      members.push(member)
      const st = newState()
      states.set(member, st)
      gl && buildMember(st)
      renderer.surface.need()
      renderer.redraw()
    },

    // Datos y colocación recolocan en el próximo dibujo; foco y hover sólo reescriben alfa y banderas; `color` y `halo`
    // son uniformes.
    invalidate(member, reason) {
      const st = states.get(member)
      if (!st) return
      if (reason === 'style') {
        st.color = colorOf(member.opts.color)
        st.halo  = member.opts.halo === 'none' ? null : colorOf(member.opts.halo)
      }
      ;(reason === 'focus' || reason === 'hover') && st.version === member.version && restyle(member, st)
      reason === 'visibility' && member.visible && renderer.surface.need()
      ;(reason === 'visibility' || member.visible) && renderer.redraw()
    },

    detach(member) {
      const st = states.get(member)
      if (!st) return
      states.delete(member)
      members.splice(members.indexOf(member), 1)
      for (let i = 0; i < st.count; i++) glyphs.unref(st.u16[i * U16 + GLIFO])
      if (gl && !gl.isContextLost()) {
        gl.deleteBuffer(st.vbo)
        gl.deleteVertexArray(st.vao)
      }
      renderer.redraw()
    },

    // Suma a `out` una parte `{ ref, id, distancePx: 0, zIndex }` por cada ítem con un rótulo bajo `sample` (px CSS del
    // contenedor), con la vista del último dibujo. La caja es la de `labelLayout`. [0-alloc]
    hitsAt(member, sample, out) {
      const st = alive && last.valid && member.visible ? states.get(member) : null
      if (!st || !st.pickN) return out
      const m = anchorMatrix(m64, st.ax, st.ay, last.zoom, last.center, last.size)
      const W = last.size.x, H = last.size.y
      const pick = st.pick
      let used = 0, prev = null
      for (let n = 0; n < st.pickN; n++) {
        const p = n * PICK
        const hw = pick[p + 4], hh = pick[p + 5]
        const id = st.pickIds[n]
        if (!(hw > 0 && hh > 0) || id === prev) continue
        project(m, W, H, pick[p], pick[p + 1])
        if (Math.abs(sample.x - hit.x - pick[p + 2]) > hw || Math.abs(sample.y - hit.y - pick[p + 3]) > hh) continue
        const part = pool[used] ?? (pool[used] = { ref: null, id: null, distancePx: 0, zIndex: 0 })
        used++
        part.ref = part.id = id
        part.zIndex = zIndex
        out.push(part)
        prev = id
      }
      return out
    },

    // Lo que ocupa en CPU y en GPU, para el banco y los tests.
    stats() {
      let glifos = 0, instancias = 0
      states.forEach(st => {
        glifos += st.count
        instancias += st.gpuCap
      })
      return { glifos, instancias, atlas: glyphs.stats, pendientes: glyphs.pending, alto: glyphs.sdf.height }
    },

    destroy() {
      if (!alive) return
      ;[...members].forEach(m => renderer.detach(m))
      alive = false
      frame && cancelAnimationFrame(frame)
      frame = 0
      offView?.forEach(off => off())
      realm.renderers.delete(renderer)
      renderer.surface.destroy()
      host.surface.unmount(pane)
      gl = u = textures = null
    },
  }

  // Sin WebGL2 la apertura lanza en el acto, y el renderer no queda a medias: quien lo pidió pinta con `canvas`.
  try {
    renderer.surface = surface({ host, pane, cssZoom: false, owner: renderer })
    renderer.surface.open(false)
  } catch (e) {
    renderer.surface?.destroy()
    host.surface.unmount(pane)
    alive = false
    throw e
  }
  realm.renderers.add(renderer)
  // Con un motor que lo reasienta, sólo falta el cambio de tamaño; sin él, cada movimiento.
  offView = [camera.on(track ? 'resize' : 'move moveend zoomend resize', () => renderer.resetCanvasReference())]
  track?.(renderer)
  return renderer
}

