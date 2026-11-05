// Protocolo de superficie de las capas GL (plan C, piezas de capas): la superficie puede ser la ranura de un tramo, que
// enlaza el FBO del miembro en `begin()` y compone en `end(view)`. Ninguna capa cambia su dibujo; lo que se fija acá:
//
//   C1  puntos, líneas y polígonos abren cada dibujo con `begin()` antes del primer comando GL y lo cierran con
//       `end(view)` y la vista dibujada; oculta o sin contexto, ninguno de los dos; líneas y polígonos cierran aunque
//       no hayan pintado nada
//   C2  `setVisible` de líneas y polígonos pasa por `surface.setVisible` y la capa no escribe `style.display`; con
//       `EditSurface` el canvas se oculta como antes
//   C3  la opción `surface` construye la superficie con los opts de siempre, y `ShapeLayer` la hace llegar a su capa
//       de polígonos
//
// Corre con: node --test test/render/capa-protocolo-tramo.test.mjs
import '../../test-helpers/engine-stub.mjs'
import { makeEditGl, makeIconSet, makeLeaflet, makeMap, makePickSpy } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSource } from '../../src/data/Source.js'
import { byDefault } from '../../src/geometry/geodesic.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'
import { LineGpuLayer } from '../../src/render/LineGpuLayer.js'
import { PointLayer } from '../../src/render/PointLayer.js'
import { PolygonGpuLayer } from '../../src/render/PolygonGpuLayer.js'
import { ShapeLayer } from '../../src/render/ShapeLayer.js'
import { projX0, projY0 } from '../../src/render/project.js'

/* ── Dobles: una superficie y un gl que anotan en el mismo registro, en orden ── */

const ZOOM   = 5
const CENTRO = { lat: 10, lng: 20 }

// Un gl de edición cuyas llamadas quedan en `log` como ['gl', método].
const glAnotado = log => {
  const base = makeEditGl(makePickSpy())
  return new Proxy(base, {
    get: (t, p) => {
      const v = t[p]
      return typeof v === 'function' ? (...args) => (log.push(['gl', p]), v(...args)) : v
    },
  })
}

// La forma de `EditSurface` que usan las capas, con el protocolo del tramo. `conContexto: false` no lo toma nunca: ni
// `open` ni `need` lo dan. `end` anota una copia de la vista, que la capa reusa entre dibujos.
const superficieFalsa = (log, { conContexto = true } = {}) => {
  const hechas = []
  const fabrica = opts => {
    const gl = glAnotado(log)
    const s  = {
      opts,
      gl          : null,
      canvas      : { style: {} },
      attached    : false,
      contextLost : false,
      cssZoom     : opts.cssZoom ?? true,
      z           : 0,
      needed      : true,
      state       : 'none',
      onState     : null,
      open(content) {
        log.push(['surface', 'open', content])
        return content && conContexto ? s.acquire() : null
      },
      need() {
        log.push(['surface', 'need'])
        return !s.gl && conContexto && !!s.acquire()
      },
      acquire() {
        log.push(['surface', 'acquire'])
        if (s.gl) return s.gl
        s.gl = gl
        s.attached = true
        s.state    = 'live'
        opts.owner?.buildGl(gl)
        return gl
      },
      release()              { log.push(['surface', 'release']); return false },
      reconcile()            { return false },
      resetCanvasReference() { log.push(['surface', 'resetCanvasReference']) },
      destroy()              { log.push(['surface', 'destroy']) },
      begin()                { log.push(['surface', 'begin']) },
      end(view)              { log.push(['surface', 'end', { zoom: view.zoom, x: view.center.x, y: view.center.y }]) },
      setVisible(visible)    { log.push(['surface', 'setVisible', visible]); return visible },
      setOpacity(alpha)      { log.push(['surface', 'setOpacity', alpha]) },
    }
    hechas.push(s)
    return s
  }
  return { fabrica, hechas }
}

const anfitrion = () => {
  const map = makeMap({ zoom: ZOOM })
  map._center = CENTRO
  return adoptLeafletHost(map, { leaflet: makeLeaflet() })
}

