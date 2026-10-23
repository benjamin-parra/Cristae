// Navegador falso: las reglas de los contextos WebGL de un documento de Chromium, puestas sobre el doble de GL
// del repo (`makeEditGl`, que ya registra lo que una capa sube, dibuja y lee). No es un GL paralelo: cada
// contexto ES un `makeEditGl` envuelto, y lo que agrega es lo que ese doble no sabe, que es lo que un
// desalojo le hace a una capa. Las reglas salen de medirlas en un Chromium headless real:
//
//   · Techo de contextos vivos por documento (16). Crear el siguiente desaloja a uno. Quién cae es lo que la
//     política decide: 'creacion' (el más viejo por creación, lo único medido) o 'ultimoUso' (el de trabajo
//     más antiguo, que es lo que Chromium dice mirar: GetLastFlushIdCHROMIUM).
//   · Perdido = `isContextLost()` verdadero YA, y `webglcontextlost` DESPUÉS, en otra tarea, cancelable. Sobre
//     un perdido `getExtension` devuelve null, `drawingBufferWidth` es 0, `getContextAttributes` es null,
//     `getError` es 37442 y `clientWaitSync` es WAIT_FAILED; `create*` devuelve null y el resto de las
//     llamadas no hacen nada (no llegan al espía del doble: una capa que dibuja sobre un perdido no se nota
//     en `gl.spy`, se nota en `llamadasTrasPerdida`).
//   · Un perdido no cuenta contra el techo. `loseContext()` libera el cupo en el acto —soltar uno y crear
//     otro en la misma pila no desaloja a nadie—, y el evento llega después.
//   · `restoreContext()` sólo restaura si el evento ya llegó y se canceló con `preventDefault()`; si no,
//     avisa y no hace nada. Restaurar toma un cupo (puede desalojar a otro), conserva el MISMO `gl` y deja
//     inválidos los recursos de antes.
//   · Un canvas 2D no cuenta. Pedir otro tipo de contexto a un canvas ya tomado da null; pedir el mismo da el
//     mismo.
//
// Las épocas son un rigor del doble, no de Chromium (que sólo marca INVALID_OPERATION): un recurso (programa,
// shader, buffer, textura, VAO, framebuffer, fence, ubicación de uniform) nace en un contexto y en una época,
// y se pierde con ella. Usarlo en otro contexto, o después de que el suyo se perdió, LANZA, y queda en
// `violaciones`: un uso del `gl` viejo es un defecto de la capa y tiene que verse. Borrarlo no lanza (en
// Chromium es un no-op, y el teardown de una capa perdida lo hace). Esto incluye la ventana entre perderse y
// oír el evento: una capa que dibuja en ese lapso con recursos de antes lanza; quien necesite pasar de largo
// llama a `vaciar()`, o construye con `estricto: false`.
//
// Un registro por documento: el techo es de la página, no del mapa. `instalarNavegador(window)` lo cuelga de
// `HTMLCanvasElement.prototype.getContext` (jsdom); `conNavegador(navegador)` lo cuelga de los canvases que
// fabrica el `document` del shim.
//
//   const navegador = instalarNavegador(window, { techo: 16, politica: 'creacion' })
//   …montar…
//   navegador.stat()   // { creados, vivos, liberados, desalojados, pico }

import { decorarElementos, makeEditGl, NOOP_CTX } from './engine-stub.mjs'

const GL                 = new Set(['webgl', 'webgl2', 'experimental-webgl'])
const PLANO              = new Set(['2d', 'bitmaprenderer'])
const CRITERIO           = { creacion: 'serie', ultimoUso: 'ultimoUso' }    // qué campo manda en cada política
const CONTEXT_LOST_WEBGL = 37442
const WAIT_FAILED        = 0x911D
const AVISO_TECHO        = 'WARNING: Too many active WebGL contexts. Oldest context will be lost.'

