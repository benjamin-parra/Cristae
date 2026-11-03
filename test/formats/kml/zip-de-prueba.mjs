// Escritor de zip deliberadamente ingenuo para los tests de KMZ (PKWARE APPNOTE 6.3.x: encabezado
// local, directorio central y EOCD; números de § a verificar). Deflate con `CompressionStream`, el
// mismo motor del lector, pero el CRC y las cabeceras salen de acá.

const TABLA = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

export const crc32 = bytes => {
  let c = 0xFFFFFFFF
  bytes.forEach(b => { c = TABLA[(c ^ b) & 0xFF] ^ (c >>> 8) })
  return (c ^ 0xFFFFFFFF) >>> 0
}

const desinflar = async bytes =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())

// `entradas`: [nombre, bytes, método 0 | 8]. `crc` reemplaza el CRC declarado de todas, para probar
// el rechazo.
export const zip = async (entradas, { crc } = {}) => {
  const nombre  = n => new TextEncoder().encode(n)
  const partes  = []
  const central = []
  let offset = 0
  for (const [n, datos, metodo] of entradas) {
    const empacado = metodo === 8 ? await desinflar(datos) : datos
    const suma     = crc ?? crc32(datos)
    const nb       = nombre(n)
    const local    = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034B50, true)
    local.setUint16(4, 20, true)
    local.setUint16(8, metodo, true)
    local.setUint32(14, suma, true)
    local.setUint32(18, empacado.length, true)
    local.setUint32(22, datos.length, true)
    local.setUint16(26, nb.length, true)
    const dir = new DataView(new ArrayBuffer(46))
    dir.setUint32(0, 0x02014B50, true)
    dir.setUint16(4, 20, true)
    dir.setUint16(6, 20, true)
    dir.setUint16(10, metodo, true)
    dir.setUint32(16, suma, true)
    dir.setUint32(20, empacado.length, true)
    dir.setUint32(24, datos.length, true)
    dir.setUint16(28, nb.length, true)
    dir.setUint32(42, offset, true)
    partes.push(new Uint8Array(local.buffer), nb, empacado)
    central.push(new Uint8Array(dir.buffer), nb)
    offset += 30 + nb.length + empacado.length
  }
  const largo = central.reduce((s, p) => s + p.length, 0)
  const fin   = new DataView(new ArrayBuffer(22))
  fin.setUint32(0, 0x06054B50, true)
  fin.setUint16(8, entradas.length, true)
  fin.setUint16(10, entradas.length, true)
  fin.setUint32(12, largo, true)
  fin.setUint32(16, offset, true)
  return new Uint8Array(await new Blob([...partes, ...central, new Uint8Array(fin.buffer)]).arrayBuffer())
}
