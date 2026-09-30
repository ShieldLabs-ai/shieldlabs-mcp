import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'node_modules/', '.deps/'] },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: rootDir,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // stdout carries the MCP protocol on stdio: log through the stderr logger instead.
      'no-console': 'error',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
