// Tiles de altura por la red: el pedido de un tile y su decodificación, y una caché de los ya leídos.
// Lo comparten el terreno de medida (`terrain`) y quien necesite las mismas alturas en otra parte, así
// que el mismo tile no se pide ni se decodifica dos veces. Toda la red pasa por el `fetch` que se le
// pase, suelto: el del navegador lanza con otro receptor. No hay estado al importar el módulo.
import { decodeTile } from './raster.js'

// Los tiles de la caché se miden en bytes y no en cuenta, porque su tamaño depende de la fuente (256 o
// 512 de lado). El tope son tres mosaicos del tamaño máximo de una capa: el visible, el de una medida y
// el de un paneo. 2048 es el MAX_TEXTURE_SIZE mínimo de WebGL2, el lado más grande que una capa arma.
const CACHE_SIDE = 2048
export const HEIGHT_CACHE_BYTES = 3 * CACHE_SIDE * CACHE_SIDE * Float32Array.BYTES_PER_ELEMENT

// La opción interna con que `terrain` toma una caché: un Symbol, así que no figura en los tipos ni en los
// docs ni la escribe un consumidor por casualidad. Sin ella, `terrain` pide y decodifica cada tile.
export const TILE_CACHE = Symbol('cristae.terrain.cache')

// El tile (z, x, y) de `source` como alturas en m, fila por fila, o `null` si el proveedor no lo tiene
// (404 o 204). La x se envuelve a [0, 2^z). Un 4xx o 5xx rechaza con `status`, un tile ilegible o de otro
// tamaño que `source.tileSize` (256 por omisión) rechaza con la URL, y un pedido sin respuesta con la
// causa. Un `signal` abortado rechaza por el fetch. El arreglo que devuelve no se escribe.
export const loadHeightTile = async (source, z, x, y, { fetch: fetchTile = globalThis.fetch, signal } = {}) => {
  const wrap    = 2 ** z
  const size    = source.tileSize ?? 256
  const url     = source.url.replaceAll('{z}', z).replaceAll('{x}', (x % wrap + wrap) % wrap).replaceAll('{y}', y)
  const unheard = cause => { throw new Error(`[terrain] ${url} no respondió`, { cause }) }
  const res     = await fetchTile(url, { signal }).catch(unheard)
  if (res.status === 404 || res.status === 204) return null
  if (!res.ok) throw Object.assign(new Error(`[terrain] ${url} respondió ${res.status}`), { status: res.status })

  const { width, height, heights } = await decodeTile(new Uint8Array(await res.arrayBuffer().catch(unheard)), source.encoding)
    .catch(error => {
      throw error.message.startsWith('[terrain]') ? error : new Error(`[terrain] ${url} no es un tile legible: ${error.message}`, { cause: error })
    })
  if (width !== size || height !== size) throw new Error(`[terrain] ${url} mide ${width}×${height}; se esperaban ${size}×${size}`)
  return heights
}

// Una caché de tiles de altura, LRU por bytes: el `Map` guarda el orden de uso, el más viejo primero. Sirve
// con cualquier fuente, porque la clave lleva la plantilla, la codificación, el lado y z/x/y (con la x
// envuelta). Lo que guarda es el resultado de `loadHeightTile`: un `null` por un 404 se guarda, un error
// no. Un tile pedido que ya está en vuelo no se vuelve a pedir: cada interesado lleva su `signal`, abortar
// a uno no aborta a los demás, y el fetch real se aborta sólo cuando abortaron todos.
export const createHeightTileCache = ({ maxBytes = HEIGHT_CACHE_BYTES } = {}) => {
  const done    = new Map()
  const pending = new Map()
  let bytes     = 0

  const store = (key, values) => {
    done.set(key, values)
    bytes += values?.byteLength ?? 0
    for (const [old, gone] of done) {
      if (bytes <= maxBytes) break
      done.delete(old)
      bytes -= gone?.byteLength ?? 0
    }
  }

  const start = (key, source, z, x, y, fetchTile) => {
    const job = { interested: 0, controller: new AbortController(), promise: null }
    job.promise = loadHeightTile(source, z, x, y, { fetch: fetchTile, signal: job.controller.signal }).then(values => {
      if (pending.get(key) === job) pending.delete(key)
      store(key, values)
      return values
    }, error => {
      if (pending.get(key) === job) pending.delete(key)
      throw error
    })
    pending.set(key, job)
    return job
  }

  return {
    get: async (source, z, x, y, { fetch: fetchTile, signal } = {}) => {
      signal?.throwIfAborted()
      const wrap = 2 ** z
      const key  = `${source.url}|${source.encoding}|${source.tileSize ?? 256}|${z}/${(x % wrap + wrap) % wrap}/${y}`
      if (done.has(key)) {
        const values = done.get(key)
        done.delete(key)
        done.set(key, values)
        return values
      }

      const job = pending.get(key) ?? start(key, source, z, x, y, fetchTile)
      job.interested++
      return new Promise((resolve, reject) => {
        const leave = () => {
          signal?.removeEventListener('abort', onAbort)
          if (--job.interested || pending.get(key) !== job) return

          pending.delete(key)
          job.controller.abort()
        }
        const onAbort = () => {
          leave()
          reject(signal.reason)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        job.promise.then(values => {
          signal?.removeEventListener('abort', onAbort)
          resolve(values)
        }, error => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        })
      })
    },
    // Vacía la caché y suelta los tiles en vuelo, que ya nadie espera.
    clear: () => {
      for (const job of pending.values()) job.controller.abort()
      pending.clear()
      done.clear()
      bytes = 0
    },
    get bytes() { return bytes },
    get size() { return done.size },
  }
}
