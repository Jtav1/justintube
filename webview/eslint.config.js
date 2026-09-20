import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // A `const` read above its own declaration is a temporal-dead-zone
      // ReferenceError at runtime, not a build failure - and once minified it
      // surfaces as an opaque "can't access lexical declaration 'N' before
      // initialization" that takes a bundle spelunk to trace back. Hoisted
      // function declarations are safe and used throughout, hence functions: false.
      'no-use-before-define': ['error', { variables: true, functions: false, classes: false }],
    },
  },
])
