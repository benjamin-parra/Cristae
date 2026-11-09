// Hook PreToolUse de Claude Code: un `git push` no se salta el pre-push. El pre-push corre el CI local en la
// imagen del runner; --no-verify, un core.hooksPath en la línea o HUSKY=0 lo apagan sin que se note.
// En `git push`, -n es --dry-run y no salta hooks: no se bloquea.
let entrada = ''
process.stdin.on('data', d => { entrada += d })
process.stdin.on('end', () => {
  const comando = JSON.parse(entrada || '{}').tool_input?.command ?? ''
  const esPush = /(^|[^\w-])git(\s|$)/.test(comando) && /(^|\s)push(\s|$)/.test(comando)
  if (!esPush || !/--no-verify|core\.hooksPath|HUSKY=0/.test(comando)) return
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Un git push no se salta el pre-push (--no-verify, core.hooksPath, HUSKY=0). Si el pre-push frena, el CI local está en rojo: se corrige la causa o se le pregunta al usuario.',
    },
  }))
})
