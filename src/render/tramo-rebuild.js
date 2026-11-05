// Cola de reconstrucción A2 de un tramo: al recuperar el contexto, los miembros con contenido se rearman de a tandas de
// hasta `budget` ms por cuadro, la primera en la misma tarea y al menos un miembro por tanda aunque él solo se pase del
// tope; lo que no entra sigue en el cuadro siguiente. No pasa por la política de `gl-budget`: el contexto ya está tomado.
// 8 ms es el único valor sin costo medido (notas M6.md:110); medirlo queda para el banco.
//
// [0-alloc] (SPECS §13): los ítems se copian a un array propio reusado, el callback del cuadro es un campo ligado una vez
// y cada `build` va aislado con `safe` y un onError de módulo.
//
// Reentrante: un `build` o el `after` pueden llamar `start` o `cancel` sobre la misma cola (el tramo se pierde a mitad de
// la tanda). Cada `start` y cada `cancel` abren una generación nueva, y la tanda en curso se corta en cuanto la ve
// cambiar: nunca sigue sobre ítems viejos.
import { safe } from '../data/safe.js'

export const REBUILD_BUDGET_MS = 8

const onBuildError = e => console.error('[cristae] la reconstrucción de un miembro lanzó', e)

export class RebuildQueue {
  #now
  #frame
  #cancelFrame
  #budget
  #items   = []                     // reusado entre `start`: crece una vez y queda
  #next    = 0
  #count   = 0
  #build   = null
  #after   = null
  #frameId = 0
  #gen     = 0
  #onFrame = () => {
    this.#frameId = 0
    this.#next < this.#count && this.#run()
  }

  // Los relojes por defecto se resuelven al llamarlos: construir la cola donde no hay `requestAnimationFrame` no falla.
  constructor({
    now = () => performance.now(),
    frame = cb => requestAnimationFrame(cb),
    cancelFrame = id => cancelAnimationFrame(id),
    budget = REBUILD_BUDGET_MS,
  } = {}) {
    this.#now         = now
    this.#frame       = frame
    this.#cancelFrame = cancelFrame
    this.#budget      = budget
  }

  get pending() { return this.#count - this.#next }

  // `items[0..count)` en orden de prioridad. Una cola en curso se reemplaza. Sin ítems no hay tanda ni `after`.
  start(items, count, build, after) {
    this.cancel()
    for (let i = 0; i < count; i++) this.#items[i] = items[i]
    this.#count = count
    this.#build = build
    this.#after = after
    count && this.#run()
  }

  cancel() {
    this.#gen++
    if (this.#frameId) {
      const cancelFrame = this.#cancelFrame  // sin receptor: el `cancelAnimationFrame` nativo lo exige
      cancelFrame(this.#frameId)
      this.#frameId = 0
    }
    for (let i = this.#next; i < this.#count; i++) this.#items[i] = null
    this.#next  = 0
    this.#count = 0
    this.#build = null
    this.#after = null
  }

  // Una tanda: al menos un ítem, y otro mientras quede tope. El cuadro siguiente se agenda antes de `after`, para que un
  // `after` que lanza no deje la cola varada.
  #run() {
    const gen   = this.#gen
    const now   = this.#now
    const t0    = now()
    const after = this.#after
    do {
      const item = this.#items[this.#next]
      this.#items[this.#next++] = null
      safe(this.#build, item, onBuildError)
      if (gen !== this.#gen) return
    } while (this.#next < this.#count && now() - t0 < this.#budget)

    if (this.#next < this.#count) {
      const frame = this.#frame
      this.#frameId = frame(this.#onFrame)
    } else {
      this.#next  = 0
      this.#count = 0
      this.#build = null
      this.#after = null
    }
    after()
  }
}
