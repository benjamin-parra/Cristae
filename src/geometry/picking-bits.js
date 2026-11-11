// Reparto de los 32 bits del id de picking: objeto (14) y chunk (6) por draw, índice local (12) por
// vértice. Viven acá, y no en render/Picking.js, para que la geometría direccione por (chunk, local) sin
// importar el render; Picking.js los re-exporta.
export const OBJ_BITS   = 14
export const CHUNK_BITS = 6
export const LOCAL_BITS = 12
