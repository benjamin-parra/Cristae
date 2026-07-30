// Instrumento del banco de medición: un medidor por stage. Engancha los seis observadores, los
// alimenta desde el rAF del harness y devuelve un informe serializable agrupado por fase.
//
// REGLA DEL BANCO: el instrumento no se mide a sí mismo. `frame()` corre dentro del MISMO rAF que las
// escenas, así que es [0-alloc]: escribe en buffers preasignados y no crea arrays, objetos, clausuras
// ni strings por frame. Todo lo que asigna —percentiles, desgloses, informes— ocurre en los límites
// de fase o en `terminar()`.
//
// Orden esperado por stage: crearMedidor(contenedor) → crear el L.map → iniciar() → montar backend.
// `iniciar()` marca el t0 de "montar" y arranca los observadores, así el chrome de Leaflet creado
// ANTES no ensucia ni el conteo de nodos ni la detección del primer dato en pantalla.

const CAP_FRAMES     = 8192   // ~2,3 min a 60 fps; el guión completo son ~15 s
const CAP_LONGTASKS  = 4096
const CAP_ATRIBUCION = 64
const CAP_TESTIGOS   = 24
const CAP_INTENTOS   = 120    // frames que se reintenta atribuir un contexto antes de darlo por ajeno

// Familias que delatan el backend real de una capa: `path` = vector SVG de Leaflet,
// `.leaflet-marker-icon` = un nodo por ítem, `canvas` = GL o canvas-2d.
const SELECTORES = ['path', '.leaflet-marker-icon', '.leaflet-interactive', 'canvas']

const TIPOS_GL = ['webgl', 'webgl2', 'experimental-webgl']

// nombre → índice del argumento `count`. Un count>0 es la evidencia de que una capa GL puso datos en
// pantalla (instrumento 2). Los wrappers pasan SIEMPRE seis argumentos —WebIDL ignora los sobrantes—
// para no truncar `drawRangeElements`, la única firma de más de cinco.
const METODOS_DRAW = {
  drawArrays            : 2,
  drawElements          : 1,
  drawArraysInstanced   : 2,
  drawElementsInstanced : 1,
  drawRangeElements     : 3,
}

const soportaUA   = typeof performance.measureUserAgentSpecificMemory === 'function'
const soportaHeap = !!performance.memory
const soportaGc   = typeof globalThis.gc === 'function'

const r3        = v => (v == null ? null : Math.round(v * 1000) / 1000)
const heapAhora = () => (soportaHeap ? performance.memory.usedJSHeapSize : null)

// ─── Instrumento 5: parcheo global de GL, con recuento de instalaciones ──────────────────────────
// Los prototipos son del documento, no del stage: A y B comparten el parche. La atribución por
// contenedor la resuelve `propietarioDe`; el parche se restaura cuando se desengancha el último
// medidor.

let instalaciones = 0
let FRAME         = 0     // reloj de frames del documento; sella los intentos de resolución

const originales  = []    // { proto, nombre, orig } para restaurar en terminar()
const estados     = []    // medidores enganchados, en orden de instalación
const contextos   = []    // { canvas: WeakRef, perdido, propietario } — histórico, nunca se purga
const pendientes  = []    // entradas de `contextos` sin propietario resuelto
const PROPIETARIO = new WeakMap()
const SELLO       = new WeakMap()
const VISTOS      = new WeakSet()

// Un contexto GL se atribuye al stage cuyo contenedor tiene su canvas. La resolución es perezosa: al
// primer draw el canvas puede no estar todavía en el DOM. El sello acota los reintentos a uno por
// contexto y por frame — el hot path no puede pagar un `contains` por llamada.
const propietarioDe = gl => {
  const previo = PROPIETARIO.get(gl)
  if (previo) return previo
  if (SELLO.get(gl) === FRAME) return null
  SELLO.set(gl, FRAME)
  const canvas = gl.canvas
  if (!canvas || canvas.nodeType !== 1) return null
  for (let i = 0; i < estados.length; i++) {
    if (!estados[i].contenedor.contains(canvas)) continue
    PROPIETARIO.set(gl, estados[i])
    return estados[i]
  }
  return null
}

