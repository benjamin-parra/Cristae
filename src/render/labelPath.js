// El trazo de un rótulo proyectado a px de contenedor: los tramos de una línea, o los anillos de un
// polígono como trazos cerrados. Con curva, entre cada par de vértices entran los puntos de su
// geodésica, los mismos que dibuja `LineGpuLayer#pack` (`count` y `at` de geometry/curve.js), así el
// texto sigue la línea que se ve. Puro: sin DOM; la vista llega como números.
import { at, count } from '../geometry/curve.js'
import { foldRings } from '../geometry/measure.js'
import { foldRuns } from '../geometry/polyline.js'
import { coordOf } from '../data/path.js'
import { projX0, projY0 } from './project.js'

/** Lo que guarda una parte en `run.parts`: primer vértice, cantidad, caja (minX, minY, maxX, maxY) y si
 *  es un hueco (1) o no (0). */
export const PART = 7

const grow = (arr, need) => {
  if (arr.length >= need) return arr
  const next = new arr.constructor(Math.max(arr.length * 2, need))
  next.set(arr)
  return next
}

const curvePoint = [0, 0]                 // portador de `at`, escrito y leído en el acto

/** Un acumulador de trazos proyectados, reusado entre llamadas: `xy` intercalado, `cum` el largo
 *  acumulado por vértice dentro de su parte y `parts` de a `PART` por parte. */
export const createRun = () => ({
  xy    : new Float64Array(256),
  cum   : new Float64Array(128),
  parts : new Float64Array(PART * 8),
  n     : 0,
  count : 0,
  view  : null,
  curve : null,
  from  : 0,
  open  : false,
  lat   : 0,
  lng   : 0,
  hole  : 0,
  minX  : 0,
  minY  : 0,
  maxX  : 0,
  maxY  : 0,
})

const begin = (run, hole) => {
  run.from = run.n
  run.open = false
  run.hole = hole
  run.minX = run.minY = Infinity
  run.maxX = run.maxY = -Infinity
}

// Un vértice en px. El que cae en el mismo px que el anterior no suma: el segmento de largo 0 no tiene
// tangente.
const vertex = (run, lat, lng) => {
  const { cx, cy, scale, hw, hh } = run.view
  const x = (projX0(lng) - cx) * scale + hw
  const y = (projY0(lat) - cy) * scale + hh
  const n = run.n
  if (n > run.from && x === run.xy[2 * n - 2] && y === run.xy[2 * n - 1]) return
  run.xy  = grow(run.xy, (n + 1) * 2)
  run.cum = grow(run.cum, n + 1)
  run.cum[n]        = n > run.from ? run.cum[n - 1] + Math.hypot(x - run.xy[2 * n - 2], y - run.xy[2 * n - 1]) : 0
  run.xy[2 * n]     = x
  run.xy[2 * n + 1] = y
  run.n = n + 1
  if (x < run.minX) run.minX = x
  if (y < run.minY) run.minY = y
  if (x > run.maxX) run.maxX = x
  if (y > run.maxY) run.maxY = y
}

// Un vértice de la entrada y, con curva y si hay uno anterior, los de la geodésica que los une.
const put = (run, lat, lng) => {
  const curve = run.curve
  if (curve && run.open) {
    const lat0 = run.lat, lng0 = run.lng
    const m    = count(curve, lat0, lng0, lat, lng)
    for (let k = 1; k < m; k++) {
      at(curve, lat0, lng0, lat, lng, k / m, curvePoint)
      vertex(run, curvePoint[0], curvePoint[1])
    }
  }
  vertex(run, lat, lng)
  run.open = true
  run.lat  = lat
  run.lng  = lng
}

// Cierra la parte abierta: queda si tiene al menos dos vértices.
const end = run => {
  const from = run.from
  if (run.n - from < 2) return run.n = from
  const parts = run.parts = grow(run.parts, (run.count + 1) * PART)
  const o     = run.count++ * PART
  parts[o]     = from
  parts[o + 1] = run.n - from
  parts[o + 2] = run.minX
  parts[o + 3] = run.minY
  parts[o + 4] = run.maxX
  parts[o + 5] = run.maxY
  parts[o + 6] = run.hole
}

// Estables en el módulo, por lo que piden `foldRuns` y `foldRings`.
const runStep = (run, vertices, first, n) => {
  begin(run, 0)
  for (let i = first; i < first + n; i++) put(run, coordOf(vertices[i], 0), coordOf(vertices[i], 1))
  end(run)
  return run
}

const ringStep = (run, coords, n, hole) => {
  begin(run, hole ? 1 : 0)
  for (let i = 0; i < n; i++) put(run, coords[2 * i], coords[2 * i + 1])
  put(run, coords[0], coords[1])
  end(run)
  return run
}

const reset = (run, view, curve) => {
  run.n     = 0
  run.count = 0
  run.view  = view
  run.curve = curve ?? null
  return run
}

/** Los tramos de un path de línea, como los lee `foldRuns`, proyectados con `view` ({ cx, cy, scale, hw,
 *  hh }: centro en world0, 2^zoom y medio tamaño) y curvados sobre `curve` si no es null. */
export const projectPath = (run, path, view, curve) => foldRuns(path, runStep, reset(run, view, curve))

/** Los anillos de una zona, como los lee `foldRings`, cada uno como trazo cerrado: su último vértice es
 *  el primero. Los huecos llevan 1 en la última casilla de su parte. Una zona inválida no deja partes. */
export const projectRings = (run, zone, view, curve) => foldRings(zone, ringStep, reset(run, view, curve)) ?? reset(run, view, curve)
