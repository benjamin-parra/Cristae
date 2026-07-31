// Contrato del relleno por stencil-then-cover, sobre un doble de gl que registra los uniforms además de
// las subidas. Lo que se observa es lo que la capa le PIDE a la GPU —qué aristas emite cada draw y con
// qué rango—, y de ahí se reconstruye el conjunto de triángulos del abanico para evaluarlo en CPU con
// la misma regla par-impar que el stencil, contra un oráculo de ray casting independiente.
//
// Cinco invariantes:
//   · el pase completo emite exactamente las aristas del anillo, incluida la del cierre;
//   · promover un vértice no cambia el relleno: los dos tramos vivos reponen las dos aristas que
//     salieron del pase estático, y eso vale también cuando el vértice cae en el borde de un chunk o
//     es el primero del anillo (su `prev` vive en el chunk más lejano);
//   · el arrastre no escribe un solo byte a GPU;
//   · el XOR entre anillos abre el agujero;
//   · la cobertura devuelve el stencil a cero sin `clear`.
//
// El harness va primero: instala los globals de módulo que el resto del árbol toca al evaluarse.
import { makeGl } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ChunkedPath } from '../../src/geometry/ChunkedPath.js'
import { EditArena } from '../../src/render/EditArena.js'
import { EditFillLayer } from '../../src/render/EditFillLayer.js'
import { pointInPoly } from '../../src/geometry/polygon.js'

// cap 31 · 15 parejas por chunk: un anillo de 48 vértices cruza varios chunks con pocos puntos.
const BITS = 5
const W0   = 256 / 360
const SIZE = { x: 800, y: 600 }

const project = (lat, lng, out) => {
  out[0] = (lng + 180) * W0
  out[1] = (90 - lat) * W0
}

/* ── Doble de gl: constantes estables, uniforms etiquetados y un log ordenado de llamadas ── */

// El Proxy del harness devuelve una función NUEVA por cada constante que no conoce, así que
// `gl.KEEP !== gl.KEEP`: las que decide este contrato se fijan acá para poder asertarlas.
const CONSTANTES = {
  TRIANGLES : 'TRIANGLES', KEEP : 'KEEP', ZERO : 'ZERO', INVERT : 'INVERT',
  NOTEQUAL  : 'NOTEQUAL',  ALWAYS : 'ALWAYS', BLEND : 'BLEND',
  STENCIL_TEST : 'STENCIL_TEST', SCISSOR_TEST : 'SCISSOR_TEST',
  SRC_ALPHA : 'SRC_ALPHA', ONE_MINUS_SRC_ALPHA : 'ONE_MINUS_SRC_ALPHA',
  VERTEX_SHADER : 'VERTEX_SHADER', FRAGMENT_SHADER : 'FRAGMENT_SHADER',
  COMPILE_STATUS : 'COMPILE_STATUS', LINK_STATUS : 'LINK_STATUS',
}

const espiar = base => {
  const log   = []
  const anota = (op, ...args) => log.push({ op, args })
  const propio = {
    log,
    // La localización lleva el NOMBRE del uniform: es lo que permite leer el plan de dibujo del log.
    getUniformLocation : (_program, nombre) => ({ nombre }),
    useProgram         : () => anota('useProgram'),
    uniform1i          : (loc, v) => anota(loc.nombre, v),
    uniform2f          : (loc, x, y) => anota(loc.nombre, x, y),
    uniform4f          : (loc, r, g, b, a) => anota(loc.nombre, r, g, b, a),
    uniformMatrix4fv   : (loc, _transpose, m) => anota(loc.nombre, [...m]),
    bindTexture        : (_target, textura) => anota('bindTexture', textura),
    drawArrays         : (_mode, first, count) => anota('drawArrays', first, count),
    scissor            : (x, y, ancho, alto) => anota('scissor', x, y, ancho, alto),
    stencilOp          : (falla, zeta, pasa) => anota('stencilOp', falla, zeta, pasa),
    stencilFunc        : (func, ref, mask) => anota('stencilFunc', func, ref, mask),
    enable             : capacidad => anota('enable', capacidad),
    disable            : capacidad => anota('disable', capacidad),
    clear              : () => anota('clear'),
  }
  return new Proxy(base, { get: (t, p) => propio[p] ?? CONSTANTES[p] ?? t[p] })
}