const resolverEntrada = entrada => {
  if (entrada.propietario) return true
  const canvas = entrada.canvas.deref()
  if (!canvas) return true                       // canvas recolectado: ya no hay nada que atribuir
  for (let i = 0; i < estados.length; i++) {
    if (!estados[i].contenedor.contains(canvas)) continue
    entrada.propietario = estados[i]
    return true
  }
  return false
}

// [0-alloc]: se llama desde `frame()` sólo mientras queden entradas sin resolver. Compacta con
// swap-and-pop porque `splice` devuelve un array nuevo por llamada. Un canvas que nunca aparece bajo
// ningún stage se abandona tras CAP_INTENTOS: sigue contando para el total del documento.
const barrerPendientes = () => {
  for (let i = pendientes.length - 1; i >= 0; i--) {
    const entrada = pendientes[i]
    if (!resolverEntrada(entrada) && ++entrada.intentos < CAP_INTENTOS) continue
    pendientes[i] = pendientes[pendientes.length - 1]
    pendientes.pop()
  }
  return pendientes.length
}

// El canvas se guarda por WeakRef: retenerlo desde el banco falsearía tanto el veredicto de teardown
// como la medición de memoria.
const registrarContexto = (canvas, gl) => {
  if (VISTOS.has(gl)) return false
  VISTOS.add(gl)
  const entrada = { canvas: new WeakRef(canvas), perdido: false, propietario: null, intentos: 0 }
  contextos.push(entrada)
  canvas.addEventListener('webglcontextlost', () => (entrada.perdido = true), { once: true })
  resolverEntrada(entrada) || pendientes.push(entrada)
  return true
}

const contarContextos = filtro => {
  let creados = 0
  let vivos   = 0
  for (let i = 0; i < contextos.length; i++) {
    const entrada = contextos[i]
    if (filtro && entrada.propietario !== filtro) continue
    creados++
    if (!entrada.perdido && entrada.canvas.deref()) vivos++
  }
  return { creados, vivos }
}

const instalarDraws = proto => Object.entries(METODOS_DRAW).forEach(([nombre, idxCount]) => {
  const orig = proto[nombre]
  if (typeof orig !== 'function') return
  // `function` y no arrow: el receptor es el contexto GL que hace la llamada.
  const envuelto = function (a, b, c, d, e, f) {
    const estado = propietarioDe(this)
    if (estado) {
      estado.draws++
      const count = idxCount === 1 ? b : idxCount === 2 ? c : d
      count > 0 && estado.tPrimerDraw < 0 && (estado.tPrimerDraw = performance.now())
    }
    return orig.call(this, a, b, c, d, e, f)
  }
  proto[nombre] = envuelto
  originales.push({ proto, nombre, orig })
})

const instalarGetContext = () => {
  const proto = HTMLCanvasElement.prototype
  const orig  = proto.getContext
  const envuelto = function (tipo, atributos) {
    const ctx = orig.call(this, tipo, atributos)
    ctx && TIPOS_GL.includes(tipo) && registrarContexto(this, ctx)
    return ctx
  }
  proto.getContext = envuelto
  return originales.push({ proto, nombre: 'getContext', orig })
}

const instalar = estado => {
  estados.push(estado)
  // Cuántos stages llegaron a convivir: el informe de cada uno lo declara aunque se cierren en orden.
  estados.forEach(otro => (otro.concurrentes = Math.max(otro.concurrentes, estados.length)))
  if (instalaciones++) return instalaciones
  ;[globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]
    .forEach(ctor => ctor && instalarDraws(ctor.prototype))
  instalarGetContext()
  return instalaciones
}

