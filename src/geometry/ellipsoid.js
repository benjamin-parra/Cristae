// El elipsoide de revolución como modelo de `distance`: la geodésica por el problema inverso de
// Karney, que converge en todo el elipsoide, antípodas incluidas. Vive en su propio módulo, y
// `distance` no lo importa, para que la librería geodésica entre sólo al bundle de quien lo usa.
//
// La librería se publica como CommonJS/UMD, sin campo `module` ni `exports`: se importa por su default,
// que es `module.exports` en Node, en esbuild y en Vite. Un import con nombre no pasaría en Node, que
// no puede leer los nombres de un UMD.
import geodesic from 'geographiclib-geodesic'
import { checkLength, makeModel } from './geodesic.js'

export const ellipsoid = (semiMajorAxis, flattening) => {
  checkLength(semiMajorAxis, '[ellipsoid] semiMajorAxis')
  if (!(Number.isFinite(flattening) && flattening >= 0 && flattening < 1))
    throw new RangeError(`[ellipsoid] flattening tiene que estar en [0, 1): ${flattening}`)
  const { Geodesic, DISTANCE } = geodesic.Geodesic
  const solver = new Geodesic(semiMajorAxis, flattening)
  return makeModel((lat1, lng1, lat2, lng2) => solver.Inverse(lat1, lng1, lat2, lng2, DISTANCE).s12)
}

// El achatamiento es 1 / 298,257223563, escrito como el literal del mismo double: esbuild no descarta
// una llamada pura si un argumento es una división, y quien importa sólo `ellipsoid` pagaría este
// elipsoide al cargar el módulo.
export const WGS84 = /* @__PURE__ */ ellipsoid(6378137, 0.0033528106647474805)
