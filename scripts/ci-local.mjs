// Barrera de Cristae antes de subir: corre lint + suite + build sobre un CLON LIMPIO de lo commiteado,
// en la imagen del runner de CI de winglibraries Y en el Node de esta máquina.
//
//   node scripts/ci-local.mjs [--ref <commit>] [--usar-sello]
//
//   --ref         commit (o tag) a validar; por defecto HEAD.
//   --usar-sello  si ese mismo árbol ya pasó, no repite la corrida (lo usa el pre-push).
//
// Por qué la imagen del runner: Cristae se vendoriza en winglibraries (packages/cristae) y ahí lo
// verifica un pipeline de GitLab que avisa a todo el equipo cuando falla. El 06-11 se subió con el CI
// local en rojo; tres pruebas sólo andaban en el Node de la máquina (Node 26) y no en el de la imagen
// (Node 24). Probar sólo con el Node propio no basta: ese es el problema.
//
// Los dos pasos usan lo MISMO que el CI: el contenedor instala desde cero, así que no ve nada que sólo
// exista en tu working tree o en tu node_modules. El paso con el Node de la máquina reutiliza el
// node_modules del repo (symlink) si existe —se prueba el código commiteado, no las dependencias— y,
// si no, instala en el clon.
//
// Dónde corre el contenedor (sin rutas ni nombres de máquina en el repo; se configura por clon):
//   · Windows        → docker dentro de la distro WSL.
//   · Linux / macOS  → docker o podman locales, o un host remoto por ssh:
//       git config cilocal.remoto <alias-ssh>      git config cilocal.motor docker|podman
//       git config cilocal.candado <ruta-remota>   (serializa con `flock` en el host remoto)
//     Cada clave también se acepta como variable de entorno (CILOCAL_REMOTO, CILOCAL_MOTOR, CILOCAL_CANDADO).
//
// SELLO: en verde se guarda el hash del ÁRBOL validado en `<git-common-dir>/ci-local-sellos/` (no
// versionado). En rojo el código de salida es distinto de 0 y no se escribe sello.

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Imagen del job `verificar` de winglibraries (`default.image` de su .gitlab-ci.yml). Si allá cambia,
// cambia acá: es la que corre las pruebas de Cristae cuando se vendoriza en packages/cristae.
const IMAGEN_RUNNER = 'node:24-alpine'

