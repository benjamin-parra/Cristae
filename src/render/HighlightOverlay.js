// HighlightOverlay — el PASE DE COMPOSICIÓN SEPARADO para el estado de interacción de una capa de
// puntos (selección / seguimiento / hover). Dibuja un tratamiento por-id (anillo, retículo, …) sobre
// un canvas 2D propio, anclado a la posición VIVA leída del MISMO Source que alimenta la capa GPU —
// SIN tocar el atlas (el ícono base no cambia de variante) y SIN entrar al hot-path de la capa.
//
// Por qué existe: hornear el realce EN la variante del sprite multiplica los tiles del atlas
// (marcador × {sin, seleccionado, seguido} = varios tiles) y ata el tratamiento a la rotación del
// ícono. Sacándolo a un overlay, el realce es un segundo pase O(K) sobre los pocos ids resaltados,
// el ícono base queda en una sola variante, y el tratamiento se dibuja en espacio de pantalla
// (invariante a la rotación del sprite).
//
// Agnóstico (MODELO §16): el core provee el MECANISMO (proyectar + coalescer + limpiar + iterar los
// resaltados); el consumidor provee el DIBUJO (`drawHighlight(ctx, size, key)`) y decide QUIÉN está
// resaltado (`setHighlighted`). El core no conoce "selección"/"seguimiento": las claves son opacas.
//
// Costo: O(K) por redibujo (K = resaltados, típicamente ínfimo), NUNCA O(N) del set completo. El feed
// de alta frecuencia sólo despierta el overlay si un id RESALTADO cambió (gate contra los `dirty` del
// Source), así los ~N puntos que se mueven por tick no lo tocan.
//
// Dependencias inyectadas (el módulo no crea DOM ni conoce Leaflet — el motor le cablea el pane/canvas):
//   source        — CristaeSource: `itemById(id)`, `accessors.positionOf(item)`, `subscribe`,
//                   `moveDirtyIds()`, `dirtyIds()`. Es la MISMA fuente que la capa GPU → sin desincronía.
//   project(lat,lng) → { x, y }   — geográfica → píxel de contenedor (camera.latLngToContainerPoint).
//   ctx           — CanvasRenderingContext2D del overlay.
//   clear()       — limpia el canvas (el caller conoce su tamaño).
//   drawHighlight(ctx, size, key) — dibuja el tratamiento, con el ctx ya trasladado al punto.
//   sizeOf(item)  → number        — tamaño en pantalla del sprite base (px) para escalar el tratamiento.
//   schedule(fn)  — coalescing a un frame (requestAnimationFrame en runtime; síncrono en test).

const EMPTY = new Map()

export function createHighlightOverlay({ source, project, ctx, clear, drawHighlight, sizeOf, schedule }) {
  let highlighted = EMPTY          // Map<id, key> — clave opaca por id resaltado
  let agendado = false             // ya hay un redibujo pedido para este frame

  // Dibuja cada resaltado con un proyector inyectado (la vista viva, o una interpolada en el zoom animado).
  const dibujarCon = proyectar => {
    clear()
    if (!highlighted.size) return
    const byId = source.itemById
    const positionOf = source.accessors.positionOf
    for (const [id, key] of highlighted) {
      const item = byId(id)
      if (item == null) continue
      const p = positionOf(item)
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue
      const { x, y } = proyectar(p.lat, p.lng)
      ctx.save()
      ctx.translate(x, y)
      drawHighlight(ctx, sizeOf(item), key)
      ctx.restore()
    }
  }

  const redibujar = () => { agendado = false; dibujarCon(project) }

  // Coalesce a un solo redibujo por frame. Varias invalidaciones en un tick → un flush.
  const invalidar = () => {
    if (agendado) return
    agendado = true
    schedule(redibujar)
  }

  // El feed sólo importa si tocó a un RESALTADO: intersección contra el set chico, O(min(K, sucios)).
  const alNotificar = () => {
    if (!highlighted.size) return
    if (tocaResaltado(highlighted, source.moveDirtyIds?.()) ||
        tocaResaltado(highlighted, source.dirtyIds?.())) invalidar()
  }
  const unsub = source.subscribe(alNotificar)

  return {
    // Quién está resaltado y con qué clave (Map<id, key>). El consumidor lo deriva de selectedIds/focus.
    setHighlighted(next) { highlighted = next ?? EMPTY; invalidar() },
    // El consumidor cablea acá el pan/zoom del mapa: todo resaltado reproyecta.
    onViewportChange() { if (highlighted.size) invalidar() },
    // Redibujo síncrono e inmediato (montaje / cambio de tema / test).
    redraw: redibujar,
    // Redibujo síncrono a una vista arbitraria (un frame del zoom animado).
    renderAtView(proyectar) { dibujarCon(proyectar) },
    destroy() { unsub?.() },
  }
}

// True si algún id resaltado está en el set de sucios. Itera el conjunto MENOR.
function tocaResaltado(highlighted, sucios) {
  if (!sucios || !sucios.size) return false
  if (highlighted.size <= sucios.size) {
    for (const id of highlighted.keys()) if (sucios.has(id)) return true
    return false
  }
  for (const id of sucios) if (highlighted.has(id)) return true
  return false
}
