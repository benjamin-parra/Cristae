// Contextos WebGL al montar y al quitar un mapa de elementos REALES (Lit + custom elements en jsdom), contados por un
// navegador falso que respeta el techo de Chromium. Dos balances:
//
//   T0.1  creados == vivos tras el montaje: ninguna creación espuria. ROJO hoy —una `<cristae-point-layer>` con
//         `source` se construye dos veces: `updated()` monta y enseguida `syncLayer` trata la `source` recién
//         montada como un reemplazo, y el reemplazo es destruir la capa y construir otra—. Va como `todo` hasta
//         que la etapa 1 haga idempotente `attachSource`, para que la suite siga verde mientras tanto.
//         `CRISTAE_SIN_TODO=1 node --test test/element/contextos-montaje.test.mjs` lo corre sin el `todo`.
//   T0.2  `map.remove()` deja 0 vivos y creados == liberados: verde hoy, fija el balance del teardown.
//
// Dos modelos. El de 8: polígono + cluster{overlay{puntos}} (el cluster toma 5: host, badge, burbujas, espiral y
// sub-espiral) + dos capas de puntos. El de 13 es la pila en reposo del Mapa Geotáctico de la app: ese mismo, más
// las cinco capas que el kit del shell monta por código con `engine.add*` (marcas, extremos de ruta, mediciones,
// rutas calculadas y enlaces de seguimiento); esas no se construyen dos veces.
//
// El árbol se arma desconectado y se conecta de una vez, como React al commitear; las props se asignan después de
// conectar (`react`) o antes (`antes`), siempre antes de que corra un microtask de Lit.
//
// El harness va PRIMERO: window, customElements y lo que Lit toca al evaluar.
import { window } from '../../test-helpers/jsdom-elementos.mjs'
import { instalarNavegador } from '../../test-helpers/navegador-falso.mjs'
import { makeIconSet } from '../../test-helpers/engine-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import '../../src/index.js'
import { createSource } from '../../src/data/index.js'

const PENDIENTE = process.env.CRISTAE_SIN_TODO ? false : 'etapa 1: montaje doble'

const ACC     = { idOf: v => v.id, positionOf: v => ({ lat: v.lat, lng: v.lng }) }
const POLI    = { idOf: v => v.id, ringsOf: () => [[[0, 0], [0, 1], [1, 1]]] }
const LINEA   = { idOf: s => s.id, pathOf: s => s.pts, styleOf: s => s }
const iconSet = makeIconSet()

const esperar = ms => new Promise(r => setTimeout(r, ms))
const items   = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, lat: i * 1e-4, lng: i * 1e-4 }))

const fuente = n => {
  const source = createSource(ACC)
  source.set(items(n))
  return source
}

// Las capas que el kit del shell monta con `engine.add*` al estar listo el motor: cinco contextos más.
const capasDelKit = engine => {
  engine.addPointLayer({ id: 'marcas',   accessors: ACC, iconSet, data: items(2) })
  engine.addPointLayer({ id: 'extremos', accessors: ACC, iconSet, data: items(2) })
  engine.addLineLayer({ id: 'medicion', accessors: LINEA, data: [] })           // montada «siempre, también vacía»
  engine.addLineLayer({ id: 'rutas',    accessors: LINEA, data: [] })
  engine.addLineLayer({ id: 'enlaces',  accessors: LINEA, data: [{ id: 1, pts: [[0, 0], [1, 1]], color: '#00f', weight: 2, opacity: 1 }] })
}

// `capas`: 8 o 13. `orden`: 'react' asigna las props después de conectar, 'antes' antes.
const armar = async (capas, orden) => {
  const navegador = instalarNavegador(window)
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

const CASOS = [8, 13].flatMap(capas => ['react', 'antes'].map(orden => [capas, orden]))

after(() => document.body.replaceChildren())

for (const [capas, orden] of CASOS) {
  test(`T0.1 modelo de ${capas} capas, props ${orden}: creados == vivos tras el montaje`, { todo: PENDIENTE }, async t => {
    const { map, navegador } = await armar(capas, orden)
    t.after(() => map.remove())
    const estado = navegador.stat()
    assert.equal(estado.vivos, capas, `capas vivas: ${navegador.resumen()}`)
    assert.equal(estado.desalojados, 0, 'sin ajenos no hay desalojo')
    const dobles = navegador.contextos.filter(c => c.causa === 'liberado').map(c => c.pane)
    assert.equal(estado.creados, estado.vivos,
      `creaciones espurias: ${navegador.resumen()}; liberados al instante en: ${dobles.join(', ')}`)
    assert.deepEqual(navegador.violaciones, [], 'ninguna capa usa un recurso de un contexto perdido ni de otro')
  })
}

for (const [capas, orden] of CASOS) {
  test(`T0.2 modelo de ${capas} capas, props ${orden}: map.remove() deja 0 vivos y creados == liberados`, async () => {
    const { map, navegador } = await armar(capas, orden)
    assert.equal(navegador.vivos, capas, 'el montaje dejó las capas esperadas')
    map.remove()
    await esperar(30)
    const estado = navegador.stat()
    assert.equal(estado.vivos, 0, `quedaron contextos: ${navegador.resumen()}`)
    assert.equal(estado.creados, estado.liberados, `no se devolvió todo: ${navegador.resumen()}`)
    assert.equal(estado.desalojados, 0)
    assert.deepEqual(navegador.violaciones, [])
  })
}
