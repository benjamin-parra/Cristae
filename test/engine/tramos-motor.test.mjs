// El motor con contexto compartido por tramo (PLAN-C-MINIMO §7, D1–D5): las capas GL de Cristae contiguas comparten un
// contexto, y la visibilidad, la opacidad y el z de cada una se resuelven al componer su tramo. Corre sobre el modelo de
// 13 capas del Mapa Geotáctico (test-helpers/modelo-capas.mjs), con el navegador falso que cuenta los contextos.
//
// El tramo de una capa se lee de su superficie (`layer.surface.tramo`): es un camino de test, no API pública. Cada
// contexto lleva un registro de lo que pasa en el framebuffer por defecto —la composición: un `clear` y un triángulo por
// miembro— y de lo que los miembros dibujan en sus FBO.
//
// El harness va PRIMERO: window, customElements y lo que Lit toca al evaluar.
import { ACC, armar, armarVacio, asentar, esperar, fuente, iconSet, items } from '../../test-helpers/modelo-capas.mjs'
import { makeEditGl } from '../../test-helpers/engine-stub.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

after(() => document.body.replaceChildren())

const DIBUJOS = new Set(['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'])
const CLAVES  = ['layerId', 'kind', 'pane', 'z', 'cssZoom', 'state', 'hasContent', 'visible']

// `composiciones`: `clear` del framebuffer por defecto; `capas`: triángulos de la última composición; `miembros`:
// dibujos con un FBO enlazado.
const conRegistro = () => {
  const base     = makeEditGl()
  const registro = { miembros: 0, composiciones: 0, capas: 0 }
  let fbo = null
  const propios = {
    registro,
    bindFramebuffer: (target, f) => {
      fbo = f
      return base.bindFramebuffer(target, f)
    },
    clear: mask => {
      if (!fbo) {
        registro.composiciones++
        registro.capas = 0
      }
      return base.clear(mask)
    },
  }
  const dibujo = nombre => (...args) => {
    fbo ? registro.miembros++ : registro.capas++
    return base[nombre](...args)
  }
  DIBUJOS.forEach(nombre => propios[nombre] = dibujo(nombre))
  return new Proxy(base, { get: (t, p) => (p in propios ? propios[p] : t[p]) })
}

const tramoDe    = (engine, id) => engine.getLayer(id)?.layer?.surface?.tramo ?? null
const tramos     = engine => new Set(engine.surfaces().map(s => tramoDe(engine, s.layerId)).filter(Boolean))
const miembrosDe = (engine, tramo) => engine.surfaces().map(s => s.layerId).filter(id => tramoDe(engine, id) === tramo)
const dibujos    = navegador => navegador.contextos.reduce((n, c) => n + (c.gl.registro?.miembros ?? 0), 0)
const compuestas = navegador => navegador.contextos.reduce((n, c) => n + (c.gl.registro?.composiciones ?? 0), 0)
const quieto     = () => esperar(60)                 // los rAF de las Sources y los ociosos del montaje ya corrieron

// Una capa de puntos del modelo con contenido, visible y en un tramo con otros miembros. Las de puntos no se redibujan
// al volver a mostrarse si nada cambió mientras estaban ocultas.
const compartida = engine => ['lugares', 'busqueda', 'marcas', 'extremos', 'veh']
  .find(id => (f => f?.hasContent && f.visible)(engine.surfaces().find(s => s.layerId === id))
    && miembrosDe(engine, tramoDe(engine, id)).length > 1)

test('D1 modelo de 13 en reposo: un contexto vivo por tramo, y no más de 5', async t => {
  const { map, navegador } = await armar(13, 'react', { crearGl: conRegistro })
  t.after(() => map.remove())
  await quieto()
  const vivos = tramos(map.engine)
  t.diagnostic(`contextos vivos ${navegador.vivos}, tramos ${vivos.size}: ${navegador.resumen()}`)
  assert.equal(navegador.vivos, vivos.size, 'cada contexto vivo es el de un tramo')
  assert.ok(navegador.vivos <= 5, `vivos en reposo: ${navegador.resumen()}`)
  vivos.forEach(tramo => assert.ok(navegador.contextos.some(c => c.gl === tramo.gl && c.estado === 'vivo')))
  assert.equal(navegador.stat().desalojados, 0)
  assert.deepEqual(navegador.violaciones, [])
})

