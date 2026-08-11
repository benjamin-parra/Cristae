// Oráculo diferencial del lector de GeoJSON — contrato: SPECS §17.
//
// POR QUÉ EXISTE. La salida esperada de cada fixture del corpus tiene que derivarse del CONTRATO,
// no de lo que termine haciendo el lector. Una fixture congelada contra la implementación no
// prueba al lector: lo fotografía, y cualquier error que ya traiga queda ratificado como "lo
// esperado" para siempre.
//
// POR QUÉ USA JSON.parse. §17 le prohíbe al LECTOR construir el grafo; acá es al revés y a
// propósito: recorrer objetos es la vía más corta a un recorredor obviamente correcto, y que el
// parseo lo haga otro motor (el JSON del runtime) es justamente lo que vuelve independiente al
// oráculo del sujeto que mide. No se optimiza nada — la claridad le gana a la velocidad porque
// este archivo es el patrón de medida, no la ruta caliente.
//
// QUÉ NO CALCULA. `propAt` / `idAt` son rangos de BYTE (§17.4) y el oráculo trabaja sobre el
// grafo, donde los offsets ya se perdieron. Eso se prueba aparte. Tampoco produce `stats`: §17.3-5
// las define como cuenta de violaciones del lector, no como parte de la geometría.
//
// QUÉ HACE CUANDO §17 NO ALCANZA. Se planta: `Error('oraculo: …')`. Inventar una salida sería
// exactamente lo que este archivo existe para impedir; cada plantada es una ambigüedad reportable.

// Copia literal del enum de §17.2 en vez de importarlo del lector. Si el oráculo importara del
// sujeto, un enum mal numerado se cancelaría contra sí mismo en las dos puntas y ninguna fixture
// lo vería. GeometryCollection no tiene código: se aplana (§17.1).
export const GeoJsonKind = Object.freeze({
  Point: 1, MultiPoint: 2, LineString: 3, MultiLineString: 4, Polygon: 5, MultiPolygon: 6,
})

// El orden es el de §17.1 — feature → geometría → parte → anillo → vértice, y después los planos.
export const TABLAS = Object.freeze([
  'geometryAt', 'partAt', 'ringAt', 'vertexAt', 'kinds', 'featureOf', 'closed', 'xy', 'z',
])

const esObjeto = v => typeof v === 'object' && v !== null && !Array.isArray(v)

// `Object.hasOwn` y no `GeoJsonKind[type]`: un documento con `"type": "constructor"` resolvería
// contra el prototipo y entraría como geometría válida.
const esTipoDeGeometria = type => typeof type === 'string' && Object.hasOwn(GeoJsonKind, type)

const fueraDeContrato = motivo => { throw new Error(`oraculo: ${motivo}`) }

// ── entrada ───────────────────────────────────────────────────────────────────────────────────

// `ignoreBOM: true` NO es cosmético: por default el decodificador se COME un EF BB BF inicial, y
// entonces el oráculo estaría contestando "el BOM se salta" con un default de TextDecoder en vez de
// con el contrato. Se deja que el BOM sobreviva a la decodificación y se lo saltea a mano, que es lo
// que §17.3-6 le exige al lector — y así la regla se lee en el código en vez de esconderse en una
// opción del runtime.
const decodificador = new TextDecoder('utf-8', { ignoreBOM: true })

// §17.3-6: el BOM se saltea, venga por bytes o venga por string. Hacerlo en los dos caminos es lo que
// vuelve al oráculo invariante por forma de entrada, que es exactamente lo que se le exige al lector.
const sinBOM = texto => (texto.charCodeAt(0) === 0xFEFF ? texto.slice(1) : texto)

// El oráculo se contrata sobre el grafo, pero acepta los mismos envases que el lector para que el
// runner pueda pasarle los bytes crudos de la fixture sin decodificar dos veces.
// `decode` de una VISTA respeta byteOffset/byteLength por sí solo: la misma trampa que §17.3-6 le
// marca al lector con los Buffer pooled de Node, evitada sin tocar el ArrayBuffer entero.
const parsear = entrada =>
  typeof entrada === 'string'      ? JSON.parse(sinBOM(entrada))
  : ArrayBuffer.isView(entrada)    ? JSON.parse(sinBOM(decodificador.decode(entrada)))
  : entrada instanceof ArrayBuffer ? JSON.parse(sinBOM(decodificador.decode(new Uint8Array(entrada))))
  : entrada

// ── recorrido ─────────────────────────────────────────────────────────────────────────────────

export const oraculo = entrada => {
  const acc = nuevoAcumulador()
  featuresDe(parsear(entrada)).forEach(feature => agregarFeature(acc, feature))
  return sellar(acc)
}

