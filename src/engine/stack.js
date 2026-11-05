// El orden de declaración de las capas primarias de un motor. Del rango sale el z derivado
// (`plano + rango·Z_STEP`), así que una capa que monta tarde cae donde se declaró y remontarla no la sube.
//
// Dos listas: declaradas, por orden de documento del nodo que las declaró, e imperativas, por orden de alta y encima
// de todas las declaradas. El rango es denso: el de una declarada es su índice; el de una imperativa,
// `declaradas + su índice`. No hay memoria por id: una imperativa que vuelve va arriba de las imperativas.

export const STACK = Symbol('cristae.stack')   // clave del cfg del alta: dónde se declaró la capa

const FOLLOWING = 4   // Node.DOCUMENT_POSITION_FOLLOWING; el global `Node` no existe sin DOM

// Un nodo conectado ubica la capa en el documento. Sin `compareDocumentPosition` (un objeto plano, los elementos de
// test-helpers/element-stub.mjs) o desconectado, la capa es imperativa.
const placed = at => typeof at?.compareDocumentPosition === 'function' && !!at.isConnected

// ¿`node` precede a `at`? Si no comparten raíz, el que está en un shadow root sube a su host hasta que la compartan, y
// el host precede a su contenido de sombra. Sin raíz común, `at` cuenta como posterior. Defensivo: hoy una capa en un
// shadow root no monta (src/element/base.js:39).
const precedes = (node, at) => {
  for (let x = node; x; x = x.getRootNode().host) {
    const root = x.getRootNode()
    for (let y = at; y; y = y.getRootNode().host)
      if (y.getRootNode() === root) return x === y ? x === node : !!(x.compareDocumentPosition(y) & FOLLOWING)
  }
  return true
}

export const createStack = () => {
  const declared   = []   // { id, at }, por orden de documento
  const imperative = []   // ids, por orden de alta

  const remove = id => {
    const d = declared.findIndex(entry => entry.id === id)
    if (d >= 0) {
      declared.splice(d, 1)
      return d
    }
    const i = imperative.indexOf(id)
    if (i < 0) return -1
    imperative.splice(i, 1)
    return declared.length + i
  }

  // La declarada recorre su lista desde el final: montar en orden cuesta una comparación. Salta las entradas
  // desconectadas, porque React quita un grupo desconectando varios nodos antes del `disconnectedCallback` de cada
  // uno y comparar contra ellos da un orden arbitrario; por eso tampoco hay búsqueda binaria.
  const insert = (id, at) => {
    remove(id)
    if (!placed(at)) return declared.length + imperative.push(id) - 1
    let i = declared.length
    while (i && !(declared[i - 1].at.isConnected && precedes(declared[i - 1].at, at))) i--
    declared.splice(i, 0, { id, at })
    return i
  }

  // cb no debe tocar la pila mientras recorre.
  const forEachFrom = (rank, cb) => {
    const n = declared.length
    for (let r = Math.max(rank, 0); r < n + imperative.length; r++)
      cb(r < n ? declared[r].id : imperative[r - n], r)
  }

  return { insert, remove, forEachFrom }
}
