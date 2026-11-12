// El vocabulario que se promete de un proveedor de tiles. Hoy el motor entrega el objeto tal cual al anfitrión,
// que lo pasa a su capa de tiles; el anfitrión GL lee sólo estas seis claves, así que el resto avisa desde ya.
import { deprecated } from '../engine/deprecated.js'

export const TILE_KEYS = ['url', 'subdomains', 'minZoom', 'maxZoom', 'maxNativeZoom', 'attribution']

const LISTA = TILE_KEYS.join(', ')

// Avisa una vez por página y por clave de `provider` que no es del vocabulario. `noWrap` tiene su reemplazo, y
// las demás se retiran sin él. No toca el proveedor: sigue funcionando como hasta ahora.
export const warnTileKeys = provider => {
  if (!provider || typeof provider !== 'object') return
  for (const key of Object.keys(provider)) {
    if (TILE_KEYS.includes(key)) continue
    deprecated(`tile.${key}`, key === 'noWrap'
      ? '[cristae] tile.noWrap está deprecado y se retira con el anfitrión GL: usar worldCopies en MapEngine ' +
        "(world-copies en <cristae-map>), por ejemplo new MapEngine({ container, worldCopies: false })."
      : `[cristae] tile.${key} está deprecado y se retira con el anfitrión GL: sigue funcionando por ahora, pero ` +
        `el proveedor promete sólo ${LISTA}.`)
  }
}
