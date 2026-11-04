// Fixtures binarios escritos a mano, campo por campo, para contrastar el escritor del test (DISENO-INTEROP
// §5-3bis): un generador que comparte un error con el lector lo vuelve invisible. Las tablas son de
// la ESRI Shapefile Technical Description, julio 1998 (Tabla 1: cabecera; Tabla 2: encabezado de registro).

const hex = texto => Uint8Array.from(texto.replace(/#.*$/gm, '').match(/[0-9a-f]{2}/gi), h => parseInt(h, 16))

// Un Point (tipo 1) en (-70.5, -33.25). 128 bytes = 64 palabras de 16 bits.
export const PUNTO = hex(`
  00 00 27 0a                                       # «Main File Header», byte 0: código 9994, big-endian
  00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 00  00 00 00 00   # bytes 4-23: sin uso
  00 00 00 40                                       # byte 24: largo del archivo, 64 palabras, big-endian
  e8 03 00 00                                       # byte 28: versión 1000, little-endian
  01 00 00 00                                       # byte 32: tipo de forma 1 (Point)
  00 00 00 00 00 a0 51 c0  00 00 00 00 00 a0 40 c0  # bytes 36-51: Xmin -70.5, Ymin -33.25
  00 00 00 00 00 a0 51 c0  00 00 00 00 00 a0 40 c0  # bytes 52-67: Xmax, Ymax
  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  # bytes 68-83: Zmin, Zmax
  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  # bytes 84-99: Mmin, Mmax
  00 00 00 01                                       # «Main File Record Headers»: número de registro 1, big-endian
  00 00 00 0a                                       # largo de contenido: 10 palabras (20 bytes), big-endian
  01 00 00 00                                       # «Point»: tipo 1, little-endian
  00 00 00 00 00 a0 51 c0                           # X = -70.5 (0xC051A00000000000)
  00 00 00 00 00 a0 40 c0                           # Y = -33.25 (0xC040A00000000000)
`)

// Un Polygon (tipo 5): el cuadrado unitario en sentido horario, como pide «Polygon» para el exterior.
// 100 + 8 + 128 = 236 bytes = 118 palabras (0x76).
export const CUADRADO = hex(`
  00 00 27 0a  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00   # código 9994 y sin uso
  00 00 00 76                                       # largo del archivo: 118 palabras
  e8 03 00 00  05 00 00 00                          # versión 1000, tipo 5 (Polygon)
  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  # Xmin 0, Ymin 0
  00 00 00 00 00 00 f0 3f  00 00 00 00 00 00 f0 3f  # Xmax 1, Ymax 1
  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00   # Z y M
  00 00 00 01  00 00 00 40                          # registro 1, contenido 64 palabras (128 bytes)
  05 00 00 00                                       # tipo 5
  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  # Box: Xmin, Ymin
  00 00 00 00 00 00 f0 3f  00 00 00 00 00 00 f0 3f  # Box: Xmax, Ymax
  01 00 00 00                                       # NumParts 1
  05 00 00 00                                       # NumPoints 5
  00 00 00 00                                       # Parts[0] = 0
  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  # (0, 0)
  00 00 00 00 00 00 00 00  00 00 00 00 00 00 f0 3f  # (0, 1)
  00 00 00 00 00 00 f0 3f  00 00 00 00 00 00 f0 3f  # (1, 1)
  00 00 00 00 00 00 f0 3f  00 00 00 00 00 00 00 00  # (1, 0)
  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  # (0, 0): cierra
`)

// `.dbf` de dBase III [inf.: estructura conocida; dbase.com sólo publica la de Level 7] con un campo C de 10 y uno
// N de 5, y un registro: «Ñuble», 42.
export const ATRIBUTOS = hex(`
  03 7e 0b 03                                       # versión 3; fecha 2026-11-03 (AA MM DD)
  01 00 00 00                                       # 1 registro
  61 00                                             # largo de cabecera: 32 + 2·32 + 1 = 97
  10 00                                             # largo de registro: 1 + 10 + 5 = 16
  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00   # bytes 12-28: reservados
  00 00 00                                          # byte 29: sin language driver; 30-31 reservados
  6e 6f 6d 62 72 65 00 00 00 00 00                  # «nombre», 11 bytes con relleno nulo
  43 00 00 00 00 0a 00                              # tipo C, dirección, largo 10, decimales 0
  00 00 00 00 00 00 00 00 00 00 00 00 00 00         # reservados
  76 61 6c 6f 72 00 00 00 00 00 00                  # «valor»
  4e 00 00 00 00 05 00                              # tipo N, largo 5
  00 00 00 00 00 00 00 00 00 00 00 00 00 00
  0d                                                # fin de los descriptores
  20                                                # registro vigente
  d1 75 62 6c 65 20 20 20 20 20                     # «Ñuble» en windows-1252, relleno a la derecha
  20 20 20 34 32                                    # «   42»
  1a                                                # fin de archivo
`)
