import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite');
    const workspace = path.resolve(__dirname, '../../test-fixtures/simple');

    await runTests({
      version: 'stable',
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspace]
    });
  } catch (err) {
    console.error('Failed to run tests');
    process.exit(1);
  }
}

main();
