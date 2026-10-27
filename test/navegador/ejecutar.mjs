// `npm run test:navegador`: los escenarios de contextos WebGL contra un navegador real, fuera de `npm test`.
//
//   node test/navegador/ejecutar.mjs [--motor chromium|shell|firefox|todos] [--escenario a,b-4,c …] [--dist <dir>] [--salida <dir>] [--debug]
//
//   --motor      chromium: /usr/bin/chromium, GL por hardware (ANGLE sobre EGL) y el renderer queda registrado.
//                shell: el headless shell de Playwright, GL por software (SwiftShader).
//                firefox: /usr/bin/firefox por Marionette (Playwright no lo maneja); sólo el montaje y los ajenos.
//   --escenario  uno o varios, separados por coma (sin esto, todos los del motor). Ver escenarios.mjs.
//   --dist       el `dist/cristae` de un build (el que tiene esm/map.js). Por defecto el de la raíz: `npm run build` lo deja ahí.
//   --salida     dónde van las capturas y resultados.json (por defecto test/navegador/salida/, que git ignora).
//
// `playwright-core` es una devDependency. Si no está instalada, PLAYWRIGHT_CORE apunta a una carpeta que contenga
// node_modules/playwright-core (p. ej. la caché de npx). Las variables CRISTAE_CHROMIUM y CRISTAE_FIREFOX cambian los ejecutables.
// Sale con 1 si algún escenario falla. Cada navegador abre una página por escenario, en un contexto nuevo, y la cierra.
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { leerPng } from './png.mjs'
import { lanzarFirefox } from './firefox.mjs'
import { ESCENARIOS } from './escenarios.mjs'

const AQUI = dirname(fileURLToPath(import.meta.url))
const A = { motor: 'chromium', escenario: '', dist: resolve(AQUI, '../../dist/cristae'), salida: resolve(AQUI, 'salida') }
const BANDERAS = new Set(['debug'])
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i].replace(/^--/, '')
  BANDERAS.has(k) ? (A[k] = true) : (A[k] = process.argv[++i])
}
A.dist = resolve(A.dist)
A.salida = resolve(A.salida)
if (!existsSync(`${A.dist}/esm/map.js`)) { console.error(`no hay ${A.dist}/esm/map.js: corré \`npm run build\` o pasá --dist`); process.exit(2) }
mkdirSync(A.salida, { recursive: true })

const cargarPlaywright = async () => {
  try { return await import('playwright-core') } catch {}
  if (!process.env.PLAYWRIGHT_CORE) throw new Error('falta playwright-core: `npm install` o PLAYWRIGHT_CORE=<carpeta con node_modules/playwright-core>')
  return createRequire(`${process.env.PLAYWRIGHT_CORE}/node_modules/`)('playwright-core')
}

// ───────────────────────── servidor ─────────────────────────
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.md': 'text/plain' }
const srv = createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/log') { const p = []; return req.on('data', c => p.push(c)).on('end', () => { A.debug && console.log('  [pagina]', Buffer.concat(p).toString().slice(0, 300)); res.end('ok') }) }
  if (u.pathname === '/favicon.ico') { res.statusCode = 204; return res.end() }
  const m = u.pathname.match(/^\/dist\/(.*)$/)
  const f = m ? `${A.dist}/${decodeURIComponent(m[1])}` : `${AQUI}${u.pathname === '/' ? '/pagina.html' : decodeURIComponent(u.pathname)}`
  if (f.includes('..') || req.method !== 'GET' || !existsSync(f) || /\/salida\//.test(f)) { res.statusCode = 404; return res.end() }
  res.setHeader('content-type', TIPOS[extname(f)] ?? 'application/octet-stream')
  res.setHeader('cache-control', 'no-store')
  res.end(readFileSync(f))
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const URL_PAGINA = `http://127.0.0.1:${srv.address().port}/pagina.html?dist=/dist/`

// ───────────────────────── motores ─────────────────────────
const TOL = 40        // por canal: la composición no es exacta al bit (gestión de color, mezcla en bordes)
const FONDO = [221, 221, 221]
const cerca = (a, b, tol = TOL) => a.every((v, i) => Math.abs(v - b[i]) <= tol)

// Una página abierta con lo que los escenarios necesitan: correr código en ella, capturar y comprobar píxeles.
const interfaz = (motor, base, nombre) => {
  const resultado = { escenario: nombre, motor, checks: [], notas: {}, capturas: [] }
  let n = 0
  const c = {
    motor, resultado,
    nota: (k, v) => { resultado.notas[k] = v },
    comprobar(nombre, ok, detalle) {
      resultado.checks.push({ nombre, ok: !!ok, detalle })
      console.log(`    ${ok ? 'ok  ' : 'FALLA'} ${nombre}${detalle === undefined ? '' : ` :: ${typeof detalle === 'string' ? detalle : JSON.stringify(detalle)}`}`)
      return !!ok
    },
    dormir: ms => new Promise(r => setTimeout(r, ms)),
    ev: base.evaluar,
    async captura(etiqueta, pagina = base) {
      const png = await pagina.captura()
      const archivo = `${motor}-${nombre}-${String(++n).padStart(2, '0')}-${etiqueta}.png`
      writeFileSync(`${A.salida}/${archivo}`, png)
      resultado.capturas.push(archivo)
      return { archivo, ...leerPng(png) }
    },
    // Lee los píxeles de las sondas en una captura. `esperadas` son los ids de las capas que tienen que estar pintadas; las demás se informan.
    async sondear(etiqueta, sondas, esperadas, pagina = base) {
      const img = await c.captura(etiqueta, pagina)
      const filas = sondas.map(s => {
        const px = img.px(s.x, s.y), pintada = s.rgb ? cerca(px, s.rgb) : !cerca(px, FONDO, 10) && !cerca(px, [255, 255, 255], 6)
        return { capa: s.capa, x: s.x, y: s.y, esperado: s.rgb ?? 'no fondo', obtenido: px, pintada, debe: esperadas.has(s.capa) }
      })
      return { archivo: img.archivo, ancho: img.ancho, alto: img.alto, filas, malas: filas.filter(f => f.debe && !f.pintada), pintadas: filas.filter(f => f.pintada).map(f => f.capa), sinPintar: filas.filter(f => !f.pintada).map(f => f.capa) }
    },
  }
  return c
}

const abrirChromium = async (pw, motor) => {
  const args = motor === 'chromium' ? ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  const navegador = await pw.chromium.launch({ headless: true, executablePath: motor === 'chromium' ? (process.env.CRISTAE_CHROMIUM ?? '/usr/bin/chromium') : undefined, args: [...args, '--disable-popup-blocking'] })
  return {
    version: navegador.version(),
    async abrir(nombre) {
      const contexto = await navegador.newContext({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 1 })
      const pagina = await contexto.newPage()
      A.debug && pagina.on('console', m => console.log(`  [consola ${m.type()}]`, m.text().slice(0, 300)))
      pagina.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 300)))
      await pagina.goto(URL_PAGINA)
      await pagina.waitForFunction(() => window.__listo === true)
      const base = {
        evaluar: codigo => pagina.evaluate(`(async () => (${codigo}))()`),
        captura: () => pagina.screenshot({ type: 'png' }),
      }
      const c = interfaz(motor, base, nombre)
      c.pagina = pagina
      // una ventana que el propio JS de la página abre (window.open): su Page y su interfaz de captura
      c.abrirVentana = async () => {
        const [popup] = await Promise.all([pagina.waitForEvent('popup'), pagina.evaluate('__nav.abrirVentana()')])
        await popup.setViewportSize({ width: 700, height: 500 })
        return { pagina: popup, captura: () => popup.screenshot({ type: 'png' }) }
      }
      c.cerrar = () => contexto.close()
      return c
    },
    cerrar: () => navegador.close(),
  }
}

