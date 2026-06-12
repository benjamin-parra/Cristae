// Difusor adaptativo. Dos modos según `interval`:
//   throttled (interval > 0): un setInterval chequea version() y emite si cambió.
//   tunnel reactivo (interval === 0): sin loop; el productor llama notify() tras mutar.
// `defer: 'raf'` coalesce la emisión a UN requestAnimationFrame.

const noRaf = (cb) => setTimeout(cb, 0)
const hasRaf = typeof requestAnimationFrame === 'function'
const raf = hasRaf ? requestAnimationFrame : noRaf
const cancelRaf = hasRaf ? cancelAnimationFrame : clearTimeout

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

  destroy() {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null }
    if (this.#rafId != null) { cancelRaf(this.#rafId); this.#rafId = null }  // bug: rAF colgado post-destroy
    this.#pending = null
    this.#subs.clear()
    this.#lastData = null
  }

  /* ── Internos ── */

  #check() {
    const ver = this.#version()
    if (ver === this.#lastVersion) return            // dirty-skip
    this.#lastVersion = ver
    this.#lastData = this.#source()
    if (this.#defer === 'raf') this.#scheduleEmit(this.#lastData)
    else this.#emit(this.#lastData)
  }

  #emit(data) {
    for (const cb of this.#subs.values()) cb(data)
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
