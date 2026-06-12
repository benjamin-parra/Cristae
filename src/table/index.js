// Entry point SOLO-tabla. Importarlo registra <cristae-table> y expone su API imperativa SIN
// arrastrar el motor de mapa (Leaflet/glify): `table/` solo depende de `lit` y del contrato Source
// de `data/`. Es la frontera que vuelve trivial el futuro split a `cristae/table` — este archivo
// pasa a ser el `main`/`exports` de ese paquete tal cual.
//
//   import 'cristae/table'                        // registra <cristae-table>
//   import { PagedTable, paginationModel } from 'cristae/table'   // + API imperativa

import { CristaeTable } from './CristaeTable.js'

if (!customElements.get('cristae-table')) customElements.define('cristae-table', CristaeTable)

export { CristaeTable } from './CristaeTable.js'
export { PagedTable } from './PagedTable.js'
export { paginationModel } from './pagination.js'

// Re-export del núcleo: un consumidor de tabla también necesita crear/filtrar una Source. `data/`
// es liviano y sin Leaflet, así que `cristae/table` queda autosuficiente para el caso común.
export { defineSource, createSource, makeFilter, makeListener } from '../data/index.js'
