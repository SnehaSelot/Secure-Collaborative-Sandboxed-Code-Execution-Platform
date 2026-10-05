import { getFileRoomName } from '../config/collaboration';

export interface CollaborationRoomPreview {
  roomId: string;
  roomName: string;
  shareUrl: string;
  availability: 'ui-only';
  joined: false;
}

const ROOM_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidRoomId(roomId: string): boolean {
  return ROOM_ID_PATTERN.test(roomId);
}

export function createRoomPreview(
  roomId: string,
  origin: string,
): CollaborationRoomPreview {
  if (!isValidRoomId(roomId)) {
    throw new Error('Room ID must be a valid workspace file UUID.');
  }

  const shareUrl = new URL(`/collaboration/${encodeURIComponent(roomId)}`, origin);
  return {
    roomId,
    roomName: getFileRoomName(roomId),
    shareUrl: shareUrl.toString(),
    availability: 'ui-only',
    joined: false,
  };
}
