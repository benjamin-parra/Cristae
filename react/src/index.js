import { createElement, forwardRef, useCallback, useLayoutEffect, useRef } from 'react'
import { useCristaeElement } from './use-cristae-element.js'

export { applyElementProps } from './apply-props.js'
export { useCristaeElement } from './use-cristae-element.js'

// Los eventos del shell Cristae son custom events 'cristae:*' (ver CristaeMap.js del núcleo):
// onViewportChange → 'cristae:viewportchange', onClick → 'cristae:click', onSelect → 'cristae:select'.
const cristaeEvent = key => 'cristae:' + key.slice(2).toLowerCase()

// Handlers que NO viajan por el DOM: los publica el BUS del motor (`map.engine.on`), así que ningún
// addEventListener los recibe y su canal no se deriva del nombre de la prop (lleva guiones y dos
// puntos). Tabla por tag — key de la prop → canal del bus; `scoped` filtra el canal por el id de ESA
// capa. En <cristae-map> click/hover NO están: ahí sí hay CustomEvent y los cabla el camino genérico.
const LAYER_BUS = {
  scoped: true,
  channels: {
    onClick:          'click',
    onSecondaryClick: 'secondary-click',
    onHover:          'hover',
    onHoverStart:     'hover:start',
    onHoverEnd:       'hover:end',
  },
}
const BUS = {
  'cristae-map': {
    scoped: false,
    channels: { onSecondaryClick: 'secondary-click', onHoverStart: 'hover:start', onHoverEnd: 'hover:end' },
  },
  'cristae-point-layer':   LAYER_BUS,
  'cristae-line-layer':    LAYER_BUS,
  'cristae-polygon-layer': LAYER_BUS,
  'cristae-html-layer':    LAYER_BUS,
  'cristae-cluster': {
    scoped: false,
    channels: {
      onClusterExpand:  'cluster:expand',
      onClusterUpdate:  'cluster:update',
      onClusterDismiss: 'cluster:dismiss',
      onClusterMarked:  'cluster:marked',
    },
  },
}

// Suscribe al bus del motor los handlers que le corresponden al elemento, y los RE-suscribe en cada
// `cristae:ready`: tras un re-montaje el motor es OTRA instancia y los unsub viejos apuntan al bus
// muerto. Los handlers se leen de un ref → una lambda nueva por render NO rehace la suscripción; lo
// único que la rehace es el set de canales activos, que es lo que gobierna el picking (sin handler
// suscrito, el motor no resuelve ese canal).
const useBusChannels = (ref, handlers, bus) => {
  const latest = useRef(handlers)
  useLayoutEffect(() => { latest.current = handlers })

  const keys = Object.keys(handlers)
  useLayoutEffect(() => {
    const map = ref.current?.closest('cristae-map')
    if (!map || !keys.length) return
    let offs = []
    const wire = () => {
      offs.forEach(off => off())
      // Id de capa: manda el del handle vivo (una capa sin `id` lo auto-genera); antes de montar, el
      // declarado. `null` = canal global, sin filtro (mapa y cluster). `||` y no `??` porque el id
      // ausente del DOM es cadena vacía, y el bus sólo trata `null` como "todas las capas": filtrar
      // por '' no matchea ninguna y la suscripción quedaría muda. Sin id todavía, no se suscribe —
      // el próximo `cristae:ready` reintenta con el handle ya montado.
      const layerId = bus.scoped ? ref.current.controls?.id || ref.current.id : null
      offs = map.engine && (!bus.scoped || layerId)
        ? keys.map(key => map.engine.on(bus.channels[key], layerId, (hits, ev) => latest.current[key]?.(hits, ev)))
        : []
    }
    wire()
    map.addEventListener('cristae:ready', wire)
    return () => { map.removeEventListener('cristae:ready', wire); offs.forEach(off => off()) }
  }, [keys.join('|')])
}

// Envuelve un tag <cristae-*> en un componente React. `children` se anida (capas dentro del mapa,
// popup dentro de una capa); el resto de props se aplican por propiedad/atributo/evento (sin reconcile).
// El `ref` publica el elemento vivo: la puerta a engine/camera (map), al handle `controls` (capas) y a
// los métodos del popup — todo lo imperativo que no es estado declarativo.
const wrap = tag => {
  const bus = BUS[tag]
  const Cristae = forwardRef(function Cristae({ children, ...props }, ref) {
    // Las keys del bus se sacan de las props del elemento: el camino genérico las cablearía como
    // 'cristae:clusterexpand', un evento que nadie despacha.
    const handlers = {}
    bus && Object.keys(bus.channels).forEach(key => {
      typeof props[key] === 'function' && (handlers[key] = props[key])
      delete props[key]
    })
    const el = useCristaeElement(props, cristaeEvent)
    useBusChannels(el, handlers, bus)
    // Un solo callback-ref publica el elemento en los dos destinos: el ref interno del hook (que
    // aplica las props) y el del consumidor, sea objeto o función.
    const attach = useCallback(node => {
      el.current = node
      typeof ref === 'function' ? ref(node) : ref && (ref.current = node)
    }, [ref])
    return createElement(tag, { ref: attach }, children)
  })
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
// El otro entry de la lib: lo registra `import 'cristae/table'` (no lo arrastra `cristae/map`).
export const CristaeTable = wrap('cristae-table')
