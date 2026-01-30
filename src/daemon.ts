import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { BrowserManager } from './browser.js';
import { parseCommand, serializeResponse, errorResponse } from './protocol.js';
import { executeCommand } from './actions.js';
import { StreamServer } from './stream-server.js';

// Platform detection
const isWindows = process.platform === 'win32';

// Session support - each session gets its own socket/pid
let currentSession = process.env.AGENT_BROWSER_SESSION || 'default';

// Stream server for browser preview
let streamServer: StreamServer | null = null;

// Track cleanup in progress to prevent concurrent cleanup calls
const cleaningUp = new Set<string>();

// Default stream port (can be overridden with AGENT_BROWSER_STREAM_PORT)
const DEFAULT_STREAM_PORT = 9223;

const MAX_BUFFER_SIZE = 1024 * 1024 * 4; // 4MB

/**
 * Set the current session
 */
export function setSession(session: string): void {
  currentSession = session;
}

/**
 * Get the current session
 */
export function getSession(): string {
  return currentSession;
}

/**
 * Get port number for TCP mode (Windows)
 * Uses a hash of the session name to get a consistent port
 */
function getPortForSession(session: string): number {
  let hash = 0;
  for (let i = 0; i < session.length; i++) {
    hash = (hash << 5) - hash + session.charCodeAt(i);
    hash |= 0;
  }
  // Port range 49152-65535 (dynamic/private ports)
  return 49152 + (Math.abs(hash) % 16383);
}

/**
 * Get the base directory for socket/pid files.
 * Priority: AGENT_BROWSER_SOCKET_DIR > XDG_RUNTIME_DIR > ~/.agent-browser > tmpdir
 */
export function getAppDir(): string {
  // 1. XDG_RUNTIME_DIR (Linux standard)
  if (process.env.XDG_RUNTIME_DIR) {
    return join(process.env.XDG_RUNTIME_DIR, 'agent-browser');
  }

  // 2. Home directory fallback (like Docker Desktop's ~/.docker/run/)
  const homeDir = homedir();
  if (homeDir) {
    return join(homeDir, '.agent-browser');
  }

  // 3. Last resort: temp dir
  return join(tmpdir(), 'agent-browser');
}

export function getSocketDir(): string {
  // Allow explicit override for socket directory
  if (process.env.AGENT_BROWSER_SOCKET_DIR) {
    return process.env.AGENT_BROWSER_SOCKET_DIR;
  }
  return getAppDir();
}

/**
 * Get the socket address for the current session (Unix) or port (Windows)
 */
export function getSocketAddress(session?: string): string {
  const sess = session ?? currentSession;
  if (isWindows) {
    return String(getPortForSession(sess));
  }
  return join(getSocketDir(), `${sess}.sock`);
}

/**
 * Get the port file path for Windows (stores the port number)
 */
export function getPortFile(session?: string): string {
  const sess = session ?? currentSession;
  return join(getSocketDir(), `${sess}.port`);
}

/**
 * Get the PID file path for the current session
 */
export function getPidFile(session?: string): string {
  const sess = session ?? currentSession;
  return join(getSocketDir(), `${sess}.pid`);
}

/**
 * Check if daemon is running for the current session
 */
export async function isDaemonRunning(session?: string): Promise<boolean> {
  const pidFile = Bun.file(getPidFile(session));
  if (!(await pidFile.exists())) return false;

  try {
    const pid = parseInt((await pidFile.text()).trim(), 10);
    // Check if process exists (works on both Unix and Windows)
    process.kill(pid, 0);
    return true;
  } catch {
    // Process doesn't exist, clean up stale files
    await cleanupSocket(session);
    return false;
  }
}

/**
 * Get connection info for the current session
 * Returns { type: 'unix', path: string } or { type: 'tcp', port: number }
 */
export function getConnectionInfo(
  session?: string
): { type: 'unix'; path: string } | { type: 'tcp'; port: number } {
  const sess = session ?? currentSession;
  if (isWindows) {
    return { type: 'tcp', port: getPortForSession(sess) };
  }
  return { type: 'unix', path: join(getSocketDir(), `${sess}.sock`) };
}

/**
 * Clean up socket and PID file for the current session
 */
