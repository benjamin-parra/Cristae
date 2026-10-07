// Cuántos vértices lleva una curva para que la cuerda no se aparte de ella más que una tolerancia. Las
// dos fórmulas hablan en METROS, y cada tolerancia dice quién la usa: `GROUND`, las piezas que no
// re-ingieren por zoom —`ring`, `arc` y los radios de un sector—, y `viewTolerance`, las capas que sí lo
// hacen, que la llevan de píxeles a metros con el zoom vigente. Módulo puro: sin Leaflet, sin DOM.
import { MEAN_RADIUS } from './geodesic.js'

const D             = Math.PI / 180
const WORLD_PER_RAD = 256 / (2 * Math.PI)   // píxeles world0 por radián de longitud, en el ecuador
const VIEW_PX       = 0.2                   // cuánto se aparta la cuerda del arco, en píxeles de pantalla
const MIN_SEGMENTS  = 16
const MAX_SEGMENTS  = 4096

// La tolerancia sin vista, en metros.
export const GROUND = 0.1

// Los metros que valen `VIEW_PX` a `zoom` en una forma de radio `radius` centrada en `lat`. La escala de
// Mercator se toma en la latitud más alta que la forma toca, que es la mayor de las que mide.
export const viewTolerance = (lat, radius, zoom) =>
  VIEW_PX * MEAN_RADIUS * Math.cos(Math.abs(lat) * D + radius / MEAN_RADIUS) / (WORLD_PER_RAD * 2 ** zoom)

// Segmentos que mantienen la flecha de la cuerda de un arco de radio `radius` bajo `tolerance`:
// n = π / acos(1 − tolerance / radius), con la potencia de dos que lo cubre, entre 16 y 4096. Es potencia
// de dos para que un zoom que no cruce una potencia no re-tesele.
export const segmentsFor = (radius, tolerance) =>
  Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS,
    2 ** Math.ceil(Math.log2(Math.PI / Math.acos(Math.max(-1, 1 - tolerance / radius))))))

// Tramos en que se parte una geodésica de `length` metros cuya latitud de mayor módulo es `lat`, en
// grados, para que su polilínea recta en Mercator no se aparte de ella más que `tolerance`. La separación
// entre la recta de Mercator y la geodésica es a lo más L²·tan|φ| / 8R; de ahí m = ⌈√(separación /
// tolerancia)⌉, y 1 cuando la separación ya está bajo la tolerancia. Se acota a 4096 como los segmentos:
// junto a un polo la cota diverge.
export const stepsFor = (length, lat, tolerance) =>
  Math.min(MAX_SEGMENTS, Math.max(1,
    Math.ceil(Math.sqrt(length * length * Math.tan(Math.abs(lat) * D) / (8 * MEAN_RADIUS) / tolerance))))
