// La fórmula de EPSG:3857 vive en la hoja de proyección; se re-exporta acá para los importadores de render/.
import { projX0, projY0 } from '../projection/mercator.js'
export { MAXLAT, projX0, projY0 } from '../projection/mercator.js'

// La vista de la cámara del anfitrión, escrita en `view`: el zoom, el centro en píxeles world0 —lo que
// esperan las matrices de las capas GPU— y el tamaño del contenedor. `view` es un portador que reusa quien
// lo pasa, porque la vista se lee por frame, y lo consume en el acto.
export const readView = (camera, view) => {
  const c = camera.center()
  const s = camera.size()
  view.zoom     = camera.zoom()
  view.center.x = projX0(c.lng)
  view.center.y = projY0(c.lat)
  view.size.x   = s.x
  view.size.y   = s.y
  return view
}
