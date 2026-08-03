import { useEffect, useMemo, useRef, useState } from "react";
import { executeChatCommand } from "./capabilities";
import { Composer, type ComposerSubmit } from "./components/Composer";
import { MessageItem } from "./components/MessageItem";
import { RoomList } from "./components/RoomList";
import { SearchPanel } from "./components/SearchPanel";
import type {
  BuzzChatTransport,
  ChatMessage,
  ChatRoom,
  ChatWorkspaceSnapshot,
} from "./transport/types";

/** Props for the browser-native Bluplai Chat workspace. */
export interface BluplaiChatProps {
  transport: BuzzChatTransport;
  className?: string;
  initialRoomId?: string;
  mode?: "workspace" | "rail";
  compact?: boolean;
  showRoomList?: boolean;
  onRoomChange?: (room: ChatRoom) => void;
  onCreateRoom?: () => void;
  onCreateDm?: () => void;
  onManageMembers?: (room: ChatRoom) => void;
  onNotificationPreferenceChange?: (
    room: ChatRoom,
    preference: "all" | "mentions" | "muted",
  ) => Promise<void> | void;
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
  requestedRoomId?: string | null,
): string | null {
  const candidates = [requestedRoomId, snapshot.activeRoomId];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const room = snapshot.rooms.find(
      (item) => item.id === candidate || item.conversationId === candidate,
    );
    if (room) return room.id;
  }
  return snapshot.rooms[0]?.id ?? null;
}

