import * as Y from 'yjs';
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getParticipants } from './presence';

afterEach(() => {
  vi.useRealTimers();
});

describe('collaboration participants', () => {
  it('lists only identities actually present in awareness state', () => {
    vi.useFakeTimers();
    const localDoc = new Y.Doc();
    const remoteDoc = new Y.Doc();
    const localAwareness = new Awareness(localDoc);
    const remoteAwareness = new Awareness(remoteDoc);

    localAwareness.setLocalState({ user: { name: 'Riley' } });
    remoteAwareness.setLocalState({ user: { name: 'Riley' } });
    applyAwarenessUpdate(
      localAwareness,
      encodeAwarenessUpdate(remoteAwareness, [remoteDoc.clientID]),
      'test',
    );
    localAwareness.setLocalStateField('cursor', { line: 1 });
    localAwareness.getStates().set(9876, { cursor: { line: 2 } });

    const participants = getParticipants(localAwareness);
    expect(participants).toHaveLength(2);
    expect(participants.find(({ clientId }) => clientId === localDoc.clientID)).toMatchObject({
      displayName: expect.stringMatching(/^Riley(?: \(2\))?$/),
      color: expect.any(String),
      isLocal: true,
    });
    expect(participants.map(({ displayName }) => displayName)).toEqual(['Riley', 'Riley (2)']);
    expect(participants[0].color).not.toBe(participants[1].color);
    expect(participants.some(({ clientId }) => clientId === 9876)).toBe(false);

    clearInterval(localAwareness._checkInterval);
    clearInterval(remoteAwareness._checkInterval);
    localDoc.destroy();
    remoteDoc.destroy();
  });

  it('uses a readable fallback for missing names and omits states without user identity', () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awareness.setLocalState({ user: {} });
    awareness.getStates().set(9876, { user: { name: '   ' } });
    awareness.getStates().set(5432, { cursor: { line: 1 } });

    const participants = getParticipants(awareness);
    expect(participants).toHaveLength(2);
    expect(participants.find(({ clientId }) => clientId === doc.clientID)?.displayName).toBe(
      `Participant ${doc.clientID.toString(36)}`,
    );
    expect(participants.find(({ clientId }) => clientId === 9876)?.displayName).toBe(
      `Participant ${(9876).toString(36)}`,
    );
    expect(participants.some(({ clientId }) => clientId === 5432)).toBe(false);

    clearInterval(awareness._checkInterval);
    doc.destroy();
  });
});