const nuevoAcumulador = () => ({
  geometryAt : [0],
  partAt     : [0],
  ringAt     : [0],
  vertexAt   : [0],
  kinds      : [],
  featureOf  : [],
  closed     : [],
  xy         : [],
  z          : [],      // paralelo a los vértices; se descarta ENTERO si el documento resultó 2D
  hay3D      : false,
})

const esGeometria = v => esObjeto(v) && (esTipoDeGeometria(v.type) || v.type === 'GeometryCollection')

// §17.3-12: el feature es el objeto que POSEE el miembro `geometry`, no «el elemento de `features`».
// Atar el reconocimiento al nombre de un array deja afuera formas reales y legales —una colección de
// documentos bajo `docs`, `items` o cualquier otro nombre, cada uno con su `geometry` adentro— que es
// justamente lo que §17.4 existe para soportar. Con la regla del poseedor los cuatro casos colapsan
// en uno solo y no hace falta enumerarlos.
// Una colección VACÍA y un documento que no es GeoJSON llegan los dos a cero poseedores, y no son lo
// mismo: el primero es una lectura válida de cero features, el segundo es GeoJsonError('formato') con
// su `hint`. Los separa que la raíz se declare colección — sin eso, un TopoJSON entraría como
// "GeoJSON vacío" y el error se descubriría recién al ver el mapa en blanco.
const esColeccion = doc => doc.type === 'FeatureCollection' || Array.isArray(doc.features)

const featuresDe = doc =>
  !esObjeto(doc)      ? fueraDeContrato('la raíz no es un objeto JSON: §17.9 lo manda a GeoJsonError(formato)')
  : esGeometria(doc)  ? [doc]      // geometría desnuda en la raíz: es su propio feature
  : 'geometry' in doc ? [doc]      // Feature suelto
  : (hallados =>
      hallados.length || esColeccion(doc) ? hallados
      : fueraDeContrato(`raíz irreconocible: type=${JSON.stringify(doc.type)}, sin poseedores de \`geometry\` y sin declararse colección`)
    )(poseedores(doc))

// Recorrido en orden de documento. Se detiene en cuanto encuentra un poseedor o una geometría, así
// que nunca entra a `geometries` —sus elementos pertenecen al feature de más arriba, no son features
// propios— y NO entra al subárbol de `properties`, que es un rango opaco (§17.4) donde una geometría
// escondida no cuenta como tal (§17.3-11).
// Un objeto con forma de geometría NO cuenta acá: §17.3-11 sólo la reconoce como valor de `geometry`,
// como elemento de `geometries` o como raíz. Aceptarla en cualquier lado convierte un `"gemetry"` mal
// tipeado en una geometría válida — que es exactamente el error silencioso que la regla evita.
const poseedores = v =>
  Array.isArray(v)    ? v.flatMap(poseedores)
  : !esObjeto(v)      ? []
  : esGeometria(v)    ? []
  : 'geometry' in v   ? [v]
  : Object.entries(v).flatMap(([clave, hijo]) => (clave === 'properties' ? [] : poseedores(hijo)))

const agregarFeature = (acc, feature) => {
  const f = acc.geometryAt.length - 1        // el feature que se abre; se cierra al pie de la función
  geometriasHoja(geometriaDe(feature)).forEach(geom => agregarGeometria(acc, geom, f))
  acc.geometryAt.push(acc.kinds.length)
}

// `geometry: null` es un feature sin geometrías (§17.9) — no un error: devuelve null y el aplanado
// entrega la lista vacía, con lo que geometryAt[i] === geometryAt[i+1].
const geometriaDe = feature =>
  !esObjeto(feature)                  ? fueraDeContrato('un elemento de `features` no es un objeto')
  : 'geometry' in feature             ? feature.geometry
  : esTipoDeGeometria(feature.type)   ? feature
  : feature.type === 'GeometryCollection' ? feature
  : fueraDeContrato(`feature sin \`geometry\` y con type=${JSON.stringify(feature.type)}`)

