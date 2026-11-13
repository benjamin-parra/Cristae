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


// Sobre el trazo, entre asientos: el cuadro sólo cambia la escala del glifo, y el asiento sin nada que recolocar (un
// paneo dentro del margen) tampoco asigna. El picking glifo a glifo, tampoco.
test('[0-alloc] sobre el trazo, el cuadro, el asiento sin recolocar y el picking no asignan', () => {
  const { host, r } = montar({ mudo: true })
  const rutas = Array.from({ length: 30 }, (_, i) => ({
    id: `r${i}`, text: `Ruta ${i}`,
    path: Array.from({ length: 40 }, (_, k) => [-33.42 + i * 0.0013 + Math.sin(k / 5) * 1e-3, -70.66 + k * 0.003]),
  }))
  const m = miembro({ id: 'l', kind: 'line', placement: 'along', items: rutas, pathOf: x => x.path, opts: { repeat: 80 } })
  r.attach(m)
  r.resetCanvasReference()
  const zoom = bytesPorLlamada(i => r.renderAtView(12 + (i % 10) * 0.1, host.center), 20_000, { calentar: 100_000 })
  assert.ok(zoom < 1, `${zoom} B por cuadro del zoom animado`)
  const asiento = bytesPorLlamada(i => {
    host.center.lng = -70.6 + (i % 50) * 1e-5
    r.resetCanvasReference()
    host.camera.emit('moveend')
  }, 20_000, { calentar: 100_000 })
  assert.ok(asiento < 1, `${asiento} B por asiento sin recolocar`)
  // `length = 0` le hace soltar a V8 el almacenamiento del arreglo: un centinela en la casilla 0 deja medir sólo lo que
  // asigna `hitsAt`, como en label-layout.test.mjs.
  const out = [null]
  const muestra = { x: 400, y: 300 }
  let picados = 0
  const pica = bytesPorLlamada(i => {
    out.length = 1
    muestra.x = 200 + (i % 400)
    r.hitsAt(m, muestra, out)
    picados += out.length - 1
  }, 20_000, { calentar: 100_000 })
  assert.ok(picados > 0, 'hay glifos bajo las muestras')
  assert.ok(pica < 2, `${pica} B por picking`)
  r.destroy()
})
