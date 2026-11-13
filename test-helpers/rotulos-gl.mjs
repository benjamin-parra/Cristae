// Dobles del renderer `gl` de los rótulos para node:test: el contexto 2D de la medida (que se instala en el `document`
// del shim de engine-stub), el contexto de trabajo del atlas, un gl que anota (o uno plano de no-ops para medir
// asignaciones), una superficie de tramo falsa, la cámara de un mapa de 800 × 600 y un miembro de rótulos.
import { decorarElementos } from './engine-stub.mjs'
import { createLabelGl } from '../src/render/LabelGl.js'
import { createGlyphAtlas, STRIDE } from '../src/render/labelGlyphs.js'
import { LABEL_DEFAULTS } from '../src/render/labelOptions.js'

export const ANCHO = 7                           // px por grafema del contexto falso
const EMOJI = /\p{Extended_Pictographic}/u
const SEG   = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const unidades = s => Array.from(SEG.segment(s), x => x.segment)

// El contexto 2D de la medida (labelText) y de los colores: mide ANCHO px por grafema, con un ajuste en «AV», y
// normaliza `fillStyle` como el real (un hex de 6 dígitos queda igual).
export const medida = () => {
  const ctx = {
    font: '', _fill: '#000000',
    get fillStyle() { return ctx._fill },
    set fillStyle(v) { /^#[0-9a-f]{6}$/i.test(v) ? (ctx._fill = v.toLowerCase()) : v === '#000' && (ctx._fill = '#000000') },
    measureText: text => ({
      width: ANCHO * unidades(text).length - (text === 'AV' ? 2 : 0),
      fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2,
    }),
  }
  return ctx
}
/** Instala la medida en los canvas del shim; devuelve la restauración. */
export const instalarMedida = () => decorarElementos((el, tag) => {
  if (tag === 'canvas') el.getContext = () => medida()
  return el
})

// El contexto de trabajo del atlas: la caja de tinta de cada grafema a 24 px y, con un emoji, píxeles de color.
export const trabajo = () => {
  let ultimo = ''
  const canvas = { width: 64, height: 64 }
  const ctx = {
    canvas, font: '', textAlign: '', textBaseline: 'alphabetic', fillStyle: '',
    measureText(text) {
      if (text === 'H') return { width: 17, actualBoundingBoxAscent: ctx.textBaseline === 'alphabetic' ? 17 : 9, actualBoundingBoxDescent: 0 }
      return { width: 17 * unidades(text).length - (text === 'AV' ? 5 : 0), actualBoundingBoxLeft: 6, actualBoundingBoxRight: 6,
        actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 8 }
    },
    clearRect() {},
    fillText(text) { ultimo = text },
    getImageData: (_x, _y, w, h) => {
      const data = new Uint8ClampedArray(w * h * 4)
      if (EMOJI.test(ultimo)) for (let i = 0; i < data.length; i += 4) data.set([10, 200, 30, 255], i)
      return { data }
    },
  }
  return ctx
}

// Un gl que anota lo que importa y devuelve objetos para lo demás. `mudo`: no anota nada y todo es la misma función,
// para medir asignaciones sin medir al espía.
const NADA = () => null
const METODOS = ['activeTexture', 'bindTexture', 'texImage2D', 'texSubImage2D', 'pixelStorei', 'useProgram', 'uniform1i', 'uniform2f',
  'uniform1f', 'uniform4fv', 'uniformMatrix4fv', 'enable', 'blendFunc', 'clearColor', 'clear', 'bindVertexArray', 'drawArraysInstanced',
  'bindBuffer', 'bufferData', 'bufferSubData', 'createBuffer', 'createVertexArray', 'enableVertexAttribArray', 'vertexAttribPointer',
  'vertexAttribIPointer', 'vertexAttribDivisor', 'createTexture', 'texParameteri', 'createProgram', 'createShader', 'shaderSource',
  'compileShader', 'attachShader', 'deleteShader', 'bindAttribLocation', 'linkProgram', 'getUniformLocation', 'getProgramInfoLog',
  'deleteBuffer', 'deleteVertexArray']
// Un objeto plano, sin Proxy: el compilador integra sus no-ops y no encajona los números de cada llamada.
const callado = base => {
  const gl = { ...base, isContextLost: () => false, getProgramParameter: () => true }
  METODOS.forEach(k => (gl[k] = NADA))
  return gl
}
export const glFalso = ({ mudo = false } = {}) => {
  const log = { draws: [], datas: [], subs: [], tex: [], texSub: [], matrices: [], uniforms: [], blend: [] }
  const base = {
    canvas: { width: 800, height: 600 }, drawingBufferWidth: 800, drawingBufferHeight: 600,
    TEXTURE0: 100, ONE: 1, ONE_MINUS_SRC_ALPHA: 771, ARRAY_BUFFER: 1, TEXTURE_2D: 2, R8: 3, RGBA8: 4, RGBA32F: 5, RED: 6, RGBA: 7, FLOAT: 8, UNSIGNED_BYTE: 9,
    isContextLost: () => false,
    getProgramParameter: () => true,
    bufferData: (_t, src, _u, off, len) => log.datas.push(src.slice(off, off + len)),
    bufferSubData: (_t, at, src, off, len) => log.subs.push({ at, bytes: src.slice(off, off + len) }),
    texImage2D: (_t, _l, internal, w, h) => log.tex.push({ internal, w, h }),
    texSubImage2D: (_t, _l, x, y, w, h) => log.texSub.push({ x, y, w, h }),
    drawArraysInstanced: (_m, _f, _n, count) => log.draws.push(count),
    uniformMatrix4fv: (_l, _t, m) => log.matrices.push(Float64Array.from(m)),
    uniform4fv: (_l, v) => log.uniforms.push(Array.from(v)),
    blendFunc: (a, b) => log.blend.push([a, b]),
  }
  if (mudo) return { log, gl: callado(base) }
  return { log, gl: new Proxy(base, { get: (t, p) => (p in t ? t[p] : () => ({})) }) }
}

// La superficie de tramo, con el contexto que da `need()`; `sinGl` lanza al abrir, como sin WebGL2.
export const superficie = ({ sinGl = false, mudo = false } = {}) => {
  const hechas = []
  const fabrica = opts => {
    const g = glFalso({ mudo })
    const s = {
      opts, ...g, ends: 0, destroyed: false, built: false,
      open() { if (sinGl) throw new Error('[cristae] sin WebGL2: las capas en GPU necesitan gl_VertexID y texelFetch'); return null },
      need() {
        if (s.built) return false
        s.built = true
        opts.owner.buildGl(g.gl)
        return true
      },
      begin() {}, end() { s.ends++ }, resetCanvasReference() {},
      destroy() { s.destroyed = true },
    }
    hechas.push(s)
    return s
  }
  return { fabrica, hechas }
}

// La cámara de un mapa de 800 × 600 que el test mueve.
export const anfitrion = () => {
  const center = { lat: -33.4, lng: -70.6 }
  const size   = { x: 800, y: 600 }
  const origin = { x: 0, y: 0 }
  const panes  = new Map()
  const state  = { zoom: 12 }
  const camera = {
    hasView: () => true, center: () => center, size: () => size, zoom: () => state.zoom, frameOrigin: () => origin,
    on: () => () => {},
  }
  const surface = {
    mount: (name, z) => (panes.set(name, (panes.get(name) ?? 0) + 1), { z }),
    unmount: name => panes.set(name, panes.get(name) - 1),
    setZ() {},
  }
  return { camera, surface, center, state, panes }
}

export const miembro = ({ id = 'm', kind = 'point', placement = 'below', items, opts = {}, pathOf = null }) => {
  const m = {
    id, kind, placement, version: 0, visible: true, curve: null,
    opts: { ...LABEL_DEFAULTS, renderer: 'gl', ...opts },
    hovered: new Set(), dim: null,
    forEach(fn, arg) { for (const it of items) it.text && fn(arg, it, it.id, it.text) },
    pathOf,
    anchorOf(it, out) {
      out.lat = it.lat
      out.lng = it.lng
      out.w = out.h = it.size ?? 8
      return out
    },
    alphaOf: id => (m.dim && !m.dim.has(id) ? 0.3 : 1),
    isHovered: id => m.hovered.has(id),
  }
  return m
}

export const montar = ({ atlas = createGlyphAtlas(trabajo()), sinGl = false, track = null, mudo = false } = {}) => {
  const host = anfitrion()
  const sup  = superficie({ sinGl, mudo })
  const r    = createLabelGl({ host, pane: 'cristae-labels-gl', zIndex: 7, surface: sup.fabrica, track, atlas })
  return { host, r, s: sup.hechas[0], atlas }
}

// Las instancias que subió la última `bufferData` o `bufferSubData`, como objetos: las `n` primeras, o todas las de una
// `bufferSubData`, que sube lo que ocupa.
export const instancias = (log, n) => {
  const sub    = log.subs.at(-1)
  const ultimo = sub ? sub.bytes : log.datas.at(-1).subarray(0, n * STRIDE)
  const f32 = new Float32Array(ultimo.buffer, ultimo.byteOffset, ultimo.byteLength / 4)
  const u16 = new Uint16Array(ultimo.buffer, ultimo.byteOffset, ultimo.byteLength / 2)
  const out = []
  for (let i = 0; i < ultimo.byteLength / STRIDE; i++) out.push({
    wx: f32[i * 6], wy: f32[i * 6 + 1], ox: f32[i * 6 + 2], oy: f32[i * 6 + 3], glifo: u16[i * 12 + 8],
    alfa: ultimo[i * STRIDE + 20], flags: ultimo[i * STRIDE + 21],
  })
  return out
}

export const PUNTOS = [
  { id: 'a', lat: -33.40, lng: -70.60, text: 'Faena 1' },
  { id: 'b', lat: -33.41, lng: -70.58, text: 'AV 7' },
  { id: 'c', lat: -33.39, lng: -70.63, text: 'Ruta' },
]