const desinstalar = estado => {
  const i = estados.indexOf(estado)
  i >= 0 && estados.splice(i, 1)
  if (--instalaciones > 0) return instalaciones
  originales.forEach(({ proto, nombre, orig }) => (proto[nombre] = orig))
  originales.length = 0
  return 0
}

// ─── Instrumento 4: nodos DOM ───────────────────────────────────────────────────────────────────

// Un subárbol insertado de una vez cuenta como UN registro pero como N elementos: el churn de las
// capas DOM se ve en el acumulado, no en el conteo de mutaciones.
const contarElementos = lista => {
  let n = 0
  for (let i = 0; i < lista.length; i++) {
    const nodo = lista[i]
    if (nodo.nodeType !== 1) continue
    n += 1 + nodo.getElementsByTagName('*').length
  }
  return n
}

const procesarMutaciones = (estado, registros) => {
  for (let i = 0; i < registros.length; i++) {
    const registro = registros[i]
    estado.nodosCreados    += contarElementos(registro.addedNodes)
    estado.nodosEliminados += contarElementos(registro.removedNodes)
  }
  const primera = estado.tPrimeraMutacion < 0 && estado.nodosCreados > 0
  primera && (estado.tPrimeraMutacion = performance.now() - estado.t0)
  return estado.nodosCreados
}

// Las entregas del MutationObserver son microtareas: sin drenar en el límite, las mutaciones de la
// fase que cierra se contarían en la que abre.
const drenar = estado => !!estado.obsDom && procesarMutaciones(estado, estado.obsDom.takeRecords())

const vivosEn    = contenedor => contenedor.querySelectorAll('*').length
const desglosarD = contenedor => SELECTORES.reduce((acc, sel) => {
  acc[sel] = contenedor.querySelectorAll(sel).length
  return acc
}, {})

const nombreDe = nodo => {
  const clases = typeof nodo.className === 'string' ? nodo.className.trim() : ''
  return nodo.tagName.toLowerCase() + (clases ? '.' + clases.replace(/\s+/g, '.') : '')
}

const testigos = contenedor => {
  const nodos  = contenedor.querySelectorAll('*')
  const salida = []
  for (let i = 0; i < nodos.length && salida.length < CAP_TESTIGOS; i++) salida.push(nombreDe(nodos[i]))
  return salida
}

// ─── Instrumento 1: estadística de frametime ────────────────────────────────────────────────────
// Nunca el promedio: esconde justo el tirón que se busca.

const percentil = (ordenado, p) => ordenado[Math.min(ordenado.length - 1, Math.round(p * (ordenado.length - 1)))]

const peorUnoPorCiento = ordenado => {
  const k = Math.max(1, Math.ceil(ordenado.length * 0.01))
  let suma = 0
  for (let i = ordenado.length - k; i < ordenado.length; i++) suma += ordenado[i]
  return suma / k
}

const VACIO = { p50: null, p95: null, peor1pct: null, max: null, muestras: 0 }

const ordenar = (deltas, desde, hasta) => {
  const fin = Math.min(hasta, CAP_FRAMES)
  return fin - desde > 0 ? deltas.slice(desde, fin).sort() : null
}

// El p50 SIN redondear: el umbral de "frame estable" se compara contra los mismos float32 del buffer,
// y un p50 redondeado a 3 decimales cae por debajo del valor guardado — ningún frame lo cumpliría.
const p50Crudo = (deltas, desde, hasta) => {
  const ordenado = ordenar(deltas, desde, hasta)
  return ordenado && percentil(ordenado, 0.5)
}

const estadisticaFrametime = (deltas, desde, hasta) => {
  const ordenado = ordenar(deltas, desde, hasta)
  if (!ordenado) return VACIO
  return {
    p50      : r3(percentil(ordenado, 0.5)),
    p95      : r3(percentil(ordenado, 0.95)),
    peor1pct : r3(peorUnoPorCiento(ordenado)),
    max      : r3(ordenado[ordenado.length - 1]),
    muestras : ordenado.length,
  }
}

