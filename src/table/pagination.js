// Modelo de paginación con elipsis — función PURA. El engine (PagedTable) solo computa el
// pageInfo (página actual / total); la VISTA llama a esto para decidir qué botones dibujar.
// Separarlo del engine deja la mecánica de scroll virtual sin ninguna noción de UI/CSS, y vuelve
// la lógica de elipsis trivial de testear y de reusar en cualquier piel.
//
// `capacity` = cantidad de botones disponibles (incluye los dos extremos, 1 y `totalPages`).
// Devuelve descriptores `{ label, pageIndex, isCurrent }`; un `label === '...'` marca una elipsis
// (su `pageIndex` salta a un punto intermedio razonable, para que el click avance de a tramos).
//
// Invariantes para CUALQUIER entrada: como mucho `capacity` descriptores, todo `pageIndex` dentro
// de `[0, totalPages - 1]`, la secuencia nunca retrocede, y la página actual queda marcada
// exactamente una vez (mientras haya al menos un botón que dibujar).

// El andamiaje `1 … ventana … N` cuesta cinco botones: los dos extremos, las dos elipsis y la
// página actual. Con menos presupuesto que eso, anclar los extremos deja afuera la actual o se
// pasa del presupuesto, así que el modelo degrada a una ventana corrida.
const SCAFFOLD_SLOTS = 5

const pageButton = (index, current) => ({ label: index + 1, pageIndex: index, isCurrent: index === current })

// Degradación para presupuestos chicos: páginas CONTIGUAS centradas en la actual y encajadas en el
// rango. Sin extremos ni elipsis — un salto sin elipsis se leería como páginas consecutivas, y las
// elipsis no entran en el presupuesto sin desalojar a la página actual.
const slidingWindow = (current, totalPages, capacity) => {
  const size = Math.min(Math.max(capacity, 0), totalPages)
  const start = Math.min(Math.max(current - (size >> 1), 0), totalPages - size)
  return Array.from({ length: size }, (_, i) => pageButton(start + i, current))
}

export const paginationModel = (current, totalPages, capacity) => {
  if (totalPages <= capacity)
    return Array.from({ length: totalPages }, (_, i) => pageButton(i, current))

  if (capacity < SCAFFOLD_SLOTS) return slidingWindow(current, totalPages, capacity)

  const model = []
  const inner = capacity - 2
  const half = inner >> 1

  let start         = 1
  let end           = totalPages - 2
  let leftEllipsis  = false
  let rightEllipsis = false

  if (current <= half + 1) {
    end = inner - 1
    rightEllipsis = true
  } else if (current >= totalPages - 1 - half) {
    start = totalPages - inner
    leftEllipsis = true
  } else {
    start = current - ((inner - 2) >> 1)
    end = current + ((inner - 3) >> 1)
    leftEllipsis = true
    rightEllipsis = true
  }

  model.push(pageButton(0, current))
  if (leftEllipsis) model.push({ label: '...', pageIndex: start >> 1, isCurrent: false })

  for (let i = start; i <= end; i++)
    model.push(pageButton(i, current))

  if (rightEllipsis) model.push({ label: '...', pageIndex: (end + totalPages - 1) >> 1, isCurrent: false })
  model.push(pageButton(totalPages - 1, current))

  return model
}
