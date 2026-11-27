import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', 'out', '.git']);

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(m?js|css|html|json|md|webmanifest|ps1)$/.test(name)) yield p;
  }
}

// Guards against UTF-8 text being re-read as Windows-1252 and saved again,
// which turns curly quotes, arrows and dashes into sequences starting with U+00E2.
test('source files are clean UTF-8 without mojibake or BOMs', () => {
  const bad = [];
  for (const f of files(root)) {
    if (f.endsWith('encoding.test.mjs')) continue;
    const buf = readFileSync(f);
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bad.push(`${relative(root, f)}: BOM`);
    const text = buf.toString('utf8');
    if (text.includes('�')) bad.push(`${relative(root, f)}: invalid UTF-8`);
    const m = text.match(/â€|â†|Ã[\u0080-¿]|Â[·×]/);
    if (m && !f.endsWith('encoding.test.mjs')) bad.push(`${relative(root, f)}: mojibake "${m[0]}"`);
  }
  assert.deepEqual(bad, []);
});
