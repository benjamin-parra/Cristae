// Servidor del banco. COOP + COEP ponen la página en cross-origin isolation, que es lo que habilita
// `performance.measureUserAgentSpecificMemory()` (memoria real del agente, no una heurística sobre
// `performance.memory`). Ése es el motivo de que el banco no cargue tiles: con COEP puesto, un tile
// de OSM —que no manda CORP— queda bloqueado.
//
// Escotilla `?tiles=1`: el documento pedido con esa query sale SIN las cabeceras, así el basemap
// carga y la escena se puede mirar sobre el mundo real; a cambio se pierde el aislamiento y la
// métrica de memoria degrada a heurística (`crossOriginIsolated === false` lo delata en el JSON).

import { defineConfig } from 'vite'

const AISLAMIENTO = {
  'Cross-Origin-Opener-Policy'   : 'same-origin',
  'Cross-Origin-Embedder-Policy' : 'require-corp',
}

const aislarSalvoConTiles = () => {
  const cabeceras = (req, res, siguiente) => {
    req.url.includes('tiles=1')
      || Object.entries(AISLAMIENTO).forEach(([cabecera, valor]) => res.setHeader(cabecera, valor))
    siguiente()
  }
  // Los dos hooks NO devuelven: `use()` entrega la app de connect —una función— y Vite interpreta
  // cualquier función devuelta como post-hook, que después invoca como si fuera middleware.
  const instalar = servidor => { servidor.middlewares.use(cabeceras) }
  return {
    name                   : 'bench-aislamiento',
    configureServer        : instalar,
    configurePreviewServer : instalar,
  }
}

export default defineConfig({
  // `root` se resuelve contra el CWD, no contra este archivo: correr desde la raíz del repo
  // (`npm run bench` → `vite -c bench/vite.config.js`).
  root    : 'bench',
  plugins : [aislarSalvoConTiles()],
  // El banco importa la librería real desde `../src`, fuera del root servido.
  server  : { fs: { allow: ['..'] } },
})
