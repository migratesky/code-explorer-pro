import * as path from 'path';
import * as Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 20000 });

  const testsRoot = path.resolve(__dirname);

  return new Promise((resolve, reject) => {
    // Load single test file to avoid glob/ESM issues
    mocha.addFile(path.resolve(testsRoot, 'extension.test.js'));

    try {
      mocha.run((failures: number) => {
        if (failures > 0) {
          reject(new Error(`${failures} tests failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err);
      reject(err);
    }
  });
}
