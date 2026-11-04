// Packages dist/ into gitifact-<version>.zip for Chrome Web Store upload.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const out = `gitifact-${pkg.version}.zip`;
execFileSync('zip', ['-r', '-X', `../${out}`, '.'], { cwd: new URL('../dist', import.meta.url).pathname, stdio: 'inherit' });
console.log(`wrote ${out}`);
