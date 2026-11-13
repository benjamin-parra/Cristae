// El renderer `gl` de los rótulos sobre el trazo (`along`), sin GPU. Lo que se fija:
//   · la colocación es la de `labelLayout` (la del canvas) con la vista del asiento agrandada una pantalla por lado: cada
//     glifo cae donde lo pone el canvas, con su giro, también con `orientation: 'path'`, `repeat` y `offset`;
//   · lo que el canvas coloca con la vista está entre lo que coloca `gl`, y lo que queda lejos no se coloca;
//   · el picking es el de `labelLayout`, glifo a glifo;
//   · entre asientos no recoloca: el glifo escala con el mapa (`u_zs`); el asiento recoloca si cambió el zoom, el tamaño
//     o la vista salió del margen, y sólo entonces;
//   · lo que estuvo oculto recoloca al volver a verse; las referencias del atlas se sueltan al recolocar.
// Corre con: node --test test/render/label-gl-along.test.mjs
import { instalarMedida, instancias, medida, miembro, montar, trabajo } from '../../test-helpers/rotulos-gl.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createGlyphAtlas } from '../../src/render/labelGlyphs.js'
import { createLayout, readLabelView } from '../../src/render/labelLayout.js'
import { createMeasure } from '../../src/render/labelText.js'

after(instalarMedida())

// Rutas que cruzan la vista de 800 × 600 a z12 en distintos sentidos, una que vuelve sobre sí (lo que `orientation`
// decide), una en dos partes, y una a varias pantallas, fuera del margen.
const rutas = () => {
  const r = []
  for (let i = 0; i < 12; i++) {
    const lat = -33.43 + i * 0.005, d = i % 2 ? 1 : -1
    const a = [[lat, -70.66], [lat + 0.004 * d, -70.62], [lat - 0.003 * d, -70.58], [lat + 0.002, -70.54]]
    r.push({ id: `r${i}`, path: i % 3 === 0 ? a.slice().reverse() : i % 4 === 1 ? [a, a.map(([y, x]) => [y + 0.002, x])] : a, text: `Ruta ${i} · AV` })
  }
  r.push({ id: 'giro', path: [[-33.39, -70.65], [-33.39, -70.56], [-33.395, -70.56], [-33.395, -70.65]], text: 'Vuelta' })
  r.push({ id: 'lejos', path: [[-33.4, -69.6], [-33.4, -69.5]], text: 'Lejos' })
  return r
}
const linea = (opts = {}) => miembro({ id: 'l', kind: 'line', placement: 'along', items: rutas(), pathOf: x => x.path, opts: { repeat: 90, ...opts } })

// La vista de la cámara agrandada `k` pantallas por lado, como la arma el renderer.
const agrandada = (host, k) => {
  const v = readLabelView(host.camera, {})
  v.w *= 1 + 2 * k
  v.h *= 1 + 2 * k
  v.hw = v.w / 2
  v.hh = v.h / 2
  return v
}
const colocar = (m, vista) => {
  const layout = createLayout()
  layout.place(m, vista, createMeasure(medida()))
  return layout
}
const vuelta = a => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
const giro = (a, b) => Math.min(vuelta(a - b), vuelta(b - a))

