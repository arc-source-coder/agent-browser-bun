#!/usr/bin/env bun

/**
 * Verifies that package.json and cli/Cargo.toml have the same version.
 * Used in CI to catch version drift.
 */

import { join } from 'node:path';

const rootDir = join(import.meta.dir, '..');

// Read package.json version
const packageJson = await Bun.file(join(rootDir, 'package.json')).json();
const packageVersion = packageJson.version;

// Read Cargo.toml version
const cargoToml = await Bun.file(join(rootDir, 'cli/Cargo.toml')).text();
const cargoVersionMatch = cargoToml.match(/^version\s*=\s*"([^"]*)"/m);

if (!cargoVersionMatch) {
  console.error('Could not find version in cli/Cargo.toml');
  process.exit(1);
}

const cargoVersion = cargoVersionMatch[1];

if (packageVersion !== cargoVersion) {
  console.error('Version mismatch detected!');
  console.error(`  package.json:    ${packageVersion}`);
  console.error(`  cli/Cargo.toml:  ${cargoVersion}`);
  console.error('');
  console.error("Run 'bun version:sync' to fix this.");
  process.exit(1);
}

console.log(`Versions are in sync: ${packageVersion}`);
