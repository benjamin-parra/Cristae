// El atlas de glifos de los rótulos `gl`: determinista, con la cola y su tope de tiempo, las referencias, la
// compactación que sólo corre si suelta algo, el tope que no lanza, el emoji en la página de color, el ajuste por par
// sólo donde se usa, las métricas por tamaño y 0 B en el camino de cada recolocación. El canvas es un contexto 2D falso
// y determinista: mide por clase de grafema, pinta la caja de tinta con antialias en los bordes y, con el emoji, colores
// que no son los del `fillStyle`. Corre con:
//   node --test test/render/label-glyphs.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  BASE_PX, COLOR, CORTE, HALO_PX, META, RADIO, RASTER_BUDGET_MS, SDF, createGlyphAtlas, dirtyRows, needsRun, snapBaseline,
} from '../../src/render/labelGlyphs.js'
import { bytesPorLlamada } from '../../test-helpers/asignaciones.mjs'

const FUENTE = '700 10.5px Inter'
const BASE   = `700 ${BASE_PX}px Inter`
const HAN    = /\p{Script=Han}/u
const EMOJI  = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u

// La caja de tinta de cada grafema a `px`: los ideogramas son un cuadrado, el emoji uno más ancho y el latino varía con
// el código, para que haya estantes de varios altos.
const caja = (text, px, variada = false) => {
  if (text === ' ') return { width: px * 0.3, l: 0, r: 0, a: 0, d: 0 }
  if (EMOJI.test(text)) return { width: px * 1.2, l: px * 0.55, r: px * 0.55, a: px * 0.5, d: px * 0.5 }
  if (HAN.test(text) && variada) {
    const k = text.codePointAt(0), ancho = 0.5 + (k % 7) * 0.08, alto = 0.3 + (k % 5) * 0.07
    return { width: px, l: px * ancho / 2, r: px * ancho / 2, a: px * alto, d: px * alto * 0.8 }
  }
  if (HAN.test(text)) return { width: px, l: px * 0.45, r: px * 0.45, a: px * 0.45, d: px * 0.5 }
  const k = text.codePointAt(0)
  const w = px * (0.4 + (k % 5) * 0.05)
  return { width: w * [...text].length, l: w * 0.45, r: w * 0.45, a: px * (k % 2 ? 0.7 : 0.5), d: k % 3 ? 0 : px * 0.2 }
}

// Los pares que la fuente falsa ajusta: el ajuste es la resta del ancho del par y el de cada grafema.
const CORRECCION = { AV: 2, 'T.': 1, '😀a': 3 }

/** Un contexto 2D falso. `mono`: el emoji sale del `fillStyle`, como sin fuente de color. `reloj`: cada lectura de
 *  píxeles avanza `costo` ms del reloj falso. Cuenta las medidas en `medidas`. */