/* ── Montaje ── */

// Cuadrado de n vértices recorriendo el perímetro, en [lat, lng] y con cierre implícito.
const LADOS = [(u, r) => [-r, -r + 2 * r * u], (u, r) => [-r + 2 * r * u, r],
  (u, r) => [r, r - 2 * r * u], (u, r) => [r - 2 * r * u, -r]]

const cuadrado = (n, radio, lat = -33.45, lng = -70.66) => Array.from({ length: n }, (_, i) => {
  const t = i / n * 4
  const [dy, dx] = LADOS[Math.floor(t)](t - Math.floor(t), radio)
  return [lat + dy, lng + dx]
})

// Un círculo toca sus extremos con UN vértice, no con un lado entero: la caja del contorno no se puede
// armar con una sola esquina de cada chunk, como sí dejaría pasar un cuadrado.
const circulo = (n, radio, lat = -33.45, lng = -70.66) => Array.from({ length: n }, (_, i) => {
  const a = 2 * Math.PI * i / n
  return [lat + radio * Math.sin(a), lng + radio * Math.cos(a)]
})

// El agujero va DESCENTRADO a propósito: el ancla de cada anillo es el centro de su caja, y con dos
// cuadrados concéntricos las dos anclas coincidirían — justo el caso que no prueba nada.
const HUECO = cuadrado(20, 0.008, -33.446, -70.663)

const montar = (anillos, { closed = true } = {}) => {
  const gl    = espiar(makeGl())
  const rings = anillos.map(points => {
    const path  = new ChunkedPath({ points, localBits: BITS, closed })
    const arena = new EditArena({ gl, path, project })
    return { path, arena }
  })
  const capa  = new EditFillLayer({ gl, rings })
  const vista = { zoom: 13, center: { x: rings[0].arena.anchor.x, y: rings[0].arena.anchor.y }, size: SIZE }
  return { gl, rings, capa, vista }
}

const dibujar = ({ gl, capa, vista }, drag = null) => {
  gl.log.length = 0
  assert.equal(capa.draw({ ...vista, drag }), true, 'el contorno tiene que quedar en pantalla')
  return gl.log
}

const limpiar = spy => {
  spy.texImages.length = spy.texSubImages.length = 0
  spy.bufferDatas.length = spy.bufferSubDatas.length = spy.uploads.length = 0
}

/* ── Lectura del log: draws con su estado de uniforms, y de ahí las aristas ── */

// Los uniforms son por PROGRAMA: cambiar de programa invalida el estado acumulado.
const dibujos = log => {
  const estado = {}
  return log.reduce((out, { op, args }) => {
    if (op === 'drawArrays') out.push({ count: args[1], ...estado })
    else if (op === 'useProgram') Object.keys(estado).forEach(k => delete estado[k])
    else estado[op] = args
    return out
  }, [])
}

const VIVO = 'vivo'

// La MISMA regla que el vertex shader: la arista e va de `uFirst + 2e` al siguiente, y la última del
// tramo cierra contra `uTail`. Es una REIMPLEMENTACIÓN: estos tests leen los uniforms, no ejecutan
// GLSL, así que el shader y este oráculo pueden derivar sin que nada falle. Lo ata `DERIVACION`.
const ARISTAS = {
  uEdges : ({ uFirst, uEdges, uTail }) => Array.from({ length: uEdges[0] }, (_, e) => [
    uFirst[0] + 2 * e,
    e + 1 < uEdges[0] ? uFirst[0] + 2 * (e + 1) : uTail[0],
  ]),
  uVivo  : ({ uPrev, uNext }) => [[uPrev[0], VIVO], [VIVO, uNext[0]]],
}

