// Lo que se ve es el color al alfa que pidió el estilo. Ese contrato lo firman DOS módulos que nada
// obliga a coincidir: el modelo de alfa que la superficie negocia en `getContext` y los factores de
// mezcla que cada pase le pone a la GPU. Acá se corre la mezcla de GL sobre el plan de dibujo REAL de
// cada pase y después la composición de la página, y el resultado se compara contra el `over` exacto.
//
// El alfa BAJO es el que discrimina: con `opacity: 1` cualquier combinación de factores da lo mismo, y
// es el relleno de una geocerca —0.1— el que desaparece si el alfa se aplica dos veces.

import { makeGl } from '../../test-helpers/engine-stub.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { SURFACE_ATTRS } from '../../src/render/EditSurface.js'
import { EditFillLayer } from '../../src/render/EditFillLayer.js'
import { StrokePass } from '../../src/render/StrokePass.js'
import { RingStore } from '../../src/render/RingStore.js'

const W0   = 256 / 360
const SIZE = { x: 800, y: 600 }

const project = (lat, lng, out) => {
  out[0] = (lng + 180) * W0
  out[1] = (90 - lat) * W0
}

// El Proxy del harness devuelve una función NUEVA por cada constante que no conoce: los factores de
// mezcla se fijan acá porque son justamente lo que se lee del plan.
const CONSTANTES = {
  ONE       : 'ONE',       ZERO   : 'ZERO',   SRC_ALPHA : 'SRC_ALPHA',
  DST_ALPHA : 'DST_ALPHA', BLEND  : 'BLEND',  ONE_MINUS_SRC_ALPHA : 'ONE_MINUS_SRC_ALPHA',
}

const espiar = base => {
  const log = []
  const propio = {
    log,
    getUniformLocation : (_program, nombre) => ({ nombre }),
    uniform4f          : (loc, r, g, b, a) => log.push({ op: loc.nombre, args: [r, g, b, a] }),
    uniform4fv         : (loc, v) => log.push({ op: loc.nombre, args: [...v] }),
    blendFunc          : (sf, df) => log.push({ op: 'blend', args: [sf, df, sf, df] }),
    blendFuncSeparate  : (sf, df, sfA, dfA) => log.push({ op: 'blend', args: [sf, df, sfA, dfA] }),
  }
  return new Proxy(base, { get: (t, p) => propio[p] ?? CONSTANTES[p] ?? t[p] })
}

const cuadrado = (radio, lat = -33.45, lng = -70.66) =>
  [[lat - radio, lng - radio], [lat - radio, lng + radio], [lat + radio, lng + radio], [lat + radio, lng - radio]]

const montar = () => {
  const gl    = espiar(makeGl())
  const arena = new RingStore({ gl, points: cuadrado(0.02), project })
  return { gl, rings: [{ arena }], vista: { zoom: 13, center: arena.anchor, size: SIZE } }
}

/* ── Oráculo: la mezcla de GL y después el compositor de la página ── */

const FACTOR = {
  ONE                 : () => 1,
  ZERO                : () => 0,
  SRC_ALPHA           : src => src[3],
  ONE_MINUS_SRC_ALPHA : src => 1 - src[3],
  DST_ALPHA           : (_src, dst) => dst[3],
}

const factorDe = (nombre, src, dst) => {
  const f = FACTOR[nombre]
  assert.ok(f, `factor de mezcla no modelado en el oráculo: ${nombre}`)
  return f(src, dst)
}

// El destino arranca en (0,0,0,0): el `clear` del repintado deja el canvas transparente.
const LIMPIO = [0, 0, 0, 0]

const mezclar = ([sf, df, sfA, dfA], src, dst = LIMPIO) => [
  ...[0, 1, 2].map(i => src[i] * factorDe(sf, src, dst) + dst[i] * factorDe(df, src, dst)),
  src[3] * factorDe(sfA, src, dst) + dst[3] * factorDe(dfA, src, dst),
]

// Con `premultipliedAlpha: false` el compositor premultiplica antes de mezclar contra la página; con
// `true` toma el rgb tal cual. El alfa del canvas es la cobertura en los dos casos.
const componer = ([r, g, b, a], fondo, { premultipliedAlpha }) =>
  [r, g, b].map((c, i) => (premultipliedAlpha ? c : c * a) + fondo[i] * (1 - a))

const sobre = ([r, g, b, a], fondo) => [r, g, b].map((c, i) => c * a + fondo[i] * (1 - a))

const FONDO = [0.85, 0.87, 0.9]                       // el gris del raster de tiles bajo la capa

