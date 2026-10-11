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

/** Exported alias for use in awareness color assignment. */
export const PARTICIPANT_COLORS_ARRAY = PARTICIPANT_COLORS;



function colorForClient(clientId: number): string {
  return PARTICIPANT_COLORS[Math.abs(clientId) % PARTICIPANT_COLORS.length];
}

export function colorForName(name: string): string {
  let hash = 0;
  for (const char of name.trim().toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return PARTICIPANT_COLORS[Math.abs(hash) % PARTICIPANT_COLORS.length];
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
        color: 'color' in user && typeof user.color === 'string' && PARTICIPANT_COLORS.includes(user.color)
          ? user.color
          : colorForClient(clientId),
        isLocal: clientId === awareness.clientID,
      }];
    })
    .sort((left, right) => left.clientId - right.clientId);

  const usedColors = new Set<string>();
  const nameCounts = new Map<string, number>();
  return participants.map((participant) => {
    const count = (nameCounts.get(participant.displayName) ?? 0) + 1;
    nameCounts.set(participant.displayName, count);

    let color = participant.color;
    if (usedColors.has(color)) {
      let colorIndex = Math.abs(participant.clientId) % PARTICIPANT_COLORS.length;
      while (usedColors.has(PARTICIPANT_COLORS[colorIndex]) && usedColors.size < PARTICIPANT_COLORS.length) colorIndex = (colorIndex + 1) % PARTICIPANT_COLORS.length;
      color = PARTICIPANT_COLORS[colorIndex];
    }
    usedColors.add(color);

    return count === 1
      ? { ...participant, color }
      : { ...participant, color, displayName: `${participant.displayName} (${count})` };
  });
}