test('D2 ocultar y mostrar una capa de un tramo compartido: la composición la saca y la pone, sin dibujar miembros', async t => {
  const { map, navegador } = await armar(13, 'react', { crearGl: conRegistro })
  t.after(() => map.remove())
  const engine = map.engine
  await quieto()
  const id = compartida(engine)
  assert.ok(id, 'el modelo tiene una capa de puntos con contenido en un tramo compartido')
  const { registro } = tramoDe(engine, id).gl
  const capas        = registro.capas
  const veces        = registro.composiciones
  const miembros     = dibujos(navegador)

  engine.setLayerVisibility(id, false)
  await esperar(0)
  assert.equal(registro.composiciones, veces + 1, 'ocultar compone una vez')
  assert.equal(registro.capas, capas - 1, 'la composición ya no la lleva')

  engine.setLayerVisibility(id, true)
  await esperar(0)
  assert.equal(registro.composiciones, veces + 2, 'mostrar compone una vez')
  assert.equal(registro.capas, capas, 'la composición la vuelve a llevar')
  assert.equal(dibujos(navegador), miembros, 'ningún miembro se redibujó')
})

test('D3 focus atenúa por composición, y repetir el mismo foco no compone', async t => {
  const { map, navegador } = await armar(13, 'react', { crearGl: conRegistro })
  t.after(() => map.remove())
  const engine = map.engine
  await quieto()
  const id   = compartida(engine)
  const alfa = new Map()
  engine.surfaces().forEach(({ layerId }) => {
    const slot = engine.getLayer(layerId).layer?.surface
    if (!slot?.tramo) return
    const original = slot.setOpacity
    slot.setOpacity = a => {
      alfa.set(layerId, a)
      return original.call(slot, a)
    }
  })
  const miembros = dibujos(navegador)
  const veces    = compuestas(navegador)

  engine.focus([id])
  await esperar(0)
  assert.equal(alfa.get(id), 1, 'la enfocada queda plena')
  assert.ok([...alfa].every(([lid, a]) => lid === id || a === 0.3), 'el resto se atenúa en su superficie')
  assert.ok(compuestas(navegador) > veces, 'el atenuado sale de componer')
  assert.equal(dibujos(navegador), miembros, 'atenuar no redibuja miembros')

  const ya = compuestas(navegador)
  engine.focus([id])
  await esperar(0)
  assert.equal(compuestas(navegador), ya, 'el mismo foco no compone')
  assert.equal(dibujos(navegador), miembros)
})

test('D4 setLayerZ que saca una capa del rango de su tramo replanifica: queda en otro', async t => {
  const { map, navegador } = await armarVacio()
  t.after(() => map.remove())
  const engine = map.engine
  engine.addPointLayer({ id: 'a', accessors: ACC, iconSet, data: items(2), z: 400 })
  engine.addPointLayer({ id: 'b', accessors: ACC, iconSet, data: items(2), z: 410 })
  engine.addLabelLayer({ id: 'separa', z: 420 })                // no dibuja en un tramo: su pane separa
  engine.addPointLayer({ id: 'c', accessors: ACC, iconSet, data: items(2), z: 430 })
  await asentar(engine)
  assert.equal(tramoDe(engine, 'a'), tramoDe(engine, 'b'), 'a y b son contiguas')
  assert.notEqual(tramoDe(engine, 'b'), tramoDe(engine, 'c'), 'la etiqueta los separa')

  engine.setLayerZ('b', 440)
  assert.notEqual(tramoDe(engine, 'b'), tramoDe(engine, 'a'), 'b salió del tramo de a')
  assert.ok(tramoDe(engine, 'b'), 'y quedó en otro')
  await asentar(engine)
  await quieto()
  assert.equal(navegador.vivos, tramos(engine).size)
  assert.deepEqual(navegador.violaciones, [])
})

