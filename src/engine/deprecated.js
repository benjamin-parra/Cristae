// Los avisos de retiro: uno por página y por clave. Una clave junta las puertas de un mismo retiro —el elemento y
// el método del motor que monta—, así quien usa una no ve también el aviso de la otra.
const warned = new Set()

/** Avisa `message` por consola la primera vez que la página pide `key`. */
export const deprecated = (key, message) => {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(message)
}
