// Las cuatro presentaciones del MISMO documento, para el arnés del §17.8.
//
// Existe porque §17.3-6 normaliza la entrada por TIPO explícito, no por forma: un `ArrayBuffer` se
// toma entero, cualquier `ArrayBufferView` se toma por (buffer, byteOffset, byteLength) y un
// `string` se codifica. Vestir un documento de las cuatro maneras deja al corpus exigir lo único
// que el contrato promete acá: que las cuatro colapsen al mismo rango de bytes y den salidas
// idénticas.
//
// La forma que paga por todas es la pooled. Las otras tres arrancan en el offset 0, así que una
// normalización que tome `.buffer` entero pasa los tres primeros casos y falla sólo el cuarto —
// leyendo memoria de OTRAS asignaciones, que es exactamente lo que después saldría por
// `propertiesOf` (§17.9, fila "propertiesOf devolviendo memoria ajena").
import { Buffer } from 'node:buffer'

// `Buffer.allocUnsafe` sólo reparte pool por debajo de la mitad de `poolSize`; arriba de eso
// devuelve un buffer dedicado, con `byteOffset` 0, y la forma pooled deja de probar lo que dice
// probar sin avisar. Se exporta para que el corpus pueda exigir que sus documentos entren, en vez
// de enterarse el día que un documento creció y el caso más caro se volvió decorativo.
export const LIMITE_POOL = Buffer.poolSize >>> 1

const codificador = new TextEncoder()

// `ignoreBOM: true` no es cosmético: por default el decodificador se COME un EF BB BF inicial. Con
// el default, la forma `string` de un documento con BOM sería un documento DISTINTO de las otras
// tres, y el arnés estaría comparando dos entradas diferentes mientras las llama invariante — la
// clase de test que pasa siempre porque ya no mide nada.
const decodificador = new TextDecoder('utf-8', { ignoreBOM: true })

// Relleno con forma de GeoJSON bueno para la memoria del pool que rodea al documento. Si una
// lectura se sale del rango, la salida trae geometrías de más en lugar de basura ilegible: la causa
// queda escrita en el resultado y no hay que reconstruirla desde un stack trace.
const VENENO = codificador.encode('{"type":"Point","coordinates":[999,999]},')

const relleno = n => Buffer.from(Uint8Array.from({ length: n }, (_, i) => VENENO[i % VENENO.length]))

// La misma regla que se le exige al lector vale acá adentro: el documento de origen puede llegar ya
// pooled (`readFile` de Node devuelve `Buffer`), así que la ventana es (byteOffset, byteLength) y
// nunca el `ArrayBuffer` subyacente. Un arnés que tome el buffer entero fabrica el bug que vino a
// cazar, y lo fabrica en las cuatro formas a la vez.
const copiaExacta = vista =>
  new Uint8Array(vista.buffer.slice(vista.byteOffset, vista.byteOffset + vista.byteLength))

const aBytes = documento => {
  const bytes =
    typeof documento === 'string'    ? codificador.encode(documento)
    : documento instanceof ArrayBuffer ? new Uint8Array(documento.slice(0))
    : ArrayBuffer.isView(documento)  ? copiaExacta(documento)
    : null
  if (bytes === null) throw new TypeError('formasDeEntrada: string | ArrayBuffer | ArrayBufferView')
  return bytes
}

// Los cortes en tercios pueden caer en el medio de una secuencia UTF-8, y es a propósito: `concat`
// junta bytes, no caracteres. Una implementación que sólo funcione con los trozos alineados a
// carácter está decodificando por su cuenta en un lugar donde el contrato habla de bytes.
const enTresTrozos = bytes => {
  const corte = n => Math.floor((bytes.length * n) / 3)
  return [bytes.subarray(0, corte(1)), bytes.subarray(corte(1), corte(2)), bytes.subarray(corte(2))]
    .map(trozo => Buffer.from(trozo))
}

// El cursor del pool es global al proceso: dónde cae una asignación no lo decide este archivo. Se
// pide un trozo antes para correr el cursor y otro después para dejar veneno pegado al final. Si el
// documento igual aterrizó en el offset 0 es porque no había lugar y `allocUnsafe` estrenó pool; el
// intento siguiente ya cae con el cursor corrido, así que dos alcanzan — el tercero es para no
// depender de esa aritmética. Las vistas de veneno no se retienen: los bytes viven en la memoria
// del pool, que el documento mantiene viva, no en la vista que los escribió.
const enElPool = (bytes, intentos = 3) => {
  const trozos = enTresTrozos(bytes)   // los trozos también salen del pool: se piden antes del veneno
  relleno(64)
  const pooled = Buffer.concat(trozos)
  relleno(64)
  return pooled.byteOffset !== 0 || intentos === 1 ? pooled : enElPool(bytes, intentos - 1)
}

export const formasDeEntrada = documento => {
  const bytes = aBytes(documento)
  return {
    texto: decodificador.decode(bytes),
    // §17.3-6 toma el `ArrayBuffer` ENTERO, así que este tiene que medir exactamente el documento:
    // entregar uno más grande no sería otra presentación del mismo documento, sería otro documento.
    arrayBuffer: bytes.slice().buffer,
    uint8Array: bytes.slice(),
    bufferPooled: enElPool(bytes),
  }
}
