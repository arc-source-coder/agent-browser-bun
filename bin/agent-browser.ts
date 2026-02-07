#!/usr/bin/env bun

/**
 * Cross-platform CLI wrapper for agent-browser
 * This wrapper enables npx support on Windows where shell scripts don't work.
 */

import { join } from 'path';
import { accessSync, chmodSync, constants } from 'fs';

// Map Node.js platform/arch to binary naming convention
function getBinaryName() {
  const os = process.platform;
  const cpuArch = process.arch;

  let osKey;
  switch (os) {
    case 'darwin':
      osKey = 'darwin';
      break;
    case 'linux':
      osKey = 'linux';
      break;
    case 'win32':
      osKey = 'win32';
      break;
    default:
      return null;
  }

  let archKey;
  switch (cpuArch) {
    case 'x64':
      archKey = 'x64';
      break;
    case 'arm64':
      archKey = 'arm64';
      break;
    default:
      return null;
  }

  const ext = os === 'win32' ? '.exe' : '';
  return `agent-browser-${osKey}-${archKey}${ext}`;
}

async function main() {
  const binaryName = getBinaryName();
  const platform = process.platform;
  const arch = process.arch;

  if (!binaryName) {
    console.error(`Error: Unsupported platform: ${platform}-${arch}`);
    process.exit(1);
  }

  const binaryPath = join(import.meta.dir, binaryName);

  if (!(await Bun.file(binaryPath).exists())) {
    console.error(`Error: No binary found for ${platform}-${arch}`);
    console.error(`Expected: ${binaryPath}`);
    console.error('');
    console.error('Run "bun build:native" to build for your platform,');
    console.error('or reinstall the package to trigger the postinstall download.');
    process.exit(1);
  }

  try {
    // Ensure binary is executable (fixes EACCES on macOS/Linux when postinstall didn't run,
    // e.g., when using bun which blocks lifecycle scripts by default)
    if (process.platform !== 'win32') {
      try {
        accessSync(binaryPath, constants.X_OK);
      } catch {
        // Binary exists but isn't executable - fix it
        try {
          chmodSync(binaryPath, 0o755);
        } catch (chmodErr) {
          console.error(`Error: Cannot make binary executable: ${chmodErr.message}`);
          console.error('Try running: chmod +x ' + binaryPath);
          process.exit(1);
        }
      }
    }

    // Spawn the native binary with inherited stdio
    const child = Bun.spawn([binaryPath, ...process.argv.slice(2)], {
      stdio: ['inherit', 'inherit', 'inherit'],
      windowsHide: false,
    });

    const exitCode = await child.exited;
    process.exit(exitCode ?? 0);
  } catch (err) {
    console.error(`Error executing binary: ${err.message}`);
    process.exit(1);
  }
}

main();