// GeometryCollection no sobrevive a la salida (§17.1): sus hojas se emiten aplanadas en orden de
// recorrido. El aplanado en profundidad es idempotente, así que el anidamiento —legal: el RFC dice
// SHOULD avoid, no MUST NOT— no necesita un quinto nivel; `flatMap` recursivo ES ese aplanado.
// Un objeto que trae `geometries` y ADEMÁS se declara hoja afirma que contiene geometrías y que es
// una: §17.3-15 lo rechaza en vez de elegir cuál de las dos pierde. El oráculo se planta —no es una
// salida que él pueda derivar— y el veredicto del caso lo pone el contrato, como los truncados.
const geometriasHoja = geom =>
  geom === null || geom === undefined ? []
  : !esObjeto(geom)                   ? fueraDeContrato('una geometría no es un objeto')
  : 'geometries' in geom && esTipoDeGeometria(geom.type)
      ? fueraDeContrato(`objeto con geometries y type=${JSON.stringify(geom.type)}: §17.3-15`)
  : geom.type !== 'GeometryCollection' && !('geometries' in geom) ? [geom]
  : Array.isArray(geom.geometries)    ? geom.geometries.flatMap(geometriasHoja)
  : fueraDeContrato('GeometryCollection sin `geometries`')

const agregarGeometria = (acc, geom, f) => {
  const kind = esTipoDeGeometria(geom.type)
    ? GeoJsonKind[geom.type]
    : fueraDeContrato(`type ${JSON.stringify(geom.type)} no es una de las seis geometrías: §17.3-1 prohíbe adivinarlo por la forma`)
  partesDe(geom).forEach(parte => agregarParte(acc, parte))
  // Cierre atómico (§17.3-3): kinds, featureOf y partAt se escriben en el MISMO bloque. Reservar
  // una ranura en un sitio y comprometerla en otro es cómo se corre una tabla CSR en silencio.
  acc.kinds.push(kind)
  acc.featureOf.push(f)
  acc.partAt.push(acc.ringAt.length - 1)
}

const agregarParte = (acc, anillos) => {
  Array.isArray(anillos) || fueraDeContrato('una parte no es un array de anillos')
  anillos.forEach(anillo => agregarAnillo(acc, anillo))
  acc.ringAt.push(acc.vertexAt.length - 1)
}

const agregarAnillo = (acc, posiciones) => {
  Array.isArray(posiciones) || fueraDeContrato('un anillo no es un array de posiciones')
  posiciones.forEach(posicion => agregarVertice(acc, posicion))
  acc.closed.push(cerrado(posiciones) ? 1 : 0)
  acc.vertexAt.push(acc.xy.length / 2)
}

const agregarVertice = (acc, posicion) => {
  validarPosicion(posicion)
  acc.xy.push(posicion[0], posicion[1])   // orden RFC, sin invertir (§17.1)
  acc.z.push(alturaDe(posicion))
  acc.hay3D = acc.hay3D || posicion.length === 3
}

// ── normalización al modelo de cuatro niveles ─────────────────────────────────────────────────

// La estructura sale del TIPO, con la tabla de §17.1. La forma NO alcanza: `MultiLineString` y
// `Polygon` comparten profundidad 3 y significan cosas distintas —N líneas independientes contra un
// polígono con hoyos—, así que derivar de la forma les daría las mismas tablas. Que el lector reciba
// el `type` recién al cerrar (§17.3-2) es problema suyo, y §17.3-14 se lo resuelve difiriendo la
// decisión de forma al cierre; el oráculo trabaja sobre el grafo y siempre lo tiene a mano.
const partesDe = ({ type, coordinates }) =>
  coordinates === undefined     ? fueraDeContrato(`${type} sin miembro \`coordinates\`: §17.9 lo manda a GeoJsonError('estructura'), no hay tablas que derivar`)
  : !Array.isArray(coordinates) ? fueraDeContrato(`${type} con \`coordinates\` que no es un array`)
  : coordinates.length === 0    ? []      // §17.9: `"coordinates": []` es legal → 0 partes, 0 anillos
  : envolver(coordinates, type)

// Una parte es una sub-geometría, y el nivel existe para preservar la pertenencia anillo→polígono
// (§17.1). `MultiPoint` es la única excepción —un anillo de N vértices, no N partes— porque un punto
// no tiene interior y entre sus posiciones no hay ninguna pertenencia que preservar.
const ENVOLVER = {
  Point          : c => [[[c]]],
  MultiPoint     : c => [[c]],
  LineString     : c => [[c]],
  Polygon        : c => [c],
  MultiLineString: c => c.map(linea => [linea]),
  MultiPolygon   : c => c,
}

const PROFUNDIDAD_DE = { Point: 1, MultiPoint: 2, LineString: 2, Polygon: 3, MultiLineString: 3, MultiPolygon: 4 }

