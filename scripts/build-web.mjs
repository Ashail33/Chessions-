// Copies the static app into dist/ for packaging (Android app via Capacitor).
import { cp, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = root + 'dist/';
await rm(out, { recursive: true, force: true });
await mkdir(out);
for (const p of ['index.html', 'styles.css', 'src', 'vendor']) await cp(root + p, out + p, { recursive: true });
console.log('Built dist/');
