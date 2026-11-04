// Build script: bundles the extension into dist/ with esbuild.
// Usage: node scripts/build.mjs [--watch]
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

async function copyStatic() {
  await mkdir(dist, { recursive: true });
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(root, 'public/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  await writeFile(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await cp(path.join(root, 'public/icons'), path.join(dist, 'icons'), { recursive: true });
  await cp(path.join(root, 'src/preview/preview.html'), path.join(dist, 'preview.html'));
  await cp(path.join(root, 'src/preview/preview.css'), path.join(dist, 'preview.css'));
  await cp(path.join(root, 'src/sandbox/sandbox.html'), path.join(dist, 'sandbox.html'));
  await cp(path.join(root, 'src/content/content.css'), path.join(dist, 'content.css'));
}

const common = {
  bundle: true,
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  target: ['chrome120'],
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
};

const configs = [
  { entryPoints: ['src/content/index.ts'], outfile: 'dist/content.js', format: 'iife' },
  { entryPoints: ['src/background/sw.ts'], outfile: 'dist/sw.js', format: 'esm' },
  { entryPoints: ['src/preview/preview.ts'], outfile: 'dist/preview.js', format: 'iife' },
  { entryPoints: ['src/sandbox/sandbox.ts'], outfile: 'dist/sandbox.js', format: 'iife' },
];

await rm(dist, { recursive: true, force: true });
await copyStatic();

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context({ ...common, ...c })));
  await Promise.all(contexts.map((c) => c.watch()));
  const { watch: fsWatch } = await import('node:fs');
  for (const dir of ['public', 'src/preview', 'src/sandbox', 'src/content']) {
    fsWatch(path.join(root, dir), { recursive: true }, (_e, f) => {
      if (f && /\.(html|css|json)$/.test(f)) copyStatic().catch(console.error);
    });
  }
  console.log('watching…');
} else {
  await Promise.all(configs.map((c) => esbuild.build({ ...common, ...c })));
  console.log('built dist/');
}