const contexto = ({ mono = false, reloj = null, costo = 0, variada = false, largo = 0 } = {}) => {
  const canvas = { width: 64, height: 64 }
  let buf = new Uint8ClampedArray(64 * 64 * 4), bw = 64
  const ajustar = () => {
    if (bw === canvas.width && buf.length === canvas.width * canvas.height * 4) return
    buf = new Uint8ClampedArray(canvas.width * canvas.height * 4)
    bw  = canvas.width
  }
  const px  = () => Number(/(\d+(?:\.\d+)?)px/.exec(ctx.font)[1])
  const ctx = {
    canvas, font: '', textAlign: 'start', textBaseline: 'alphabetic', fillStyle: '#000', medidas: 0,
    measureText(text) {
      ctx.medidas++
      const p = px()
      if (text === 'H') {
        const a = ctx.textBaseline === 'alphabetic' ? Math.round(0.72 * p) : Math.round(0.36 * p)
        return { width: p * 0.7, actualBoundingBoxAscent: a, actualBoundingBoxDescent: 0, actualBoundingBoxLeft: 0, actualBoundingBoxRight: p * 0.7 }
      }
      const units = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(s => s.segment)
      const b     = text.length > 8 && largo ? { l: largo / 2, r: largo / 2, a: p / 2, d: p / 2 } : caja(units[0], p, variada)
      const width = units.reduce((sum, u) => sum + caja(u, p).width, 0) - (CORRECCION[text] ?? 0)
      return { width, actualBoundingBoxLeft: b.l, actualBoundingBoxRight: b.r, actualBoundingBoxAscent: b.a, actualBoundingBoxDescent: b.d }
    },
    clearRect(x, y, w, h) {
      ajustar()
      for (let r = y; r < y + h; r++) buf.fill(0, (r * bw + x) * 4, (r * bw + x + w) * 4)
    },
    // La caja de tinta con cobertura exacta en los bordes.
    fillText(text, x, y) {
      ajustar()
      const b = text.length > 8 && largo ? { l: largo / 2, r: largo / 2, a: px() / 2, d: px() / 2 } : caja(text, px(), variada)
      const x0 = x - b.l, x1 = x + b.r, y0 = y - b.a, y1 = y + b.d
      const cp = text.codePointAt(0)
      const [cr, cg, cb] = EMOJI.test(text) && !mono ? [cp & 255, (cp >> 8) & 255, 90] : [255, 0, 255]
      for (let r = Math.floor(y0); r < Math.ceil(y1); r++) for (let c = Math.floor(x0); c < Math.ceil(x1); c++) {
        const cov = Math.max(0, Math.min(c + 1, x1) - Math.max(c, x0)) * Math.max(0, Math.min(r + 1, y1) - Math.max(r, y0))
        const i   = (r * bw + c) * 4
        buf[i] = cr; buf[i + 1] = cg; buf[i + 2] = cb; buf[i + 3] = Math.round(255 * cov)
      }
    },
    getImageData(x, y, w, h) {
      ajustar()
      reloj && (reloj.t += costo)
      const data = new Uint8ClampedArray(w * h * 4)
      for (let r = 0; r < h; r++) data.set(buf.subarray(((y + r) * bw + x) * 4, ((y + r) * bw + x + w) * 4), r * w * 4)
      return { data }
    },
  }
  return ctx
}

// Un reloj falso para `performance.now`, que el test restaura.
const conReloj = t => {
  const reloj = { t: 0 }
  t.mock.method(performance, 'now', () => reloj.t)
  return reloj
}

const ideogramas = n => Array.from({ length: n }, (_, i) => String.fromCodePoint(0x4E00 + i))
// Con tope de vueltas: un atlas que nunca termina de vaciar la cola falla por aserción, no por tiempo.
const vaciar     = atlas => { for (let i = 0; atlas.flush(Infinity); i++) assert.ok(i < 50, 'la cola no se vacía') }
const celda      = (atlas, id) => Array.from(atlas.meta.pixels.subarray(META * id, META * id + META))
const huella     = atlas => createHash('sha256').update(atlas.sdf.pixels).update(atlas.color.pixels)
  .update(new Uint8Array(atlas.meta.pixels.buffer)).digest('hex')

// Los bytes de la celda de `id` en la página de campos.
const bytesDe = (atlas, id) => {
  const [x, y, w, h] = celda(atlas, id)
  const out = []
  for (let r = 0; r < h; r++) out.push(...atlas.sdf.pixels.subarray((y + r) * atlas.sdf.width + x, (y + r) * atlas.sdf.width + x + w))
  return out
}

test('el campo cubre el halo y el antialias al tamaño más chico que se dibuja', () => {
  const chico = 10.5                                     // el rótulo por defecto, a DPR 1
  assert.ok(RADIO * (1 - CORTE) >= (HALO_PX + 1) * BASE_PX / chico, 'afuera')
  assert.ok(RADIO * CORTE >= 2, 'adentro: el antialias de un trazo de 2 a 3 px de la base')
})

