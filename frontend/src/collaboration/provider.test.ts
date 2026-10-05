import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import { getCollaborationSocketUrl, getFileRoomName } from '../config/collaboration';
import { createProvider } from './provider';

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

  it('keeps a configured WebSocket URL available without connecting', () => {
    const provider = createProvider({
      roomName: getFileRoomName('file-id'),
      doc: new Y.Doc(),
      websocketBaseUrl: 'wss://collab.example/',
    });

    expect(provider.getSnapshot()).toMatchObject({
      status: 'local-only',
      networkAvailable: false,
      message: 'Network collaboration is configured but not available in this local-only provider.',
    });
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
});
