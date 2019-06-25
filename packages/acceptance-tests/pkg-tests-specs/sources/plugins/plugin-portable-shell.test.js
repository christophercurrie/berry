const {
  fs: {readJson, unpackToDirectory, writeFile}
} = require('pkg-tests-core');

describe(`Plugins`, () => {
  describe(`portable-shell`, () => {
    test(
      `it should automatically add @types to development`,
      makeTemporaryEnv({
        scripts: {
          'printenv': 'env',
        },
      }, async ({ path, run, source }) => {
        await writeFile(`${path}/.yarnrc`, `plugins:\n  - ${JSON.stringify(require.resolve(`@berry/monorepo/scripts/plugin-portable-shell.js`))}\n`);

        expect(await run(`printenv`)).toMatchSnapshot();
      })
    );
  });
});
