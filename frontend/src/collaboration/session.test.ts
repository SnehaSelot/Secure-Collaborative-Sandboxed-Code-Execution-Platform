import { describe, expect, it } from 'vitest';
import { createRoomPreview, isValidRoomId } from './session';

describe('collaboration room preview', () => {
  it('creates a preview link based on a stable file UUID without claiming a joined room', () => {
    const room = createRoomPreview('123e4567-e89b-42d3-a456-426614174000', 'https://glasshouse.test');

    expect(room).toEqual({
      roomId: '123e4567-e89b-42d3-a456-426614174000',
      roomName: '123e4567-e89b-42d3-a456-426614174000',
      shareUrl: 'https://glasshouse.test/collaboration/123e4567-e89b-42d3-a456-426614174000',
      availability: 'ui-only',
      joined: false,
    });
  });

  it('accepts UUID room IDs and rejects missing or malformed IDs', () => {
    expect(isValidRoomId('123e4567-e89b-42d3-a456-426614174000')).toBe(true);
    expect(isValidRoomId('')).toBe(false);
    expect(isValidRoomId('room one')).toBe(false);
    expect(isValidRoomId('123e4567-e89b-42d3-a456')).toBe(false);
  });

  it('refuses to create a preview for an invalid room ID', () => {
    expect(() => createRoomPreview('not-a-room', 'https://glasshouse.test')).toThrow(
      'Room ID must be a valid workspace file UUID.',
    );
  });
});