const abrirFirefox = async () => {
  let ff = null, lanzamientos = 0
  return {
    version: null,
    async abrir(nombre) {
      ff?.cerrar()
      ff = await lanzarFirefox({ url: URL_PAGINA, ejecutable: process.env.CRISTAE_FIREFOX ?? '/usr/bin/firefox', puerto: 2830 + ++lanzamientos })   // un puerto por lanzamiento: el Firefox anterior puede estar muriendo
      for (let i = 0; i < 100; i++) { if (await ff.evaluar('window.__listo === true')) break; await new Promise(r => setTimeout(r, 100)) }
      const c = interfaz('firefox', { evaluar: ff.evaluar, captura: ff.captura }, nombre)
      c.version = ff.version
      c.cerrar = async () => { ff.cerrar(); ff = null }
      return c
    },
    cerrar: () => ff?.cerrar(),
  }
}

// ───────────────────────── corrida ─────────────────────────
const motores = A.motor === 'todos' ? ['chromium', 'shell', 'firefox'] : A.motor.split(',')
const pedidos = A.escenario ? A.escenario.split(',') : null
const todos = []
let fallos = 0
for (const motor of motores) {
  const lista = ESCENARIOS.filter(e => e.motores.includes(motor) && (!pedidos || pedidos.includes(e.id)))
  if (!lista.length) continue
  console.log(`\n== ${motor} ==`)
  const nav = motor === 'firefox' ? await abrirFirefox() : await abrirChromium(await cargarPlaywright(), motor)
  for (const e of lista) {
    console.log(`\n  [${e.id}] ${e.titulo}`)
    const c = await nav.abrir(e.id)
    const t0 = Date.now()
    // un escenario colgado no se come el tiempo de los demás: tope de 150 s (el más largo, el ping-pong, dura 45 s)
    let reloj
    const tope = new Promise((_, mal) => { reloj = setTimeout(() => mal(new Error('tope de 150 s: el escenario no terminó')), 150_000) })
    try {
      await Promise.race([tope, (async () => {
        await e.correr(c)
        const est = await c.ev('__nav.estado()').catch(() => null)
        c.nota('renderer', est?.renderer)
        const evs = await c.ev('__nav.eventos()').catch(() => null)
        evs && writeFileSync(`${A.salida}/${motor}-${e.id}-eventos.json`, JSON.stringify(evs))
      })()])
    } catch (err) {
      c.comprobar('el escenario corre sin excepciones', false, String(err?.stack ?? err).slice(0, 600))
    }
    clearTimeout(reloj)
    c.resultado.version = nav.version ?? c.version
    c.resultado.ms = Date.now() - t0
    c.resultado.paso = c.resultado.checks.every(k => k.ok)
    c.resultado.paso || fallos++
    todos.push(c.resultado)
    const archivo = `${A.salida}/resultados-${motores.length > 1 ? 'todos' : motor}.json`
    // un archivo por motor: lo que se corre ahora reemplaza a los mismos escenarios de una corrida anterior y deja los demás
    const previos = existsSync(archivo) ? JSON.parse(readFileSync(archivo, 'utf8')).filter(r => !todos.some(t => t.escenario === r.escenario && t.motor === r.motor)) : []
    writeFileSync(archivo, JSON.stringify([...previos, ...todos], null, 2))
    console.log(`  -> ${c.resultado.paso ? 'PASA' : 'FALLA'} (${(c.resultado.ms / 1000).toFixed(1)} s)`)
    await c.cerrar()
  }
  await nav.cerrar()
}
srv.close()
console.log(`\n${todos.length} escenarios, ${fallos} con fallas`)
process.exit(fallos ? 1 : 0)
