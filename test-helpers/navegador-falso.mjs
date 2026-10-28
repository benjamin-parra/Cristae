// Navegador falso: las reglas de los contextos WebGL de un proceso de render de Chromium, puestas sobre el doble de
// GL del repo (`makeEditGl`, que ya registra lo que una capa sube, dibuja y lee). No es un GL paralelo: cada
// contexto ES un `makeEditGl` envuelto, y lo que agrega es lo que ese doble no sabe, que es lo que un desalojo
// le hace a una capa. Las reglas salen de medirlas en un Chromium headless real (etapa0/ORACULO.md); lo que
// sólo sale de la especificación de WebGL va marcado [especificación].
//
//   · Techo de contextos vivos por PROCESO de render (16). Crear el siguiente desaloja a uno: el que lleva más
//     tiempo sin `flush()` ni `finish()`. La creación cuenta como el primer flush, y entre los nunca vaciados
//     manda el orden de creación. Dibujar, `readPixels`, subir datos, `getParameter` y `getError` NO renuevan
//     nada. La política 'creacion' (cae el más viejo por creación) queda sólo para contrastar.
//   · Perdido = `isContextLost()` verdadero YA, y `webglcontextlost` DESPUÉS, en otra tarea, cancelable. Sobre
//     un perdido `getExtension` devuelve null, `drawingBufferWidth` es 0, `getContextAttributes` es null,
//     `getError` es 37442 y `clientWaitSync` es WAIT_FAILED; `create*` devuelve null y el resto de las
//     llamadas no hacen nada (no llegan al espía del doble: una capa que dibuja sobre un perdido no se nota
//     en `gl.spy`, se nota en `llamadasTrasPerdida`). Del resto de las respuestas no hay oráculo, salen de la
//     especificación: `getError` da 37442 sólo la primera vez tras la pérdida y NO_ERROR después,
//     `getAttribLocation` y `getFragDataLocation` dan -1, `checkFramebufferStatus` da FRAMEBUFFER_UNSUPPORTED
//     [especificación].
//   · Un perdido no cuenta contra el techo. `loseContext()` libera el cupo en el acto —soltar uno y crear
//     otro en la misma pila no desaloja a nadie—, y el evento llega después.
//   · `restoreContext()` sólo restaura si el evento ya llegó y se canceló con `preventDefault()`; si no,
//     avisa y no hace nada. Restaurar toma un cupo (puede desalojar a otro), conserva el MISMO `gl` y deja
//     inválidos los recursos de antes.
//   · Un canvas 2D no cuenta. Pedir otro tipo de contexto a un canvas ya tomado da null; pedir el mismo da el
//     mismo.
//   · `drawingBufferWidth` y `drawingBufferHeight` siguen al `width` y al `height` del canvas, vivos: un
//     contenedor de 0×0 da un buffer de 0×0.
//
// El buffer enlazado a ARRAY_BUFFER se anota por contexto (`bindBuffer`, y `deleteBuffer` del que está enlazado lo
// suelta), y `vertexAttribPointer` o `vertexAttribIPointer` sin ninguno y con un offset distinto de 0 es
// INVALID_OPERATION en WebGL [especificación; Chromium: «no ARRAY_BUFFER is bound and offset is non-zero»]. El
// doble lo trata como un recurso mal usado: la llamada no hace nada, queda en `violaciones` (con `perdido: false`),
// el contexto retiene el error hasta que `getError()` lo lee, y con `estricto` lanza. Un VAO armado sobre un VBO que
// todavía no existe (`linkPointProgram(gl, null)`) cae acá.
//
// Las épocas son un rigor del doble, no de Chromium (que sólo marca INVALID_OPERATION): un recurso (programa,
// shader, buffer, textura, VAO, framebuffer, fence, ubicación de uniform) nace en un contexto y en una época,
// y se pierde con ella. Dónde se nota su uso inválido:
//
//   · Sobre un contexto PERDIDO no lanza, como Chromium, que no hace nada: la llamada queda contada en
//     `llamadasTrasPerdida` y, si traía un recurso de antes, marcada en `violaciones` con `perdido: true`. Así
//     una capa que no consulta `isContextLost()` se ve en las cifras sin que el doble la corte, y el orden
//     entre el desalojo y el evento (un rAF puede llegar antes) no cambia el resultado.
//   · Sobre un contexto VIVO lanza, y queda en `violaciones`: es el recurso de otro contexto, o el de una
//     época anterior sobre un contexto restaurado. Es un defecto de la capa (un `gl` reemplazado a medias, o
//     recursos que no se re-crearon al restaurar) y tiene que verse.
//   · Borrar nunca lanza (en Chromium es un no-op, y el teardown de una capa perdida lo hace).
//
// `estricto: false` no lanza nunca y deja todo en `violaciones`.
//
// Un registro por PROCESO de render: el techo no es del documento ni del mapa. Un mismo navegador se comparte
// entre varias ventanas con `instalarNavegador(window, { navegador })`, y se reparte así [medido,
// etapa0/salidas/techo-pagina-*.txt]:
//
//   · iframe del mismo sitio, popup con `opener`, portal   → un navegador para todos.
//   · popup `noopener`                                    → otro navegador (proceso aparte).
//   · iframe de otro sitio                                → compartido sin aislamiento de sitios
//     (Chromium 151); aparte con aislamiento (155).
//
// `instalarNavegador(window)` cuelga el registro de `HTMLCanvasElement.prototype.getContext` (jsdom);
// `conNavegador(navegador)` lo cuelga de los canvases que fabrica el `document` del shim, con eventos reales.
//
//   const navegador = instalarNavegador(window, { techo: 16 })
//   …montar…
//   navegador.stat()   // { creados, vivos, liberados, desalojados, pico }

