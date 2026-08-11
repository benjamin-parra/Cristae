// Categoría "puerta de entrada y codificación" del corpus de conformidad del §17.
//
// Lo que se contrata acá no es la geometría —de eso se ocupan las otras categorías— sino los BYTES:
// cómo entra el documento (§17.3-6), qué pasa con lo que no es ASCII, y qué pasa con los bytes que
// el JSON permite entre tokens. Por eso los documentos son pocos y chicos: el peso está en
// `formas-de-entrada.mjs`, que multiplica cada uno por las cuatro presentaciones del §17.8.
//
// 🔴 La afirmación central de esta categoría es de ACUERDO, no de veredicto. Donde el contrato no
// determina el resultado (el BOM, la secuencia multi-raíz), el corpus igual puede exigir algo
// fuerte: que las cuatro formas contesten LO MISMO, sea la salida una lectura buena o un
// `GeoJsonError` con el mismo `code` y el mismo `at`. Un desacuerdo entre formas es siempre un bug
// de normalización, no una opinión sobre el borde.

export const categoria = 'entradas'

// Estos documentos entran enteros en el pool de Node (< `LIMITE_POOL`) a propósito: por encima de
// ese tamaño `Buffer.concat` devuelve un buffer dedicado con `byteOffset` 0 y la cuarta forma deja
// de probar lo que dice probar. Todo documento que se sume acá tiene que respetarlo.
export const casos = [
  {
    archivo: 'bom-al-inicio.geojson',
    clausula: '§17.3-6 · §17.8 · §17.9',
    prueba:
      'Un FeatureCollection mínimo (1 feature, 1 Polygon, 1 anillo cerrado de 5 posiciones 2D) ' +
      'precedido por EF BB BF. Aísla el BOM del resto de la cobertura para que su veredicto —que el ' +
      'contrato no fija— no se lleve puesta ninguna expectativa que sí está determinada.',
    // El BOM no aparece ni en §17.3-6 ni en NINGUNA de las dos tablas del §17.9, que son las que
    // deciden qué borde se maneja y cuál no ocurre. Ese silencio es la ambigüedad.
    ambiguedad:
      'El contrato no dice si EF BB BF inicial se salta o es GeoJsonError("sintaxis", at 0). Lo que ' +
      'sí queda determinado por §17.3-6 es que la forma `string` no puede diferir: un string se ' +
      'CODIFICA, y U+FEFF vuelve a ser los mismos tres bytes.',
  },
  {
    archivo: 'espacios-y-no-ascii.geojson',
    clausula: '§17.3-4 · §17.3-6 · §17.3-9 · §17.4 · §17.9',
    prueba:
      'Los cuatro bytes que el JSON admite entre tokens (0x20, 0x09, 0x0A, 0x0D) más dos features ' +
      'byte-a-byte idénticos salvo que el primero escribe ñ/Ñ/€ en UTF-8 literal y el segundo con ' +
      'escapes \\uXXXX. Las tablas de geometría tienen que salir iguales para los dos; los rangos de ' +
      'BYTE, no.',
    // Los dos features comparten geometría LITERAL (mismo texto, mismos bytes) para que la
    // comparación entre ellos no dependa de qué cubre el rango: sea "el valor de `properties`" o
    // "el objeto que envuelve a la geometría", los dos rangos decodifican a lo mismo.
    ambiguedad:
      '§17.4 dice que el rango anotado es el del objeto que ENVUELVE a la geometría, pero §17.1 lo ' +
      'llama "rango de BYTE de properties", hay un `idAt` aparte y el ejemplo del §17.7 hace ' +
      'propertiesOf(f)?.nombre. Las dos lecturas dan cosas distintas para un Feature canónico.',
  },
  {
    archivo: 'secuencia-bbox-multiraiz.geojson',
    clausula: '§17.9 (bbox con más de una raíz) · §17.2 (hint "geojsonseq")',
    prueba:
      'Tres documentos raíz separados por saltos de línea —Feature con bbox, Feature sin bbox, ' +
      'FeatureCollection con bbox— o sea bbox en más de una raíz. Una raíz por línea: con las raíces ' +
      'formateadas en varias líneas el separador no significaría nada, porque habría saltos por todos ' +
      'lados y el límite entre raíces sólo se hallaría parseando.',
    ambiguedad:
      'El contrato dice qué pasa con `bbox` (queda en null) pero no si una secuencia se LEE o se ' +
      'rechaza —`GeoJsonError.hint` incluye "geojsonseq"—, ni cómo se acumulan las raíces en las ' +
      'tablas, ni dónde vive `bbox` en la salida: §17.1 no declara ese campo.',
  },
]
