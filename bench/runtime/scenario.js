// Escenario del banco: PRNG semillado, datasets deterministas por capa y el guion de fases.
// Sin dependencias — una corrida se reproduce entera con (capa, n, semilla) y nada más; por eso la
// semilla se muestra en la UI y viaja en el JSON: una corrida sin semilla no es un número citable.

/** Vista inicial de los dos stages. Los datasets se dispersan alrededor de este centro para que la
 *  escena entre en el viewport: si la geometría cae fuera, se mide el clipping, no la capa. */
export const VISTA = { centro: [-33.441, -70.654], zoom: 11 }

const TAU = Math.PI * 2

const EXTENSION = { lat: 0.22, lng: 0.30 }
const PALETA    = ['#22d3ee', '#a3e635', '#f472b6', '#fbbf24', '#818cf8']

const VERTICES_POR_LINEA  = 256
const VERTICES_POR_ANILLO = 48
const PASO_CAMINATA       = 0.0015

/** Fracción de unidades que la fase viva mueve por tick. */
const FRACCION_VIVA = 0.2
/** Desplazamiento por tick de una unidad viva, en grados. */
const DERIVA = 0.0016

// Cada metadato derivado tira de su propio PRNG: agregar uno no puede correr la secuencia de los
// otros, o el dataset dejaría de ser el mismo entre versiones del banco.
const SAL_GEOMETRIA = 0x9E3779B9
const SAL_MOVIBLES  = 0x85EBCA6B
const SAL_SALTOS    = 0xC2B2AE35

/**
 * PRNG semillado (mulberry32): mismo estado inicial ⇒ misma secuencia, en cualquier navegador.
 */