test('un glifo nuevo no se dibuja hasta que flush lo rasteriza, y queda en su celda con su meta', () => {
  const atlas = createGlyphAtlas(contexto())
  const { key } = atlas.fontOf(FUENTE)
  const id = atlas.glyph(key, 'A')
  assert.ok(id > 0)
  assert.deepEqual(celda(atlas, id).slice(0, 4), [0, 0, 0, 0], 'sin celda: el shader no lo dibuja')
  assert.equal(atlas.pending, 1)
  assert.equal(atlas.glyph(key, 'A'), id, 'el mismo id al pedirlo de nuevo')
  const marca = atlas.stamp
  assert.equal(atlas.flush(), 0)
  const [x, y, w, h, ox, oy, avance, pagina] = celda(atlas, id)
  assert.equal(pagina, SDF)
  assert.ok(w > 2 * 7 && h > 2 * 7, 'la tinta y el campo de afuera alrededor')
  assert.deepEqual([x, y], [0, 0])
  assert.ok(ox < 0 && oy < 0, 'la esquina queda arriba a la izquierda del punto de referencia')
  assert.ok(Math.abs(avance - caja('A', BASE_PX).width) < 1e-4, 'el avance a la base')
  const bytes = bytesDe(atlas, id)
  assert.equal(Math.max(...bytes), 255, 'adentro de la tinta')
  assert.equal(bytes[0], 0, 'la esquina, lejos del contorno')
  const filas = dirtyRows(atlas.sdf, marca, {})
  assert.deepEqual([filas.y0, filas.y1], [0, h], 'sube sólo las filas de la celda')
  assert.equal(dirtyRows(atlas.sdf, atlas.stamp, {}).y1, 0, 'y nada después de la última marca')
  assert.equal(dirtyRows(atlas.sdf, atlas.sdf.rows[0], {}).y1, 0, 'la marca ya subida no es nueva')
  assert.ok(atlas.meta.rows[0] > marca, 'la fila de meta también')
})

test('determinista: lo mismo pedido en el mismo orden da los mismos bytes, rasterice de a uno o todo junto', t => {
  const textos = ['Ñandú', 'Πάτρα', 'Москва', '東京都', 'a b', '😀 🇨🇱']
  const armar = budget => {
    const reloj = conReloj(t)
    const atlas = createGlyphAtlas(contexto({ reloj, costo: 0.3 }))
    const { key } = atlas.fontOf(FUENTE)
    textos.forEach(texto => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(texto)].forEach(s => atlas.glyph(key, s.segment)))
    atlas.run(key, 'القاهرة')
    let vueltas = 0
    while (atlas.flush(budget)) vueltas++
    t.mock.restoreAll()
    return { h: huella(atlas), vueltas }
  }
  const junto = armar(Infinity)
  const de1   = armar(0)
  assert.equal(junto.vueltas, 0)
  assert.ok(de1.vueltas > 20, `${de1.vueltas} cuadros`)
  assert.equal(de1.h, junto.h)
  assert.equal(armar(RASTER_BUDGET_MS).h, junto.h)
})

test('el tope por cuadro reparte la primera carga CJK: ningún flush pasa el tope más un glifo', t => {
  const reloj = conReloj(t)
  const COSTO = 0.3                                      // ms por glifo, lo medido en una Arc B580
  const atlas = createGlyphAtlas(contexto({ reloj, costo: COSTO }))
  const { key } = atlas.fontOf('16px Noto Sans CJK')
  ideogramas(1903).forEach(u => atlas.glyph(key, u))     // los distintos de 1.000 textos de tres ideogramas
  const cuadros = []
  let quedan = atlas.pending
  while (quedan) {
    const t0 = reloj.t
    quedan = atlas.flush()
    cuadros.push(reloj.t - t0)
  }
  const peor = Math.max(...cuadros)
  assert.ok(peor <= RASTER_BUDGET_MS + COSTO + 1e-9, `peor cuadro ${peor} ms`)
  assert.ok(peor < 50)
  assert.ok(cuadros.length >= Math.floor(1903 * COSTO / (RASTER_BUDGET_MS + COSTO)), `${cuadros.length} cuadros`)
  assert.equal(atlas.stats.rastered, 1903)
  assert.equal(atlas.flush(0), 0, 'sin cola no hace nada')
})

test('con tope 0 rasteriza igual uno por llamada: siempre avanza', t => {
  conReloj(t)
  const atlas = createGlyphAtlas(contexto())
  const { key } = atlas.fontOf(FUENTE)
  ;['a', 'b', 'c'].forEach(u => atlas.glyph(key, u))
  assert.deepEqual([atlas.flush(0), atlas.flush(0), atlas.flush(0)], [2, 1, 0])
})