const aristasEmitidas = (log, rings) => dibujos(log).flatMap(d => {
  const clase = 'uEdges' in d ? 'uEdges' : 'uVivo' in d ? 'uVivo' : null
  if (!clase) return []
  const anillo = rings.findIndex(r => r.arena.texture === d.bindTexture[0])
  return ARISTAS[clase](d).map(([a, b]) => ({ anillo, a, b }))
})

const conjunto = aristas => aristas.map(({ anillo, a, b }) => `${anillo}:${a}→${b}`).sort()

const refs = path => {
  const out = []
  path.forEachVertex((_x, _y, ref) => out.push(ref))
  return out
}

// Las aristas que el anillo TIENE, leídas del trazo: pares consecutivos más el cierre.
const aristasDelTrazo = (path, anillo = 0) => {
  const vs = refs(path)
  return vs.map((v, i) => ({ anillo, a: v, b: vs[(i + 1) % vs.length] }))
}

// El mismo conjunto con el vértice promovido reemplazado por su posición viva.
const promovido = (aristas, anillo, vertice) => aristas.map(e => (e.anillo !== anillo ? e : {
  anillo,
  a : e.a === vertice ? VIVO : e.a,
  b : e.b === vertice ? VIVO : e.b,
}))

const rangos = arena => {
  const out = []
  arena.eachRange((_ordinal, first, count) => count && out.push({ first, verts: count >> 1 }))
  return out
}

/* ── Evaluación en CPU: el abanico emitido, con la misma regla par-impar ── */

const posicionDe = (arena, ref, vivo) => (ref === VIVO ? vivo
  : { x: arena.anchor.x + arena.relX(ref), y: arena.anchor.y + arena.relY(ref) })

const triangulos = (log, rings, vivo = null) => aristasEmitidas(log, rings).map(({ anillo, a, b }) => {
  const { arena } = rings[anillo]
  return { o: arena.anchor, a: posicionDe(arena, a, vivo), b: posicionDe(arena, b, vivo) }
})

const lado = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)

// Pertenencia ESTRICTA: las muestras se eligen fuera de todo trazo y de todo radio, así que el
// desempate del borde no entra en juego y un empate sería un punto mal elegido, no una decisión.
const cubre = ({ o, a, b }, r) => {
  const d0 = lado(o, a, r), d1 = lado(a, b, r), d2 = lado(b, o, r)
  return (d0 > 0 && d1 > 0 && d2 > 0) || (d0 < 0 && d1 < 0 && d2 < 0)
}

const paridad = (tris, r) => tris.filter(t => cubre(t, r)).length % 2

// El contorno del anillo tal como quedó en el espejo (float32 + ancla), en [lat, lng] para el oráculo.
const contorno = ({ path, arena }, vivo = null, vertice = -1) => refs(path).map(ref => {
  const p = posicionDe(arena, ref === vertice ? VIVO : ref, vivo)
  return [p.y, p.x]
})

// Par-impar entre anillos: el XOR es lo que deja el agujero afuera.
const dentro = (contornos, r) => contornos.reduce((n, c) => n + (pointInPoly(r.y, r.x, c) ? 1 : 0), 0) % 2

const caja = contornos => contornos.flat().reduce((b, [lat, lng]) => ({
  minX : Math.min(b.minX, lng), maxX : Math.max(b.maxX, lng),
  minY : Math.min(b.minY, lat), maxY : Math.max(b.maxY, lat),
}), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity })

// Rejilla con desplazamiento irracional y margen: cae adentro, afuera y en el agujero, y nunca sobre
// una arista o un radio.
const MUESTRAS = 23
const MARGEN   = 0.15