export const mulberry32 = semilla => {
  let estado = semilla >>> 0
  return () => {
    estado = (estado + 0x6D2B79F5) | 0
    let t = Math.imul(estado ^ (estado >>> 15), 1 | estado)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const disperso = rnd => [
  VISTA.centro[0] + (rnd() * 2 - 1) * EXTENSION.lat,
  VISTA.centro[1] + (rnd() * 2 - 1) * EXTENSION.lng,
]

const caminata = (desde, vertices, rnd) => {
  let [lat, lng] = desde
  return Array.from({ length: vertices }, () => {
    lat += (rnd() * 2 - 1) * PASO_CAMINATA
    lng += (rnd() * 2 - 1) * PASO_CAMINATA
    return [lat, lng]
  })
}

// Una SEMILLA es una unidad de N ya posicionada. Las ocho capas la consumen igual —la entidad i
// arranca en `datos[i]`, sea un punto, una línea o un anillo—, así que el ítem no se bifurca por
// capa: lo que cambia entre capas es qué CUENTA N (ver UNIDADES) y cómo se agrupan las semillas en
// geometría (ver GEOMETRIAS). Cada backend lee los campos de su capa y descarta el resto.
const sembrar = (n, rnd) => Array.from({ length: n }, (_, i) => {
  const [lat, lng] = disperso(rnd)
  return {
    id       : i,
    lat,
    lng,
    variante : PALETA[i % PALETA.length],
    peso     : rnd(),
    rumbo    : rnd() * 360,
    radio    : 200 + rnd() * 1800,
    texto    : `#${i}`,
  }
})

const reparto = (n, porGrupo, minimo) => {
  const cantidad = Math.max(1, Math.min(Math.round(n / porGrupo), Math.floor(n / minimo)))
  return { cantidad, tamano: Math.max(minimo, Math.floor(n / cantidad)) }
}

const lineas = (semillas, rnd) => {
  const { cantidad, tamano } = reparto(semillas.length, VERTICES_POR_LINEA, 2)
  return Array.from({ length: cantidad }, (_, i) => ({
    id     : i,
    path   : caminata([semillas[i].lat, semillas[i].lng], tamano, rnd),
    color  : PALETA[i % PALETA.length],
    weight : 2,
  }))
}

// El radio se jitterea por vértice: un anillo circular perfecto es simplificable y mediría el
// fast-path del simplificador de Leaflet en vez del costo real de n vértices.
const anillo = (semilla, vertices, rnd) => {
  const radio = 0.004 + rnd() * 0.02
  return Array.from({ length: vertices }, (_, k) => {
    const angulo = TAU * k / vertices
    const r      = radio * (0.75 + rnd() * 0.5)
    return [semilla.lat + Math.sin(angulo) * r, semilla.lng + Math.cos(angulo) * r * 1.2]
  })
}

const poligonos = (semillas, rnd) => {
  const { cantidad, tamano } = reparto(semillas.length, VERTICES_POR_ANILLO, 3)
  return Array.from({ length: cantidad }, (_, i) => ({
    id    : i,
    rings : anillo(semillas[i], tamano, rnd),
    fill  : PALETA[i % PALETA.length],
  }))
}

const trazo = (semillas, rnd) => [{
  id   : 'trazo',
  lat  : semillas[0].lat,
  lng  : semillas[0].lng,
  path : caminata([semillas[0].lat, semillas[0].lng], semillas.length, rnd),
}]

const mismas = semillas => semillas

/** Cómo se agrupan las N semillas en la geometría que consume la capa (`datos.geometria`). */
const GEOMETRIAS = {
  points   : mismas,
  heat     : mismas,
  html     : mismas,
  label    : mismas,
  circle   : mismas,
  lines    : lineas,
  polygon  : poligonos,
  editable : trazo,
}

/** Qué cuenta N en cada capa. Si no se fija, dos capas con el mismo N no comparan. */
const UNIDADES = {
  points   : 'items',
  heat     : 'items',
  html     : 'items',
  label    : 'items',
  circle   : 'circulos',
  lines    : 'vertices totales',
  polygon  : 'anillos × vertices',
  editable : 'vertices de un trazo',
}

// Subconjunto sin reposición por Fisher-Yates parcial: determinista con la misma semilla y sin sesgo
// de posición (un muestreo por zancada correlaciona con el orden de generación, que es espacial).
const muestra = (total, fraccion, rnd) => {
  const indices = Int32Array.from({ length: total }, (_, i) => i)
  const k       = Math.max(1, Math.round(total * fraccion))
  for (let i = 0; i < k; i++) {
    const j = i + ((rnd() * (total - i)) | 0)
    ;[indices[i], indices[j]] = [indices[j], indices[i]]
  }
  return indices.slice(0, k)
}

// Metadato PEREZOSO: se calcula en el primer acceso y queda fijado. Un dataset de 500 k unidades no
// puede pagar geometría ni muestreos que ningún backend pidió, y el costo caería dentro de la fase
// que se está midiendo.
const perezoso = (datos, nombre, calcular) => Object.defineProperty(datos, nombre, {
  configurable : true,
  get() {
    const valor = calcular()
    Object.defineProperty(datos, nombre, { value: valor })
    return valor
  },
})

/**
 * Dataset determinista de una capa. Devuelve el ARRAY de N semillas —posiciones en la unidad de N de
 * esa capa— para que un backend arme sus entidades con `datos[i].lat/.lng` sin inventar posiciones;
 * el resto viaja colgado, NO enumerable (el array se itera y se serializa limpio) y perezoso:
 *   · `unidad`     — qué cuenta N en esta capa.
 *   · `geometria`  — las semillas ya agrupadas en lo que la capa consume (líneas, anillos, el trazo).
 *   · `movibles`   — Int32Array con el 20 % de unidades que toca la fase viva (índices de `datos`).
 *   · `saltos`     — Float32Array [dLat,dLng] por unidad movible, precomputado: la fase viva no
 *                    consulta el PRNG, así A y B derivan idéntico aunque consuman `rnd` distinto.
 *   · `paraN(m)`   — el mismo dataset para otro N (lo que necesita `backend.aplicarN`).
 */
export const datosDe = (capa, n, semilla) => {
  const unidad = UNIDADES[capa]
  if (!unidad) throw new Error(`bench: capa desconocida "${capa}" (${Object.keys(UNIDADES).join(', ')})`)

  const total = Math.max(2, n | 0)
  const datos = Object.defineProperties(sembrar(total, mulberry32(semilla)), {
    capa    : { value: capa },
    unidad  : { value: unidad },
    n       : { value: total },
    semilla : { value: semilla },
    paraN   : { value: m => datosDe(capa, m, semilla) },
  })

  perezoso(datos, 'geometria', () => GEOMETRIAS[capa](datos, mulberry32(semilla ^ SAL_GEOMETRIA)))
  perezoso(datos, 'movibles', () => muestra(total, FRACCION_VIVA, mulberry32(semilla ^ SAL_MOVIBLES)))
  perezoso(datos, 'saltos', () => {
    const rnd = mulberry32(semilla ^ SAL_SALTOS)
    return Float32Array.from({ length: datos.movibles.length * 2 }, () => (rnd() * 2 - 1) * DERIVA)
  })
  return datos
}

const SIN_ANIMACION = { animate: false }
// Reusado por frame: el guion corre DENTRO del rAF medido, así que no puede asignar por paso.
const DESPLAZAMIENTO = [0, 0]

const PAN_PX          = 7
const PAN_PERIODO_MS  = 1000
const ZOOM_AMPLITUD   = 1.5
const ZOOM_PERIODO_MS = 1500

// El estímulo es función del RELOJ, no del contador de frames: A y B comparten `t` porque corren en
// el mismo rAF, así que ven el mismo movimiento aunque la corrida deje caer frames. Los períodos
// dividen justo la duración de su fase ⇒ cada fase termina en la vista con la que empezó.
const panear = (stage, t) => {
  DESPLAZAMIENTO[0] = PAN_PX * Math.sin(TAU * t / PAN_PERIODO_MS)
  DESPLAZAMIENTO[1] = PAN_PX * Math.cos(TAU * t / PAN_PERIODO_MS) / 2
  return stage.engine.camera.panBy(DESPLAZAMIENTO, SIN_ANIMACION)
}

// Barrido fraccional (el mapa se crea con `zoomSnap: 0`): reproyecta todas las capas en cada frame,
// que es el costo que interesa, sin depender del reloj de la animación de zoom de Leaflet.
const zoomear = (stage, t) =>
  stage.engine.camera.setZoom(VISTA.zoom + ZOOM_AMPLITUD * Math.sin(TAU * t / ZOOM_PERIODO_MS))

const vivir = (stage, t) => stage.backend.paso(t)

/**
 * Guion único para A y B. `tipo` dice quién ejecuta la fase:
 *   · `montaje`  — la abre `medidor.iniciar()` dentro del stage, no el harness: el instrumento tiene
 *                  que estar enganchado antes de que nazca la primera capa.
 *   · `paint`    — se agota por FRAMES (el primer paint no dura un tiempo, dura un frame).
 *   · `frames`   — se agota por RELOJ; `paso` se aplica una vez por frame a cada stage.
 *   · `teardown` — la marca el harness alrededor de `stage.destruir()`.
 */
export const GUION = [
  { nombre: 'montaje',      tipo: 'montaje'                            },
  { nombre: 'primer-paint', tipo: 'paint',    frames: 2                },
  { nombre: 'reposo',       tipo: 'frames',   ms: 3000                 },
  { nombre: 'pan',          tipo: 'frames',   ms: 3000, paso: panear   },
  { nombre: 'zoom',         tipo: 'frames',   ms: 3000, paso: zoomear  },
  { nombre: 'vivo',         tipo: 'frames',   ms: 3000, paso: vivir    },
  { nombre: 'destruir',     tipo: 'teardown'                           },
]

/** Duración nominal del guion (sin montaje ni teardown, que no tienen presupuesto de tiempo). */
export const MS_TOTAL = GUION.reduce((ms, fase) => ms + (fase.ms ?? 0), 0)