const longtasksEntre = (estado, desde, hasta) => {
  let conteo = 0
  let total  = 0
  let peor   = 0
  for (let i = 0; i < estado.ltConteo; i++) {
    const inicio = estado.ltInicio[i]
    if (inicio < desde || inicio >= hasta) continue
    const duracion = estado.ltDuracion[i]
    conteo++
    total += duracion
    if (duracion > peor) peor = duracion
  }
  return { conteo, duracionTotal: r3(total), peor: r3(peor) }
}

// ─── Instrumento 3: memoria ─────────────────────────────────────────────────────────────────────
// Tres caminos que degradan. El hito de un límite de fase cierra la contabilidad de la fase que
// termina y abre la de la que empieza: el heap crudo se lee ANTES del gc opcional (asignado y todavía
// no recolectado) y el gcHeap después (retenido de verdad).

const medirUA = (estado, hito) => {
  if (!estado.soporteUA || estado.uaEnVuelo) return false
  estado.uaEnVuelo = true
  const promesa = performance.measureUserAgentSpecificMemory()
    .then(r => (hito.ua = r.bytes))
    .catch(() => (estado.soporteUA = false))
    .finally(() => (estado.uaEnVuelo = false))
  estado.promesasUA.push(promesa)
  return true
}

const registrarHito = (estado, nombre) => {
  const marca = `${estado.prefijo}${estado.hitos.length}:${nombre}`
  const hito  = { fase: nombre, marca, t: performance.now() - estado.t0, heap: heapAhora(), gcHeap: null, ua: null }
  performance.mark(marca)
  if (soportaGc) {
    globalThis.gc()
    hito.gcHeap = heapAhora()
  }
  medirUA(estado, hito)
  estado.hitos.push(hito)
  return estado.hitos.length - 1
}

const memoriaDeFase = (estado, fase) => {
  const a = estado.hitos[fase.hitoInicio]
  const b = estado.hitos[fase.hitoFin]
  if (!a || !b) return null
  const porFrame = (x, y) => (x == null || y == null || !fase.frames ? null : Math.round((y - x) / fase.frames))
  return {
    uaAntes            : a.ua,
    uaDespues          : b.ua,
    uaDelta            : a.ua != null && b.ua != null ? b.ua - a.ua : null,
    heapAntes          : a.heap,
    heapDespues        : b.heap,
    heapDelta          : a.heap != null && b.heap != null ? b.heap - a.heap : null,
    bytesPorFrame      : porFrame(a.gcHeap, b.gcHeap),   // retenido tras gc: delata fugas
    bytesPorFrameCrudo : porFrame(a.gcHeap, b.heap),     // asignado y aún no recolectado: churn
    fuente             : a.gcHeap != null ? 'gc' : a.ua != null ? 'ua' : a.heap != null ? 'heap' : null,
    aproximado         : a.gcHeap == null && a.ua == null,
  }
}

// ─── Fases ──────────────────────────────────────────────────────────────────────────────────────

const abrirFase = (estado, nombre, hitoInicio) => {
  const fase = {
    nombre,
    tInicio         : performance.now() - estado.t0,
    tFin            : 0,
    frameInicio     : estado.frames,
    frameFin        : estado.frames,
    frames          : 0,
    draws           : 0,
    drawsMax        : 0,
    baseCreados     : estado.nodosCreados,
    baseEliminados  : estado.nodosEliminados,
    nodosCreados    : 0,
    nodosEliminados : 0,
    nodosVivosFin   : 0,
    desgloseFin     : null,
    hitoInicio,
    hitoFin         : -1,
  }
  estado.fases.push(fase)
  estado.faseActual = fase
  return fase
}

