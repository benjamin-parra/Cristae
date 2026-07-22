// Verifica que un cambio sea NO-SEMÁNTICO (sólo comentarios + espaciado). Compara el minify de la
// versión en HEAD contra la del working tree: esbuild --minify es determinista, borra comentarios y
// normaliza whitespace, así que dos versiones que difieren SÓLO en eso minifican byte-idéntico.
// Uso: node scripts/verify-nonsemantic.mjs <ref> <archivo...>   (ref = HEAD, un tag, un commit)
// Salida: lista de archivos cuyo CÓDIGO cambió (vacío = todo el cambio fue comentarios/espaciado).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

const [, , ref = 'HEAD', ...files] = process.argv

const minify = (code) => transformSync(code, { minify: true, loader: 'js' }).code

const semanticos = []
for (const f of files) {
  let antes
  try { antes = execFileSync('git', ['show', `${ref}:${f}`], { encoding: 'utf8', maxBuffer: 1 << 26 }) }
  catch { console.log(`NUEVO   ${f} (no existe en ${ref}) — se omite`); continue }
  const ahora = readFileSync(f, 'utf8')
  const [ma, mb] = [minify(antes, f), minify(ahora, f)]
  if (ma !== mb) semanticos.push(f)
}

if (semanticos.length) {
  console.log('CÓDIGO CAMBIADO (no sólo comentarios/espaciado):')
  for (const f of semanticos) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log(`✓ ${files.length} archivo(s): el cambio es puramente comentarios + espaciado`)
