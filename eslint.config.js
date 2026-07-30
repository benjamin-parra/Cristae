// Configuración ESLint (flat config, ESLint 9). Consistencia, errores reales y los invariantes de
// estilo de AGENTS.md. El patrón UPPER_CASE se ignora en no-unused-vars (constantes y
// placeholders), igual que en el proyecto padre.
// La librería, el banco de medición, los ejemplos y las pruebas comparten reglas: lo único que
// cambia entre bloques es de qué entorno son los globals.
import js from '@eslint/js'
import globals from 'globals'

const reglas = {
  'no-unused-vars' : ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^[A-Z_]' }],
  'arrow-parens'   : ['error', 'as-needed'],
}

const idioma = entorno => ({ ecmaVersion: 2023, sourceType: 'module', globals: entorno })

// test-helpers/dom-stub.mjs los instala en globalThis antes de montar un engine headless: para el
// linter son globals del entorno de pruebas, no identificadores sueltos.
const STUB_DOM = {
  document              : 'readonly',
  requestAnimationFrame : 'readonly',
  cancelAnimationFrame  : 'readonly',
  ResizeObserver        : 'readonly',
  IntersectionObserver  : 'readonly',
}

export default [
  js.configs.recommended,
  {
    files           : ['src/**/*.js', 'react/src/**/*.js', 'build.mjs'],
    languageOptions : idioma({ ...globals.browser, ...globals.node }),
    rules           : reglas,
  },
  {
    files           : ['bench/**/*.js', 'examples/**/*.js'],
    languageOptions : idioma(globals.browser),
    rules           : reglas,
  },
  {
    files           : ['test/**/*.mjs', 'test-helpers/**/*.mjs'],
    languageOptions : idioma({ ...globals.node, ...STUB_DOM }),
    rules           : reglas,
  },
]