const VISTA = { zoom: ZOOM, x: projX0(CENTRO.lng), y: projY0(CENTRO.lat) }

// Fuentes y montajes mínimos de cada clase, con la superficie falsa.
const fuentePuntos = n => {
  const lista = Array.from({ length: n }, (_, i) => ({ id: `P${i}`, pos: { lat: CENTRO.lat, lng: CENTRO.lng + i * 0.01 } }))
  return {
    accessors    : { idOf: it => it.id, positionOf: it => it.pos },
    getSnapshot  : () => lista,
    subscribe    : () => () => {},
    itemById     : id => lista.find(it => it.id === id),
    moveDirtyIds : () => new Set(),
    dirtyIds     : () => new Set(),
  }
}

const fuenteLineas = items => {
  const source = createSource({ idOf: r => r.id, pathOf: r => r.path })
  source.set(items)
  return source
}
const tramoCerca = [[CENTRO.lat, CENTRO.lng], [CENTRO.lat + 0.01, CENTRO.lng + 0.01]]

// Anillo cuadrado cerrado en [lng, lat], como lo pide `ringsOf`.
const cuadrado = (lng, lat, r) => [[lng - r, lat - r], [lng + r, lat - r], [lng + r, lat + r], [lng - r, lat + r], [lng - r, lat - r]]
const fuentePoligonos = (lng, lat) => {
  const source = createSource({ idOf: r => r.id, ringsOf: r => r.rings })
  source.set([{ id: 1, rings: [cuadrado(lng, lat, 0.05)] }])
  return source
}

const montarPuntos = (log, opciones = {}) => {
  const sup = superficieFalsa(log, opciones)
  const layer = new PointLayer({ host: anfitrion(), pane: 'p', source: fuentePuntos(3), iconSet: makeIconSet(), surface: sup.fabrica })
  return { layer, sup }
}
const montarLineas = (log, items = [{ id: 1, path: tramoCerca }], opciones = {}) => {
  const sup = superficieFalsa(log, opciones)
  const layer = new LineGpuLayer({ host: anfitrion(), pane: 'l', source: fuenteLineas(items), surface: sup.fabrica })
  return { layer, sup }
}
const montarPoligonos = (log, { lng = CENTRO.lng, lat = CENTRO.lat, ...opciones } = {}) => {
  const sup = superficieFalsa(log, opciones)
  const layer = new PolygonGpuLayer({ host: anfitrion(), pane: 'g', source: fuentePoligonos(lng, lat), surface: sup.fabrica })
  return { layer, sup }
}

// Lo que anotó UN dibujo, desde cero.
const dibujo = (log, run) => {
  log.length = 0
  const r = run()
  return { r, log: log.slice() }
}
const de       = (log, quien, metodo) => log.filter(([q, m]) => q === quien && m === metodo)
const indiceDe = (log, quien, metodo) => log.findIndex(([q, m]) => q === quien && m === metodo)

// C1: un `begin`, ningún comando GL antes; un `end` con la vista dibujada, después del último comando GL.
const abreYCierra = (log, vista = VISTA) => {
  assert.equal(de(log, 'surface', 'begin').length, 1, 'un begin por dibujo')
  assert.equal(de(log, 'surface', 'end').length, 1, 'un end por dibujo')
  const begin = indiceDe(log, 'surface', 'begin')
  const end   = indiceDe(log, 'surface', 'end')
  const gl    = log.flatMap(([q], i) => (q === 'gl' ? [i] : []))
  assert.ok(gl.length > 0, 'el dibujo emitió comandos GL')
  assert.ok(gl[0] > begin, `begin antes del primer comando GL (${log[gl[0]][1]})`)
  assert.ok(gl.at(-1) < end, 'end después del último comando GL')
  assert.deepEqual(log[end][2], vista, 'end recibe la vista con que pintó')
}

/* ── C1 ── */

