// Contrato de HtmlLayer sobre el anfitrión: la capa no es de Leaflet, cuelga un nodo propio del pane de la
// superficie y un nodo por marcador, que posiciona por proyección en el marco que sigue al paneo. Un
// paneo no reescribe nada, un zoom animado lleva los nodos al destino y uno sin destino los lleva cuadro
// a cuadro, el foco es opacidad del nodo, el hit es por proximidad y destroy suelta el pane y la vista.
//
// El harness (engine-stub) shimea window/document — se importa PRIMERO.
import { decorarElementos, makeMap, oyentesDeVista } from '../../test-helpers/engine-stub.mjs'
import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { HtmlLayer } from '../../src/render/HtmlLayer.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

// Los divs que nacen de la fábrica, con lo que se les cuelga y se les quita, cada transform escrito y la
// clave de cada escritura de estilo.
let nodos = []

after(decorarElementos((el, tag) => {
  if (tag !== 'div') return el
  const baja = el.remove
  el.hijos      = []
  el.quitado    = false
  el.escrituras = []
  el.claves     = []
  el.style = new Proxy({}, { set: (estilo, clave, valor) => {
    clave === 'transform' && el.escrituras.push(valor)
    el.claves.push(clave)
    estilo[clave] = valor
    return true
  } })
  el.appendChild = hijo => el.hijos.push(hijo)
  el.remove      = () => { el.quitado = true; baja() }
  nodos.push(el)
  return el
}))

beforeEach(() => { nodos = [] })

// El marco del paneo NO está en el origen del contenedor: así el aserto de la posición no es vacuo.
const MARCO = { x: -120, y: 35 }

const accessors = {
  idOf       : m => m.id,
  positionOf : m => ({ lat: m.lat, lng: m.lng }),
  htmlOf     : m => `<b>${m.id}</b>`,
}

// Una Source a mano: el contrato de lectura, y `emitir` para que cambie.
const fuente = (items, acc = accessors) => {
  const oyentes = new Set()
  return {
    accessors   : acc,
    getSnapshot : () => items,
    subscribe   : cb => (oyentes.add(cb), () => oyentes.delete(cb)),
    emitir      : nuevos => { items = nuevos; oyentes.forEach(cb => cb()) },
    oyentes,
  }
}

const montar = (items, { acc, interactive = false } = {}) => {
  const map      = { ...makeMap(), containerPointToLayerPoint: () => MARCO }
  const host     = adoptLeafletHost(map)
  const oyentes  = oyentesDeVista(host)
  const pane     = host.surface.mount('marcas')
  const colgados = []
  pane.appendChild = nodo => colgados.push(nodo)
  const source   = fuente(items, acc)
  const layer    = new HtmlLayer({ host, pane: 'marcas', source, interactive })
  const [raiz]   = colgados
  return { map, host, oyentes, layer, source, raiz, colgados, marcadores: () => raiz.hijos }
}

const UNO = { id: 1, lat: 2, lng: 3 }   // el stub lo proyecta al píxel (300, 200) del contenedor

test('cuelga un nodo propio del pane y un nodo por marcador, con su clase y su html', () => {
  const { colgados, raiz, marcadores } = montar([UNO])
  assert.equal(colgados.length, 1, 'un solo nodo en el pane')
  assert.equal(raiz.className, 'cristae-html-layer')

  const [marcador] = marcadores()
  assert.match(marcador.className, /leaflet-zoom-animated/, 'acompaña la transición del zoom animado')
  const [icono] = marcador.hijos
  assert.equal(icono.className, 'cristae-html-marker', 'la clase por defecto')
  assert.equal(icono.innerHTML, '<b>1</b>')
})

test('classNameOf pone la clase del icono', () => {
  const { marcadores } = montar([UNO], { acc: { ...accessors, classNameOf: m => `badge-${m.id}` } })
  assert.equal(marcadores()[0].hijos[0].className, 'badge-1')
})

test('posiciona por proyección: el píxel del contenedor más el origen del marco', () => {
  const { marcadores } = montar([UNO])
  const [marcador]     = marcadores()
  assert.equal(marcador.style.transform, 'translate3d(180px, 235px, 0) translate(-50%, -50%)')
  assert.equal(marcador.style.zIndex, '235', 'el de más abajo en pantalla tapa al de más arriba')
})

