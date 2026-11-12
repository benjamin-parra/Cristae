// Tablas de un lector → ítems de capa. Un feature se vuelve UN ítem: sus `properties` más la geometría que
// la capa dibuja, que cuelga de claves Symbol para que no choque con ningún campo del dato ni se vea al
// enumerar el ítem. Las coordenadas del lector son `[lng, lat]`; las capas piden `[lat, lng]`.
//
// La identidad del ítem es el `id` del feature cuando el documento lo trae (el `id` de GeoJSON) y, sólo si
// falta, su índice en el archivo: con ids estables un `refresh` que reordena, agrega o quita features no
// cambia de dueño los popups abiertos ni el seguimiento. `fields.id` o `idOf` mandan sobre los dos.

// Los códigos de `GeoJsonKind` (SPECS §17): los lectores de formatos los comparten en sus tablas.
const POINT = 1, MULTI_POINT = 2, LINE_STRING = 3, MULTI_LINE_STRING = 4, POLYGON = 5, MULTI_POLYGON = 6

export const FEATURE  = Symbol('cristae.feature')
export const POSITION = Symbol('cristae.position')
export const PATH     = Symbol('cristae.path')
export const RINGS    = Symbol('cristae.rings')

// Revisión del ítem: un número de módulo que crece con cada ítem que `itemsOf` arma. Es el `hashOf` de los
// accessors de `url`: un `set` con ids estables y un ítem NUEVO lo marca sucio y la capa lo reescribe; un
// ítem que el refresco conserva (mismo objeto) mantiene su revisión y no se toca. Es numérico para que
// `String()` en los rótulos sirva, a diferencia de un hash por identidad de objeto. Un `hashOf` propio gana.
export const REVISION = Symbol('cristae.revision')
let revision = 0

const idOf   = item => item[FEATURE]
const hashOf = item => item[REVISION]

export const URL_ACCESSORS = {
  point  : { idOf, hashOf, positionOf: item => item[POSITION] },
  line   : { idOf, hashOf, pathOf: item => item[PATH] },
  polygon: { idOf, hashOf, ringsOf: item => item[RINGS] },
}

const isPoint = k => k === POINT || k === MULTI_POINT
const isLine  = k => k === LINE_STRING || k === MULTI_LINE_STRING
const isArea  = k => k === POLYGON || k === MULTI_POLYGON

const MATCH = { point: isPoint, line: isLine, polygon: isArea }

const ring = (read, r) => {
  const { xy, vertexAt } = read
  const out = []
  for (let v = vertexAt[r], to = vertexAt[r + 1]; v < to; v++) out.push([xy[v * 2 + 1], xy[v * 2]])
  return out
}

const propertiesOf = (read, f) => {
  const props = read.propertiesOf(f)
  return props !== null && typeof props === 'object' && !Array.isArray(props) ? props : {}
}

export const itemsOf = (read, kind) => {
  const match = MATCH[kind]
  if (!match) throw new TypeError(`itemsOf: kind desconocido '${kind}'`)
  const { geometryAt, partAt, ringAt, vertexAt, kinds, xy } = read
  const items = []
  let skipped = 0

  for (let f = 0; f < read.featureCount; f++) {
    let position = null, shapes = null
    for (let g = geometryAt[f]; g < geometryAt[f + 1]; g++) {
      if (!match(kinds[g])) continue
      if (kind === 'point') {
        const v = vertexAt[ringAt[partAt[g]]]
        if (v < vertexAt[ringAt[partAt[g + 1]]]) { position = { lat: xy[v * 2 + 1], lng: xy[v * 2] }; break }
        continue
      }
      for (let p = partAt[g]; p < partAt[g + 1]; p++)
        for (let r = ringAt[p]; r < ringAt[p + 1]; r++) (shapes ??= []).push(ring(read, r))
    }

    if (kind === 'point' ? position === null : shapes === null) { skipped++; continue }
    const item = propertiesOf(read, f)
    item[FEATURE] = read.idOf?.(f) ?? f
    item[REVISION] = ++revision
    if (kind === 'point') item[POSITION] = position
    else item[kind === 'line' ? PATH : RINGS] = shapes
    items.push(item)
  }
  return { items, skipped }
}
