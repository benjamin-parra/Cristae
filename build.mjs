// Build de Cristae como librería distribuible para proyectos externos.
//
// Por qué un script y no un vite.config: UMD/IIFE en Vite solo soportan UN entry por build, mientras
// ESM soporta multi-entry. Necesitamos los tres entries (core/table/map) en AMBOS formatos, así que
// orquestamos varias corridas de la API de Vite: 1 build ESM (3 entries) + 3 builds UMD (1 c/u).
//
// Todo se bundlea hacia adentro (Leaflet, glify, lit) → self-contained, sin CDN. El resultado vive en
// `dist/cristae/` junto a la app, servido por el mismo hosting estático. Además empaqueta la skill
// (SKILL.md + MODELO/SPECS/docs) y genera llms.txt / llms-full.txt para consumo por agentes.

import { build } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'

const scriptDir = dirname(fileURLToPath(import.meta.url))
// La lib vive aquí mismo: este build es parte de Cristae y se copia junto con la carpeta.
const srcDir = scriptDir
// Proyecto host que dispara el build (cwd al correr `build:lib` o `vite build`) → ahí va el dist.
// Usar cwd en vez de subir N niveles deja el script portable si Cristae se copia a otra ruta/proyecto.
const projectRoot = process.cwd()
const outDir = resolve(projectRoot, 'dist/cristae')

// Entry → archivo. `map` re-exporta el núcleo; `table` no arrastra Leaflet; `core` es solo datos.
const ENTRIES = {
  core:  resolve(srcDir, 'src/data/index.js'),
  table: resolve(srcDir, 'src/table/index.js'),
  map:   resolve(srcDir, 'src/index.js'),
}
const UMD_GLOBALS = { core: 'CristaeCore', table: 'CristaeTable', map: 'CristaeMap' }

// Config común: sin cargar el vite.config de la app (nada de React/Tailwind/aliases), __DEBUG__ fijo en
// producción, y NADA externalizado → todas las deps quedan dentro del bundle.
const baseConfig = (mode) => ({
  configFile: false,
  root: projectRoot,
  publicDir: false,          // no copiar el public/ de la app (theme.css, svgs) dentro de la librería
  logLevel: 'warn',
  define: { __DEBUG__: 'false' },
  // Salida JS ASCII-only: esbuild escapa todo char no-ASCII a `\uXXXX` (Vite por defecto emite utf8).
  // Hace el bundle inmune a cómo se sirva/decodifique al importarlo (charset mal declarado, latin-1,
  // concatenación, `fetch().text()` con decoder no-utf8) → parsea igual en cualquier navegador.
  esbuild: { charset: 'ascii' },
  build: {
    emptyOutDir: false,        // limpiamos `dist/cristae` una sola vez, manualmente, antes de todo
    minify: 'esbuild',
    target: 'es2020',
    cssCodeSplit: false,
    ...mode,
  },
})

async function buildEsm() {
  await build(baseConfig({
    outDir: resolve(outDir, 'esm'),
    lib: {
      entry: ENTRIES,
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
  }))
}

async function buildUmd(name) {
  await build(baseConfig({
    outDir: resolve(outDir, 'umd'),
    rollupOptions: { output: { inlineDynamicImports: true } },   // UMD no code-splittea: glify inline
    lib: {
      entry: ENTRIES[name],
      name: UMD_GLOBALS[name],
      formats: ['umd'],
      fileName: () => `${name}.js`,
    },
  }))
}

// Garantiza bundles JS **ASCII-only**: escapa cualquier char no-ASCII a `\uXXXX` en los `.js` emitidos.
// El `charset:'ascii'` de esbuild no llega de forma confiable al render final de Vite (comentarios y
// literales sobreviven), así que lo forzamos acá. Es seguro: en JS, `\uXXXX` es equivalente al carácter
// en strings, templates, regex, comentarios e identificadores. Se itera por code-unit UTF-16, así los
// pares surrogate (chars astral) se reescriben como sus dos `\u` y se reconstruyen idénticos. Motivo:
// el bundle queda inmune a cómo se sirva/decodifique al importarlo (charset mal declarado, latin-1,
// `fetch().text()` con decoder no-utf8) → parsea igual en cualquier navegador.
async function toAsciiJs() {
  const escape = (s) => s.replace(/[^\x00-\x7F]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase())
  for (const sub of ['esm', 'umd']) {
    const dir = resolve(outDir, sub)
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.js')) continue
      const p = resolve(dir, name)
      const text = await readFile(p, 'utf8')
      const ascii = escape(text)
      if (ascii !== text) await writeFile(p, ascii)
    }
  }
}