test('sin sizeOf ni anchorOf el punto cae en el medio del contenido', () => {
  const { marcadores } = montar([UNO])
  const [marcador]     = marcadores()
  assert.equal(marcador.style.width, 'max-content', 'el ancho lo da el contenido, no el pane sin ancho')
  assert.match(marcador.style.transform, /translate\(-50%, -50%\)$/)
  assert.equal(marcador.hijos[0].style.width, '')
})

test('sizeOf da la caja del icono y centra el ancla; anchorOf la pisa', () => {
  const conTamano = montar([UNO], { acc: { ...accessors, sizeOf: () => [30, 20] } })
  const [a]       = conTamano.marcadores()
  assert.equal(a.hijos[0].style.width, '30px')
  assert.equal(a.hijos[0].style.height, '20px')
  assert.equal(a.style.marginLeft, '-15px')
  assert.equal(a.style.marginTop, '-10px')
  assert.doesNotMatch(a.style.transform, /translate\(-50%/, 'la caja se conoce: el ancla va por margen')

  const conAncla = montar([UNO], { acc: { ...accessors, sizeOf: () => [30, 20], anchorOf: () => [5, 20] } })
  const [b]      = conAncla.marcadores()
  assert.equal(b.style.marginLeft, '-5px')
  assert.equal(b.style.marginTop, '-20px')
})

test('anchorOf sin sizeOf mueve el ancla y deja el tamaño al CSS', () => {
  const { marcadores } = montar([UNO], { acc: { ...accessors, anchorOf: () => [4, 6] } })
  const [marcador]     = marcadores()
  assert.equal(marcador.style.marginLeft, '-4px')
  assert.equal(marcador.hijos[0].style.width, '')
  assert.doesNotMatch(marcador.style.transform, /translate\(-50%/)
})

test('un marcador sin posición finita no se dibuja', () => {
  const { marcadores } = montar([UNO, { id: 2, lat: NaN, lng: 0 }, { id: 3, lat: 0, lng: undefined }])
  assert.equal(marcadores().length, 1)
})

test('un paneo no reescribe ningún transform: el marco se lleva a los marcadores', () => {
  const { map, marcadores } = montar([UNO])
  const [marcador]          = marcadores()
  const antes               = marcador.escrituras.length

  // Paneo de 50 px a la izquierda: el contenedor ve al marcador 50 px más acá y el marco se corre igual.
  map.latLngToContainerPoint = ll => ({ x: ll.lng * 100 - 50, y: ll.lat * 100 })
  map.containerPointToLayerPoint = () => ({ x: MARCO.x + 50, y: MARCO.y })
  map.fire('moveend')
  assert.equal(marcador.escrituras.length, antes, 'la posición en el marco no cambió')
})

test('un cambio de vista que sí mueve el marco reescribe sólo lo que cambió', () => {
  const { map, marcadores } = montar([UNO, { id: 2, lat: 1, lng: 1 }])
  const [uno, dos]          = marcadores()
  const antes               = dos.escrituras.length

  map.latLngToContainerPoint = ll => ({ x: ll.lng * 100 + (ll.lat === 2 ? 40 : 0), y: ll.lat * 100 })
  map.fire('zoomend')
  assert.equal(uno.style.transform, 'translate3d(220px, 235px, 0) translate(-50%, -50%)')
  assert.equal(dos.escrituras.length, antes, 'el que quedó donde estaba no se toca')
})

test('un zoom animado lleva los nodos a la vista destino, y un move a mitad de camino no los distrae', () => {
  const { map, raiz, marcadores } = montar([UNO])
  const [marcador]                = marcadores()

  map.fire('zoomstart')
  // El stub proyecta px = coord·100·2^zoom: a zoom 4 el marcador cae en (4800, 3200) y el centro destino
  // (0, 0) en el medio del contenedor de 800×600.
  map.fire('zoomanim', { zoom: 4, center: { lat: 0, lng: 0 } })
  assert.equal(marcador.style.transform, 'translate3d(5080px, 3535px, 0) translate(-50%, -50%)')
  map.fire('move')
  assert.equal(marcador.style.transform, 'translate3d(5080px, 3535px, 0) translate(-50%, -50%)', 'la transición manda')

  map.fire('zoomend')
  assert.equal(marcador.style.transform, 'translate3d(180px, 235px, 0) translate(-50%, -50%)', 'asienta en la vista viva')
  assert.equal(raiz.style.visibility, undefined, 'la capa nunca se esconde')
})

// Un pinch o un `flyTo` mueven la vista cuadro a cuadro sin `zoomanim`: el marcador la sigue en cada
// `move`, como sigue al destino en un zoom animado.
test('un zoom sin vista destino lleva los nodos en cada move hasta asentar', () => {
  const { map, marcadores } = montar([UNO])
  const [marcador]          = marcadores()

  map.fire('zoomstart')
  map.latLngToContainerPoint = ll => ({ x: ll.lng * 100 + 7, y: ll.lat * 100 })
  map.fire('move')
  assert.equal(marcador.style.transform, 'translate3d(187px, 235px, 0) translate(-50%, -50%)')
  map.latLngToContainerPoint = ll => ({ x: ll.lng * 100 + 9, y: ll.lat * 100 })
  map.fire('move')
  assert.equal(marcador.style.transform, 'translate3d(189px, 235px, 0) translate(-50%, -50%)')
  map.fire('zoomend')
  assert.equal(marcador.style.transform, 'translate3d(189px, 235px, 0) translate(-50%, -50%)')
})

test('fuera de un zoom, un move no proyecta: el paneo se lo lleva el marco', () => {
  const { map, marcadores } = montar([UNO])
  const [marcador]          = marcadores()
  const antes               = marcador.escrituras.length

  map.latLngToContainerPoint = ll => ({ x: ll.lng * 100 + 7, y: ll.lat * 100 })
  map.fire('move')
  assert.equal(marcador.escrituras.length, antes)
})

test('un tick de datos durante un zoom animado respeta la vista destino', () => {
  const { map, source, marcadores } = montar([UNO])
  map.fire('zoomanim', { zoom: 4, center: { lat: 0, lng: 0 } })
  source.emitir([UNO])
  assert.equal(marcadores()[0].style.transform, 'translate3d(5080px, 3535px, 0) translate(-50%, -50%)')
})

test('sin vista no hay dónde posicionar, y al llegar la vista se posiciona', () => {
  const map  = { ...makeMap(), containerPointToLayerPoint: () => MARCO }
  map._loaded = false
  const host = adoptLeafletHost(map)
  const pane = host.surface.mount('marcas')
  const colgados = []
  pane.appendChild = nodo => colgados.push(nodo)
  new HtmlLayer({ host, pane: 'marcas', source: fuente([UNO]) })
  const [marcador] = colgados[0].hijos
  assert.equal(marcador.escrituras.length, 0)

  map._loaded = true
  map.fire('moveend')
  assert.equal(marcador.style.transform, 'translate3d(180px, 235px, 0) translate(-50%, -50%)')
})

test('un tick de datos reusa el nodo del marcador y reescribe sólo lo que cambió', () => {
  const { source, marcadores } = montar([UNO, { id: 2, lat: 1, lng: 1 }])
  const [uno, dos]             = marcadores()
  uno.hijos[0].innerHTML = 'tocado'                      // si la capa lo reescribe, lo pisa

  source.emitir([{ ...UNO, lat: 4 }, { id: 2, lat: 1, lng: 1 }])
  assert.deepEqual(marcadores(), [uno, dos], 'los mismos nodos, sin crear ni quitar')
  assert.equal(uno.hijos[0].innerHTML, 'tocado', 'el html no cambió: no se rehace')
  assert.equal(uno.style.transform, 'translate3d(180px, 435px, 0) translate(-50%, -50%)', 'se movió')
})

test('un tick de datos que no cambia nada no escribe ningún estilo', () => {
  const items                  = [{ ...UNO, tam: [20, 10] }]
  const acc                    = { ...accessors, sizeOf: m => m.tam, classNameOf: () => 'badge' }
  const { source, marcadores } = montar(items, { acc })
  const [marcador]             = marcadores()
  const [icono]                = marcador.hijos
  const antes                  = [marcador.claves.length, icono.claves.length]

  source.emitir(items)
  assert.deepEqual([marcador.claves.length, icono.claves.length], antes)
})

test('un html que cambia se reescribe, y el que ya no está sale del documento', () => {
  let n = 1
  const acc = { ...accessors, htmlOf: m => `<b>${m.id}:${n}</b>` }
  const { source, marcadores } = montar([UNO, { id: 2, lat: 1, lng: 1 }], { acc })
  const [uno, dos]             = marcadores()

  n = 2
  source.emitir([UNO])
  assert.equal(uno.hijos[0].innerHTML, '<b>1:2</b>')
  assert.equal(dos.quitado, true)
  assert.equal(uno.quitado, false)
})

test('el foco es la opacidad del nodo, y sobrevive a un tick de datos', () => {
  const { layer, source, marcadores } = montar([UNO, { id: 2, lat: 1, lng: 1 }])
  const [uno, dos]                    = marcadores()
  assert.equal(uno.style.opacity, '1')

  assert.equal(layer.applyFocus(new Set([1]), 0.25), true)
  assert.equal(uno.style.opacity, '1')
  assert.equal(dos.style.opacity, '0.25')

  source.emitir([UNO, { id: 2, lat: 1, lng: 1 }])
  assert.equal(dos.style.opacity, '0.25', 'la reconciliación aplica el mismo factor')

  layer.applyFocus(null)
  assert.equal(dos.style.opacity, '1', 'sin foco, todo pleno')
})

test('el hit es por proximidad al punto, y ordenarlos por distancia es cosa del registro', () => {
  const { layer } = montar([UNO, { id: 2, lat: 2, lng: 3.1 }], { interactive: true })
  const hits      = layer.resolveClick({ x: 302, y: 200 })
  assert.deepEqual(hits.map(h => h.id).sort(), [1, 2], 'los dos caen dentro de la tolerancia por defecto')
  assert.deepEqual(hits.find(h => h.id === 1), { ref: 1, id: 1, distancePx: 2 })
  assert.deepEqual(layer.resolveHover({ x: 302, y: 200 }), hits)
  assert.deepEqual(layer.resolveClick({ x: 500, y: 500 }), [])
})

test('un sizeOf grande agranda la tolerancia, y una capa que no es interactiva no pica', () => {
  const grande = montar([UNO], { interactive: true, acc: { ...accessors, sizeOf: () => [100, 60] } })
  assert.equal(grande.layer.resolveClick({ x: 345, y: 200 }).length, 1, 'cae dentro de la mitad del lado mayor')
  assert.equal(grande.layer.resolveClick({ x: 355, y: 200 }).length, 0)

  assert.deepEqual(montar([UNO]).layer.resolveClick({ x: 300, y: 200 }), [])
})

test('sin vista no pica', () => {
  const { map, layer } = montar([UNO], { interactive: true })
  map._loaded = false
  assert.deepEqual(layer.resolveClick({ x: 300, y: 200 }), [])
})

test('destroy saca el nodo, suelta el pane, la vista y la Source; un segundo destroy no hace nada', () => {
  const { map, host, oyentes, layer, source, raiz } = montar([UNO])
  assert.equal(oyentes('zoomstart', 'zoomanim', 'move', 'moveend', 'zoomend', 'resize'), 6)
  assert.equal(source.oyentes.size, 1)

  layer.destroy()
  assert.equal(raiz.quitado, true)
  assert.equal(oyentes('zoomstart', 'zoomanim', 'move', 'moveend', 'zoomend', 'resize'), 0)
  assert.equal(source.oyentes.size, 0)
  assert.notEqual(map.getPane('marcas'), null, 'el pane sigue: lo sostiene quien lo montó para la capa')
  host.surface.unmount('marcas')
  assert.equal(map.getPane('marcas'), null, 'la capa no deja una cuenta de más')
  assert.doesNotThrow(() => layer.destroy())
  assert.deepEqual(layer.resolveClick({ x: 0, y: 0 }), [])
})
