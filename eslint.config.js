import js from '@eslint/js';
import globals from 'globals';

const extensionGlobals = { ...globals.browser, ...globals.webextensions, Highlight: 'readonly' };

export default [
  js.configs.recommended,
  { ignores: ['node_modules/', 'dist/', '.claude/'] },
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: extensionGlobals },
  },
  {
    files: ['src/background.js'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.webextensions } },
  },
  {
    files: ['test/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // Test code runs in Node and, via page.evaluate(), inside the extension pages.
      globals: { ...globals.node, ...extensionGlobals, __emit: 'readonly', __har: 'writable', __navigated: 'writable', postcatSend: 'readonly' },
    },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
