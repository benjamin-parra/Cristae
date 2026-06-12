// Máscaras de canal de evento. Un handler declara demanda sobre un canal (click u hover);
// el registro solo resuelve hits para los canales con demanda activa → cero picking ocioso.

export const EVENT_CLICK = 1
export const EVENT_HOVER = 2

// Tipo de evento → bit de canal. Los tres sabores de hover comparten el canal EVENT_HOVER:
// 'hover' (estado actual), 'hover:start' y 'hover:end' (deltas). Tipo desconocido → 0 (sin demanda).
export const maskOfEventType = (eventType) => {
  if (eventType === 'click') return EVENT_CLICK
  if (eventType === 'hover' || eventType === 'hover:start' || eventType === 'hover:end') return EVENT_HOVER
  return 0
}