// Lo que manda trabajo a la GPU: es lo que cuenta como «uso» para la política 'ultimoUso'. Un contexto que sólo
// sube datos o consulta no avanzó su flush.
const USOS = new Set([
  'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements',
  'clear', 'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi', 'blitFramebuffer',
  'readPixels', 'flush', 'finish',
])

const MARCA  = Symbol('contexto y época de un recurso GL')
const NACE   = /^(create[A-Z]|fenceSync$|getUniformLocation$)/   // devuelven un recurso que pertenece al contexto
const BORRAR = /^delete[A-Z]/

// Qué devuelve una llamada sobre un contexto perdido: lo que Chromium, que no hace nada y contesta «nada».
const neutro = nombre =>
  nombre === 'getError'          ? CONTEXT_LOST_WEBGL
  : nombre === 'clientWaitSync'  ? WAIT_FAILED
  : /^(create[A-Z]|fenceSync$|get[A-Z])/.test(nombre) ? null
  : /^is[A-Z]/.test(nombre)      ? false
  : undefined

// El pane de Leaflet se llama `leaflet-<nombre>-pane`: de ahí sale el nombre con que el motor lo montó.
const nombrePane = el => el
  ? /\bleaflet-([\w-]+)-pane\b/.exec(el.className)?.[1] ?? String(el.className || el.tagName)
  : '?'