// La profundidad ya no decide la forma, pero sigue sirviendo de VALIDACIÓN: un `Polygon` cuyo
// `coordinates` viene anidado dos niveles no es un Polygon dentado, es un documento mal armado, y
// envolverlo igual sería el error silencioso corrido un nivel que §17.3-3 existe para matar.
const envolver = (coords, type) => {
  const esperada = PROFUNDIDAD_DE[type]
  if (esperada === undefined) return fueraDeContrato(`tipo de geometría desconocido: ${type}`)

  // INDECIDIBLE pasa: son los contenedores vacíos anidados, y §17.3-14 los ubica por el tipo.
  const d = profundidad(coords)
  return d !== INDECIDIBLE && d !== esperada
    ? fueraDeContrato(`${type} con \`coordinates\` anidado ${d} niveles; §17.1 pide ${esperada}`)
    : ENVOLVER[type](coords)
}

// Un array vacío NO dice a qué nivel pertenece MIRANDO LA FORMA: `[]` puede ser un anillo sin
// posiciones, una parte sin anillos o una posición de 0 números. Por eso no vale 1 —eso era medir la
// profundidad con un dato que no la tiene— sino INDECIDIBLE. Quien lo ubica es el tipo (§17.3-14).
const INDECIDIBLE = -1

// El descenso mira TODOS los hijos y no sólo `v[0]`: un `Polygon` con 300 anillos vacíos delante del
// real es legal, y medir por el primero lo leería como un anillo de 300 posiciones vacías. Que un
// hermano vacío no aporte profundidad es justamente lo que lo vuelve inofensivo acá.
const profundidad = v =>
  !Array.isArray(v) ? 0
  : v.length === 0  ? INDECIDIBLE
  : masProfunda(v.map(profundidad))

// Los hermanos con profundidad conocida tienen que COINCIDIR: un `coordinates` con una posición al
// lado de un anillo no es ninguna de las siete geometrías, y quedarse con el máximo lo leería como
// una forma válida corrida un nivel — el error silencioso que §17.3-3 existe para matar.
const masProfunda = ds => {
  const conocidas = [...new Set(ds.filter(d => d !== INDECIDIBLE))]
  return conocidas.length === 0 ? INDECIDIBLE
    : conocidas.length > 1 ? fueraDeContrato(`\`coordinates\` con hermanos de profundidad distinta (${conocidas.join(', ')}): la forma no es ninguna de las siete geometrías del RFC`)
    : 1 + conocidas[0]
}

// §17.3-4: una posición son 2 o 3 números y puede variar DENTRO del mismo anillo. `xy` lleva stride
// fijo 2 y la altitud vive aparte; derivar el conteo con `largo >> 1` es la falla que lee la
// altitud como latitud.
const validarPosicion = p =>
  !Array.isArray(p)              ? fueraDeContrato('una posición no es un array')
  : p.length < 2 || p.length > 3 ? fueraDeContrato(`posición de ${p.length} números: §17.3-4 contrata 2 o 3`)
  : p.some(n => typeof n !== 'number' || !Number.isFinite(n))
      ? fueraDeContrato(`posición con un valor no numérico o no finito: ${JSON.stringify(p)}`)
  : p

// NaN marca "la posición era 2D" (§17.1). Se compara con Object.is en todo el archivo porque
// NaN === NaN es false y taparía diferencias reales de dimensión.
const alturaDe = p => p.length === 3 ? p[2] : NaN

// "Cerrado" pide un último que REPITA a un primero distinto de sí mismo: con 0 o 1 posiciones no
// hay repetición que mirar, y §17.7 alimenta RingStore con `count - closed[r]` — un anillo de un
// solo vértice quedaría en cero vértices.
const cerrado = posiciones =>
  posiciones.length >= 2 && mismaPosicion(posiciones[0], posiciones.at(-1))

// Identidad de POSICIÓN (RFC §3.1.6), no sólo de xy: si la primera es 2D y la última 3D la altitud
// difiere (NaN contra número) y el anillo no cierra.
const mismaPosicion = (a, b) =>
  Object.is(a[0], b[0]) && Object.is(a[1], b[1]) && Object.is(alturaDe(a), alturaDe(b))

// ── sellado ───────────────────────────────────────────────────────────────────────────────────

