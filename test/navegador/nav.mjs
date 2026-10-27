// Lado de la página de `npm run test:navegador`: un mapa con la forma del Geotáctico (13 superficies GL: 9 con contenido y 4
// vacías), contextos ajenos que se crean y dibujan como los de Street View, y la instrumentación que cuenta lo que el navegador
// hace con los contextos. El orquestador (ejecutar.mjs) la maneja por `window.__nav`; las capturas de pantalla las toma él.
//
// Cada capa con contenido pinta un color propio en un píxel conocido de la pantalla (SONDAS): el orquestador lo lee de la captura.
// Las posiciones se dan en píxeles del contenedor (1200×760, DPR 1) para la vista inicial y se proyectan a lat/lng, de modo que
// siguen valiendo si la cámara se mueve.
//
// La instrumentación se instala antes de importar el bundle: `getContext` envuelto (cuenta cada contexto nuevo, propio o ajeno),
// los avisos `webglcontextlost`, `surfacechange` del motor, los errores de la página y un contador de cuadros.

const q      = new URLSearchParams(location.search)
const DIST   = q.get('dist') ?? '/dist/'
const ESC    = { w: 1200, h: 760 }
const VISTA  = { lat: -33.45, lng: -70.66, z: 11 }
const ahora  = () => performance.now()
const dormir = ms => new Promise(r => setTimeout(r, ms))

// ───────────────────────── instrumentación ─────────────────────────
const T = { ctx: new Map(), canvas: new WeakMap(), ev: [], errores: [], avisos: [], cuadro: 0, gestos: [] }
let   ajeno = false                    // en true mientras se crea un contexto ajeno: el envoltorio de getContext lo rotula

const ev = (k, datos) => T.ev.push({ t: ahora(), f: T.cuadro, k, ...datos })

// Los canvases de un motor montado en la ventana los crea el JS de la página y los cuelga el motor en otro documento.
const enVentana = canvas => canvas.ownerDocument !== document

const vigilar = (win, ventana) => {
  const proto = win.HTMLCanvasElement.prototype, original = proto.getContext
  proto.getContext = function (tipo, ...r) {
    const gl = original.call(this, tipo, ...r)
    if (!/webgl/.test(String(tipo))) return gl
    if (!gl) return (ev('ctx-fallo', { ajeno }), gl)
    if (T.ctx.has(gl)) return gl
    const n = T.ctx.size + 1, canvas = this, dato = { n, gl, ajeno, canvas }
    T.ctx.set(gl, dato)
    T.renderer ??= (e => e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))(gl.getExtension('WEBGL_debug_renderer_info'))
    T.canvas.set(canvas, gl)
    ev('ctx', { n, ajeno })
    canvas.addEventListener('webglcontextlost', () => ev('perdido', { n, ajeno: dato.ajeno, ventana: enVentana(canvas) ? 'ventana' : 'principal', pane: canvas.parentElement?.className ?? '?' }))
    return gl
  }
  win.addEventListener('error', e => T.errores.push(`${ventana}: ${e.message}`))
  win.addEventListener('unhandledrejection', e => T.errores.push(`${ventana}: ${e.reason?.stack ?? e.reason}`))
  for (const [nivel, lista] of [['error', T.errores], ['warn', T.avisos]]) {
    const o = win.console[nivel]
    win.console[nivel] = function (...a) { lista.push(a.map(String).join(' ').slice(0, 300)); return o.apply(this, a) }
  }
}
vigilar(window, 'principal')

const contar = () => {
  const todos = [...T.ctx.values()], perdido = c => c.gl.isContextLost()
  const de = pred => ({ creados: todos.filter(pred).length, vivos: todos.filter(c => pred(c) && !perdido(c)).length, perdidos: todos.filter(c => pred(c) && perdido(c)).length })
  return { propios: de(c => !c.ajeno), ajenos: de(c => c.ajeno), principal: de(c => !c.ajeno && !enVentana(c.canvas)), ventana: de(c => !c.ajeno && enVentana(c.canvas)) }
}

