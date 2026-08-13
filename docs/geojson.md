# GeoJSON — `readGeoJson`, la vista CSR, los rangos perezosos

> Pieza de [Cristae](../MODELO.md). Entry propio (`cristae/geojson`): **no** importa el motor, el
> [Source](./data.md) ni Leaflet, y nada del resto de la librería lo importa a él. Sirve suelto en
> Node o en un worker. Contrato normativo en [SPECS §17](../SPECS.md).

`readGeoJson` lee coordenadas de un documento GeoJSON **desde los bytes**, en una pasada, y las deja
en arrays tipados. No construye el grafo intermedio de `JSON.parse`: nunca existen los millones de
`Array(2)` de un `coordinates`, así que tampoco existe la basura que hay que recoger después.

Es un **lector de coordenadas**, no un parser de JSON de propósito general. Reconoce las ocho claves
del RFC 7946 y atraviesa todo lo demás sin interpretarlo.

---

## La idea central: el costo del formato no es parsear, es retener

Medido sobre este repo: parsear los bytes es el 31 % del alta a 8M vértices; **asignar el grafo es el
69 %**. Y ese grafo no se paga una vez — queda vivo, y cada Mark-Compact vuelve a recorrerlo. Con la
geometría en cinco `TypedArray` el heap retenido cae a 1/73 del que retiene el grafo equivalente.

De ahí sale el reparto: el lector produce **geometría**, y de `properties` produce **rangos de byte**.
Los atributos casi nunca se leen todos —una capa pinta 8.000 geocercas y muestra la ficha de una— así
que interpretarlos por adelantado es pagar el 100 % para usar el 0,01 %.

| Path | Cuándo | Costo | Mecanismo |
|---|---|---|---|
| **lectura** | `readGeoJson(bytes)` | O(bytes) tiempo · O(v) memoria | una pasada; el número exacto sin `parseFloat` |
| **camino exacto** | mantisa < 2^53 y potencia de diez exacta | un `imul` + una división | cubre el 85 % de lo que emite `JSON.stringify` |
| **respaldo exacto** | mantisa ≥ 2^53, ≤31 dígitos, sin exponente | segundo limbo + Dekker, en el mismo barrido | exacto, sin asignar, sin `BigInt` |
| **delegación** | más de ~31 dígitos, o exponente | `Number(...)` sobre el fragmento | exacto por el estándar; asigna una string corta |
| **respaldo lento** | notación con exponente, o más de 22 decimales | `TextDecoder` + `Number(...)` | se cuenta en `stats.slowNumbers` |
| **atributos** | `propertiesOf(f)` | O(largo del fragmento) | `JSON.parse` del rango, bajo demanda, **sin cachear** |

---

## Los cuatro niveles

La salida es una cadena CSR de cuatro tablas de offsets. Cada nivel existe porque hay una pertenencia
que preservar; ninguno es decorativo:

```
feature ──geometryAt──▶ geometría ──partAt──▶ parte ──ringAt──▶ anillo ──vertexAt──▶ vértice
```

- **geometría** — un feature puede tener varias: `GeometryCollection` **no sobrevive**, se aplana en
  recorrido en profundidad y `featureOf` ata cada hoja a su feature.
- **parte** — una sub-geometría. Es lo que distingue las N líneas de un `MultiLineString` (N partes)
  de los N anillos de un `Polygon` (1 parte, N anillos): meterlas en una parte diría que son los
  anillos de un mismo polígono.
- **anillo** — la unidad de render y de hit-test.

`MultiPoint` es la única excepción: 1 parte, 1 anillo, N vértices. Un punto no tiene interior, así que
entre sus posiciones no hay pertenencia que preservar y subdividir sólo multiplicaría las tablas en el
perfil de capa más común.

El ascenso inverso (`partOf`, `geometryOf`, `featureOfRing`) es `upperBound(a, x) - 1`, **nunca**
`lowerBound`: las tablas tienen entradas repetidas por diseño —una geometría vacía sale con 0 partes—
y el dueño de `x` es el único `i` con `a[i] <= x < a[i+1]`.

---

## Uso

```js
import { readGeoJson, GeoJsonKind } from 'cristae/geojson'

const geo = readGeoJson(await (await fetch(url)).arrayBuffer(), { bounds: true })

geo.eachRing((ring, first, count) => {
  // xy[2i] = lng, xy[2i+1] = lat — orden RFC, sin invertir
  drawRing(geo.xy, first, count, geo.closed[ring])
})

// Los atributos se pagan cuando se tocan, no al leer.
const f = geo.featureOfRing(ringClickeado)
mostrarFicha(geo.propertiesOf(f))

// Sólo la geometría sobrevive: los bytes se sueltan y `propertiesOf` deja de servir.
geo.release()
```

