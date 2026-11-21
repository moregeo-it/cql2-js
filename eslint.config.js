import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    }
  },

  js.configs.recommended,

  {
    rules: {
      'curly': ['error', 'all'],
      'semi': ['error', 'always'],
      'dot-notation': 'error',
      'eqeqeq': ['error', 'always'],
      'radix': ['error', 'always'],
      'require-await': 'error',
      'no-constructor-return': 'error',
      'no-duplicate-imports': 'error',
      'no-empty': 'error',
      'no-extend-native': 'error',
      'no-implicit-globals': 'error',
      'no-implicit-coercion': 'error',
      'no-lonely-if': 'error',
      'no-nested-ternary': 'error',
      'no-script-url': 'error',
      'no-shadow': 'error',
      'no-throw-literal': 'error',
      'no-var': 'error',

      'indent': ['error', 2, { 'SwitchCase': 1 }],

      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-promise-executor-return': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-use-before-define': ['error', {
        'functions': true,
        'classes': false,
        'variables': true,
        'allowNamedExports': true
      }],

      'no-await-in-loop': 'error',
      'no-inner-declarations': 'error',
      'no-unmodified-loop-condition': 'error',
      'require-atomic-updates': 'error'
    }
  },

  {
    ignores: [
      'node_modules/**',
      'types/**'
    ]
  }
];
