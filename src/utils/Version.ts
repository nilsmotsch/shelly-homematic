import * as fs from 'fs';
import * as path from 'path';

// Single source of truth for the displayed version: package.json, which sits
// next to dist/ in both layouts (repo root for tsc/ts-node, ADDON_DIR for the
// esbuild addon bundle — build-addon.sh copies it there).
// Falls back to the addon's plain-text VERSION file, which every install
// path guarantees even when package.json wasn't deployed.
let cached: string | null = null;

export function appVersion(): string {
  if (cached) return cached;
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, rel), 'utf-8'));
      if (pkg.version) { cached = pkg.version as string; return cached; }
    } catch { /* try next */ }
  }
  for (const rel of ['../VERSION', '../../addon/VERSION']) {
    try {
      const v = fs.readFileSync(path.resolve(__dirname, rel), 'utf-8').trim();
      if (v) { cached = v; return cached; }
    } catch { /* try next */ }
  }
  return '0.0.0'; // not cached — a later read may succeed
}