import { conEventos, decorarElementos, makeEditGl, NOOP_CTX } from './engine-stub.mjs'

const GL                      = new Set(['webgl', 'webgl2', 'experimental-webgl'])
const PLANO                   = new Set(['2d', 'bitmaprenderer'])
const CRITERIO                = { creacion: 'serie', ultimoUso: 'ultimoUso' }    // qué campo manda en cada política
const NO_ERROR                = 0
const CONTEXT_LOST_WEBGL      = 37442
const INVALID_OPERATION       = 0x0502
const FRAMEBUFFER_COMPLETE    = 0x8CD5
const FRAMEBUFFER_UNSUPPORTED = 0x8CDD
const WAIT_FAILED             = 0x911D
const AVISO_TECHO             = 'WARNING: Too many active WebGL contexts. Oldest context will be lost.'

// Lo único que renueva un contexto ante el techo [medido]: vaciar la cola de comandos.
const USOS = new Set(['flush', 'finish'])

// Las llamadas que leen el buffer enlazado a ARRAY_BUFFER, y la posición de su offset entre los argumentos.
const PUNTEROS = new Map([['vertexAttribPointer', 5], ['vertexAttribIPointer', 4]])

// Constantes que el doble base no define (ahí caen a un no-op): sin ellas `gl.getError() === gl.NO_ERROR` no se
// puede escribir.
const ENUMS = new Map([
  ['NO_ERROR', NO_ERROR], ['CONTEXT_LOST_WEBGL', CONTEXT_LOST_WEBGL], ['INVALID_OPERATION', INVALID_OPERATION],
  ['FRAMEBUFFER_COMPLETE', FRAMEBUFFER_COMPLETE], ['FRAMEBUFFER_UNSUPPORTED', FRAMEBUFFER_UNSUPPORTED],
])

const LADO      = new Map([['drawingBufferWidth', 'width'], ['drawingBufferHeight', 'height']])
const MENOS_UNO = new Set(['getAttribLocation', 'getFragDataLocation'])

