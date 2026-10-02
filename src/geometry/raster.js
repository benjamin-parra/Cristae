// Decodificador de tiles de altura: los bytes de un PNG o de un WebP a las alturas en m de sus píxeles.
// Decodifica un tile por llamada y no sabe del mosaico: quien arma la grilla copia lo que necesita de cada
// tile, y la misma carga podría alimentar otra cosa.
//
// El formato lo deciden los bytes mágicos, no el content-type. El PNG se decodifica acá y no por el canvas:
// con protección anti-fingerprinting el navegador altera lo que devuelve `getImageData`, y en Terrarium un
// bit de R son 256 m de altura; además `DecompressionStream` es global en el navegador, en los workers y en
// Node, y el camino real se prueba sin canvas. El WebP sí pasa por la plataforma, y un canario de 64 × 64
// verifica la primera vez que ella no altera los píxeles. Nada corre al importar el módulo.
//
// Un tile ilegible rechaza con el motivo solo, para que el llamador lo componga con la URL; un entorno sin
// `DecompressionStream` o sin WebP, y el canario alterado, rechazan con el mensaje completo de la API: la
// culpa es del entorno, no del tile.

const NO_PNG  = '[terrain] este entorno no decodifica PNG: le falta DecompressionStream'
const NO_WEBP = '[terrain] este entorno no decodifica WebP: usa una fuente PNG, como terrainPresets.aws'
const ALTERED = '[terrain] este navegador altera los píxeles que lee (protección anti-fingerprinting): usa una fuente PNG, como terrainPresets.aws'

// WebP sin pérdida de 64 × 64 (238 B) con R = 37x + 11y, G = 13x + 71y + 128, B = 7xy + 3 (mod 256) y A = 255.
const CANARY = 'UklGRuYAAABXRUJQVlA4TNoAAAAvP8APAM1lRP9jFxH9DwtBtg3BuK51/ykMRCCQaIQ73GBwIAAgoLxt2/Zn27Zt27Zt295cW1tbW1tbm427yNeKV3uf4scOQDsg7IC3A80OXDtI7KC2g4kdrO3gZAdPOwTYIdwOcXZItfcpcuxQbIcqOzTaocMO/XYYs8OsHVbssG2HIzsc2+HKDtd2uLHDrR3u7HBvhwc7PNrhww7/doDYAW0Hkh2YdhDYQW4HnR3M7WBnB1c7+Ngh2A5Rdki0Q4Yd8u1QZu9T1NqhxQ7ddhiyw6QdFuywboc9Gw=='

// La promesa del canario es el único estado del módulo: se crea con el primer WebP del realm y resuelve a
// `undefined` si pasa, o al mensaje con que se rechaza todo WebP de ese realm.
let canary

const ascii = (bytes, from, count) => String.fromCharCode(...bytes.subarray(from, from + count))

const readWebp = async bytes => {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }),
    { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const { width, height } = bitmap   // close() los pone en 0
  let context

  // El bitmap se cierra aunque falle el canvas: desde que existe, todo lo que puede lanzar va acá.
  try {
    context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })
    context.drawImage(bitmap, 0, 0)
  } finally { bitmap.close() }
  return { width, height, data: context.getImageData(0, 0, width, height).data, offset: 0, stride: width * 4, bpp: 4 }
}

// Las alturas de los píxeles de un tile, fila por fila: Terrarium, o Terrain-RGB con `encoding` 'mapbox', y
// NaN donde el alfa es 0. El píxel (x, y) empieza en `data[offset + y·stride + x·bpp]`, con R, G y B en ese
// orden y el alfa en +3 cuando bpp = 4.
const heightsOf = ({ width, height, data, offset, stride, bpp }, encoding) => {
  const heights = new Float32Array(width * height)
  const mapbox  = encoding === 'mapbox'

  for (let y = 0, k = 0; y < height; y++)
    for (let x = 0, at = offset + y * stride; x < width; x++, k++, at += bpp)
      heights[k] = bpp === 4 && data[at + 3] === 0 ? NaN
        : mapbox ? -10000 + (data[at] * 65536 + data[at + 1] * 256 + data[at + 2]) * 0.1
        : data[at] * 256 + data[at + 1] + data[at + 2] / 256 - 32768
  return { width, height, heights }
}

