// Cuándo una superficie GL propia toma su contexto y cuándo lo suelta. El registro es del módulo —del realm—, no del mapa
// ni del documento: el techo de contextos vivos es del proceso de render (16 en Chromium), y lo comparten los mapas de la
// página y los de las ventanas donde el mismo JS monta por portal.
//
// Tomar un contexto cuesta más que un cuadro (getContext 18–55 ms en Chromium, 180–380 ms en Firefox): nada se toma de
// forma especulativa en un gesto, y nada se suelta por tiempo, sólo bajo presión de cupo y al destruir. La política tiene
// tres capas: lo que avisan las superficies y el motor (alta, contexto tomado, perdido, soltado, contenido, gesto), la
// decisión, y el efecto, que es tomar o soltar de a una superficie.
//
//   · Alta. Una capa con contenido toma su contexto al construirse. Una vacía deja un marcador en su pane y se toma en un
//     momento ocioso, de a una por ranura y por prioridad; si recibe contenido antes, en esa tarea.
//   · Necesaria es la que se ve y tiene algo que dibujar (o un editor con un trazo o un gesto vivo); prescindible, la
//     que no. Perder una necesaria es presión: se sueltan en el acto las prescindibles, y la perdida vuelve en un cuadro
//     siguiente. Una prescindible perdida queda soltada, y vuelve cuando se la necesita.
//   · Recuperar: una por cuadro, la de mayor z primero, nunca con un mapa del realm en pleno gesto. El dato que llega a
//     una perdida no la adelanta: espera su cuadro. Volver a tomar por un aviso de la dueña —mostrar una soltada, darle
//     contenido— es en esa tarea si es la primera toma desde el último cuadro; si no, va a la cola. Si falla (WebGL
//     bloqueado), queda soltada, el error sale por consola y no se insiste hasta que otro contexto del realm se logre.
//   · Saturación, sin relojes ni ratos ociosos. Sin prescindibles, si tomar una propia hace perder otra propia —en el
//     acto—, o si una que la política tomó vuelve a perderse antes de una señal de cupo —un ajeno que se rehace—, la de
//     menor z queda sin superficie y no se insiste. Vuelve ante una señal de cupo (una propia que se suelta o se
//     destruye, la pestaña que vuelve a verse, `invalidateCanvas()`) y en dos reintentos.
//   · Pérdida masiva (un reinicio de la GPU: varias propias a la vez sin una adquisición propia que lo explique): vuelven
//     todas las necesarias, de a una por cuadro y por prioridad.
//   · Orden de desalojo. Chromium desaloja al contexto de `flush` más viejo, y un `flush` sin comandos pendientes también
//     lo renueva (etapa3/FLUSH.md). Cuando la política toma una prescindible, cada necesaria viva vacía su cola por z
//     ascendente: las prescindibles quedan como las más viejas y, entre las necesarias, cae primero la de menor z. Desde
//     la primera pérdida de un contexto propio, también tras toda adquisición de la política, al asentar un montaje y
//     cuando una viva pasa a necesaria (recibe contenido, o se vuelve a ver). Antes no: lejos del techo el orden entre
//     necesarias no se usa, y cada `flush` es un viaje al proceso de la GPU (16 µs en Chromium, 77 µs en Firefox) que
//     poblar una capa o abrir una espiral pagarían por nada. Por evento, nunca por cuadro.
//   · El registro no retiene a nadie: una superficie que nadie destruye se recolecta, y la de un documento sin ventana
//     (un popup que se cerró sin desmontar su mapa) no es necesaria.

const IDLE_MS   = 1000              // tope de espera de una ranura ociosa
const MOTION_MS = 10_000            // un gesto sin su fin deja de contar: un `moveend` perdido no frena la recuperación
const RETRIES   = [5000, 30_000]    // los reintentos de una saturación, además de las señales de cupo

const members = new WeakMap()       // superficie → { order, ref }: el orden de alta desempata la prioridad
const roster  = new Set()           // la WeakRef de cada dada de alta: lo que se recorre
const wanted  = new Set()           // necesarias sin contexto que la política toma, de a una por cuadro
const idle    = new Set()           // vacías al construirse, que se toman en un momento ocioso
const starved = new Set()           // necesarias que la saturación dejó sin superficie: esperan cupo
const movers  = new Map()           // motor en pleno gesto → desde cuándo

