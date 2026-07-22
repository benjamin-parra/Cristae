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

  #ms
  #cap
  #timer = null

  #onFlush
  #defer
  #pending = null
  #rafId = null

  constructor({ source, version, interval = 100, onFlush, defer = 'none', maxInterval = Infinity } = {}) {
    this.#source = source
    this.#version = version
    this.#cap = maxInterval
    this.#ms = this.#clamp(interval)
    this.#onFlush = onFlush
    this.#defer = defer
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
    this.#ms = this.#clamp(ms)
    this.#startTimer()
  }
  get interval() { return this.#ms }

  get defer() { return this.#defer }
  set defer(v) { this.#defer = v }

  get reactive() { return this.#ms === 0 }
  get snapshot() { return this.#lastData }

  // Avanza el tracker de version sin emitir (tras un rebuild manual).
  sync() { this.#lastVersion = this.#version() }

  // Entrada del tunnel reactivo. En modo throttled es no-op (el timer se encarga).
  notify() {
    if (this.#ms === 0) this.#check()
  }

  /* ── Lifecycle ── */

  // Deja el emitter INERTE: suelta la fuente (a la que `#check` se guarda) y las suscripciones, y
  // cancela lo agendado. Un `notify()` posterior ya no lee, no emite ni dispara `#onFlush`.
  destroy() {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null }
    if (this.#rafId != null) { cancelRaf(this.#rafId); this.#rafId = null }
    this.#pending = null
    this.#subs.clear()
    this.#onFlush = null
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
    if (this.#defer === 'raf') this.#scheduleEmit(this.#lastData)
    else this.#emit(this.#lastData)
  }

  // Reparto aislado: la versión ya se consumió, así que un subscriber que lanza no puede llevarse
  // ni a los demás ni al onFlush — esa emisión no se reintenta. El error se reporta, no se traga.
  #emit(data) {
    for (const cb of this.#subs.values()) safe(cb, data, reportSubscriberError)
    this.#onFlush?.()
  }

  #scheduleEmit(data) {
    this.#pending = data
    if (this.#rafId != null) return                  // guard: una sola emisión agendada
    this.#rafId = raf(() => {
      this.#rafId = null
      const next = this.#pending
      this.#pending = null
      if (next != null) this.#emit(next)
    })
  }

  #startTimer() {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null }
    if (this.#ms > 0) this.#timer = setInterval(() => this.#check(), this.#ms)
    // interval === 0 → tunnel reactivo, sin loop
  }

  #clamp(ms) {
    return Math.max(0, Math.min(+ms || 0, this.#cap))
  }
}
