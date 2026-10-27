// Los escenarios de `npm run test:navegador`. Cada uno recibe la interfaz de ejecutar.mjs:
//   c.ev(código)              corre una expresión en la página (async) y devuelve su valor JSON
//   c.sondear(...)            captura la pantalla y lee el píxel de cada sonda (el color que pinta cada capa)
//   c.comprobar(nombre, ok, evidencia)   anota un resultado; nunca lanza
// El criterio de cada uno es el de DISENO.md §3 (criterios 1 a 6 y 9) y el enunciado de la etapa 5; los umbrales salen de ahí y no de lo medido.

const SATURACION = /el techo de contextos WebGL está lleno/

const necesaria = f => f.visible && f.hasContent
const vivas = filas => new Set(filas.filter(f => f.state === 'live').map(f => f.layerId))
const ids = lista => lista.map(f => f.layerId ?? f.capa ?? f)

// Recorre los avisos `surfacechange` en orden y arma lo que el navegador y la política hicieron: quién cayó (y si quedaba alguna
// prescindible viva en ese momento) y quién volvió (y cuánto tardó).
const analizar = (eventos, filasIni) => {
  const est = new Map(filasIni.map(f => [f.layerId, { estado: f.state, necesaria: necesaria(f), z: f.z }]))
  const ultimaCaida = new Map(filasIni.filter(f => necesaria(f) && (f.state === 'lost' || f.state === 'released')).map(f => [f.layerId, { t: 0 }])), caidas = [], vueltas = []
  for (const e of eventos) {
    if (e.k !== 'estado') continue
    const previo = est.get(e.capa) ?? { estado: 'none' }
    if (previo.estado === 'live' && (e.estado === 'lost' || e.estado === 'released')) {
      const c = { capa: e.capa, estado: e.estado, necesaria: e.necesaria, z: e.z, t: e.t, f: e.f,
        prescindiblesVivos: [...est].filter(([id, s]) => id !== e.capa && s.estado === 'live' && !s.necesaria).map(([id]) => id) }
      caidas.push(c)
      ultimaCaida.set(e.capa, c)
    }
    if (e.estado === 'live' && (previo.estado === 'lost' || previo.estado === 'released') && ultimaCaida.has(e.capa)) vueltas.push({ capa: e.capa, z: e.z, t: e.t, f: e.f, tCaida: ultimaCaida.get(e.capa).t })
    est.set(e.capa, { estado: e.estado, necesaria: e.necesaria, z: e.z })
  }
  return { caidas, vueltas, estados: est }
}

// «Cada vuelta en su cuadro, en orden de z, antes de k cuadros + 1 s»: la recuperación toma una superficie por cuadro, la de mayor z
// primero, y la última no tarda más de lo que cuestan k cuadros más un segundo.
// `desde`: la hora de la señal que las pone en marcha (cerrar un widget), si no es la caída de cada una.
const revisarVueltas = (c, vueltas, cadencia, etiqueta, desde = null) => {
  if (!vueltas.length) return c.comprobar(`${etiqueta}: hubo capas que volver a tomar`, false, 'ninguna cayó, el escenario no ejercita la recuperación')
  const orden = [...vueltas].sort((a, b) => a.t - b.t)
  const juntas = orden.every((v, i) => i === 0 || v.t - orden[i - 1].t > cadencia * 0.5)
  const zOk = orden.every((v, i) => orden.slice(i + 1).every(w => (desde === null && w.tCaida > v.t) || v.z >= w.z))
  const k = orden.length, plazo = k * cadencia + 1000, peor = Math.max(...orden.map(v => v.t - (desde ?? v.tCaida)))
  c.nota(`${etiqueta}:vueltas`, orden.map(v => ({ capa: v.capa, z: v.z, ms: Math.round(v.t - (desde ?? v.tCaida)) })))
  c.comprobar(`${etiqueta}: una superficie por cuadro`, juntas, `${k} vueltas, cuadro de ${cadencia.toFixed(1)} ms`)
  c.comprobar(`${etiqueta}: de mayor a menor z cuando esperan juntas`, zOk, orden.map(v => `${v.capa}:${v.z}`).join(' '))
  c.comprobar(`${etiqueta}: la última vuelve antes de k cuadros + 1 s`, peor <= plazo, `peor ${Math.round(peor)} ms, plazo ${Math.round(plazo)} ms (k=${k})`)
}