test('el tope del atlas no lanza: 10.000 ideogramas llenan la página, avisan una vez y lo que no cabe no se dibuja', t => {
  const warn  = t.mock.method(console, 'warn', () => {})
  const atlas = createGlyphAtlas(contexto())
  const { key } = atlas.fontOf('16px Noto Sans CJK')
  const ids = ideogramas(10_000).map(u => atlas.glyph(key, u))
  ids.forEach(atlas.ref)
  assert.doesNotThrow(() => vaciar(atlas))
  const dibujados = ids.filter(id => celda(atlas, id)[2] > 0).length
  assert.equal(atlas.sdf.height, 4096, 'creció hasta el tope')
  assert.ok(atlas.sdf.rows[0] > 0, 'y conservó la marca de lo escrito')
  assert.ok(dibujados > 2500 && dibujados < 3200, `${dibujados} caben (unos 2.800)`)
  assert.equal(atlas.stats.overflow, 10_000 - dibujados)
  assert.equal(atlas.stats.compactions, 0, 'todos con referencias: compactar no soltaría nada')
  assert.equal(warn.mock.callCount(), 1)
  assert.match(warn.mock.calls[0].arguments[0], /lleno/)
  let area = 0
  ids.forEach(id => { const [, , w, h] = celda(atlas, id); area += w * h })
  const llenado = area / (atlas.sdf.width * atlas.sdf.bottom)
  assert.ok(llenado >= 0.9, `llenado ${(100 * llenado).toFixed(1)} % del alto usado`)
})

test('compacta sólo si suelta algo: suelta lo sin referencias, conserva los vivos y dibuja lo que esperaba lugar', t => {
  t.mock.method(console, 'warn', () => {})
  const atlas = createGlyphAtlas(contexto())
  const { key } = atlas.fontOf('16px Noto Sans CJK')
  const ids = ideogramas(3200).map(u => atlas.glyph(key, u))
  ids.forEach(atlas.ref)
  vaciar(atlas)
  const fuera = ids.filter(id => !(celda(atlas, id)[2] > 0))
  assert.ok(fuera.length > 0, 'llenó la página')
  const gen = atlas.sdf.gen
  atlas.flush()
  assert.equal(atlas.stats.compactions, 0, 'sin nada que soltar no compacta')

  const vivo   = ids[ids.length - fuera.length - 1]    // el último que entró, que el reempaque mueve
  const antes  = bytesDe(atlas, vivo)
  const sueltos = ids.slice(0, 400)
  const marcaAntes = atlas.stamp
  sueltos.forEach(atlas.unref)
  assert.equal(atlas.glyph(key, ideogramas(1)[0]), ids[0], 'sin referencias sigue de caché')
  vaciar(atlas)
  assert.equal(atlas.stats.compactions, 1)
  assert.ok(atlas.sdf.gen > gen, 'la página se sube entera')
  const sucias = dirtyRows(atlas.sdf, marcaAntes, {})
  assert.deepEqual([sucias.y0, sucias.y1], [0, atlas.sdf.height], 'y con todas las filas marcadas')
  assert.equal(atlas.color.gen, 0, 'la página de color no se reempaca si no perdió nada')
  assert.deepEqual(bytesDe(atlas, vivo), antes, 'el vivo conserva su campo, aunque cambie de lugar')
  assert.ok(fuera.every(id => celda(atlas, id)[2] > 0), 'lo que esperaba lugar ya se dibuja')
  assert.ok(sueltos.every(id => celda(atlas, id)[2] === 0), 'lo suelto no')
  const nuevo = atlas.glyph(key, ideogramas(1)[0])
  assert.ok(sueltos.includes(nuevo), 'su id se reusa')
  assert.equal(atlas.pending, 1, 'y se vuelve a rasterizar')
})

test('lo rasterizado sin referencias es caché: una página llena lo suelta para lo que sí se usa', t => {
  t.mock.method(console, 'warn', () => {})
  const atlas = createGlyphAtlas(contexto())
  const { key } = atlas.fontOf('16px Noto Sans CJK')
  const cache = ideogramas(600).map(u => atlas.glyph(key, u))
  vaciar(atlas)
  const usados = ideogramas(3000).slice(600).map(u => atlas.glyph(key, u))
  usados.forEach(atlas.ref)
  vaciar(atlas)
  assert.equal(atlas.stats.compactions, 1)
  assert.ok(usados.every(id => celda(atlas, id)[2] > 0), 'todo lo usado se dibuja')
  assert.ok(cache.some(id => celda(atlas, id)[2] === 0), 'a costa de la caché')
  assert.equal(atlas.stats.overflow, 0, 'sin avisar')
})