const cerrarFase = estado => {
  const fase = estado.faseActual
  if (!fase) return null
  fase.tFin            = performance.now() - estado.t0
  fase.frameFin        = estado.frames
  fase.nodosCreados    = estado.nodosCreados - fase.baseCreados
  fase.nodosEliminados = estado.nodosEliminados - fase.baseEliminados
  fase.nodosVivosFin   = vivosEn(estado.contenedor)
  fase.desgloseFin     = desglosarD(estado.contenedor)
  if (fase.nodosVivosFin > estado.nodosVivosMax) estado.nodosVivosMax = fase.nodosVivosFin
  return fase
}

// El primer frame de cada fase carga con el trabajo del límite (gc opcional, snapshots del DOM,
// cambio de fase): se descarta de los percentiles, nunca del conteo.
const informeDeFase = (estado, fase) => {
  const duracion = fase.tFin - fase.tInicio
  return {
    nombre    : fase.nombre,
    tInicio   : r3(fase.tInicio),
    tFin      : r3(fase.tFin),
    duracion  : r3(duracion),
    frames    : fase.frames,
    fps       : duracion > 0 ? r3((fase.frames * 1000) / duracion) : null,
    frametime : estadisticaFrametime(estado.deltas, fase.frameInicio + 1, fase.frameFin),
    longtasks : longtasksEntre(estado, fase.tInicio, fase.tFin),
    dom       : {
      creados     : fase.nodosCreados,
      eliminados  : fase.nodosEliminados,
      vivosFin    : fase.nodosVivosFin,
      desgloseFin : fase.desgloseFin,
    },
    gl        : {
      draws         : fase.draws,
      drawsPorFrame : fase.frames ? r3(fase.draws / fase.frames) : null,
      drawsMaxFrame : fase.drawsMax,
    },
    memoria   : memoriaDeFase(estado, fase),
  }
}

// ─── Instrumento 2: primer paint ────────────────────────────────────────────────────────────────

const primerFrameEstable = (estado, umbral) => {
  if (umbral == null) return null
  const n = Math.min(estado.frames, CAP_FRAMES)
  for (let i = 0; i < n; i++) if (estado.deltas[i] <= umbral) return r3(estado.tiempos[i])
  return null
}

const primerPaint = (estado, umbral) => {
  const gl  = estado.tPrimerDraw < 0 ? null : estado.tPrimerDraw - estado.t0
  const dom = estado.tPrimeraMutacion < 0 ? null : estado.tPrimeraMutacion
  const usaGl = gl != null && (dom == null || gl <= dom)
  return {
    montarADatos              : r3(usaGl ? gl : dom),
    fuenteDatos               : gl == null && dom == null ? null : usaGl ? 'gl' : 'dom',
    primerDrawGL              : r3(gl),
    primeraMutacionDOM        : r3(dom),
    montarAPrimerFrameEstable : primerFrameEstable(estado, umbral),
    umbralEstable             : r3(umbral),
  }
}

// ─── Informe ────────────────────────────────────────────────────────────────────────────────────

const medirFases = estado => {
  estado.fases.forEach((fase, i) => {
    const hitoA = estado.hitos[fase.hitoInicio]
    const hitoB = estado.hitos[fase.hitoFin]
    if (!hitoA || !hitoB) return
    try {
      performance.measure(`${estado.prefijo}${i}:${fase.nombre}`, hitoA.marca, hitoB.marca)
    } catch { /* el panel de rendimiento es un extra: su falla no invalida la medición */ }
  })
  return estado.fases.length
}

