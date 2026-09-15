export default {
  displayName: 'ui',
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'jsdom',
  // The same rule every other project here follows: mock call history is per-test, always.
  clearMocks: true,
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  injectGlobals: false,
  // AIDEV-NOTE: the client mapped to its SOURCE, and to the browser entry the UI actually imports -
  // so a change to the contract is seen here without a build in between, exactly as the server's
  // tests see it. Stylesheets are what a bundler handles and jest cannot; there is nothing in one
  // for a test to assert.
  moduleNameMapper: {
    '^@3d-print-shop/client/browser$': '<rootDir>/../client/src/browser.ts',
    '^@3d-print-shop/client$': '<rootDir>/../client/src/index.ts',
    '\\.css$': '<rootDir>/tests/noStyles.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: '<rootDir>/tests/tsconfig.json',
      },
    ],
  },
  transformIgnorePatterns: [],
};