// Git exporta estas variables a los hooks; apuntarían a otro repo si se heredaran en un subproceso.
for (const v of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete process.env[v]

const args = process.argv.slice(2)
const valorDe = nombre => { const i = args.indexOf(nombre); return i >= 0 ? args[i + 1] : null }
const ref = valorDe('--ref') ?? 'HEAD'
const usarSello = args.includes('--usar-sello')

const sh = (cmd, argv, opciones = {}) => execFileSync(cmd, argv, { encoding: 'utf8', maxBuffer: 256 << 20, stdio: 'pipe', ...opciones })
const REPO = sh('git', ['rev-parse', '--show-toplevel']).trim()
const git = (...argv) => sh('git', argv, { cwd: REPO }).trim()
const config = clave => {
  const env = process.env[clave.replace('.', '_').toUpperCase()]
  if (env) return env
  try { return git('config', '--get', clave) } catch { return null }
}

const commit = git('rev-parse', '--verify', `${ref}^{commit}`)
const arbol = git('rev-parse', '--verify', `${ref}^{tree}`)

/* ── Sello ────────────────────────────────────────────────────────────────── */
const dirSellos = join(resolve(REPO, git('rev-parse', '--git-common-dir')), 'ci-local-sellos')
const archivoSello = join(dirSellos, createHash('sha256').update(`${arbol}\n${IMAGEN_RUNNER}\n`).digest('hex').slice(0, 40))
if (usarSello && existsSync(archivoSello)) {
  console.log(`Sello vigente: el árbol ${arbol.slice(0, 12)} ya pasó en ${IMAGEN_RUNNER} y en el Node de la máquina. No se repite la corrida.`)
  process.exit(0)
}

/* ── Utilidades ───────────────────────────────────────────────────────────── */
// El shell de login del host remoto puede no ser POSIX (fish): todo comando remoto va dentro de `sh -c`.
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`
const ssh = (host, cmd, opciones) => sh('ssh', [host, `sh -c ${q(cmd)}`], opciones)
const existe = (cmd, argv = ['--version']) => spawnSync(cmd, argv, { stdio: 'ignore' }).status === 0

const t0 = Date.now()
const seg = desde => `${((Date.now() - desde) / 1000).toFixed(1)}s`
let fallo = false
const paso = (titulo, fn) => {
  if (fallo) return
  process.stdout.write(`▸ ${titulo}… `)
  const t = Date.now()
  try { fn(); console.log(`OK (${seg(t)})`) } catch (e) {
    console.log('FALLA\n')
    console.error(String(e.stdout ?? '') + String(e.stderr ?? '') || e.message)
    fallo = true
  }
}

/* ── Motor: dónde corre el contenedor ─────────────────────────────────────── */
function elegirMotor() {
  if (process.platform === 'win32') {
    return {
      nombre: 'wsl+docker', sufijoVolumen: '',
      ruta: win => '/mnt/' + win[0].toLowerCase() + win.slice(2).replace(/\\/g, '/'),
      engineCli: argv => sh('wsl', ['-d', 'archlinux', '-u', 'root', '--', 'bash', '-lc', ['docker', ...argv].map(q).join(' ')]),
    }
  }
  const remoto = config('cilocal.remoto')
  const preferido = config('cilocal.motor')
  if (remoto) {
    const engine = preferido ?? ssh(remoto, 'command -v docker >/dev/null && echo docker || { command -v podman >/dev/null && echo podman; }').trim()
    if (!engine) throw new Error(`Ni docker ni podman en ${remoto}.`)
    const candado = config('cilocal.candado')
    return {
      nombre: `${engine}@${remoto}`, remoto, sufijoVolumen: engine === 'podman' ? ':Z' : '',
      engineCli: argv => ssh(remoto, `${candado ? `flock ${candado} ` : ''}${[engine, ...argv].map(q).join(' ')}`),
    }
  }
  const engine = preferido ?? ['docker', 'podman'].find(e => existe(e))
  if (!engine) throw new Error('No hay docker ni podman. Instalá uno, o configurá un host remoto: git config cilocal.remoto <alias-ssh>')
  if (!existe(engine, ['info'])) throw new Error(`${engine} está instalado pero no responde (¿daemon apagado?). Levantalo, o usá un host remoto: git config cilocal.remoto <alias-ssh>`)
  return { nombre: engine, sufijoVolumen: engine === 'podman' ? ':Z' : '', engineCli: argv => sh(engine, argv) }
}

let motor
try { motor = elegirMotor() } catch (e) { console.error(e.message); process.exit(1) }
console.log(`Validando ${ref} (commit ${commit.slice(0, 12)}, árbol ${arbol.slice(0, 12)}) en ${IMAGEN_RUNNER} vía ${motor.nombre} y en Node ${process.version}`)

/* ── 1. Clon limpio de lo COMMITEADO ──────────────────────────────────────── */
const tmp = mkdtempSync(join(tmpdir(), 'cristae-ci-'))
const clon = join(tmp, 'repo')
let dirMotor = null
paso(`clon limpio de ${commit.slice(0, 12)}`, () => {
  mkdirSync(clon)
  sh('tar', ['-x', '-C', clon], { input: execFileSync('git', ['archive', '--format=tar', commit], { cwd: REPO, maxBuffer: 1 << 30 }) })
  // `npm ci` si el lockfile está commiteado (hoy .gitignore lo excluye: entonces `npm install`).
  writeFileSync(join(clon, 'ci-contenedor.sh'), [
    'set -e',
    'if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi',
    'npm run lint',
    'npm test',
    'npm run build',
  ].join('\n') + '\n')
})

/* ── 2. Contenedor: la imagen del runner, instalando desde cero ───────────── */
paso(motor.remoto ? `copiar el clon a ${motor.remoto}` : 'preparar el clon para el contenedor', () => {
  if (!motor.remoto) { dirMotor = motor.ruta ? motor.ruta(clon) : clon; return }
  dirMotor = ssh(motor.remoto, 'mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}/ci-local" && mktemp -d "${XDG_CACHE_HOME:-$HOME/.cache}/ci-local/cristae-XXXXXX"').trim()
  ssh(motor.remoto, `tar -x -C ${q(dirMotor)}`, { input: execFileSync('tar', ['-c', '-C', clon, '.'], { maxBuffer: 1 << 30 }) })
})
paso(`imagen del runner disponible (${IMAGEN_RUNNER})`, () => {
  try { motor.engineCli(['image', 'inspect', IMAGEN_RUNNER]) } catch { motor.engineCli(['pull', IMAGEN_RUNNER]) }
})
paso(`${IMAGEN_RUNNER}: install, lint, test, build`, () => {
  motor.engineCli(['run', '--rm', '-v', `${dirMotor}:/build${motor.sufijoVolumen}`, '-w', '/build', IMAGEN_RUNNER, 'sh', 'ci-contenedor.sh'])
})

/* ── 3. El Node de esta máquina, sobre el MISMO clon ──────────────────────── */
// El clon local nunca se tocó dentro del contenedor (en remoto se copió; en local el contenedor sí lo
// usa, así que los restos root-owned se limpian antes de reusarlo).
paso(`Node ${process.version} de esta máquina: lint + test`, () => {
  if (!motor.remoto) limpiarClon()
  const modulos = join(REPO, 'node_modules')
  if (existsSync(modulos)) symlinkSync(modulos, join(clon, 'node_modules'), 'dir')
  else sh('npm', ['install', '--no-audit', '--no-fund'], { cwd: clon })
  sh('npm', ['run', 'lint'], { cwd: clon })
  sh('npm', ['test'], { cwd: clon })
})

/* ── Limpieza ─────────────────────────────────────────────────────────────── */
// El contenedor corre como root: lo que creó (node_modules) no lo puede borrar el usuario normal.
function limpiarClon() {
  if (motor.remoto || !dirMotor) return
  try { motor.engineCli(['run', '--rm', '-v', `${dirMotor}:/build${motor.sufijoVolumen}`, IMAGEN_RUNNER, 'sh', '-c', 'rm -rf /build/node_modules /build/dist']) } catch { /* se intenta igual abajo */ }
}
if (motor.remoto && dirMotor) {
  try { motor.engineCli(['run', '--rm', '-v', `${dirMotor}:/build${motor.sufijoVolumen}`, IMAGEN_RUNNER, 'sh', '-c', 'rm -rf /build/* /build/.[!.]* /build/..?*']) } catch { /* idem */ }
  try { ssh(motor.remoto, `rm -rf ${q(dirMotor)}`) } catch { /* residuo en el cache del host */ }
}
rmSync(tmp, { recursive: true, force: true })

if (fallo) {
  console.error(`\nGate local EN ROJO (${seg(t0)}). No se escribe sello: no subir esto.`)
  process.exit(1)
}
mkdirSync(dirSellos, { recursive: true })
writeFileSync(archivoSello, JSON.stringify({ arbol, imagen: IMAGEN_RUNNER, node: process.version, commit, motor: motor.nombre, fecha: new Date().toISOString() }, null, 2) + '\n')
console.log(`\nGate local en verde (${seg(t0)}). Sello escrito para el árbol ${arbol.slice(0, 12)}.`)
