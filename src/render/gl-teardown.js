// Libera el contexto WebGL de una capa GL (glify) al destruirla. `glify.remove()` saca el canvas del
// DOM pero NO libera el contexto → el navegador lo retiene hasta el GC, y como el techo de contextos
// vivos es acotado (~16 por navegador), montar/desmontar capas GL lo agota de forma ACUMULATIVA (no
// por capas concurrentes). `WEBGL_lose_context.loseContext()` lo libera al instante.
//
// Se invoca DESPUÉS de `layer.remove()` (glify hace su teardown sobre un contexto válido) y es a prueba
// de todo: sin capa, sin `gl`, sin la extensión o sin el método → no hace nada (no rompe en entornos
// sin soporte ni en stubs de test).
export const loseGlContext = glifyLayer =>
  glifyLayer?.gl?.getExtension?.('WEBGL_lose_context')?.loseContext?.()

// Cancela el redibujo que glify dejó agendado. Su `redraw()` difiere el trabajo a un
// requestAnimationFrame y guarda el id en `_frame`, pero su `onRemove` NO lo cancela: si la capa se
// desmonta entre el `redraw()` y ese frame, el callback corre con `_map` ya en null y revienta
// (`Cannot read properties of null (reading 'getSize')`). Se llama ANTES de `remove()`, mientras el
// overlay sigue accesible. A prueba de stubs: sin capa, sin overlay o sin frame pendiente, no hace nada.
export const cancelPendingRedraw = glifyLayer => {
  const overlay = glifyLayer?.layer
  if (overlay?._frame == null) return
  cancelAnimationFrame(overlay._frame)
  overlay._frame = null
}
