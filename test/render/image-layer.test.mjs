// Contrato de ImageLayer sobre el anfitrión: un envoltorio propio colgado del pane, llevado a las cuatro
// esquinas proyectadas por un `matrix3d`; la imagen aparece al cargar, una carga descartada no llega, el
// hit es punto en cuadrilátero y destroy suelta el pane, la vista y los oyentes del <img>.
//
// El harness (engine-stub) shimea window/document: se importa PRIMERO. Proyecta lineal, px = grados·100,
// con la latitud hacia abajo: no es Mercator, y por eso el transform se compara contra lo que el stub
// proyecta y no contra una cuenta propia.
import { decorarElementos, makeMap, oyentesDeVista } from '../../test-helpers/engine-stub.mjs'
import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ImageLayer } from '../../src/render/ImageLayer.js'
import { adoptLeafletHost } from '../../src/host/LeafletHost.js'

// Los <img> que nacen, con sus oyentes vivos y la posibilidad de dispararlos; los div, con sus hijos.
let imagenes = []

after(decorarElementos((el, tag) => {
  if (tag === 'img') {
    el.oyentes = { load: new Set(), error: new Set() }
    el.addEventListener    = (tipo, fn) => el.oyentes[tipo].add(fn)
    el.removeEventListener = (tipo, fn) => el.oyentes[tipo].delete(fn)
    el.disparar            = tipo => el.oyentes[tipo].forEach(fn => fn())
    imagenes.push(el)
  }
  if (tag === 'div') {
    el.hijos       = []
    el.appendChild = hijo => {
      el.hijos.push(hijo)
      hijo.remove = () => el.hijos.splice(el.hijos.indexOf(hijo), 1)
    }
  }
  return el
}))

beforeEach(() => { imagenes = [] })

const MARCO = { x: -120, y: 35 }
const CAJA  = { south: 1, west: 2, north: 3, east: 5 }

const montar = (cfg = {}) => {
  let marco      = MARCO
  const map      = { ...makeMap(), containerPointToLayerPoint: () => marco }
  const host     = adoptLeafletHost(map)
  const oyentes  = oyentesDeVista(host)
  const colgados = []
  host.surface.mount('img').appendChild = nodo => colgados.push(nodo)
  const eventos  = []
  const layer    = new ImageLayer({
    host, pane: 'img', id: 'radar', url: 'a.png', bounds: CAJA,
    onLoad: e => eventos.push(['load', e.url]), onError: e => eventos.push(['error', e.url]),
    ...cfg,
  })
  host.surface.unmount('img')
  return { map, host, oyentes, layer, raiz: colgados[0], eventos, moverMarco: m => (marco = m) }
}

const matriz = t => /^matrix3d\((.+)\)$/.exec(t)[1].split(',').map(Number)

const aplicar = (m, u, v) => {
  const w = m[3] * u + m[7] * v + m[15]
  return [(m[0] * u + m[4] * v + m[12]) / w, (m[1] * u + m[5] * v + m[13]) / w]
}

// Las esquinas de la caja de referencia (256 px) llevadas por el transform del envoltorio.
const esquinas = raiz => [[0, 0], [256, 0], [256, 256], [0, 256]].map(([u, v]) => aplicar(matriz(raiz.style.transform), u, v))

const cerca = (real, esperado) => real.forEach((p, i) => p.forEach((c, j) =>
  assert.ok(Math.abs(c - esperado[i][j]) < 1e-6, `esquina ${i}: ${p} contra ${esperado[i]}`)))

test('el envoltorio lleva la caja a las esquinas proyectadas más el origen del marco', () => {
  const { raiz } = montar()
  assert.equal(raiz.className, 'cristae-image-layer leaflet-zoom-animated')
  assert.equal(raiz.style.width, '256px')
  // nw, ne, se, sw: (lat, lng)·100 y el marco.
  cerca(esquinas(raiz), [[80, 335], [380, 335], [380, 135], [80, 135]])
})

test('un moveend reubica con el marco nuevo; sin cambio no reescribe', () => {
  const { map, raiz, moverMarco } = montar()
  const antes = raiz.style.transform
  map.fire('moveend')
  assert.equal(raiz.style.transform, antes)
  moverMarco({ x: 0, y: 0 })
  map.fire('moveend')
  cerca(esquinas(raiz), [[200, 300], [500, 300], [500, 100], [200, 100]])
})

