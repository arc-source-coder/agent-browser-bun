import type { Server, ServerWebSocket } from 'bun';
import type { BrowserManager, ScreencastFrame } from './browser.js';
import { setScreencastFrameCallback } from './actions.js';

// Message types for WebSocket communication
export interface FrameMessage {
  type: 'frame';
  data: string; // base64 encoded image
  metadata: {
    offsetTop: number;
    pageScaleFactor: number;
    deviceWidth: number;
    deviceHeight: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
    timestamp?: number;
  };
}

export interface InputMouseMessage {
  type: 'input_mouse';
  eventType: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
  x: number;
  y: number;
  button?: 'left' | 'right' | 'middle' | 'none';
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: number;
}

export interface InputKeyboardMessage {
  type: 'input_keyboard';
  eventType: 'keyDown' | 'keyUp' | 'char';
  key?: string;
  code?: string;
  text?: string;
  modifiers?: number;
}

export interface InputTouchMessage {
  type: 'input_touch';
  eventType: 'touchStart' | 'touchEnd' | 'touchMove' | 'touchCancel';
  touchPoints: Array<{ x: number; y: number; id?: number }>;
  modifiers?: number;
}

export interface StatusMessage {
  type: 'status';
  connected: boolean;
  screencasting: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type StreamMessage =
  | FrameMessage
  | InputMouseMessage
  | InputKeyboardMessage
  | InputTouchMessage
  | StatusMessage
  | ErrorMessage;

/**
 * WebSocket server for streaming browser viewport and receiving input
 */
export class StreamServer {
  private server: Server<any> | null = null;
  private browser: BrowserManager;
  private port: number;
  private isScreencasting: boolean = false;
  private clientCount: number = 0;

  constructor(browser: BrowserManager, port: number = 9223) {
    this.browser = browser;
    this.port = port;
  }

  /**
   * Start the WebSocket server
   */
  async start(): Promise<void> {
    try {
      this.server = Bun.serve({
        port: this.port,
        fetch: (req, server) => {
          // Security: Reject cross-origin WebSocket connections from browsers.
          // This prevents malicious web pages from connecting and injecting input events.
          const origin = req.headers.get('origin');

          // Allow connections with no origin (non-browser clients like CLI tools)
          // Reject connections from web pages (which always have an origin)
          if (origin && !origin.startsWith('file://')) {
            console.log(`[StreamServer] Rejected connection from origin: ${origin}`);
            return new Response('Forbidden', { status: 403 });
          }

          if (server.upgrade(req)) return;
          return new Response('Upgrade failed', { status: 400 });
        },
        websocket: {
          open: (ws: ServerWebSocket) => {
            this.handleOpen(ws);
          },
          message: (ws: ServerWebSocket, data) => {
            this.handleMessage(ws, data);
          },
          close: (ws: ServerWebSocket, code, reason) => {
            if (code !== 1000) {
              let r = reason ? `due to ${reason}` : '';
              console.log(`[StreamServer] WebSocket exited with code ${code}${r}`);
            }

            this.handleClose(ws);
          },
        },
      });
      console.log(`[StreamServer] Listening on port ${this.port}`);

      // Set up the screencast frame callback
      setScreencastFrameCallback((frame) => {
        this.broadcastFrame(frame);
      });
    } catch (error) {
      console.error('[StreamServer] WebSocket error:', error);
      throw error;
    }
  }

  /**
   * Stop the WebSocket server
   */
  async stop(): Promise<void> {
    // Stop screencasting
    if (this.isScreencasting) {
      await this.stopScreencast();
    }

    // Clear the callback
    setScreencastFrameCallback(null);

    // Close the server
    if (this.server) {
      this.clientCount = 0;
      await this.server.stop(true).finally(() => (this.server = null));
    }
  }

  /**
   * Handle a new WebSocket connection
   */
  private handleOpen(ws: ServerWebSocket): void {
    console.log('[StreamServer] Client connected');
    this.clientCount++;

    // Subscribe the client to the screencast topic
    ws.subscribe('screencast');
    ws.subscribe('status');

    // Send initial status
    this.sendStatus(ws);

    // Start screencasting if this is the first client
    if (this.clientCount === 1 && !this.isScreencasting) {
      this.startScreencast().catch((error) => {
        console.error('[StreamServer] Failed to start screencast:', error);
        this.sendError(ws, error.message);
      });
    }
  }