export const crearNavegador = ({
  techo       = 16,
  politica    = 'creacion',
  estricto    = true,
  Evento      = globalThis.Event,
  crearGl     = () => makeEditGl(),
  crearCanvas = () => ({}),
} = {}) => {
  if (!CRITERIO[politica]) throw new RangeError(`[navegador-falso] política desconocida: ${politica}`)

  const entradas  = []                    // todos los contextos GL, en orden de creación
  const porCanvas = new WeakMap()
  const planos    = new WeakSet()
  const cola      = []                    // eventos que ya ocurrieron y todavía no se despacharon
  let programado  = false
  let serie       = 0
  let reloj       = 0

  const nav = {
    techo, politica, estricto,
    contextos   : entradas,
    avisos      : [],                     // lo que Chromium dice por consola
    violaciones : [],                     // usos de un recurso ajeno o de una época anterior
    liberados   : 0,
    desalojados : 0,
    restaurados : 0,
    pico        : 0,
    get creados()    { return entradas.length },
    get vivos()      { return entradas.filter(e => e.estado === 'vivo').length },
    get pendientes() { return cola.length },
  }

  /* ── Eventos: ocurren ya, se oyen después ── */

  const emitir = (entrada, tipo) => {
    const evento = new Evento(tipo, { cancelable: tipo === 'webglcontextlost' })
    tipo === 'webglcontextlost' && (entrada.eventoPerdida = evento)
    entrada.canvas.dispatchEvent?.(evento)
  }

  const drenar = () => {
    let n = 0
    for (; cola.length; n++) cola.shift()()
    return n
  }

  const programar = fn => {
    cola.push(fn)
    if (programado) return
    programado = true
    setTimeout(() => { programado = false; drenar() }, 0)
  }

  // El pane del canvas se lee mientras está colgado: `destroy()` lo saca del DOM antes de soltar el contexto.
  const ubicar = entrada => {
    const padre = entrada.canvas.parentNode
    padre?.nodeType === 1 && (entrada.paneEl = padre)
    return entrada.paneEl
  }

  /* ── Pérdida, cupo y restauración ── */

  const perder = (entrada, causa) => {
    ubicar(entrada)
    entrada.estado        = 'perdido'
    entrada.causa         = causa
    entrada.eventoPerdida = null
    entrada.epoca++
    programar(() => emitir(entrada, 'webglcontextlost'))
  }

  // Tomar un cupo: si con éste se pasa del techo, cae el que la política elige entre los otros vivos.
  const tomarCupo = entrada => {
    const campo = CRITERIO[nav.politica]
    if (!campo) throw new RangeError(`[navegador-falso] política desconocida: ${nav.politica}`)
    while (nav.vivos > nav.techo) {
      const victima = entradas.reduce((v, e) =>
        e !== entrada && e.estado === 'vivo' && (!v || e[campo] < v[campo]) ? e : v, null)
      if (!victima) break
      nav.avisos.push(AVISO_TECHO)
      nav.desalojados++
      perder(victima, 'desalojo')
    }
    nav.pico = Math.max(nav.pico, nav.vivos)
  }

  const liberar = entrada => {
    if (entrada.estado === 'perdido') {
      nav.avisos.push('INVALID_OPERATION: loseContext: context already lost')
      return
    }
    nav.liberados++
    perder(entrada, 'liberado')
  }

  const restaurar = entrada => {
    const rechazo =
      entrada.estado !== 'perdido'                       ? 'el contexto no está perdido'
      : !entrada.eventoPerdida                           ? 'hay que esperar a webglcontextlost'
      : !entrada.eventoPerdida.defaultPrevented          ? 'context restoration not allowed'
      : entrada.restaurando                              ? 'ya hay una restauración en curso'
      : null
    if (rechazo) {
      nav.avisos.push(`INVALID_OPERATION: restoreContext: ${rechazo}`)
      return
    }
    entrada.restaurando = true
    programar(() => {
      entrada.restaurando = false
      entrada.estado      = 'vivo'
      entrada.causa       = null
      entrada.serie       = ++serie                // reingresa como el más nuevo
      entrada.ultimoUso   = ++reloj
      nav.restaurados++
      tomarCupo(entrada)
      emitir(entrada, 'webglcontextrestored')
    })
  }

  /* ── El gl de un contexto: el doble del repo, con lo que el navegador le agrega ── */

  // Un recurso nace sellado con el contexto y la época que lo crearon. Usarlo con otro contexto, o con el mismo
  // después de perderse, lanza (salvo borrarlo).
  const validar = (entrada, nombre, args) => {
    if (BORRAR.test(nombre)) return
    for (const a of args) {
      const sello = a !== null && typeof a === 'object' ? a[MARCA] : undefined
      if (!sello || (sello.entrada === entrada && sello.epoca === entrada.epoca)) continue
      const porque = sello.entrada !== entrada
        ? `es del contexto #${sello.entrada.id} y éste es el #${entrada.id}`
        : `nació en la época ${sello.epoca} y la del contexto #${entrada.id} es la ${entrada.epoca}: se perdió`
      nav.violaciones.push({ contexto: entrada.id, metodo: nombre, porque })
      if (nav.estricto) throw new Error(`[navegador-falso] ${nombre}() con un recurso que ${porque}`)
    }
  }

  const metodo = (entrada, nombre, original) => {
    if (nombre === 'getExtension')
      return ext => entrada.estado === 'perdido' ? null
        : ext === 'WEBGL_lose_context' ? entrada.extension : original(ext)
    return (...args) => {
      validar(entrada, nombre, args)
      if (entrada.estado === 'perdido') {
        entrada.llamadasTrasPerdida++
        return neutro(nombre)
      }
      entrada.paneEl || ubicar(entrada)
      USOS.has(nombre) && (entrada.ultimoUso = ++reloj)
      const resultado = original(...args)
      NACE.test(nombre) && resultado !== null && typeof resultado === 'object'
        && Object.defineProperty(resultado, MARCA, { value: { entrada, epoca: entrada.epoca }, configurable: true })
      return resultado
    }
  }

  const envolver = (entrada, base) => {
    const metodos = Object.create(null)
    return new Proxy(base, { get: (t, p) => {
      if (typeof p === 'symbol') return t[p]
      if (p === 'isContextLost') return () => entrada.estado === 'perdido'
      if (p === 'canvas') return entrada.canvas
      if (p === 'drawingBufferWidth' || p === 'drawingBufferHeight') return entrada.estado === 'perdido' ? 0 : t[p]
      const valor = t[p]
      return typeof valor === 'function' ? (metodos[p] ??= metodo(entrada, p, valor)) : valor
    } })
  }

  /* ── API ── */

  // `canvas.getContext(kind, attrs)`. El mismo canvas con el mismo tipo devuelve el mismo contexto (los atributos
  // nuevos se ignoran, como en el navegador); con otro tipo, null.
  nav.getContext = (canvas, kind, attrs) => {
    const previo = porCanvas.get(canvas)
    if (previo) return previo.kind === kind ? previo.gl : null
    if (planos.has(canvas)) return null
    if (PLANO.has(kind)) {
      planos.add(canvas)
      return NOOP_CTX
    }
    if (!GL.has(kind)) return null

    const entrada = {
      canvas, kind, attrs,
      id                  : entradas.length,
      ajeno               : false,
      estado              : 'vivo',       // 'vivo' | 'perdido'
      causa               : null,         // por qué se perdió: 'desalojo' | 'liberado'
      epoca               : 0,            // sube con cada pérdida: los recursos de una época anterior no sirven
      serie               : ++serie,
      ultimoUso           : ++reloj,
      eventoPerdida       : null,
      restaurando         : false,
      llamadasTrasPerdida : 0,
      paneEl              : null,
      get pane() { return nombrePane(ubicar(this)) },
    }
    entrada.extension = { loseContext: () => liberar(entrada), restoreContext: () => restaurar(entrada) }
    entrada.gl        = envolver(entrada, crearGl(canvas))
    entradas.push(entrada)
    porCanvas.set(canvas, entrada)
    tomarCupo(entrada)
    return entrada.gl
  }

  // Un contexto que no es de la librería (un panorama de Street View, otro widget): ocupa cupo y compite por él.
  nav.ajeno = (canvas = crearCanvas()) => {
    nav.getContext(canvas, 'webgl2')
    const entrada = porCanvas.get(canvas)
    entrada.ajeno = true
    return entrada
  }

  // El navegador le quita el contexto a uno (otra pestaña, un reset de GPU), sin que se pase del techo.
  nav.desalojar = entrada => {
    if (entrada.estado !== 'vivo') return false
    nav.desalojados++
    perder(entrada, 'desalojo')
    return true
  }

  // Despacha ya los eventos que llegarían en la próxima tarea. Devuelve cuántos.
  nav.vaciar = drenar

  nav.stat = () => ({
    creados: nav.creados, vivos: nav.vivos, liberados: nav.liberados, desalojados: nav.desalojados, pico: nav.pico,
  })

  nav.resumen = () => Object.entries(nav.stat()).map(([k, v]) => `${k} ${v}`).join(' ')

  nav.desinstalar = () => {}

  return nav
}

/* ── Enchufes ── */

const instalados = new WeakMap()                   // document → navegador: un registro por documento

export const navegadorDe = document => instalados.get(document)

// jsdom: todo canvas del `window` pide su contexto al registro del documento. Instalar de nuevo sobre el mismo
// documento reemplaza al anterior.
export const instalarNavegador = (window, opciones) => {
  navegadorDe(window.document)?.desinstalar()
  const navegador = crearNavegador({ Evento: window.Event, crearCanvas: () => window.document.createElement('canvas'), ...opciones })
  const proto     = window.HTMLCanvasElement.prototype
  const original  = proto.getContext
  proto.getContext = function (kind, attrs) { return navegador.getContext(this, kind, attrs) }
  navegador.desinstalar = () => {
    proto.getContext = original
    instalados.delete(window.document)
  }
  instalados.set(window.document, navegador)
  return navegador
}

// El `document` del shim de engine-stub: los canvases que fabrica piden su contexto al registro. Devuelve la
// restauración, como `decorarElementos`.
export const conNavegador = navegador => decorarElementos((el, tag) => {
  tag === 'canvas' && (el.getContext = (kind, attrs) => navegador.getContext(el, kind, attrs))
  return el
})
