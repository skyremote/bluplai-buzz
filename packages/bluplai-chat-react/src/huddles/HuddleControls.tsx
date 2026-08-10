import type { HuddleSnapshot } from "../transport/types";

/** Props for the Huddle lifecycle and consent controls. */
export interface HuddleControlsProps {
  snapshot: HuddleSnapshot | null;
  canStart: boolean;
  busy: boolean;
  onStart: () => void;
  onJoin: () => void;
  onLeave: () => void;
  onEnd: () => void;
  onConsent: (consent: "granted" | "denied") => void;
}

const MOBILE_TARGET = { minHeight: "44px", minWidth: "44px" } as const;

/** Mobile-safe controls for the authority-fenced Huddle lifecycle. */
export function HuddleControls({
  snapshot,
  canStart,
  busy,
  onStart,
  onJoin,
  onLeave,
  onEnd,
  onConsent,
}: HuddleControlsProps) {
  if (!snapshot) {
    return canStart ? (
      <div className="bluplai-huddle__controls">
        <button
          disabled={busy}
          onClick={onStart}
          style={MOBILE_TARGET}
          type="button"
        >
          Start Huddle
        </button>
      </div>
    ) : null;
  }

  const currentParticipant = snapshot.participants.find(
    (participant) => participant.isCurrentUser,
  );
  const joinLabel =
    snapshot.connection === "interrupted" ? "Rejoin Huddle" : "Join Huddle";
  const canJoin = ["ready_to_join", "interrupted"].includes(
    snapshot.connection,
  );
  const joined = currentParticipant?.state === "joined";
  const needsConsent =
    snapshot.recording.requested && currentParticipant?.consent === "pending";

  return (
    <fieldset className="bluplai-huddle__controls">
      <legend className="bluplai-chat__sr-only">Huddle controls</legend>
      {canJoin ? (
        <button
          disabled={busy}
          onClick={onJoin}
          style={MOBILE_TARGET}
          type="button"
        >
          {joinLabel}
        </button>
      ) : null}
      {needsConsent ? (
        <>
          <button
            disabled={busy}
            onClick={() => onConsent("granted")}
            style={MOBILE_TARGET}
            type="button"
          >
            Allow recording
          </button>
          <button
            disabled={busy}
            onClick={() => onConsent("denied")}
            style={MOBILE_TARGET}
            type="button"
          >
            Continue without recording
          </button>
        </>
      ) : null}
      {joined ? (
        <button
          disabled={busy}
          onClick={onLeave}
          style={MOBILE_TARGET}
          type="button"
        >
          Leave Huddle
        </button>
      ) : null}
      {snapshot.canEnd && snapshot.lifecycle.state !== "ended" ? (
        <button
          className="bluplai-huddle__end"
          disabled={busy}
          onClick={onEnd}
          style={MOBILE_TARGET}
          type="button"
        >
          End Huddle
        </button>
      ) : null}
    </fieldset>
  );
}