const notasDe = estado => {
  const notas = []
  estado.soporteUA || notas.push('measureUserAgentSpecificMemory no disponible: hace falta cross-origin isolation (COOP/COEP)')
  soportaGc || notas.push('sin window.gc (--js-flags=--expose-gc): no hay bytes/frame exactos, sólo el heap aproximado')
  soportaHeap || notas.push('performance.memory no disponible: la memoria queda sin proxy sincrónico')
  estado.obsLong || notas.push('longtask no soportado por este navegador: las pausas quedan sin atribuir')
  estado.concurrentes > 1 && notas.push('las longtasks son del documento: A y B ven las mismas entradas')
  estado.desbordeFrames && notas.push(`${estado.desbordeFrames} frames por encima de CAP_FRAMES quedaron fuera de los percentiles`)
  estado.nodosCreados && notas.push('los registros del MutationObserver son basura propia del instrumento: inflan la memoria de los backends DOM')
  return notas
}

const armarInforme = estado => {
  const contenedor = estado.contenedor
  const duracion   = performance.now() - estado.t0
  const propios    = contarContextos(estado)
  const documento  = contarContextos(null)
  const nodosVivos = vivosEn(contenedor)
  const fases      = estado.fases.map(fase => informeDeFase(estado, fase))
  const global     = estadisticaFrametime(estado.deltas, 0, estado.frames)
  const reposo     = estado.fases.find(fase => fase.nombre === 'reposo')
  const umbral     = (reposo && p50Crudo(estado.deltas, reposo.frameInicio + 1, reposo.frameFin))
    ?? p50Crudo(estado.deltas, 0, estado.frames)
  medirFases(estado)
  return {
    version     : 1,
    contenedor  : { ancho: contenedor.clientWidth, alto: contenedor.clientHeight, dpr: devicePixelRatio },
    soporte     : { memoriaUA: estado.soporteUA, gc: soportaGc, heap: soportaHeap, longtask: !!estado.obsLong },
    primerPaint : primerPaint(estado, umbral),
    fases,
    global      : {
      duracion  : r3(duracion),
      frames    : estado.frames,
      fps       : duracion > 0 ? r3((estado.frames * 1000) / duracion) : null,
      frametime : global,
      longtasks : { ...longtasksEntre(estado, 0, duracion), atribuciones: estado.atribuciones },
      dom       : {
        creados     : estado.nodosCreados,
        eliminados  : estado.nodosEliminados,
        vivosMax    : estado.nodosVivosMax,
        vivosFin    : nodosVivos,
        desgloseFin : desglosarD(contenedor),
      },
      gl        : {
        draws            : estado.draws,
        drawsPorFrame    : estado.frames ? r3(estado.draws / estado.frames) : null,
        contextosCreados : propios.creados,
        contextosVivos   : propios.vivos,
      },
    },
    // Instrumento 6: el veredicto se emite contra los contextos ATRIBUIDOS al stage — los del stage
    // hermano seguirían vivos y darían un falso positivo.
    teardown    : {
      ok                      : nodosVivos === 0 && propios.vivos === estado.contextosPrevios,
      nodosVivos,
      desglose                : desglosarD(contenedor),
      supervivientes          : testigos(contenedor),
      contextosVivos          : propios.vivos,
      contextosPrevios        : estado.contextosPrevios,
      contextosCreados        : propios.creados,
      contextosVivosDocumento : documento.vivos,
    },
    notas       : notasDe(estado),
  }
}

// ─── Fábrica ────────────────────────────────────────────────────────────────────────────────────

let secuencia = 0