// Sin bucle: ni un contexto nuevo durante `ms` después de que todo asentó. Con una capa sin superficie por saturación la política
// reintenta a los 5 s y a los 30 s (gl-budget.js, RETRIES), así que ahí se permite un contexto en una ventana de 8 s.
const sinBucle = async (c, etiqueta, { ms = 3000, permitidos = 0 } = {}) => {
  const n = await c.ev('__nav.nEventos()')
  await c.dormir(ms)
  const evs = await c.ev(`__nav.eventos(${n})`)
  const nuevos = evs.filter(e => e.k === 'ctx').length
  c.nota(`${etiqueta}:ventana`, { ms, getContext: nuevos, cambiosDeEstado: evs.filter(e => e.k === 'estado').map(e => `${e.capa}:${e.estado}`) })
  c.comprobar(`${etiqueta}: ${permitidos ? `a lo sumo ${permitidos} getContext (el reintento por saturación)` : 'sin contextos nuevos'} en ${ms / 1000} s`, nuevos <= permitidos, `${nuevos} getContext`)
  return nuevos
}

// El estado final: cada capa necesaria o está viva y pintada, o está soltada con la señal de saturación; ninguna queda `lost`.
const revisarFinal = async (c, etiqueta, { todasVivas = false, sondas = null } = {}) => {
  const est = await c.ev('__nav.estado()')
  const nec = est.filas.filter(necesaria), vivasIds = vivas(nec)
  const perdidas = nec.filter(f => f.state === 'lost'), soltadas = nec.filter(f => f.state === 'released' || f.state === 'none')
  c.nota(`${etiqueta}:filas`, est.filas.map(f => `${f.layerId}:${f.state}${necesaria(f) ? '' : '(vacía)'}`))
  c.comprobar(`${etiqueta}: ninguna capa necesaria queda perdida sin recuperarse`, perdidas.length === 0, ids(perdidas))
  if (todasVivas) c.comprobar(`${etiqueta}: las ${nec.length} capas necesarias están vivas`, soltadas.length === 0, ids(soltadas))
  else c.comprobar(`${etiqueta}: lo que quedó sin superficie lleva la señal de saturación`, !soltadas.length || est.avisos.some(a => SATURACION.test(a)), { sinSuperficie: ids(soltadas), avisos: est.avisos.length })
  const s = sondas ?? await c.ev('__nav.sondas()')
  const img = await c.sondear(etiqueta, s, vivasIds)
  c.comprobar(`${etiqueta}: cada capa viva pinta su color en su píxel`, img.malas.length === 0, img.malas.length ? img.malas : `${img.pintadas.length} píxeles leídos (${img.archivo})`)
  c.comprobar(`${etiqueta}: sin errores de la página`, est.errores.length === 0, est.errores)
  return { est, img }
}