export async function cleanupSocket(session?: string): Promise<void> {
  const sess = session ?? currentSession;

  // Prevent concurrent cleanup for same session
  if (cleaningUp.has(sess)) return;
  cleaningUp.add(sess);

  try {
    const pidFile = Bun.file(getPidFile(session));
    const streamPortFile = Bun.file(getStreamPortFile(session));
    if (await pidFile.exists()) await pidFile.delete();
    if (await streamPortFile.exists()) await streamPortFile.delete();
    if (isWindows) {
      const portFile = Bun.file(getPortFile(session));
      if (await portFile.exists()) await portFile.delete();
    } else {
      const socketFile = Bun.file(getSocketAddress(session));
      if (await socketFile.exists()) await socketFile.delete();
    }
  } catch {
    // Ignore cleanup errors
  } finally {
    cleaningUp.delete(sess);
  }
}

/**
 * Get the stream port file path
 */
export function getStreamPortFile(session?: string): string {
  const sess = session ?? currentSession;
  return join(getSocketDir(), `${sess}.stream`);
}

type SocketData = {
  chunks: string[];
  httpChecked: boolean;
};

/**
 * Start the daemon server
 * @param options.streamPort Port for WebSocket stream server (0 to disable)
 */
export async function startDaemon(options?: { streamPort?: number }): Promise<void> {
  // Ensure socket directory exists
  const socketDir = getSocketDir();
  mkdirSync(socketDir, { recursive: true });

  // Clean up any stale socket
  await cleanupSocket();

  const browser = new BrowserManager();
  let shuttingDown = false;

  // Start stream server if port is specified (or use default if env var is set)
  const streamPort =
    options?.streamPort ??
    (process.env.AGENT_BROWSER_STREAM_PORT
      ? parseInt(process.env.AGENT_BROWSER_STREAM_PORT, 10)
      : 0);

  if (streamPort > 0) {
    streamServer = new StreamServer(browser, streamPort);
    await streamServer.start();

    // Write stream port to file for clients to discover
    const streamPortFile = getStreamPortFile();
    await Bun.write(streamPortFile, streamPort.toString());
  }

  const pidFile = getPidFile();

  // Write PID file before listening
  await Bun.write(pidFile, process.pid.toString());

  const listenOptions: any = isWindows
    ? { hostname: '127.0.0.1', port: getPortForSession(currentSession) }
    : { unix: getSocketAddress() };

  if (isWindows) {
    await Bun.write(getPortFile(), listenOptions.port.toString());
  }

  // Set Unix socket permissions to 0600
  const oldUmask = isWindows ? null : process.umask(0o077);

  try {
    const server = Bun.listen<SocketData>({
      ...listenOptions,
      socket: {
        open(socket) {
          socket.data = { chunks: [], httpChecked: false };
        },
        async data(socket, data) {
          let socketData = socket.data;
          const chunk = data.toString();

          // Prevent unbounded buffer growth
          const currentSize = socketData.chunks.reduce((sum, c) => sum + c.length, 0);
          if (currentSize + chunk.length > MAX_BUFFER_SIZE) {
            socket.terminate();
            return;
          }

          socketData.chunks.push(chunk);

          // Process complete lines
          let buffer = socketData.chunks.join('');

          // Security: Detect and reject HTTP requests to prevent cross-origin attacks.
          // Browsers using fetch() must send HTTP headers (e.g., "POST / HTTP/1.1"),
          // while legitimate clients send raw JSON starting with "{".
          if (!socketData.httpChecked) {
            socketData.httpChecked = true;
            // Check buffer for HTTP method signatures
            const trimmed = buffer.trimStart();
            if (/^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|CONNECT|TRACE)\s/i.test(trimmed)) {
              socket.terminate();
              return;
            }
          }

          while (buffer.includes('\n')) {
            const newlineIdx = buffer.indexOf('\n');
            const line = buffer.substring(0, newlineIdx);
            buffer = buffer.substring(newlineIdx + 1);

            if (!line.trim()) continue;

            try {
              const parseResult = parseCommand(line);

              if (!parseResult.success) {
                const resp = errorResponse(parseResult.id ?? 'unknown', parseResult.error);
                socket.write(serializeResponse(resp) + '\n');
                continue;
              }

              // Auto-launch browser if not already launched and this isn't a launch command
              if (
                !browser.isLaunched() &&
                parseResult.command.action !== 'launch' &&
                parseResult.command.action !== 'close'
              ) {
                const extensions = process.env.AGENT_BROWSER_EXTENSIONS
                  ? process.env.AGENT_BROWSER_EXTENSIONS.split(',')
                      .map((p) => p.trim())
                      .filter(Boolean)
                  : undefined;

                // Parse args from env (comma or newline separated)
                const argsEnv = process.env.AGENT_BROWSER_ARGS;
                const args = argsEnv
                  ? argsEnv
                      .split(/[,\n]/)
                      .map((a) => a.trim())
                      .filter((a) => a.length > 0)
                  : undefined;

                // Parse proxy from env
                const proxyServer = process.env.AGENT_BROWSER_PROXY;
                const proxyBypass = process.env.AGENT_BROWSER_PROXY_BYPASS;
                const proxy = proxyServer
                  ? {
                      server: proxyServer,
                      ...(proxyBypass && { bypass: proxyBypass }),
                    }
                  : undefined;

                const ignoreHTTPSErrors = process.env.AGENT_BROWSER_IGNORE_HTTPS_ERRORS === '1';
                await browser.launch({
                  id: 'auto',
                  action: 'launch' as const,
                  headless: process.env.AGENT_BROWSER_HEADED !== '1',
                  executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH,
                  extensions: extensions,
                  profile: process.env.AGENT_BROWSER_PROFILE,
                  storageState: process.env.AGENT_BROWSER_STATE,
                  args,
                  userAgent: process.env.AGENT_BROWSER_USER_AGENT,
                  proxy,
                  ignoreHTTPSErrors: ignoreHTTPSErrors,
                });
              }

              // Handle close command specially
              if (parseResult.command.action === 'close') {
                const response = await executeCommand(parseResult.command, browser);
                socket.write(serializeResponse(response) + '\n');

                if (!shuttingDown) {
                  shuttingDown = true;
                  setTimeout(async () => {
                    server.stop(true);
                    await cleanupSocket().finally(() => process.exit(0));
                  }, 100);
                }
                return;
              }

              const response = await executeCommand(parseResult.command, browser);
              socket.write(serializeResponse(response) + '\n');
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              socket.write(serializeResponse(errorResponse('error', message)) + '\n');
            }
          }
          // Save remaining partial line back to chunks
          socketData.chunks = buffer ? [buffer] : [];
        },
        drain() {
          // ignore
        },
        close() {
          // Ignore
        },
        error() {
          // Client disconnected, ignore
        },
      },
    });

    // Handle shutdown signals
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;

      // Stop stream server if running
      if (streamServer) {
        await streamServer.stop();
        streamServer = null;
        // Clean up stream port file
        const streamPortFile = Bun.file(getStreamPortFile());
        try {
          if (await streamPortFile.exists()) await streamPortFile.delete();
        } catch {
          // Ignore cleanup errors
        }
      }

      await browser.close();
      server.stop(true);
      await cleanupSocket().finally(() => process.exit(0));
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGHUP', shutdown);

    // Handle unexpected errors - always cleanup
    process.on('uncaughtException', async (err) => {
      console.error('Uncaught exception:', err);
      await cleanupSocket().finally(() => process.exit(1));
    });

    process.on('unhandledRejection', async (reason) => {
      console.error('Unhandled rejection:', reason);
      await cleanupSocket().finally(() => process.exit(1));
    });

    // Cleanup on normal exit
    process.on('beforeExit', async () => {
      await cleanupSocket();
    });

    // Keep process alive
    process.stdin.resume();
  } catch (err) {
    console.error('Server error:', err);
    await cleanupSocket().finally(() => process.exit(1));
  } finally {
    if (oldUmask !== null) {
      process.umask(oldUmask);
    }
  }
}

// Run daemon if this is the entry point
if (import.meta.main || process.env.AGENT_BROWSER_DAEMON === '1') {
  startDaemon().catch(async (err) => {
    console.error('Daemon error:', err);
    await cleanupSocket().finally(() => process.exit(1));
  });
}
