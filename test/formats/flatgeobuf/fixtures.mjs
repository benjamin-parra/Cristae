// FlatGeobuf escritos a mano, campo por campo, para contrastar el escritor del test (DISENO-INTEROP
// §5-3bis). Esquemas `header.fbs` y `feature.fbs` [inf.: índices de campo de memoria, D-11]. Los
// offsets de los comentarios son relativos al comienzo de cada buffer de FlatBuffers.

const hex = texto => Uint8Array.from(texto.replace(/#.*$/gm, '').match(/[0-9a-f]{2}/gi), h => parseInt(h, 16))

// Cabecera con geometry_type Point e index_node_size 0 (sin índice) y un feature Point (-70.5, -33.25).
export const PUNTO = hex(`
  66 67 62 03 66 67 62 01      # mágico: «fgb», versión mayor 3, «fgb», parche
  24 00 00 00                  # largo de la cabecera: 36 bytes
  1c 00 00 00                  # 0: uoffset a la tabla Header, en 28
  18 00 08 00                  # 4: vtable de Header: 24 bytes, tabla de 8
  00 00 00 00 04 00            #    campos 0 name, 1 envelope (ausentes), 2 geometry_type en +4
  00 00 00 00 00 00 00 00 00 00   # campos 3 a 7 ausentes
  00 00 06 00                  #    campo 8 features_count ausente (0), 9 index_node_size en +6
  18 00 00 00                  # 28: soffset 24 → vtable en 4
  01 00                        # 32: geometry_type = 1 (Point), relleno
  00 00                        # 34: index_node_size = 0
  38 00 00 00                  # largo del feature: 56 bytes
  0c 00 00 00                  # 0: uoffset a la tabla Feature, en 12
  06 00 08 00 04 00 00 00      # 4: vtable de Feature: 6 bytes, tabla de 8, geometry en +4; relleno
  08 00 00 00                  # 12: soffset 8 → vtable en 4
  0c 00 00 00                  # 16: uoffset a Geometry, en 28
  08 00 08 00 00 00 04 00      # 20: vtable de Geometry: 8 bytes, tabla de 8; 0 ends ausente, 1 xy en +4
  08 00 00 00                  # 28: soffset 8 → vtable en 20
  04 00 00 00                  # 32: uoffset al vector xy, en 36
  02 00 00 00                  # 36: largo 2
  00 00 00 00 00 a0 51 c0      # 40: x = -70.5
  00 00 00 00 00 a0 40 c0      # 48: y = -33.25
`)

// Cabecera Unknown con has_z y sin índice; un feature LineString con su `type` y vector z:
// (1, 2, 10) → (3, 4, 20).
export const LINEA = hex(`
  66 67 62 03 66 67 62 01
  24 00 00 00                  # cabecera de 36 bytes
  1c 00 00 00                  # 0: Header en 28
  18 00 08 00                  # 4: vtable de 24, tabla de 8
  00 00 00 00 00 00 04 00      #    0 name, 1 envelope, 2 geometry_type ausentes (Unknown); 3 has_z en +4
  00 00 00 00 00 00 00 00 00 00   # campos 4 a 8 ausentes
  06 00                        #    9 index_node_size en +6
  18 00 00 00                  # 28: soffset 24
  01 00                        # 32: has_z = true, relleno
  00 00                        # 34: index_node_size = 0
  70 00 00 00                  # largo del feature: 112 bytes
  0c 00 00 00                  # 0: Feature en 12
  06 00 08 00 04 00 00 00      # 4: vtable de Feature, geometry en +4; relleno
  08 00 00 00                  # 12: soffset 8
  18 00 00 00                  # 16: Geometry en 40
  12 00 10 00                  # 20: vtable de Geometry: 18 bytes, tabla de 16
  00 00 04 00 08 00            #    0 ends ausente, 1 xy en +4, 2 z en +8
  00 00 00 00 00 00 0c 00      #    3 m, 4 t, 5 tm ausentes; 6 type en +12
  00 00                        # 38: relleno
  14 00 00 00                  # 40: soffset 20 → vtable en 20
  0c 00 00 00                  # 44: uoffset a xy, en 56
  2c 00 00 00                  # 48: uoffset a z, en 92
  02 00 00 00                  # 52: type = 2 (LineString), relleno
  04 00 00 00                  # 56: xy, largo 4
  00 00 00 00 00 00 f0 3f  00 00 00 00 00 00 00 40   # (1, 2)
  00 00 00 00 00 00 08 40  00 00 00 00 00 00 10 40   # (3, 4)
  02 00 00 00                  # 92: z, largo 2
  00 00 00 00 00 00 24 40  00 00 00 00 00 00 34 40   # 10, 20
`)
