// `npm run pack` ships manifest, src/ and icons/ but never the dev build stamp (src/build-info.js).
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const stamp = path.join(root, 'src', 'build-info.js');

test('pack leaves src/build-info.js out of the zip', () => {
  // A stamped checkout is the case that matters; stamp a plain one for the duration of the run.
  const hadStamp = fs.existsSync(stamp);
  if (!hadStamp) fs.writeFileSync(stamp, "export default { commit: 'test', short: 'test', branch: 'test', time: '' };\n");
  try {
    execFileSync('node', ['scripts/pack.js'], { cwd: root, stdio: 'pipe' });
  } finally {
    if (!hadStamp) fs.rmSync(stamp, { force: true });
  }
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const listing = execFileSync('unzip', ['-l', path.join(root, 'dist', `postcat-${version}.zip`)], { encoding: 'utf8' });
  assert.ok(listing.includes('src/panel/main.js'), listing);
  assert.ok(!listing.includes('build-info'), listing);
});
