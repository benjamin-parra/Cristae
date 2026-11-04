// Qué ejercita cada fixture del corpus de EsriJSON y qué se espera. Sin `error`, la salida esperada es
// la del oráculo, y `aviso` es el código del único warning si lo hay. Las citas son de la ArcGIS REST
// API, «Geometry objects» y «FeatureSet object» (DISENO-INTEROP §3.6), sin número de sección.

export const ESPERADO = {
  'felices/featureset-poligonos.json' : { cita: 'FeatureSet; Polygon con hoyo y segundo exterior (DISENO-INTEROP §2.4)' },
  'felices/featureset-lineas.json'    : { cita: 'Polyline; hasZ del FeatureSet llega después de los features (§3.6)' },
  'felices/feature-suelto.json'       : { cita: 'feature suelto; Point con z' },
  'felices/geometria-suelta.json'     : { cita: 'geometría suelta; Multipoint' },

  'especificacion/envelope.json'       : { cita: 'Envelope → Polygon de 5 vértices cerrado, horario' },
  'especificacion/punto-vacio.json'    : { cita: 'x null o "NaN": punto vacío (§1.6-4); Envelope vacío' },
  'especificacion/hasm-sin-hasz.json'  : { cita: 'hasM sin hasZ: la tercera ordenada es M y se descarta (§3.6)' },
  'especificacion/hasz-y-hasm.json'    : { cita: 'hasZ y hasM: z en la tercera, M en la cuarta; hasZ false descarta' },
  'especificacion/curvas.json'         : { cita: 'curveRings/curvePaths: skippedGeometries, el feature queda (§3.6)' },

  'degenerados/hoyos-anidados.json' : { cita: '§2.4: hoyo al exterior más chico; exteriores en orden de archivo' },
  'degenerados/huerfano.json'       : { cita: '§2.4-3: hoyo sin exterior sale como exterior propio' },
  'degenerados/area-cero.json'      : { cita: '§2.4-4: anillo de área 0 es exterior y degenerado' },
  'degenerados/vacios.json'         : { cita: 'geometrías vacías y features sin geometría (SPECS §17.9)' },
  'degenerados/anillo-abierto.json' : { cita: 'anillos sin cerrar: se cuentan, no se corrigen (SPECS §17.3-5)' },

  'adversarios/dos-roles.json'           : { error: 'estructura', cita: 'raíz FeatureSet y geometría a la vez' },
  'adversarios/dos-formas.json'          : { error: 'estructura', cita: 'paths y rings en la misma geometría' },
  'adversarios/feature-y-geometria.json' : { error: 'estructura', cita: 'raíz feature y geometría a la vez' },
  'adversarios/punto-sin-y.json'         : { error: 'estructura', cita: 'Point sin y' },
  'adversarios/punto-y-null.json'        : { error: 'posicion', cita: 'x numérico con y vacío' },
  'adversarios/x-texto.json'             : { error: 'posicion', cita: 'x es número, null o "NaN"' },
  'adversarios/envelope-incompleto.json' : { error: 'estructura', cita: 'Envelope sin ymax' },
  'adversarios/topojson.json'            : { error: 'formato', hint: 'topojson', cita: 'SPECS §17.9: hint' },
  'adversarios/geojson.json'             : { error: 'formato', hint: 'geojson', cita: 'SPECS §17.9: hint' },
  'adversarios/raiz-vacia.json'          : { error: 'formato', cita: 'raíz sin FeatureSet, feature ni geometría' },
  'adversarios/raiz-array.json'          : { error: 'formato', cita: 'la raíz es un objeto' },
  'adversarios/posicion-corta.json'      : { error: 'posicion', cita: 'una posición tiene al menos x e y' },
  'adversarios/infinito.json'            : { error: 'numero', cita: 'DISENO-INTEROP §1.6-4' },
  'adversarios/wkid-no-soportado.json'   : { error: 'crs', detalle: 'wkid:4269', cita: 'DISENO-INTEROP §2.5: NAD83 no está en D-2' },
  'adversarios/crs-distintos.json'       : { error: 'crs', cita: 'DISENO-INTEROP §2.5: una lectura publica un CRS' },
  'adversarios/truncado.json'            : { error: 'truncado', cita: 'SPECS §17.9' },
  'adversarios/hasz-no-booleano.json'    : { error: 'estructura', cita: 'hasZ es booleano' },
  'adversarios/fuera-de-rango.json'      : { aviso: 'crs', cita: 'SPECS §19.5: sin CRS y fuera del rango geográfico avisa' },
  'adversarios/feature-no-objeto.json'   : { error: 'estructura', cita: 'un feature es un objeto' },
  'adversarios/basura-al-final.json'     : { error: 'sintaxis', cita: 'RFC 8259 §2' },
}