test('el emoji va a la página de color con sus colores; sin fuente de color, al campo; la corrida nunca', () => {
  const atlas = createGlyphAtlas(contexto())
  const { key } = atlas.fontOf(FUENTE)
  const cara    = atlas.glyph(key, '😀')
  const familia = atlas.glyph(key, '👨‍👩‍👧')            // un grafema con ZWJ, como lo parte labelText
  const letra   = atlas.glyph(key, 'a')
  vaciar(atlas)
  ;[cara, familia].forEach(id => {
    const [x, y, w, h, , , , pagina] = celda(atlas, id)
    assert.equal(pagina, COLOR)
    let tinta = 0, sonda = 0
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const i = ((y + r) * atlas.color.width + x + c) * 4
      if (!atlas.color.pixels[i + 3]) continue
      tinta++
      atlas.color.pixels[i] === 255 && atlas.color.pixels[i + 1] === 0 && sonda++
    }
    assert.ok(tinta > 100 && sonda === 0, `${tinta} px de color propio`)
    const [, , , , ox, oy] = celda(atlas, id)
    const b = caja(id === cara ? '😀' : '👨', BASE_PX)
    assert.ok(Math.abs(ox + 1 + b.l) < 1e-4 && Math.abs(oy + 1 + b.a) < 1e-4, 'la esquina a 1 px de la tinta')
    assert.ok(w < celda(atlas, letra)[2] + 30, 'con 1 px de margen, no los 7 del campo')
  })
  assert.equal(celda(atlas, letra)[7], SDF)
  assert.equal(atlas.kern(cara, letra), 0, 'sin ajuste con el emoji, aunque la fuente ajuste el par')

  const mono = createGlyphAtlas(contexto({ mono: true }))
  const id = mono.glyph(mono.fontOf(FUENTE).key, '😀')
  vaciar(mono)
  assert.equal(celda(mono, id)[7], SDF, 'monocromo: del color del texto')
  assert.ok(celda(mono, id)[2] > 0)

  const run = atlas.run(key, '😀')
  vaciar(atlas)
  assert.notEqual(run, cara, 'la corrida es otro glifo')
  assert.equal(celda(atlas, run)[7], SDF)
})

test('needsRun: las escrituras que se modelan van enteras; el emoji con ZWJ no', () => {
  assert.ok(needsRun('القاهرة'))
  assert.ok(needsRun('नई दिल्ली'))
  assert.ok(needsRun('a\u202Eb'), 'un control bidi')
  assert.ok(!needsRun('Ñandú'))
  assert.ok(!needsRun('東京'))
  assert.ok(!needsRun('👨‍👩‍👧'), 'el ZWJ del emoji no es modelado')
})

test('el ajuste por par: medido una vez en latino, griego y cirílico; nunca en CJK', () => {
  const ctx   = contexto()
  const atlas = createGlyphAtlas(ctx)
  const { key } = atlas.fontOf(FUENTE)
  const [a, v] = ['A', 'V'].map(u => atlas.glyph(key, u))
  const n = ctx.medidas
  assert.equal(atlas.kern(a, v), -2)
  assert.equal(ctx.medidas, n + 3)
  assert.equal(atlas.kern(a, v), -2)
  assert.equal(ctx.medidas, n + 3, 'de la caché')
  assert.equal(atlas.kern(v, a), 0, 'el par al revés es otro par')
  const [g, c] = ['λ', 'Ж'].map(u => atlas.glyph(key, u))
  atlas.kern(g, c)
  assert.equal(ctx.medidas, n + 9, 'griego con cirílico se mide')
  const [t, punto] = ['T', '.'].map(u => atlas.glyph(key, u))
  assert.equal(atlas.kern(t, punto), -1, 'lo común (el punto, el espacio, los dígitos) se ajusta con el latino')
  const [x, y] = ['東', '京'].map(u => atlas.glyph(key, u))
  const m = ctx.medidas
  assert.equal(atlas.kern(x, y), 0)
  assert.equal(atlas.kern(a, x), 0)
  assert.equal(ctx.medidas, m, 'CJK no mide')
})

