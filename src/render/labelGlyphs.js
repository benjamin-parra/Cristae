// El atlas de glifos del renderer `gl` de rótulos. Cada grafema de una fuente se rasteriza UNA vez, a BASE_PX, con el
// canvas 2D del navegador: la misma pila de fuentes, los mismos respaldos y la misma carga perezosa que el renderer
// `canvas`, sin parser de fuentes. Se guarda como campo de distancia en una página R8, de la que un rótulo de cualquier
// tamaño, giro o zoom lee sin volver a rasterizar, y su halo sale del mismo campo. El emoji en color va a una página
// RGBA aparte, tal como lo pinta el canvas, por el camino con que el IconSet rasteriza sus íconos: un lienzo de trabajo
// con `willReadFrequently` y `getImageData`. La meta de cada glifo (su celda, de qué página es, su avance) es una
// tercera página, RGBA32F, que el shader lee con `texelFetch`: las instancias guardan sólo el id del glifo, y
// rasterizar tarde, crecer, compactar o perder el contexto reescriben la meta, nunca las instancias.
//
// Lo nuevo no se rasteriza al pedirlo: toma un id con la celda vacía (no se dibuja) y entra a una cola que `flush`
// gasta con un tope de tiempo por cuadro. La primera carga de miles de ideogramas se reparte entre cuadros.
//
// Cada glifo cuenta sus referencias. Sin referencias queda de caché. Si una página llega a su tope y algo no cabe, se
// compacta, y sólo si eso suelta algo: los glifos sin referencias se olvidan y los vivos se reempacan. Lo que aun así no
// cabe no se dibuja y avisa una vez: nunca lanza.
//
// La copia en CPU de las tres páginas es la verdad. Cada página lleva la marca de la última escritura de cada fila y
// una generación que cambia al crecer o compactar: un contexto sube las filas con marca nueva, o la página entera si
// cambió la generación, y uno nuevo la sube entera.
import { createScratch, distanceField, fitScratch } from './sdf.js'

// El tamaño con que se rasteriza, en px. Poco más del doble de los 10,5 px del rótulo por defecto: con DPR 1 el campo
// se lee a 0,44 de su tamaño y con DPR 2 a 0,875, y no se agranda más de 2× hasta 48 px de dispositivo.
export const BASE_PX = 24

// Hasta dónde llega el campo, en px de la base: RADIO · (1 − CORTE) = 7 px hacia afuera y RADIO · CORTE = 3 hacia
// adentro. Afuera cabe el halo de HALO_PX más 1 px de antialias aun a 10,5 px con DPR 1: 2,5 / 0,44 = 5,7 px de la
// base. Error menor que 0,5 px contra un disco (test/render/sdf.test.mjs).
export const RADIO = 10
export const CORTE = 0.3

// El halo: la mitad del trazo de 3 px que pinta LabelCanvas, hacia afuera del contorno, en px CSS.
export const HALO_PX = 1.5

// Cuánto se corre hacia afuera el contorno del relleno, en px de dispositivo a DPR 1: el canvas de Chromium oscurece
// el texto chico y el campo leído tal cual sale un 5 % más claro. Con 0,05 la tinta queda en 1,016 de la del canvas
// en el barrido 0 / 0,05 / 0,1 de una Arc B580. A DPR 2 da 1,06: el shader lo divide por el DPR.
export const GROSOR = 0.05

// Una instancia por glifo: posición world0 relativa al ancla del miembro (2 × f32), corrimiento en px (2 × f32), id
// del glifo (u16), ángulo (u16), alfa (u8) y banderas (u8).
export const STRIDE = 24

// Lo que se rasteriza por cuadro, en ms: lo que deja de 16,7 ms el resto del mapa, que con la escena pesada de una
// Arc B580 gasta hasta 7,3 ms. A unos 0,3 ms por glifo son unos 13 por cuadro.
export const RASTER_BUDGET_MS = 4

