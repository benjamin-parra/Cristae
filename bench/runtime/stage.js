// Stage del banco: un mapa aislado (sin tiles) + el motor real + el backend que se mide.
// Tres decisiones de orden que definen qué se está midiendo:
//   · el dataset se arma ANTES del medidor — la fase de montaje mide la librería, no al escenario
//     construyendo arrays;
//   · el `L.map` también nace antes — su chrome (panes, contenedor) es piso de Leaflet y no puede
//     entrar en el conteo de nodos de la capa;
//   · desde `iniciar()` en adelante todo lo que se crea ES la librería: motor, capas y datos.

import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { MapEngine, adoptLeafletHost } from '../../src/index.js'
import { crearMedidor } from './metrics.js'
import { datosDe, mulberry32, VISTA } from './scenario.js'

// Escotilla `?tiles=1`: el basemap real ayuda a mirar la escena, pero apaga el aislamiento
// cross-origin (ver bench/vite.config.js) y con él la memoria exacta. Por default, sin tiles.
export const CON_TILES = new URLSearchParams(globalThis.location?.search ?? '').get('tiles') === '1'
const OSM = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, attribution: '© OpenStreetMap' }

// Sin animaciones ni inercia: el estímulo del guion tiene que ser el mismo en A y B, y una animación
// en curso mete un tercer reloj que ninguno de los dos controla. `zoomSnap: 0` habilita el barrido
// fraccional de la fase de zoom. NO se toca `preferCanvas`: las capas vectoriales se miden con el
// renderer por defecto de Leaflet (SVG), que es el que describe la radiografía.
const OPCIONES_MAPA = {
  center              : VISTA.centro,
  zoom                : VISTA.zoom,
  zoomSnap            : 0,
  zoomAnimation       : false,
  fadeAnimation       : false,
  markerZoomAnimation : false,
  inertia             : false,
  zoomControl         : false,
  attributionControl  : false,
}

const PREFIJO      = '../backends/'
const MODULOS      = import.meta.glob('../backends/*.js')
const nombreDeRuta = ruta => ruta.slice(PREFIJO.length, -'.js'.length)

/** Nombres de backend disponibles (`heat.actual`, …) — la UI los lista de acá, no de una lista a mano. */
export const backendsDisponibles = () => Object.keys(MODULOS).map(nombreDeRuta).sort()

/** Acepta el nombre del módulo o el módulo ya importado (namespace o el objeto backend suelto). */
export const cargarBackend = async modulo => {
  if (typeof modulo !== 'string') return modulo?.default ?? modulo
  const cargar = MODULOS[`${PREFIJO}${modulo}.js`]
  if (!cargar) throw new Error(`bench: no hay backend "${modulo}" (${backendsDisponibles().join(', ')})`)
  return (await cargar()).default
}

// El nombre del módulo lo declara el DIRECTORIO, no el objeto: un backend no sabe si es `.actual` o
// `.remake`. Sin esto el JSON exportado no dice cuál de las dos variantes fue A, que es justo lo que
// se compara. El índice se resuelve una vez y sólo cuando alguien lo pide (al cerrar la corrida).
let indice = null
const indexar = () => indice ??= Promise.all(
  Object.entries(MODULOS).map(([ruta, cargar]) => cargar().then(modulo => [modulo.default ?? modulo, nombreDeRuta(ruta)])),
).then(pares => new Map(pares))

export const nombreDeBackend = async backend => (await indexar()).get(backend) ?? backend.id

/**
 * Monta un stage completo y deja abierta la fase de montaje del medidor; el harness sigue desde ahí.
 * `destruir()` devuelve el recuento de lo que quedó colgando en el contenedor: un teardown que no
 * se puede verificar no es un teardown.
 */
export const crearStage = async (el, { modulo, n, semilla }) => {
  const backend = await cargarBackend(modulo)
  const datos   = datosDe(backend.id, n, semilla)
  const rnd     = mulberry32(semilla)

  const medidor    = crearMedidor(el)
  const contenedor = el.appendChild(document.createElement('div'))
  contenedor.className     = 'bench-mapa'
  contenedor.style.cssText = 'position:relative;width:100%;height:100%'

  const map = L.map(contenedor, OPCIONES_MAPA)

  medidor.iniciar()                      // abre la fase de montaje: de acá en adelante se mide

  const engine = new MapEngine({ host: adoptLeafletHost(map, { leaflet: L }), zoomAnimation: 'none' })
  await engine.ready
  CON_TILES && engine.setTileProvider(OSM)

  // `remove()` emite `unload`: alcanza para saber si el motor ya se llevó el mapa adoptado, sin
  // espiar privados de Leaflet ni arriesgar el "container is being reused" de un remove doble.
  let mapaVivo = true
  map.on('unload', () => mapaVivo = false)

  const destruir = () => {
    backend.destruir()
    engine.destroy()
    mapaVivo && map.remove()
    contenedor.remove()
    return { hijos: el.childElementCount, canvas: el.querySelectorAll('canvas').length }
  }

  backend.montar({ engine, map, L, datos, rnd })
  backend.aplicarN(n)

  return { engine, map, backend, medidor, datos, destruir }
}