const rejilla = contornos => {
  const b = caja(contornos)
  const ancho = (b.maxX - b.minX) * (1 + 2 * MARGEN), alto = (b.maxY - b.minY) * (1 + 2 * MARGEN)
  return Array.from({ length: MUESTRAS * MUESTRAS }, (_, k) => ({
    x : b.minX - ancho * MARGEN / (1 + 2 * MARGEN) + ancho * ((k % MUESTRAS) + 0.31831) / MUESTRAS,
    y : b.minY - alto  * MARGEN / (1 + 2 * MARGEN) + alto  * (Math.floor(k / MUESTRAS) + 0.27182) / MUESTRAS,
  }))
}

// Compara el relleno emitido contra el oráculo en toda la rejilla y describe la primera discrepancia.
const comparar = (tris, contornos, nota) => {
  const puntos = rejilla(contornos)
  const falla  = puntos.findIndex(r => paridad(tris, r) !== dentro(contornos, r))
  if (falla >= 0) assert.fail(`${nota}: discrepa en (${puntos[falla].x}, ${puntos[falla].y}) — ` +
    `abanico ${paridad(tris, puntos[falla])} vs oráculo ${dentro(contornos, puntos[falla])}`)
  assert.ok(puntos.some(r => dentro(contornos, r)), `${nota}: ninguna muestra cayó adentro`)
}

/* ── 1. El pase completo ── */

test('el pase completo emite las aristas del anillo, con el cierre, y ningún rango vacío', () => {
  const escena = montar([cuadrado(48, 0.02)])
  const log    = dibujar(escena)

  assert.ok(rangos(escena.rings[0].arena).length >= 2, 'el anillo tiene que cruzar chunks')
  assert.deepEqual(conjunto(aristasEmitidas(log, escena.rings)),
    conjunto(aristasDelTrazo(escena.rings[0].path)))
  assert.ok(dibujos(log).every(d => d.count > 0), 'un draw de cero vértices es trabajo tirado')
})

test('un rango por chunk: el pase estático dibuja tantas veces como chunks tiene el anillo', () => {
  const escena = montar([cuadrado(48, 0.02)])
  const log    = dibujar(escena)
  const chunks = rangos(escena.rings[0].arena)

  assert.equal(dibujos(log).filter(d => 'uEdges' in d).length, chunks.length)
  assert.deepEqual(dibujos(log).filter(d => 'uEdges' in d).map(d => d.uEdges[0]),
    chunks.map(r => r.verts), 'cada rango aporta una arista por vértice: la última cierra en el vecino')
})

/* ── 2. Promoción: el relleno no cambia ── */

const equivale = (escena, vertice, vivo) => {
  const completo = conjunto(promovido(aristasDelTrazo(escena.rings[0].path), 0, vertice))
  const conDrag  = dibujar(escena, { ring: 0, vertex: vertice, ...vivo })
  assert.deepEqual(conjunto(aristasEmitidas(conDrag, escena.rings)), completo)
  return conDrag
}

// El arrastre viaja en world0, que es el espacio de `project`.
const enMundo = (lat, lng) => {
  const out = new Float64Array(2)
  project(lat, lng, out)
  return { x: out[0], y: out[1] }
}

// Los draws que salen del rango `r`: su `uFirst` cae dentro de él.
const tramosDe = (est, r) => est
  .filter(d => d.uFirst[0] >= r.first && d.uFirst[0] < r.first + 2 * r.verts)
  .map(d => [d.uFirst[0], d.uEdges[0]])

