// El renderer `gl` de los rótulos (LabelGl.js) sin GPU: un gl que anota cada llamada, una superficie de tramo falsa y
// un atlas de glifos con un contexto 2D falso. Lo que se fija:
//   · la colocación no depende de la vista: paneo, zoom y el zoom animado no recolocan ni suben instancias (que el cuadro
//     no asigna, en label-gl-alloc.test.mjs);
//   · el corrimiento de cada glifo: la caja de `labelAnchor`, los anchos de `labelText` más el ajuste por par y la línea
//     alfabética;
//   · el picking del gemelo de CPU da lo mismo que el de `labelLayout` (el del canvas) en puntos, polígonos y líneas;
//   · cada instancia toma una referencia del atlas y la suelta al recolocar y al soltar el miembro;
//   · foco y hover sin recolocar; `color` y `halo` como uniformes; `halo: 'none'` sin pase de halo;
//   · un emoji dentro de una corrida compleja sale aparte, para que vaya en color;
//   · las páginas del atlas suben enteras al crecer y por filas después; un contexto nuevo sube todo;
//   · sin WebGL2 la fábrica lanza en el acto y no deja nada.
// Corre con: node --test test/render/label-gl.test.mjs
import { ANCHO, PUNTOS, anfitrion, glFalso, instalarMedida, instancias, medida, miembro, montar, superficie, trabajo } from '../../test-helpers/rotulos-gl.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createLabelGl } from '../../src/render/LabelGl.js'
import { createGlyphAtlas } from '../../src/render/labelGlyphs.js'
import { createLayout, readLabelView } from '../../src/render/labelLayout.js'
import { createMeasure } from '../../src/render/labelText.js'
import { projX0, projY0 } from '../../src/render/project.js'

after(instalarMedida())

test('el corrimiento de cada glifo: caja de labelAnchor, anchos de labelText con ajuste por par, y la línea alfabética', () => {
  const { r, s, atlas } = montar()
  const m = miembro({ items: [PUNTOS[1]] })
  r.attach(m)
  r.resetCanvasReference()
  const inst = instancias(s.log, r.stats().glifos)
  const f = atlas.fontOf(m.opts.font)
  assert.equal(inst.length, 4, 'un glifo por grafema, espacio incluido')
  // below: el ancla cae bajo el ícono de 8 px, a 4 px de su borde; la caja crece hacia abajo.
  const cy = 4 + 4 + 5
  inst.forEach(g => assert.ok(Math.abs(g.oy - (cy + f.alfaPedido)) < 1e-4, 'la alfabética del rótulo'))
  const kern = atlas.kern(inst[0].glifo, inst[1].glifo) * f.scale
  assert.ok(kern < 0, 'la fuente falsa ajusta AV')
  const total = 4 * ANCHO + kern
  assert.ok(Math.abs(inst[0].ox - (-total / 2 + ANCHO / 2)) < 1e-4)
  assert.ok(Math.abs(inst[1].ox - inst[0].ox - (ANCHO + kern)) < 1e-4, 'la pluma avanza con el ancho más el ajuste')
  assert.ok(Math.abs(inst[3].ox - inst[2].ox - ANCHO) < 1e-4, 'sin ajuste fuera del par')
  r.destroy()
})

test('paneo, zoom y el zoom animado no recolocan ni suben instancias: sólo cambia la matriz', () => {
  const { host, r, s } = montar()
  r.attach(miembro({ items: PUNTOS }))
  r.resetCanvasReference()
  const datas = s.log.datas.length, subs = s.log.subs.length
  const ancla = instancias(s.log, r.stats().glifos)
  host.center.lng += 0.01
  r.resetCanvasReference()
  host.state.zoom = 13.5
  r.resetCanvasReference()
  r.renderAtView(12.7, { lat: -33.38, lng: -70.61 })
  assert.equal(s.log.datas.length + s.log.subs.length, datas + subs, 'ninguna subida de instancias')
  assert.deepEqual(instancias(s.log, r.stats().glifos), ancla)
  const m = s.log.matrices.at(-1)
  assert.ok(Math.abs(m[0] / (2 * 2 ** 12.7 / 800) - 1) < 1e-6, 'la matriz es la de la vista inyectada')
  r.destroy()
})

// El gemelo de CPU contra la caja de `labelLayout` con la misma vista: el picking del canvas.
const comparar = (r, m, host, n = 2000) => {
  const layout  = createLayout()
  const measure = createMeasure(medida())
  const vista   = readLabelView(host.camera, {})
  layout.place(m, vista, measure)
  let semilla = 7, distintos = 0, conHit = 0
  const azar = () => (semilla = (semilla * 16807) % 2147483647) / 2147483647
  for (let k = 0; k < n; k++) {
    const muestra = { x: azar() * 800, y: azar() * 600 }
    const a = layout.hitsAt(muestra, { x: 0, y: 0 }, []).map(p => p.id).sort()
    const b = r.hitsAt(m, muestra, []).map(p => p.id).sort()
    ;(a.length || b.length) && conHit++
    a.join() === b.join() || distintos++
  }
  return { distintos, conHit }
}