// Lo que contesta un contexto vivo cuando el doble base no sabe (devuelve un objeto no-op).
const VIVO = new Map([['getError', NO_ERROR], ['checkFramebufferStatus', FRAMEBUFFER_COMPLETE]])

const MARCA  = Symbol('contexto y época de un recurso GL')
const NACE   = /^(create[A-Z]|fenceSync$|getUniformLocation$)/   // devuelven un recurso que pertenece al contexto
const BORRAR = /^delete[A-Z]/

// La especificación da CONTEXT_LOST_WEBGL una sola vez tras la pérdida; las llamadas siguientes dan NO_ERROR.
const errorDePerdida = entrada => {
  if (entrada.errorAvisado) return NO_ERROR
  entrada.errorAvisado = true
  return CONTEXT_LOST_WEBGL
}

// Qué devuelve una llamada sobre un contexto perdido: lo que Chromium, que no hace nada y contesta «nada».
const neutro = (entrada, nombre) =>
  nombre === 'getError'                 ? errorDePerdida(entrada)
  : nombre === 'clientWaitSync'         ? WAIT_FAILED
  : nombre === 'checkFramebufferStatus' ? FRAMEBUFFER_UNSUPPORTED
  : MENOS_UNO.has(nombre)               ? -1
  : /^(create[A-Z]|fenceSync$|get[A-Z])/.test(nombre) ? null
  : /^is[A-Z]/.test(nombre)             ? false
  : undefined

// El pane de Leaflet se llama `leaflet-<nombre>-pane`: de ahí sale el nombre con que el motor lo montó. El
// nombre puede traer `:` (los panes del cluster: `cristae-point-cluster-3:spider`).
const nombrePane = el => el
  ? /(?:^|\s)leaflet-(\S+)-pane(?=\s|$)/.exec(el.className)?.[1] ?? String(el.className || el.tagName)
  : '?'

