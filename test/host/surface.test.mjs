// La superficie del anfitrión sobre el Leaflet REAL, en jsdom: dónde cuelga un nodo montado, la cuenta de
// quienes lo sostienen, que un pane que el mapa ya tenía se presta y queda, y que desmontar suelta lo que
// Leaflet no suelta solo. Son los tests de contrato de los dos privados que toca `unmount`: si Leaflet
// deja de registrar sus panes en `_panes`, o de cachear en `_paneRenderers` el renderer de los paths de
// un pane, el nodo o su renderer quedan colgados en silencio y es acá donde se ve.
// Corre con: node --test test/host/surface.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { contenedor, prepararDom } from '../../test-helpers/leaflet-real.mjs'

// jsdom no rasteriza canvas, así que los paths van por el renderer SVG, que cachea por pane igual que
// el de canvas.
prepararDom()
const { default: L }       = await import('leaflet')
const { adoptLeafletHost } = await import('../../src/host/LeafletHost.js')

// Un mapa con vista, adoptado.
const montar = () => {
  const map = L.map(contenedor()).setView([-33, -70], 10)
  return { map, surface: adoptLeafletHost(map).surface }
}

const LINEA = [[-33, -70], [-33.01, -70.01]]

test('mount cuelga el nodo del marco que sigue al paneo, con su z y sin puntero salvo que se pida', () => {
  const { map, surface } = montar()
  const capa = surface.mount('capa', 450, { pointer: false })
  const otra = surface.mount('otra', 460, { pointer: true })

  assert.equal(capa.parentNode, map.getPane('mapPane'), 'cuelga del pane raíz, que Leaflet traslada al panear')
  assert.equal(map.getPane('capa'), capa, 'y Leaflet lo encuentra por nombre: un path con `pane: "capa"` va ahí')
  assert.deepEqual([capa.style.zIndex, capa.style.pointerEvents], ['450', 'none'])
  assert.deepEqual([otra.style.zIndex, otra.style.pointerEvents], ['460', ''])
  assert.equal(surface.container, map.getContainer())
})

test('un pane lo sostienen todos los que lo montaron, y se va con el último', () => {
  const { map, surface } = montar()
  const nodo = surface.mount('comun', 450, { pointer: false })
  assert.equal(surface.mount('comun'), nodo, 'el segundo recibe el mismo nodo')
  assert.deepEqual([nodo.style.zIndex, nodo.style.pointerEvents], ['450', 'none'], 'y sin z ni puntero no lo reconfigura')

  surface.unmount('comun')
  assert.equal(map.getPane('comun'), nodo, 'con uno que lo sostiene, el pane sigue')
  assert.ok(nodo.isConnected)

  surface.unmount('comun')
  assert.equal(map.getPane('comun'), undefined, 'sin nadie, sale del registro de Leaflet')
  assert.equal(nodo.isConnected, false, 'y del documento')

  surface.unmount('comun')
  const nuevo = surface.mount('comun')
  assert.notEqual(nuevo, nodo, 'una baja de más no descuenta, y el montaje siguiente estrena un nodo')
  assert.ok(nuevo.isConnected)
})

test('un pane que el mapa ya tenía se presta y queda', () => {
  const { map, surface } = montar()
  const overlay = map.getPane('overlayPane')
  const propio  = map.createPane('delDueño')

  assert.equal(surface.mount('overlayPane'), overlay)
  assert.equal(surface.mount('delDueño'), propio)
  surface.unmount('overlayPane')
  surface.unmount('delDueño')

  assert.equal(map.getPane('overlayPane'), overlay, 'el de Leaflet sigue')
  assert.equal(map.getPane('delDueño'), propio, 'y el del dueño del mapa, también')
  assert.ok(overlay.isConnected && propio.isConnected)
})

// Las capas que lo toman prestado lo configuran y lo ocultan o atenúan con su estilo, como a uno propio;
// al irse la última, el dueño recupera el suyo: sus capas vuelven a verse y a recibir el puntero.
test('un pane prestado vuelve al estilo que tenía cuando lo suelta el último que lo sostiene', () => {
  const { map, surface } = montar()
  const pane   = map.createPane('delDueño')
  const estilo = () => [pane.style.zIndex, pane.style.pointerEvents, pane.style.visibility, pane.style.opacity]
  pane.style.zIndex = '350'
  const antes = estilo()

  surface.mount('delDueño', 410, { pointer: false })
  surface.mount('delDueño', 420)
  surface.setVisible('delDueño', false)
  surface.setOpacity('delDueño', 0.4)
  surface.unmount('delDueño')
  assert.deepEqual(estilo(), ['420', 'none', 'hidden', '0.4'], 'mientras quede uno, el estilo es el de las capas')

  surface.unmount('delDueño')
  assert.deepEqual(estilo(), antes, 'con el último, el del dueño')
  surface.mount('delDueño', 430)
  surface.unmount('delDueño')
  assert.deepEqual(estilo(), antes, 'y un préstamo nuevo lo guarda de nuevo')
})

