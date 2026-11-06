// El error de todos los lectores de formatos (DISENO-INTEROP §1.4). Es otra clase que `GeoJsonError`
// porque el `name` y el prefijo del mensaje dicen quién falló. `detail` sólo alarga el mensaje: lo que
// se leyó y no sirve (el CRS, las capas de un zip), para quien diagnostica y no para el código.

export class FormatError extends Error {
  constructor(format, code, at = -1, hint = null, detail = null) {
    super((at >= 0 ? `${format}: ${code} (byte ${at})` : `${format}: ${code}`) + (detail === null ? '' : `: ${detail}`))
    this.name   = 'FormatError'
    this.format = format
    this.code   = code
    this.at     = at
    this.hint   = hint
  }
}