export const crearNavegador = ({
  techo       = 16,
  politica    = 'ultimoUso',
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
    victimas    : [],                     // ids de los desalojados, en el orden en que cayeron
    enchufes    : new Map(),              // document → cómo desengancharlo (ver instalarNavegador)
    liberados   : 0,
    desalojados : 0,
    restaurados : 0,
    pico        : 0,
    get creados()    { return entradas.length },
    get vivos()      { return entradas.filter(e => e.estado === 'vivo').length },
    get pendientes() { return cola.length },
  }

  /* ── Eventos: ocurren ya, se oyen después ── */

  // El evento nace del realm del canvas (la ventana que lo creó), no del navegador: con uno compartido entre
  // ventanas, cada canvas oye eventos de su propia ventana.
  const emitir = (entrada, tipo) => {
    const Nace   = entrada.canvas.ownerDocument?.defaultView?.Event ?? Evento
    const evento = new Nace(tipo, { cancelable: tipo === 'webglcontextlost' })
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
    entrada.errorAvisado  = false
    entrada.arrayBuffer   = null
    entrada.errorGl       = NO_ERROR
    entrada.epoca++
    programar(() => emitir(entrada, 'webglcontextlost'))
  }

  const desalojo = entrada => {
    nav.desalojados++
    nav.victimas.push(entrada.id)
    perder(entrada, 'desalojo')
  }

  // Tomar un cupo: si con éste se pasa del techo, cae el que la política elige entre los otros vivos. Con
  // 'ultimoUso' es el de flush más antiguo; la creación y la restauración son el primer flush, así que el
  // recién llegado nunca es la víctima de su propio cupo.
  const tomarCupo = entrada => {
    const campo = CRITERIO[nav.politica]
    if (!campo) throw new RangeError(`[navegador-falso] política desconocida: ${nav.politica}`)
    while (nav.vivos > nav.techo) {
      const victima = entradas.reduce((v, e) =>
        e !== entrada && e.estado === 'vivo' && (!v || e[campo] < v[campo]) ? e : v, null)
      if (!victima) break
      nav.avisos.push(AVISO_TECHO)
      desalojo(victima)
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
  // después de perderse, es un uso inválido (salvo borrarlo). Sobre un contexto vivo lanza; sobre uno perdido
  // sólo queda marcado, porque Chromium no hace nada y la llamada ya se cuenta en `llamadasTrasPerdida`.
  const validar = (entrada, nombre, args) => {
    if (BORRAR.test(nombre)) return
    for (const a of args) {
      const sello = a !== null && typeof a === 'object' ? a[MARCA] : undefined
      if (!sello || (sello.entrada === entrada && sello.epoca === entrada.epoca)) continue
      const porque = sello.entrada !== entrada
        ? `es del contexto #${sello.entrada.id} y éste es el #${entrada.id}`
        : `nació en la época ${sello.epoca} y la del contexto #${entrada.id} es la ${entrada.epoca}: se perdió`
      const perdido = entrada.estado === 'perdido'
      nav.violaciones.push({ contexto: entrada.id, metodo: nombre, porque, perdido })
      if (nav.estricto && !perdido) throw new Error(`[navegador-falso] ${nombre}() con un recurso que ${porque}`)
    }
  }

  // Un puntero de atributos sin buffer enlazado: INVALID_OPERATION. La llamada no llega al doble base (en Chromium no
  // hace nada), el error queda pendiente para `getError()` y la violación en el registro; con `estricto` lanza.
  const sinBuffer = (entrada, nombre, args) => {
    const porque = `se llamó sin buffer enlazado a ARRAY_BUFFER y con el offset ${args[PUNTEROS.get(nombre)]}: INVALID_OPERATION`
    entrada.errorGl ||= INVALID_OPERATION                 // WebGL retiene el primer error hasta que se lee
    nav.violaciones.push({ contexto: entrada.id, metodo: nombre, porque, perdido: false })
    if (nav.estricto) throw new Error(`[navegador-falso] ${nombre}() ${porque}`)
  }

  const metodo = (entrada, nombre, original) => {
    if (nombre === 'getExtension')
      return ext => entrada.estado === 'perdido' ? null
        : ext === 'WEBGL_lose_context' ? entrada.extension : original(ext)
    return (...args) => {
      validar(entrada, nombre, args)
      if (entrada.estado === 'perdido') {
        entrada.llamadasTrasPerdida++
        return neutro(entrada, nombre)
      }
      entrada.paneEl || ubicar(entrada)
      USOS.has(nombre) && (entrada.ultimoUso = ++reloj)
      if (PUNTEROS.has(nombre) && !entrada.arrayBuffer && args[PUNTEROS.get(nombre)]) return sinBuffer(entrada, nombre, args)
      nombre === 'bindBuffer'   && args[0] === entrada.gl.ARRAY_BUFFER && (entrada.arrayBuffer = args[1] ?? null)
      nombre === 'deleteBuffer' && args[0] === entrada.arrayBuffer     && (entrada.arrayBuffer = null)
      const resultado = original(...args)
      if (nombre === 'getError' && entrada.errorGl) {
        const pendiente = entrada.errorGl
        entrada.errorGl = NO_ERROR
        return pendiente
      }
      if (VIVO.has(nombre)) return typeof resultado === 'number' ? resultado : VIVO.get(nombre)
      NACE.test(nombre) && resultado !== null && typeof resultado === 'object'
        && Object.defineProperty(resultado, MARCA, { value: { entrada, epoca: entrada.epoca }, configurable: true })
      return resultado
    }
  }

  // El buffer de dibujo mide lo que mide el canvas ahora, no lo que medía al crearse el contexto. Un canvas sin
  // `width` numérico (un objeto pelado de un test) deja la medida del doble base.
  const envolver = (entrada, base) => {
    const metodos = new WeakMap()   // por función, no por nombre: un `mock.method` puesto después de usarla se ve
    return new Proxy(base, { get: (t, p) => {
      if (typeof p === 'symbol') return t[p]
      if (p === 'isContextLost') return () => entrada.estado === 'perdido'
      if (p === 'canvas') return entrada.canvas
      if (LADO.has(p)) return entrada.estado === 'perdido' ? 0 : entrada.canvas[LADO.get(p)] ?? t[p]
      if (ENUMS.has(p)) return ENUMS.get(p)
      const valor = t[p]
      return typeof valor === 'function' ? metodos.get(valor) ?? metodos.set(valor, metodo(entrada, p, valor)).get(valor) : valor
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
      documento           : canvas.ownerDocument ?? null,     // la ventana que lo creó; null en un canvas pelado
      ajeno               : false,
      estado              : 'vivo',       // 'vivo' | 'perdido'
      causa               : null,         // por qué se perdió: 'desalojo' | 'liberado'
      epoca               : 0,            // sube con cada pérdida: los recursos de una época anterior no sirven
      serie               : ++serie,
      ultimoUso           : ++reloj,      // el reloj de su último flush; la creación es el primero
      eventoPerdida       : null,
      errorAvisado        : false,        // getError ya dio CONTEXT_LOST_WEBGL en esta pérdida
      arrayBuffer         : null,         // el buffer enlazado a ARRAY_BUFFER: lo que lee vertexAttribPointer
      errorGl             : NO_ERROR,     // el error que el contexto retiene hasta que getError() lo lee
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
    desalojo(entrada)
    return true
  }

  // Despacha ya los eventos que llegarían en la próxima tarea. Devuelve cuántos.
  nav.vaciar = drenar

  nav.stat = () => ({
    creados: nav.creados, vivos: nav.vivos, liberados: nav.liberados, desalojados: nav.desalojados, pico: nav.pico,
  })

  nav.resumen = () => Object.entries(nav.stat()).map(([k, v]) => `${k} ${v}`).join(' ')

  // Sin argumento suelta todas las ventanas en que está instalado; con un `document`, sólo esa.
  nav.desinstalar = documento => {
    const sueltos = documento ? [documento] : [...nav.enchufes.keys()]
    sueltos.forEach(d => {
      nav.enchufes.get(d)?.()
      nav.enchufes.delete(d)
    })
  }

  return nav
}

/* ── Enchufes ── */

const instalados = new WeakMap()                   // document → navegador: el proceso de render al que pertenece

export const navegadorDe = document => instalados.get(document)

// jsdom: todo canvas del `window` pide su contexto al registro. Instalar de nuevo sobre el mismo documento
// reemplaza al anterior. Con `{ navegador }` la ventana se une a un navegador que ya existe (un iframe del
// mismo sitio, un popup con opener, un portal): comparten el techo y se desalojan entre sí.
export const instalarNavegador = (window, { navegador = null, ...opciones } = {}) => {
  const { document }  = window
  const { prototype } = window.HTMLCanvasElement
  navegadorDe(document)?.desinstalar(document)
  const nav      = navegador ?? crearNavegador({ Evento: window.Event, crearCanvas: () => document.createElement('canvas'), ...opciones })
  const original = prototype.getContext
  prototype.getContext = function (kind, attrs) { return nav.getContext(this, kind, attrs) }
  instalados.set(document, nav)
  nav.enchufes.set(document, () => {
    prototype.getContext = original
    instalados.delete(document)
  })
  return nav
}

// El `document` del shim de engine-stub: los canvases que fabrica piden su contexto al registro y oyen eventos
// de verdad (`webglcontextlost` les llega). Devuelve la restauración, como `decorarElementos`.
export const conNavegador = navegador => decorarElementos((el, tag) => {
  if (tag !== 'canvas') return el
  conEventos(el)
  el.getContext = (kind, attrs) => navegador.getContext(el, kind, attrs)
  return el
})
