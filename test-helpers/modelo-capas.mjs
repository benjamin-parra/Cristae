// El modelo de capas del Mapa Geotáctico de la app, montado con elementos REALES (Lit + custom elements en jsdom) bajo un
// navegador falso que respeta el techo de contextos de Chromium. Lo comparten los tests que cuentan contextos:
// `contextos-montaje` (balances del montaje y del remove) y `contextos-readquirir` (lo que pasa cuando el navegador los
// quita). Hay dos modelos. El de 8: polígono + cluster{overlay{puntos}} (el cluster toma 5: host, badge, burbujas, espiral y
// sub-espiral) + dos capas de puntos. El de 13 es la pila en reposo del Mapa Geotáctico: ese mismo, más las cinco capas que el
// kit del shell monta por código con `engine.add*` (marcas, extremos de ruta, mediciones, rutas calculadas y enlaces de
// seguimiento); esas no se construyen dos veces.
//
// El árbol se arma desconectado y se conecta de una vez, como React al commitear; las props se asignan después de conectar
// (`react`) o antes (`antes`), siempre antes de que corra un microtask de Lit.
//
// Se importa PRIMERO: el harness de jsdom pone window, customElements y lo que Lit toca al evaluar.
import { window } from './jsdom-elementos.mjs'
import { instalarNavegador } from './navegador-falso.mjs'
import { makeIconSet } from './engine-stub.mjs'
import '../src/index.js'
import { createSource } from '../src/data/index.js'

export const ACC     = { idOf: v => v.id, positionOf: v => ({ lat: v.lat, lng: v.lng }) }
export const POLI    = { idOf: v => v.id, ringsOf: () => [[[0, 0], [0, 1], [1, 1]]] }
export const LINEA   = { idOf: s => s.id, pathOf: s => s.pts, styleOf: s => s }
export const iconSet = makeIconSet()

export const esperar = ms => new Promise(r => setTimeout(r, ms))
export const items   = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, lat: i * 1e-4, lng: i * 1e-4 }))

export const fuente = n => {
  const source = createSource(ACC)
  source.set(items(n))
  return source
}

// Las capas que el kit del shell monta con `engine.add*` al estar listo el motor: cinco contextos más.
export const capasDelKit = engine => {
  engine.addPointLayer({ id: 'marcas',   accessors: ACC, iconSet, data: items(2) })
  engine.addPointLayer({ id: 'extremos', accessors: ACC, iconSet, data: items(2) })
  engine.addLineLayer({ id: 'medicion', accessors: LINEA, data: [] })           // montada «siempre, también vacía»
  engine.addLineLayer({ id: 'rutas',    accessors: LINEA, data: [] })
  engine.addLineLayer({ id: 'enlaces',  accessors: LINEA, data: [{ id: 1, pts: [[0, 0], [1, 1]], color: '#00f', weight: 2, opacity: 1 }] })
}

// `capas`: 8 o 13. `orden`: 'react' asigna las props después de conectar, 'antes' antes. `opciones` van al navegador falso
// (`crearGl`, `techo`…).
export const armar = async (capas, orden, opciones = {}) => {
  const navegador = instalarNavegador(window, opciones)
  document.body.replaceChildren()
  const map = document.createElement('cristae-map')
  map.style.cssText = 'display:block;width:800px;height:600px'
  document.body.appendChild(map)
  await esperar(40)                                   // el motor nace en firstUpdated del mapa

  const [poly, cl, ov, veh, lug, bus] = ['polygon-layer', 'cluster', 'overlay', 'point-layer', 'point-layer', 'point-layer']
    .map(tag => document.createElement(`cristae-${tag}`))
  ov.appendChild(veh)
  cl.appendChild(ov)
  const raiz = document.createElement('div')
  ;[poly, cl, lug, bus].forEach(el => raiz.appendChild(el))

  const props = () => {
    Object.assign(poly, { id: 'geo', accessors: POLI, data: [{ id: 'z1' }] })
    Object.assign(cl,   { radius: 80 })
    Object.assign(ov,   { iconSet })
    Object.assign(veh,  { id: 'veh', source: fuente(3), iconSet })
    Object.assign(lug,  { id: 'lugares', source: fuente(2), iconSet })
    Object.assign(bus,  { id: 'busqueda', source: fuente(1), iconSet })
  }
  orden === 'antes' && props()
  ;[...raiz.children].forEach(el => map.appendChild(el))   // se conecta de una vez
  orden === 'react' && props()
  await esperar(80)
  capas === 13 && capasDelKit(map.engine)
  await esperar(40)
  return { map, navegador }
}

// Un mapa sin capas, con el motor ya listo, para armar a mano lo que cada test necesita con `engine.add*`.
export const armarVacio = async (opciones = {}) => {
  const navegador = instalarNavegador(window, opciones)
  document.body.replaceChildren()
  const map = document.createElement('cristae-map')
  map.style.cssText = 'display:block;width:800px;height:600px'
  document.body.appendChild(map)
  await esperar(40)
  return { map, navegador }
}