test('promover un vértice del medio parte SU rango en dos tramos y no cambia el relleno', () => {
  const escena  = montar([cuadrado(48, 0.02)])
  const suyo    = rangos(escena.rings[0].arena)[2]
  const k       = suyo.verts >> 1
  const vertice = suyo.first + 2 * k

  assert.ok(k > 0 && k < suyo.verts - 1, 'el vértice tiene que caer en el MEDIO de su rango')
  const log = equivale(escena, vertice, enMundo(-33.44, -70.65))
  assert.deepEqual(tramosDe(dibujos(log).filter(d => 'uEdges' in d), suyo),
    [[suyo.first, k - 1], [suyo.first + 2 * (k + 1), suyo.verts - k - 1]])
  assert.equal(dibujos(log).filter(d => 'uVivo' in d).length, 1, 'las dos aristas vivas van en UN draw')
})

test('con el vértice en el ARRANQUE de un chunk, la arista que sale es la que cerraba el rango anterior', () => {
  const escena = montar([cuadrado(48, 0.02)])
  const chunks = rangos(escena.rings[0].arena)
  const previo = chunks[chunks.length - 2]
  const primer = chunks[chunks.length - 1].first             // primer vértice de un chunk, con prev lejos

  const log = equivale(escena, primer, enMundo(-33.44, -70.65))
  const est = dibujos(log).filter(d => 'uEdges' in d)

  assert.equal(est.find(d => d.uFirst[0] === previo.first).uEdges[0], previo.verts - 1,
    'el rango anterior pierde su arista de costura')
  assert.ok(est.some(d => d.uFirst[0] === primer + 2), 'y el del vértice arranca en el que le sigue')
})

test('con el vértice al FINAL de un chunk, su rango pierde las DOS y el siguiente queda entero', () => {
  const escena = montar([cuadrado(48, 0.02)])
  const chunks = rangos(escena.rings[0].arena)
  const ultimo = chunks[0].first + 2 * (chunks[0].verts - 1)  // último vértice de un chunk

  const log = equivale(escena, ultimo, enMundo(-33.44, -70.65))
  const est = dibujos(log).filter(d => 'uEdges' in d)

  // Las dos aristas arrancan en este chunk —la de `prev` y la de costura—, así que el corte se lleva
  // la cola del rango en vez de partirlo.
  assert.deepEqual(tramosDe(est, chunks[0]), [[chunks[0].first, chunks[0].verts - 2]])
  assert.deepEqual(tramosDe(est, chunks[1]), [[chunks[1].first, chunks[1].verts]],
    'el rango siguiente no pierde nada: ninguna de las dos aristas arranca ahí')
})

test('en un anillo cerrado, promover el PRIMER vértice parte el pase en los rangos correctos', () => {
  const escena  = montar([cuadrado(48, 0.02)])
  const chunks  = rangos(escena.rings[0].arena)
  const primero = escena.rings[0].path.firstVertex
  const ultimo  = escena.rings[0].path.lastVertex

  assert.notEqual(escena.rings[0].path.chunkOf(ultimo), escena.rings[0].path.chunkOf(primero),
    'su prev tiene que vivir en el chunk más lejano')

  const log = equivale(escena, primero, enMundo(-33.44, -70.65))
  const est = dibujos(log).filter(d => 'uEdges' in d)
  const fin = chunks[chunks.length - 1]

  assert.equal(est.find(d => d.uFirst[0] === fin.first).uEdges[0], fin.verts - 1,
    'el último rango pierde la arista que cerraba el anillo')
  assert.equal(est.find(d => d.uFirst[0] === chunks[0].first + 2).uEdges[0], chunks[0].verts - 1,
    'y el primero arranca en el segundo vértice')
  assert.ok(!est.some(d => d.uFirst[0] === chunks[0].first), 'el primer vértice ya no abre ningún tramo')
})

