// Pliegue del eje focus sobre un feature. El foco es `{ ids, dim }`: `ids` null = sin foco (todo pleno);
// con foco, lo que no está en el set multiplica su opacidad por `dim`. Puro: sin estado ni import de
// Leaflet, lo comparten las capas nativas (polygon / circle / line / html) para que su rebuild lo aplique
// solo. También es el embudo de los paths de Leaflet: polígonos y círculos sólo se estilan con `pathStyle`.

export const focusFactor = ({ ids, dim }, id) => (!ids || ids.has(id) ? 1 : dim)

export const focusedStyle = (style, focus, id) => {
  const k = focusFactor(focus, id)
  return k === 1
    ? style ?? {}
    : { ...style, opacity: (style?.opacity ?? 1) * k, fillOpacity: (style?.fillOpacity ?? 0.2) * k }
}

// Lo que recibe un path de Leaflet (polígono, círculo) al nacer y en cada `setStyle`: el estilo plegado por
// el foco, con `interactive: false` al final. El picking es por índice, y un path interactivo para Leaflet
// pone su `pointer` encima del cursor del mapa. `setStyle` escribe las opciones igual que el constructor,
// así que la regla va en toda ruta que estile, no sólo en la que construye.
export const pathStyle = (style, focus, id) => ({ ...focusedStyle(style, focus, id), interactive: false })