const ajenosB = n => ({
  id: `b-${n}`, titulo: `${n} contextos ajenos creados después del montaje, que dibujan y vacían la cola (como Street View)`,
  motores: n === 12 ? ['chromium', 'shell', 'firefox'] : ['chromium', 'shell'],
  async correr(c) {
    const m = await c.ev('__nav.montar()')
    const cad = await c.ev('__nav.cadencia()')
    c.nota('montaje', { propios: m.propios, renderer: m.renderer })
    const inicial = await revisarFinal(c, 'antes', { todasVivas: true })
    const desde = await c.ev('__nav.nEventos()')
    await c.ev(`__nav.ajenos(${n}, { entre: ${c.motor === 'firefox' ? 400 : 80} })`)
    await c.ev('__nav.quieto(1500, 20000)')
    const evs = await c.ev(`__nav.eventos(${desde})`)
    const a = analizar(evs, inicial.est.filas)
    const peores = a.caidas.filter(x => x.necesaria && x.prescindiblesVivos.length)
    c.nota('caidas', a.caidas.map(x => `${x.capa}:${x.estado}${x.necesaria ? '' : '(prescindible)'} z=${x.z}`))
    const fin = await c.ev('__nav.estado()')
    c.nota('contextos', { propios: fin.propios, ajenos: fin.ajenos })
    if (c.motor === 'firefox') {
      c.comprobar(`Firefox no tiene techo bajo: nada cae con ${n} ajenos`, a.caidas.length === 0 && fin.propios.perdidos === 0 && fin.ajenos.perdidos === 0, { caidas: a.caidas.length, propiosPerdidos: fin.propios.perdidos, ajenosPerdidos: fin.ajenos.perdidos })
    } else {
      c.comprobar('ninguna capa visible con contenido cae mientras quede una prescindible', peores.length === 0, peores.map(x => `${x.capa} cayó con ${x.prescindiblesVivos.join(',')} vivas`))
      a.vueltas.length && revisarVueltas(c, a.vueltas, cad, 'las que caen')
      const primera = a.caidas.findIndex(x => x.necesaria)
      c.comprobar('las prescindibles caen antes que las necesarias', primera < 0 || a.caidas.slice(0, primera).every(x => !x.necesaria), a.caidas.map(x => `${x.capa}${x.necesaria ? '*' : ''}`).join(' '))
    }
    await revisarFinal(c, 'despues', { todasVivas: c.motor === 'firefox' || n <= 7 })
    if (c.motor !== 'firefox') {
      await sinBucle(c, 'asentado', n <= 7 ? {} : { ms: 8000, permitidos: 1 })
      n <= 7 || await revisarFinal(c, 'tras el reintento', {})      // el reintento de los 5 s puede devolverle su superficie a la que quedó sin ella
    }
  },
})

const MEDICIONES = [
  {
    id: 'g', titulo: 'medición: costo de vaciar la cola (flush) de los contextos propios, lo que paga la política por evento', motores: ['chromium', 'shell', 'firefox'],
    async correr(c) {
      await c.ev('__nav.montar()')
      const m = await c.ev('__nav.flushCosto()')
      const pasada = m.usPorFlush * 9 / 1000, cuadro = c.motor === 'firefox' ? 16.7 : 16.7
      c.nota('flush vacío', { ...m, pasadaDeNueveMs: +pasada.toFixed(3) })
      c.comprobar('una pasada de flush sobre las nueve capas con contenido cuesta menos que un cuadro', pasada < cuadro, `${m.usPorFlush.toFixed(1)} µs por flush (mín ${m.min.toFixed(1)}, máx ${m.max.toFixed(1)}), ${m.contextos} contextos: la pasada de nueve ${pasada.toFixed(3)} ms`)
    },
  },
  {
    id: 'h', titulo: 'medición: ¿la composición de un canvas visible renueva el orden de desalojo? (headless; ORACULO §7)', motores: ['chromium', 'shell'],
    async correr(c) {
      await c.ev('__nav.compo.crear(16)')
      // el contexto 0 es el más viejo; se redibuja en cada cuadro sin vaciar la cola y se captura la pantalla, que fuerza la composición
      for (let i = 0; i < 12; i++) { await c.ev(`__nav.compo.pintar(0, ${(i % 10) / 10})`); await c.dormir(30) }
      await c.captura('compuesto')
      await c.ev('__nav.compo.crear(1)')
      await c.dormir(300)
      const sinFlush = await c.ev('__nav.compo.perdidos()')
      c.nota('17.º contexto', { cae: sinFlush })
      c.comprobar('medición: el 17.º contexto desaloja a uno solo', sinFlush.length === 1, { cae: sinFlush, conclusion: sinFlush[0] === 0 ? 'cae el #0, el único que dibujaba y se componía sin flush: la composición headless NO renueva el orden' : 'no cae el #0: la composición SÍ renueva el orden' })
      // control: el vaciado explícito sí renueva, así que ahora cae el siguiente más viejo
      const vivos = Array.from({ length: 17 }, (_, i) => i).filter(i => !sinFlush.includes(i)), k = vivos[0], siguiente = vivos[1]
      await c.ev(`__nav.compo.vaciar(${k})`)
      await c.ev('__nav.compo.crear(1)')
      await c.dormir(300)
      const conFlush = await c.ev('__nav.compo.perdidos()'), nuevos = conFlush.filter(i => !sinFlush.includes(i))
      c.nota('18.º contexto tras un flush explícito en el más viejo', { vaciado: k, cae: nuevos })
      c.comprobar('control: tras un flush explícito en el más viejo, cae el siguiente (el flush renueva el orden)', nuevos.length === 1 && nuevos[0] === siguiente, { vaciado: k, esperado: siguiente, cae: nuevos })
    },
  },
]

