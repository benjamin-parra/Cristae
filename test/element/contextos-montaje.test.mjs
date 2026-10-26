// Contextos WebGL al montar y al quitar un mapa de elementos REALES (Lit + custom elements en jsdom), contados por un
// navegador falso que respeta el techo de Chromium. Dos balances:
//
//   T0.1  creados == vivos tras el montaje: ninguna creación espuria. Antes de `attachSource` idempotente una
//         `<cristae-point-layer>` con `source` se construía dos veces: `updated()` monta y enseguida `syncLayer`
//         trataba la `source` recién montada como un reemplazo, y el reemplazo es destruir la capa y construir otra.
//   T0.2  `map.remove()` deja 0 vivos y creados == liberados: verde hoy, fija el balance del teardown.
//
// Dos modelos, el de 8 y el de 13 capas (test-helpers/modelo-capas.mjs).
//
// El harness va PRIMERO: window, customElements y lo que Lit toca al evaluar.
import { armar, esperar } from '../../test-helpers/modelo-capas.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

const CASOS = [8, 13].flatMap(capas => ['react', 'antes'].map(orden => [capas, orden]))

after(() => document.body.replaceChildren())

for (const [capas, orden] of CASOS) {
  test(`T0.1 modelo de ${capas} capas, props ${orden}: creados == vivos tras el montaje`, async t => {
    const { map, navegador } = await armar(capas, orden)
    t.after(() => map.remove())
    const estado = navegador.stat()
    assert.equal(estado.vivos, capas, `capas vivas: ${navegador.resumen()}`)
    assert.equal(estado.desalojados, 0, 'sin ajenos no hay desalojo')
    const dobles = navegador.contextos.filter(c => c.causa === 'liberado').map(c => c.pane)
    assert.equal(estado.creados, estado.vivos,
      `creaciones espurias: ${navegador.resumen()}; liberados al instante en: ${dobles.join(', ')}`)
    assert.deepEqual(navegador.violaciones, [], 'ninguna capa usa un recurso de un contexto perdido ni de otro')
  })
}

for (const [capas, orden] of CASOS) {
  test(`T0.2 modelo de ${capas} capas, props ${orden}: map.remove() deja 0 vivos y creados == liberados`, async () => {
    const { map, navegador } = await armar(capas, orden)
    assert.equal(navegador.vivos, capas, 'el montaje dejó las capas esperadas')
    map.remove()
    await esperar(30)
    const estado = navegador.stat()
    assert.equal(estado.vivos, 0, `quedaron contextos: ${navegador.resumen()}`)
    assert.equal(estado.creados, estado.liberados, `no se devolvió todo: ${navegador.resumen()}`)
    assert.equal(estado.desalojados, 0)
    assert.deepEqual(navegador.violaciones, [])
  })
}
