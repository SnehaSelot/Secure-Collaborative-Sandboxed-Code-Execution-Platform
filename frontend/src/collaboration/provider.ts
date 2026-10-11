/**
 * collaboration/provider.ts — Real Yjs WebSocket collaboration provider.
 *
 * F2: Replaces the StaticProvider stub with a real WebsocketProvider from
 * y-websocket. Connects clients to the correct WebSocket endpoint and room,
 * exposes connection status and awareness, and handles initialization,
 * reconnection, and cleanup correctly.
 */

import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { getCollaborationWsBaseUrl } from '../config/collaboration';
import { env } from '../config/env';

export type ProviderStatus =
  | 'local-only'
  | 'connecting'
  | 'connected'
  | 'offline'
  | 'syncing'
  | 'error';

export type ProviderSyncState = 'not-applicable' | 'syncing' | 'synced' | 'offline' | 'error';

export interface ProviderSnapshot {
  status: ProviderStatus;
  syncState: ProviderSyncState;
  networkAvailable: boolean;
  message: string;
  error: Error | null;
  awareness: Awareness | null;
}

export interface CollaborationProvider {
  readonly roomName: string;
  getSnapshot(): ProviderSnapshot;
  subscribe(listener: (snapshot: ProviderSnapshot) => void): () => void;
  destroy(): void;
}

export interface ProviderOptions {
  roomName: string;
  doc: Y.Doc;
  token?: string;
  websocketBaseUrl?: string | null;
}

// ---------------------------------------------------------------------------
// StaticProvider — local-only fallback (no network, no awareness)
// ---------------------------------------------------------------------------

class StaticProvider implements CollaborationProvider {
  private readonly listeners = new Set<(snapshot: ProviderSnapshot) => void>();
  private destroyed = false;
  readonly roomName: string;
  private readonly snapshot: ProviderSnapshot;

  constructor(roomName: string, snapshot: ProviderSnapshot) {
    this.roomName = roomName;
    this.snapshot = snapshot;
  }

  getSnapshot(): ProviderSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: ProviderSnapshot) => void): () => void {
    if (this.destroyed) {
      throw new Error('Cannot subscribe to a destroyed collaboration provider.');
    }

    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.clear();
  }
}

// ---------------------------------------------------------------------------
// F2: WebSocketCollabProvider — real live collaboration via y-websocket
// ---------------------------------------------------------------------------

/**
 * Wraps y-websocket's WebsocketProvider and translates its events into the
 * CollaborationProvider interface consumed by CodeEditor and EditorPage.
 *
 * The room_id passed to WebsocketProvider is "{sessionId}:{fileId}" matching
 * the backend route /ws/collab/{room_id}. y-websocket appends "/{roomName}"
 * to the base URL automatically:
 *   baseUrl = "ws://localhost:8000/ws/collab"
 *   room    = "{sessionId}:{fileId}"
 *   result  = "ws://localhost:8000/ws/collab/{sessionId}:{fileId}"
 *
 * The JWT token is passed via params so it appears as ?token=... in the WS URL.
 * It is NEVER logged.
 */
class WebSocketCollabProvider implements CollaborationProvider {
  private readonly listeners = new Set<(snapshot: ProviderSnapshot) => void>();
  private destroyed = false;
  private snapshot: ProviderSnapshot;
  private readonly wsProvider: WebsocketProvider;
  readonly roomName: string;

  constructor(options: ProviderOptions, baseUrl: string) {
    this.roomName = options.roomName;

    // Build params — token is included only if provided (never log it)
    const params: Record<string, string> = {};
    if (options.token) {
      params.token = options.token;
    }

    // y-websocket's WebsocketProvider connects immediately.
    this.wsProvider = new WebsocketProvider(
      baseUrl,
      options.roomName,
      options.doc,
      {
        params,
        // Reconnect automatically on disconnect
        connect: true,
        // Disable cross-tab awareness sync (not needed here, can cause issues)
        disableBc: true,
      },
    );

    // Initial snapshot: connecting
    this.snapshot = {
      status: 'connecting',
      syncState: 'syncing',
      networkAvailable: true,
      message: 'Connecting to collaboration server…',
      error: null,
      awareness: this.wsProvider.awareness,
    };

    // F7: Hook into y-websocket status events
    this.wsProvider.on('status', this._onStatus);
    this.wsProvider.on('sync', this._onSync);
    this.wsProvider.on('connection-error', this._onConnectionError);
    this.wsProvider.on('connection-close', this._onConnectionClose);
  }

  private _onStatus = (event: { status: string }) => {
    if (this.destroyed) return;
    if (event.status === 'connected') {
      this._updateSnapshot({
        status: 'syncing',
        syncState: 'syncing',
        networkAvailable: true,
        message: 'Connected — syncing document…',
        error: null,
        awareness: this.wsProvider.awareness,
      });
    } else if (event.status === 'disconnected') {
      this._updateSnapshot({
        status: this.wsProvider.shouldConnect ? 'offline' : 'offline',
        syncState: 'offline',
        networkAvailable: navigator.onLine,
        message: 'Disconnected from collaboration server.',
        error: null,
        awareness: this.wsProvider.awareness,
      });
    }
  };

