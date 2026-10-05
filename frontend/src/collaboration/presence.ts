import type { Awareness } from 'y-protocols/awareness';

export interface Participant {
  clientId: number;
  displayName: string;
  color: string;
  isLocal: boolean;
}

const PARTICIPANT_COLORS = [
  '#f87171',
  '#fb923c',
  '#facc15',
  '#4ade80',
  '#2dd4bf',
  '#38bdf8',
  '#818cf8',
  '#e879f9',
];

function colorForClient(clientId: number): string {
  return PARTICIPANT_COLORS[Math.abs(clientId) % PARTICIPANT_COLORS.length];
}

export function getParticipants(awareness: Awareness): Participant[] {
  const participants = [...awareness.getStates().entries()]
    .flatMap(([clientId, state]) => {
      const user = state.user;
      if (!user || typeof user !== 'object' || Array.isArray(user)) return [];

      const suppliedName =
        'name' in user && typeof user.name === 'string' ? user.name.trim() : '';
      return [{
        clientId,
        displayName: suppliedName || `Participant ${clientId.toString(36)}`,
        color: colorForClient(clientId),
        isLocal: clientId === awareness.clientID,
      }];
    })
    .sort((left, right) => left.clientId - right.clientId);

  const nameCounts = new Map<string, number>();
  return participants.map((participant) => {
    const count = (nameCounts.get(participant.displayName) ?? 0) + 1;
    nameCounts.set(participant.displayName, count);

    return count === 1
      ? participant
      : { ...participant, displayName: `${participant.displayName} (${count})` };
  });
}
