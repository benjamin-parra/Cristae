// Las asignaciones del cuadro del renderer `gl` de los rótulos, en un proceso propio y con un gl de no-ops plano: así
// lo que se mide es el renderer y no el espía, ni sitios de llamada que otro test volvió megamórficos. El cuadro con la
// vista en movimiento, o con la del zoom animado, no recoloca ni sube nada: sólo uniformes y draws. Corre con:
//   node --test test/render/label-gl-alloc.test.mjs
import { PUNTOS, instalarMedida, miembro, montar } from '../../test-helpers/rotulos-gl.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { bytesPorLlamada } from '../../test-helpers/asignaciones.mjs'

after(instalarMedida())

test('[0-alloc] el cuadro con la vista en movimiento no asigna', () => {
  const { host, r } = montar({ mudo: true })
  const muchos = Array.from({ length: 400 }, (_, i) => ({ id: i, lat: -33.4 + (i % 20) * 1e-3, lng: -70.6 + Math.floor(i / 20) * 1e-3, text: `CAM-${i}` }))
  r.attach(miembro({ items: muchos }))
  r.attach(miembro({ id: 'n', items: PUNTOS, opts: { halo: 'none' } }))
  r.resetCanvasReference()
  // Tanda larga y calentamiento largo, como el resto de las pruebas de [0-alloc]: con el código frío V8 encajona.
  const bytes = bytesPorLlamada(i => {
    host.center.lng = -70.6 + (i % 50) * 1e-4
    r.resetCanvasReference()
  }, 20_000, { calentar: 100_000 })
  assert.ok(bytes < 1, `${bytes} B por cuadro`)
  const zoom = bytesPorLlamada(i => r.renderAtView(12 + (i % 10) * 0.1, host.center), 20_000, { calentar: 100_000 })
  assert.ok(zoom < 1, `${zoom} B por cuadro del zoom animado`)
  r.destroy()
})

