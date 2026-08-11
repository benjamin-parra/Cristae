// Corpus "degenerados": documentos LEGALES cuyo contenido está vacío o torcido.
//
// Están juntos porque comparten el mismo valor de prueba, y no es la geometría que producen —varios
// no producen ni un vértice—: es el HUECO que dejan en las tablas CSR. Un hueco es una entrada
// repetida (`a[i] === a[i+1]`), y §17.3-8 dice que las tablas las tienen "por diseño". Ese es el
// único material donde el desempate del ascenso (`upperBound - 1`, nunca `lowerBound`) tiene
// consecuencia observable: sobre un documento sin contenedores vacíos las dos búsquedas devuelven
// lo mismo y un lector roto pasa verde. Con un hueco, `lowerBound` devuelve el contenedor VACÍO de
// al lado — y ese es exactamente el error que §17.1 describe: el hoyo atribuido al polígono
// equivocado.
//
// Los tres casos "torcidos" (anillo abierto, anillo corto, mano derecha invertida) existen para
// fijar lo contrario de lo que la intuición pide: §17.3-5 manda CONTAR la violación y no
// corregirla, así que su salida esperada es que las tablas queden IDÉNTICAS a las de un documento
// bien formado. Si el lector agrega el vértice de cierre, invierte el sentido de un anillo o
// descarta un anillo de menos de 4 posiciones, estas fixtures lo delatan; sin ellas, "corregir al
// pasar" es indistinguible de leer bien.
//
// 🔴 Lo que estas fixtures NO pueden verificar: `stats`. §17.3-5, §17.5 y §17.9 escriben ahí, pero
// §17 nunca declara los campos de `GeoJsonStats`. Hasta que el contrato los fije, de los casos
// torcidos sólo es exigible la mitad negativa (las tablas no cambian), no la positiva (el contador
// subió). Está reportado como ambigüedad de la fase 0.

export const categoria = 'degenerados'

// URL absoluta del .geojson. El lector come BYTES UTF-8 (§17.2), así que el arnés lee el archivo
// crudo: pasarlo por `JSON.parse` para volver a serializarlo cambiaría el documento —y con él los
// offsets de byte de `propAt`/`idAt` y del `at` de cualquier `GeoJsonError`.
export const rutaDe = archivo => new URL(archivo, import.meta.url)

export const casos = [
  {
    archivo : 'coordenadas-vacias-cada-tipo.geojson',
    clausula: '§17.9 (fila `"coordinates": []`) · §17.3-3',
    prueba  : 'los 6 tipos con `coordinates: []` —lo que emite ST_AsGeoJSON de una geometría vacía— son legales: 6 geometrías con kind, dueño y 0 partes, no un error de estructura.',
  },
  {
    archivo : 'geometria-nula.geojson',
    clausula: '§17.9 (fila `geometry: null`) · §17.3-8',
    prueba  : 'un feature sin geometría entre dos que sí la tienen: `geometryAt[1] === geometryAt[2]` y la geometría siguiente sigue atada a SU feature (`featureOf[1] === 2`), que es donde `lowerBound` la ataría al feature vacío.',
  },
  {
    archivo : 'coleccion-features-vacia.geojson',
    clausula: '§17.9 (fila "contadores de contenedores vacíos") · §17.3-3',
    prueba  : 'el documento de conteos en cero: todas las tablas quedan en su centinela (`[0]`) o vacías, y la invariante del sellado se verifica con g = 0.',
  },
  {
    archivo : 'poligono-anillo-vacio-intermedio.geojson',
    clausula: '§17.3-8 · §17.1',
    prueba  : 'un anillo vacío entre dos llenos deja `vertexAt` con la entrada repetida (`[0,5,5,10]`): el dueño del vértice 5 es el anillo 2, y con `lowerBound` sería el anillo 1, que no tiene vértices.',
  },
  {
    archivo : 'anillo-no-cerrado.geojson',
    clausula: '§17.3-5 · §17.6 (`closed`)',
    prueba  : 'anillo cuya última posición no repite la primera: el lector cuenta y NO cierra — 4 vértices, no 5, y `closed[0] === 0`.',
  },
  {
    archivo : 'anillo-menos-de-cuatro.geojson',
    clausula: '§17.3-5 · §17.6 (`closed`)',
    prueba  : 'anillo cerrado de 3 posiciones (el mínimo del RFC es 4): se emite tal cual, con `closed[0] === 1`, sin descartarlo ni completarlo.',
  },
  {
    archivo : 'anillo-mano-derecha-invertida.geojson',
    clausula: '§17.3-5',
    prueba  : 'exterior horario y hoyo antihorario, los dos al revés del RFC: las tablas salen idénticas a las de un polígono bien orientado — corregir el sentido es dominio, no lectura.',
  },
  {
    archivo : 'linea-de-dos-posiciones.geojson',
    clausula: '§17.1 · §17.3-1',
    prueba  : 'la LineString más corta que admite el RFC: 1 parte, 1 anillo, 2 vértices y `closed[0] === 0` — el piso de la cadena CSR para una geometría de una sola secuencia.',
  },
  {
    archivo : 'multipunto-de-un-punto.geojson',
    clausula: '§17.3-1 · §17.6 (Point/MultiPoint sin RingStore)',
    prueba  : 'MultiPoint de una sola posición: el kind lo fija `type` (§17.3-1) y no la forma —es indistinguible de un Point envuelto— y su único anillo de 1 vértice deja al descubierto que `closed` no está definido para ese tamaño.',
  },
  {
    archivo : 'todo-vacio.geojson',
    clausula: '§17.9 (filas `geometry: null` y `"coordinates": []`) · §17.1 · §17.3-8',
    prueba  : 'cuatro formas distintas de estar vacío en un mismo documento (null, GeometryCollection sin geometrías, y dos `coordinates: []`): `geometryAt` arranca con tres ceros seguidos y el ascenso tiene que seguir cayendo en el feature correcto.',
  },
  {
    archivo : 'contenedor-vacio-anidado.geojson',
    clausula: '§17.3-8 vs. §17.1 — AMBIGUO',
    prueba  : '`[[]]`, `[[]]` y `[[[]]]`: contenedores vacíos que no son `coordinates: []`. Choca la letra de §17.3-8 ("una geometría sin posiciones sale con 0 partes") con el mapeo estructural que exige el anillo-vacío-intermedio; el contrato tiene que elegir una.',
  },
  {
    archivo : 'geometria-vacia-desnuda.geojson',
    clausula: '§17.9 (fila `"coordinates": []`) · §17.4 — AMBIGUO en el nivel feature',
    prueba  : 'la salida literal de `ST_AsGeoJSON`: una geometría sin Feature que la envuelva. La geometría es legal, pero §17 nunca dice cuántos features tiene un documento con raíz de geometría, y `featureOf` exige un dueño.',
  },
  {
    archivo : 'geometria-vacia-entre-llenas.geojson',
    clausula: '§17.3-8 (el caso de la cláusula) · §17.2 (`geometryOf`/`featureOfRing`)',
    prueba  : 'una geometría de 0 partes entre dos de 1: `partAt === [0,1,1,2]` y `geometryOf(1)` tiene que dar 2. Es el desempate del ascenso hecho observable desde la superficie pública, no desde las tablas.',
  },
]

export default casos
