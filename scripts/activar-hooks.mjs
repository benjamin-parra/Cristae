// `prepare`: deja los hooks versionados (.githooks) activos en este clon.
//
// Lo invoca `prepare` sólo si el archivo existe (el paquete publicado y los installs desde GitHub no
// lo traen: `files` lo deja fuera) y calla ante cualquier problema: sin git (una imagen de CI que no lo
// trae) o dentro de otro repo no debe romper el `npm install`.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

try {
  // Sólo si ESTE directorio es la raíz del repo: copiado dentro de otro repo no se toca nada.
  if (resolve(git('rev-parse', '--show-toplevel')) === resolve(process.cwd()) && existsSync('.githooks/pre-push')) {
    git('config', 'core.hooksPath', '.githooks')
    for (const f of readdirSync('.githooks')) chmodSync(join('.githooks', f), 0o755) // sin el bit, git salta el hook con un hint
  }
} catch { /* sin git (CI, tarball): nada que activar */ }
