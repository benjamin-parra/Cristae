// Difusor adaptativo. Dos modos según `interval`:
//   throttled (interval > 0): un setInterval chequea version() y emite si cambió.
//   tunnel reactivo (interval === 0): sin loop; el productor llama notify() tras mutar.
// `defer: 'raf'` coalesce la emisión a UN requestAnimationFrame.

import { safe } from './safe.js'

const noRaf = (cb) => setTimeout(cb, 0)
const hasRaf = typeof requestAnimationFrame === 'function'
const raf = hasRaf ? requestAnimationFrame : noRaf
const cancelRaf = hasRaf ? cancelAnimationFrame : clearTimeout

// Ref de módulo estable → safe no aloca por emisión (solo se invoca si un subscriber tira).
function reportSubscriberError(e) {
  console.error('[Emitter] subscriber lanzó', e)
}

export class Emitter {

  #source
  #version
  #lastVersion = -1
  #lastData = null

  #subs = new Map()

  // Eje 6 — dos máquinas de estado agrupadas por co-mutación (ambas por-instancia: el object
  // literal de un campo se instancia una vez por Emitter, sin estado compartido entre difusores).
  //   #throttle: el loop por timer (ms/cap/timer se escriben y apagan juntos en interval/destroy).
  //   #frame: la emisión diferida a rAF (onFlush/mode/pending/rafId son el ciclo del frame).
  // `pending` (dato agendado para el frame) queda SEPARADO de `#lastData` (último chequeado): son
  // dos ranuras distintas y el getter `snapshot` lee la segunda — conflacionarlas rompería el test.
  #throttle = { ms: 0, cap: Infinity, timer: null }
  #frame = { onFlush: null, mode: 'none', pending: null, rafId: null }

  constructor({ source, version, interval = 100, onFlush, defer = 'none', maxInterval = Infinity } = {}) {
    this.#source = source
    this.#version = version
    const t = this.#throttle
    t.cap = maxInterval
    t.ms = this.#clamp(interval)              // #clamp lee t.cap → cap primero
    const f = this.#frame
    f.onFlush = onFlush
    f.mode = defer
    this.#startTimer()
  }

  /* ── Consumidores ── */

  subscribe(id, callback) {
    this.#subs.set(id, callback)
    return this
  }

  unsubscribe(id) {
    this.#subs.delete(id)
    return this
  }

  /* ── Configuración ── */

  set interval(ms) {
    this.#throttle.ms = this.#clamp(ms)
    this.#startTimer()
  }
  get interval() { return this.#throttle.ms }

  get defer() { return this.#frame.mode }
  set defer(v) { this.#frame.mode = v }

  get reactive() { return this.#throttle.ms === 0 }
  get snapshot() { return this.#lastData }

  // Avanza el tracker de version sin emitir (tras un rebuild manual).
  sync() { this.#lastVersion = this.#version() }

  // Entrada del tunnel reactivo. En modo throttled es no-op (el timer se encarga).
  notify() {
    if (this.#throttle.ms === 0) this.#check()
  }

  /* ── Lifecycle ── */

  // Deja el emitter INERTE: suelta la fuente (a la que `#check` se guarda) y las suscripciones, y
  // cancela lo agendado. Un `notify()` posterior ya no lee, no emite ni dispara `#onFlush`.
  destroy() {
    const t = this.#throttle, f = this.#frame
    if (t.timer) { clearInterval(t.timer); t.timer = null }
    if (f.rafId != null) { cancelRaf(f.rafId); f.rafId = null }
    f.pending = null
    this.#subs.clear()
    f.onFlush = null
    this.#source = null
    this.#lastData = null
  }

  /* ── Internos ── */

  #check() {
    if (!this.#source) return          // destruido → inerte
    const ver = this.#version()
    if (ver === this.#lastVersion) return            // dirty-skip
    this.#lastVersion = ver
    this.#lastData = this.#source()
    if (this.#frame.mode === 'raf') this.#scheduleEmit(this.#lastData)
    else this.#emit(this.#lastData)
  }

  // Reparto aislado: la versión ya se consumió, así que un subscriber que lanza no puede llevarse
  // ni a los demás ni al onFlush — esa emisión no se reintenta. El error se reporta, no se traga.
  #emit(data) {
    for (const cb of this.#subs.values()) safe(cb, data, reportSubscriberError)
    this.#frame.onFlush?.()
  }

  #scheduleEmit(data) {
    const f = this.#frame
    f.pending = data
    if (f.rafId != null) return                      // guard: una sola emisión agendada
    f.rafId = raf(() => {
      f.rafId = null
      const next = f.pending
      f.pending = null
      if (next != null) this.#emit(next)
    })
  }

  #startTimer() {
    const t = this.#throttle
    if (t.timer) { clearInterval(t.timer); t.timer = null }
    if (t.ms > 0) t.timer = setInterval(() => this.#check(), t.ms)
    // interval === 0 → tunnel reactivo, sin loop
  }

  #clamp(ms) {
    return Math.max(0, Math.min(+ms || 0, this.#throttle.cap))
  }
}
