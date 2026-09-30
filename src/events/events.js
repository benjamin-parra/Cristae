// Máscaras de canal de evento. Un handler declara demanda sobre un canal (click u hover);
// el registro solo resuelve hits para los canales con demanda activa → cero picking ocioso. También los
// niveles de handle que el editor (render/) le informa al árbitro del cursor (engine/): es el módulo
// neutral que comparten los dos lados.

export const EVENT_CLICK = 1
export const EVENT_HOVER = 2
// Click contextual (botón secundario / long-press touch / tecla Menú): DISCRETO como el click
// primario y resuelto por el MISMO pick síncrono (`resolveClick`) — el botón no cambia dónde cae el
// hit, sólo cuál se apretó. NO justifica una sesión de picking de hover (no entra en PICK_CHANNELS).
export const EVENT_SECONDARY = 4

// Canales que justifican una SESIÓN DE PICKING de hover. Además de HOVER (entregar eventos de
// hover), CLICK la justifica para el CURSOR de affordance: una capa clickeable debe mostrar el
// puntero al pasar por encima de sus features —como `.leaflet-interactive` en Leaflet—, aunque el
// consumidor no escuche el canal de hover. Sin esto, una capa solo-click no tendría picking de
// hover y el cursor nunca cambiaría (contradiría el "cursor automático" de SPECS §eventos).
// Ver engine/Interaction (syncHoverDemand / #emitHover) e interaction/LayerRegistry (hasHitForChannels).
export const PICK_CHANNELS = EVENT_CLICK | EVENT_HOVER

// Nivel de handle que un editor le informa al motor, que lo traduce a cursor y, con varios editores, se
// queda con el más fuerte (ver engine/Interaction).
export const HANDLE_NONE = 0
export const HANDLE_OVER = 1   // un handle bajo el puntero
export const HANDLE_HELD = 2   // el gesto tiene uno tomado

// Recorrido en px, medido como |dx| + |dy| desde donde se apretó, desde el que una pulsación ya no es
// quieta: la del mapa deja de ser un click y la de un handle empieza a arrastrarlo. Es la tolerancia de
// click de Leaflet, para que el click que sintetiza la puerta del puntero caiga donde caía el suyo.
export const CLICK_TOLERANCE = 3

// El orden de apilado: más `zIndex` arriba y, con el mismo, el de menor `order`. Negativo si `a` queda por
// encima de `b`, así que ordena top-first. Lo comparten los hits del registro y los participantes de la
// puerta del puntero, que se disputan la misma pulsación.
export const topFirst = (a, b) => b.zIndex - a.zIndex || a.order - b.order

// Tipo de evento → bit de canal (dispatch por tabla en vez de if/else). Los tres sabores de hover
// comparten el canal EVENT_HOVER: 'hover' (estado actual), 'hover:start' y 'hover:end' (deltas).
// Tabla CONSTANTE de módulo (no se reconstruye por llamada) con prototipo nulo: un tipo desconocido
// —incluido el nombre de un método heredado como 'toString'— no resuelve nada y cae en el `?? 0`.
const CHANNEL_OF_EVENT_TYPE = {
  __proto__        : null,
  'click'          : EVENT_CLICK,
  'secondary-click': EVENT_SECONDARY,
  'hover'          : EVENT_HOVER,
  'hover:start'    : EVENT_HOVER,
  'hover:end'      : EVENT_HOVER,
}

export const maskOfEventType = eventType => CHANNEL_OF_EVENT_TYPE[eventType] ?? 0