  /**
   * Handle client disconnection
   */
  private handleClose(ws: ServerWebSocket) {
    console.log('[StreamServer] Client disconnected');

    ws.unsubscribe('screencast');
    ws.unsubscribe('status');
    this.clientCount--;

    // Stop screencasting if no more clients
    if (this.clientCount === 0 && this.isScreencasting) {
      this.stopScreencast().catch((error) => {
        console.error('[StreamServer] Failed to stop screencast:', error);
      });
    }
  }

  /**
   * Handle incoming messages from clients
   */
  private async handleMessage(ws: ServerWebSocket, data: string | Buffer): Promise<void> {
    try {
      const message = JSON.parse(data.toString()) as StreamMessage;
      switch (message.type) {
        case 'input_mouse':
          await this.browser.injectMouseEvent({
            type: message.eventType,
            x: message.x,
            y: message.y,
            button: message.button,
            clickCount: message.clickCount,
            deltaX: message.deltaX,
            deltaY: message.deltaY,
            modifiers: message.modifiers,
          });
          break;

        case 'input_keyboard':
          await this.browser.injectKeyboardEvent({
            type: message.eventType,
            key: message.key,
            code: message.code,
            text: message.text,
            modifiers: message.modifiers,
          });
          break;

        case 'input_touch':
          await this.browser.injectTouchEvent({
            type: message.eventType,
            touchPoints: message.touchPoints,
            modifiers: message.modifiers,
          });
          break;

        case 'status':
          // Client is requesting status
          this.sendStatus(ws);
          break;
      }
    } catch (error) {
      console.error('[StreamServer] Failed to parse message:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.sendError(ws, errorMessage);
    }
  }

  /**
   * Broadcast a frame to all connected clients
   */
  private broadcastFrame(frame: ScreencastFrame): void {
    if (!this.server) return;

    const message: FrameMessage = {
      type: 'frame',
      data: frame.data,
      metadata: frame.metadata,
    };

    this.server.publish('screencast', JSON.stringify(message));
  }

  /**
   * Broadcast status to all connected clients
   */
  private broadcastStatus(): void {
    if (!this.server) return;
    const message = this.statusMessage();
    if (message !== null) this.server.publish('status', JSON.stringify(message));
  }

  /**
   * Send status to a client
   */
  private sendStatus(ws: ServerWebSocket): void {
    const message = this.statusMessage();
    if (message !== null) ws.send(JSON.stringify(message));
  }

  private statusMessage(): StatusMessage | null {
    try {
      const page = this.browser.getPage();
      const viewport = page.viewportSize();
      const viewportWidth = viewport?.width;
      const viewportHeight = viewport?.height;

      const message: StatusMessage = {
        type: 'status',
        connected: true,
        screencasting: this.isScreencasting,
        viewportWidth,
        viewportHeight,
      };
      return message;
    } catch {
      // Browser not launched yet
      return null;
    }
  }

  /**
   * Send an error to a client
   */
  private sendError(ws: ServerWebSocket, errorMessage: string): void {
    ws.send(JSON.stringify({ type: 'error', message: errorMessage }));
  }

  /**
   * Start screencasting
   */
  private async startScreencast(): Promise<void> {
    // Set flag immediately to prevent race conditions with concurrent calls
    if (this.isScreencasting) return;
    this.isScreencasting = true;

    try {
      // Check if browser is launched
      if (!this.browser.isLaunched()) {
        throw new Error('Browser not launched');
      }

      await this.browser.startScreencast((frame) => this.broadcastFrame(frame), {
        format: 'jpeg',
        quality: 80,
        maxWidth: 1280,
        maxHeight: 720,
        everyNthFrame: 1,
      });

      this.broadcastStatus();
    } catch (error) {
      // Reset flag on failure so caller can retry
      this.isScreencasting = false;
      throw error;
    }
  }

  /**
   * Stop screencasting
   */
  private async stopScreencast(): Promise<void> {
    if (!this.isScreencasting) return;

    await this.browser.stopScreencast();
    this.isScreencasting = false;

    this.broadcastStatus();
  }

  /**
   * Get the port the server is running on
   */
  getPort(): number {
    return this.port;
  }
}
