// Qué se hace cuando el navegador le quita el contexto a una superficie GL propia. Es del módulo y no del mapa,
// porque el techo de contextos vivos es del proceso de render (16 en Chromium) y lo comparten todos los mapas
// de la página. La superficie avisa y la política decide: es el único lugar donde se decide cuándo se toma un
// contexto que no pidió una capa al construirse.
//
// La política es la mínima que recupera sin ciclos. Una superficie perdida que tiene dueño se re-adquiere en el
// cuadro siguiente, una por cuadro, porque `getContext` cuesta más que un cuadro; y no en medio de un zoom animado,
// donde ese costo caería en el gesto más sensible y el canvas nuevo se vería corrido. Si una propia se pierde hasta
// un segundo después de una recuperación, no hay cupo: recuperarla desalojaría a otra propia, o a un ajeno que se
// rehace al perder y vuelve a desalojar. Ahí se deja de recuperar, y las que esperaban se quedan sin contexto,
// como antes de que hubiera recuperación. La prioridad, la liberación bajo presión, los reintentos y la señal de
// saturación entran acá.

const VENTANA = 1000                // ms después de una recuperación en que perder una propia es falta de cupo

const pendientes = new Set()        // perdidas por re-adquirir, en el orden en que se perdieron
let recuperada   = -Infinity        // cuándo empezó la última recuperación
let cuadro       = 0

const recuperar = () => {
  cuadro = 0
  const surface = pendientes.values().next().value
  if (!surface) return

  // En pleno zoom animado no: el canvas nuevo no recibe el `zoomanim` que ya pasó y se vería corrido hasta el `zoomend`, y el
  // `getContext` caería en el gesto más sensible. Espera con un cuadro agendado, que se apaga solo cuando asienta.
  if (surface.zooming) {
    cuadro = requestAnimationFrame(recuperar)
    return
  }

  pendientes.delete(surface)
  recuperada = performance.now()
  pendientes.size && (cuadro = requestAnimationFrame(recuperar))
  try {
    surface.acquire()
  } catch (error) {
    surface.release()               // la que no se pudo rearmar no se queda con un cupo
    throw error
  }
}

export const glBudget = {
  // El navegador le quitó el contexto a una superficie con dueño.
  lost(surface) {
    if (performance.now() - recuperada < VENTANA) {
      pendientes.clear()
      return
    }
    pendientes.add(surface)
    cuadro ||= requestAnimationFrame(recuperar)
  },

  // Soltada o destruida: si esperaba su turno, ya no.
  dropped(surface) { pendientes.delete(surface) },
}
