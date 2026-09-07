export default {
  displayName: 'client',
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
  // AIDEV-NOTE: no mappings at all, deliberately. This package depends on nothing else in the
  // repository, and a mapping added for convenience is how that stops being true.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          esModuleInterop: true,
        },
      },
    ],
  },
  transformIgnorePatterns: [],
};
