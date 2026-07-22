// Utilidad de ciclo de vida, agnóstica de Source: normaliza el teardown que devuelve un
// subscribe a una función de baja uniforme. Reusable por cualquier consumidor (defineSource,
// PagedTable.attach) — no depende de Store/Emitter ni de nada del motor.

const NOOP = () => {}

// Normaliza el teardown que devuelve una librería de reactividad a una función de baja.
// Tolera: función (Preact effect, Zustand), objeto con `unsubscribe()` (RxJS), objeto con
// `dispose()` (Solid root) o nada (la baja queda en no-op).
export const toUnsub = (teardown) =>
  typeof teardown === 'function' ? teardown
  : teardown && typeof teardown.unsubscribe === 'function' ? () => teardown.unsubscribe()
  : teardown && typeof teardown.dispose === 'function' ? () => teardown.dispose()
  : NOOP