// La meta por glifo en floats: x, y, ancho y alto de la celda en su página (px), la esquina de la celda respecto del
// punto de referencia (centro del avance, línea media) en px de la base, el avance en px de la base y la página. Dos
// téxeles RGBA32F por glifo, META_ANCHO téxeles por fila.
export const META       = 8
export const META_ANCHO = 1024
export const SDF        = 0
export const COLOR      = 1

// La página de campos: ancho fijo y alto que se duplica. 1024 × 256 R8 son 256 KiB, unos 500 glifos latinos; 4096 es
// el tope de lienzo del anfitrión GL, y caben unos 2.800 ideogramas.
const SDF_ANCHO     = 1024
const SDF_ALTO      = 256
const SDF_MAX_ALTO  = 4096
const PAD           = Math.ceil(RADIO * (1 - CORTE))   // el campo de afuera entero alrededor de la tinta

// La página de color: un emoji de 24 px ocupa unos 30 × 30, con 1 px de margen para el filtrado lineal. 512 × 1024
// RGBA son 2 MiB y caben unos 450 emoji distintos. Guarda el alfa premultiplicado: con el color sin premultiplicar, el
// filtrado lineal mezcla el borde con el negro transparente de al lado y lo oscurece dos veces.
const COLOR_ANCHO    = 512
const COLOR_ALTO     = 64
const COLOR_MAX_ALTO = 1024
const COLOR_PAD      = 1

// Los ids: el par (a, b) se cachea con la clave a · MAX_GLIFOS + b, que así queda en un entero pequeño de V8 (31 bits)
// y `Map.get` no asigna; la instancia lo lleva en un u16. El 0 es el glifo vacío: no se dibuja y nunca se suelta.
const MAX_GLIFOS = 1 << 15
const VACIO      = 0

// Los estantes van de a clases de HOLGURA px de alto: una celda entra en el estante de su alto redondeado hacia arriba
// y desperdicia menos de HOLGURA px.
const HOLGURA = 4

// Un emoji se pinta con este color: si lo que vuelve es sólo este color, la fuente no lo tiene en color y va al campo,
// del color del texto, como lo pinta el canvas.
const SONDA = '#ff00ff'

const FREE = 0, PENDING = 1, READY = 2, OVERFLOW = 3
const KERN = 1, RUN = 2                 // la clase de un glifo: se ajusta por par, o es una corrida

// Los sistemas que piden modelado por contexto o reordenamiento, y los controles bidi: el texto entero va como un solo
// glifo, rasterizado con el modelado del navegador.
const COMPLEX = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Thai}\p{Script=Lao}\p{Script=Tibetan}\p{Script=Myanmar}\p{Script=Khmer}\p{Script=Mongolian}\u200E\u200F\u202A-\u202E\u2066-\u2069]/u

// Un grafema de emoji: presentación de emoji, un pictograma con el selector de emoji, una bandera o una tecla.
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|\p{Regional_Indicator}|\u20E3/u

// El ajuste por par sólo entre grafemas latinos, griegos y cirílicos (y lo común a todos): en CJK cada par es nuevo,
// medirlo cuadruplicaba la entrada en una Arc B580, y esas fuentes casi no ajustan.
const KERN_SCRIPTS = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}\p{Script=Inherited}]+$/u

const PX = /(\d+(?:\.\d+)?)px/

// Con la que queda el canvas si rechaza una fuente: la de un contexto nuevo.
const FUENTE_RESPALDO = '10px sans-serif'

// La mayúscula sin descendente con que se compara la línea media con la alfabética.
const REFERENCIA = 'H'

/** Si `text` va entero como un solo glifo (`run`): árabe, hebreo, índicas, tailandés, controles bidi… */
export const needsRun = text => COMPLEX.test(text)

/** Si el grafema `unit` es un emoji, que va a la página de color si la fuente lo trae en color. */
export const isEmoji = unit => EMOJI.test(unit)

