// Corpus «lo que el RFC 7946 permite y sorprende».
//
// Ninguno de estos documentos es un caso de error: todos son GeoJSON legal y todos tienen que
// LEERSE. La gracia está en QUÉ sale. Son las formas donde un lector escrito contra el GeoJSON
// «de manual» —type primero, properties siempre presente, un nivel de anidamiento por tipo—
// entrega números correctos con estructura equivocada, que es la falla cara: no revienta, dibuja mal.
//
// CONVENCIÓN DE SEÑUELOS. Toda coordenada real es NEGATIVA (lng ≈ -70/-71, lat ≈ -33/-34) y todo
// número que NO debe llegar a `xy` —bbox, miembros ajenos, geometrías decorativas— es POSITIVO.
// Así una fuga no se busca contando posiciones: un solo valor positivo en `xy` la delata, y el
// oráculo puede afirmarlo sobre TODO el corpus con un predicado, sin tabla por archivo. Las
// altitudes también son positivas, pero viven en `z`, que es un array aparte (§17.3-4).
//
// Los valores dentro de cada documento son únicos entre sí a propósito: un corrimiento de una
// ranura en la cadena CSR se lee de la salida sin cruzar con el archivo.
//
// `clausula` apunta a SPECS.md §17. Los casos con `ambiguo` entran igual al corpus —de hecho
// entran POR ESO—: son los que obligan a cerrar el contrato antes de que exista el lector, que es
// justamente el orden que esta fase defiende.

export const DIRECTORIO = new URL('./', import.meta.url)

export const rutaDe = archivo => new URL(archivo, DIRECTORIO)