test('una caja que cruza el antimeridiano suma 360 al este', () => {
  const { layer, raiz } = montar({ bounds: { south: 0, west: 170, north: 1, east: -170 } })
  assert.deepEqual(layer.bounds, { south: 0, west: 170, north: 1, east: 190 })
  assert.equal(esquinas(raiz)[1][0], 19000 - 120)
})

test('las esquinas se desenvuelven a ±180 de la anterior', () => {
  const { layer } = montar({ bounds: undefined, corners: [[1, 175], [1, -175], [0, -175], [0, 175]] })
  assert.deepEqual(layer.bounds, { south: 0, west: 175, north: 1, east: 185 })
})

test('la imagen nace oculta y aparece en load, con onLoad', () => {
  const { raiz, eventos } = montar()
  assert.equal(raiz.style.visibility, 'hidden')
  assert.equal(raiz.hijos.length, 0)
  const [img] = imagenes
  assert.equal(img.src, 'a.png')
  img.disparar('load')
  assert.equal(raiz.style.visibility, '')
  assert.deepEqual(raiz.hijos, [img])
  assert.equal(img.style.width, '100%')
  assert.equal(img.style.objectFit, 'fill')
  assert.deepEqual(eventos, [['load', 'a.png']])
})

test('un setUrl durante la carga descarta la anterior: su load tardío no llega', () => {
  const { layer, raiz, eventos } = montar()
  const [vieja] = imagenes
  layer.setUrl('b.png')
  const nueva = imagenes[1]
  assert.equal(vieja.oyentes.load.size + vieja.oyentes.error.size, 0, 'la vieja ya no tiene oyentes')
  vieja.disparar('load')
  assert.equal(raiz.style.visibility, 'hidden')
  nueva.disparar('load')
  assert.deepEqual(raiz.hijos, [nueva])
  assert.deepEqual(eventos, [['load', 'b.png']])
})

test('la imagen vigente sigue hasta que la nueva carga', () => {
  const { layer, raiz } = montar()
  imagenes[0].disparar('load')
  layer.setUrl('b.png')
  assert.deepEqual(raiz.hijos, [imagenes[0]])
  imagenes[1].disparar('load')
  assert.deepEqual(raiz.hijos, [imagenes[1]])
})

test('un error deja la capa oculta y corre onError', () => {
  const { raiz, eventos } = montar()
  imagenes[0].disparar('error')
  assert.equal(raiz.style.visibility, 'hidden')
  assert.deepEqual(eventos, [['error', 'a.png']])
})

test('un onLoad que lanza queda aislado', t => {
  t.mock.method(console, 'error', () => {})
  const { raiz } = montar({ onLoad: () => { throw new Error('consumidor') } })
  imagenes[0].disparar('load')
  assert.equal(raiz.style.visibility, '')
})

test('destroy durante la carga suelta los oyentes: ni onLoad ni onError', () => {
  const { layer, eventos } = montar()
  const [img] = imagenes
  layer.destroy()
  assert.equal(img.oyentes.load.size + img.oyentes.error.size, 0)
  img.disparar('load')
  assert.deepEqual(eventos, [])
})

test('destroy desmonta el pane y suelta la vista; dos veces no falla', () => {
  const { map, layer, oyentes } = montar()
  assert.ok(map.getPane('img'))
  layer.destroy()
  layer.destroy()
  assert.equal(map.getPane('img'), null)
  assert.equal(oyentes('zoomstart', 'zoomanim', 'move', 'moveend', 'zoomend', 'resize'), 0)
})

test('un nodo propio se muestra sin load y recupera su estilo al soltarlo', () => {
  const lienzo = document.createElement('div')
  lienzo.style.width = '40px'
  const { layer, raiz } = montar({ url: undefined, image: lienzo })
  assert.equal(raiz.style.visibility, '')
  assert.deepEqual(raiz.hijos, [lienzo])
  assert.equal(lienzo.style.width, '100%')
  layer.setUrl('c.png')
  imagenes.at(-1).disparar('load')
  assert.equal(lienzo.style.width, '40px')
  assert.equal(lienzo.style.display, undefined)
  assert.ok(!raiz.hijos.includes(lienzo))
})

