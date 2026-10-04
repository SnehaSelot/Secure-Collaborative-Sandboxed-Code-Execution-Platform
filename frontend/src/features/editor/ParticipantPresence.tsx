import { useEffect, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import { getParticipants, type Participant } from '../../collaboration/presence';

interface ParticipantPresenceProps {
  awareness: Awareness | null;
  showNames?: boolean;
}

export function ParticipantPresence({
  awareness,
  showNames = true,
}: ParticipantPresenceProps) {
  const [participantSnapshot, setParticipantSnapshot] = useState<{
    awareness: Awareness;
    participants: Participant[];
  } | null>(null);

  useEffect(() => {
    if (!awareness) return;

    const updateParticipants = () => {
      setParticipantSnapshot({ awareness, participants: getParticipants(awareness) });
    };
    updateParticipants();
    awareness.on('change', updateParticipants);

    return () => {
      awareness.off('change', updateParticipants);
    };
  }, [awareness]);

  const participants =
    participantSnapshot?.awareness === awareness ? participantSnapshot.participants : [];

  if (!awareness) {
    return (
      <span
        className="text-[10px] text-neutral-500"
        role="status"
        title="Network presence is unavailable in local-only mode."
      >
        Presence unavailable (local only)
      </span>
    );
  }

  if (participants.length === 0) {
    return (
      <span className="text-[10px] text-neutral-500" role="status">
        No participants
      </span>
    );
  }

  return (
    <ul className="flex max-w-full flex-wrap items-center gap-1.5" aria-label="Session participants">
      {participants.map((participant) => (
        <li
          key={participant.clientId}
          className="flex items-center gap-1 rounded-full border border-white/10 bg-neutral-900/70 px-2 py-0.5 text-[10px] text-neutral-300"
          title={participant.isLocal ? `${participant.displayName} (you)` : participant.displayName}
          aria-label={participant.isLocal ? `${participant.displayName} (you)` : participant.displayName}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: participant.color }}
            aria-hidden="true"
          />
          {showNames && (
            <>
              <span>{participant.displayName}</span>
              {participant.isLocal && <span className="text-neutral-500">(you)</span>}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