const tick = () => { T.cuadro++; requestAnimationFrame(tick) }
requestAnimationFrame(tick)

// ───────────────────────── el mapa ─────────────────────────
const COLOR = {
  geo: [0, 166, 80], enlaces: [230, 0, 126], veh: [255, 127, 0], lug: [0, 102, 255], bus: [128, 0, 255], marcas: [0, 200, 200], extremos: [160, 82, 45],
}
const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('')

// Web Mercator de 256 px por tile, la proyección del mapa: del píxel del contenedor a lat/lng y de vuelta.
const merc = (lat, lng, z) => {
  const s = 256 * 2 ** z, sen = Math.sin(lat * Math.PI / 180)
  return { x: (lng + 180) / 360 * s, y: (0.5 - Math.log((1 + sen) / (1 - sen)) / (4 * Math.PI)) * s }
}
const inv = (x, y, z) => {
  const s = 256 * 2 ** z
  return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / s))) * 180 / Math.PI, lng: x / s * 360 - 180 }
}
const aLatLng = (px, py, c = VISTA) => { const o = merc(c.lat, c.lng, c.z); return inv(o.x + px - ESC.w / 2, o.y + py - ESC.h / 2, c.z) }
const aPunto  = (lat, lng, c) => { const o = merc(c.lat, c.lng, c.z), p = merc(lat, lng, c.z); return { x: p.x - o.x + ESC.w / 2, y: p.y - o.y + ESC.h / 2 } }

// Dónde cae cada elemento (píxeles de la vista inicial). Los vehículos sueltos distan más que el radio del cluster (120 px) entre sí
// y de la burbuja; la burbuja son ocho vehículos a 3 px unos de otros.
const PX = {
  veh     : [[600, 120], [780, 120], ...Array.from({ length: 8 }, (_, k) => [940 + (k % 4) * 3, 330 + (k >> 2) * 3])],
  lug     : [[300, 470], [380, 470]],
  bus     : [[560, 470], [640, 470]],
  marcas  : [[430, 640], [490, 640]],
  extremos: [[760, 640], [820, 640]],
  geo     : [[40, 40], [420, 40], [420, 260], [40, 260]],
  enlaces : [[100, 150], [520, 150]],
}
const latlng = ([x, y]) => aLatLng(x, y)

// Lo que la captura tiene que mostrar en cada píxel, con la vista inicial. `capa` es el id de la capa en `surfaces()`.
const SONDAS = [
  { capa: 'geo',      x: 80,  y: 220, rgb: COLOR.geo,      nota: 'polígono, fuera de la línea' },
  { capa: 'enlaces',  x: 250, y: 150, rgb: COLOR.enlaces,  nota: 'línea sobre el polígono: orden de z' },
  { capa: 'veh',      x: 600, y: 120, rgb: COLOR.veh,      nota: 'vehículo suelto del cluster' },
  { capa: 'cluster-3:clusters', x: 940, y: 330, rgb: null,           nota: 'burbuja del cluster: cualquier color que no sea el fondo' },
  { capa: 'lug',      x: 300, y: 470, rgb: COLOR.lug,      nota: 'lugares' },
  { capa: 'bus',      x: 560, y: 470, rgb: COLOR.bus,      nota: 'búsqueda' },
  { capa: 'marcas',   x: 430, y: 640, rgb: COLOR.marcas,   nota: 'marcas del kit' },
  { capa: 'extremos', x: 760, y: 640, rgb: COLOR.extremos, nota: 'extremos de ruta del kit' },
]

const PLANTILLA = animacion => `
<cristae-map id="m" initial-center="${VISTA.lat},${VISTA.lng}" initial-zoom="${VISTA.z}" zoom-animation="${animacion}" style="position:absolute;left:0;top:0;width:${ESC.w}px;height:${ESC.h}px">
  <cristae-polygon-layer id="geo" interactive></cristae-polygon-layer>
  <cristae-cluster id="cl" radius="120" max-zoom="18" min-points="2" dim-rest>
    <cristae-overlay id="ov"><cristae-point-layer id="veh" interactive></cristae-point-layer></cristae-overlay>
  </cristae-cluster>
  <cristae-label-layer id="vehL" bind-to="veh"></cristae-label-layer>
  <cristae-point-layer id="lug" interactive></cristae-point-layer>
  <cristae-label-layer id="lugL" bind-to="lug"></cristae-label-layer>
  <cristae-point-layer id="bus"></cristae-point-layer>
  <cristae-label-layer id="busL" bind-to="bus"></cristae-label-layer>
</cristae-map>`

