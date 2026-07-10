// Máscaras de canal de evento. Un handler declara demanda sobre un canal (click u hover);
// el registro solo resuelve hits para los canales con demanda activa → cero picking ocioso.

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
// Ver engine/Interaction (#pickDemand / #emitHover) e interaction/LayerRegistry (hasHitForChannels).
export const PICK_CHANNELS = EVENT_CLICK | EVENT_HOVER

// Tipo de evento → bit de canal. Los tres sabores de hover comparten el canal EVENT_HOVER:
// 'hover' (estado actual), 'hover:start' y 'hover:end' (deltas). Tipo desconocido → 0 (sin demanda).
export const maskOfEventType = (eventType) => {
  if (eventType === 'click') return EVENT_CLICK
  if (eventType === 'secondary-click') return EVENT_SECONDARY
  if (eventType === 'hover' || eventType === 'hover:start' || eventType === 'hover:end') return EVENT_HOVER
  return 0
}
