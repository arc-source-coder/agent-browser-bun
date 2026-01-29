#!/usr/bin/env bun

/**
 * Postinstall script for agent-browser
 * Downloads the platform-specific native binary if not present.
 */

import { chmodSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dir, '..');
const binDir = join(projectRoot, 'bin');

// Platform detection
const platformKey = `${process.platform}-${process.arch}`;
const ext = process.platform === 'win32' ? '.exe' : '';
const binaryName = `agent-browser-${platformKey}${ext}`;
const binaryPath = join(binDir, binaryName);

// Package info
const packageJson = await Bun.file(join(projectRoot, 'package.json')).json();
const version = packageJson.version;

// GitHub release URL
const GITHUB_REPO = 'vercel-labs/agent-browser';
const DOWNLOAD_URL = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${binaryName}`;

async function downloadFile(url: string, dest: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download: HTTP ${response.status}`);

    await Bun.write(dest, response);
  } catch (err) {
    // Clean up the partial file if it exists
    await Bun.file(dest)
      .delete()
      .catch(() => {});
    throw err;
  }
}

async function main() {
  // Check if binary already exists
  if (await Bun.file(binaryPath).exists()) {
    // Ensure binary is executable (npm doesn't preserve execute bit)
    if (process.platform !== 'win32') {
      chmodSync(binaryPath, 0o755);
    }
    console.log(`✓ Native binary ready: ${binaryName}`);

    showPlaywrightReminder();
    return;
  }

  console.log(`Downloading native binary for ${platformKey}...`);
  console.log(`URL: ${DOWNLOAD_URL}`);

  try {
    await downloadFile(DOWNLOAD_URL, binaryPath);

    // Make executable on Unix
    if (process.platform !== 'win32') {
      chmodSync(binaryPath, 0o755);
    }

    console.log(`✓ Downloaded native binary: ${binaryName}`);
  } catch (err) {
    console.log(`⚠ Could not download native binary: ${err.message}`);
    console.log(`  The CLI will use Node.js fallback (slightly slower startup)`);
    console.log('');
    console.log('To build the native binary locally:');
    console.log('  1. Install Rust: https://rustup.rs');
    console.log('  2. Run: npm run build:native');
  }

  showPlaywrightReminder();
}

function showPlaywrightReminder() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════════════════╗');
  console.log('║ To download browser binaries, run:                                        ║');
  console.log('║                                                                           ║');
  console.log('║     npx playwright install chromium                                       ║');
  console.log('║                                                                           ║');
  console.log('║ On Linux, include system dependencies with:                               ║');
  console.log('║                                                                           ║');
  console.log('║     npx playwright install --with-deps chromium                           ║');
  console.log('║                                                                           ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════════╝');
}

main().catch(console.error);