const VARIANTES = Object.keys(COLOR)
const accesores = variante => ({ idOf: v => v.id, positionOf: v => ({ lat: v.lat, lng: v.lng }), variantOf: () => variante })
const items = (lista, id0) => lista.map((p, i) => ({ id: id0 + i, ...latlng(p) }))

const iconos = mod => mod.defineIconSet({
  variants: VARIANTES, sizes: { default: 20, canvas: 32 },
  describe: v => ({ shape: 'dot', color: hex(COLOR[v] ?? [0, 0, 0]) }),
  renderers: { dot: (ctx, s, d) => { ctx.fillStyle = d.color; ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.4, 0, 7); ctx.fill() } },
})

const VENT = { w: 700, h: 500, puntos: [['v-p1', 150, 250, 'veh'], ['v-p2', 250, 250, 'lug'], ['v-p3', 350, 250, 'bus'], ['v-p4', 450, 250, 'marcas']] }
const N = { compo: [], cadenas: [], capas: {}, mod: null, mapa: null, eng: null, ventana: null, engVentana: null, ajenos: [], iconos: null }
const vista = () => {
  const c = N.eng.camera.getCenter()
  return { lat: c.lat, lng: c.lng, z: N.eng.camera.getZoom() }
}

// Espera a que no haya eventos de contextos durante `ms`, o el `tope`.
const quieto = async (ms = 700, tope = 10_000) => {
  const desde = ahora()
  let   largo = T.ev.length, ultimo = ahora()
  while (ahora() - desde < tope) {
    await dormir(50)
    if (T.ev.length !== largo) { largo = T.ev.length; ultimo = ahora() }
    else if (ahora() - ultimo >= ms) break
  }
  return ahora() - desde
}

const filas = eng => eng?.surfaces() ?? []

// El pane y los hijos de cada pane, en el orden del DOM, con el z-index vigente: lo que tiene que quedar igual al perder y
// recuperar. Sin identidad de nodos (los canvases se reemplazan), sólo su etiqueta y clase.
const instantaneaPanes = raiz => {
  const mp = raiz.querySelector('.leaflet-map-pane')
  return [...mp.children].map(p => ({
    pane: p.className.replace('leaflet-pane ', ''),
    z   : getComputedStyle(p).zIndex,
    hijos: [...p.children].map(h => h.tagName + (h.className ? '.' + String(h.className).replace(/\s+/g, '.') : '')),
  }))
}