let episode    = new WeakSet()      // las que la política volvió a tomar desde la última señal de cupo: la tanda
let fresh      = new WeakSet()      // las necesarias que vaciaron su cola en la última renovación
let blamed     = new WeakMap()      // propia desalojada en el acto por una adquisición de la política → esa adquisición
let joined     = new WeakSet()      // las que tomaron el suyo por su cuenta desde el último rato ocioso, sin presión
let order      = 0
let frame      = 0
let idleId     = 0
let retryId    = 0
let retryStep  = 0
let motionId   = 0
let pumping    = null               // la que la política está tomando: su aviso de contexto tomado no es un alta
let deciding   = false              // la política suelta: no es una señal de cupo
let settle     = false              // al reposo se ordena el desalojo
let joining    = false              // hubo altas sin presión: al reposo se ordena si alguna no se ve
let capable    = false              // algún contexto del realm se logró, y el último intento no falló
let measured   = false
let maxTexture = null
let warned     = false
let listening  = false
let took       = false              // un aviso ya volvió a tomar una desde el último cuadro: otro aviso espera al siguiente
let pressed    = false              // el realm ya perdió un contexto propio: desde ahí se cuida el orden de desalojo

const now = () => performance.now()

// La prioridad es la z del pane y, a igual z, la dada de alta después, que en un pane compartido queda encima.
const below   = (a, b) => a.z < b.z || (a.z === b.z && members.get(a).order < members.get(b).order)
const lowest  = list => list.reduce((m, s) => !m || below(s, m) ? s : m, null)
const highest = list => list.reduce((m, s) => !m || below(m, s) ? s : m, null)

// Las dadas de alta que siguen en memoria; la que el GC ya se llevó sale del registro.
const registered = () => {
  const list = []
  roster.forEach(ref => {
    const s = ref.deref()
    s ? list.push(s) : roster.delete(ref)
  })
  return list
}

const live        = () => registered().filter(s => s.state === 'live')
// Perdidas que todavía no avisaron: el navegador lo sabe en el acto, y el evento llega en otra tarea.
const unprocessed = () => registered().filter(s => s.gl?.isContextLost())

// Ningún mapa del realm en pleno gesto: un getContext ahí cae en el cuadro más sensible de cualquiera de ellos. Lo que
// espera no agenda cuadros: lo retoma el fin del gesto, o el plazo de un gesto que nunca avisó su fin.
const quiet = () => {
  movers.forEach((since, engine) => now() - since > MOTION_MS && movers.delete(engine))
  if (!movers.size) return true
  motionId ||= setTimeout(() => {
    motionId = 0
    wanted.size && schedule()
    idle.size && askIdle()
  }, MOTION_MS)
  motionId.unref?.()
  return false
}

const schedule = () => frame ||= requestAnimationFrame(pump)
const askIdle  = () => idleId ||= globalThis.requestIdleCallback
  ? requestIdleCallback(rest, { timeout: IDLE_MS })
  : setTimeout(rest, 0)

// Cada necesaria viva vacía su cola, por z ascendente: la última en hacerlo es la última en caer.
const renew = () => {
  fresh = new WeakSet()
  live().filter(s => s.needed).sort((a, b) => below(a, b) ? -1 : 1).forEach(s => {
    s.gl.flush()
    fresh.add(s)
  })
}

// El orden se rehace en el próximo rato ocioso, una vez por tanda de avisos.
const resettle = () => {
  settle = true
  askIdle()
}

// Soltar por decisión propia no es una señal de cupo.
const drop = s => {
  deciding = true
  try {
    s.release()
  } finally {
    deciding = false
  }
}

// El efecto: toma el contexto de `s`, anota a qué propia desalojó en el acto —la de `flush` más viejo, cuyo aviso llega
// en otra tarea— y renueva el orden de desalojo si hace falta: desde la primera presión, siempre; antes, sólo si la
// tomada no se ve con contenido, que si no nace como la más joven y es necesaria. Si ya lo había tenido, es una vuelta:
// entra en la tanda.
const take = s => {
  const antes  = unprocessed()
  const previa = pumping
  const vuelta = s.attached
  wanted.delete(s)
  idle.delete(s)
  pumping = s
  try {
    s.acquire()
  } catch (error) {
    drop(s)                         // la que no se pudo rearmar no se queda con un cupo
    throw error
  } finally {
    pumping = previa
  }
  vuelta && episode.add(s)
  unprocessed().forEach(v => antes.includes(v) || blamed.set(v, s))
  ;(pressed || !s.needed) && renew()
  return true
}

