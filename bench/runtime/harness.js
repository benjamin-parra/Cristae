// Harness del banco: monta A y B, corre el guion sobre LOS DOS EN EL MISMO rAF y arma el JSON.
// Dos loops separados se miden entre sí —el que reciba el callback segundo hereda el jank del
// primero y lo reporta como propio—, así que acá hay UNA sola cola de frames y por cada una pasan
// los dos stages. Dentro del frame, el orden se alterna: ir primero no es gratis y no puede quedar
// clavado en el mismo lado toda la corrida.

import { crearStage, cargarBackend, nombreDeBackend, CON_TILES } from './stage.js'
import { GUION, MS_TOTAL } from './scenario.js'

const TIMADAS  = GUION.filter(fase => fase.tipo === 'frames' || fase.tipo === 'paint')
const MONTAJE  = GUION.find(fase => fase.tipo === 'montaje')
const TEARDOWN = GUION.find(fase => fase.tipo === 'teardown')

const correrGuion = (a, b, avisar) => new Promise(resolver => {
  let indice = 0
  let inicio = null
  let frames = 0
  let previo = 0

  const marcar = fase => {
    a.medidor.marcarFase(fase.nombre)
    b.medidor.marcarFase(fase.nombre)
    avisar(fase, previo)
  }

  const bucle = ahora => {
    const fase = TIMADAS[indice]
    inicio ??= ahora
    const t   = ahora - inicio
    const par = (frames & 1) === 0

    // Los dos estímulos se aplican antes de muestrear: A y B ven el mismo instante.
    fase.paso?.(par ? a : b, t, frames)
    fase.paso?.(par ? b : a, t, frames)
    a.medidor.frame(ahora)
    b.medidor.frame(ahora)
    frames++

    const cumplida = fase.tipo === 'paint' ? frames >= fase.frames : t >= fase.ms
    if (!cumplida) return requestAnimationFrame(bucle)

    previo += fase.ms ?? t
    indice++
    inicio = null
    frames = 0
    if (indice >= TIMADAS.length) return resolver()
    marcar(TIMADAS[indice])
    requestAnimationFrame(bucle)
  }

  marcar(TIMADAS[0])
  requestAnimationFrame(bucle)
})

/**
 * Corre el guion completo sobre dos backends de la MISMA capa y devuelve el resultado agregado, que
 * además queda en `window.__BENCH__` (objeto serializable) para copiarlo de la consola.
 * `onProgreso` recibe SIEMPRE el mismo objeto mutado y sólo en los cortes de fase: un objeto nuevo
 * por frame contaminaría justo la métrica de asignaciones que el banco existe para medir.
 */
export const correr = async ({ elA, elB, moduloA, moduloB, n, semilla, onProgreso }) => {
  const [defA, defB] = await Promise.all([cargarBackend(moduloA), cargarBackend(moduloB)])
  if (defA.id !== defB.id)
    throw new Error(`bench: A mide "${defA.id}" y B mide "${defB.id}" — otra unidad de N, no comparan`)

  const progreso = { fase: '', indice: 0, fases: GUION.length, transcurrido: 0, total: MS_TOTAL, progreso: 0 }
  const avisar   = (fase, transcurrido) => {
    progreso.fase         = fase.nombre
    progreso.indice       = GUION.indexOf(fase)
    progreso.transcurrido = transcurrido
    progreso.progreso     = MS_TOTAL > 0 ? Math.min(1, transcurrido / MS_TOTAL) : 0
    onProgreso?.(progreso)
  }

  // Montaje secuencial y no en paralelo: el mount de cada lado se mide solo, sin el otro compitiendo
  // por la misma GPU. La fase de montaje ya la abre `crearStage` (el medidor precede a las capas).
  avisar(MONTAJE, 0)
  const a = await crearStage(elA, { modulo: defA, n, semilla })
  const b = await crearStage(elB, { modulo: defB, n, semilla })

  await correrGuion(a, b, avisar)

  a.medidor.marcarFase(TEARDOWN.nombre)
  b.medidor.marcarFase(TEARDOWN.nombre)
  avisar(TEARDOWN, MS_TOTAL)
  const cierreA = a.destruir()
  const cierreB = b.destruir()

  // `terminar()` cuenta nodos y contextos DESPUÉS de destruir: su veredicto de teardown es sobre el
  // contenedor ya vacío, y el `cierre` del stage es el mismo hecho contado por el otro lado.
  const [informeA, informeB] = await Promise.all([a.medidor.terminar(), b.medidor.terminar()])
  // Recién ahora: resolver el nombre importa los módulos que faltan, y eso no puede pasar mientras
  // el medidor tiene en vuelo la medición de memoria y el gc.
  const [nombreA, nombreB] = await Promise.all([nombreDeBackend(defA), nombreDeBackend(defB)])

  const resultado = {
    version : 1,
    fecha   : new Date().toISOString(),
    config  : {
      capa    : defA.id,
      unidad  : a.datos.unidad,
      n,
      semilla,
      aislado : globalThis.crossOriginIsolated === true,
      tiles   : CON_TILES,
      agente  : navigator.userAgent,
      guion   : GUION.map(fase => ({ nombre: fase.nombre, tipo: fase.tipo, ms: fase.ms ?? 0 })),
    },
    a       : { modulo: nombreA, capa: defA.id, backend: defA.backend, ...informeA, cierre: cierreA },
    b       : { modulo: nombreB, capa: defB.id, backend: defB.backend, ...informeB, cierre: cierreB },
  }
  globalThis.__BENCH__ = resultado
  return resultado
}
