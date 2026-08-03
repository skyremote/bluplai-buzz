import { useEffect, useMemo, useState } from "react";
import type {
  BuzzChatTransport,
  ChatMessage,
  ChatReadState,
  ChatRoom,
  ChatWorkspaceSnapshot,
} from "./transport/types";

/** Props for the browser-native Bluplai Chat workspace. */
export interface BluplaiChatProps {
  transport: BuzzChatTransport;
  className?: string;
  initialRoomId?: string;
}

type WorkspaceState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: ChatWorkspaceSnapshot };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown transport error";
}

function resolveRoomId(
  snapshot: ChatWorkspaceSnapshot,
  requestedRoomId?: string,
): string | null {
  const candidates = [requestedRoomId, snapshot.activeRoomId];
  for (const candidate of candidates) {
    if (candidate && snapshot.rooms.some((room) => room.id === candidate)) {
      return candidate;
    }
  }
  return snapshot.rooms[0]?.id ?? null;
}

function isMessageRead(
  message: ChatMessage,
  readState: ChatReadState | undefined,
): boolean {
  if (!readState) return false;
  return Date.parse(message.createdAt) <= Date.parse(readState.lastReadAt);
}

function reactionLabel(
  emoji: string,
  count: number,
  reactedByCurrentUser: boolean,
): string {
  const people = count === 1 ? "1 person" : `${count} people`;
  const viewer = reactedByCurrentUser ? ", you reacted" : "";
  return `${emoji} reaction, ${people}${viewer}`;
}

function MessageCard({
  message,
  readState,
}: {
  message: ChatMessage;
  readState: ChatReadState | undefined;
}) {
  const read = isMessageRead(message, readState);
  return (
    <article
      aria-label={`Message from ${message.author.displayName}`}
      className="bluplai-chat__message"
    >
      <header className="bluplai-chat__message-header">
        <strong>{message.author.displayName}</strong>
        <time dateTime={message.createdAt}>
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
        <span
          aria-label={read ? "Read message" : "Unread message"}
          className="bluplai-chat__read-state"
          role="status"
        >
          {read ? "Read" : "Unread"}
        </span>
      </header>
      <p>{message.body}</p>
      {message.reactions.length > 0 ? (
        <div className="bluplai-chat__reactions">
          {message.reactions.map((reaction) => (
            <button
              aria-label={reactionLabel(
                reaction.emoji,
                reaction.count,
                reaction.reactedByCurrentUser,
              )}
              aria-pressed={reaction.reactedByCurrentUser}
              key={reaction.emoji}
              type="button"
            >
              <span aria-hidden="true">{reaction.emoji}</span>
              <span>{reaction.count}</span>
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function roomButtonLabel(room: ChatRoom): string {
  return room.unreadCount > 0
    ? `${room.name}, ${room.unreadCount} unread`
    : room.name;
}

/**
 * Minimal browser workspace proving the React and transport seams without
 * importing Buzz desktop, authentication, Tauri, or developer-only surfaces.
 */
export function BluplaiChat({
  transport,
  className,
  initialRoomId,
}: BluplaiChatProps) {
  const [workspace, setWorkspace] = useState<WorkspaceState>({
    status: "loading",
  });
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let mounted = true;
    const acceptSnapshot = (snapshot: ChatWorkspaceSnapshot) => {
      if (!mounted) return;
      setWorkspace({ status: "ready", snapshot });
      setSelectedRoomId((current) =>
        resolveRoomId(snapshot, current ?? initialRoomId),
      );
    };
    const unsubscribe = transport.subscribe(acceptSnapshot);

    transport
      .loadWorkspace({ signal: controller.signal })
      .then(acceptSnapshot)
      .catch((error: unknown) => {
        if (!mounted || controller.signal.aborted) return;
        setWorkspace({ status: "error", message: errorMessage(error) });
      });

    return () => {
      mounted = false;
      controller.abort();
      unsubscribe();
    };
  }, [initialRoomId, transport]);

  const roomProjection = useMemo(() => {
    if (workspace.status !== "ready" || !selectedRoomId) return null;
    const room = workspace.snapshot.rooms.find(
      (candidate) => candidate.id === selectedRoomId,
    );
    if (!room) return null;
    const roomMessages = workspace.snapshot.messages.filter(
      (message) => message.roomId === room.id,
    );
    const rootMessages = roomMessages.filter(
      (message) => !message.threadRootId,
    );
    const repliesByRoot = new Map<string, ChatMessage[]>();
    for (const message of roomMessages) {
      if (!message.threadRootId) continue;
      const replies = repliesByRoot.get(message.threadRootId) ?? [];
      replies.push(message);
      repliesByRoot.set(message.threadRootId, replies);
    }
    const readState = workspace.snapshot.readStates.find(
      (candidate) => candidate.roomId === room.id,
    );
    return { readState, repliesByRoot, room, rootMessages };
  }, [selectedRoomId, workspace]);

  return (
    <section className={["bluplai-chat", className].filter(Boolean).join(" ")}>
      <header className="bluplai-chat__brand">
        <h1>Bluplai Chat, powered by Buzz</h1>
      </header>

      {workspace.status === "loading" ? (
        <p aria-live="polite">Loading Bluplai Chat…</p>
      ) : null}
      {workspace.status === "error" ? (
        <p role="alert">Unable to load Bluplai Chat: {workspace.message}</p>
      ) : null}
      {workspace.status === "ready" && workspace.snapshot.rooms.length === 0 ? (
        <p>No chat rooms are available.</p>
      ) : null}

      {workspace.status === "ready" && workspace.snapshot.rooms.length > 0 ? (
        <div className="bluplai-chat__workspace">
          <nav aria-label="Chat rooms" className="bluplai-chat__rooms">
            {workspace.snapshot.rooms.map((room) => (
              <button
                aria-current={room.id === selectedRoomId ? "page" : undefined}
                aria-label={roomButtonLabel(room)}
                key={room.id}
                onClick={() => setSelectedRoomId(room.id)}
                type="button"
              >
                <span>{room.name}</span>
                {room.unreadCount > 0 ? (
                  <span aria-hidden="true">{room.unreadCount}</span>
                ) : null}
              </button>
            ))}
          </nav>

          {roomProjection ? (
            <main className="bluplai-chat__timeline">
              <header>
                <h2>{roomProjection.room.name}</h2>
                {roomProjection.room.topic ? (
                  <p>{roomProjection.room.topic}</p>
                ) : null}
              </header>
              {roomProjection.rootMessages.map((message) => {
                const replies =
                  roomProjection.repliesByRoot.get(message.id) ?? [];
                return (
                  <div className="bluplai-chat__conversation" key={message.id}>
                    <MessageCard
                      message={message}
                      readState={roomProjection.readState}
                    />
                    {replies.length > 0 ? (
                      <section
                        aria-label={`Thread replies to ${message.body}`}
                        className="bluplai-chat__thread"
                      >
                        {replies.map((reply) => (
                          <MessageCard
                            key={reply.id}
                            message={reply}
                            readState={roomProjection.readState}
                          />
                        ))}
                      </section>
                    ) : null}
                  </div>
                );
              })}
            </main>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
