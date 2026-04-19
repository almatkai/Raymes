import { access, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { getScreenSnapshot, moveMouse, screenshot, typeText } from '../src/main/bridge';

async function main(): Promise<void> {
  const png = screenshot();
  const pngPath = '/tmp/test.png';
  await writeFile(pngPath, png);
  await access(pngPath);
  console.log(`Saved screenshot to ${pngPath}`);

  moveMouse(100, 100);
  console.log('Moved mouse to (100, 100)');

  console.log('Typing "hello" in 1s. Focus a text input now...');
  await delay(1000);
  typeText('hello');

  const snapshot = await getScreenSnapshot();
  console.log('AX tree first 5 elements:');
  console.log(JSON.stringify(snapshot.elements.slice(0, 5), null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
