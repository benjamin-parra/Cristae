# Formatos — KML, GPX, WKT, WKB, TopoJSON, EsriJSON, Shapefile y FlatGeobuf

> Pieza de [Cristae](../MODELO.md). Entry propio (`cristae/formats`): **no** importa el motor, el
> [Source](./data.md), Leaflet ni `cristae/geojson`. Sirve suelto en Node o en un worker. Contrato
> normativo en [SPECS §19](../SPECS.md).

Cada lector lee su formato **desde los bytes** y deja la geometría en las mismas tablas que
[`readGeoJson`](./geojson.md): feature → geometría → parte → anillo → vértice, en arrays tipados y sin
grafo intermedio. Todo lo que sirve para GeoJSON sirve igual acá: `eachRing`, `featureOfRing`,
`propertiesOf` a demanda, `release` y `areasOf` para la capa de polígonos.

```js
import { readShapefileZip } from 'cristae/formats'
import { areasOf } from 'cristae/geojson'

const read = await readShapefileZip(await (await fetch(url)).arrayBuffer())
engine.addPolygonLayer({ id: 'rodales', geometry: areasOf(read) })
read.propertiesOf(read.featureOfRing(anilloClickeado))   // el registro del .dbf, decodificado al pedirlo
```

| Lector | Entrada | Síncrono |
|---|---|---|
| `readKml(input, options?)` | KML 2.2 | sí |
| `readKmz(bytes, options?)` | KMZ | no: infla el zip |
| `readGpx(input, options?)` | GPX 1.1 y 1.0 | sí |
| `readWkt(input, options?)` | WKT y EWKT, una o más geometrías | sí |
| `readWkb(input, options?)` | WKB y EWKB, en binario o en hex | sí |
| `readTopoJson(input, options?)` | TopoJSON 1.0 | sí |
| `readEsriJson(input, options?)` | FeatureSet, feature o geometría de ArcGIS REST | sí |
| `readShapefile({ shp, dbf?, prj?, cpg? }, options?)` | Shapefile con su `.dbf` | sí |
| `readShapefileZip(bytes, options?)` | Shapefile en un zip | no: infla el zip |
| `readFlatGeobuf(bytes, options?)` | FlatGeobuf 3 | sí |

`input` es un `string`, un `ArrayBuffer` o una vista (`Uint8Array`, `Buffer`); los binarios no aceptan
texto, salvo WKB, que lo toma como hex.

---

## Lo que agrega la lectura

Además de las tablas de GeoJSON, cada lectura trae cuatro campos:

- **`format`**: el lector que leyó.
- **`crs`**: el CRS en que venía la fuente (`'EPSG:32719'`), o `null` si no declaraba ninguno. La
  salida **siempre** está en grados WGS84 `[lng, lat]`: UTM, Web Mercator y los `.prj` de transversa de
  Mercator se pasan a grados al sellar.
- **`layers` y `layerOf`**: las carpetas de KML y los `objects` de TopoJSON son capas con nombre y
  padre, y `layerOf[f]` dice en cuál está cada feature. Los formatos sin contenedores tienen una sola,
  `{ name: null, parent: -1 }`.
- **`warnings`**: avisos no fatales `{ code, detail }`. La lectura siguió, pero hay algo que conviene
  mostrar: hoy, un `.cpg` que no se reconoce. Vacío casi siempre.

```js
const read = readShapefile({ shp, dbf, cpg })
read.warnings.forEach(w => console.warn(`${w.code}: ${w.detail}`))   // codificacion: .cpg "OEM"
```

`stats` suma tres contadores a los de GeoJSON: `skippedGeometries` (curvas, `MultiPatch`, `Model`,
`gx:Track`), `deletedRecords` (registros borrados del `.dbf`, que igual se emiten) y `orphanHoles`
(hoyos sin exterior en Shapefile y EsriJSON). `extraOrdinates` cuenta las posiciones a las que se les
descartó la M o una cuarta ordenada.