test('C1 puntos: begin antes del primer comando GL y end con la vista dibujada; la inyectada también', () => {
  const log = []
  const { layer } = montarPuntos(log)
  layer.resetCanvasReference()                       // asienta la escala: el siguiente es sólo dibujo
  const { r, log: uno } = dibujo(log, () => layer.resetCanvasReference())
  assert.equal(r, undefined)
  abreYCierra(uno)
  assert.ok(de(uno, 'gl', 'drawArrays').length > 0, 'dibujó los puntos')

  const { log: inyectado } = dibujo(log, () => layer.renderAtView(ZOOM + 1, { lat: 0, lng: 0 }))
  abreYCierra(inyectado, { zoom: ZOOM + 1, x: projX0(0), y: projY0(0) })
  layer.destroy()
})

test('C1 puntos: oculta o sin contexto, ni begin ni end', () => {
  const log = []
  const { layer } = montarPuntos(log)
  layer.setVisible(false)
  const { log: oculta } = dibujo(log, () => (layer.resetCanvasReference(), layer.renderAtView(ZOOM, CENTRO)))
  assert.equal(de(oculta, 'surface', 'begin').length + de(oculta, 'surface', 'end').length, 0)
  layer.destroy()

  const sin = montarPuntos(log, { conContexto: false })
  const { log: vacio } = dibujo(log, () => (sin.layer.resetCanvasReference(), sin.layer.renderAtView(ZOOM, CENTRO)))
  assert.equal(de(vacio, 'surface', 'begin').length + de(vacio, 'surface', 'end').length, 0)
  sin.layer.destroy()
})

test('C1 líneas: begin tras reasentar la superficie y antes del clear; end con la vista, aunque no pinte', () => {
  const log = []
  const { layer } = montarLineas(log)
  const { r, log: uno } = dibujo(log, () => layer.redraw())
  assert.equal(r, true, 'pintó el tramo')
  abreYCierra(uno)
  assert.ok(indiceDe(uno, 'surface', 'resetCanvasReference') < indiceDe(uno, 'surface', 'begin'), 'reasienta antes de begin')
  layer.destroy()

  const nada = montarLineas(log, [{ id: 1, path: [] }])
  const { r: pinto, log: limpio } = dibujo(log, () => nada.layer.redraw())
  assert.equal(pinto, false, 'no hay tramo que pintar')
  abreYCierra(limpio)
  nada.layer.destroy()
})

test('C1 líneas: oculta o sin contexto, ni begin ni end', () => {
  const log = []
  const { layer } = montarLineas(log)
  layer.setVisible(false)
  const { log: oculta } = dibujo(log, () => layer.redraw())
  assert.equal(de(oculta, 'surface', 'begin').length + de(oculta, 'surface', 'end').length, 0)
  layer.destroy()

  const sin = montarLineas(log, undefined, { conContexto: false })
  const { log: vacio } = dibujo(log, () => sin.layer.redraw())
  assert.equal(de(vacio, 'surface', 'begin').length + de(vacio, 'surface', 'end').length, 0)
  sin.layer.destroy()
})

test('C1 polígonos: begin tras reasentar y antes del clear; end con la vista, aunque nada caiga en pantalla', () => {
  const log = []
  const { layer } = montarPoligonos(log)
  const { r, log: uno } = dibujo(log, () => layer.redraw())
  assert.equal(r, true, 'pintó el polígono')
  abreYCierra(uno)
  assert.ok(indiceDe(uno, 'surface', 'resetCanvasReference') < indiceDe(uno, 'surface', 'begin'), 'reasienta antes de begin')
  layer.destroy()

  const lejos = montarPoligonos(log, { lng: CENTRO.lng - 150 })
  const { r: pinto, log: limpio } = dibujo(log, () => lejos.layer.redraw())
  assert.equal(pinto, false, 'el polígono queda fuera de la vista')
  abreYCierra(limpio)
  lejos.layer.destroy()
})

