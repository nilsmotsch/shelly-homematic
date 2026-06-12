#!/usr/bin/env node
/**
 * Generate a THIRD-PARTY-LICENSES file for the addon tarball.
 *
 * Reads an esbuild metafile and collects every npm package that contributed
 * code to the bundle, then concatenates each package's LICENSE/NOTICE text
 * (falling back to the SPDX id from package.json when no license file is
 * shipped). The build script appends the bundled Node.js runtime license
 * separately.
 *
 * Usage: node scripts/generate-third-party-licenses.mjs <metafile.json> <outfile>
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const [metaPath, outPath] = process.argv.slice(2);
if (!metaPath || !outPath) {
  console.error('usage: generate-third-party-licenses.mjs <metafile.json> <outfile>');
  process.exit(1);
}

const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

// Map of package dir -> true for every node_modules package in the bundle.
const pkgDirs = new Set();
for (const input of Object.keys(meta.inputs)) {
  const idx = input.lastIndexOf('node_modules/');
  if (idx === -1) continue;
  const rest = input.slice(idx + 'node_modules/'.length);
  const parts = rest.split('/');
  const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  pkgDirs.add(`${input.slice(0, idx)}node_modules/${name}`);
}

// Dedupe by name@version (the same package can appear under several paths).
const packages = new Map();
for (const dir of pkgDirs) {
  const pkgJsonPath = path.join(dir, 'package.json');
  if (!existsSync(pkgJsonPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const key = `${pkg.name}@${pkg.version}`;
  if (packages.has(key)) continue;

  const files = readdirSync(dir);
  const texts = files
    .filter((f) => /^(licen[cs]e|notice)(\.|-|$)/i.test(f))
    .sort()
    .map((f) => readFileSync(path.join(dir, f), 'utf8').trim());

  packages.set(key, {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license || 'see license text',
    homepage: pkg.homepage || '',
    texts,
  });
}

const rule = '='.repeat(72);
const out = [
  'Third-party software distributed with the shelly-homematic addon.',
  '',
  'The file dist/index.js is a single-file bundle that contains the',
  'shelly-homematic application together with the npm packages listed',
  'below. Each section reproduces the license under which that package',
  'is redistributed.',
  '',
];

for (const key of [...packages.keys()].sort()) {
  const p = packages.get(key);
  out.push(rule);
  out.push(`${p.name} ${p.version} (${p.license})`);
  if (p.homepage) out.push(p.homepage);
  out.push(rule);
  out.push('');
  if (p.texts.length > 0) {
    out.push(p.texts.join('\n\n'));
  } else {
    out.push(`(no license file shipped in the npm package; licensed under ${p.license},`);
    out.push(`see the package's source repository for the full text)`);
  }
  out.push('');
}

writeFileSync(outPath, out.join('\n'));
console.log(`Wrote ${outPath} (${packages.size} packages)`);
