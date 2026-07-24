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