test('C1 polígonos: oculta o sin contexto, ni begin ni end', () => {
  const log = []
  const { layer } = montarPoligonos(log)
  layer.setVisible(false)
  const { log: oculta } = dibujo(log, () => layer.redraw())
  assert.equal(de(oculta, 'surface', 'begin').length + de(oculta, 'surface', 'end').length, 0)
  layer.destroy()

  const sin = montarPoligonos(log, { conContexto: false })
  const { log: vacio } = dibujo(log, () => sin.layer.redraw())
  assert.equal(de(vacio, 'surface', 'begin').length + de(vacio, 'surface', 'end').length, 0)
  sin.layer.destroy()
})

/* ── C2 ── */

test('C2 líneas y polígonos: setVisible pasa por la superficie y la capa no escribe style.display', () => {
  for (const montar of [montarLineas, montarPoligonos]) {
    const log = []
    const { layer, sup } = montar(log)
    log.length = 0
    assert.equal(layer.setVisible(false), false)
    layer.setVisible(true)
    assert.deepEqual(de(log, 'surface', 'setVisible').map(([, , v]) => v), [false, true])
    assert.equal('display' in sup.hechas[0].canvas.style, false, 'la capa no toca el display del canvas')
    layer.destroy()
  }
})

// Mostrarla sólo repinta si algo pidió un dibujo mientras estaba oculta (I5): si no, la imagen sigue valiendo.
test('C2 con EditSurface: el canvas se oculta y se vuelve a ver como antes', () => {
  const lineas = new LineGpuLayer({ host: anfitrion(), pane: 'l', source: fuenteLineas([{ id: 1, path: tramoCerca }]) })
  const poligonos = new PolygonGpuLayer({ host: anfitrion(), pane: 'g', source: fuentePoligonos(CENTRO.lng, CENTRO.lat) })
  for (const layer of [lineas, poligonos]) {
    const canvas = layer.surface.canvas
    assert.ok(canvas, 'la superficie real tiene su canvas')
    layer.setVisible(false)
    assert.equal(canvas.style.display, 'none')
    assert.equal(layer.setVisible(true), false, 'sin nada pendiente, mostrarla no repinta')
    assert.equal(canvas.style.display, '')
    layer.setVisible(false)
    assert.equal(layer.redraw(), false, 'oculta no dibuja: queda atrasada')
    assert.equal(layer.setVisible(true), true, 'y mostrarla repinta')
    layer.destroy()
  }
})

/* ── C3 ── */

test('C3 la opción surface construye la superficie con los opts de siempre', () => {
  const log = []
  const puntos = montarPuntos(log)
  const lineas = montarLineas(log)
  const poligonos = montarPoligonos(log)
  const casos = [
    [puntos, 'p', { depth: true, cssZoom: false }],
    [lineas, 'l', {}],
    [poligonos, 'g', {}],
  ]
  for (const [{ layer, sup }, pane, extra] of casos) {
    assert.equal(sup.hechas.length, 1, 'una superficie por capa')
    const { host, ...resto } = sup.hechas[0].opts
    assert.equal(typeof host.camera.zoom, 'function', 'recibe el anfitrión')
    assert.deepEqual(resto, { pane, ...extra, owner: layer })
    assert.equal(layer.surface, sup.hechas[0], 'la capa expone la superficie construida')
    layer.destroy()
  }
})

test('C3 ShapeLayer hace llegar la opción surface a su capa de polígonos', () => {
  const log = []
  const sup = superficieFalsa(log)
  const source = createSource({ idOf: d => d.id, positionOf: d => ({ lat: d.center[0], lng: d.center[1] }), radiusOf: d => d.radius })
  source.set([{ id: 1, center: [CENTRO.lat, CENTRO.lng], radius: 1000 }])
  const layer = new ShapeLayer({ host: anfitrion(), pane: 's', source, model: byDefault, surface: sup.fabrica })
  assert.equal(sup.hechas.length, 1, 'una superficie, la de su capa de polígonos')
  assert.equal(layer.surface, sup.hechas[0])
  assert.equal(sup.hechas[0].opts.pane, 's')
  assert.ok(sup.hechas[0].opts.owner instanceof PolygonGpuLayer, 'la dueña es la capa de polígonos')
  layer.destroy()
})
