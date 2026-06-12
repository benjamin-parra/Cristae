// Configuración ESLint (flat config, ESLint 9). Solo consistencia y errores reales — sin reglas
// de formato (no es testing ni un linter de estilo agresivo). El patrón UPPER_CASE se ignora en
// no-unused-vars (constantes y placeholders), igual que en el proyecto padre.
import js from '@eslint/js'
import globals from 'globals'

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'build.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^[A-Z_]' }],
    },
  },
]
