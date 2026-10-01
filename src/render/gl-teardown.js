// Libera el contexto WebGL de un dueño (superficie o sonda) al destruirlo. Sacar el canvas del DOM NO
// libera el contexto → el navegador lo retiene hasta el GC, y como el techo de contextos vivos es
// acotado (~16 por navegador), montar/desmontar capas GL lo agota de forma ACUMULATIVA (no por capas
// concurrentes). `WEBGL_lose_context.loseContext()` lo libera al instante.
//
// Es a prueba de todo: sin dueño, sin `gl`, sin la extensión o sin el método → no hace nada (no rompe
// en entornos sin soporte ni en stubs de test).
export const loseGlContext = owner =>
  owner?.gl?.getExtension?.('WEBGL_lose_context')?.loseContext?.()
