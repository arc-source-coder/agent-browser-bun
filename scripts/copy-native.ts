#!/usr/bin/env bun

/**
 * Copies the compiled Rust binary to bin/ with platform-specific naming
 */

import { join } from 'node:path';

const projectRoot = join(import.meta.dir, '..');

const sourceExt = process.platform === 'win32' ? '.exe' : '';
const sourcePath = join(projectRoot, `cli/target/release/agent-browser${sourceExt}`);
const sourceFile = Bun.file(sourcePath);
const binDir = join(projectRoot, 'bin');

// Determine platform suffix
const platformKey = `${process.platform}-${process.arch}`;
const ext = process.platform === 'win32' ? '.exe' : '';
const targetName = `agent-browser-${platformKey}${ext}`;
const targetPath = join(binDir, targetName);

if (!(await sourceFile.exists())) {
  console.error(`Error: Native binary not found at ${sourcePath}`);
  console.error('Run "cargo build --release --manifest-path cli/Cargo.toml" first');
  process.exit(1);
}

await Bun.write(targetPath, sourceFile);
console.log(`✓ Copied native binary to ${targetPath}`);
