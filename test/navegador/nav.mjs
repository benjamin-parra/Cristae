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
//
// Con `?preservar=1` el envoltorio pide `preserveDrawingBuffer: true` a todo contexto propio: así `__nav.huella()` puede leer los
// canvases GL vivos en cualquier momento, sin depender de la tarea en que pintaron. Sirve igual con un canvas por capa que con
// tramos (un canvas compartido por varias capas, en un pane `cristae-tramo-*`, y un marcador sin contexto en el pane de cada capa).
// Con `?dibujos=1` cuenta las llamadas de dibujo de los contextos propios según el framebuffer enlazado: al de pantalla
// (`pantalla`) o a uno propio (`fbo`: el FBO de un miembro de tramo, o el del picking). `__nav.dibujos()` los lee.

const q      = new URLSearchParams(location.search)
const DIST   = q.get('dist') ?? '/dist/'
const PRESERVAR = q.get('preservar') === '1'
const DIBUJOS   = q.get('dibujos') === '1'
const ESC    = { w: 1200, h: 760 }
const VISTA  = { lat: -33.45, lng: -70.66, z: 11 }
const ahora  = () => performance.now()
const dormir = ms => new Promise(r => setTimeout(r, ms))

// ───────────────────────── instrumentación ─────────────────────────
const T = { ctx: new Map(), canvas: new WeakMap(), ev: [], errores: [], avisos: [], cuadro: 0, gestos: [], dibujos: { pantalla: 0, fbo: 0 }, fb: new WeakMap() }
let   ajeno = false                    // en true mientras se crea un contexto ajeno: el envoltorio de getContext lo rotula

const ev = (k, datos) => T.ev.push({ t: ahora(), f: T.cuadro, k, ...datos })

// Los canvases de un motor montado en la ventana los crea el JS de la página y los cuelga el motor en otro documento.
const enVentana = canvas => canvas.ownerDocument !== document

// Cada dibujo de un contexto propio va a `pantalla` o a `fbo` según el framebuffer de dibujo enlazado en ese momento.
const contarDibujos = proto => {
  const bind = proto.bindFramebuffer
  proto.bindFramebuffer = function (blanco, fb) {
    blanco !== this.READ_FRAMEBUFFER && T.fb.set(this, fb)
    return bind.call(this, blanco, fb)
  }
  for (const k of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
    const o = proto[k]
    proto[k] = function (...a) {
      T.ctx.get(this)?.ajeno === false && T.dibujos[T.fb.get(this) ? 'fbo' : 'pantalla']++
      return o.apply(this, a)
    }
  }
}

const vigilar = (win, ventana) => {
  const proto = win.HTMLCanvasElement.prototype, original = proto.getContext
  proto.getContext = function (tipo, ...r) {
    PRESERVAR && !ajeno && /webgl/.test(String(tipo)) && (r[0] = { ...r[0], preserveDrawingBuffer: true })
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
    canvas.addEventListener('webglcontextrestored', () => ev('restaurado', { n, ajeno: dato.ajeno }))
    return gl
  }
  DIBUJOS && contarDibujos(win.WebGL2RenderingContext.prototype)
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

// El canvas GL vivo que dibuja una capa: el de su tramo si la capa es miembro de uno (su `surface.canvas` es entonces un
// marcador sin contexto), si no el suyo; y si la capa no se encuentra en el motor, el canvas con contexto vivo de su pane.
const vivo     = c => { const gl = c && T.canvas.get(c); return gl && !gl.isContextLost() ? gl : null }
const canvasDe = (motor, raiz, f) => {
  const r = motor.getLayer?.(f.layerId), s = (r?.layer ?? r?.editor)?.surface
  return [s?.tramo?.surface?.canvas, s?.canvas].find(vivo) ?? [...raiz.querySelectorAll(`.leaflet-${f.pane}-pane canvas`)].find(vivo) ?? null
}

// Orden de apilamiento de dos canvases del mapa: z del pane (hijo de .leaflet-map-pane) y, a igual z, el orden del DOM (que
// incluye el orden de los panes y el de los nodos dentro de cada uno).
const paneDe   = c => { let p = c; while (p.parentElement && !p.parentElement.classList.contains('leaflet-map-pane')) p = p.parentElement; return p }
const zDe      = c => Number(getComputedStyle(paneDe(c)).zIndex) || 0
const nombreDe = c => paneDe(c).className.replace(/^leaflet-pane leaflet-|-pane$/g, '')   // el nombre del pane, como `surfaces()`
const antes    = (a, b) => zDe(a) - zDe(b) || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)

