// Política de animación del zoom: 'none' | 'in-only' | 'on', cambiable EN VIVO por setZoomAnimation.
//
// El último test es el que importa: si la política se aplicara apagando el latch `_zoomAnimated` del
// mapa, Leaflet se lo copiaría a cada capa AL AGREGARLA y ninguna volvería a suscribirse a `zoomanim`.
// Encender la animación después dejaría los tiles saltando mientras el resto acompaña.

import '../../test-helpers/engine-stub.mjs'
import { makeGlify, makeMap, makeLeaflet } from '../../test-helpers/engine-stub.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MapEngine } from '../../src/engine/MapEngine.js'

// `_tryAnimatedZoom` es lo que Leaflet consulta en CADA zoom: true = anima, false = salto instantáneo.
const conModo = zoomAnimation => {
  const map = makeMap({ zoom: 10 })
  const engine = new MapEngine({ leaflet: makeLeaflet(), glify: makeGlify(), map, zoomAnimation })
  return {
    engine, map,
    acercar: () => map._tryAnimatedZoom(map._center, map._zoom + 2),
    alejar:  () => map._tryAnimatedZoom(map._center, map._zoom - 2),
  }
}

test("'none' no anima en ninguna dirección", () => {
  const { engine, acercar, alejar } = conModo('none')
  assert.equal(acercar(), false)
  assert.equal(alejar(), false)
  engine.destroy()
})

test("'in-only' anima al acercar y no al alejar", () => {
  const { engine, acercar, alejar } = conModo('in-only')
  assert.equal(acercar(), true)
  assert.equal(alejar(), false)
  engine.destroy()
})

test("'on' anima en AMBOS sentidos — es lo que 'in-only' recorta", () => {
  const { engine, acercar, alejar } = conModo('on')
  assert.equal(acercar(), true, 'acercar')
  assert.equal(alejar(), true, 'alejar')
  engine.destroy()
})

test('setZoomAnimation cambia la política en vivo, sin remontar nada', () => {
  const { engine, acercar, alejar } = conModo('none')
  assert.equal(acercar(), false, 'arranca sin animación')
  engine.setZoomAnimation('on')
  assert.equal(acercar(), true, 'none → on')
  assert.equal(alejar(), true)
  engine.setZoomAnimation('in-only')
  assert.equal(alejar(), false, 'on → in-only recorta el alejar')
  engine.destroy()
})

test('devuelve el motor, para encadenar', () => {
  const { engine } = conModo('none')
  assert.equal(engine.setZoomAnimation('on'), engine)
  engine.destroy()
})

test('con mapa PRESTADO y sin modo, la política queda en manos del consumidor', () => {
  const map = makeMap({ zoom: 10 })
  const engine = new MapEngine({ leaflet: makeLeaflet(), glify: makeGlify(), map })
  assert.equal(map._tryAnimatedZoom(map._center, 8), true, 'no se interviene un mapa ajeno')
  engine.destroy()
})

test('con mapa PROPIO y sin modo, el default es no animar', () => {
  const engine = new MapEngine({ leaflet: makeLeaflet(), glify: makeGlify(), container: {} })
  const map = engine.getLeafletMap()
  assert.equal(map._tryAnimatedZoom(map._center, map._zoom + 2), false)
  engine.destroy()
})

test('el latch `_zoomAnimated` del mapa queda intacto en TODOS los modos', () => {
  ;['none', 'in-only', 'on'].forEach(modo => {
    const { engine, map } = conModo(modo)
    assert.equal(map._zoomAnimated, true, `${modo}: las capas siguen cableándose a zoomanim`)
    engine.setZoomAnimation('none')
    assert.equal(map._zoomAnimated, true, `${modo} → none en vivo: el latch sigue intacto`)
    engine.destroy()
  })
})
