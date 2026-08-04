// Los programas de una capa no dependen de su INSTANCIA: el fuente es el mismo entre capas y sólo lo
// parametriza un escalar. Compilar por instancia paga, por cada una, las consultas de
// `COMPILE_STATUS`/`LINK_STATUS`, que son SÍNCRONAS —cruzan el command buffer y esperan al proceso GPU, y
// `LINK_STATUS` fuerza además a completar la compilación diferida—, así que mil geometrías son miles de
// bloqueos del hilo principal antes del primer cuadro. Cachear el binario del driver no las evita.
//
// La caché toma el contexto como clave DÉBIL y no lo referencia de ninguna otra forma: cuando el mapa
// muere —`loseGlContext` libera de una vez todo lo que colgaba del contexto— la entrada entera queda
// recolectable. De ahí que ninguna capa borre un programa al destruirse: no es suyo, vive lo que vive el
// contexto, y volver a entrar en edición sobre el mismo mapa ya no enlaza nada.

const porContexto = new WeakMap()

// `construir` corre UNA vez por (contexto, clave). La clave la compone el llamador con lo único que
// vuelve distinto al fuente, y devuelve junto al programa lo que también es suyo: las ubicaciones de
// uniforme y los uniformes que se fijan con el enlace.
export const programaCompartido = (gl, clave, construir) => {
  const programas = porContexto.get(gl) ?? porContexto.set(gl, new Map()).get(gl)
  programas.has(clave) || programas.set(clave, construir())
  return programas.get(clave)
}
