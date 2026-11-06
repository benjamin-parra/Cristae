// Fixtures WKB escritas a mano, campo por campo. Codificación de 06-103r4 §8.2 (códigos en 8.2.3, estructura en 8.2.8) y EWKB
// de PostGIS. Los doubles son IEEE 754: 1 = 3FF0…, 2 = 4000…, 3 = 4008…, 4 = 4010…, 5 = 4014…,
// 6 = 4018…; en little endian los bytes van al revés.
const h = (...campos) => campos.join('').toUpperCase()

export const FIXTURES = {
  puntoLE: h(
    '01',                   // orden: little endian
    '01000000',             // tipo 1, Point
    '000000000000F03F',     // x = 1
    '0000000000000040',     // y = 2
  ),
  lineaZBE: h(
    '00',                   // orden: big endian
    '000003EA',             // tipo 1002, LineString Z (ISO)
    '00000002',             // numPoints = 2
    '3FF0000000000000', '4000000000000000', '4008000000000000',   // 1 2 3
    '4010000000000000', '4014000000000000', '4018000000000000',   // 4 5 6
  ),
  // Es la salida de ST_AsEWKB('SRID=4326;POINT(1 2)') de PostGIS [inf.: de memoria].
  puntoEwkbSrid: h(
    '01',                   // little endian
    '01000020',             // tipo 1 con la bandera 0x20000000 (SRID)
    'E6100000',             // SRID = 4326
    '000000000000F03F',     // x = 1
    '0000000000000040',     // y = 2
  ),
  multipuntoMMezclado: h(
    '01',                   // raíz little endian
    'D4070000',             // tipo 2004, MultiPoint M (ISO)
    '01000000',             // numPoints = 1
    '00',                   // hijo big endian
    '000007D1',             // tipo 2001, Point M
    '3FF0000000000000',     // x = 1
    '4000000000000000',     // y = 2
    '4008000000000000',     // m = 3
  ),
  // Casos que el generador no expresa porque GeoJSON no los tiene.
  puntoVacio: h('01', '01000000', '000000000000F87F', '000000000000F87F'),                 // POINT EMPTY: NaN NaN
  multipuntoConVacio: h(
    '01', '04000000', '02000000',                                                        // MultiPoint de 2
    '01', '01000000', '000000000000F87F', '000000000000F87F',                            // POINT EMPTY
    '01', '01000000', '000000000000F03F', '0000000000000040',                            // POINT(1 2)
  ),
  triangulo: h(
    '01', '11000000', '01000000', '04000000',                                            // Triangle (17), 1 anillo de 4
    '0000000000000000', '0000000000000000', '000000000000F03F', '0000000000000000',
    '0000000000000000', '000000000000F03F', '0000000000000000', '0000000000000000',
  ),
  tin: h(
    '01', '10000000', '01000000',                                                        // TIN (16) de 1 triángulo
    '01', '11000000', '01000000', '04000000',
    '0000000000000000', '0000000000000000', '000000000000F03F', '0000000000000000',
    '0000000000000000', '000000000000F03F', '0000000000000000', '0000000000000000',
  ),
}