test('cada glifo cae donde lo pone labelLayout con la vista agrandada, con su giro; también path, repeat y offset', () => {
  for (const opts of [{}, { orientation: 'path' }, { offset: 3, repeat: 60 }, { repeat: null }]) {
    const { host, r, s, atlas } = montar()
    const m = linea(opts)
    r.attach(m)
    r.resetCanvasReference()
    const vista = agrandada(host, 1)
    const esperado = colocar(m, vista)
    const inst = instancias(s.log, r.stats().glifos)
    assert.equal(inst.length, esperado.glyphCount, JSON.stringify(opts))
    assert.ok(inst.length > 40, 'hay de qué hablar')
    const key = atlas.fontOf(m.opts.font).key
    let peor = 0, peorGiro = 0
    for (let i = 0; i < esperado.placementCount; i++) {
      const text = esperado.texts[esperado.spans[3 * i + 2]]
      for (let g = esperado.spans[3 * i]; g < esperado.spans[3 * i] + esperado.spans[3 * i + 1]; g++) {
        const x = inst[g].wx * vista.scale + vista.hw, y = inst[g].wy * vista.scale + vista.hh
        peor = Math.max(peor, Math.hypot(x - esperado.glyphs[4 * g], y - esperado.glyphs[4 * g + 1]))
        peorGiro = Math.max(peorGiro, giro(inst[g].angulo, esperado.glyphs[4 * g + 2]))
        assert.equal(inst[g].glifo, atlas.glyph(key, text.units[esperado.glyphs[4 * g + 3]]), 'el grafema de esa posición')
        assert.deepEqual([inst[g].ox, inst[g].oy], [0, 0])
      }
    }
    assert.ok(peor < 1e-3, `${peor} px del canvas`)
    assert.ok(peorGiro < 1e-4, `${peorGiro} rad de giro`)
    r.destroy()
  }
})

test('con orientation path, 0 colocaciones del lado contrario al canvas; con auto, ninguna se lee al revés', () => {
  for (const orientation of ['path', 'auto']) {
    const { host, r, s } = montar()
    const m = linea({ orientation })
    r.attach(m)
    r.resetCanvasReference()
    const canvas = colocar(m, readLabelView(host.camera, {}))
    const vista  = agrandada(host, 1)
    const inst   = instancias(s.log, r.stats().glifos).map(g => [g.wx * vista.scale + vista.hw - vista.w / 3, g.wy * vista.scale + vista.hh - vista.h / 3, g.angulo])
    let contrarios = 0, halladas = 0
    for (let g = 0; g < canvas.glyphCount; g++) {
      const [x, y, a] = [canvas.glyphs[4 * g], canvas.glyphs[4 * g + 1], canvas.glyphs[4 * g + 2]]
      const par = inst.find(([ix, iy]) => Math.hypot(ix - x, iy - y) < 1e-3)
      if (!par) continue
      halladas++
      giro(par[2], a) > Math.PI / 2 && contrarios++
    }
    assert.equal(halladas, canvas.glyphCount, 'lo que coloca el canvas está entre lo de gl')
    assert.equal(contrarios, 0)
    if (orientation === 'auto') {
      // La cuerda de cada colocación apunta a la derecha (o recto hacia arriba): ninguna se lee al revés.
      for (let i = 0; i < canvas.placementCount; i++) {
        const a = canvas.spans[3 * i], b = a + canvas.spans[3 * i + 1] - 1
        const dx = canvas.glyphs[4 * b] - canvas.glyphs[4 * a]
        assert.ok(dx >= -1e-9)
      }
    }
    r.destroy()
  }
})

test('colocación recortada: lo que queda a más de una pantalla no se coloca', () => {
  const { host, r, s } = montar()
  const m = linea()
  r.attach(m)
  r.resetCanvasReference()
  const todo = colocar(m, { ...readLabelView(host.camera, {}), w: 1e7, h: 1e7, hw: 5e6, hh: 5e6 })
  const lejos = todo.ids.indexOf('lejos')
  assert.ok(lejos >= 0)
  assert.ok([...Array(todo.placementCount).keys()].some(i => todo.spans[3 * i + 2] === lejos), 'sin recorte se colocaría')
  assert.ok(r.stats().glifos < todo.glyphCount)
  assert.equal(r.hitsAt(m, { x: 400, y: 300 }, []).some(p => p.id === 'lejos'), false)
  assert.equal(instancias(s.log, r.stats().glifos).length, r.stats().glifos)
  r.destroy()
})

test('el picking sobre el trazo es el de labelLayout, glifo a glifo', () => {
  const { host, r } = montar()
  const m = linea({ repeat: 40 })
  r.attach(m)
  r.resetCanvasReference()
  const canvas = colocar(m, readLabelView(host.camera, {}))
  let semilla = 11, distintos = 0, conHit = 0
  const azar = () => (semilla = (semilla * 16807) % 2147483647) / 2147483647
  for (let k = 0; k < 4000; k++) {
    const muestra = { x: azar() * 800, y: azar() * 600 }
    const a = canvas.hitsAt(muestra, { x: 0, y: 0 }, []).map(p => p.id).sort()
    const b = r.hitsAt(m, muestra, []).map(p => p.id).sort()
    ;(a.length || b.length) && conHit++
    a.join() === b.join() || distintos++
  }
  assert.ok(conHit > 200, `${conHit} muestras con rótulo`)
  assert.equal(distintos, 0)
  r.destroy()
})

