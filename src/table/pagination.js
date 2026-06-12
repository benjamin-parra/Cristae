// Modelo de paginación con elipsis — función PURA. El engine (PagedTable) solo computa el
// pageInfo (página actual / total); la VISTA llama a esto para decidir qué botones dibujar.
// Separarlo del engine deja la mecánica de scroll virtual sin ninguna noción de UI/CSS, y vuelve
// la lógica de elipsis trivial de testear y de reusar en cualquier piel (web component, React, …).
//
// `capacity` = cantidad de botones disponibles (incluye los dos extremos, 1 y `totalPages`).
// Devuelve descriptores `{ label, pageIndex, isCurrent }`; un `label === '...'` marca una elipsis
// (su `pageIndex` salta a un punto intermedio razonable, para que el click avance de a tramos).

export const paginationModel = (current, totalPages, capacity) => {
  if (totalPages <= capacity)
    return Array.from({ length: totalPages }, (_, i) => ({ label: i + 1, pageIndex: i, isCurrent: i === current }))

  const model = []
  const inner = capacity - 2
  const half = inner >> 1

  let start = 1
  let end = totalPages - 2
  let leftEllipsis = false
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

  model.push({ label: 1, pageIndex: 0, isCurrent: current === 0 })
  if (leftEllipsis) model.push({ label: '...', pageIndex: start >> 1, isCurrent: false })

  for (let i = start; i <= end; i++)
    model.push({ label: i + 1, pageIndex: i, isCurrent: i === current })

  if (rightEllipsis) model.push({ label: '...', pageIndex: (end + totalPages - 1) >> 1, isCurrent: false })
  model.push({ label: totalPages, pageIndex: totalPages - 1, isCurrent: current === totalPages - 1 })

  return model
}
