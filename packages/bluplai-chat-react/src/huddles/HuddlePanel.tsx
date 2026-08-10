import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatWorkspaceCapabilities,
  HuddleCredential,
  HuddleSnapshot,
  HuddleSource,
  HuddleTransport,
} from "../transport/types";
import { HuddleControls } from "./HuddleControls";
import { HuddleTranscript } from "./HuddleTranscript";

/** Props for the complete typed Huddle surface. */
export interface HuddlePanelProps {
  capabilities: ChatWorkspaceCapabilities;
  transport: HuddleTransport;
  source: HuddleSource;
  currentUserId: string;
  participantName: string;
  initialSnapshot?: HuddleSnapshot | null;
  className?: string;
  /** Receives the ephemeral media credential without placing it in rendered state. */
  onCredential?: (credential: HuddleCredential) => void;
}

type Operation = "start" | "join" | "leave" | "end" | "consent" | "refresh";

function correlationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `huddle-${Date.now()}`;
}

function operationError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Huddle request failed. Nothing else was changed.";
}

function connectionAnnouncement(
  snapshot: HuddleSnapshot | null,
): string | null {
  if (!snapshot) return null;
  if (snapshot.connection === "interrupted") {
    return "Connection interrupted. Rejoin the Huddle.";
  }
  if (snapshot.connection === "background") {
    return "Huddle continues in the background.";
  }
  if (snapshot.connection === "rejoining") return "Rejoining Huddle.";
  if (snapshot.lifecycle.state === "ended") return "Huddle ended.";
  return snapshot.progress?.detail ?? snapshot.progress?.label ?? null;
}

/**
 * Typed, host-authorised Huddle UI. ElevenLabs credentials are handed directly
 * to the host callback and are never retained in component state or the DOM.
 */