test('D5 surfaces() conserva la forma de sus filas; perder un tramo avisa un surfacechange por miembro', async t => {
  const { map, navegador } = await armar(13, 'react')
  t.after(() => map.remove())
  const engine = map.engine
  await quieto()
  engine.surfaces().forEach(fila => assert.deepEqual(Object.keys(fila), CLAVES))

  const tramo    = [...tramos(engine)].find(tr => miembrosDe(engine, tr).length > 1)
  const miembros = miembrosDe(engine, tramo).sort()
  const avisos   = []
  engine.on('surfacechange', fila => avisos.push(fila))
  navegador.desalojar(navegador.contextos.find(c => c.gl === tramo.gl))
  navegador.vaciar()                                    // el webglcontextlost, que llega en otra tarea

  const perdidas = avisos.filter(a => a.state === 'lost')
  assert.deepEqual(perdidas.map(a => a.layerId).sort(), miembros, 'una fila por miembro del tramo')
  perdidas.forEach(fila => assert.deepEqual(Object.keys(fila), CLAVES))
})

test('D6 attachSource conserva la opacidad y la visibilidad de la capa en la composición de su tramo', async t => {
  const { map } = await armarVacio()
  t.after(() => map.remove())
  const engine = map.engine
  engine.addPointLayer({ id: 'a', source: fuente(2), iconSet, z: 400 })
  engine.addPointLayer({ id: 'b', source: fuente(2), iconSet, z: 410 })
  await asentar(engine)
  assert.equal(tramoDe(engine, 'a'), tramoDe(engine, 'b'), 'a y b comparten tramo')
  engine.setLayerOpacity('b', 0.4)
  engine.setLayerVisibility('a', false)

  engine.attachSource('a', fuente(3))
  engine.attachSource('b', fuente(3))
  const slot = id => engine.getLayer(id).layer.surface
  assert.equal(slot('a').visible, false, 'la oculta sigue oculta')
  assert.equal(slot('b').opacity, 0.4, 'la atenuada sigue atenuada')
  assert.equal(tramoDe(engine, 'a'), tramoDe(engine, 'b'), 'y en el mismo tramo')
})

test('D7 un pane ajeno que aparece o se mueve entre dos miembros después del plan los separa, sin otra alta', async t => {
  const { map } = await armarVacio()
  t.after(() => map.remove())
  const engine  = map.engine
  const leaflet = engine.getLeafletMap()
  engine.addPointLayer({ id: 'a', source: fuente(2), iconSet, z: 400 })
  engine.addPointLayer({ id: 'c', source: fuente(2), iconSet, z: 420 })
  await asentar(engine)
  assert.equal(tramoDe(engine, 'a'), tramoDe(engine, 'c'), 'contiguas: un tramo')

  const ajeno = leaflet.createPane('ajeno-medio')
  ajeno.style.zIndex = '410'
  ajeno.appendChild(document.createElement('div'))      // un popup, un tooltip: algo que se pinta entre las dos
  await esperar(0)
  assert.notEqual(tramoDe(engine, 'a'), tramoDe(engine, 'c'), 'el pane nuevo con hijos las separa')

  const abajo = leaflet.createPane('ajeno-abajo')
  abajo.style.zIndex = '300'
  abajo.appendChild(document.createElement('div'))
  ajeno.style.zIndex = '200'                             // el que separaba se va por debajo de las dos
  await esperar(0)
  assert.ok(tramoDe(engine, 'a') && tramoDe(engine, 'c'), 'ninguna queda sin tramo')
  abajo.style.zIndex = '415'                             // y otro sube entre ellas
  await esperar(0)
  assert.notEqual(tramoDe(engine, 'a'), tramoDe(engine, 'c'), 'cambiar la z de un pane ajeno replanifica')
})