// Opacidad efectiva por CSS (producto de los ancestros hasta la raíz de sombra), 0 si algo lo oculta.
const opacidadCss = c => {
  if (getComputedStyle(c).visibility === 'hidden') return 0
  let a = 1
  for (let e = c; e; e = e.parentElement) {
    const st = getComputedStyle(e)
    if (st.display === 'none') return 0
    a *= Number(st.opacity)
  }
  return a
}

const FONDO = [221, 221, 221]          // el de .leaflet-container: lo que se ve donde no hay nada

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
    // las capas con contenido que no tienen contexto todavía lo toman en ratos ociosos: se espera a que no quede ninguna. Una
    // vacía en un tramo vivo sigue en `none` hasta tener contenido, así que no cuenta
    while (ahora() - t0 < 12_000 && filas(N.eng).some(f => f.state === 'none' && f.hasContent)) await dormir(20)
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

  // Los contextos propios vivos (de la instrumentación): cuántos hay, cuántos con su canvas en el documento, y de qué pane.
  contextosVivos() {
    const vivos = [...T.ctx.values()].filter(c => !c.ajeno && !c.gl.isContextLost())
    return {
      vivos  : vivos.length,
      enDom  : vivos.filter(c => c.canvas.isConnected).length,
      detalle: vivos.map(c => ({ n: c.n, pane: c.canvas.isConnected ? nombreDe(c.canvas) : null, w: c.canvas.width, h: c.canvas.height })),
    }
  },

  // El color de cada sonda (vista actual), leído de los canvases GL vivos del mapa principal y compuesto como lo hace el
  // navegador: en orden de apilamiento, «over» premultiplicado, con la opacidad CSS de cada canvas. Sólo GL: etiquetas y HTML
  // no entran. `rgba` es la composición sobre transparente y `rgb` sobre el fondo del contenedor. Pide `?preservar=1`: sin
  // eso un canvas ya presentado se lee vacío, y `preservado` lo dice.
  huella() {
    const raiz = N.mapa.shadowRoot, cont = N.mapa.getBoundingClientRect()
    const capas = [...raiz.querySelectorAll('canvas')].filter(c => vivo(c) && c.isConnected).sort(antes)
      .map(c => ({ c, gl: T.canvas.get(c), a: opacidadCss(c), r: c.getBoundingClientRect(), pane: nombreDe(c) }))
    const b = new Uint8Array(4)
    const leer = (k, x, y) => {
      const { c, gl, r } = k, cx = Math.floor((cont.left + x - r.left) * c.width / r.width), cy = Math.floor((cont.top + y - r.top) * c.height / r.height)
      if (cx < 0 || cy < 0 || cx >= gl.drawingBufferWidth || cy >= gl.drawingBufferHeight) return null
      gl.readPixels(cx, gl.drawingBufferHeight - 1 - cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b)
      const pre = gl.getContextAttributes().premultipliedAlpha ? 1 : b[3] / 255
      return [b[0] * pre / 255, b[1] * pre / 255, b[2] * pre / 255, b[3] / 255]
    }
    const sondas = this.sondas().map(s => {
      const o = [0, 0, 0, 0], aportan = []
      for (const k of capas) {
        const p = k.a > 0 && leer(k, s.x, s.y)
        if (!p || p[3] === 0) continue
        const f = 1 - p[3] * k.a
        for (let i = 0; i < 4; i++) o[i] = p[i] * k.a + o[i] * f
        aportan.push(k.pane)
      }
      const rgba = o.map(v => Math.round(v * 255)), rgb = FONDO.map((v, i) => Math.round((o[i] + v / 255 * (1 - o[3])) * 255))
      return { capa: s.capa, x: s.x, y: s.y, rgba, rgb, aportan }
    })
    return { preservado: capas.every(k => k.gl.getContextAttributes().preserveDrawingBuffer), canvases: capas.map(k => ({ pane: k.pane, opacidad: k.a })), sondas }
  },

  dibujos: () => ({ ...T.dibujos }),

  // La composición de los canvases GL vivos (orden de apilamiento y opacidad CSS, como huella) sobre el fondo del contenedor,
  // en PNG. Sin etiquetas ni HTML. Pide `?preservar=1`. Con `nombre`, la guarda por `servir.mjs --salida`.
  async imagen(nombre) {
    const raiz = N.mapa.shadowRoot, cont = N.mapa.getBoundingClientRect()
    const lienzo = Object.assign(document.createElement('canvas'), { width: ESC.w, height: ESC.h }), x = lienzo.getContext('2d')
    x.fillStyle = hex(FONDO)
    x.fillRect(0, 0, ESC.w, ESC.h)
    for (const c of [...raiz.querySelectorAll('canvas')].filter(c => vivo(c) && c.isConnected).sort(antes)) {
      const r = c.getBoundingClientRect()
      x.globalAlpha = opacidadCss(c)
      x.globalAlpha && x.drawImage(c, r.left - cont.left, r.top - cont.top, r.width, r.height)
    }
    const png = await new Promise(r => lienzo.toBlob(r, 'image/png'))
    return nombre ? this.guardar(nombre, png) : png.size
  },

  // Guarda un json (o un Blob) en la carpeta `--salida` de servir.mjs. Devuelve los bytes escritos, o null sin servidor que guarde.
  async guardar(nombre, datos) {
    const r = await fetch(`/guardar/${encodeURIComponent(nombre)}`, { method: 'POST', body: datos instanceof Blob ? datos : JSON.stringify(datos, null, 2) })
    return r.ok ? Number(await r.text()) : null
  },

  // El protocolo de verificación de la etapa C (contexto compartido por tramo), igual para la línea base y la rama nueva. Monta
  // si hace falta y registra: (a) contextos vivos en reposo; (b) la huella; (c) perder el contexto de `perder` (con tramos, el
  // de su tramo entero): huella en la misma tarea, eventos y huella tras recuperar; (d) ocultar y mostrar `ocultar`; (e)
  // `focus(foco)` y `unfocusAll()`; (f) errores y avisos de consola. En (d) y (e) cuenta los dibujos (pide `?dibujos=1`).
  // Con `guardar`, deja el json y las imágenes por servir.mjs con ese prefijo.
  async protocoloC({ perder = ['lug'], ocultar = 'lug', foco = ['veh'], guardar = '' } = {}) {
    N.eng || await this.montar()
    const asentar = async () => { await quieto(300, 3000); await this.cadencia(3) }
    const img = nombre => guardar ? this.imagen(`${guardar}${nombre}.png`) : null
    const dif = (a, b) => a.sondas.map((s, i) => ({ capa: s.capa, antes: s.rgb, ahora: b.sondas[i]?.rgb, max: Math.max(...s.rgb.map((v, k) => Math.abs(v - (b.sondas[i]?.rgb[k] ?? -999)))) }))
    const resumen = d => ({ iguales: d.every(x => x.max === 0), maxCanal: Math.max(...d.map(x => x.max)), distintas: d.filter(x => x.max > 0) })
    const tramo = async (accion, cuerpo) => { const d0 = this.dibujos(); accion(); await asentar(); const d1 = this.dibujos(); return { ...cuerpo(), dibujos: { pantalla: d1.pantalla - d0.pantalla, fbo: d1.fbo - d0.fbo } } }
    const R = { url: location.href, dpr: devicePixelRatio, renderer: T.renderer ?? null }

    await quieto(1000, 10_000)
    R.a = this.contextosVivos()
    R.b = this.huella()
    await img('01-inicial')

    // (c) la huella se lee en la misma tarea de la pérdida: `loseContext` deja el contexto perdido al instante
    const n0 = T.ev.length, viejos = [...T.ctx.values()].filter(c => !c.ajeno && !c.gl.isContextLost())
    const hechas = this.perder(perder), enBlanco = this.huella(), imgBlanco = img('02-perdida')
    await imgBlanco
    await quieto(1200, 15_000)
    await this.cadencia(3)
    const evs = T.ev.slice(n0), fin = this.huella()
    R.c = {
      pedidas: perder, hechas: [...hechas], contextosPerdidos: hechas.contextos,
      enBlanco: dif(R.b, enBlanco).filter(x => x.max > 40).map(x => x.capa),
      eventos: { perdido: evs.filter(e => e.k === 'perdido').length, ctxNuevos: evs.filter(e => e.k === 'ctx' && !e.ajeno).length, restaurado: evs.filter(e => e.k === 'restaurado').length },
      viejosSiguenPerdidos: viejos.filter(c => c.gl.isContextLost()).length,
      vivosTras: this.contextosVivos().vivos,
      huellaFinal: resumen(dif(R.b, fin)),
    }
    await img('03-recuperada')

    // (d) ocultar y mostrar
    R.d = {
      capa: ocultar,
      oculta: await tramo(() => N.eng.setLayerVisibility(ocultar, false), () => { const h = this.huella(); return { cambian: dif(R.b, h).filter(x => x.max > 0).map(x => x.capa), huella: h.sondas.map(s => s.rgb) } }),
    }
    await img('04-oculta')
    R.d.vuelta = await tramo(() => N.eng.setLayerVisibility(ocultar, true), () => resumen(dif(R.b, this.huella())))

    // (e) foco
    let atenuada
    R.e = { foco, atenuada: await tramo(() => N.eng.focus(foco), () => { atenuada = this.huella(); return { cambian: dif(R.b, atenuada).filter(x => x.max > 0).map(x => x.capa), huella: atenuada.sondas.map(s => s.rgb) } }) }
    await img('05-foco')
    R.e.repetido = await tramo(() => N.eng.focus(foco), () => resumen(dif(atenuada, this.huella())))     // contra la atenuada
    R.e.sinFoco  = await tramo(() => N.eng.unfocusAll(), () => resumen(dif(R.b, this.huella())))

    // (f) consola
    R.f = { errores: [...T.errores], avisos: [...T.avisos] }
    R.reposoFinal = this.contextosVivos().vivos
    guardar && await this.guardar(`${guardar}protocolo-c.json`, R)
    return R
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

  // La GPU quita el contexto de estas capas a la vez (un reinicio): `loseContext` sobre el canvas GL vivo que dibuja cada una,
  // una vez por contexto. Con tramos ese canvas es el del tramo y no el marcador del pane de la capa: perder una capa pierde a
  // todos los miembros de su tramo, y `hechas` los lista (sólo los pedidos). `contextos` cuenta los contextos perdidos.
  perder(capas, eng = 'principal') {
    const motor = eng === 'principal' ? N.eng : N.engVentana, raiz = eng === 'principal' ? N.mapa.shadowRoot : N.ventana.document.querySelector('#mapa-v')
    const hechas = [], gls = new Set()
    for (const f of filas(motor)) {
      if (!capas.includes(f.layerId) || f.state !== 'live') continue
      const gl = vivo(canvasDe(motor, raiz, f))
      gl && (gls.add(gl), hechas.push(f.layerId))
    }
    gls.forEach(gl => gl.getExtension('WEBGL_lose_context').loseContext())
    hechas.contextos = gls.size
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
  // Lee después de una microtarea: con tramos la composición corre en la microtarea de la tarea que pintó (sigue siendo la misma
  // tarea), y el canvas leído es el del tramo, no el marcador de la capa.
  async mostrarYLeer(capa, x, y) {
    const t0 = ahora()
    N.eng.setLayerVisibility(capa, true)
    const ms = ahora() - t0, f = filas(N.eng).find(r => r.layerId === capa)
    await null
    const canvas = canvasDe(N.eng, N.mapa.shadowRoot, f), gl = vivo(canvas)
    let pixel = null
    if (gl) {
      const r = canvas.getBoundingClientRect(), c = N.mapa.getBoundingClientRect(), b = new Uint8Array(4)
      const cx = Math.floor((c.left + x - r.left) * canvas.width / r.width), cy = Math.floor((c.top + y - r.top) * canvas.height / r.height)
      gl.readPixels(cx, gl.drawingBufferHeight - 1 - cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b)
      pixel = [...b]
    }
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