// El color que el estilo pidió, tal como sale del pase, y el que termina viendo el usuario.
const enPantalla = (log, uniform) => {
  const pedido = log.find(({ op }) => op === uniform)?.args
  const mezcla = log.find(({ op }) => op === 'blend')?.args
  assert.ok(pedido, `el pase no seteó el uniform ${uniform}`)
  assert.ok(mezcla, 'el pase no declaró sus factores de mezcla')
  return { pedido, visto: componer(mezclar(mezcla, pedido), FONDO, SURFACE_ATTRS) }
}

const cerca = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6)

/* ── El contrato ── */

test('el relleno translúcido llega a pantalla con el alfa que pidió el estilo', () => {
  const escena = montar()
  const capa   = new EditFillLayer({ gl: escena.gl, rings: escena.rings, step: 1, color: '#22c55e', opacity: 0.1 })

  escena.gl.log.length = 0
  assert.equal(capa.draw({ ...escena.vista, drag: null }), true, 'el anillo tiene que quedar en pantalla')

  const { pedido, visto } = enPantalla(escena.gl.log, 'uColor')
  assert.equal(pedido[3], 0.1, 'el estilo pidió un relleno al 10%')
  assert.ok(cerca(visto, sobre(pedido, FONDO)),
    `un relleno al 10% se ve como [${visto}] y el estilo pedía [${sobre(pedido, FONDO)}]`)
})

test('el trazo translúcido, con el mismo criterio', () => {
  const escena = montar()
  const pase   = new StrokePass({ gl: escena.gl, color: '#ef4444', width: 3, opacity: 0.35 })

  escena.gl.log.length = 0
  assert.equal(pase.draw(escena.rings, escena.vista), true)

  const { pedido, visto } = enPantalla(escena.gl.log, 'color')
  assert.ok(cerca(visto, sobre(pedido, FONDO)),
    `un trazo al 35% se ve como [${visto}] y el estilo pedía [${sobre(pedido, FONDO)}]`)
})

// Mismo contrato que el relleno: el estilo llega por partes —el color de una selección, el ancho de un
// resaltado— y lo que no vino queda como estaba. Con el default en 1, restilar sólo el color devolvía
// el trazo a opaco sin que nadie lo pidiera.
test('restilar sin opacidad conserva la que había', () => {
  const escena = montar()
  const pase   = new StrokePass({ gl: escena.gl, color: '#ef4444', width: 3, opacity: 0.35 })

  pase.style({ color: '#2563eb' })
  escena.gl.log.length = 0
  pase.draw(escena.rings, escena.vista)

  assert.equal(enPantalla(escena.gl.log, 'color').pedido[3], 0.35)
})

test('con el alfa opaco los factores no discriminan: es el translúcido el que prueba algo', () => {
  const escena = montar()
  const capa   = new EditFillLayer({ gl: escena.gl, rings: escena.rings, step: 1, color: '#22c55e', opacity: 1 })

  escena.gl.log.length = 0
  capa.draw({ ...escena.vista, drag: null })

  const { pedido, visto } = enPantalla(escena.gl.log, 'uColor')
  assert.ok(cerca(visto, pedido.slice(0, 3)), 'opaco tapa el fondo, mida como mida el oráculo')
})

/* ── El harness no miente ── */

test('la combinación que aplica el alfa dos veces NO pasa el oráculo', () => {
  const pedido = [0.13, 0.77, 0.37, 0.1]
  const doble  = componer(mezclar(['SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA', 'SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA'], pedido),
    FONDO, { premultipliedAlpha: false })

  assert.ok(!cerca(doble, sobre(pedido, FONDO)), 'el oráculo no distingue el defecto que vino a fijar')
  assert.ok(Math.abs(doble[1] - FONDO[1]) < 0.02, 'y el defecto es que el color se pierde contra el fondo')
})

// Los cuatro pases dibujan sobre la MISMA superficie, así que la convención de mezcla es una sola. Los
// tests de arriba corren dos; este ata los otros dos a la misma llamada en vez de duplicar el montaje.
test('todos los pases de la superficie declaran la misma mezcla', async () => {
  const pases = ['EditFillLayer', 'StrokePass', 'EditStrokeLayer', 'EditHandleLayer']
  const leer  = pase => readFile(new URL(`../../src/render/${pase}.js`, import.meta.url), 'utf8')

  for (const [i, fuente] of (await Promise.all(pases.map(leer))).entries()) {
    assert.ok(fuente.includes('blendOver(gl)'), `${pases[i]} arma su mezcla a mano en vez de la convención`)
    assert.ok(!fuente.includes('gl.blendFunc('), `${pases[i]} todavía llama a blendFunc directo`)
  }
})