/** La y de la línea alfabética en px CSS, puesta en px enteros de dispositivo como la pone Skia en el texto
 *  horizontal: el gemelo de CPU del shader. */
export const snapBaseline = (y, dpr) => Math.floor(y * dpr + 0.5) / dpr

/** Las filas de `page` escritas después de la marca `since`, en `out.y0` (incluida) y `out.y1` (excluida); vacío con
 *  y1 ≤ y0. Recorre el alto: se llama cuando la marca del atlas cambió, no por cuadro. */
export const dirtyRows = (page, since, out) => {
  let y0 = page.height, y1 = 0
  for (let y = 0; y < page.height; y++) {
    if (page.rows[y] <= since) continue
    y0 > y && (y0 = y)
    y1 = y + 1
  }
  out.y0 = y0
  out.y1 = y1
  return out
}

const newPage = (width, height, max, channels, pad, Type = Uint8Array) => ({
  width, height, max, channels, pad,
  pixels  : new Type(width * height * channels),
  rows    : new Uint32Array(height),   // marca de la última escritura de cada fila
  gen     : 0,                         // cambia al crecer o compactar: se sube entera
  shelves : [],                        // { y, h, x }
  bottom  : 0,
  idle    : 0,                         // glifos con celda y sin referencias: lo que una compactación soltaría
  waste   : 0,                         // px² de celdas abandonadas al volver a rasterizar
})

const growPage = page => {
  const pixels = new page.pixels.constructor(page.pixels.length * 2)
  const rows   = new Uint32Array(page.height * 2)
  pixels.set(page.pixels)
  rows.set(page.rows)
  page.pixels  = pixels
  page.rows    = rows
  page.height *= 2
  page.gen++
}

const classOf = h => Math.ceil(h / HOLGURA) * HOLGURA

// El estante de la clase de `h` donde cabe `w`, o uno nuevo al fondo; -1 sin alto.
const shelfFor = (page, w, h) => {
  const cls = classOf(h)
  for (let i = 0; i < page.shelves.length; i++) {
    const s = page.shelves[i]
    if (s.h === cls && s.x + w <= page.width) return i
  }
  if (page.bottom + cls > page.height) return -1
  page.shelves.push({ y: page.bottom, h: cls, x: 0 })
  page.bottom += cls
  return page.shelves.length - 1
}

const grow = (arr, need) => {
  if (arr.length >= need) return arr
  const next = new arr.constructor(Math.min(Math.max(arr.length * 2, need), MAX_GLIFOS))
  next.set(arr)
  return next
}

const workContext = () => (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(64, 64) : document.createElement('canvas'))
  .getContext('2d', { willReadFrequently: true })

/** Un atlas vacío. `ctx` es el contexto 2D de trabajo; sin él se crea uno al primer uso. Uno por realm basta: lo
 *  comparten los mapas de la página, y cada contexto GL sube su copia. */