export const ESCENARIOS = [
  {
    id: 'a', titulo: 'montaje: creados == vivos tras el ocioso, sin errores', motores: ['chromium', 'shell', 'firefox'],
    async correr(c) {
      const m = await c.ev('__nav.montar()')
      c.nota('montaje', { montajeMs: m.montajeMs, alMontar: m.alMontar.propios, final: m.propios, renderer: m.renderer })
      c.comprobar('creados == vivos al asentar el montaje', m.propios.creados === m.propios.vivos && m.propios.perdidos === 0, m.propios)
      c.comprobar('ningún contexto ajeno ni espurio', m.ajenos.creados === 0, m.ajenos)
      c.comprobar('13 superficies GL, todas con su contexto', m.filas.length === 13 && m.filas.every(f => f.state === 'live'), m.filas.map(f => `${f.layerId}:${f.state}`))
      c.comprobar('nueve con contenido y cuatro vacías', m.filas.filter(necesaria).length === 9, { conContenido: ids(m.filas.filter(necesaria)), vacias: ids(m.filas.filter(f => !necesaria(f))) })
      const evs = await c.ev('__nav.eventos()')
      const vacias = new Set(m.filas.filter(f => !necesaria(f)).map(f => f.layerId))
      const diferidas = evs.filter(e => e.k === 'estado' && e.estado === 'live' && vacias.has(e.capa))
      const ctxAntes = diferidas.length ? evs.filter(e => e.k === 'ctx' && e.t <= diferidas[0].t).length - 1 : null
      c.nota('al terminar el montaje síncrono', m.alMontar.propios)
      c.comprobar('las cuatro vacías toman su contexto después de las nueve con contenido, en ratos ociosos distintos', diferidas.length === 4 && ctxAntes >= 9 && new Set(diferidas.map(e => e.f)).size === 4, { contextosAntesDeLaPrimeraVacia: ctxAntes, cuadros: diferidas.map(e => e.f), capas: diferidas.map(e => e.capa) })
      await revisarFinal(c, 'montaje', { todasVivas: true })
      await sinBucle(c, 'montaje asentado', { ms: 2000 })
    },
  },
  ajenosB(4), ajenosB(8), ajenosB(12),
  {
    id: 'c', titulo: 'un ajeno en ping-pong: una rotación, saturación con su señal y sin bucle', motores: ['chromium', 'shell'],
    async correr(c) {
      const m = await c.ev('__nav.montar()')
      const n0 = await c.ev('__nav.nEventos()'), t0 = await c.ev('__nav.ahora()')
      await c.ev('__nav.ajeno({ pingPong: true, tope: 40 })')            // el ajeno que se rehace cada vez que el navegador se lo quita
      await c.ev('__nav.ajenos(7, { entre: 80 })')
      await c.dormir(38_000)                                              // cubre los dos reintentos de la saturación (5 s y 30 s)
      const evs = await c.ev(`__nav.eventos(${n0})`)
      const pp = await c.ev('__nav.pingPong()')
      const serie = Array.from({ length: 39 }, () => 0), propiasPorSegundo = Array.from({ length: 39 }, () => 0)
      for (const e of evs) if (e.k === 'ctx') { const s = Math.min(38, Math.floor((e.t - t0) / 1000)); serie[s]++; e.ajeno || propiasPorSegundo[s]++ }
      const a = analizar(evs, m.filas)
      const transitorio = propiasPorSegundo.slice(0, 4).reduce((x, y) => x + y, 0), regimen = serie.slice(4).reduce((x, y) => x + y, 0)
      c.nota('getContext por segundo (propios y ajenos)', serie)
      c.nota('ping-pong (veces que el ajeno se rehizo)', pp)
      c.nota('caidas', a.caidas.map(x => `${x.capa}:${x.estado}${x.necesaria ? '' : '(prescindible)'}`))
      c.comprobar('una rotación propia como máximo en el transitorio (a lo sumo una readquisición por capa necesaria)', transitorio <= 9, `${transitorio} contextos propios nuevos en los primeros 4 s`)
      c.comprobar('el ajeno no queda en bucle (se rehizo pocas veces y no llegó a su tope)', pp.every(x => !x.tope && x.rehechos <= 3), pp)
      c.comprobar('en régimen, como máximo 3 adquisiciones por minuto (los reintentos de 5 s y 30 s)', regimen <= 3, `${regimen} getContext entre el segundo 4 y el 38`)
      c.comprobar('sin bucle: nada de getContext en los últimos 4 s', serie.slice(35).every(n => n === 0), serie.slice(28))
      await revisarFinal(c, 'final', {})
      const est = await c.ev('__nav.estado()')
      const sin = est.filas.filter(necesaria).filter(f => f.state !== 'live')
      c.nota('contextos', { propios: est.propios, ajenos: est.ajenos })
      c.comprobar('si una capa necesaria quedó sin superficie, la señal de saturación salió una sola vez', !sin.length || est.avisos.filter(x => SATURACION.test(x)).length === 1, { sin: ids(sin), avisos: est.avisos.filter(x => SATURACION.test(x)).length })
      c.nota('saturación', { señalesEmitidas: est.avisos.filter(x => SATURACION.test(x)).length, sinSuperficieAlFinal: ids(sin) })
    },
  },
  {
    id: 'd', titulo: 'ventana window.open del mismo origen con otro mapa montado por el mismo JS: un solo registro', motores: ['chromium', 'shell'],
    async correr(c) {
      const m = await c.ev('__nav.montar()')
      const cad = await c.ev('__nav.cadencia()')
      const v = await c.abrirVentana()
      const n0 = await c.ev('__nav.nEventos()')
      await c.ev('__nav.montarVentana()')
      await c.ev('__nav.quieto(1500, 20000)')
      const evs = await c.ev(`__nav.eventos(${n0})`)
      const est = await c.ev('__nav.estado()')
      const filasB = est.filasVentana, a = analizar(evs, m.filas)
      c.nota('contextos', { principal: est.principal, ventana: est.ventana, propios: est.propios })
      const nec = [...est.filas, ...filasB].filter(necesaria)
      c.comprobar('el registro ve las dos: 9 + 7 capas con contenido caben en 16 y todas están vivas', nec.length === 16 && nec.every(f => f.state === 'live'), nec.filter(f => f.state !== 'live').map(f => `${f.layerId}:${f.state}`))
      c.comprobar('las vacías del primer mapa cedieron su lugar al segundo', est.filas.filter(f => !necesaria(f)).every(f => f.state !== 'live') && est.propios.vivos <= 16, { vacias: est.filas.filter(f => !necesaria(f)).map(f => `${f.layerId}:${f.state}`), propiosVivos: est.propios.vivos })
      c.comprobar('ninguna capa con contenido cayó mientras quedaba una prescindible viva', a.caidas.filter(x => x.necesaria && x.prescindiblesVivos.length).length === 0, a.caidas.filter(x => x.necesaria).map(x => `${x.capa} con ${x.prescindiblesVivos.join(',')}`))
      c.comprobar('ninguna capa con contenido queda perdida sin recuperarse', !nec.some(f => f.state === 'lost'), est.propios)
      const sp = await c.ev('__nav.sondas()'), sv = await c.ev('__nav.sondasVentana()')
      const p1 = await c.sondear('principal', sp, vivas(est.filas.filter(necesaria)))
      const p2 = await c.sondear('ventana', sv, vivas(filasB.filter(necesaria)), v)
      c.comprobar('la ventana principal pinta sus capas vivas', p1.malas.length === 0, p1.malas.length ? p1.malas : `${p1.pintadas.length} píxeles`)
      c.comprobar('la ventana abierta pinta sus capas vivas', p2.malas.length === 0, p2.malas.length ? p2.malas : `${p2.pintadas.length} píxeles`)
      c.comprobar('sin errores de la página', est.errores.length === 0, est.errores)
      await sinBucle(c, 'dos mapas asentados', { ms: 2500 })

      // Presión de verdad: dos ajenos más (18 contextos para 16). Nadie queda muerto sin señal.
      const n1 = await c.ev('__nav.nEventos()')
      await c.ev('__nav.ajenos(2, { entre: 120 })')
      await c.ev('__nav.quieto(1500, 20000)')
      const evs2 = await c.ev(`__nav.eventos(${n1})`)
      const e2 = await c.ev('__nav.estado()')
      const nec2 = [...e2.filas, ...e2.filasVentana].filter(necesaria), sin = nec2.filter(f => f.state !== 'live')
      const a2 = analizar(evs2, [...est.filas, ...filasB])
      c.nota('con 2 ajenos', { sinSuperficie: sin.map(f => `${f.layerId}:${f.state}`), caidas: a2.caidas.map(x => `${x.capa}:${x.estado}`), ajenos: e2.ajenos })
      c.comprobar('con 2 ajenos, ninguna capa necesaria queda perdida sin señal', !nec2.some(f => f.state === 'lost') && (!sin.length || e2.avisos.some(x => SATURACION.test(x))), { sinSuperficie: sin.map(f => `${f.layerId}:${f.state}`), avisos: e2.avisos.length })
      c.comprobar('con 2 ajenos, ninguna necesaria cayó con una prescindible viva', a2.caidas.filter(x => x.necesaria && x.prescindiblesVivos.length).length === 0, a2.caidas.filter(x => x.necesaria).map(x => `${x.capa} con ${x.prescindiblesVivos.join(',')}`))
      await sinBucle(c, 'con 2 ajenos asentado', { ms: 8000, permitidos: 1 })
      const e2b = await c.ev('__nav.estado()')
      const nec2b = [...e2b.filas, ...e2b.filasVentana].filter(necesaria)
      c.nota('tras el reintento de los 5 s', nec2b.map(f => `${f.layerId}:${f.state}`))
      c.comprobar('tras el reintento, ninguna capa necesaria queda perdida', !nec2b.some(f => f.state === 'lost'), nec2b.filter(f => f.state === 'lost').map(f => f.layerId))
      const q1 = await c.sondear('principal-2-ajenos', await c.ev('__nav.sondas()'), vivas(e2b.filas.filter(necesaria)))
      const q2 = await c.sondear('ventana-2-ajenos', sv, vivas(e2b.filasVentana.filter(necesaria)), v)
      c.comprobar('con 2 ajenos, lo vivo de las dos ventanas pinta', q1.malas.length === 0 && q2.malas.length === 0, [...q1.malas, ...q2.malas])

      // Se cierra el widget: la señal de cupo devuelve lo soltado, una superficie por cuadro.
      const n2 = await c.ev('__nav.nEventos()')
      const tSenal = await c.ev('(() => { const t = __nav.ahora(); __nav.soltarAjenos(); __nav.invalidar(); return t })()')
      await c.ev('__nav.quieto(1500, 20000)')
      const evs3 = await c.ev(`__nav.eventos(${n2})`)
      const e3 = await c.ev('__nav.estado()')
      const nec3 = [...e3.filas, ...e3.filasVentana].filter(necesaria)
      c.comprobar('al cerrar el widget vuelven todas las capas necesarias', nec3.every(f => f.state === 'live'), nec3.filter(f => f.state !== 'live').map(f => `${f.layerId}:${f.state}`))
      const sinAntes = nec2b.filter(f => f.state !== 'live')
      sinAntes.length && revisarVueltas(c, analizar(evs3, [...e2b.filas, ...e2b.filasVentana]).vueltas, cad, 'tras el cierre', tSenal)
      const r1 = await c.sondear('principal-final', await c.ev('__nav.sondas()'), vivas(e3.filas.filter(necesaria)))
      const r2 = await c.sondear('ventana-final', sv, vivas(e3.filasVentana.filter(necesaria)), v)
      c.comprobar('al final todo pinta en las dos ventanas', r1.malas.length === 0 && r2.malas.length === 0, [...r1.malas, ...r2.malas])
      await c.ev('__nav.cerrarVentana()')
    },
  },
  {
    id: 'e', titulo: 'zoom animado durante una recuperación: ninguna adquisición dentro del gesto', motores: ['chromium', 'shell'],
    async correr(c) {
      const m = await c.ev('__nav.montar({ animacion: "on" })')
      const cad = await c.ev('__nav.cadencia()')
      const CAPAS = ['lug', 'bus', 'marcas']
      // control: la misma pérdida, sin gesto
      let n = await c.ev('__nav.nEventos()')
      const t0 = await c.ev(`(() => { const t = __nav.ahora(); __nav.perder(${JSON.stringify(CAPAS)}); return t })()`)
      await c.ev('__nav.quieto(1000, 10000)')
      let evs = await c.ev(`__nav.eventos(${n})`)
      const primero = evs.filter(e => e.k === 'ctx').map(e => e.t)
      const tPerdido = evs.find(e => e.k === 'perdido')?.t ?? t0         // desde que el navegador avisa, no desde la llamada: `loseContext` puede tardar con la GPU ocupada
      const ctl = analizar(evs, m.filas)
      c.nota('control sin gesto', { msDeLaLlamadaAlAviso: Math.round(tPerdido - t0), msDelAvisoAlPrimerGetContext: primero.length ? Math.round(primero[0] - tPerdido) : null, vueltas: ctl.vueltas.length })
      c.comprobar('control: sin gesto, la recuperación empieza enseguida', primero.length === 3 && primero[0] - tPerdido < 3 * cad + 250, { getContext: primero.length, msDesdeElAviso: primero.length ? Math.round(primero[0] - tPerdido) : null })
      revisarVueltas(c, ctl.vueltas, cad, 'control')

      // con gesto: se pierden las mismas tres capas y en la misma tarea empieza un vuelo con zoom
      const filas0 = (await c.ev('__nav.estado()')).filas
      n = await c.ev('__nav.nEventos()')
      const z0 = (await c.ev('__nav.vista()')).z
      const r = await c.ev(`(() => { const hechas = __nav.perder(${JSON.stringify(CAPAS)}); const t0 = __nav.iniciarVuelo(260, ${z0 + 1}, 1400); return { hechas, t0 } })()`)
      let g = null
      for (let i = 0; i < 80 && !g?.fin; i++) { await c.dormir(100); g = (await c.ev('__nav.gestos()')).at(-1) }
      await c.ev('__nav.quieto(1200, 15000)')
      evs = await c.ev(`__nav.eventos(${n})`)
      const ctx = evs.filter(e => e.k === 'ctx')
      const dentro = g?.fin ? ctx.filter(e => e.t >= g.ini && e.t <= g.fin) : []
      const despues = g?.fin ? ctx.filter(e => e.t > g.fin) : []
      const a = analizar(evs, filas0)
      c.nota('gesto', g && { duracionMs: Math.round(g.fin - g.ini), iniciaDespuesDeLaPerdidaMs: Math.round(g.ini - r.t0), perdidas: r.hechas, getContextDentro: dentro.length, getContextDespues: despues.length })
      c.comprobar('el motor avisó el gesto (interactionstart e interactionend)', !!g?.fin, g)
      c.comprobar('el gesto es largo (≥ 300 ms) y empezó con las capas perdidas', !!g?.fin && g.fin - g.ini >= 300 && g.ini - r.t0 < 100, g && { duracionMs: Math.round(g.fin - g.ini), arranqueMs: Math.round(g.ini - r.t0) })
      c.comprobar('ninguna adquisición (getContext) dentro del gesto', dentro.length === 0, dentro.map(e => Math.round(e.t - g.ini)))
      c.comprobar('las tres capas perdidas se recuperan al terminar el gesto', despues.length === 3 && a.vueltas.length === 3, { getContextDespues: despues.length, vueltas: a.vueltas.length })
      g?.fin && a.vueltas.length && c.comprobar('la primera vuelve dentro de k cuadros + 1 s del fin del gesto', Math.min(...a.vueltas.map(v => v.t)) - g.fin <= 3 * cad + 1000, `${Math.round(Math.min(...a.vueltas.map(v => v.t)) - g.fin)} ms`)
      await revisarFinal(c, 'tras el gesto', {})
      await sinBucle(c, 'tras el gesto asentado', { ms: 2000 })
    },
  },
  {
    id: 'f', titulo: 'orden visual: z-index y orden del DOM de cada pane iguales antes y después de perder, recuperar, soltar y volver a tomar', motores: ['chromium', 'shell'],
    async correr(c) {
      await c.ev('__nav.montar()')
      const snap0 = await c.ev('__nav.paneSnapshot()')
      c.nota('panes', JSON.parse(snap0).map(p => `${p.pane}:z${p.z}:${p.hijos.join('+')}`))
      const mismo = async etiqueta => {
        const s = JSON.parse(await c.ev('__nav.paneSnapshot()')), s0 = JSON.parse(snap0)
        const dif = s.map((p, i) => JSON.stringify(p) === JSON.stringify(s0[i]) ? null : { esperado: s0[i], obtenido: p }).filter(Boolean)
        c.comprobar(`${etiqueta}: z-index y orden del DOM idénticos a los del montaje`, s.length === s0.length && dif.length === 0, dif.length ? dif.slice(0, 2) : `${s.length} panes`)
      }
      await revisarFinal(c, 'montaje', { todasVivas: true })

      // 1) pérdida masiva y recuperación
      await c.ev('__nav.perder(["geo", "enlaces", "lug", "bus", "marcas", "extremos"])')
      await c.ev('__nav.quieto(1200, 15000)')
      await mismo('tras perder 6 capas y recuperarlas')
      await revisarFinal(c, 'recuperadas', { todasVivas: true })

      // 2) presión de ajenos: las cuatro prescindibles se sueltan y caen necesarias (9 + 9 > 16): saturación
      await c.ev('__nav.ajenos(9, { entre: 80 })')
      await c.ev('__nav.quieto(1500, 15000)')
      await mismo('con 9 ajenos (vacías soltadas, saturación)')
      await revisarFinal(c, 'con-ajenos', {})

      // 3) se cierra el widget: la señal de cupo devuelve lo que falte
      await c.ev('__nav.soltarAjenos()')
      await c.ev('__nav.invalidar()')
      await c.ev('__nav.quieto(1500, 15000)')
      await mismo('al soltar los ajenos y recuperar todo')
      await revisarFinal(c, 'sin-ajenos', { todasVivas: true })

      // 4) una capa que nació vacía recibe contenido y vuelve a quedar vacía
      await c.ev('__nav.llenarLinea("regla")')
      await c.ev('__nav.quieto(1000, 10000)')
      await mismo('tras dar contenido a la capa de medición')
      const img = await c.sondear('regla', [{ capa: 'regla', x: 300, y: 700, rgb: [17, 34, 51], nota: 'línea de la medición, que nació vacía' }], new Set(['regla']))
      c.comprobar('la capa que nació vacía pinta al recibir contenido', img.malas.length === 0, img.malas.length ? img.malas : img.archivo)
      await c.ev('__nav.vaciarLinea("regla")')
      await c.ev('__nav.quieto(800, 10000)')
      await mismo('tras vaciarla')
      const fin = await c.ev('__nav.estado()')
      c.comprobar('sin errores de la página', fin.errores.length === 0, fin.errores)
    },
  },
  ...MEDICIONES,
]
