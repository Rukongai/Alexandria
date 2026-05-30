// Rewrites every `--ax-*: hsl(H S% L%);` color declaration into a channel pair:
//   --ax-name-h: H S% L%;
//   --ax-name: hsl(var(--ax-name-h));
// and `--ax-*: #ffffff;` into the equivalent `0 0% 100%` channel pair.
// Non-color tokens (fonts, density, radius, aspect, shadows) are left untouched.
// Idempotent-ish: re-running on already-transformed output is a no-op because
// transformed lines no longer match `: hsl(NUMBERS)` / `: #ffffff`.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node transform-tokens.mjs <path-to-css>');
  process.exit(1);
}

const HSL = /^(\s*)(--ax-[\w-]+):\s*hsl\(([^)]+)\);\s*$/;
const HEX_WHITE = /^(\s*)(--ax-[\w-]+):\s*#ffffff;\s*$/i;

const out = readFileSync(file, 'utf8')
  .split('\n')
  .map((line) => {
    let m = line.match(HSL);
    if (m) {
      const [, indent, name, channels] = m;
      return `${indent}${name}-h: ${channels};\n${indent}${name}: hsl(var(${name}-h));`;
    }
    m = line.match(HEX_WHITE);
    if (m) {
      const [, indent, name] = m;
      return `${indent}${name}-h: 0 0% 100%;\n${indent}${name}: hsl(var(${name}-h));`;
    }
    return line;
  })
  .join('\n');

writeFileSync(file, out);
console.log(`transformed ${file}`);