export const CASOS_RFC = [
  {
    archivo  : 'tipo-despues-de-coordinates.geojson',
    clausula : '§17.3-2',
    prueba   : 'El RFC §3 declara irrelevante el orden de los miembros: `type` llega después de `coordinates` en las dos geometrías, después de `geometry` en los dos Feature y al final del FeatureCollection. El tipo se fija al CERRAR el objeto, retro-parchando `kinds`.',
  },
  {
    archivo  : 'geometrycollection-plana-mixta.geojson',
    clausula : '§17.1, §17.3-1',
    prueba   : 'Un solo feature con cuatro tipos que la profundidad de anidamiento no distingue (MultiPoint y LineString comparten 2; Polygon aporta el nivel de anillos con hoyo). La GeometryCollection no sobrevive: salen 4 geometrías aplanadas, todas con `featureOf` = 0.',
    ambiguo  : 'El contrato no da la tabla tipo → (partes, anillos): para MultiPoint no se sabe si son N anillos de 1 vértice o 1 anillo de N.',
  },
  {
    archivo  : 'geometrycollection-anidada.geojson',
    clausula : '§17.1',
    prueba   : 'GeometryCollection dentro de GeometryCollection en dos features (legal: el RFC dice SHOULD avoid, no MUST NOT). El aplanado en profundidad es idempotente y `featureOf` sigue atando cada hoja a su feature; el anidamiento no pide un quinto nivel. El GC interior del feature A trae `type` después de `geometries`.',
  },
  {
    archivo  : 'posiciones-3d.geojson',
    clausula : '§17.3-4',
    prueba   : 'Todas las posiciones con altitud. `xy` mantiene stride fijo 2 y la altitud vive en `z`: derivar el conteo con `largo >> 1` sobre el LineString da 4 posiciones donde hay 3, que es la falla que lee la altitud como latitud.',
  },
  {
    archivo  : 'dimension-mixta-en-anillo.geojson',
    clausula : '§17.3-4, §17.6',
    prueba   : 'Posiciones 2D y 3D intercaladas dentro del MISMO anillo exterior —legal— con el hoyo íntegramente 2D: `z` no es null y lleva NaN exactamente donde la posición era 2D, incluido un anillo entero. Ambos anillos vienen explícitamente cerrados (§3.1.6) ⇒ `closed` = 1 en los dos.',
  },
  {
    archivo  : 'bbox-en-tres-niveles.geojson',
    clausula : '§17.3-9, §17.9',
    prueba   : '`bbox` en documento, en feature y en geometría —donde es HERMANO de `coordinates`, antes en la primera y después en la segunda: la trampa clásica del escáner que busca arrays de números. Se descarta en los tres niveles; ningún valor positivo entra a `xy` ni a `z`.',
  },
  {
    archivo  : 'miembros-ajenos-con-numeros.geojson',
    clausula : '§17.3-7, §17.3-9',
    prueba   : 'Miembros ajenos con arrays de números en los cuatro sitios donde el RFC §7.1 los permite: raíz, feature, dentro de properties y dentro del objeto geometría (antes y después de `coordinates`). Ninguno abre una geometría ni aporta vértices.',
  },
  {
    archivo  : 'ids-numerico-y-texto.geojson',
    clausula : '§17.2 (`idOf`), §17.4',
    prueba   : 'El RFC §3.2 admite `id` como string o como número: el primer feature lo trae numérico antes de `geometry`, el segundo de texto después. El rango de bytes de `idAt` tiene que ser un fragmento JSON parseable (las comillas entran). El tercero no trae `id` y trae `properties: null`.',
    ambiguo  : 'No hay centinela definido para un feature sin `id`: qué par escribe `idAt` y qué devuelve (o lanza) `idOf`.',
  },
  {
    archivo  : 'atributos-hermanos-de-geometry.geojson',
    clausula : '§17.4',
    prueba   : 'El caso que decide la cláusula entera: colección de documentos con `geometry` adentro y los atributos como HERMANOS, sin `type: "Feature"` ni `type: "FeatureCollection"`. El rango anotado es el del objeto que ENVUELVE a la geometría; un lector que busque una clave llamada `properties` devuelve vacío justo acá. El tercer documento trae ADEMÁS un miembro llamado `properties`, con contenido distinto del envoltorio, para que las dos lecturas de §17.4 den resultados visiblemente distintos.',
    ambiguo  : 'Si el rango es siempre el del envoltorio, en un Feature RFC estándar `propertiesOf` devuelve el Feature completo (con `geometry` adentro), no el valor de `properties`. §17.1 lo llama «rango de BYTE de properties» y §17.3-9 habla de «capturar properties en el feature»: las dos frases apuntan al miembro. Hay que elegir una.',
  },
  {
    archivo  : 'coordinates-ajeno-en-geometrycollection.geojson',
    clausula : '§17.3-3',
    prueba   : 'El caso que §17.3-3 nombra por su nombre: un `coordinates` como miembro ajeno de una GeometryCollection —legal— que corre la cadena CSR en uno en silencio. El segundo feature es el control con la misma forma sin el miembro ajeno: las dos mitades de la salida tienen que ser estructuralmente idénticas.',
    ambiguo  : 'Está determinado que no se reserva una ranura de geometría, pero no está escrito si los dos números del miembro ajeno entran a `xy`. Se deduce de las formas declaradas (`xy` es [2v], `vertexAt` es [r+1]) que no, y el contrato nunca escribe la invariante `vertexAt[r] === v`.',
  },
  {
    archivo  : 'geometria-dentro-de-miembro-ajeno.geojson',
    clausula : '§17.4 vs §17.3-7',
    prueba   : 'Dos objetos con forma de geometría completa y válida que NO son la geometría del feature: uno dentro de `properties`, otro dentro de un miembro ajeno (`estilo`). La geometría real es el único par negativo.',
    ambiguo  : 'Es la ambigüedad más cara del contrato: cambia `g`, `kinds`, `featureOf` y `xy`. §17.4 prohíbe asumir el nombre del miembro, así que estructuralmente estos objetos son indistinguibles de la geometría real; pero §17.4 también trata `properties` como un rango opaco que no se interpreta, lo que sólo se sostiene si el nombre SÍ se conoce. La salida esperada es 1, 2 o 3 geometrías según cómo se cierre.',
  },
]
