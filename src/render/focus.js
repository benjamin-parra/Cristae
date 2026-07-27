// Pliegue del eje focus sobre un feature. El foco es `{ ids, dim }`: `ids` null = sin foco (todo pleno);
// con foco, lo que no está en el set multiplica su opacidad por `dim`. Puro: sin estado ni Leaflet, lo
// comparten las capas nativas (polygon / circle / line / html) para que su rebuild lo aplique solo.

export const focusFactor = ({ ids, dim }, id) => (!ids || ids.has(id) ? 1 : dim)

export const focusedStyle = (style, focus, id) => {
  const k = focusFactor(focus, id)
  return k === 1
    ? style ?? {}
    : { ...style, opacity: (style?.opacity ?? 1) * k, fillOpacity: (style?.fillOpacity ?? 0.2) * k }
}