function commandId(): string {
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "");
  return `web_${random ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function attachmentLinks(value: ComposerSubmit): string {
  const links = value.attachments.map(
    (attachment) => `[${attachment.name}](${attachment.downloadUrl})`,
  );
  return [value.body, ...links].filter(Boolean).join("\n");
}

/** Browser workspace powered by the host's managed Buzz gateway transport. */
export function BluplaiChat({
  transport,
  className,
  initialRoomId,
  mode = "workspace",
  compact = false,
  showRoomList = true,
  onRoomChange,
  onCreateRoom,
  onCreateDm,
  onManageMembers,
  onNotificationPreferenceChange,
}: BluplaiChatProps) {
  const [workspace, setWorkspace] = useState<WorkspaceState>({
    status: "loading",
  });
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [threadRoot, setThreadRoot] = useState<ChatMessage | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const lastMarkedRead = useRef<string | null>(null);
  const initialRoomIdRef = useRef(initialRoomId);
  const uploadAttachment = transport.uploadAttachment?.bind(transport);

  useEffect(() => {
    const controller = new AbortController();
    let mounted = true;
    const acceptSnapshot = (snapshot: ChatWorkspaceSnapshot) => {
      if (!mounted) return;
      setWorkspace({ status: "ready", snapshot });
      setSelectedRoomId((current) =>
        resolveRoomId(snapshot, current ?? initialRoomIdRef.current),
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
  }, [transport]);

  useEffect(() => {
    if (workspace.status !== "ready" || !initialRoomId) return;
    setSelectedRoomId(resolveRoomId(workspace.snapshot, initialRoomId));
  }, [initialRoomId, workspace]);

  const projection = useMemo(() => {
    if (workspace.status !== "ready" || !selectedRoomId) return null;
    const room = workspace.snapshot.rooms.find(
      (item) => item.id === selectedRoomId,
    );
    if (!room) return null;
    const messages = workspace.snapshot.messages
      .filter((message) => message.roomId === room.id)
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
    const roots = messages.filter((message) => !message.threadRootId);
    const repliesByRoot = new Map<string, ChatMessage[]>();
    for (const message of messages) {
      if (!message.threadRootId) continue;
      const replies = repliesByRoot.get(message.threadRootId) ?? [];
      replies.push(message);
      repliesByRoot.set(message.threadRootId, replies);
    }
    const readState = workspace.snapshot.readStates.find(
      (state) => state.roomId === room.id,
    );
    const members = (workspace.snapshot.members ?? []).filter((member) =>
      room.memberIds?.includes(member.id),
    );
    return { room, messages, roots, repliesByRoot, readState, members };
  }, [selectedRoomId, workspace]);

  useEffect(() => {
    if (!projection || projection.messages.length === 0) return;
    const latest = projection.messages.at(-1);
    if (!latest || latest.id === lastMarkedRead.current) return;
    lastMarkedRead.current = latest.id;
    void executeChatCommand(transport, {
      type: "chat.mark-read",
      roomId: projection.room.id,
      messageId: latest.id,
    }).catch(() => {
      if (lastMarkedRead.current === latest.id) lastMarkedRead.current = null;
    });
  }, [projection, transport]);

  const selectRoom = (room: ChatRoom) => {
    setSelectedRoomId(room.id);
    setThreadRoot(null);
    setSearchOpen(false);
    onRoomChange?.(room);
  };

  const send = async (value: ComposerSubmit) => {
    if (!projection) return;
    const body = attachmentLinks(value);
    await executeChatCommand(
      transport,
      threadRoot
        ? {
            type: "chat.send-message",
            roomId: projection.room.id,
            body,
            parentMessageId: threadRoot.id,
            threadRootId: threadRoot.threadRootId ?? threadRoot.id,
          }
        : { type: "chat.send-message", roomId: projection.room.id, body },
    );
  };

  const react = async (message: ChatMessage, emoji: string) => {
    await executeChatCommand(transport, {
      type: "chat.add-reaction",
      roomId: message.roomId,
      messageId: message.id,
      emoji,
    });
  };

  const roomList =
    workspace.status === "ready" ? (
      <RoomList
        compact={compact || mode === "rail"}
        onCreateDm={onCreateDm}
        onCreateRoom={onCreateRoom}
        onSelect={selectRoom}
        rooms={workspace.snapshot.rooms}
        selectedRoomId={selectedRoomId}
      />
    ) : null;

  return (
    <section
      className={[
        "bluplai-chat",
        compact ? "bluplai-chat--compact" : "",
        mode === "rail" ? "bluplai-chat--rail" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <header className="bluplai-chat__brand">
        <h2 aria-label="Bluplai Chat, powered by Buzz">
          <span>Bluplai Chat</span>
          <span>powered by Buzz</span>
        </h2>
      </header>
      {workspace.status === "loading" ? (
        <p aria-live="polite" className="bluplai-chat__state">
          Loading Bluplai Chat…
        </p>
      ) : null}
      {workspace.status === "error" ? (
        <p className="bluplai-chat__state" role="alert">
          Unable to load Bluplai Chat: {workspace.message}
        </p>
      ) : null}
      {workspace.status === "ready" && workspace.snapshot.rooms.length === 0 ? (
        <p className="bluplai-chat__state">No chat rooms are available.</p>
      ) : null}
      {mode === "rail" ? roomList : null}
      {mode === "workspace" &&
      workspace.status === "ready" &&
      workspace.snapshot.rooms.length ? (
        <div
          className={[
            "bluplai-chat__workspace",
            !showRoomList ? "bluplai-chat__workspace--without-rail" : "",
            threadRoot ? "bluplai-chat__workspace--thread-open" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {showRoomList ? roomList : null}
          {projection ? (
            <main className="bluplai-chat__timeline">
              <header className="bluplai-chat__room-header">
                <div>
                  <h1>{projection.room.name}</h1>
                  {projection.room.topic ? (
                    <p>{projection.room.topic}</p>
                  ) : null}
                </div>
                <div className="bluplai-chat__room-actions">
                  <span title="Members online">
                    {
                      projection.members.filter(
                        (member) => member.presence === "online",
                      ).length
                    }
                    /{projection.members.length} online
                  </span>
                  <button onClick={() => setSearchOpen(true)} type="button">
                    Search
                  </button>
                  {onManageMembers && projection.room.canManageMembers ? (
                    <button
                      onClick={() => onManageMembers(projection.room)}
                      type="button"
                    >
                      Members
                    </button>
                  ) : null}
                  {onNotificationPreferenceChange ? (
                    <select
                      aria-label="Notification preference"
                      onChange={(event) =>
                        void onNotificationPreferenceChange(
                          projection.room,
                          event.target.value as "all" | "mentions" | "muted",
                        )
                      }
                      value={projection.room.notificationPreference ?? "all"}
                    >
                      <option value="all">All messages</option>
                      <option value="mentions">Mentions</option>
                      <option value="muted">Muted</option>
                    </select>
                  ) : null}
                </div>
              </header>
              <div className="bluplai-chat__message-stream">
                {projection.roots.length === 0 ? (
                  <p className="bluplai-chat__empty-room">
                    This room is ready. Start the conversation.
                  </p>
                ) : null}
                {projection.roots.map((message) => (
                  <MessageItem
                    compact={compact}
                    key={message.id}
                    message={message}
                    onOpenThread={setThreadRoot}
                    onReact={(item, emoji) => void react(item, emoji)}
                    readState={projection.readState}
                    threadReplyCount={
                      projection.repliesByRoot.get(message.id)?.length ?? 0
                    }
                  />
                ))}
              </div>
              <Composer
                compact={compact}
                onSubmit={send}
                onUpload={
                  uploadAttachment
                    ? (file, signal) =>
                        uploadAttachment(projection.room.id, file, signal)
                    : undefined
                }
                roomName={projection.room.name}
              />
            </main>
          ) : (
            <div className="bluplai-chat__state">Select a room to begin.</div>
          )}
          {threadRoot && projection ? (
            <aside
              aria-label={`Thread replies to ${threadRoot.body}`}
              className="bluplai-chat__thread-panel"
            >
              <header>
                <strong>Thread</strong>
                <button
                  aria-label="Close thread"
                  onClick={() => setThreadRoot(null)}
                  type="button"
                >
                  ×
                </button>
              </header>
              <MessageItem
                compact
                message={threadRoot}
                readState={projection.readState}
              />
              {(
                projection.repliesByRoot.get(
                  threadRoot.threadRootId ?? threadRoot.id,
                ) ?? []
              ).map((reply) => (
                <MessageItem
                  compact
                  key={reply.id}
                  message={reply}
                  readState={projection.readState}
                />
              ))}
              <Composer
                compact
                onCancelReply={() => setThreadRoot(null)}
                onSubmit={send}
                replyToLabel={threadRoot.author.displayName}
                roomName={projection.room.name}
              />
            </aside>
          ) : null}
          {searchOpen && projection ? (
            <SearchPanel
              messages={projection.messages}
              onClose={() => {
                setSearchOpen(false);
                setSearchQuery("");
              }}
              onQueryChange={setSearchQuery}
              onSelect={(message) => {
                const rootId = message.threadRootId;
                if (rootId) {
                  const root = projection.messages.find(
                    (item) => item.id === rootId,
                  );
                  if (root) setThreadRoot(root);
                }
                setSearchOpen(false);
              }}
              query={searchQuery}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export { commandId };