const saturated = () => {
  warned || console.warn('[cristae] el techo de contextos WebGL está lleno: una capa visible queda sin superficie hasta ' +
    'que haya cupo (engine.surfaces() dice cuál)')
  warned = true
  listening || globalThis.document?.addEventListener?.('visibilitychange', () =>
    document.visibilityState === 'visible' && glBudget.retry())
  listening = true
  if (retryId || retryStep >= RETRIES.length) return
  retryId = setTimeout(() => glBudget.retry(), RETRIES[retryStep++])
  retryId.unref?.()                 // en node, un reintento pendiente no retiene el proceso
}

// Sin superficie hasta que haya cupo. La que todavía lo tiene se suelta.
const starve = s => {
  wanted.delete(s)
  idle.delete(s)
  s.state === 'released' || drop(s)
  starved.add(s)
  saturated()
}

// `s` se perdió y no hay cupo: queda sin superficie la de menor z entre ella y las necesarias vivas. A igual z no se
// cambia una por otra, que costaría un getContext por nada. Lo que esperaba su turno pasa a esperar cupo.
const saturate = s => {
  const menor = lowest(live().filter(m => m.needed))
  wanted.forEach(w => w === s || starve(w))
  if (menor && menor.z < s.z) {
    starve(menor)
    wanted.add(s)
    schedule()
    return 'lost'
  }
  starved.add(s)
  saturated()
  return 'released'
}

// Bajo presión se sueltan las prescindibles: las vivas devuelven su cupo en el acto, y las vacías que esperaban un momento
// ocioso ya no se toman. Devuelve cuántos cupos liberó.
const shed = () => {
  const sueltas = live().filter(s => !s.needed)
  idle.forEach(drop)
  sueltas.forEach(drop)
  return sueltas.length
}

// Un cuadro de recuperación: libera la toma por aviso del cuadro anterior, procesa las pérdidas que el navegador ya
// hizo y toma la necesaria de mayor z. La siguiente se agenda antes de tomar: si ésta tira, las demás no pierden su turno.
const pump = () => {
  frame = 0
  took  = false
  unprocessed().forEach(s => s.reconcile())
  wanted.forEach(s => s.needed || drop(s))
  if (!wanted.size) return askIdle()
  if (!quiet()) return
  const s = highest([...wanted])
  wanted.delete(s)
  wanted.size && schedule()
  take(s)
  wanted.size ? schedule() : askIdle()
}

// Un momento ocioso: los avisos pendientes ya llegaron. Sin nada esperando cupo, los reintentos vuelven a empezar;
// ordena el desalojo tras un montaje y toma una vacía diferida. Sin presión, un montaje sólo lo ordena si una de sus
// altas no se ve: las que se ven nacieron más jóvenes que todo lo anterior.
const rest = () => {
  idleId = 0
  if (wanted.size || frame) return
  if (!starved.size) {
    clearTimeout(retryId)
    retryId = retryStep = 0
  }
  ;(settle || joining && registered().some(s => joined.has(s) && !s.needed)) && renew()
  settle  = false
  joining = false
  joined  = new WeakSet()
  if (starved.size || !idle.size || !quiet()) return
  const s = highest([...idle])
  askIdle()
  take(s)
}