test('un trazo abierto se rellena como su clausura, y promover un extremo saca la arista del cierre', () => {
  const escena = montar([cuadrado(24, 0.02)], { closed: false })
  const path   = escena.rings[0].path

  assert.equal(path.prevVertex(path.firstVertex), -1, 'un trazo abierto no tiene arista antes del primero')
  assert.deepEqual(conjunto(aristasEmitidas(dibujar(escena), escena.rings)), conjunto(aristasDelTrazo(path)),
    'el cierre lo pone el relleno, no el trazo')

  const fin      = rangos(escena.rings[0].arena).at(-1)
  const primeros = dibujos(equivale(escena, path.firstVertex, enMundo(-33.44, -70.65)))
  assert.deepEqual(tramosDe(primeros.filter(d => 'uEdges' in d), fin), [[fin.first, fin.verts - 1]],
    'promovido el PRIMERO, la arista del cierre sale del último rango, que es donde vive su `prev`')

  const ultimos = dibujos(equivale(escena, path.lastVertex, enMundo(-33.44, -70.65)))
  assert.deepEqual(tramosDe(ultimos.filter(d => 'uEdges' in d), fin), [[fin.first, fin.verts - 2]],
    'y promovido el ÚLTIMO, la del cierre es su propia arista: el rango pierde las dos de la cola')
})

test('el relleno con un vértice promovido es el del anillo con ese vértice movido', () => {
  const escena  = montar([cuadrado(24, 0.02)])
  const vertice = refs(escena.rings[0].path)[6]
  const vivo    = enMundo(-33.415, -70.63)                    // bien afuera de la caja congelada
  const log     = dibujar(escena, { ring: 0, vertex: vertice, ...vivo })

  comparar(triangulos(log, escena.rings, vivo), [contorno(escena.rings[0], vivo, vertice)],
    'anillo con el vértice promovido')
})

/* ── 3. El arrastre no escribe ── */

test('el arrastre no produce NI UNA escritura de textura ni de buffer', () => {
  const escena  = montar([cuadrado(48, 0.02)])
  const vertice = refs(escena.rings[0].path)[20]
  limpiar(escena.gl.spy)

  const emitidos = Array.from({ length: 40 }, (_, i) => dibujar(escena, {
    ring: 0, vertex: vertice, ...enMundo(-33.44 + i * 0.0005, -70.65 - i * 0.0004),
  }).filter(({ op }) => op === 'drawArrays').length)

  assert.deepEqual({
    textura : escena.gl.spy.texImages.length + escena.gl.spy.texSubImages.length,
    buffer  : escena.gl.spy.bufferDatas.length + escena.gl.spy.bufferSubDatas.length,
  }, { textura: 0, buffer: 0 })
  assert.ok(emitidos.every(n => n > 3), 'y sin embargo cada cuadro dibujó el contorno entero')
})

/* ── 4. Multi-anillo: el XOR abre el agujero ── */

test('un anillo con agujero rellena la corona y no el agujero', () => {
  const escena = montar([cuadrado(48, 0.02), HUECO])
  const log    = dibujar(escena)
  const cs     = escena.rings.map(anillo => contorno(anillo))

  assert.notEqual(escena.rings[0].arena.anchor.x, escena.rings[1].arena.anchor.x,
    'cada anillo trae su propia ancla: es lo que el XOR tiene que tolerar')
  comparar(triangulos(log, escena.rings), cs, 'corona')

  // Dentro del agujero pero lejos de su centro: ahí vive el ancla, que es la esquina compartida de
  // todos sus triángulos y el único punto donde la pertenencia estricta no decide.
  const hueco  = caja([cs[1]])
  const adentro = { x: hueco.minX + (hueco.maxX - hueco.minX) * 0.41, y: hueco.minY + (hueco.maxY - hueco.minY) * 0.37 }
  assert.equal(paridad(triangulos(log, escena.rings), adentro), 0, 'el agujero queda afuera')
})

/* ── 5. La limpieza del stencil ── */

