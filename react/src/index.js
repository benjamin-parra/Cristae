import { createElement } from 'react'
import { useCristaeElement } from './use-cristae-element.js'

export { applyElementProps } from './apply-props.js'
export { useCristaeElement } from './use-cristae-element.js'

// Los eventos del shell Cristae son custom events 'cristae:*' (ver CristaeMap.js del núcleo):
// onViewportChange → 'cristae:viewportchange', onClick → 'cristae:click', onSelect → 'cristae:select'.
const cristaeEvent = (key) => 'cristae:' + key.slice(2).toLowerCase()

// Envuelve un tag <cristae-*> en un componente React. `children` se anida (capas dentro del mapa,
// popup dentro de una capa); el resto de props se aplican por propiedad/atributo/evento (sin reconcile).
const wrap = (tag) => {
  function Cristae({ children, ...props }) {
    const ref = useCristaeElement(props, cristaeEvent)
    return createElement(tag, { ref }, children)
  }
  Cristae.displayName = tag
  return Cristae
}

export const CristaeMap = wrap('cristae-map')
export const CristaePointLayer = wrap('cristae-point-layer')
export const CristaeLineLayer = wrap('cristae-line-layer')
export const CristaePolygonLayer = wrap('cristae-polygon-layer')
export const CristaeHtmlLayer = wrap('cristae-html-layer')
export const CristaeLabelLayer = wrap('cristae-label-layer')
export const CristaeCluster = wrap('cristae-cluster')
export const CristaeOverlay = wrap('cristae-overlay')
export const CristaePopup = wrap('cristae-popup')
export const CristaeToolbar = wrap('cristae-toolbar')