export const createGlyphAtlas = ctx => {
  const fonts   = new Map()             // font CSS → { key, px, scale, alfaPedido, alfaBase }
  const byKey   = new Map()             // font de la base → { units: grafema → id, runs: texto → id }
  const kerns   = new Map()             // a · MAX_GLIFOS + b → px de la base
  const free    = []                    // ids sueltos, que se reusan
  const queue   = []                    // ids por rasterizar, en orden de pedido
  const keys    = []                    // id → font de la base
  const texts   = []                    // id → grafema o corrida
  const owners  = []                    // id → el mapa que lo nombra
  const at      = { x: 0, y: 0 }
  let state     = new Uint8Array(64)
  let refs      = new Int32Array(64)
  let kind      = new Uint8Array(64)    // KERN, RUN o 0
  let count     = 1                     // el 0 es el glifo vacío
  let head      = 0
  let orphans   = 0                     // glifos sin referencias, con celda o sin ella: los ids que soltaría compactar
  let overflown = 0                     // glifos sin lugar, que esperan una compactación
  let retry     = false                 // con algo sin lugar, una celda quedó sin referencias: compactar en el próximo flush
  let current   = VACIO                 // el que se rasteriza: compactar no lo suelta
  let scratch   = createScratch(64)
  let full      = false
  let wide      = false

  const sdf   = newPage(SDF_ANCHO, SDF_ALTO, SDF_MAX_ALTO, 1, PAD)
  const color = newPage(COLOR_ANCHO, COLOR_ALTO, COLOR_MAX_ALTO, 4, COLOR_PAD)
  const meta  = newPage(META_ANCHO, 1, MAX_GLIFOS * 2 / META_ANCHO, 4, 0, Float32Array)
  const pages = [sdf, color]
  state[VACIO] = READY

  const atlas = {
    sdf, color, meta,
    stamp : 0,                          // sube con cada escritura en cualquier página
    stats : { rasterMs: 0, rastered: 0, compactions: 0, overflow: 0 },
    get pending() { return queue.length - head },
  }

  const work = () => ctx ??= workContext()

  const stampMeta = id => (meta.rows[(2 * id / META_ANCHO) | 0] = ++atlas.stamp)

  const hasCell = id => state[id] === READY && meta.pixels[META * id + 2] > 0
  const pageOf  = id => pages[meta.pixels[META * id + 7]]

  // La celda vacía: no se dibuja hasta rasterizar. Conserva el avance y la página.
  const clearCell = id => {
    meta.pixels.fill(0, META * id, META * id + 6)
    stampMeta(id)
  }

  const warnFull = () => {
    atlas.stats.overflow++
    full || console.warn('[cristae] el atlas de glifos de los rótulos está lleno: hay glifos que no se dibujan')
    full = true
  }

  // Un texto entero más ancho que la página no cabrá nunca, ni vaciando el atlas: queda sin celda, sin reintentos.
  const warnWide = () => {
    atlas.stats.overflow++
    wide || console.warn('[cristae] un texto de los rótulos es más ancho que el atlas de glifos: no se dibuja')
    wide = true
  }

  // Suelta un glifo sin referencias: su nombre, su id y su celda, que el reempaque no copia.
  const release = id => {
    owners[id].get(texts[id]) === id && owners[id].delete(texts[id])
    hasCell(id) && pageOf(id).idle--
    orphans--
    state[id]  = FREE
    owners[id] = keys[id] = texts[id] = null
    meta.pixels.fill(0, META * id, META * id + META)
    stampMeta(id)
    free.push(id)
  }

  // Reempaca en una página nueva del mismo alto lo que quedó vivo, de más alto a más ancho, sin rasterizar. Un estante
  // de primer ajuste no siempre acomoda lo mismo en otro orden: lo que ya no cabe vuelve a la cola sin celda.
  const repack = page => {
    const live = []
    for (let id = 1; id < count; id++) hasCell(id) && pageOf(id) === page && live.push(id)
    const m = meta.pixels
    live.sort((a, b) => classOf(m[META * b + 3]) - classOf(m[META * a + 3]) || m[META * b + 2] - m[META * a + 2] || a - b)
    const old = page.pixels, ch = page.channels
    page.pixels         = new old.constructor(old.length)
    page.shelves.length = 0
    page.bottom         = 0
    page.waste          = 0
    live.forEach(id => {
      const o = META * id, w = m[o + 2], h = m[o + 3]
      const s = shelfFor(page, w, h)
      if (s < 0) {
        refs[id] === 0 && page.idle--
        state[id] = PENDING
        clearCell(id)
        return queue.push(id)
      }
      const shelf = page.shelves[s]
      for (let r = 0; r < h; r++) {
        const from = ((m[o + 1] + r) * page.width + m[o]) * ch
        page.pixels.set(old.subarray(from, from + w * ch), ((shelf.y + r) * page.width + shelf.x) * ch)
      }
      m[o]     = shelf.x
      m[o + 1] = shelf.y
      shelf.x += w
      stampMeta(id)
    })
    page.rows.fill(++atlas.stamp)
    page.gen++
  }

  // Suelta todo lo que no tiene referencias y reempaca las páginas que perdieron celdas o tenían basura. Lo que quedó
  // sin lugar y tiene referencias vuelve a la cola.
  const compact = () => {
    const dirty = pages.map(page => page.idle > 0 || page.waste > 0)
    for (let id = 1; id < count; id++) state[id] !== FREE && refs[id] === 0 && id !== current && release(id)
    kerns.clear()
    pages.forEach((page, i) => dirty[i] && repack(page))
    for (let id = 1; id < count; id++) state[id] === OVERFLOW && (state[id] = PENDING, queue.push(id))
    overflown = 0
    retry     = false
    atlas.stats.compactions++
  }

  // Un lugar de `w` × `h` en `page`, en `at`: crece hasta su tope y, en el tope, compacta si eso suelta algo.
  const reserve = (page, w, h) => {
    let s = shelfFor(page, w, h)
    while (s < 0 && page.height < page.max) {
      growPage(page)
      s = shelfFor(page, w, h)
    }
    if (s < 0 && (page.idle > 0 || page.waste > 0)) {
      compact()
      s = shelfFor(page, w, h)
    }
    if (s < 0) return false
    const shelf = page.shelves[s]
    at.x     = shelf.x
    at.y     = shelf.y
    shelf.x += w
    return true
  }

  const newId = () => {
    if (free.length) return free.pop()
    if (count < MAX_GLIFOS) return count++
    orphans > 0 && compact()
    return free.pop() ?? (warnFull(), VACIO)
  }

  const create = (owner, key, text, run) => {
    const id = newId()
    if (id === VACIO) return id
    state = grow(state, id + 1)
    refs  = grow(refs, id + 1)
    kind  = grow(kind, id + 1)
    while (2 * (id + 1) > meta.width * meta.height) growPage(meta)
    state[id]  = PENDING
    refs[id]   = 0
    kind[id]   = run ? RUN : KERN_SCRIPTS.test(text) && !EMOJI.test(text) ? KERN : 0
    keys[id]   = key
    texts[id]  = text
    owners[id] = owner
    owner.set(text, id)
    orphans++
    meta.pixels.fill(0, META * id, META * id + META)
    stampMeta(id)
    queue.push(id)
    return id
  }

  // Dibuja el glifo `id` en el lienzo de trabajo con la tinta corrida `PAD` px y devuelve sus píxeles.
  const draw = (c, id, rx, ry, w, h) => {
    if (c.canvas.width < w || c.canvas.height < h) {
      c.canvas.width  = Math.max(c.canvas.width, w)
      c.canvas.height = Math.max(c.canvas.height, h)
    }
    c.font         = keys[id]
    c.textAlign    = 'center'
    c.textBaseline = 'middle'
    c.fillStyle    = SONDA
    c.clearRect(0, 0, w, h)
    c.fillText(texts[id], rx, ry)
    return c.getImageData(0, 0, w, h).data
  }

  // Sin color: todo lo pintado es la sonda.
  const monochrome = rgba => {
    for (let i = 0; i < rgba.length; i += 4)
      if (rgba[i + 3] && (rgba[i] !== 255 || rgba[i + 1] !== 0 || rgba[i + 2] !== 255)) return false
    return true
  }

  // Rasteriza `id`: lo mide centrado en su avance y en la línea media, elige la página, toma lugar y escribe la celda.
  const rasterize = id => {
    current = id
    const c = work()
    c.font         = keys[id]
    c.textAlign    = 'center'
    c.textBaseline = 'middle'
    const mt   = c.measureText(texts[id])
    const left = mt.actualBoundingBoxLeft, asc = mt.actualBoundingBoxAscent
    const inkW = Math.ceil(left + mt.actualBoundingBoxRight), inkH = Math.ceil(asc + mt.actualBoundingBoxDescent)
    const o    = META * id
    const m    = meta.pixels
    m[o + 6] = mt.width
    m[o + 7] = SDF
    if (!(inkW > 0 && inkH > 0)) {
      state[id] = READY
      return clearCell(id)
    }
    const rx = PAD + left, ry = PAD + asc, fw = inkW + 2 * PAD, fh = inkH + 2 * PAD
    let rgba = null
    let page = sdf
    if (kind[id] !== RUN && EMOJI.test(texts[id])) {
      rgba = draw(c, id, rx, ry, fw, fh)
      monochrome(rgba) || (page = color)
    }
    const shift = PAD - page.pad
    const w = fw - 2 * shift, h = fh - 2 * shift
    if (w > page.width || h > page.max) {
      state[id] = READY
      clearCell(id)
      return warnWide()
    }
    if (!reserve(page, w, h)) {
      state[id] = OVERFLOW
      overflown++
      clearCell(id)
      return warnFull()
    }
    rgba ??= draw(c, id, rx, ry, fw, fh)
    if (page === sdf) {
      scratch = fitScratch(scratch, fw, fh)
      distanceField(rgba, fw, fh, RADIO, CORTE, scratch, sdf.pixels, at.y * sdf.width + at.x, sdf.width)
    } else {
      for (let r = 0; r < h; r++) {
        let from = ((r + shift) * fw + shift) * 4
        let to   = ((at.y + r) * color.width + at.x) * 4
        for (let c = 0; c < w; c++, from += 4, to += 4) {
          const a = rgba[from + 3]
          color.pixels[to]     = (rgba[from] * a + 127) / 255
          color.pixels[to + 1] = (rgba[from + 1] * a + 127) / 255
          color.pixels[to + 2] = (rgba[from + 2] * a + 127) / 255
          color.pixels[to + 3] = a
        }
      }
    }
    m[o]     = at.x
    m[o + 1] = at.y
    m[o + 2] = w
    m[o + 3] = h
    m[o + 4] = shift - rx
    m[o + 5] = shift - ry
    m[o + 7] = page === sdf ? SDF : COLOR
    page.rows.fill(++atlas.stamp, at.y, at.y + h)
    stampMeta(id)
    state[id] = READY
    refs[id] === 0 && page.idle++
    atlas.stats.rastered++
  }

  const mapsOf = key => {
    let maps = byKey.get(key)
    maps || byKey.set(key, maps = { units: new Map(), runs: new Map() })
    return maps
  }

  // La distancia de la línea media a la alfabética de REFERENCIA con la fuente `k`.
  const drop = (c, k) => {
    c.font         = k
    c.textBaseline = 'alphabetic'
    const a        = c.measureText(REFERENCIA).actualBoundingBoxAscent
    c.textBaseline = 'middle'
    return a - c.measureText(REFERENCIA).actualBoundingBoxAscent
  }

  // La fuente con su tamaño en px, como la normaliza el canvas (`12pt Arial` es `16px Arial`, `bold Arial` es `bold 10px
  // Arial`): una sin px no admite el tamaño de la base pegado al final, que daría una fuente inválida que el canvas
  // ignora. Una que el canvas rechaza deja la de respaldo.
  const sizedFont = font => {
    const c = work()
    c.font = FUENTE_RESPALDO
    c.font = font
    return c.font
  }

  // El camino de una fuente que no se conocía. Va aparte de `fontOf`: una clausura en su cuerpo haría que V8 abriera
  // un contexto en cada entrada, aun con la fuente ya vista.
  const measuredFont = font => {
    const css = PX.test(font) ? font : sizedFont(font)
    const m   = PX.exec(css)
    const key = m ? css.replace(PX, `${BASE_PX}px`) : `${css} ${BASE_PX}px`
    const px  = m ? +m[1] : 10
    const f   = { key, px, scale: px / BASE_PX, alfaPedido: drop(work(), font), alfaBase: drop(work(), key) }
    fonts.set(font, f)
    mapsOf(key)
    return f
  }

  /** La fuente de la base de `font` (su `key`), su tamaño pedido y la escala a la base, y la distancia de la línea
   *  media a la alfabética al tamaño pedido (px CSS) y a la base (px de la base): el canvas redondea sus métricas a
   *  cada tamaño, así que la de la base escalada no coincide. [0-alloc] con la fuente ya vista. */
  atlas.fontOf = font => fonts.get(font) ?? measuredFont(font)

  /** El id del grafema `unit` en la fuente de la base `key`. Uno nuevo entra a la cola y no se dibuja hasta que
   *  `flush` lo rasteriza. El 0 si el atlas no tiene más ids. [0-alloc] con el grafema ya pedido. */
  atlas.glyph = (key, unit) => {
    const units = mapsOf(key).units
    return units.get(unit) ?? create(units, key, unit, false)
  }

  /** El id de `text` entero como un solo glifo (corrida), aparte de los grafemas: un texto de un grafema es las dos
   *  cosas. */
  atlas.run = (key, text) => {
    const runs = mapsOf(key).runs
    return runs.get(text) ?? create(runs, key, text, true)
  }

  /** El ajuste del par de glifos (a, b) en px de la base; 0 fuera de los sistemas que lo usan. [0-alloc] con el par
   *  ya medido. */
  atlas.kern = (a, b) => {
    if ((kind[a] & kind[b]) !== KERN) return 0
    const k = a * MAX_GLIFOS + b
    let v = kerns.get(k)
    if (v !== undefined) return v
    const c = work()
    c.font = keys[a]
    v = c.measureText(texts[a] + texts[b]).width - c.measureText(texts[a]).width - c.measureText(texts[b]).width
    v = Math.abs(v) < 1e-3 ? 0 : v
    kerns.set(k, v)
    return v
  }

  /** Una instancia más usa `id`. [0-alloc] */
  atlas.ref = id => {
    if (id === VACIO || refs[id]++) return
    orphans--
    hasCell(id) && pageOf(id).idle--
  }

  /** Una instancia menos usa `id`. Sin referencias queda de caché hasta que haga falta lugar. [0-alloc] */
  atlas.unref = id => {
    if (id === VACIO || --refs[id]) return
    orphans++
    if (!hasCell(id)) return
    pageOf(id).idle++
    retry ||= overflown > 0
  }

  /** Rasteriza lo pendiente, en orden de pedido, hasta gastar `budget` ms (siempre al menos uno) y devuelve cuántos
   *  quedan. [0-alloc] sin cola. */
  atlas.flush = (budget = RASTER_BUDGET_MS) => {
    retry && sdf.idle + color.idle > 0 && compact()
    if (head >= queue.length) return 0
    const t0 = performance.now()
    let t = t0
    do {
      const id = queue[head++]
      state[id] === PENDING && rasterize(id)
      t = performance.now()
    } while (head < queue.length && t - t0 < budget)
    current = VACIO
    atlas.stats.rasterMs += t - t0
    if (head >= queue.length) queue.length = head = 0
    return queue.length - head
  }

  /** La fuente `font` terminó de cargar: sus glifos vuelven a la cola con los mismos ids, y sus métricas se miden de
   *  nuevo. Las celdas viejas quedan como basura hasta la próxima compactación. */
  atlas.forget = font => {
    const key = fonts.get(font)?.key
    if (!key) return
    fonts.forEach((f, css) => f.key === key && fonts.delete(css))
    kerns.clear()
    for (let id = 1; id < count; id++) {
      if (keys[id] !== key || state[id] === PENDING || state[id] === FREE) continue
      state[id] === OVERFLOW && overflown--
      if (hasCell(id)) {
        const page = pageOf(id)
        page.waste += meta.pixels[META * id + 2] * meta.pixels[META * id + 3]
        refs[id] === 0 && page.idle--
      }
      state[id] = PENDING
      clearCell(id)
      queue.push(id)
    }
  }

  return atlas
}