  private _onSync = (isSynced: boolean) => {
    if (this.destroyed) return;
    if (isSynced) {
      this._updateSnapshot({
        status: 'connected',
        syncState: 'synced',
        networkAvailable: true,
        message: 'Connected and synchronized.',
        error: null,
        awareness: this.wsProvider.awareness,
      });
    } else {
      this._updateSnapshot({
        ...this.snapshot,
        status: 'syncing',
        syncState: 'syncing',
        message: 'Syncing document with collaborators…',
      });
    }
  };

  private _onConnectionError = (event: Event) => {
    if (this.destroyed) return;
    // F7: Detect auth rejections and other errors
    const errorEvent = event as ErrorEvent | CloseEvent;
    let message = 'Connection error.';

    if ('code' in errorEvent) {
      // WebSocket CloseEvent with code
      const closeCode = (errorEvent as CloseEvent).code;
      const reason = (errorEvent as CloseEvent).reason || '';
      if (closeCode === 4401) {
        message = 'Authentication failed. Your session may have expired.';
        this.wsProvider.disconnect();
      } else if (closeCode === 4403) {
        message = 'Access denied. You are not a member of this session.';
        this.wsProvider.disconnect();
      } else if (closeCode === 4404) {
        message = `Not found: ${reason || 'Session or file does not exist.'}`;
        this.wsProvider.disconnect();
      } else if (closeCode === 4409) {
        message = 'Session is closed.';
        this.wsProvider.disconnect();
      } else if (closeCode === 4429) {
        message = 'This collaboration room is full.';
      } else if (closeCode === 4003) {
        message = 'Connection rejected: origin not allowed.';
      } else {
        message = `Connection closed (code ${closeCode}${reason ? ': ' + reason : ''}).`;
      }
    }

    this._updateSnapshot({
      status: 'error',
      syncState: 'error',
      networkAvailable: navigator.onLine,
      message,
      error: new Error(message),
      awareness: this.wsProvider.awareness,
    });
  };

  private _onConnectionClose = (event: CloseEvent | null) => {
    if (this.destroyed) return;
    if (!event) return; // null event = provider destroyed cleanly
    // 1000 = normal closure; anything else is unexpected
    if (event.code !== 1000 && this.snapshot.status !== 'error') {
      const wasClean = event.wasClean;
      if (!wasClean || event.code >= 4000) {

        // Application-level close — treat as error
        this._onConnectionError(event);
        return;
      }
      // Network-level drop — will auto-reconnect
      this._updateSnapshot({
        ...this.snapshot,
        status: 'offline',
        syncState: 'offline',
        networkAvailable: navigator.onLine,
        message: 'Disconnected — reconnecting…',
        error: null,
      });
    }
  };

  private _updateSnapshot(snapshot: ProviderSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // ignore listener errors
      }
    }
  }

  getSnapshot(): ProviderSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: ProviderSnapshot) => void): () => void {
    if (this.destroyed) {
      throw new Error('Cannot subscribe to a destroyed collaboration provider.');
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    // F2: Clean up y-websocket provider — disconnects WS and removes all listeners
    this.wsProvider.off('status', this._onStatus);
    this.wsProvider.off('sync', this._onSync);
    this.wsProvider.off('connection-error', this._onConnectionError);
    this.wsProvider.off('connection-close', this._onConnectionClose);
    this.wsProvider.destroy();

    this.listeners.clear();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the appropriate collaboration provider:
 * - If a valid WebSocket base URL is available: real WebSocketCollabProvider
 * - If URL is null (no config): StaticProvider with 'local-only' status
 * - If URL is invalid: StaticProvider with 'error' status
 *
 * The provider is initialized with the configured base URL from env (F1),
 * which defaults to ws://localhost:8000/ws/collab without requiring .env changes.
 */
export function createProvider(options: ProviderOptions): CollaborationProvider {
  const rawBaseUrl = options.websocketBaseUrl !== undefined
    ? options.websocketBaseUrl
    : env.collaborationWsBaseUrl;

  try {
    const baseUrl = getCollaborationWsBaseUrl(rawBaseUrl);

    if (!baseUrl) {
      // No WS URL configured — local-only mode
      return new StaticProvider(options.roomName, {
        status: 'local-only',
        syncState: 'not-applicable',
        networkAvailable: false,
        message: 'Network collaboration is not configured.',
        error: null,
        awareness: null,
      });
    }

    // F2: Real WebSocket provider
    return new WebSocketCollabProvider(options, baseUrl);
  } catch (error) {
    const configurationError =
      error instanceof Error ? error : new Error(String(error));

    // F7: Detected invalid configuration — tell user clearly
    return new StaticProvider(options.roomName, {
      status: 'error',
      syncState: 'error',
      networkAvailable: false,
      message: `Collaboration configuration is invalid: ${configurationError.message}`,
      error: configurationError,
      awareness: null,
    });
  }
}
