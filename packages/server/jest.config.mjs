export default {
  displayName: 'server',
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  // AIDEV-NOTE: mock call history is per-test, always. Without this a mock created once - a
  // jest.mock() module factory, or a module-scope jest.spyOn - accumulates calls across every test
  // in the file, because a beforeEach that reprograms its BEHAVIOUR leaves its history intact.
  // Positive assertions still pass, so it hides: any "was not called" assertion silently reads a
  // previous test's calls. Set here rather than per file so files written later inherit it.
  clearMocks: true,
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  injectGlobals: false,
  // AIDEV-NOTE: the shop's own packages, mapped to their SOURCE so a change to the client is seen
  // by the server's tests without a build in between. Nothing outside this repository may be mapped
  // here: a client of the shop reaches it over HTTP, and the shop knows none of them.
  moduleNameMapper: {
    '^@3d-print-shop/client$': '<rootDir>/../client/src/index.ts',
    '^@3d-print-shop/octoprint-sim$': '<rootDir>/../octoprint-sim/src/index.ts',
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