test('las métricas de la línea alfabética se miden a cada tamaño, no se escalan; y la línea cae en px de dispositivo', () => {
  const atlas = createGlyphAtlas(contexto())
  const f = atlas.fontOf(FUENTE)
  assert.equal(f.key, BASE)
  assert.equal(f.scale, 10.5 / BASE_PX)
  assert.equal(atlas.fontOf('700 12px Inter').key, BASE, 'otro tamaño, la misma base')
  assert.equal(f.alfaPedido, 4)                          // round(0,72 · 10,5) − round(0,36 · 10,5)
  assert.equal(f.alfaBase, 8)                            // round(0,72 · 24) − round(0,36 · 24)
  assert.notEqual(f.alfaPedido, f.alfaBase * f.scale)
  assert.equal(atlas.fontOf(FUENTE), f, 'memo por fuente')
  assert.equal(snapBaseline(10.3, 1), 10)
  assert.equal(snapBaseline(10.3, 2), 10.5)
  assert.equal(snapBaseline(10.2, 1.5), 10)
})

test('forget: la fuente cargada rasteriza de nuevo con los mismos ids, y la celda vieja es basura que se compacta', () => {
  const atlas = createGlyphAtlas(contexto())
  const { key } = atlas.fontOf(FUENTE)
  const id = atlas.glyph(key, 'Q')
  atlas.ref(id)
  vaciar(atlas)
  const primera = celda(atlas, id)
  const marca = atlas.stamp
  atlas.forget(FUENTE)
  assert.ok(atlas.meta.rows[0] > marca, 'la meta vaciada se marca para subirla')
  assert.equal(celda(atlas, id)[2], 0)
  assert.equal(atlas.pending, 1)
  assert.equal(atlas.glyph(key, 'Q'), id, 'el mismo id')
  vaciar(atlas)
  assert.ok(celda(atlas, id)[2] > 0)
  assert.notDeepEqual(celda(atlas, id).slice(0, 2), primera.slice(0, 2), 'en otra celda')
  assert.ok(atlas.sdf.waste > 0, 'la vieja es basura')
})

test('sin ids no lanza: da el glifo vacío, y compactar suelta los que no tienen referencias', t => {
  const warn  = t.mock.method(console, 'warn', () => {})
  const atlas = createGlyphAtlas(contexto())
  const { key } = atlas.fontOf(FUENTE)
  const ids = []
  for (let i = 0; ids.length < (1 << 15) - 1; i++) ids.push(atlas.glyph(key, String.fromCodePoint(0x10000 + i)))
  ids.forEach(atlas.ref)
  assert.equal(atlas.glyph(key, 'z'), 0, 'el vacío')
  assert.equal(warn.mock.callCount(), 1)
  atlas.unref(ids[7])
  const z = atlas.glyph(key, 'z')
  assert.equal(z, ids[7], 'compactó y reusó el id suelto')
  assert.equal(atlas.stats.compactions, 1)
  atlas.ref(z)
  atlas.ref(0)
  atlas.unref(0)
  assert.equal(atlas.glyph(key, 'y'), 0, 'el vacío no cuenta referencias ni se suelta')
  assert.equal(atlas.stats.compactions, 1, 'sin nada que soltar no vuelve a compactar')
})

test('compactar olvida los ajustes por par: el id que se reusa no hereda el ajuste del grafema que lo tuvo', t => {
  t.mock.method(console, 'warn', () => {})
  const atlas = createGlyphAtlas(contexto())
  const { key } = atlas.fontOf(FUENTE)
  const [a, v] = ['A', 'V'].map(u => atlas.glyph(key, u))
  ;[a, v].forEach(atlas.ref)
  assert.equal(atlas.kern(a, v), -2)
  for (let i = 0; atlas.glyph(key, String.fromCodePoint(0x10000 + i)) !== 0 && i < (1 << 15); i++) atlas.ref(atlas.glyph(key, String.fromCodePoint(0x10000 + i)))
  ;[a, v].forEach(atlas.unref)
  const y = atlas.glyph(key, 'y')
  const x = atlas.glyph(key, 'x')
  assert.deepEqual([x, y], [a, v], 'reusan los ids de A y V')
  assert.equal(atlas.kern(x, y), 0, 'xy no se ajusta, aunque el par de ids sí se ajustaba')
})