// Las alturas de un tile con su ancho y su alto, con `encoding` el de la fuente. Un WebP pasa antes por el
// canario. Del PNG se leen `IHDR` y todos los `IDAT`, sin copiarlos, hasta `IEND`. El CRC no se verifica: el
// Adler-32 de zlib cubre los datos, y un dato corrupto falla al inflar. Se acepta RGB o RGBA de 8 bits sin
// entrelazar; lo demás se rechaza con su motivo. El inflado se desfiltra en su lugar: el byte de filtro de
// cada fila (offset 1 del píxel) sigue ahí, y el `Uint8Array` envuelve módulo 256.
export const decodeTile = async (bytes, encoding) => {
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    canary ??= readWebp(Uint8Array.from(atob(CANARY), c => c.charCodeAt(0))).then(({ width, height, data }) => {
      if (width !== 64 || height !== 64) return ALTERED

      for (let y = 0, i = 0; y < 64; y++)
        for (let x = 0; x < 64; x++, i += 4)
          if (data[i]     !== (37 * x + 11 * y) % 256      ||
              data[i + 1] !== (13 * x + 71 * y + 128) % 256 ||
              data[i + 2] !== (7 * x * y + 3) % 256         ||
              data[i + 3] !== 255) return ALTERED
    }, () => NO_WEBP)

    const failure = await canary

    if (failure) throw new Error(failure)
    return heightsOf(await readWebp(bytes).catch(cause => { throw new Error('WebP ilegible', { cause }) }), encoding)
  }

  if (ascii(bytes, 0, 8) !== '\x89PNG\r\n\x1a\n') throw new Error('no es PNG ni WebP')
  if (typeof DecompressionStream !== 'function') throw new Error(NO_PNG)

  const view  = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const idats = []
  let header  = 0
  let ended   = false

  for (let pos = 8; !ended; ) {
    // Sin 8 bytes de cabecera el largo no existe, y el chunk entero no cabe: el mismo rechazo.
    const size = pos + 8 <= bytes.length ? view.getUint32(pos) : bytes.length

    if (pos + 12 + size > bytes.length) throw new Error('PNG truncado')

    const type = ascii(bytes, pos + 4, 4)

    if (type === 'IDAT') idats.push(bytes.subarray(pos + 8, pos + 8 + size))
    else if (type === 'IHDR' && size === 13) header = pos + 8
    else if (type === 'IEND') ended = true
    pos += 12 + size
  }

  if (!header) throw new Error('PNG sin IHDR')

  const width  = view.getUint32(header)
  const height = view.getUint32(header + 4)
  const depth  = bytes[header + 8]
  const color  = bytes[header + 9]

  if (depth !== 8) throw new Error(`PNG de ${depth} bits: solo se lee 8`)
  if (color !== 2 && color !== 6) throw new Error(`PNG de tipo de color ${color}: solo RGB (2) y RGBA (6)`)
  if (bytes[header + 10] || bytes[header + 11]) throw new Error('PNG con método de compresión o de filtro desconocido')
  if (bytes[header + 12]) throw new Error('PNG entrelazado')

  const bpp      = color === 6 ? 4 : 3
  const stride   = 1 + width * bpp
  const expected = height * stride
  const reader   = new Blob(idats).stream().pipeThrough(new DecompressionStream('deflate')).getReader()
  const parts    = []
  let inflated   = 0

  // Se infla por partes y se corta apenas el total pasa de lo que declara el IHDR: un flujo que infla de más
  // se rechaza sin llegar a la memoria, y lo retenido nunca pasa de h·stride más una parte. Ese tope es el
  // del IHDR; que el tile mida lo que se pidió lo valida quien lo pidió.
  try {
    for (let part; !(part = await reader.read()).done && (inflated += part.value.length) <= expected; )
      parts.push(part.value)
  } catch (cause) { throw new Error('PNG con datos corruptos', { cause }) }

  if (inflated > expected) {
    reader.cancel()
    throw new Error(`PNG con más datos que los ${expected} bytes esperados`)
  }
  if (inflated < expected) throw new Error(`PNG con ${inflated} bytes de datos; ${expected} esperados`)

  const raw = new Uint8Array(await new Blob(parts).arrayBuffer())

  // Un bucle por filtro y fila, sin clausuras. `a` es el byte de la izquierda (0 en los primeros bpp), `b` el
  // de arriba (0 en la fila 0) y `c` el de arriba a la izquierda.
  for (let y = 0, row = 0; y < height; y++, row += stride) {
    const filter = raw[row]
    const first  = row + 1
    const end    = row + stride

    switch (filter) {
      case 0: break
      case 1:
        for (let i = first + bpp; i < end; i++) raw[i] += raw[i - bpp]
        break
      case 2:
        if (y) for (let i = first; i < end; i++) raw[i] += raw[i - stride]
        break
      case 3:
        for (let i = first; i < end; i++)
          raw[i] += ((i < first + bpp ? 0 : raw[i - bpp]) + (y ? raw[i - stride] : 0)) >> 1
        break
      case 4:
        for (let i = first; i < end; i++) {
          const left = i >= first + bpp
          const a    = left ? raw[i - bpp] : 0
          const b    = y ? raw[i - stride] : 0
          const c    = left && y ? raw[i - stride - bpp] : 0
          const pa   = Math.abs(b - c)
          const pb   = Math.abs(a - c)
          const pc   = Math.abs(a + b - 2 * c)

          raw[i] += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        }
        break
      default: throw new Error(`PNG con el filtro ${filter} en la fila ${y}`)
    }
  }

  return heightsOf({ width, height, data: raw, offset: 1, stride, bpp }, encoding)
}