test('la cobertura pinta con NOTEQUAL y devuelve el bit a cero, sin un solo `clear`', () => {
  const escena = montar([cuadrado(48, 0.02)])
  const log    = dibujar(escena)
  const cierre = log.slice(log.findIndex(({ op }) => op === 'uColor'))

  assert.ok(!log.some(({ op }) => op === 'clear'), 'un `clear` no respeta el scissor de nadie')
  assert.deepEqual(log.filter(({ op }) => op === 'stencilOp').map(({ args }) => args), [
    ['KEEP', 'KEEP', 'INVERT'],
    ['KEEP', 'KEEP', 'ZERO'],
  ])
  assert.deepEqual(log.filter(({ op }) => op === 'stencilFunc').map(({ args }) => args[0]),
    ['ALWAYS', 'NOTEQUAL'])
  assert.deepEqual(cierre.filter(({ op }) => op === 'drawArrays').map(({ args }) => args[1]), [3],
    'la cobertura es un solo triángulo, y va última')
})

// El rel-ancla llevado a píxeles del framebuffer, con la matriz del propio anillo.
const enPantalla = (arena, vista, x, y) => {
  const m = arena.matrixFor(vista.zoom, vista.center, SIZE)
  return { x: ((m[0] * x + m[12]) * 0.5 + 0.5) * SIZE.x, y: ((m[5] * y + m[13]) * 0.5 + 0.5) * SIZE.y }
}

const encierra = ([x, y, ancho, alto], p) => p.x >= x && p.x <= x + ancho && p.y >= y && p.y <= y + alto

const scissorDe = log => log.find(({ op }) => op === 'scissor').args

test('el relleno sale con el stencil y el scissor apagados: el contexto es compartido', () => {
  const escena = montar([cuadrado(24, 0.02)])
  const log    = dibujar(escena, { ring: 0, vertex: refs(escena.rings[0].path)[6], ...enMundo(-33.44, -70.65) })
  const ultimo = capacidad => log.filter(({ args }) => args[0] === capacidad).at(-1)

  assert.equal(ultimo('STENCIL_TEST').op, 'disable', 'el pase de picking quedaría recortado por el stencil')
  assert.equal(ultimo('SCISSOR_TEST').op, 'disable', 'y en silencio, por el scissor del último contorno')
  assert.equal(ultimo('BLEND').op, 'enable', 'la mezcla queda puesta: es la que también necesitan los sprites')
})

test('el scissor encierra el contorno entero: es lo que hace correcta la limpieza por cobertura', () => {
  const escena = montar([circulo(48, 0.02), HUECO])
  const rect   = scissorDe(dibujar(escena))

  escena.rings.forEach(({ path, arena }, i) => {
    const apex = enPantalla(arena, escena.vista, 0, 0)
    assert.ok(encierra(rect, apex), `el ancla del anillo ${i} —la esquina de todos sus triángulos— quedó afuera`)
    refs(path).forEach(ref => assert.ok(
      encierra(rect, enPantalla(arena, escena.vista, arena.relX(ref), arena.relY(ref))),
      `el vértice ${ref} del anillo ${i} quedó fuera del scissor`))
  })
})

test('el scissor encierra el vértice vivo aunque salga de la caja congelada de los chunks', () => {
  const escena = montar([cuadrado(24, 0.02)])
  const vivo   = enMundo(-33.40, -70.61)
  const { arena } = escena.rings[0]

  const quieto  = scissorDe(dibujar(escena))
  const conDrag = scissorDe(dibujar(escena, { ring: 0, vertex: refs(escena.rings[0].path)[6], ...vivo }))
  const p = enPantalla(arena, escena.vista, vivo.x - arena.anchor.x, vivo.y - arena.anchor.y)

  assert.ok(!encierra(quieto, p), 'el punto vivo tiene que caer FUERA del scissor quieto, o el test no prueba nada')
  assert.ok(encierra(conDrag, p), `(${p.x}, ${p.y}) fuera de [${conDrag}]`)
})