// SPECS §14: recolocar un rótulo con sus glifos ya en el atlas —el id de cada grafema, el ajuste del par, las
// referencias— y el flush sin cola corren por rótulo y por cuadro con el texto que cambia.
test('[0-alloc] recolocar con los glifos conocidos, la fuente ya vista y flush sin cola no asignan', () => {
  const atlas = createGlyphAtlas(contexto())
  const units = [...'Patente AB-1234 · 88 km/h']
  const ids   = new Uint16Array(units.length)
  const css   = FUENTE
  let pen     = 0
  const recolocar = () => {
    const { key, scale } = atlas.fontOf(css)
    for (let i = 0; i < units.length; i++) {
      atlas.unref(ids[i])
      ids[i] = atlas.glyph(key, units[i])
      atlas.ref(ids[i])
      i && (pen += atlas.kern(ids[i - 1], ids[i]) * scale)
    }
  }
  recolocar()
  vaciar(atlas)
  const porRotulo = bytesPorLlamada(recolocar, 2_000, { calentar: 20_000 })
  assert.ok(porRotulo < 1, `${porRotulo} B por rótulo`)
  const fuente = bytesPorLlamada(() => atlas.fontOf(css), 2_000, { calentar: 20_000 })
  assert.ok(fuente < 1, `${fuente} B por fontOf`)
  const sinCola = bytesPorLlamada(() => atlas.flush(), 2_000, { calentar: 20_000 })
  assert.ok(sinCola < 1, `${sinCola} B por flush`)
  assert.ok(Number.isFinite(pen))
})

// Las celdas vivas dentro de su página, sin solaparse, y con los bytes de rasterizar cada glifo solo.
const celdasSanas = (atlas, vivos, key, muestra = 1) => {
  const cajas = []
  vivos.forEach(({ id, texto }, i) => {
    const [x, y, w, h, , , , pagina] = celda(atlas, id)
    if (!w) return
    const page = pagina === SDF ? atlas.sdf : atlas.color
    assert.ok(x >= 0 && y >= 0 && x + w <= page.width && y + h <= page.height, `${texto} dentro de su página`)
    cajas.push({ pagina, x, y, w, h, texto })
    if (pagina !== SDF || i % muestra) return
    const solo = createGlyphAtlas(contexto({ variada: true }))
    const sid  = solo.glyph(solo.fontOf(key).key, texto)
    vaciar(solo)
    assert.deepEqual(bytesDe(atlas, id), bytesDe(solo, sid), `${texto} conserva su campo`)
  })
  cajas.sort((a, b) => a.pagina - b.pagina || a.y - b.y)
  for (let i = 0; i < cajas.length; i++) for (let j = i + 1; j < cajas.length && cajas[j].y < cajas[i].y + cajas[i].h; j++) {
    const a = cajas[i], b = cajas[j]
    assert.ok(a.pagina !== b.pagina || a.x + a.w <= b.x || b.x + b.w <= a.x, `${a.texto} y ${b.texto} no se solapan`)
  }
}