test('entre asientos no recoloca y el glifo escala con el mapa; el asiento recoloca sólo si hace falta', () => {
  const { host, r, s } = montar()
  const m = linea()
  const p = miembro({ id: 'p', items: [{ id: 'a', lat: -33.4, lng: -70.6, text: 'Base' }] })
  r.attach(m)
  r.attach(p)
  r.resetCanvasReference()
  const subidas = () => s.log.datas.length + s.log.subs.length
  const zs = () => s.log.escalares.filter(([n]) => n === 'u_zs').map(([, v]) => v)
  const along = () => s.log.escalares.filter(([n]) => n === 'u_along').map(([, v]) => v)
  const base = subidas()
  assert.deepEqual(along().slice(-2), [1, 0], 'la línea sobre el trazo, el punto no')

  // El zoom animado y un paso de pellizco sin asentar: escala, no recoloca.
  r.renderAtView(13, host.center)
  assert.deepEqual(zs().slice(-2), [2, 1])
  host.state.zoom = 12.5
  r.resetCanvasReference()
  assert.ok(Math.abs(zs().at(-2) - 2 ** 0.5) < 1e-12)
  assert.equal(subidas(), base, 'sin subir instancias')

  // Asienta en otro zoom: recoloca la línea y no el punto, con u_zs = 1.
  host.camera.emit('zoomend')
  assert.equal(subidas(), base + 1)
  assert.deepEqual(zs().slice(-2), [1, 1])
  host.camera.emit('moveend')
  assert.equal(subidas(), base + 1, 'el moveend del mismo paso no vuelve a colocar')

  // Un paneo dentro del margen no recoloca al asentar; uno que lo pasa, sí.
  const pantalla = 800 / (256 * 2 ** 12.5) * 360
  host.center.lng += 0.9 * pantalla
  r.resetCanvasReference()
  host.camera.emit('moveend')
  assert.equal(subidas(), base + 1)
  host.center.lng += 0.2 * pantalla
  r.resetCanvasReference()
  host.camera.emit('moveend')
  assert.equal(subidas(), base + 2)

  // Otro tamaño de la vista también recoloca.
  host.camera.size().x = 900
  host.camera.emit('moveend')
  assert.equal(subidas(), base + 3)
  host.camera.size().x = 800
  r.destroy()
})

test('lo que estuvo oculto recoloca al volver a verse, y las referencias se sueltan al recolocar', () => {
  const atlas = createGlyphAtlas(trabajo())
  const cuenta = new Map()
  const { ref, unref } = atlas
  atlas.ref = id => (cuenta.set(id, (cuenta.get(id) ?? 0) + 1), ref(id))
  atlas.unref = id => (cuenta.set(id, cuenta.get(id) - 1), unref(id))
  const vivas = () => [...cuenta.values()].reduce((a, n) => a + n, 0)
  const { host, r, s } = montar({ atlas })
  const m = linea()
  r.attach(m)
  r.resetCanvasReference()
  const antes = vivas()
  assert.equal(antes, r.stats().glifos)
  m.visible = false
  r.invalidate(m, 'visibility')
  host.state.zoom = 13
  r.resetCanvasReference()
  host.camera.emit('zoomend')
  assert.equal(vivas(), antes, 'oculto no se recoloca en el asiento')
  m.visible = true
  r.invalidate(m, 'visibility')
  r.resetCanvasReference()
  assert.deepEqual(s.log.escalares.filter(([n]) => n === 'u_zs').at(-1), ['u_zs', 1], 'colocado con la vista de ahora')
  assert.equal(vivas(), r.stats().glifos, 'la colocación vieja se soltó')
  r.detach(m)
  assert.equal(vivas(), 0)
  r.destroy()
})