// Empaqueta la skill como carpeta autoinstalable (`skill/cristae/`) replicando la estructura de
// archivos `.md` de Cristae → todos los links relativos (./docs/x.md, ../MODELO.md) siguen resolviendo.
async function bundleSkill() {
  const skillRoot = resolve(outDir, 'skill/cristae')
  await mkdir(resolve(skillRoot, 'docs'), { recursive: true })
  await Promise.all([
    cp(resolve(srcDir, 'SKILL.md'), resolve(skillRoot, 'SKILL.md')),
    cp(resolve(srcDir, 'MODELO.md'), resolve(skillRoot, 'MODELO.md')),
    cp(resolve(srcDir, 'SPECS.md'), resolve(skillRoot, 'SPECS.md')),
    cp(resolve(srcDir, 'docs'), resolve(skillRoot, 'docs'), { recursive: true }),
  ])
}

// Demo + smoke test: página declarativa que carga el UMD del mapa vía <script> clásico (sin CDN, sin
// módulos) y dibuja puntos WebGL. El banner de estado refleja `cristae:ready` o cualquier error de
// runtime → sirve para verificación headless y como ejemplo "abrir esto y funciona" para externos.
async function generateExample() {
  const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cristae — ejemplo (UMD)</title>
  <style>html,body{margin:0;height:100%} #app{height:100vh}
    #status{position:absolute;top:8px;left:8px;z-index:2000;padding:6px 12px;border-radius:6px;
      font:600 14px system-ui,sans-serif;color:#fff;background:#888}</style>
</head>
<body>
  <div id="status">cargando…</div>
  <div id="app">
    <cristae-map initial-center="-35.5,-71.5" initial-zoom="5" style="width:100%;height:100%">
      <cristae-point-layer id="fleet" interactive></cristae-point-layer>
    </cristae-map>
  </div>

  <script src="umd/map.js"></script>
  <script>
    const status = document.querySelector('#status')
    const fail = msg => { status.textContent = msg; status.style.background = '#e11' }
    window.addEventListener('error', e => fail('✗ ERROR: ' + e.message))
    window.addEventListener('unhandledrejection', e => fail('✗ REJECT: ' + (e.reason?.message || e.reason)))
    try {
      const { createSource, defineIconSet } = CristaeMap
      const map = document.querySelector('cristae-map')
      const fleet = document.querySelector('#fleet')

      map.tile = { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, attribution: '© OSM' }

      const source = createSource({ idOf: m => m.id, positionOf: m => ({ lat: m.lat, lng: m.lng }), variantOf: m => m.estado })
      fleet.iconSet = defineIconSet({
        variants: ['activo', 'alerta'], sizes: { default: 18 },
        describe: v => ({ shape: 'dot', color: v === 'alerta' ? '#e11' : '#1a8' }),
        renderers: { dot: (ctx, s, d) => { ctx.fillStyle = d.color; ctx.beginPath(); ctx.arc(s/2, s/2, s*0.42, 0, 7); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke() } },
      })
      fleet.source = source

      const PTS = [
        { id: 1, lat: -33.45, lng: -70.66, estado: 'activo' }, { id: 2, lat: -33.05, lng: -71.62, estado: 'activo' },
        { id: 3, lat: -36.82, lng: -73.05, estado: 'alerta' }, { id: 4, lat: -29.90, lng: -71.25, estado: 'activo' },
        { id: 5, lat: -38.74, lng: -72.59, estado: 'activo' }, { id: 6, lat: -23.65, lng: -70.40, estado: 'alerta' },
        { id: 7, lat: -41.47, lng: -72.94, estado: 'activo' }, { id: 8, lat: -34.17, lng: -70.74, estado: 'activo' },
        { id: 9, lat: -35.43, lng: -71.65, estado: 'activo' }, { id: 10, lat: -18.48, lng: -70.31, estado: 'alerta' },
      ]
      source.set(PTS)

      // ready robusto: el evento puede emitirse antes de enganchar el listener (el bundle resuelve
      // glify al instante), así que también esperamos el promise map.ready. Idempotente.
      const onReady = () => {
        if (window.__SMOKE_OK__) return
        window.__SMOKE_OK__ = true
        status.textContent = '✓ READY — ' + PTS.length + ' puntos'
        status.style.background = '#1a8'
      }
      map.addEventListener('cristae:ready', onReady)
      map.ready?.then(onReady)
    } catch (err) { status.textContent = '✗ THROW: ' + err.message; status.style.background = '#e11' }
  </script>
</body>
</html>
`
  await writeFile(resolve(outDir, 'example.html'), html)
}

async function generateLlmsTxt() {
  const docFiles = (await readdir(resolve(srcDir, 'docs'))).filter(f => f.endsWith('.md')).sort()
  const base = 'skill/cristae'

  const index = [
    '# Cristae',
    '',
    '> Leaflet + glify con shaders reescritos (atlas de iconos, rotación, picking GPU) y path',
    '> incremental [0-alloc]. Piel declarativa web component `<cristae-map>` + motor headless',
    '> `MapEngine`. Leaflet y glify viajan dentro del bundle (sin CDN).',
    '',
    'Empieza por **SKILL.md** (instalación + reemplazo de Leaflet/glify paso a paso). MODELO.md es la',
    'arquitectura; SPECS.md el contrato formal e invariantes.',
    '',
    '## Documentación',
    `- [SKILL](${base}/SKILL.md): guía práctica — reemplazar Leaflet/glify, instalación y API mínima`,
    `- [MODELO](${base}/MODELO.md): arquitectura, capas, empaquetado`,
    `- [SPECS](${base}/SPECS.md): contrato Source, optimizaciones e invariantes`,
    ...docFiles.map(f => `- [${f.replace('.md', '')}](${base}/docs/${f})`),
    '',
    '## Builds (self-contained, sin CDN)',
    '- ESM: `esm/map.js`, `esm/table.js`, `esm/core.js`',
    '- UMD: `umd/map.js` (global `CristaeMap`), `umd/table.js`, `umd/core.js`',
    '- Importar el módulo (o cargar el UMD) registra los custom elements `<cristae-*>` por efecto.',
    '',
    '## Reglas e invariantes al usar (no violarlas)',
    '- **`<cristae-map>` ES un `L.Map` (ciclo de vida):** desconectarlo del DOM (`remove`/reparent/',
    '  `innerHTML` en un ancestro) **destruye** el motor y su contexto WebGL. No es un `<div>`',
    '  reposicionable: inserta el layout alrededor del nodo vivo. Al reconectar se re-monta con un motor',
    '  NUEVO → **no caches** `engine`/`camera`/`getLeafletMap()`; lee siempre el getter vivo.',
    '- **Readiness:** antes de montar, `engine`/`camera` son `null`. `await map.ready` es one-shot por',
    '  instancia (cada mapa el suyo); el evento `cristae:ready` se re-emite en cada (re)montaje.',
    '- **La cámara es la vía de viewport:** mueve (`setView/panTo/flyTo/fitBounds/fitToLayer/followPoint`),',
    '  hace zoom (`zoomIn/zoomOut/setZoom`) y proyecta (`latLngToContainerPoint`/inverso, para overlays HTML',
    '  en light DOM). No bajes a `getLeafletMap()` salvo escape real.',
    '- **Atributos vs props:** estructura y escalares (`initial-zoom`, `interactive`, `slot`, `radius`,',
    '  `bind-to`, `icon-set="nombre"`) van en HTML; objetos y funciones (`tile`, `accessors`, `iconSet`,',
    '  `source`/`data`, `items` del toolbar, `textOf`) se asignan por JS.',
    '- **El `source` transporta sus accessors:** con `layer.source` NO setees `layer.accessors`. Ruta',
    '  alterna sin compartir fuente: `layer.accessors` + `layer.data` (la capa posee la Source).',
    '- **`createSource(accessors, variants)`:** `accessors` es el primer arg posicional (no `{accessors}`).',
    '- **El orden de asignación motor⊗config NO importa:** la capa difiere el montaje hasta tener su',
    '  config mínima (source o accessors); no hace falta orquestar el orden de los seteos.',
    '- **`set` es rebuild O(n); no muevas con `set`.** Para mover un punto usa `source.move(id, lat, lng)`',
    '  (O(1)); para parchear varios campos `source.patch(items, dirtyIds)` (O(k)). `set` es solo alta/baja.',
    '- **`describe` del IconSet debe ser total:** para cualquier `variant` posible devuelve un descriptor',
    '  completo, derivándolo de la variante misma (no de una lista con `indexOf`).',
    '- **El contenedor `<cristae-map>` necesita altura explícita** (como Leaflet) o no renderiza.',
    '- **Timing:** lo que necesite el engine ya vivo (items del toolbar, `registerIconSet`) va en el',
    '  evento `cristae:ready` o tras `await map.ready`. Las props objeto seteadas síncronas tras tomar',
    '  la referencia del elemento llegan a tiempo.',
    '- **Una sola instancia de Leaflet por página** (la del bundle); no cargues otra en paralelo.',
    '- **Resize y re-visibilidad se auto-curan:** el `ResizeObserver` interno de `<cristae-map>` redibuja el',
    '  canvas GL en cualquier cambio de tamaño (alto, maximizar columna) **y** al pasar de `display:none` a',
    '  visible (tab panel, modal con el mapa ya montado: el tamaño salta de 0 a N). No montes un',
    '  `ResizeObserver` propio ni llames nada para estos casos. `map.invalidateCanvas()` es solo escape',
    '  hatch manual: motor headless (`MapEngine` sin elemento, sin observer) o volver a visible **sin**',
    '  cambiar de tamaño.',
    '- **Múltiples `<cristae-map>` en la página:** al destruirse uno, los hermanos vivos reciben un reset',
    '  automático de sus capas de puntos — el consumer no hace nada.',
    '',
  ].join('\n')

  await writeFile(resolve(outDir, 'llms.txt'), index)
}

// Construye toda la librería en `dist/cristae/`. Reutilizable: la invoca tanto el script directo
// (`npm run build:lib`) como el plugin de Vite en el build de la app (`vite build`) — ver vite.config.js.
export async function buildCristae() {
  await rm(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
  await mkdir(outDir, { recursive: true })

  await buildEsm()
  for (const name of Object.keys(ENTRIES)) await buildUmd(name)
  await toAsciiJs()                          // garantía ASCII-only sobre los bundles emitidos

  await bundleSkill()
  await generateExample()
  await generateLlmsTxt()

  console.log(`\n✓ Cristae lib + skill + llms.txt → ${outDir}`)
}

// Ejecutado directo (`node scripts/build-cristae.mjs`): corre el build. Importado (vite.config): no.
if (import.meta.url === pathToFileURL(process.argv[1]).href) await buildCristae()
