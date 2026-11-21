import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/generated/**', 'tmp/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
];
