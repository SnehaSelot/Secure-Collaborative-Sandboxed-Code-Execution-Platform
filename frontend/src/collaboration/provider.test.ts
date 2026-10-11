import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import { getCollaborationSocketUrl, getFileRoomName, getCollaborationWsBaseUrl } from '../config/collaboration';
import { createProvider } from './provider';

// ---------------------------------------------------------------------------
// Mock y-websocket so tests never open real sockets
// ---------------------------------------------------------------------------

vi.mock('y-websocket', () => {
  // Use a class so `new WebsocketProvider(...)` works correctly in the test env.
  class MockWebsocketProvider {
    awareness = { clientID: 1, getStates: () => new Map(), setLocalStateField: vi.fn() };
    shouldConnect = true;
    private _listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_baseUrl: string, _roomName: string, _doc: unknown, _options?: unknown) {}

    on(event: string, cb: (...args: unknown[]) => void) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(cb);
    }

    off(event: string, cb: (...args: unknown[]) => void) {
      this._listeners[event] = (this._listeners[event] ?? []).filter((fn) => fn !== cb);
    }

    destroy() {}
  }

  return { WebsocketProvider: MockWebsocketProvider };
});

describe('collaboration provider abstraction', () => {
  it('reports local-only without claiming network connectivity or synchronization', () => {
    const provider = createProvider({
      roomName: getFileRoomName('file-id'),
      doc: new Y.Doc(),
      websocketBaseUrl: null,
    });

    expect(provider.getSnapshot()).toMatchObject({
      status: 'local-only',
      syncState: 'not-applicable',
      networkAvailable: false,
      awareness: null,
      error: null,
      message: 'Network collaboration is not configured.',
    });
    provider.destroy();
  });

  it('creates a real WebSocket provider when a valid WS base URL is supplied', () => {
    const provider = createProvider({
      roomName: getFileRoomName('file-id'),
      doc: new Y.Doc(),
      websocketBaseUrl: 'wss://collab.example/',
    });

    // With a valid URL, a real WS provider is created — starts in 'connecting'
    const snapshot = provider.getSnapshot();
    expect(snapshot.status).toBe('connecting');
    expect(snapshot.networkAvailable).toBe(true);
    expect(snapshot.awareness).not.toBeNull();
    expect(snapshot.error).toBeNull();
    provider.destroy();
  });

  it('uses stable room names and builds encoded collaboration URLs', () => {
    const roomName = getFileRoomName('file/id');

    expect(roomName).toBe('file/id');
    expect(getCollaborationSocketUrl(roomName, 'wss://collab.example/')).toBe(
      'wss://collab.example/collab/file%2Fid',
    );
  });

  it('adds a supplied token as a URL query parameter without encoding it into the room path', () => {
    const socketUrl = getCollaborationSocketUrl(
      'file-id',
      'wss://collab.example',
      'jwt.value+/=',
    );

    expect(socketUrl).toBe('wss://collab.example/collab/file-id?token=jwt.value%2B%2F%3D');
  });

  it('preserves base URL query parameters when adding an optional token', () => {
    expect(
      getCollaborationSocketUrl('file-id', 'wss://collab.example?tenant=glasshouse'),
    ).toBe('wss://collab.example/collab/file-id?tenant=glasshouse');
  });

  it('rejects non-WebSocket collaboration URLs', () => {
    expect(() => getCollaborationSocketUrl('room', 'https://collab.example')).toThrow(
      'The collaboration URL must use ws:// or wss://.',
    );
    expect(() => getCollaborationWsBaseUrl('https://collab.example')).toThrow(
      'The collaboration URL must use ws:// or wss://.',
    );
  });

  it('reports invalid WebSocket configuration without breaking local editing', () => {
    const provider = createProvider({
      roomName: getFileRoomName('file-id'),
      doc: new Y.Doc(),
      websocketBaseUrl: 'https://collab.example',
    });

    expect(provider.getSnapshot()).toMatchObject({
      status: 'error',
      syncState: 'error',
      networkAvailable: false,
      message: 'Collaboration configuration is invalid: The collaboration URL must use ws:// or wss://.',
    });
    provider.destroy();
  });

  it('cleans up subscriptions and supports repeated destruction', () => {
    const provider = createProvider({
      roomName: getFileRoomName('file-id'),
      doc: new Y.Doc(),
      websocketBaseUrl: null,
    });
    const listener = vi.fn();
    const unsubscribe = provider.subscribe(listener);

    unsubscribe();
    provider.destroy();
    provider.destroy();

    expect(listener).not.toHaveBeenCalled();
    expect(() => provider.subscribe(listener)).toThrow(
      'Cannot subscribe to a destroyed collaboration provider.',
    );
  });

  it('cleans up a real WebSocket provider on destroy', () => {
    const doc = new Y.Doc();
    const provider = createProvider({
      roomName: 'test-room',
      doc,
      websocketBaseUrl: 'wss://collab.example/',
    });

    // Should start connecting
    expect(provider.getSnapshot().status).toBe('connecting');

    const listener = vi.fn();
    provider.subscribe(listener);
    provider.destroy();

    // After destroy, subscribe should throw
    expect(() => provider.subscribe(vi.fn())).toThrow(
      'Cannot subscribe to a destroyed collaboration provider.',
    );
  });
});
