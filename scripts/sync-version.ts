#!/usr/bin/env bun

/**
 * Syncs the version from package.json to all other config files.
 * Run this script before building or releasing.
 */

import { join } from 'node:path';

const rootDir = join(import.meta.dir, '..');
const cliDir = join(rootDir, 'cli');

// Read version from package.json (single source of truth)
const packageJson = await Bun.file(join(rootDir, 'package.json')).json();
const version = packageJson.version;

console.log(`Syncing version ${version} to all config files...`);

// Update Cargo.toml
const cargoTomlPath = join(cliDir, 'Cargo.toml');
let cargoToml = await Bun.file(cargoTomlPath).text();
const cargoVersionRegex = /^version\s*=\s*"[^"]*"/m;
const newCargoVersion = `version = "${version}"`;

let cargoTomlUpdated = false;
if (cargoVersionRegex.test(cargoToml)) {
  const oldMatch = cargoToml.match(cargoVersionRegex)?.[0];
  if (oldMatch !== newCargoVersion) {
    cargoToml = cargoToml.replace(cargoVersionRegex, newCargoVersion);
    await Bun.write(cargoTomlPath, cargoToml);
    console.log(`  Updated cli/Cargo.toml: ${oldMatch} -> ${newCargoVersion}`);
    cargoTomlUpdated = true;
  } else {
    console.log(`  cli/Cargo.toml already up to date`);
  }
} else {
  console.error('  Could not find version field in cli/Cargo.toml');
  process.exit(1);
}

// Update Cargo.lock to match Cargo.toml
if (cargoTomlUpdated) {
  try {
    Bun.spawnSync(['cargo', 'update', '-p', 'agent-browser', '--offline'], {
      cwd: cliDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`  Updated cli/Cargo.lock`);
  } catch {
    // --offline may fail if package not in cache, try without it
    try {
      Bun.spawnSync(['cargo', 'update', '-p', 'agent-browser'], {
        cwd: cliDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      console.log(`  Updated cli/Cargo.lock`);
    } catch (e) {
      console.error(`  Warning: Could not update Cargo.lock: ${e.message}`);
    }
  }
}

console.log('Version sync complete.');