// El dueño de un mapa adoptado puede quitar un pane que prestó, o remover el mapa entero antes de soltar
// al anfitrión: soltar lo que ya no está no tiene nodo que devolver ni que sacar.
test('soltar un pane que ya no está no lanza', () => {
  const { map, surface } = montar()
  map.createPane('delDueño')
  ;['delDueño', 'overlayPane', 'propio'].forEach(name => surface.mount(name, 450))

  map.getPane('delDueño').remove()
  delete map._panes.delDueño
  assert.doesNotThrow(() => surface.unmount('delDueño'), 'un prestado que el dueño quitó')
  map.remove()
  assert.doesNotThrow(() => ['overlayPane', 'propio'].forEach(name => surface.unmount(name)), 'y los de un mapa removido')
})

// El relevo de un mapa longevo: el anfitrión nuevo se adopta antes de soltar el viejo, y los dos montan
// los mismos nombres. El nodo es del mapa, y se va con el último que lo sostiene, sea del anfitrión que sea.
test('con dos anfitriones sobre un mapa, el pane que montan los dos se va con el último', () => {
  const map   = L.map(contenedor()).setView([-33, -70], 10)
  const viejo = adoptLeafletHost(map)
  const nuevo = adoptLeafletHost(map)
  const nodo  = viejo.surface.mount('capa', 450)
  assert.equal(nuevo.surface.mount('capa', 450), nodo, 'el nuevo recibe el mismo nodo')

  viejo.surface.unmount('capa')
  viejo.destroy()
  assert.equal(nodo.isConnected, true, 'soltar el viejo no se lo saca al nuevo')
  nuevo.surface.unmount('capa')
  assert.equal(nodo.isConnected, false, 'y se va con el último')
  nuevo.destroy()
  map.remove()
})

// Leaflet dibuja los paths de un pane con un renderer que crea al primero y deja en el mapa aunque el
// último se vaya. Sin soltarlo, un path nuevo en un pane con el mismo nombre se dibujaría en el lienzo
// del nodo viejo, fuera del documento.
test('desmontar suelta el renderer que Leaflet cacheó para el pane', () => {
  const { map, surface } = montar()
  const nodo     = surface.mount('patas', 450)
  const linea    = L.polyline(LINEA, { pane: 'patas' }).addTo(map)
  const renderer = map._paneRenderers.patas
  assert.ok(nodo.contains(renderer._container), 'el renderer dibuja dentro del pane')

  linea.remove()
  assert.ok(map.hasLayer(renderer), 'Leaflet no lo suelta al irse el último path')

  surface.unmount('patas')
  assert.equal(map.hasLayer(renderer), false, 'el anfitrión sí')
  assert.equal(map._paneRenderers.patas, undefined)

  const nuevo = surface.mount('patas', 450)
  L.polyline(LINEA, { pane: 'patas' }).addTo(map)
  assert.ok(nuevo.querySelector('path'), 'y el path siguiente se dibuja en el pane vivo')
})

test('setZ, setVisible y setOpacity escriben el pane por su nombre; uno que no existe no hace nada', () => {
  const { surface } = montar()
  const nodo = surface.mount('capa', 450)

  surface.setZ('capa', 470)
  surface.setVisible('capa', false)
  surface.setOpacity('capa', 0.3)
  assert.deepEqual([nodo.style.zIndex, nodo.style.visibility, nodo.style.opacity], ['470', 'hidden', '0.3'])

  surface.setVisible('capa', true)
  surface.setOpacity('capa', 1)
  assert.deepEqual([nodo.style.visibility, nodo.style.opacity], ['', ''], 'visible y opaco es el estilo sin tocar')

  assert.doesNotThrow(() => {
    surface.setZ('ninguno', 1)
    surface.setVisible('ninguno', false)
    surface.setOpacity('ninguno', 0.5)
  })
})

// La transición del zoom animado la da la hoja de Leaflet a los nodos con su clase, con el
// `transform-origin` en la esquina del que depende la escala.
test('followZoom le suma a un nodo la clase con que Leaflet lo interpola en el zoom animado', () => {
  const { surface } = montar()
  const nodo = document.createElement('canvas')
  nodo.className = 'propia'
  surface.followZoom(nodo)
  assert.deepEqual([...nodo.classList], ['propia', 'leaflet-zoom-animated'])
})