// Un ajeno en ping-pong se rehace cada vez que el navegador le quita el contexto: `cadena` cuenta las veces entre todas sus generaciones.
const ajenoNuevo = ({ pingPong = false, tope = 60, cadena = { rehechos: 0, tope: false } } = {}) => {
  const c = document.createElement('canvas')
  c.width = c.height = 32
  document.getElementById('ajenos').appendChild(c)
  ajeno = true
  let gl
  try { gl = c.getContext('webgl2', { stencil: true }) } finally { ajeno = false }
  const a = { i: N.ajenos.length, canvas: c, gl, cadena }
  pingPong && !N.cadenas.includes(cadena) && N.cadenas.push(cadena)
  if (gl) {
    gl.clearColor(1, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.flush()
    a.n = T.ctx.get(gl)?.n
  }
  N.ajenos.push(a)
  pingPong && c.addEventListener('webglcontextlost', () => {
    c.remove()
    cadena.rehechos < tope ? (cadena.rehechos++, setTimeout(() => ajenoNuevo({ pingPong, tope, cadena }), 0)) : (cadena.tope = true)
  })
  return a
}

window.__nav = {
  config: { ESC, VISTA, COLOR },

  async montar({ animacion = 'none' } = {}) {
    const t0 = ahora()
    N.mod = await import(`${DIST}esm/map.js`)
    const { createSource } = N.mod
    N.iconos = iconos(N.mod)
    const escena = document.getElementById('escena')
    escena.innerHTML = PLANTILLA(animacion)
    const $ = id => escena.querySelector('#' + id)
    $('geo').accessors = { idOf: g => g.id, ringsOf: g => g.coords, styleOf: () => ({ color: hex(COLOR.geo), fillColor: hex(COLOR.geo), fillOpacity: 1 }) }
    $('geo').data = [{ id: 1, coords: [PX.geo.map(p => { const l = latlng(p); return [l.lat, l.lng] })] }]
    for (const [id, lista, id0] of [['veh', PX.veh, 0], ['lug', PX.lug, 100], ['bus', PX.bus, 200]]) {
      $(id).iconSet = N.iconos
      const s = createSource(accesores(id), VARIANTES)
      $(id).source = s
      s.set(items(lista, id0))
    }
    $('ov').iconSet = N.iconos
    $('ov').where = () => true
    for (const id of ['vehL', 'lugL', 'busL']) $(id).textOf = v => 'v' + v.id
    N.mapa = $('m')
    await N.mapa.ready
    N.eng = N.mapa.engine
    N.eng.on('surfacechange', d => ev('estado', { capa: d.layerId, estado: d.state, z: d.z, pane: d.pane, necesaria: d.visible && d.hasContent }))
    N.eng.on('interactionstart', () => T.gestos.push({ ini: ahora(), fin: null }))
    N.eng.on('interactionend', () => { const g = T.gestos.at(-1); g && (g.fin = ahora()) })

    // lo que monta el kit del shell por código: bandas de z como las de la app
    const lineas = { idOf: s => s.id, pathOf: s => s.pts, styleOf: s => s }
    const par = ps => ps.map(p => { const l = latlng(p); return [l.lat, l.lng] })
    N.eng.addLineLayer({ id: 'enlaces', z: 614, accessors: lineas, data: [{ id: 1, pts: par(PX.enlaces), color: hex(COLOR.enlaces), weight: 12, opacity: 1 }] })
    N.capas.regla = N.eng.addLineLayer({ id: 'regla', z: 394, accessors: lineas, data: [] })
    N.capas.rutas = N.eng.addLineLayer({ id: 'rutas', z: 395, accessors: lineas, data: [] })
    N.eng.addPointLayer({ id: 'marcas', z: 405, accessors: accesores('marcas'), iconSet: N.iconos, data: items(PX.marcas, 300) })
    N.eng.addPointLayer({ id: 'extremos', z: 406, accessors: accesores('extremos'), iconSet: N.iconos, data: items(PX.extremos, 400) })
    N.eng.addHtmlLayer({ id: 'hitos', pane: 'cristae-ruta-620', z: 620, accessors: { idOf: h => h.id, positionOf: h => ({ lat: h.lat, lng: h.lng }), htmlOf: () => '<b>I</b>' }, data: items([[100, 700]], 500) })
    const montaje = ahora() - t0
    const sincrono = { ...contar(), filas: filas(N.eng) }
    // las capas que nacieron vacías toman su contexto en ratos ociosos, de a una: se espera a que no quede ninguna sin tomarlo
    while (ahora() - t0 < 12_000 && filas(N.eng).some(f => f.state === 'none')) await dormir(20)
    await quieto()
    return { montajeMs: Math.round(montaje), alMontar: sincrono, ...this.estado() }
  },

  estado: () => ({
    cuadro: T.cuadro, ...contar(), filas: filas(N.eng), filasVentana: filas(N.engVentana), errores: [...T.errores], avisos: [...T.avisos],
    renderer: T.renderer ?? null,
  }),

  quieto,
  ahora,
  // ms por cuadro de la página, para medir cuánto es «k cuadros»
  async cadencia(n = 20) {
    const f0 = T.cuadro, t0 = ahora()
    while (T.cuadro - f0 < n && ahora() - t0 < 10_000) await dormir(5)
    return (ahora() - t0) / Math.max(1, T.cuadro - f0)
  },
  cuadro: () => T.cuadro,
  eventos: desde => T.ev.slice(desde ?? 0),
  nEventos: () => T.ev.length,
  gestos: () => T.gestos,
  marca: etiqueta => ev('marca', { etiqueta }),

  // Las sondas proyectadas a la vista actual; las que quedan fuera del contenedor no se piden.
  sondas() {
    const c = vista()
    return SONDAS.map(s => {
      const l = aLatLng(s.x, s.y), p = aPunto(l.lat, l.lng, c)
      return { ...s, x: Math.round(p.x), y: Math.round(p.y) }
    }).filter(s => s.x >= 0 && s.y >= 0 && s.x < ESC.w && s.y < ESC.h)
  },

  paneSnapshot: () => JSON.stringify(instantaneaPanes(N.mapa.shadowRoot)),
  paneSnapshotVentana: () => JSON.stringify(instantaneaPanes(N.ventana.document.querySelector('#mapa-v'))),

  ajeno: opciones => { const a = ajenoNuevo(opciones); return { i: a.i, ok: !!a.gl, n: a.n } },

  // Crea `n` ajenos, cada uno en su tarea y con `entre` ms de por medio, como un widget que va tomando contextos.
  async ajenos(n, { entre = 80, ...opciones } = {}) {
    for (let k = 0; k < n; k++) { ajenoNuevo(opciones); await dormir(entre) }
    return N.ajenos.length
  },

  // Quita los ajenos (cierra un widget): sus contextos se sueltan y el motor recibe la señal de cupo.
  soltarAjenos() {
    N.cadenas.forEach(k => { k.rehechos = Infinity })
    N.ajenos.forEach(a => { a.canvas.remove(); a.gl?.getExtension('WEBGL_lose_context')?.loseContext() })
    const n = N.ajenos.length
    N.ajenos = []
    return n
  },
  pingPong: () => N.cadenas.map(k => ({ rehechos: k.rehechos, tope: k.tope })),

  // La GPU quita el contexto de estas capas a la vez (un reinicio): `loseContext` sobre el canvas vivo de cada pane.
  perder(capas, eng = 'principal') {
    const motor = eng === 'principal' ? N.eng : N.engVentana, raiz = eng === 'principal' ? N.mapa.shadowRoot : N.ventana.document.querySelector('#mapa-v')
    const hechas = []
    for (const f of filas(motor)) {
      if (!capas.includes(f.layerId) || f.state !== 'live') continue
      const canvas = [...raiz.querySelectorAll(`.leaflet-${f.pane}-pane canvas`)].find(c => { const gl = T.canvas.get(c); return gl && !gl.isContextLost() })
      const gl = canvas && T.canvas.get(canvas)
      gl && (gl.getExtension('WEBGL_lose_context').loseContext(), hechas.push(f.layerId))
    }
    return hechas
  },

  // Lo que cuesta vaciar la cola de los contextos propios vivos (el `flush` dirigido de la política), por llamada: cinco rondas de
  // `ms` ms cada una, tomando la mediana. Acotado por tiempo, no por cantidad: en un navegador con la composición por software una
  // llamada puede costar milisegundos.
  flushCosto({ ms = 200, tope = 4000 } = {}) {
    const gls = [...T.ctx.values()].filter(c => !c.ajeno && !c.gl.isContextLost()).map(c => c.gl), t0 = ahora()
    const ronda = () => {
      const a = ahora()
      let n = 0
      while (ahora() - a < ms) for (const gl of gls) { gl.flush(); n++; if (ahora() - a >= ms) break }
      return (ahora() - a) / n * 1000
    }
    const m = []
    for (let i = 0; i < 5 && ahora() - t0 < tope; i++) m.push(ronda())
    m.sort((x, y) => x - y)
    return { contextos: gls.length, rondas: m.length, usPorFlush: m[m.length >> 1], min: m[0], max: m.at(-1), totalMs: ahora() - t0 }
  },

  // ¿La composición de un canvas visible renueva el orden de desalojo? Contextos simples, visibles, sin Cristae de por medio.
  compo: {
    crear(n) {
      let host = document.getElementById('compo')
      host || (host = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'compo' })), host.style.cssText = 'position:fixed;left:0;top:0;width:700px;height:80px;z-index:5')
      for (let i = 0; i < n; i++) {
        const c = document.createElement('canvas')
        c.width = c.height = 40
        c.style.cssText = 'width:40px;height:40px;margin:2px'
        host.appendChild(c)
        const gl = c.getContext('webgl2')
        gl.clearColor(i / 20, 0.5, 0.5, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.flush()
        N.compo.push({ canvas: c, gl, i: N.compo.length })
      }
      return N.compo.length
    },
    // Dibuja en el contexto `i` sin vaciar la cola: sólo la composición puede presentarlo.
    pintar(i, tono) { const { gl } = N.compo[i]; gl.clearColor(tono, 0.2, 0.8, 1); gl.clear(gl.COLOR_BUFFER_BIT) },
    vaciar(i) { N.compo[i].gl.flush() },
    perdidos: () => N.compo.filter(e => e.gl.isContextLost()).map(e => e.i),
  },
  // Muestra una capa y, en la MISMA tarea, lee su estado y el píxel (x, y) de su canvas: con `preserveDrawingBuffer` apagado el
  // buffer sólo se puede leer antes de que el cuadro se presente, así que un píxel con su color prueba que pintó en esa tarea.
  mostrarYLeer(capa, x, y) {
    const t0 = ahora()
    N.eng.setLayerVisibility(capa, true)
    const ms = ahora() - t0, f = filas(N.eng).find(r => r.layerId === capa)
    const canvas = [...N.mapa.shadowRoot.querySelectorAll(`.leaflet-${f.pane}-pane canvas`)].find(c => { const gl = T.canvas.get(c); return gl && !gl.isContextLost() })
    const gl = canvas && T.canvas.get(canvas)
    let pixel = null
    if (gl) { const b = new Uint8Array(4); gl.readPixels(x, gl.drawingBufferHeight - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); pixel = [...b] }
    return { estado: f.state, pixel, ms }
  },
  setVisible: (id, visible) => N.eng.setLayerVisibility(id, visible),

  // Una línea en una capa que nació vacía: la medición o las rutas.
  llenarLinea(id, px = [[100, 700], [500, 700]]) {
    N.capas[id].set([{ id: 1, pts: px.map(p => { const l = latlng(p); return [l.lat, l.lng] }), color: '#112233', weight: 6, opacity: 1 }])
    return true
  },
  vaciarLinea: id => (N.capas[id].set([]), true),

  // Vuela a un punto (px de desplazamiento) y espera a que termine el gesto. Devuelve la ventana del gesto.
  async volar(dx, z, ms) {
    const c = vista(), d = aLatLng(ESC.w / 2 + dx, ESC.h / 2, c), n0 = T.gestos.length
    const t0 = ahora()
    N.eng.camera.flyTo([d.lat, d.lng], z ?? c.z, { duration: ms / 1000 })
    while (ahora() - t0 < ms + 3000) { await dormir(30); if (T.gestos.length > n0 && T.gestos.at(-1).fin) break }
    return { t0, ...T.gestos.slice(n0).at(-1) }
  },
  iniciarVuelo(dx, z, ms) {
    const c = vista(), d = aLatLng(ESC.w / 2 + dx, ESC.h / 2, c), t0 = ahora()
    N.eng.camera.flyTo([d.lat, d.lng], z ?? c.z, { duration: ms / 1000 })
    return t0
  },
  vista,
  restaurarVista: () => N.eng.camera.setView([VISTA.lat, VISTA.lng], VISTA.z),
  invalidar: () => N.eng.invalidateCanvas(),

  // Abre una ventana del mismo origen y monta ahí otro mapa con el MISMO JS (el portal de la app): un motor propio con 7 capas
  // con contenido (un polígono, cuatro de puntos y dos de líneas) sobre un contenedor de la ventana.
  async abrirVentana() {
    const w = window.open('about:blank', 'ventana', 'popup,width=700,height=500')
    if (!w) throw new Error('window.open devolvió null')
    N.ventana = w
    w.document.open()
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>ventana</title><style>html,body{margin:0;background:#fff;overflow:hidden}</style></head><body></body></html>')
    w.document.close()
    const css = [...N.mapa.shadowRoot.adoptedStyleSheets].flatMap(h => [...h.cssRules].map(r => r.cssText)).join('\n')
    const st = w.document.createElement('style')
    st.textContent = css
    w.document.head.appendChild(st)
    const cont = w.document.createElement('div')
    cont.id = 'mapa-v'
    cont.style.cssText = 'position:absolute;left:0;top:0;width:700px;height:500px'
    w.document.body.appendChild(cont)
    vigilar(w, 'ventana')
    return true
  },

  async montarVentana() {
    const { MapEngine } = N.mod, cont = N.ventana.document.querySelector('#mapa-v')
    const eng = new MapEngine({ container: cont, view: { center: [VISTA.lat, VISTA.lng], zoom: VISTA.z } })
    await eng.ready
    N.engVentana = eng
    eng.on('surfacechange', d => ev('estado', { capa: d.layerId, estado: d.state, z: d.z, pane: d.pane, necesaria: d.visible && d.hasContent, ventana: 'ventana' }))
    const alli = ([x, y]) => aLatLng(x - VENT.w / 2 + ESC.w / 2, y - VENT.h / 2 + ESC.h / 2)
    const par  = lista => lista.map(p => { const l = alli(p); return [l.lat, l.lng] })
    const lineas = { idOf: s => s.id, pathOf: s => s.pts, styleOf: s => s }
    const rect   = [[60, 60], [640, 60], [640, 440], [60, 440]]
    eng.addPolygonLayer({ id: 'v-geo', accessors: { idOf: g => g.id, ringsOf: g => g.coords, styleOf: () => ({ color: '#444444', fillColor: '#444444', fillOpacity: 1 }) }, data: [{ id: 1, coords: [par(rect)] }] })
    eng.addLineLayer({ id: 'v-lin-a', accessors: lineas, data: [{ id: 1, pts: par([[80, 150], [620, 150]]), color: '#ff0000', weight: 12, opacity: 1 }] })
    eng.addLineLayer({ id: 'v-lin-b', accessors: lineas, data: [{ id: 1, pts: par([[80, 350], [620, 350]]), color: '#00ff00', weight: 12, opacity: 1 }] })
    VENT.puntos.forEach(([id, x, y, v], k) => eng.addPointLayer({ id, accessors: accesores(v), iconSet: N.iconos, data: [{ id: 1000 + k, ...alli([x, y]) }] }))
    await quieto()
    return true
  },
  sondasVentana: () => [
    { capa: 'v-geo',   x: 100, y: 100, rgb: [68, 68, 68], nota: 'polígono de la ventana' },
    { capa: 'v-lin-a', x: 350, y: 150, rgb: [255, 0, 0],  nota: 'línea roja' },
    { capa: 'v-lin-b', x: 350, y: 350, rgb: [0, 255, 0],  nota: 'línea verde' },
    ...VENT.puntos.map(([capa, x, y, v]) => ({ capa, x, y, rgb: COLOR[v], nota: 'puntos de la ventana' })),
  ],
  cerrarVentana() { N.engVentana?.destroy(); N.engVentana = null; N.ventana?.close(); N.ventana = null },

  destruir() { N.eng?.destroy?.(); N.mapa?.remove() },
}
// Para los navegadores que no maneja Playwright (Firefox por Marionette): se corre un código y se lee su resultado por id.
const RES = {}
let   corridas = 0
window.__res = RES
window.__run = codigo => {
  const id = ++corridas
  ;(async () => {
    try { RES[id] = JSON.stringify({ ok: await (0, eval)(`(async () => (${codigo}))()`) }) } catch (e) { RES[id] = JSON.stringify({ error: String(e?.stack ?? e) }) }
  })()
  return id
}
window.__listo = true
