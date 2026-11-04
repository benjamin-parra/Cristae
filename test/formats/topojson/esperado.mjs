// Qué ejercita cada fixture del corpus de TopoJSON y qué se espera. Sin `error`, la salida esperada es
// la del oráculo, y `aviso` es el código del único warning si lo hay. Las citas de
// topojson-specification 1.0 están verificadas contra la especificación (DISENO-INTEROP §8, D-11).

export const ESPERADO = {
  'felices/poligonos-compartidos.json' : { cita: '§2.1.2 transform, §2.1.3 arcos con delta, §2.1.4 ~i y arcos compartidos' },
  'felices/capas.json'                 : { cita: '§2.1.5 objects como capas, §2.2 Point/MultiPoint/MultiPolygon, bbox' },
  'felices/lineas-sin-transform.json'  : { cita: '§2.1.3 sin transform: posiciones absolutas; §2.1.4 unión de arcos' },

  'especificacion/ejemplo.json'            : { cita: 'ejemplo de la especificación, §1.1' },
  'especificacion/orden-de-miembros.json'  : { cita: '§2.1 el orden de los miembros es irrelevante: arcs después de objects' },
  'especificacion/arco-invertido.json'     : { cita: '§2.1.4 índice negativo = ~i, recorrido invertido' },
  'especificacion/tipo-null.json'          : { cita: '§2.2 type null: feature sin geometría' },
  'especificacion/puntos-cuantizados.json' : { cita: '§2.1.2 posiciones de Point/MultiPoint cuantizadas sin delta' },

  'degenerados/vacios.json'            : { cita: 'SPECS §17.3-14: contenedor vacío ocupa ranura donde cierra' },
  'degenerados/anillo-abierto.json'    : { cita: 'DISENO-INTEROP §3.5: unión que no cierra suma openRings' },
  'degenerados/con-z.json'             : { cita: 'SPECS §17.3-4: z aparte con NaN; cuarta ordenada a extraOrdinates' },
  'degenerados/coleccion-anidada.json' : { cita: 'SPECS §17.1: aplanado en profundidad dentro del feature' },

  'adversarios/indice-fuera-de-rango.json'     : { error: 'estructura', cita: 'DISENO-INTEROP §3.5 índice fuera de rango' },
  'adversarios/indice-negativo-fuera.json'     : { error: 'estructura', cita: '§2.1.4: ~1 = −2 apunta al arco 1, que no existe' },
  'adversarios/indice-no-entero.json'          : { error: 'estructura', cita: '§2.1.4: un índice de arco es entero' },
  'adversarios/indice-texto.json'              : { error: 'estructura', cita: '§2.1.4: un índice de arco es número' },
  'adversarios/transform-incompleto.json'      : { error: 'estructura', cita: 'DISENO-INTEROP §3.5: transform sin translate' },
  'adversarios/sin-type.json'                  : { error: 'tipo', cita: 'SPECS §17.3-1: type es entrada' },
  'adversarios/tipo-desconocido.json'          : { error: 'tipo', cita: '§2.2: lista cerrada de tipos de geometría' },
  'adversarios/tipo-topology-anidado.json'     : { error: 'tipo', cita: '§2.2: Topology no es un objeto geometría' },
  'adversarios/hoja-con-geometries.json'       : { error: 'estructura', cita: 'SPECS §17.3-15' },
  'adversarios/coleccion-sin-geometries.json'  : { error: 'estructura', cita: 'SPECS §17.9: GeometryCollection sin geometries' },
  'adversarios/hoja-sin-arcs.json'             : { error: 'estructura', cita: 'SPECS §17.9: tipo sin coordenadas' },
  'adversarios/posicion-corta.json'            : { error: 'posicion', cita: '§2.1.1: una posición tiene al menos dos números' },
  'adversarios/infinito.json'                  : { error: 'numero', cita: 'DISENO-INTEROP §1.6-4' },
  'adversarios/geojson.json'                   : { error: 'formato', hint: 'geojson', cita: 'SPECS §17.9: raíz de otro formato con hint' },
  'adversarios/esrijson.json'                  : { error: 'formato', hint: 'esrijson', cita: 'SPECS §17.9: raíz de otro formato con hint' },
  'adversarios/truncado.json'                  : { error: 'truncado', cita: 'SPECS §17.9' },
  'adversarios/capa-repetida.json'             : { error: 'estructura', cita: 'spec-d §capas: nombre de objeto repetido' },
  'adversarios/arcs-no-array.json'             : { error: 'estructura', cita: '§2.1.3: arcs es un array' },
  'adversarios/coma-final.json'                : { error: 'sintaxis', cita: 'RFC 8259 §4' },
  'adversarios/dos-raices.json'                : { error: 'sintaxis', cita: 'RFC 8259 §2: un solo valor' },
  'adversarios/escape-invalido.json'           : { error: 'sintaxis', cita: 'RFC 8259 §7' },
  'adversarios/fuera-de-rango-geografico.json' : { aviso: 'crs', cita: 'SPECS §19.5: sin CRS declarado y fuera de rango avisa' },
}
