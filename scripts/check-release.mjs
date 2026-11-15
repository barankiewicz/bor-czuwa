import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve(process.argv[2] ?? 'build');
const markers = /wersja testowa|test version|noindex|dane testowe|danych testowych|test data coverage|\[data startu\]|\[e-mail projektu\]|\[lokalizacja serwera\]|szkic do przeglądu prawników|brzmienie do potwierdzenia przez prawników/iu;
const failures = [];

async function scan(current) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name);
    if (entry.isDirectory()) await scan(file);
    else if (/\.(html|js|json|css|txt|md|svg|xml|webmanifest)$/i.test(entry.name)) {
      const match = (await readFile(file, 'utf8')).match(markers);
      if (match) failures.push(`${path.relative(directory, file)}: ${match[0]}`);
    }
  }
}

try {
  await readFile(path.join(directory, 'index.html'));
  await scan(directory);
} catch {
  failures.push('Build missing or unreadable. Run the build before checking release assets.');
}
if (failures.length) {
  console.error(`Release blocked:\n${failures.join('\n')}\nComplete human step 02 before release. Use npm run build:staging only for internal checks.`);
  process.exitCode = 1;
} else console.log('Release assets contain no test markers or legal placeholders.');
