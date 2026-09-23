// Builds dist/postcat-<version>.zip with only what the browser needs: manifest, src/, icons/.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  console.error(`Version mismatch: manifest.json ${manifest.version} vs package.json ${pkg.version}`);
  process.exit(1);
}

const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, `postcat-${manifest.version}.zip`);
fs.rmSync(out, { force: true });

// zip(1) is available on macOS, Linux and GitHub's runners; -X drops OS metadata.
execFileSync('zip', ['-r', '-X', '-q', out, 'manifest.json', 'src', 'icons', '-x', '*.DS_Store'], { cwd: root, stdio: 'inherit' });
const size = fs.statSync(out).size;
console.log(`${path.relative(root, out)} (${(size / 1024).toFixed(0)} KB)`);
