// `auto-fit="once"` en <cristae-point-layer> sobre elementos REALES (Lit + custom elements en jsdom): encuadra una sola
// vez, con la primera fuente que trae puntos. Si el elemento recambia la `source` antes de que eso pase, la espera se
// pasa a la fuente nueva: la vieja —que puede ser compartida con otras vistas— no puede encuadrar la capa a destiempo
// ni queda suscripta. El encuadre se observa en `camera.fitToLayer`, el handle imperativo en que se respalda.
//
// Corre con: node --test test/element/autofit-recambio.test.mjs
import { window } from '../../test-helpers/jsdom-elementos.mjs'
import { instalarNavegador } from '../../test-helpers/navegador-falso.mjs'
import { makeIconSet } from '../../test-helpers/engine-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import '../../src/index.js'
import { createSource } from '../../src/data/index.js'

const ACC     = { idOf: v => v.id, positionOf: v => ({ lat: v.lat, lng: v.lng }) }
const iconSet = makeIconSet()
const esperar = ms => new Promise(r => setTimeout(r, ms))

const PUNTOS = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, lat: i * 1e-4, lng: i * 1e-4 }))
const vacia  = () => createSource(ACC)
const llena  = n => {
  const fuente = vacia()
  fuente.set(PUNTOS(n))
  return fuente
}

const navegador = instalarNavegador(window)
after(() => {
  navegador.desinstalar()
  document.body.replaceChildren()
})

// Un mapa montado con una capa de puntos `auto-fit="once"` sobre `source`. Cuenta los encuadres que la capa le pide a la
// cámara, que no se mueve: el mapa de jsdom no tiene layout.
const armar = async (props, autoFit = 'once') => {
  document.body.replaceChildren()
  const map = document.createElement('cristae-map')
  map.style.cssText = 'display:block;width:800px;height:600px'
  document.body.appendChild(map)
  await esperar(40)
  const encuadres = []
  map.camera.fitToLayer = id => { encuadres.push(id); return map.camera }
  const capa = Object.assign(document.createElement('cristae-point-layer'), { id: 'p', iconSet, autoFit, ...props })
  map.appendChild(capa)
  await esperar(40)
  return { map, capa, encuadres }
}

// Asigna la fuente nueva como lo hace el consumidor y deja correr el ciclo de Lit y el cuadro del Emitter.
const recambiar = async (capa, source) => {
  capa.source = source
  await capa.updateComplete
  await esperar(40)
}

const cargar = async (source, n) => {
  source.set(PUNTOS(n))
  await esperar(40)
}

test('E1: con la fuente vieja vacía, el recambio por una que ya trae puntos encuadra con la nueva y la vieja no encuadra después', async () => {
  const vieja = vacia()
  const { map, capa, encuadres } = await armar({ source: vieja })
  assert.deepEqual(encuadres, [], 'sin puntos no encuadra')

  await recambiar(capa, llena(3))
  assert.deepEqual(encuadres, ['p'], 'la fuente nueva ya tiene datos: encuadra al toque')

  await cargar(vieja, 5)
  assert.deepEqual(encuadres, ['p'], 'la vieja se llena después, compartida con otra vista: ya no mueve esta capa')
  map.remove()
})

test('E1: con la fuente vieja vacía, el recambio por otra vacía espera a la nueva, y sólo a la nueva', async () => {
  const vieja = vacia()
  const nueva = vacia()
  const { map, capa, encuadres } = await armar({ source: vieja })

  await recambiar(capa, nueva)
  assert.deepEqual(encuadres, [], 'las dos vacías: nada que encuadrar')

  await cargar(vieja, 4)
  assert.deepEqual(encuadres, [], 'la vieja trae puntos y la capa ya no la mira')

  await cargar(nueva, 2)
  assert.deepEqual(encuadres, ['p'], 'la nueva trae los primeros puntos: encuadra')

  await cargar(nueva, 6)
  await recambiar(capa, llena(1))
  assert.deepEqual(encuadres, ['p'], 'y una sola vez')
  map.remove()
})

test('E1: dos recambios seguidos antes de la primera carga dejan una sola espera, sobre la última fuente', async () => {
  const [a, b, c] = [vacia(), vacia(), vacia()]
  const { map, capa, encuadres } = await armar({ source: a })

  await recambiar(capa, b)
  await recambiar(capa, c)
  await cargar(a, 3)
  await cargar(b, 3)
  assert.deepEqual(encuadres, [], 'ni la primera ni la segunda cuentan')

  await cargar(c, 3)
  assert.deepEqual(encuadres, ['p'])
  map.remove()
})

test('E1: si ya encuadró, el recambio no vuelve a encuadrar: es una sola vez', async () => {
  const { map, capa, encuadres } = await armar({ source: llena(3) })
  assert.deepEqual(encuadres, ['p'], 'los datos ya estaban: encuadró al montar')

  await recambiar(capa, llena(5))
  await recambiar(capa, vacia())
  assert.deepEqual(encuadres, ['p'])
  map.remove()
})

test('E1: reasignar la misma fuente no cambia nada: la espera sigue en pie y encuadra una vez', async () => {
  const fuente = vacia()
  const { map, capa, encuadres } = await armar({ source: fuente })

  await recambiar(capa, fuente)
  await cargar(fuente, 3)
  assert.deepEqual(encuadres, ['p'])
  map.remove()
})

test('E1: sin auto-fit el recambio no encuadra nunca', async () => {
  const { map, capa, encuadres } = await armar({ source: vacia() }, null)
  const nueva = vacia()
  await recambiar(capa, nueva)
  await cargar(nueva, 3)
  await recambiar(capa, llena(3))
  assert.deepEqual(encuadres, [])
  map.remove()
})

test('E1: quitada del mapa después del recambio, ninguna de las dos fuentes la encuadra', async () => {
  const vieja = vacia()
  const nueva = vacia()
  const { map, capa, encuadres } = await armar({ source: vieja })
  await recambiar(capa, nueva)

  capa.remove()
  await cargar(nueva, 3)
  await cargar(vieja, 3)
  assert.deepEqual(encuadres, [])
  map.remove()
})
