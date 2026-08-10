import type {
  HuddleParticipant,
  HuddleTranscriptTurn,
} from "../transport/types";

/** Props for the signed, reconnect-deduplicated Huddle transcript. */
export interface HuddleTranscriptProps {
  participants: HuddleParticipant[];
  turns: HuddleTranscriptTurn[];
}

function participantName(
  participants: HuddleParticipant[],
  participantId: string,
): string {
  return (
    participants.find((participant) => participant.id === participantId)
      ?.displayName ?? "Huddle participant"
  );
}

/** Renders signed transcript turns once, even when reconnect replays them. */
export function HuddleTranscript({
  participants,
  turns,
}: HuddleTranscriptProps) {
  const stableTurns = [
    ...new Map(turns.map((turn) => [turn.stableTurnId, turn])).values(),
  ].sort(
    (left, right) =>
      left.absoluteTimeMs - right.absoluteTimeMs ||
      left.stableTurnId.localeCompare(right.stableTurnId),
  );

  if (stableTurns.length === 0) {
    return (
      <p className="bluplai-huddle__empty">
        The live transcript will appear here.
      </p>
    );
  }

  return (
    <div
      aria-label="Live signed transcript"
      aria-live="polite"
      className="bluplai-huddle__transcript"
      role="feed"
    >
      {stableTurns.map((turn) => (
        <article
          aria-label={`${participantName(participants, turn.participantId)} transcript turn`}
          className={`bluplai-huddle__turn bluplai-huddle__turn--${turn.role}`}
          key={turn.stableTurnId}
        >
          <div className="bluplai-huddle__turn-meta">
            <strong>{participantName(participants, turn.participantId)}</strong>
            <time dateTime={new Date(turn.absoluteTimeMs).toISOString()}>
              {new Date(turn.absoluteTimeMs).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
            <span className="bluplai-chat__sr-only">
              Signed transcript turn
            </span>
          </div>
          <p>{turn.content}</p>
        </article>
      ))}
    </div>
  );
}