test('el picking del gemelo de CPU es el de labelLayout: puntos, polígonos y líneas, también tras paneo y zoom', () => {
  const { host, r } = montar()
  const denso = Array.from({ length: 600 }, (_, i) => ({ id: i, lat: -33.4 + ((i * 37) % 97 - 48) * 4e-4, lng: -70.6 + ((i * 53) % 89 - 44) * 6e-4, text: `P-${i}`, size: 4 + (i % 9) }))
  const caja = (lat, lng, d) => [[lat - d, lng - d], [lat - d, lng + d], [lat + d, lng + d], [lat + d, lng - d]]
  const zonas = Array.from({ length: 40 }, (_, i) => ({ id: `z${i}`, rings: caja(-33.4 + (i % 8) * 0.004 - 0.016, -70.6 + Math.floor(i / 8) * 0.006 - 0.012, 0.0015), text: `Zona ${i}` }))
  const rutas = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, path: [[-33.42 + i * 0.0013, -70.64], [-33.4 + i * 0.0011, -70.6], [-33.41 + i * 0.001, -70.55]], text: `R ${i}` }))
  const casos = [
    miembro({ id: 'p', items: denso, placement: 'right', opts: { offset: 2 } }),
    miembro({ id: 'q', items: denso, placement: 'above' }),
    miembro({ id: 'z', kind: 'polygon', placement: 'center', items: zonas, pathOf: z => z.rings, opts: { offset: 3 } }),
    miembro({ id: 'l', kind: 'line', placement: 'center', items: rutas, pathOf: x => x.path }),
  ]
  casos.forEach(m => r.attach(m))
  for (const [dlng, zoom] of [[0, 12], [0.004, 12], [-0.002, 13.3]]) {
    host.center.lng = -70.6 + dlng
    host.state.zoom = zoom
    r.resetCanvasReference()
    for (const m of casos) {
      const { distintos, conHit } = comparar(r, m, host)
      assert.ok(conHit > 5, `${m.id}: la muestra toca rótulos (${conHit})`)
      assert.equal(distintos, 0, `${m.id} a z${zoom}: ${distintos} muestras distintas`)
    }
  }
  r.destroy()
})

test('cada instancia toma una referencia del atlas y la suelta al recolocar y al soltar el miembro', () => {
  const atlas = createGlyphAtlas(trabajo())
  const cuenta = new Map()
  const { ref, unref } = atlas
  atlas.ref = id => (cuenta.set(id, (cuenta.get(id) ?? 0) + 1), ref(id))
  atlas.unref = id => (cuenta.set(id, cuenta.get(id) - 1), unref(id))
  const { r } = montar({ atlas })
  const items = PUNTOS.map(p => ({ ...p }))
  const m = miembro({ items })
  r.attach(m)
  r.resetCanvasReference()
  const vivas = () => [...cuenta.values()].reduce((s, n) => s + n, 0)
  assert.equal(vivas(), 7 + 4 + 4)
  items[0].text = 'Otra'
  m.version++
  r.invalidate(m, 'data')
  r.resetCanvasReference()
  assert.equal(vivas(), 4 + 4 + 4, 'la colocación vieja se soltó')
  assert.ok([...cuenta.values()].every(n => n >= 0))
  r.detach(m)
  assert.equal(vivas(), 0, 'nada queda referenciado')
  r.destroy()
})

test('foco y hover reescriben alfa y banderas sin recolocar; el ítem bajo el puntero va en un pase propio', () => {
  const atlas = createGlyphAtlas(trabajo())
  let glifos = 0
  const { glyph } = atlas
  atlas.glyph = (k, u) => (glifos++, glyph(k, u))
  const { r, s } = montar({ atlas })
  const m = miembro({ items: PUNTOS })
  r.attach(m)
  r.resetCanvasReference()
  const pedidos = glifos
  m.dim = new Set(['a'])
  m.hovered.add('c')
  r.invalidate(m, 'focus')
  r.invalidate(m, 'hover')
  r.resetCanvasReference()
  assert.equal(glifos, pedidos, 'no recolocó')
  const inst = instancias(s.log, r.stats().glifos)
  assert.deepEqual([...new Set(inst.slice(0, 7).map(g => g.alfa))], [255], 'a brilla')
  assert.deepEqual([...new Set(inst.slice(7, 11).map(g => g.alfa))], [Math.round(0.3 * 255)], 'b se atenúa')
  assert.deepEqual([...new Set(inst.slice(11).map(g => g.flags))], [1], 'c está bajo el puntero')
  const draws = s.log.draws.length
  r.resetCanvasReference()
  assert.equal(s.log.draws.length - draws, 4, 'halo y relleno, y otra vez para el ítem bajo el puntero')
  r.destroy()
})

