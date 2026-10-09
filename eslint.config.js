import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `.claude`: Claude Code's own settings and its agents' worktrees, not this repo's code.
    ignores: ['node_modules', '.claude', 'proto-gen', 'migrations', 'src/api/openapi/schema.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'error',
    },
  },
  { languageOptions: { globals: globals.node } },
  { files: ['scripts/**', 'test/**'], rules: { 'no-console': 'off' } },
);
