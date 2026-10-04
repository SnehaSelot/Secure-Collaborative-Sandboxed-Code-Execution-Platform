import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { getCollaborationSocketUrl } from '../config/collaboration';

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

export function createProvider(options: ProviderOptions): CollaborationProvider {
  try {
    const socketUrl = getCollaborationSocketUrl(
      options.roomName,
      options.websocketBaseUrl,
      options.token,
    );
    return new StaticProvider(options.roomName, {
      status: 'local-only',
      syncState: 'not-applicable',
      networkAvailable: false,
      message: socketUrl
        ? 'Network collaboration is configured but not available in this local-only provider.'
        : 'Network collaboration is not configured.',
      error: null,
      awareness: null,
    });
  } catch (error) {
    const configurationError =
      error instanceof Error ? error : new Error(String(error));
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
