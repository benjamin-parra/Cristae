// Decide qué hace un popup ante el TOP hit de una de sus capas `for`. Pura (sin DOM): recibe la
// vista de capa que devuelve `MapEngine.getLayer` y el id del hit, y resuelve el ítem a mostrar.
//
// Una capa `for` sólo puede vincular contenido si resuelve ítems por id, es decir si expone una
// Source con `itemById`. Las capas de puntos / líneas / html la tienen; una capa de POLÍGONOS no
// (es render + hit-test, sin modelo de datos reactivo), así que un `for` que la apunte no puede
// abrir nada. Ese caso se distingue (`'unresolvable'`) para AVISARLO, no para cerrar en silencio.
export const resolvePopupHit = (layer, id) => {
  const source = layer?.source
  if (!source?.itemById) return { action: 'unresolvable' }
  const item = source.itemById(id)
  return item == null ? { action: 'miss' } : { action: 'open', item }
}