test('color y halo son uniformes: el tema no recoloca; halo none no tiene pase', () => {
  const { r, s } = montar()
  const m = miembro({ items: PUNTOS })
  r.attach(m)
  r.resetCanvasReference()
  const subidas = s.log.datas.length + s.log.subs.length
  m.opts = { ...m.opts, color: '#ff0000', halo: 'none' }
  r.invalidate(m, 'style')
  const draws = s.log.draws.length
  r.resetCanvasReference()
  assert.equal(s.log.datas.length + s.log.subs.length, subidas, 'sin subir instancias')
  assert.equal(s.log.draws.length - draws, 1, 'sólo el relleno')
  assert.deepEqual(s.log.uniforms.at(-1), [1, 0, 0, 1])
  assert.deepEqual(s.log.blend.at(-1), [s.gl.ONE, s.gl.ONE_MINUS_SRC_ALPHA], 'salida premultiplicada, como el emoji')
  r.destroy()
})

test('un emoji dentro de una corrida compleja sale como glifo propio, en el orden de lectura', () => {
  const { r, s, atlas } = montar()
  r.attach(miembro({ items: [{ id: 'x', lat: -33.4, lng: -70.6, text: 'مرحبا 🚚' }, { id: 'y', lat: -33.41, lng: -70.6, text: 'مرحبا' }] }))
  r.resetCanvasReference()
  const inst = instancias(s.log, r.stats().glifos)
  assert.equal(inst.length, 3, 'la corrida con emoji en dos partes; la otra entera')
  while (atlas.flush(1e9));
  const pagina = id => atlas.meta.pixels[8 * id + 7]
  assert.equal(pagina(inst[0].glifo), 1, 'en árabe el emoji queda a la izquierda, y en la página de color')
  assert.equal(pagina(inst[1].glifo), 0, 'la corrida árabe, en la de campos')
  assert.ok(inst[0].ox < inst[1].ox)
  r.destroy()
})

test('el atlas sube entero al crecer y por filas después; sin escrituras no sube; un contexto nuevo sube todo', async () => {
  const { r, s, atlas } = montar()
  const m = miembro({ items: PUNTOS })
  r.attach(m)
  r.resetCanvasReference()
  assert.equal(s.log.tex.length, 3, 'las tres páginas en el primer dibujo')
  while (atlas.flush(1e9));
  r.resetCanvasReference()
  assert.equal(s.log.tex.length, 3)
  assert.ok(s.log.texSub.length >= 2, 'las filas nuevas de la página de campos y de la meta')
  const subidas = s.log.texSub.length
  r.resetCanvasReference()
  assert.equal(s.log.texSub.length, subidas, 'sin escrituras no sube nada')

  r.dropGl()
  const otro = glFalso()
  r.buildGl(otro.gl)
  assert.equal(otro.log.tex.length, 3, 'un contexto nuevo sube las tres páginas')
  assert.equal(otro.log.datas.length, 1, 'y las instancias')
  assert.equal(instancias(otro.log, r.stats().glifos).length, 15)
  r.destroy()
})

test('los glifos que esperan su rasterizado aparecen solos: el realm pinta en el cuadro en que los rasteriza', async () => {
  const { r, s, atlas } = montar()
  r.attach(miembro({ items: PUNTOS }))
  r.resetCanvasReference()
  assert.ok(atlas.pending > 0)
  const ends = s.ends
  await new Promise(res => setTimeout(res, 20))
  assert.equal(atlas.pending, 0)
  assert.ok(s.ends > ends, 'repintó sin que nadie lo pidiera')
  r.destroy()
})

test('sin WebGL2 la fábrica lanza en el acto, suelta el pane y no queda en el realm', () => {
  const atlas = createGlyphAtlas(trabajo())
  const host  = anfitrion()
  const sup   = superficie({ sinGl: true })
  assert.throws(() => createLabelGl({ host, pane: 'cristae-labels-gl', zIndex: 7, surface: sup.fabrica, atlas }), /sin WebGL2/)
  assert.equal(host.panes.get('cristae-labels-gl'), 0, 'el pane se soltó')
  assert.ok(sup.hechas[0].destroyed, 'la superficie también')
})

test('el motor lo inscribe con track; destruirlo suelta superficie, pane y referencias', () => {
  const inscritos = []
  const { r, s, host } = montar({ track: x => inscritos.push(x) })
  assert.deepEqual(inscritos, [r])
  r.attach(miembro({ items: PUNTOS }))
  r.resetCanvasReference()
  r.destroy()
  assert.ok(s.destroyed)
  assert.equal(host.panes.get('cristae-labels-gl'), 0)
  assert.deepEqual(r.hitsAt(miembro({ items: PUNTOS }), { x: 400, y: 300 }, []), [])
})

// Un ancla en world0 relativa queda en f32: a z18 el error de redondeo no llega a 1/16 de px.
test('el ancla relativa al centro de la colocación conserva la precisión a z18', () => {
  const { host, r, s } = montar()
  host.state.zoom = 18
  const p = { id: 'a', lat: -33.4001, lng: -70.6002, text: 'X' }
  r.attach(miembro({ items: [p] }))
  r.resetCanvasReference()
  const [g] = instancias(s.log, 1)
  const ex = projX0(p.lng) - projX0(host.center.lng), ey = projY0(p.lat) - projY0(host.center.lat)
  assert.ok(Math.abs(g.wx - ex) * 2 ** 18 < 1 / 16 && Math.abs(g.wy - ey) * 2 ** 18 < 1 / 16)
  r.destroy()
})
