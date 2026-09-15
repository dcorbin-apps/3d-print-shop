import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  // AIDEV-NOTE: STRUCTURE, which is a different question from prettiness and is not prettier's. Every
  // rule here was chosen from what the wider TypeScript community does, then MEASURED against this
  // repository before it went on: all but eight of them already passed, because the code had these
  // habits and nothing was enforcing them. That is the point - an opinion the codebase holds rather
  // than one each file re-decides. `recommended` above is a CORRECTNESS set and enables none of this.
  // AIDEV-NOTE: the rules below this line need TYPE information, which is why the parser is given a
  // project service here rather than parsing each file alone. It costs the lint run about three
  // seconds over the whole repository - measured, not guessed - and buys the only rules in this
  // config that can see across a function boundary.
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // AIDEV-NOTE: both were measured at ZERO violations before being switched on, which says the
      // habit was already universal here - every deliberate fire-and-forget is already spelled `void`.
      // That is exactly when to enable a rule: it costs nothing today and catches the one somebody
      // forgets later, which is a print that never starts and no error anywhere saying why.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // AIDEV-NOTE: `no-unnecessary-condition` and `strict-boolean-expressions` are the other two
      // type-checked rules worth wanting, and both are OFF deliberately. Do not complete the set.
      //
      // `no-unnecessary-condition` was measured at nine violations here and every one of them was a
      // guard the code needs and the TYPE denies - `(failure as {cause?: unknown})?.cause` where the
      // cast is a claim about an `unknown` from a catch, `expected === undefined` after splitting a
      // hash that a mangled file really can cut short, `request.caller?.name` where the augmentation
      // says non-optional and the guard's refusal says otherwise. Switching it on means deleting six
      // real runtime guards, one of them the thing standing between a corrupted credentials file and
      // a way in. The honest fix for that class is `noUncheckedIndexedAccess` in the tsconfigs, which
      // is measured and written up in PLAN.md rather than done here.
      //
      // `strict-boolean-expressions` is in no typescript-eslint preset, deliberately - it is too
      // opinionated for one. Of its ten here, six are a genuine tightening and four are ordinary JSX
      // (`{selected?.loaded.includes(f) && <span/>}`) that it would have written as `=== true`.
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // An error, not a warning. A warning does not fail a build, so it is a rule nobody has to keep.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'separate-type-imports' }],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/array-type': ['error', { default: 'array' }],
      // Allowed where the type is already written down somewhere the reader can see it - a callback
      // against a typed parameter says its return in the signature it is being passed to.
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true, allowHigherOrderFunctions: true },
      ],
      // AIDEV-NOTE: the naming section of CLAUDE.md, made into something that fails a build. Object
      // KEYS are exempt because a key is data - an error code, a header, a filament's name - and the
      // shop does not get to rename somebody else's vocabulary. PascalCase is allowed for a function
      // because a component is one.
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'default', format: ['camelCase'] },
        { selector: 'function', format: ['camelCase', 'PascalCase'] },
        { selector: 'variable', format: ['camelCase', 'UPPER_CASE', 'PascalCase'] },
        { selector: 'parameter', format: ['camelCase'], leadingUnderscore: 'allow' },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'objectLiteralProperty', format: null },
        { selector: 'objectLiteralMethod', format: null },
        { selector: 'typeProperty', format: null },
        { selector: 'import', format: null },
      ],

      // `if (x) return;` on one line stays; a body that wraps to the next line takes braces.
      curly: ['error', 'multi-line'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-else-return': ['error', { allowElseIf: false }],
      'no-lonely-if': 'error',
      'no-nested-ternary': 'error',
      'no-param-reassign': 'error',
      'object-shorthand': ['error', 'always'],
      'prefer-template': 'error',
      'prefer-arrow-callback': 'error',
      'func-style': ['error', 'declaration', { allowArrowFunctions: true }],
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
);