## Opciones comunes

- `bounds`, `capacityHint` y `maxDepth`, como en `readGeoJson`. `maxDepth` (512) cubre también el
  anidamiento de WKB y FlatGeobuf.
- `maxBytes` (256 MiB): el tope de lo que la entrada hace crecer, como el inflado de un zip o la
  expansión de arcos de TopoJSON. Pasarlo es `'tope'`.
- `crs`: el CRS de una fuente que no declara el suyo, como código EPSG (`32719`, `'EPSG:32719'`) o WKT1.
  Es lo que necesitan un Shapefile sin `.prj` y el WKT de `ST_AsText`:
  `readWkt(texto, { crs: 32719 })`. Si la fuente declara uno, gana la fuente.

Sin CRS declarado ni pedido, las coordenadas tienen que caber en ±180/±90. Si no caben, la lectura es
`FormatError('crs')`: un Shapefile en UTM sin `.prj` falla con ese diagnóstico, en vez de dibujarse en
el océano.

## Errores y detección

Los lectores lanzan `FormatError`, con `format`, `code`, `at` (offset de byte) y `hint` (a qué formato
se parece la entrada). Los asíncronos rechazan con él. Los códigos son los de `GeoJsonError` más `crs`,
`compresion`, `tope`, `entorno`, `version`, `codificacion` y `dtd`; la tabla está en SPECS §19.2. Lo
leído que no sirve, como el CRS o las capas de un zip, va al final del mensaje.

Si el archivo llega sin una extensión confiable, `detectFormat(bytes)` devuelve `'kml'`, `'kmz'`,
`'gpx'`, `'wkt'`, `'wkb'`, `'topojson'`, `'esrijson'`, `'geojson'`, `'shapefile'`, `'shapefile-zip'`,
`'flatgeobuf'`, `'zip'` o `null`. Los lectores no adivinan: hay que elegir uno.

---

## KML y KMZ

`readKml` lee KML 2.2 (OGC 07-147r2). `readKmz` abre el zip, toma `doc.kml` de la raíz o la primera
entrada `.kml`, y lo lee igual. Su lectura y sus errores llevan `format: 'kmz'`, el mismo nombre que
devuelve `detectFormat`.

- `Point`, `LineString` y `Polygon` se mapean a sus tipos; un `LinearRing` suelto es un `LineString`;
  `MultiGeometry` se aplana.
- `Document` y `Folder` son `layers`.
- `propertiesOf(f)` devuelve `name`, `description`, `styleUrl` y los `Data` y `SimpleData` del
  `ExtendedData`; `idOf(f)` es el `id` del `Placemark`. Los estilos no se leen.
- `Model`, `gx:Track` y los overlays se saltan y se cuentan en `stats`.
- Un `<!DOCTYPE` es `'dtd'`: el lector no resuelve entidades externas.
- `1, 2` (un espacio dentro de la tupla) es `'posicion'` y rechaza el documento.

## GPX

`readGpx` lee GPX 1.1 (y 1.0). Cada `wpt` es un `Point`, cada `rte` un `LineString` y cada `trk` un
`MultiLineString` con una parte por `trkseg`. La elevación va a `z`. `propertiesOf(f)` devuelve
`name`, `cmt`, `desc`, `src`, `type`, `number` y `link`, los que estén.

## WKT y WKB

`readWkt(text)` lee una o más geometrías WKT o EWKT, una por feature. `readWkb(bytes)` lee una
geometría WKB o EWKB, en binario o en el hex que entrega PostGIS. El SRID de EWKT y EWKB fija `crs`; sin
SRID, `options.crs` dice en qué CRS vienen las coordenadas. Las curvas de SQL/MM no se leen.

## TopoJSON

