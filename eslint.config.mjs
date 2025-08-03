// eslint.config.mjs
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      // Prevent the verbatimModuleSyntax errors from ever returning
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],

      // Hygiene
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['log', 'warn', 'error'] }],
      'no-debugger': 'error',
    },
  },
  // Disable rules that fight Prettier
  eslintConfigPrettier,
];