export const crearMedidor = contenedor => {
  const estado = {
    contenedor,
    prefijo          : `bench:${++secuencia}:`,
    activo           : false,
    informe          : null,
    t0               : 0,
    tPrevio          : 0,
    frames           : 0,
    desbordeFrames   : 0,
    deltas           : new Float32Array(CAP_FRAMES),
    tiempos          : new Float64Array(CAP_FRAMES),
    ltInicio         : new Float64Array(CAP_LONGTASKS),
    ltDuracion       : new Float64Array(CAP_LONGTASKS),
    ltConteo         : 0,
    atribuciones     : [],
    draws            : 0,
    drawsPrevios     : 0,
    tPrimerDraw      : -1,
    tPrimeraMutacion : -1,
    nodosCreados     : 0,
    nodosEliminados  : 0,
    nodosVivosMax    : 0,
    contextosPrevios : 0,
    concurrentes     : 0,
    fases            : [],
    faseActual       : null,
    hitos            : [],
    promesasUA       : [],
    soporteUA        : soportaUA,
    uaEnVuelo        : false,
    obsDom           : null,
    obsLong          : null,
  }

  const observarDom = () => {
    const obs = new MutationObserver(registros => procesarMutaciones(estado, registros))
    obs.observe(contenedor, { childList: true, subtree: true })
    return obs
  }

  const observarLongtasks = () => {
    const obs = new PerformanceObserver(lista => {
      const entradas = lista.getEntries()
      for (let i = 0; i < entradas.length && estado.ltConteo < CAP_LONGTASKS; i++) {
        const entrada = entradas[i]
        const k       = estado.ltConteo++
        estado.ltInicio[k]   = entrada.startTime - estado.t0
        estado.ltDuracion[k] = entrada.duration
        const atrib = entrada.attribution && entrada.attribution[0]
        const cabe  = atrib && estado.atribuciones.length < CAP_ATRIBUCION
        cabe && estado.atribuciones.push(`${atrib.name}:${atrib.containerType}:${r3(entrada.duration)}ms`)
      }
    })
    try {
      obs.observe({ type: 'longtask', buffered: false })
    } catch {
      return null
    }
    return obs
  }

  const iniciar = () => {
    if (estado.activo) return estado
    estado.activo  = true
    estado.t0      = performance.now()
    estado.tPrevio = estado.t0
    estado.obsDom  = observarDom()
    estado.obsLong = observarLongtasks()
    instalar(estado)
    estado.contextosPrevios = contarContextos(estado).vivos
    abrirFase(estado, 'montaje', registrarHito(estado, 'montaje'))
    return estado
  }

  const marcarFase = nombre => {
    if (!estado.activo) return null
    const previa = estado.faseActual
    if (previa && previa.nombre === nombre && previa.frames === 0) return previa
    drenar(estado)
    previa && cerrarFase(estado)
    const hito = registrarHito(estado, nombre)
    previa && (previa.hitoFin = hito)
    return abrirFase(estado, nombre, hito)
  }

  // [0-alloc] — una escritura por buffer y contadores enteros. Ninguna rama de acá asigna.
  const frame = tAhora => {
    if (!estado.activo) return 0
    FRAME++
    pendientes.length && barrerPendientes()
    const i     = estado.frames
    const delta = tAhora - estado.tPrevio
    estado.tPrevio = tAhora
    if (i < CAP_FRAMES) {
      estado.deltas[i]  = delta
      estado.tiempos[i] = tAhora - estado.t0
    } else estado.desbordeFrames++
    estado.frames = i + 1
    const fase = estado.faseActual
    if (fase) {
      const draws = estado.draws - estado.drawsPrevios
      fase.frames++
      fase.draws += draws
      if (draws > fase.drawsMax) fase.drawsMax = draws
    }
    estado.drawsPrevios = estado.draws
    return delta
  }

  const terminar = async () => {
    if (estado.informe) return estado.informe
    if (!estado.activo) return null
    drenar(estado)
    const ultima = estado.faseActual
    cerrarFase(estado)
    const hito = registrarHito(estado, 'fin')
    ultima && (ultima.hitoFin = hito)
    estado.faseActual = null
    estado.activo     = false
    estado.obsDom.disconnect()
    estado.obsLong && estado.obsLong.disconnect()
    desinstalar(estado)
    await Promise.allSettled(estado.promesasUA)
    soportaGc && globalThis.gc()   // WeakRefs honestas antes de contar contextos vivos
    estado.informe = armarInforme(estado)
    return estado.informe
  }

  return { iniciar, marcarFase, frame, terminar }
}
