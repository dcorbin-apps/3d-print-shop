export default {
  collectCoverageFrom: ['packages/*/src/**/*.ts'],
  projects: [
    '<rootDir>/packages/client/jest.config.mjs',
    '<rootDir>/packages/server/jest.config.mjs',
    '<rootDir>/packages/octoprint-sim/jest.config.mjs',
    '<rootDir>/packages/ui/jest.config.mjs',
    '<rootDir>/packages/installer/jest.config.mjs',
    '<rootDir>/scripts/jest.config.mjs',
  ],
};