const sellar = acc => {
  const f = acc.geometryAt.length - 1
  const g = acc.partAt.length - 1
  const p = acc.ringAt.length - 1
  const r = acc.vertexAt.length - 1
  const v = acc.xy.length / 2

  // La misma invariante que §17.3-3 le exige al lector al sellar. Acá es barata y no es decorativa:
  // un oráculo desalineado congela fixtures corridas por una ranura — la falla exacta que §17 mata.
  acc.kinds.length === g && acc.featureOf.length === g && acc.closed.length === r
    || fueraDeContrato(`tablas desalineadas: g=${g} kinds=${acc.kinds.length} featureOf=${acc.featureOf.length} r=${r} closed=${acc.closed.length}`)

  verificarCSR('geometryAt', acc.geometryAt, g)
  verificarCSR('partAt',     acc.partAt,     p)
  verificarCSR('ringAt',     acc.ringAt,     r)
  verificarCSR('vertexAt',   acc.vertexAt,   v)

  return {
    geometryAt : Uint32Array.from(acc.geometryAt),
    partAt     : Uint32Array.from(acc.partAt),
    ringAt     : Uint32Array.from(acc.ringAt),
    vertexAt   : Uint32Array.from(acc.vertexAt),
    kinds      : Uint8Array.from(acc.kinds),
    featureOf  : Uint32Array.from(acc.featureOf),
    closed     : Uint8Array.from(acc.closed),
    xy         : Float64Array.from(acc.xy),
    z          : acc.hay3D ? Float64Array.from(acc.z) : null,   // §17.1: null = documento 2D
    conteos    : { f, g, p, r, v },
  }
}

// Una tabla CSR arranca en 0, no decrece —las entradas repetidas son de diseño (§17.3-8: una
// geometría sin posiciones sale con 0 partes)— y termina en el total del nivel de abajo.
const verificarCSR = (nombre, tabla, total) =>
  tabla[0] === 0 && tabla.at(-1) === total && tabla.every((x, i) => i === 0 || x >= tabla[i - 1])
    ? tabla
    : fueraDeContrato(`CSR ${nombre} inconsistente: [${tabla}] contra un total de ${total}`)

// ── comparación ───────────────────────────────────────────────────────────────────────────────

// Compara SÓLO las tablas que el oráculo produce, así que el otro lado puede traer de más
// (`propAt`, `idAt`, `bytes`, `stats`) sin que eso cuente como diferencia. Devuelve la lista de
// diferencias legibles: vacía = idénticos.
export const comparar = (a, b, { maxPorTabla = 8 } = {}) =>
  !a || !b
    ? [`comparar: falta la salida ${!a ? 'a' : 'b'}`]
    : [
        ...TABLAS.flatMap(nombre => diferenciasDe(nombre, a[nombre], b[nombre], maxPorTabla)),
        ...diferenciasDeConteos(a.conteos, b.conteos),
      ]

const diferenciasDe = (nombre, x, y, max) =>
  x === undefined && y === undefined ? []
  : x === undefined || y === undefined ? [`${nombre}: falta en ${x === undefined ? 'a' : 'b'}`]
  : x === null && y === null           ? []
  : x === null || y === null           ? [`${nombre}: uno es null (documento 2D) y el otro trae ${(x ?? y).length} entradas`]
  : [...largos(nombre, x, y), ...celdas(nombre, x, y, max)]

const largos = (nombre, x, y) =>
  x.length === y.length ? [] : [`${nombre}: largo ${x.length} ≠ ${y.length}`]

// El prefijo común se compara igual aunque los largos difieran: saber DÓNDE empieza a divergir
// vale más que un "no coinciden" y suele señalar la tabla de arriba que corrió el rango.
const celdas = (nombre, x, y, max) => {
  const distintos = Array.from({ length: Math.min(x.length, y.length) }, (_, i) => i)
    .filter(i => !Object.is(x[i], y[i]))
  return [
    ...distintos.slice(0, max).map(i => `${ubicacion(nombre, i)}: ${fmt(x[i])} ≠ ${fmt(y[i])}`),
    ...(distintos.length > max ? [`${nombre}: … y ${distintos.length - max} diferencias más`] : []),
  ]
}

// `xy` es el único plano donde el índice no es el de la entidad: el par (2i, 2i+1) es el vértice i.
const ubicacion = (nombre, i) =>
  nombre === 'xy'
    ? `xy[${i}] (vértice ${i >> 1}, ${i % 2 === 0 ? 'lng' : 'lat'})`
    : `${nombre}[${i}]`

// -0 y NaN se imprimen aparte de lo que da String(): son justamente los valores donde una
// comparación laxa taparía una diferencia real, y el mensaje tiene que dejar ver cuál es cuál.
const fmt = n => Object.is(n, -0) ? '-0' : String(n)

// El lector no publica `conteos` —§17.1 no lo lista— y sus totales ya viajan en el último elemento
// de cada tabla CSR, que se compara arriba. Por eso sólo se contrastan si los DOS lados lo traen.
const diferenciasDeConteos = (x, y) =>
  !x || !y ? []
  : Object.keys(x).filter(k => x[k] !== y[k]).map(k => `conteos.${k}: ${x[k]} ≠ ${y[k]}`)
