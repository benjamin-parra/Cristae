// Descarga de bytes con el error clasificado. Es la base común de `url` en las capas y de `src` en los
// íconos por imagen: quien llama distingue una caída de red de un bloqueo de CORS sin leer el mensaje del
// navegador, que no los diferencia. Sin DOM: lo que toca `document` o `location` va protegido con typeof.

export class RemoteError extends Error {
  constructor(code, url, message, status) {
    super(message)
    this.name = 'RemoteError'
    this.code = code
    this.url = url
    if (status !== undefined) this.status = status
  }
}

// El navegador rechaza el fetch con un TypeError igual para una caída y para un CORS. Se distingue por
// el origen: otro origen que falla es, casi siempre, la política de CORS.
const isCrossOrigin = url => {
  if (typeof location === 'undefined') return false
  try {
    const base = typeof document !== 'undefined' ? document.baseURI : location.href
    return new URL(url, base).origin !== location.origin
  } catch { return false }
}

const isAbort = (e, signal) => signal?.aborted || e?.name === 'AbortError'

export const fetchBytes = async (url, { fetch = globalThis.fetch, signal } = {}) => {
  if (typeof fetch !== 'function') throw new RemoteError('network', url, 'no hay fetch disponible')
  let res
  try { res = await fetch(url, signal ? { signal } : undefined) }
  catch (e) {
    if (isAbort(e, signal)) throw e
    const code = isCrossOrigin(url) ? 'cors' : 'network'
    throw new RemoteError(code, url, code === 'cors' ? `${url}: bloqueada por CORS o caída de red` : `${url}: ${e?.message ?? 'falló la red'}`)
  }
  if (!res.ok) throw new RemoteError('network', url, `${url}: HTTP ${res.status}`, res.status)
  try {
    return { bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers }
  } catch (e) {
    if (isAbort(e, signal)) throw e
    throw new RemoteError('network', url, `${url}: ${e?.message ?? 'falló la lectura'}`)
  }
}
