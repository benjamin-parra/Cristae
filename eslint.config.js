// Configuración ESLint (flat config, ESLint 9). Consistencia, errores reales y los invariantes de
// estilo de AGENTS.md. El patrón UPPER_CASE se ignora en no-unused-vars (constantes y
// placeholders), igual que en el proyecto padre.
import js from '@eslint/js'
import globals from 'globals'

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'react/src/**/*.js', 'build.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^[A-Z_]' }],
      'arrow-parens': ['error', 'as-needed'],
    },
  },
]
