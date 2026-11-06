// Firefox de sistema por Marionette: Playwright sólo maneja el Firefox parcheado que trae, así que `/usr/bin/firefox` se maneja por
// el protocolo de Marionette (mensajes `longitud:json` por TCP). Sólo hace falta navegar, correr un código en la página y capturar.
import { spawn } from 'node:child_process'
import net from 'node:net'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const PREFS = {
  'browser.startup.page': 0, 'browser.shell.checkDefaultBrowser': false, 'privacy.reduceTimerPrecision': false, 'privacy.resistFingerprinting': false,
  'webgl.sanitize-unmasked-renderer': false, 'webgl.enable-debug-renderer-info': true, 'layout.css.devPixelsPerPx': '1.0',
  'datareporting.policy.dataSubmissionEnabled': false, 'toolkit.telemetry.enabled': false, 'app.update.auto': false, 'app.update.enabled': false,
  'network.captive-portal-service.enabled': false, 'network.connectivity-service.enabled': false, 'dom.max_script_run_time': 0,
  'browser.sessionstore.resume_from_crash': false, 'dom.disable_open_during_load': false, 'marionette.port': 2830,
}

export const lanzarFirefox = async ({ url, ejecutable = '/usr/bin/firefox', puerto = 2830 }) => {
  const perfil = path.join(process.env.CRISTAE_PERFIL_FF ?? path.join(homedir(), '.cache'), 'cristae-test-navegador-ff')
  rmSync(perfil, { recursive: true, force: true })
  mkdirSync(perfil, { recursive: true })
  writeFileSync(path.join(perfil, 'user.js'), Object.entries({ ...PREFS, 'marionette.port': puerto }).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'))
  const hijo = spawn(ejecutable, ['--headless', '--no-remote', '--marionette', '--remote-allow-system-access', '--profile', perfil, '--width', '1440', '--height', '987', 'about:blank'],
    { stdio: 'ignore', detached: true, env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: '1' } })
  const matar = () => { try { process.kill(-hijo.pid, 'SIGKILL') } catch {} }
  // si el orquestador muere (el carril corta con SIGTERM a los 450 s), Firefox no queda vivo
  process.on('exit', matar)
  process.on('SIGTERM', () => { matar(); process.exit(143) })

  let socket
  for (let i = 0; i < 120 && !socket; i++) {
    socket = await new Promise(ok => { const s = net.connect(puerto, '127.0.0.1', () => ok(s)); s.on('error', () => ok(null)) })
    socket || await new Promise(r => setTimeout(r, 500))
  }
  if (!socket) { matar(); throw new Error('Firefox no abrió Marionette') }

  let buf = '', id = 0
  const esperas = []
  socket.on('data', d => {
    buf += d
    for (;;) {
      const m = buf.match(/^(\d+):/)
      if (!m) break
      const n = +m[1], ini = m[0].length
      if (Buffer.byteLength(buf) < ini + n) break
      const msg = JSON.parse(buf.slice(ini, ini + n))
      buf = buf.slice(ini + n)
      esperas.shift()?.(msg)
    }
  })
  const siguiente = () => new Promise(r => esperas.push(r))
  await siguiente()                                                  // el saludo del servidor
  const cmd = async (nombre, params = {}) => {
    const j = JSON.stringify([0, ++id, nombre, params])
    socket.write(`${Buffer.byteLength(j)}:${j}`)
    const r = await siguiente()
    if (r[2]) throw new Error(`${nombre}: ${JSON.stringify(r[2])}`)
    return r[3]
  }
  await cmd('WebDriver:NewSession', { capabilities: {} })
  await cmd('WebDriver:Navigate', { url })

  const corre = async (script, args = []) => (await cmd('WebDriver:ExecuteScript', { script, args })).value
  return {
    version: await corre('return navigator.userAgent'),
    // Corre `codigo` en la página (la función `__run` de nav.mjs) y espera su resultado.
    async evaluar(codigo, tope = 60_000) {
      const id = await corre('return (window.wrappedJSObject ?? window).__run(arguments[0])', [codigo])
      const desde = Date.now()
      for (;;) {
        const r = await corre('return (window.wrappedJSObject ?? window).__res[arguments[0]] ?? null', [id])
        if (r) { const o = JSON.parse(r); if (o.error) throw new Error(o.error); return o.ok }
        if (Date.now() - desde > tope) throw new Error(`tope de ${tope} ms esperando: ${codigo.slice(0, 80)}`)
        await new Promise(res => setTimeout(res, 40))
      }
    },
    async captura() { return Buffer.from((await cmd('WebDriver:TakeScreenshot', { full: false, hash: false, scroll: false })).value, 'base64') },
    cerrar() { try { socket.destroy() } catch {} matar() },
  }
}