test('sin anillos no dibuja, y el contorno fuera de pantalla tampoco', () => {
  const escena = montar([cuadrado(24, 0.02)])
  const lejos  = { zoom: 13, center: { x: 12, y: 34 }, size: SIZE }

  assert.equal(new EditFillLayer({ gl: escena.gl }).draw({ ...escena.vista, drag: null }), false)
  assert.equal(escena.capa.draw({ ...lejos, drag: null }), false)
  assert.ok(!escena.gl.log.some(({ op }) => op === 'drawArrays'), 'y no encendió el scissor para nada')
})

test('la cobertura pinta con el color del estilo, y restilar no le habla a la GPU', () => {
  const escena = montar([cuadrado(24, 0.02)])
  const capa   = new EditFillLayer({ gl: escena.gl, rings: escena.rings, color: '#f59e0b', opacity: 0.2 })
  const color  = log => log.find(({ op }) => op === 'uColor').args

  assert.deepEqual(color(dibujar({ ...escena, capa })), [0xf5 / 255, 0x9e / 255, 0x0b / 255, 0.2])

  escena.gl.log.length = 0
  capa.style({ color: '#2563eb' })
  assert.equal(escena.gl.log.length, 0, 'el color es un uniform del próximo draw: restilar no dibuja ni sube nada')
  assert.deepEqual(color(dibujar({ ...escena, capa })), [0x25 / 255, 0x63 / 255, 0xeb / 255, 0.2],
    'estilo PARCIAL: la opacidad que no vino queda como estaba')
})

/* ── El harness no miente ── */

test('la rejilla toca las tres regiones, y el oráculo reconoce la corona', () => {
  const escena = montar([cuadrado(48, 0.02), HUECO])
  const cs     = escena.rings.map(anillo => contorno(anillo))
  const puntos = rejilla(cs)
  const b      = caja(cs)

  assert.ok(puntos.some(r => dentro(cs, r)), 'ninguna muestra en la corona')
  assert.ok(puntos.some(r => !dentro(cs, r) && pointInPoly(r.y, r.x, cs[0])), 'ninguna muestra en el agujero')
  assert.ok(puntos.some(r => !pointInPoly(r.y, r.x, cs[0])), 'ninguna muestra afuera')
  assert.equal(dentro(cs, { x: (b.minX + b.maxX) / 2 + 1e-5, y: (b.minY + b.maxY) / 2 + 1e-5 }), 0)
})

test('el doble de gl etiqueta los uniforms: sin eso el plan de dibujo no se lee', () => {
  const escena = montar([cuadrado(24, 0.02)])
  const log    = dibujar(escena)

  assert.deepEqual([...new Set(log.map(({ op }) => op))].filter(op => op.startsWith('u')).sort(),
    ['uColor', 'uEdges', 'uFirst', 'uMatrix', 'uTail', 'useProgram'])
  assert.ok(dibujos(log).filter(d => 'uEdges' in d).every(d => 'uMatrix' in d),
    'todo draw de paridad sale con la matriz de SU anillo puesta')
})

/* ── Canario de la duplicación ── */

// Estos tests leen los uniforms que la capa setea; nunca ejecutan GLSL. La derivación de la arista
// vive por duplicado —en el vertex shader y en el oráculo `ARISTAS.uEdges`— y nada las obliga a
// coincidir, así que un cambio en el shader dejaría los 17 tests en verde midiendo otra cosa. Es la
// misma trampa que una demo corriendo sobre una copia verbatim del módulo. Esto no la elimina: la
// vuelve ruidosa. Si tocás la derivación, este test cae y te obliga a mover las dos.
test('la derivación de la arista del shader es la que reimplementa el oráculo', async () => {
  const fuente = await readFile(new URL('../../src/render/EditFillLayer.js', import.meta.url), 'utf8')
  assert.ok(
    fuente.includes('arista + 1 < uEdges ? uFirst + 2 * (arista + 1) : uTail'),
    'el vertex shader cambió su derivación: actualizá también ARISTAS.uEdges en este archivo',
  )
})
