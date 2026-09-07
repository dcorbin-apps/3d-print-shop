export default {
  collectCoverageFrom: ['packages/*/src/**/*.ts'],
  projects: [
    '<rootDir>/packages/client/jest.config.mjs',
    '<rootDir>/packages/server/jest.config.mjs',
    '<rootDir>/packages/octoprint-sim/jest.config.mjs',
  ],
};
