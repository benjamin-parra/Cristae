// Corpus feliz del lector de GeoJSON: documentos que el contrato (SPECS §17) acepta sin reservas.
//
// El orden es de menor a mayor compromiso estructural -- primero los siete tipos del RFC 7946 uno
// por uno, despues los envoltorios de raiz, y al final los casos que obligan a existir al nivel
// "parte" y a los rangos perezosos. Un oraculo roto suele romperse en el archivo mas chico que lo
// cubre, y buscar ahi primero ahorra el resto de la lista.
//
// Los 15 documentos son ASCII puro y con saltos LF a proposito: asi el offset de caracter coincide
// con el offset de BYTE y los rangos de `propAt`/`idAt` se pueden escribir a mano sin recodificar.
// Ninguno lleva `bbox`, ninguno lleva posiciones 3D (`z` sale null en los 15) y todos los anillos
// cumplen §3.1.6 (cerrados, >= 4 posiciones) y la regla de la mano derecha: exterior antihorario,
// hoyos horarios. Es decir: `stats` no debe contar ni una violacion en toda la categoria.

export const casos = [
  {
    archivo: '01-punto.geojson',
    clausula: '§17.1, §17.3-1',
    prueba: 'Point: la cadena CSR de cuatro niveles completa con un unico vertice.',
  },
  {
    archivo: '02-multipunto.geojson',
    clausula: '§17.1, §17.3-1, §17.6',
    prueba: 'MultiPoint de 3 posiciones: comparte profundidad 2 con LineString y solo `type` los separa.',
  },
  {
    archivo: '03-linea.geojson',
    clausula: '§17.1, §17.3-1',
    prueba: 'LineString abierta de 4 vertices: mismo anidamiento que MultiPoint, `kinds` distinto y `closed` en 0.',
  },
  {
    archivo: '04-multilinea.geojson',
    clausula: '§17.1, §17.3-1',
    prueba: 'MultiLineString de 2 lineas de largo distinto: comparte profundidad 3 con Polygon.',
  },
  {
    archivo: '05-poligono.geojson',
    clausula: '§17.1, §17.6',
    prueba: 'Polygon sin hoyos con el anillo explicitamente cerrado del RFC: `closed[0] === 1`.',
  },
  {
    archivo: '06-multipoligono.geojson',
    clausula: '§17.1',
    prueba: 'MultiPolygon de 2 poligonos sin hoyos: dos partes de un anillo cada una.',
  },
  {
    archivo: '07-coleccion-geometrias.geojson',
    clausula: '§17.1',
    prueba: 'GeometryCollection Point+LineString+Polygon: se aplana a 3 geometrias del mismo feature.',
  },
  {
    archivo: '08-feature-collection.geojson',
    clausula: '§17.1',
    prueba: 'FeatureCollection de 2 features: `geometryAt` avanza feature por feature y `featureOf` es la inversa.',
  },
  {
    archivo: '09-feature-suelto.geojson',
    clausula: '§17.1, §17.3-9',
    prueba: 'Feature suelto en la raiz, sin FeatureCollection que lo envuelva.',
  },
  {
    archivo: '10-geometria-suelta.geojson',
    clausula: '§17.1, §17.3-9',
    prueba: 'Geometria suelta en la raiz: no hay objeto envolvente del que tomar properties ni id.',
  },
  {
    archivo: '11-poligono-un-hoyo.geojson',
    clausula: '§17.1, §17.6',
    prueba: 'Polygon con un hoyo: dos anillos bajo la MISMA parte, exterior antihorario y hoyo horario.',
  },
  {
    archivo: '12-poligono-dos-hoyos.geojson',
    clausula: '§17.1, §17.6',
    prueba: 'Polygon con dos hoyos: `ringAt` de un solo tramo de largo 3, para que un hoyo no se lea como parte.',
  },
  {
    archivo: '13-multipoligono-hoyo-y-sin-hoyo.geojson',
    clausula: '§17.1',
    prueba: 'El caso que justifica el nivel parte: 3 anillos donde el 1 es hoyo del poligono 0 y el 2 es exterior del 1.',
  },
  {
    archivo: '14-features-tipos-distintos.geojson',
    clausula: '§17.1, §17.3-1, §17.3-3',
    prueba: 'Point + LineString + Polygon con hoyo en un mismo documento: `kinds` no se contagia entre features.',
  },
  {
    archivo: '15-properties-e-id.geojson',
    clausula: '§17.2, §17.3-9, §17.4',
    prueba: 'properties e id en los dos features, uno con la geometria antes y otro despues: rangos de byte perezosos.',
  },
]

// Resolver contra `import.meta.url` y no contra el cwd: los tests se corren tanto desde la raiz del
// repo como desde test/, y un path relativo al cwd falla en uno de los dos casos.
export const rutaDe = archivo => new URL(archivo, import.meta.url)

export default casos