// Una secuencia de pedidos, bajas, rasterizados y cambios de fuente con semilla fija, con muchos más glifos vivos que lo
// que cabe y ideogramas de cajas distintas. La semilla 12 hacía lanzar al reempaque (un estante de primer ajuste no
// acomoda lo mismo en otro orden) a los 12.738 pasos.
test('una secuencia larga de pedidos, bajas, rasterizados y cambios de fuente no lanza y deja las celdas sanas', t => {
  t.mock.method(console, 'warn', () => {})
  let semilla = 12
  const azar = () => (semilla = (semilla * 1664525 + 1013904223) >>> 0) / 2 ** 32
  const alfabeto = [...ideogramas(7000), ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .-', '😀', '🇨🇱', '👍🏽']
  const atlas = createGlyphAtlas(contexto({ variada: true }))
  const { key } = atlas.fontOf(FUENTE)
  const vivos = new Map()                                 // id → { id, texto, n }
  for (let paso = 0; paso < 14_000; paso++) {
    const r = azar()
    if (r < 0.6) {
      const texto = alfabeto[(azar() * alfabeto.length) | 0]
      const id    = atlas.glyph(key, texto)
      if (!id) continue
      atlas.ref(id)
      const v = vivos.get(id) ?? { id, texto, n: 0 }
      v.n++
      vivos.set(id, v)
    } else if (r < 0.78 && vivos.size) {
      const v = [...vivos.values()][(azar() * vivos.size) | 0]
      atlas.unref(v.id)
      --v.n || vivos.delete(v.id)
    } else if (r < 0.97) atlas.flush(azar() < 0.5 ? 0 : Infinity)
    else if (r < 0.98) atlas.forget(FUENTE)
  }
  vaciar(atlas)
  assert.ok(atlas.stats.compactions > 100, `${atlas.stats.compactions} compactaciones`)
  celdasSanas(atlas, [...vivos.values()], key, 50)
})

test('un texto entero más ancho que la página no se dibuja, avisa una vez, no se reintenta y no pisa a los vecinos', t => {
  const warn  = t.mock.method(console, 'warn', () => {})
  const atlas = createGlyphAtlas(contexto({ largo: 1500 }))
  const { key } = atlas.fontOf(FUENTE)
  const antes = atlas.glyph(key, 'A')
  const ancho = atlas.run(key, 'x'.repeat(20))
  const otro  = atlas.run(key, 'y'.repeat(20))
  const luego = atlas.glyph(key, 'B')
  ;[antes, ancho, otro, luego].forEach(atlas.ref)
  assert.doesNotThrow(() => vaciar(atlas))
  assert.equal(celda(atlas, ancho)[2], 0, 'sin celda: el shader no lo dibuja')
  assert.equal(celda(atlas, otro)[2], 0)
  assert.ok(celda(atlas, antes)[2] > 0 && celda(atlas, luego)[2] > 0, 'los demás sí')
  assert.equal(warn.mock.callCount(), 1)
  assert.match(warn.mock.calls[0].arguments[0], /más ancho que el atlas/)
  assert.equal(atlas.stats.overflow, 2)
  assert.equal(atlas.pending, 0, 'no vuelve a la cola')
  atlas.unref(antes)
  atlas.flush()
  assert.equal(atlas.stats.compactions, 0, 'ni compacta por él')
  const solo = createGlyphAtlas(contexto({ largo: 1500 }))
  const sid  = solo.glyph(solo.fontOf(FUENTE).key, 'B')
  vaciar(solo)
  assert.deepEqual(bytesDe(atlas, luego), bytesDe(solo, sid), 'el vecino conserva su campo')
})

test('la página de color guarda el alfa premultiplicado, para que el filtrado lineal no oscurezca el borde', () => {
  const atlas = createGlyphAtlas(contexto())
  for (const emoji of ['😀', '👍']) {                   // sus colores falsos salen del código: ninguno es cero en los tres canales
    const id = atlas.glyph(atlas.fontOf(FUENTE).key, emoji)
    vaciar(atlas)
    const [x, y, w, h, , , , pagina] = celda(atlas, id)
    assert.equal(pagina, COLOR)
    const cp = emoji.codePointAt(0)
    let parciales = 0
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const i = ((y + r) * atlas.color.width + x + c) * 4
      const p = atlas.color.pixels, a = p[i + 3]
      ;[cp & 255, (cp >> 8) & 255, 90].forEach((canal, k) => assert.equal(p[i + k], Math.round(canal * a / 255), `${emoji} premultiplicado`))
      a > 0 && a < 255 && parciales++
    }
    assert.ok(parciales > 20, `${parciales} px de borde con alfa parcial`)
  }
})

test('una fuente sin px se normaliza con el canvas antes de ponerle el tamaño de la base', () => {
  const ctx = contexto()
  let css = ''
  const normas = { '12pt Arial': '16px Arial', 'bold Arial': 'bold 10px Arial' }
  Object.defineProperty(ctx, 'font', { get: () => css, set: v => { css = normas[v] ?? (/\d+px/.test(v) ? v : css) } })
  const atlas = createGlyphAtlas(ctx)
  const pt   = atlas.fontOf('12pt Arial')
  assert.equal(pt.key, `${BASE_PX}px Arial`)
  assert.equal(pt.px, 16)
  const sin  = atlas.fontOf('bold Arial')
  assert.equal(sin.key, `bold ${BASE_PX}px Arial`)
  assert.equal(sin.px, 10)
  const mala = atlas.fontOf('esto no es una fuente')
  assert.equal(mala.key, `${BASE_PX}px sans-serif`, 'la que el canvas deja si rechaza la pedida')
})