test('setImage descarta una carga en curso', () => {
  const { layer, raiz, eventos } = montar()
  const lienzo = document.createElement('div')
  layer.setImage(lienzo)
  imagenes[0].disparar('load')
  assert.deepEqual(raiz.hijos, [lienzo])
  assert.deepEqual(eventos, [])
})

test('el hit es punto en cuadrilátero, sólo con interactive y la imagen a la vista', () => {
  const { layer } = montar({ interactive: true })
  assert.deepEqual(layer.resolveClick({ x: 300, y: 200 }), [], 'todavía no cargó')
  imagenes[0].disparar('load')
  // En px de contenedor la caja va de (200, 100) a (500, 300).
  assert.deepEqual(layer.resolveClick({ x: 300, y: 200 }), [{ ref: 'radar', id: 'radar', distancePx: 0 }])
  assert.deepEqual(layer.resolveHover({ x: 200, y: 100 }).length, 1, 'el borde es adentro')
  assert.deepEqual(layer.resolveClick({ x: 501, y: 200 }), [])
  assert.deepEqual(layer.resolveClick({ x: 300, y: 99 }), [])

  const { layer: muda } = montar()
  imagenes.at(-1).disparar('load')
  assert.deepEqual(muda.resolveClick({ x: 300, y: 200 }), [])
})

test('el hit con esquinas rotadas sigue al cuadrilátero y no a su caja', () => {
  const { layer } = montar({ interactive: true, bounds: undefined, corners: [[2, 1], [1, 2], [2, 3], [3, 2]] })
  imagenes[0].disparar('load')
  assert.equal(layer.resolveClick({ x: 200, y: 200 }).length, 1, 'el centro del rombo')
  assert.equal(layer.resolveClick({ x: 110, y: 110 }).length, 0, 'una esquina de su caja')
})

test('setBounds y setCorners reubican y validan antes de tocar el nodo', () => {
  const { layer, raiz } = montar()
  layer.setBounds({ south: 0, west: 0, north: 1, east: 1 })
  cerca(esquinas(raiz), [[-120, 135], [-20, 135], [-20, 35], [-120, 35]])
  const antes = raiz.style.transform
  assert.throws(() => layer.setBounds({ south: 2, west: 0, north: 1, east: 1 }), TypeError)
  assert.throws(() => layer.setCorners([[0, 0], [0, 1], [1, 0], [1, 1]]), TypeError, 'en moño')
  assert.throws(() => layer.setCorners([[0, 0], [0, 1], [1, 1]]), TypeError, 'tres')
  assert.equal(raiz.style.transform, antes)
})

test('opacity se acota a [0, 1] y una no finita lanza', () => {
  const { layer, raiz } = montar({ opacity: 0.4 })
  assert.equal(raiz.style.opacity, '0.4')
  assert.equal(layer.setOpacity(7), 1)
  assert.equal(raiz.style.opacity, '1')
  assert.throws(() => layer.setOpacity(NaN), TypeError)
})

test('las exclusiones del alta lanzan TypeError', () => {
  assert.throws(() => montar({ image: document.createElement('div') }), TypeError, 'url con image')
  assert.throws(() => montar({ url: undefined }), TypeError, 'sin url ni image')
  assert.throws(() => montar({ corners: [[0, 0], [0, 1], [1, 1], [1, 0]] }), TypeError, 'bounds con corners')
  assert.throws(() => montar({ bounds: undefined }), TypeError, 'sin caja')
  assert.throws(() => montar({ bounds: { south: 0, west: 0, north: 0, east: 1 } }), TypeError, 'sin área')
  assert.throws(() => montar({ bounds: { south: 0, west: 0, north: NaN, east: 1 } }), TypeError, 'no finita')
})

test('un zoom animado lleva el envoltorio a la vista destino', () => {
  const { map, raiz } = montar()
  map.fire('zoomstart')
  map.fire('zoomanim', { zoom: 4, center: { lat: 0, lng: 0 } })
  // project a zoom 4: grados·100·16, con el centro destino en el medio de 800×600.
  const destino = ([lat, lng]) => [lng * 1600 + 400 + MARCO.x, lat * 1600 + 300 + MARCO.y]
  cerca(esquinas(raiz), [[3, 2], [3, 5], [1, 5], [1, 2]].map(destino))
})