export const glBudget = {
  // El lado máximo de textura del primer contexto del realm, o null antes de medirlo: con él se dimensionan los stores de
  // una capa que todavía no tiene contexto.
  get maxTexture() { return maxTexture },
  // Si una capa vacía puede diferir su contexto: el realm ya logró uno, así que WebGL2 anda. Sin eso el alta lo toma y
  // lanza si no hay WebGL2, que es lo que el consumidor espera para degradar.
  get capable() { return capable },

  register(s) {
    const ref = new WeakRef(s)
    members.set(s, { order: order++, ref })
    roster.add(ref)
  },

  // Tomar un contexto falló: sin WebGL2, o sin stencil. Hasta que otro se logre, las vacías lo toman al construirse.
  failed() { capable = false },

  // Destruida. Si tenía su contexto vivo, devolvió un cupo. Sin ninguna en el registro, el realm vuelve a empezar.
  unregister(s, freed) {
    roster.delete(members.get(s)?.ref)
    members.delete(s)
    roster.size || (pressed = false)
    glBudget.dropped(s, freed)
  },

  // Vacía al construirse: se toma en un momento ocioso.
  reserved(s) {
    idle.add(s)
    askIdle()
  },

  // `s` tomó un contexto: por la política, o por su cuenta (la capa al construirse, o a mano). El primero del realm da el
  // lado máximo de textura. Por su cuenta, el orden se rehace en el próximo rato ocioso; sin presión, sólo si no se ve:
  // la que se ve nace como la más joven, y la que no quedaría más joven que las necesarias. Se mira en el rato ocioso,
  // cuando la capa que la construye ya sabe si tiene contenido.
  acquired(s, gl) {
    capable = true
    if (!measured) {
      const declarado = gl.getParameter?.(gl.MAX_TEXTURE_SIZE)
      maxTexture = Number.isFinite(declarado) && declarado >= 1 ? declarado : null
      measured   = true
    }
    wanted.delete(s)
    idle.delete(s)
    starved.delete(s)
    blamed.delete(s)                // la anotación de una desalojada que volvió no explica una pérdida de después
    if (pumping === s) return
    if (pressed) return resettle()
    joined.add(s)
    joining = true
    askIdle()
  },

  // El navegador le quitó el contexto a `s`. Devuelve en qué estado queda: `lost` si la política la recupera, `released`
  // si no (prescindible, o sin cupo).
  lost(s) {
    if (!members.has(s)) return 'lost'
    const causa = blamed.get(s)
    blamed.delete(s)
    if (!causa && unprocessed().length) {       // varias a la vez sin una adquisición que lo explique
      blamed = new WeakMap()
      glBudget.retry()
    }
    pressed || resettle()           // la primera presión: el orden que no se cuidó se rehace en el próximo rato ocioso
    pressed = true
    if (!s.needed) return 'released'
    if (shed()) {
      wanted.add(s)
      schedule()
      return 'lost'
    }
    if (causa || episode.has(s) || starved.size) return saturate(s)
    wanted.add(s)
    schedule()
    return 'lost'
  },

  // Soltada (por la política o a mano) o destruida: sale de toda espera. Si devolvió un cupo vivo, es una señal de cupo.
  dropped(s, freed) {
    wanted.delete(s)
    idle.delete(s)
    starved.delete(s)
    episode.delete(s)
    blamed.delete(s)
    fresh.delete(s)
    joined.delete(s)
    freed && !deciding && glBudget.retry()
  },

  // La dueña de `s` tiene algo que mostrar: recibió contenido, o se volvió a ver. Con contexto, desde la primera presión,
  // si pasó a necesaria después de la última renovación el orden de desalojo se rehace en un rato ocioso: si no, quedaría
  // más vieja que las prescindibles. Sin contexto: una perdida —también la que todavía no avisó— espera su cuadro, y la
  // que la saturación dejó sin superficie, cupo. La primera vez lo toma en esta tarea, como al construirse; volver a
  // tomarlo también, si es la primera toma desde el último cuadro y ningún mapa está en pleno gesto, y si no va a la
  // cola. En saturación sólo entra en el lugar de una de menor z. Devuelve si lo tomó.
  need(s) {
    if (!members.has(s) || starved.has(s) || !s.needed) return false
    const state = s.state
    if (state === 'live') {
      pressed && !fresh.has(s) && resettle()
      return false
    }
    state === 'lost' && unprocessed().forEach(v => v.reconcile())
    if (!members.has(s) || wanted.has(s) || starved.has(s)) return false
    idle.delete(s)
    if (starved.size) {
      const menor = lowest(live().filter(m => m.needed))
      if (!menor || menor.z >= s.z) {
        starve(s)
        return false
      }
      starve(menor)
    }
    if (s.state !== 'none') {
      if (!capable) return false
      if (took || !quiet()) {
        wanted.add(s)
        return false
      }
      took = true
      schedule()                    // el cuadro libera la toma
    }
    try {
      return take(s)
    } catch (error) {
      console.error('[cristae] la capa queda sin contexto WebGL', error)
      return false
    }
  },

  // Un motor empieza (`true`) o termina un gesto: arrastre, zoom animado, pellizco o vuelo.
  motion(engine, moving) {
    if (moving) return movers.set(engine, now())
    if (!movers.delete(engine) || movers.size) return
    clearTimeout(motionId)
    motionId = 0
    wanted.size && schedule()
    idle.size && askIdle()
  },

  // Una señal de cupo: lo que pierda después es un accidente nuevo, y lo que la saturación dejó sin superficie se intenta
  // de nuevo, de a una por cuadro.
  retry() {
    clearTimeout(retryId)
    retryId = 0
    episode = new WeakSet()
    if (!starved.size) return
    starved.forEach(s => wanted.add(s))
    starved.clear()
    schedule()
  },
}
