// Punto de enganche ÚNICO entre las pruebas de conformidad y el lector de §17.
//
// POR QUÉ EXISTE UN ARCHIVO PARA DOS LÍNEAS. El corpus se escribió ANTES que el lector, a propósito:
// así la salida esperada se deriva del contrato y no de lo que la implementación termine haciendo.
// Concentrar la importación acá es lo que permite validar una SEGUNDA implementación del mismo
// contrato cambiando un solo archivo — y lo que evita que alguien “destrabe” un test suelto
// apuntándolo a otro lado. Toda prueba de conformidad entra por acá, con o sin opciones.

import { readGeoJson, areasOf } from '../../src/geojson/index.js'

export const leer = (bytes, options) => readGeoJson(bytes, options)

export const areasDe = geo => areasOf(geo)

// El corpus verifica la FORMA del error (§17.2: `code` + `at`) y no `instanceof`: la clase vive en el
// lector, que hoy no existe, y un test que importara la clase no podría ni cargarse. Cuando el lector
// llegue, esta función se queda igual — lo que se chequea es el contrato publicado, no la identidad
// del constructor, que es detalle de implementación.
export const esErrorDelLector = e =>
  e instanceof Error && e.name === 'GeoJsonError' && typeof e.code === 'string' && Number.isInteger(e.at)
