// Mide cuántos bytes asigna una función por llamada (SPECS §14), igual en Node 20, 24 y 26.
//
// `v8.getHeapStatistics().total_allocated_bytes` sólo existe desde el V8 14 (Node 26): en Node 24 vale
// `undefined`, la resta da NaN y todo `NaN < n` es falso, así que el test fallaba asignara o no el código.
// Este contador usa lo que sí hay desde Node 20, `v8.getHeapSpaceStatistics()`:
//   - suma lo usado en la generación joven (`new_space` y `new_large_object_space`), donde cae lo que
//     asigna el código JS; la compilación y el barrido concurrente mueven las demás áreas aun sin GC;
//   - descarta las tandas en que corrió un GC (las detecta con `v8.GCProfiler`), porque un GC baja lo usado;
//   - resta el costo fijo de leer las áreas (una tanda vacía);
//   - devuelve la mejor tanda sin GC: una función que asigna lo hace en todas, así que la mejor no esconde nada.
// Límite: no ve lo que V8 asignara directo en la generación vieja (pretenuring). La invariante vale con el
// código ya optimizado: de ahí `calentar`, largo para que el compilador termine.
import v8 from 'node:v8'

const AREAS = ['new_space', 'new_large_object_space']

const usado = () => {
  let suma  = 0
  let vistas = 0
  for (const area of v8.getHeapSpaceStatistics()) {
    if (!AREAS.includes(area.space_name)) continue
    suma += area.space_used_size
    vistas++
  }
  // Un renombre de las áreas daría un «0» falso: mejor cortar.
  if (!vistas || !Number.isFinite(suma)) throw new Error('bytesPorLlamada: este V8 no expone new_space')
  return suma
}

// Una tanda de `n` llamadas: devuelve los bytes por llamada, o null si hubo un GC.
const tanda = (fn, n) => {
  const perfil = new v8.GCProfiler()
  perfil.start()
  const antes = usado()
  for (let i = 0; i < n; i++) fn(i)
  const despues = usado()
  const { statistics } = perfil.stop()
  return statistics.length ? null : (despues - antes) / n
}

export const bytesPorLlamada = (fn, n, { calentar = 10 * n, tandas = 5 } = {}) => {
  for (let i = 0; i < calentar; i++) fn(i)
  // Costo fijo de medir: las mismas lecturas con una tanda que no hace nada.
  let fijo = Infinity
  for (let k = 0; k < 3; k++) {
    const perfil = new v8.GCProfiler()
    perfil.start()
    const antes = usado()
    const despues = usado()
    perfil.stop()
    fijo = Math.min(fijo, despues - antes)
  }
  for (let tam = n; tam >= 1; tam = Math.floor(tam / 2)) {
    let mejor = Infinity
    for (let k = 0; k < tandas; k++) {
      const bytes = tanda(fn, tam)
      if (bytes !== null) mejor = Math.min(mejor, bytes)
    }
    if (mejor !== Infinity) {
      const resultado = mejor - fijo / tam
      if (!Number.isFinite(resultado)) throw new Error(`bytesPorLlamada: medida no finita (${resultado})`)
      return Math.max(resultado, 0)
    }
  }
  throw new Error('bytesPorLlamada: todas las tandas tuvieron GC')
}
