// El contrato de path, en grados: qué es un punto, qué trae vértices y cuál de los dos encodings —plano
// o anidado— tiene un path. Vive en el núcleo porque `pathOf` es parte del contrato de la Source, que
// suma a un path sin saber quién lo lee; la geometría y las capas leen los puntos con lo mismo. No
// depende de nada.

// Un punto, en grados, tiene cuatro formas: `[lat, lng]` —un array, donde lo que siga, una altura, se
// ignora, o una vista tipada de dos o tres componentes—, `{ lat, lng }`, `{ lat, lon }` y
// `{ latitude, longitude }`. Es un punto si sus dos componentes son números finitos y la latitud cae
// en [-90, 90]: fuera de ahí no hay un lugar, y cada modelo de la Tierra la mediría distinto. No se
// coacciona un string, y un objeto que expone `lat()` como método no es un punto. Una vista tipada más
// larga es un track intercalado, que leído como punto mediría 0: no es un punto, y corta. El orden
// `[lng, lat]` no entra: es un par igual en forma, y en latitudes medias no se distingue.
//
// `coordOf(p, 0)` es la latitud y `coordOf(p, 1)` la longitud de un valor no nulo, leídas en su
// lugar, sin copiar el punto. El lector queda chico a propósito, con las formas objeto aparte: así
// V8 lo inlina entero en los recorridos, y el double de un par no se encajona. Por lo mismo la forma
// se reconoce por `typeof` y no comparando con undefined, y el null lo descarta `isPoint` antes de
// leer: mezclar el double con undefined o con un NaN constante también obliga a encajonarlo, una
// asignación por vértice en los recorridos de volumen.
//
// `isPlace` es la regla sin la forma, sobre la latitud y la longitud ya leídas: la comparten las
// esquinas de una caja, que no llegan como punto. `hasPointShape` es la forma sin la regla: la usa la
// cámara, que no acota la latitud.
const indexable = v => Array.isArray(v) || ArrayBuffer.isView(v)

const objectCoord = (p, axis) =>
  typeof p.lat === 'number' ? (axis ? (typeof p.lng === 'number' ? p.lng : p.lon) : p.lat)
  : axis ? p.longitude : p.latitude

export const coordOf       = (p, axis) => (indexable(p) ? p[axis] : objectCoord(p, axis))
export const isPlace       = (lat, lng) => Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lng)
export const hasPointShape = p => p != null && !(ArrayBuffer.isView(p) && p.length > 3)
export const isPoint       = p => hasPointShape(p) && isPlace(coordOf(p, 0), coordOf(p, 1))

// Un iterable del path es un objeto: un string también se recorre, pero sus caracteres no son
// vértices. Un array se lee en su lugar; otro iterable se materializa antes de leerlo, porque uno de
// un solo uso no se deja leer dos veces. Lo que no es iterable no trae vértices.
export const iterable = v => typeof v === 'object' && !!v?.[Symbol.iterator]
export const listOf   = v => (Array.isArray(v) ? v : iterable(v) ? [...v] : [])

// decide por su lat y su lng, como se lee el punto —lo que siga, una altura o un objeto, no cuenta—:
// si el primero no nulo de los dos es un objeto —un punto en cualquiera de sus formas, aunque venga
// sucio—, el elemento es una parte y el path es anidado; si es un primitivo —un número, aunque sea
// NaN—, es un vértice y el path es plano, y se corta. Otro objeto decide por sí mismo: un punto es un
// vértice, así que un plano de objetos se decide en su primer punto, y otro iterable es una parte,
// que se decide sin abrirla. Saltar lo que no decide (null, un primitivo, `[]`, `[null]`, un objeto
// que no es punto ni iterable) es lo que deja leer un plano cuyo vértice 0 llega sucio, que es como
// llega una fila GPS mala, y un anidado cuya primera parte llega vacía o con un vértice nulo en la
// cabeza. Si nada decide, con algún array el path es anidado: leído como parte, un array sin lat ni
// lng puede traer puntos después y, vacío, no aporta ni corta; leído como vértice, cortaría.
export const isNested = top => {
  const lead = top.find(v => (indexable(v) ? (v[0] ?? v[1]) != null : isPoint(v) || iterable(v)))
  return lead === undefined ? top.some(indexable)
    : indexable(lead) ? typeof (lead[0] ?? lead[1]) === 'object' : !isPoint(lead)
}
