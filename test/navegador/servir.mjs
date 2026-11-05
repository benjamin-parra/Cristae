// Servidor estático de la página de test/navegador, sin Playwright: para abrirla a mano o desde otro navegador.
//
//   node test/navegador/servir.mjs [--dist <dir>] [--puerto <n>] [--salida <dir>]
//
//   --dist    el `dist/cristae` de un build (el que tiene esm/map.js). Por defecto el de la raíz.
//   --puerto  por defecto 0: uno libre.
//   --salida  carpeta donde `POST /guardar/<nombre>` escribe lo que la página manda (`__nav.guardar`, `__nav.imagen`). Sin
//             ella, el POST responde 404.
//
// Sirve test/navegador/ (pagina.html en `/`) y el dist en /dist/, con la misma ruta que ejecutar.mjs. Imprime la URL de la
// página y queda escuchando hasta SIGINT o SIGTERM. `?preservar=1` y `?dibujos=1` activan la huella y el
// conteo de dibujos de nav.mjs.
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const AQUI = dirname(fileURLToPath(import.meta.url))
const A    = { dist: resolve(AQUI, '../../dist/cristae'), puerto: '0' }
for (let i = 2; i < process.argv.length; i += 2) A[process.argv[i].replace(/^--/, '')] = process.argv[i + 1]
A.dist = resolve(A.dist)
A.salida && mkdirSync(A.salida = resolve(A.salida), { recursive: true })
if (!existsSync(`${A.dist}/esm/map.js`)) { console.error(`no hay ${A.dist}/esm/map.js: corré \`npm run build\` o pasá --dist`); process.exit(2) }

const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.md': 'text/plain' }
const srv = createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/favicon.ico') { res.statusCode = 204; return res.end() }
  const g = A.salida && req.method === 'POST' && u.pathname.match(/^\/guardar\/([\w.-]+)$/)
  if (g && !g[1].startsWith('.')) {
    const p = []
    return req.on('data', c => p.push(c)).on('end', () => { const b = Buffer.concat(p); writeFileSync(`${A.salida}/${g[1]}`, b); res.end(String(b.length)) })
  }
  const m = u.pathname.match(/^\/dist\/(.*)$/)
  const f = m ? `${A.dist}/${decodeURIComponent(m[1])}` : `${AQUI}${u.pathname === '/' ? '/pagina.html' : decodeURIComponent(u.pathname)}`
  if (f.includes('..') || req.method !== 'GET' || !existsSync(f) || /\/salida\//.test(f)) { res.statusCode = 404; return res.end() }
  res.setHeader('content-type', TIPOS[extname(f)] ?? 'application/octet-stream')
  res.setHeader('cache-control', 'no-store')
  res.end(readFileSync(f))
})
await new Promise(r => srv.listen(Number(A.puerto), '127.0.0.1', r))
console.log(`http://127.0.0.1:${srv.address().port}/pagina.html?dist=/dist/&preservar=1&dibujos=1`)

const cerrar = () => srv.close(() => process.exit(0))
process.on('SIGINT', cerrar)
process.on('SIGTERM', cerrar)
