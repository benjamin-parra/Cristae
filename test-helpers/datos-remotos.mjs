// Dobles de red para las capas por `url`: un `fetch` que responde GeoJSON desde un mapa de rutas, con respuestas
// que se pueden retener y soltar a mano, y un motor sobre el navegador falso.
import { makeLeaflet, makeMap } from './engine-stub.mjs'
import { MapEngine } from '../src/engine/MapEngine.js'
import { adoptLeafletHost } from '../src/host/LeafletHost.js'

export const coleccion = features => JSON.stringify({ type: 'FeatureCollection', features })
export const punto = (lng, lat, properties = {}) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: [lng, lat] } })
export const cuadrado = (lng, lat, d, properties = {}) => ({
  type: 'Feature', properties,
  geometry: { type: 'Polygon', coordinates: [[[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]] },
})
export const traza = (coords, properties = {}) => ({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates: coords } })

// `rutas`: url → cuerpo (string) o { status } o una función `(signal) => Promise<cuerpo>` para retener la respuesta.
// Cada pedido queda en `pedidos`, con su `signal`.
export const fetchFalso = rutas => {
  const pedidos = []
  const fetch = async (url, init) => {
    const signal = init?.signal
    pedidos.push({ url, signal })
    let r = rutas[url]
    if (typeof r === 'function') r = await r(signal)
    if (signal?.aborted) throw Object.assign(new Error('abortado'), { name: 'AbortError' })
    if (r === undefined) return new Response('no hay', { status: 404 })
    if (typeof r === 'object') return new Response('', { status: r.status })
    return new Response(r, { status: 200 })
  }
  fetch.pedidos = pedidos
  return fetch
}

// Una respuesta que se suelta cuando el test lo dice.
export const retenida = () => {
  let soltar
  const espera = new Promise(r => { soltar = r })
  const rutaDe = () => async () => (await espera)
  return { soltar, rutaDe }
}

export const motor = () => new MapEngine({ host: adoptLeafletHost(makeMap(), { leaflet: makeLeaflet() }) })

// Cede hasta que `cond()` se cumpla: las respuestas de `Response` tardan varias tareas, y con `mock.timers` no hay
// `setTimeout` real que usar.
export const hasta = async (cond, tope = 200) => {
  for (let i = 0; i < tope && !cond(); i++) await new Promise(r => setImmediate(r))
  if (!cond()) throw new Error('la condición no se cumplió')
}
