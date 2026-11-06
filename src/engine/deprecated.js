// Los avisos de retiro: uno por página y por clave. Una clave junta las puertas de un mismo retiro —el elemento y
// el método del motor que monta—, así quien usa una no ve también el aviso de la otra.
const warned = new Set()

/** La versión que retira todo lo deprecado: el minor siguiente a la de la etapa C (docs/versionado.md). Los
 *  avisos de consola la toman de acá; el JSDoc y la documentación la repiten a mano. */
export const RETIRO = 'v0.47.0'

/** Avisa `message` por consola la primera vez que la página pide `key`. */
export const deprecated = (key, message) => {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(message)
}