export function HuddlePanel({
  capabilities,
  transport,
  source,
  currentUserId,
  participantName,
  initialSnapshot = null,
  className,
  onCredential,
}: HuddlePanelProps) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const canStart =
    capabilities.readOnly === false && capabilities.huddleStart === true;

  useEffect(() => {
    setSnapshot(initialSnapshot);
  }, [initialSnapshot]);

  useEffect(
    () => () => {
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!snapshot?.id || !transport.subscribe) return;
    return transport.subscribe(snapshot.id, setSnapshot);
  }, [snapshot?.id, transport]);

  useEffect(() => {
    if (!snapshot?.id) return;
    const huddleId = snapshot.id;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        setSnapshot((current) =>
          current?.connection === "connected"
            ? { ...current, connection: "background" }
            : current,
        );
        return;
      }
      if (document.visibilityState !== "visible") return;
      const controller = new AbortController();
      controllers.current.add(controller);
      setOperation("refresh");
      transport
        .refresh(huddleId, { signal: controller.signal })
        .then(setSnapshot)
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setError(operationError(cause));
        })
        .finally(() => {
          controllers.current.delete(controller);
          setOperation((current) => (current === "refresh" ? null : current));
        });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [snapshot?.id, transport]);

  const run = async (
    name: Operation,
    request: (signal: AbortSignal) => Promise<HuddleSnapshot>,
  ) => {
    const controller = new AbortController();
    controllers.current.add(controller);
    setOperation(name);
    setError(null);
    try {
      setSnapshot(await request(controller.signal));
    } catch (cause) {
      if (!controller.signal.aborted) setError(operationError(cause));
    } finally {
      controllers.current.delete(controller);
      setOperation(null);
    }
  };

  const start = () => {
    if (!canStart) return;
    void run("start", (signal) =>
      transport.start(
        {
          source,
          mode: "orchestrated",
          recordingRequested: false,
          retentionDays: 365,
          participants: [],
          correlationId: correlationId(),
        },
        { signal },
      ),
    );
  };
  const join = () => {
    if (!snapshot || capabilities.readOnly) return;
    const huddleId = snapshot.id;
    void run("join", async (signal) => {
      const joined = await transport.join(
        huddleId,
        { participantName },
        { signal },
      );
      onCredential?.(joined.credential);
      return joined.snapshot;
    });
  };
  const leave = () => {
    if (!snapshot || capabilities.readOnly) return;
    const huddleId = snapshot.id;
    void run("leave", (signal) => transport.leave(huddleId, { signal }));
  };
  const end = () => {
    if (!snapshot || capabilities.readOnly || !snapshot.canEnd) return;
    const huddleId = snapshot.id;
    void run("end", (signal) => transport.end(huddleId, { signal }));
  };
  const consent = (value: "granted" | "denied") => {
    if (!snapshot || capabilities.readOnly) return;
    const huddleId = snapshot.id;
    void run("consent", (signal) =>
      transport.setRecordingConsent(huddleId, value, { signal }),
    );
  };

  const participantCount = snapshot?.participants.filter(
    (participant) => participant.state === "joined",
  ).length;
  const announcement = error ?? connectionAnnouncement(snapshot);
  const participantNames = useMemo(
    () =>
      new Map(
        snapshot?.participants.map((person) => [person.id, person.displayName]),
      ),
    [snapshot?.participants],
  );

  return (
    <section
      aria-label="Huddle"
      className={["bluplai-huddle", className].filter(Boolean).join(" ")}
    >
      <header className="bluplai-huddle__header">
        <div>
          <p className="bluplai-huddle__eyebrow">Live collaboration</p>
          <h2>Huddle</h2>
        </div>
        {snapshot ? (
          <span className="bluplai-huddle__lifecycle">
            {snapshot.lifecycle.state.replaceAll("_", " ")}
          </span>
        ) : null}
      </header>

      {!snapshot && !canStart ? (
        <p className="bluplai-huddle__unavailable">
          Huddles are unavailable in this workspace.
        </p>
      ) : null}

      {snapshot ? (
        <>
          <div className="bluplai-huddle__recording">
            <strong>
              {snapshot.recording.active ? "Recording on" : "Recording off"}
            </strong>
            <span>
              {snapshot.recording.requested
                ? "Recording requires participant consent."
                : "Audio is not being retained."}
            </span>
          </div>
          <p aria-atomic="true" aria-live="polite" role="status">
            {announcement ??
              (operation ? `${operation} in progress` : "Huddle ready.")}
          </p>
          <section aria-labelledby="huddle-participants-title">
            <div className="bluplai-huddle__section-heading">
              <h3 id="huddle-participants-title">Participants</h3>
              <span>{participantCount ?? 0} joined</span>
            </div>
            <ul
              aria-label="Huddle participants"
              className="bluplai-huddle__roster"
            >
              {snapshot.participants.map((participant) => (
                <li key={`${participant.type}:${participant.id}`}>
                  <span aria-hidden="true" className="bluplai-huddle__avatar">
                    {participant.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <span>
                    <strong>{participant.displayName}</strong>
                    <small>
                      {participant.type === "agent"
                        ? "Specialist agent"
                        : "Human"}{" "}
                      · {participant.state}
                      {participant.id === currentUserId ? " · You" : ""}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section
            aria-labelledby="huddle-transcript-title"
            className="bluplai-huddle__transcript-section"
          >
            <div className="bluplai-huddle__section-heading">
              <h3 id="huddle-transcript-title">Transcript</h3>
              <span>Signed live</span>
            </div>
            <HuddleTranscript
              participants={snapshot.participants}
              turns={snapshot.transcript}
            />
          </section>
          {snapshot.outputs.length > 0 ? (
            <section aria-labelledby="huddle-outputs-title">
              <div className="bluplai-huddle__section-heading">
                <h3 id="huddle-outputs-title">Outputs</h3>
              </div>
              <ul className="bluplai-huddle__outputs">
                {snapshot.outputs.map((output) => (
                  <li key={output.id}>
                    {output.href ? (
                      <a href={output.href}>{output.label}</a>
                    ) : (
                      <span>{output.label}</span>
                    )}
                    <small>{output.state.replaceAll("_", " ")}</small>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <span className="bluplai-chat__sr-only">
            {participantNames.size} authorised Huddle participants
          </span>
        </>
      ) : null}

      <HuddleControls
        busy={operation !== null}
        canStart={canStart}
        onConsent={consent}
        onEnd={end}
        onJoin={join}
        onLeave={leave}
        onStart={start}
        snapshot={snapshot}
      />
    </section>
  );
}
