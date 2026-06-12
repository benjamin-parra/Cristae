// Entry del NÚCLEO (`cristae/core`). La superficie pública de la capa de datos: las dos
// primitivas de Source (B/C) y los factories de filtro/listener. Cero DOM, cero Leaflet, cero Lit —
// depende de nada. Es la base compartida por `cristae/map` y `cristae/table`.
//
// `Store`/`Emitter` quedan INTERNOS (los posee `createSource`); no se exponen (ver data.md).

export { defineSource, createSource } from './Source.js'
export { makeFilter, makeListener } from './filters.js'