`readTopoJson(bytes, { object })` lee una `Topology`. Cada miembro de `objects` es una capa: si es una
`GeometryCollection`, cada hijo es un feature. Los arcos compartidos se resuelven a coordenadas, sin
intermediario GeoJSON. `object` lee una sola capa. Una topología proyectada se lee con `crs` (por
ejemplo `{ crs: 'EPSG:3857' }`); sin esa opción, las coordenadas tienen que estar en grados.

## EsriJSON

`readEsriJson(bytes)` lee lo que devuelve una consulta de ArcGIS REST: un FeatureSet, un feature o una
geometría. Los anillos de un polígono se agrupan por orientación y contención. `propertiesOf(f)`
devuelve los `attributes`. El CRS sale de `spatialReference`.

## Shapefile

`readShapefile({ shp, dbf?, prj?, cpg? }, options?)` es síncrono; `readShapefileZip(bytes, options?)`,
asíncrono por el inflado. Cada registro del `.shp` es un feature, en orden y sin `.shx`. Un registro
Null es un feature sin geometría.

- **Polígonos.** El archivo los trae como lista plana de anillos: cada anillo horario abre un polígono y
  cada antihorario va al exterior más chico que lo contiene. Un hoyo sin exterior sale como exterior
  propio y suma `stats.orphanHoles`.
- **Z y M.** La Z llena `z`. La M se descarta y suma `stats.extraOrdinates`.
- **Atributos.** `propertiesOf(f)` decodifica el registro del `.dbf`: `C` texto, `N` y `F` número (o
  `null` en blanco), `L` booleano, `D` texto `YYYY-MM-DD`; memo y tipos de FoxPro salen `null`.
- **Codificación del `.dbf`.** `options.encoding`, si no el `.cpg`, si no el language driver, si no
  windows-1252. No se adivina por el contenido. El `.cpg` se entiende en las formas en que lo escriben
  ArcGIS, QGIS y GDAL: `UTF-8` o `65001`; `1252`, `ANSI 1252` o `CP1252`; `88591`, `8859-1` o
  `ISO-8859-1`; los números de página de Big5, GBK, Shift_JIS y EUC-KR; y los nombres que conoce
  `TextDecoder`. La tabla completa está en SPECS §19.15-7.
- **Un `.cpg` que no sirve no frena.** Si no se reconoce, o el entorno no tiene ese decodificador (437
  y 850 no están en `TextDecoder`), la lectura sigue como si no hubiera `.cpg` y deja un aviso
  `'codificacion'` en `warnings`. `options.encoding`, en cambio, lo pide el consumidor: si no se
  reconoce, es `FormatError('entrada')`.
- **CRS.** El `.prj` manda; sin él, `options.crs`.
- **Zip.** Con varios `.shp`, `options.layer` elige uno por su ruta sin extensión. `.dbf`, `.prj` y
  `.cpg` se emparejan por nombre base, sin distinguir mayúsculas en la extensión.

## FlatGeobuf

`readFlatGeobuf(bytes, options?)` lee la versión mayor 3 en orden y salta el índice. El tipo de la
cabecera manda; si es Unknown, manda el de cada feature. Las `GeometryCollection` se aplanan y las
partes de un `MultiPolygon` son sus polígonos. `propertiesOf(f)` devuelve las columnas de la cabecera;
los enteros de 64 bits que no caben exactos en un `number` salen como `bigint`. El CRS sale de
`org` + `code`, de `OGC:CRS84` o del WKT de la cabecera; sin ninguno, manda `options.crs`.

## Límites

- Sólo lectura: los escritores son otro tramo.
- Los CRS soportados son WGS84, SIRGAS sobre GRS80 (como nulo), Web Mercator y transversa de Mercator
  sobre WGS84 o GRS80. Un datum con desplazamiento, como PSAD56 o SAD69, es `'crs'`: transformarlo mal
  desplaza cientos de metros en silencio.
- KMZ y el Shapefile en zip necesitan `DecompressionStream('deflate-raw')`; sin él, `'entorno'`.