`xy` está en **grados y en orden RFC** (`[lng, lat]`): el lector no proyecta ni invierte. Proyectar es
del render, y quien consume esto sin dibujar —un hit-test, un cálculo de área— quiere los grados.

### La selección de área — `areasOf`

Una capa de relleno no dibuja puntos ni líneas: un `Point` no tiene interior y un `LineString` no
cierra. `areasOf(geo)` devuelve **las tablas tal cual —sin copiar un vértice— más los ids de anillo y
de parte de los `Polygon` y `MultiPolygon`**, que es lo que consume la capa de polígonos por su ruta `geometry`:

```js
import { readGeoJson, areasOf } from 'cristae/geojson'

engine.addPolygonLayer({ id: 'geocercas', geometry: areasOf(readGeoJson(bytes)) })
```

Sin ella, un documento mixto sube a la textura vértices que nadie rellena y su índice de hit contesta
sobre una `LineString` como si encerrara algo. Un documento de puros polígonos selecciona todo, y la
selección se puede ignorar. Las dos tablas van juntas: la capa rechaza recibir una sola.

Además devuelve **`owner`: la feature dueña de cada parte**, indexada por id de parte como `ringAt` y
no por posición en la selección. Es la identidad del documento, y es lo que hace que un multipolígono
—varias partes de una misma feature— conteste **una vez** al pickearlo, igual que la ruta de `Source`.
Cuesta una palabra por parte: sobre 50.000 polígonos de 200 vértices son 0,2 MB contra 163 MB de
estado retenido, un 0,12 %. La alternativa sin memoria —resolverlo por búsqueda binaria en cada
consulta— ataría la capa de render al lector y volvería `O(n log n)` cada reestilado.

### Hit-test

`someRing` corta temprano con la semántica nativa de `some`; con `bounds: true` la caja por geometría
descarta el 99 % de los anillos antes de mirar un solo vértice:

```js
const golpe = geo.someRing((ring, first, count) => pip(geo.xy, first, count, lng, lat))
```

---

## Lo que el lector cuenta y NO corrige

`stats` lleva las violaciones que el documento traía: anillos abiertos, anillos de menos de 4
posiciones, la regla de la mano derecha, posiciones con un cuarto número, miembros ajenos. **Corregir
geometría es dominio**, y un lector que "arregla" un anillo al vuelo hace que el bug del productor sea
imposible de ver. `stats.roots > 1` señala una secuencia RFC 8142; `stats.slowNumbers` alto señala un
emisor que escribe en notación científica.

`bbox` se atraviesa sin interpretar en cualquier rol. Para la caja está `bounds`, que sale de los
vértices realmente leídos y no de un miembro que puede mentir.

---

## Errores

Todo lo que sale es un `GeoJsonError` con `code` y `at` (el offset de byte donde se detectó, o `-1`).
Nunca una excepción cruda, nunca una salida parcial en silencio: un documento truncado es
`'truncado'`, uno vacío es `'sintaxis'`, y una geometría que cierra sin `type` reconocible es `'tipo'`
—jamás una geometría adivinada por la profundidad de anidamiento, que es ambigua.

Cuando el documento se parece a otro formato, `hint` lo dice (`'topojson'`, `'esrijson'`): es el
diagnóstico que evita la media hora buscando el bug en el lector. La marca sola no alcanza para
rechazar —`Topology` puede ser una property cualquiera—, así que se cobra al sellar y **sólo si el
documento no entregó ninguna geometría**: un TopoJSON leído como cero features es un mapa en blanco
sin diagnóstico, que es justo lo que esto evita.

---

## Límites

- **No valida el JSON completo.** Reconoce estructura; un documento inválido en una zona que el lector
  atraviesa sin interpretar puede pasar. Lo que promete es no salirse del rango, no colgarse y no
  emitir geometría falsa.
- **No proyecta, no simplifica, no repara.**
- **Sin miembro `properties`, el rango es el objeto entero que envuelve la geometría** —el caso de una
  colección de documentos con `geometry` adentro, donde los atributos son hermanos. Ese `JSON.parse`
  rearma las coordenadas de **ese** feature. Sigue siendo perezoso y por feature, pero es real.
- **`propertiesOf` no cachea.** Llamarlo en un bucle sobre 8.000 features paga 8.000 `JSON.parse`: si
  se necesitan todos, es señal de que el consumidor quería otra cosa.
- **`maxDepth`** (512 por default) es una cota anti-bomba, no un límite del formato: la geometría más
  profunda del RFC anida 4 niveles.
