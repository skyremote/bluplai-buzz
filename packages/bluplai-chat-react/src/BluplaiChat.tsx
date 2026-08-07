import { useEffect, useMemo, useRef, useState } from "react";
import { executeChatCommand } from "./capabilities";
import { Composer, type ComposerSubmit } from "./components/Composer";
import { MessageItem } from "./components/MessageItem";
import { RoomList } from "./components/RoomList";
import { SearchPanel } from "./components/SearchPanel";
import type {
  BuzzChatTransport,
  ChatAttachment,
  ChatAttachmentReference,
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

function attachmentReference(
  attachment: ChatAttachment,
): ChatAttachmentReference {
  if (!attachment.sha256) {
    throw new Error(`Attachment ${attachment.name} is missing its checksum`);
  }
  return {
    id: attachment.id,
    sha256: attachment.sha256,
    name: attachment.name,
    contentType: attachment.contentType,
    byteSize: attachment.byteSize,
    kind: attachment.kind,
  };
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
  const [serverSearchMessages, setServerSearchMessages] = useState<
    ChatMessage[]
  >([]);
  const [searchContextMessages, setSearchContextMessages] = useState<
    ChatMessage[]
  >([]);
  const [historyHasMoreOverride, setHistoryHasMoreOverride] = useState<
    Record<string, boolean>
  >({});
  const [historyLoadingRoomId, setHistoryLoadingRoomId] = useState<
    string | null
  >(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const searchNavigationController = useRef<AbortController | null>(null);
  const historyController = useRef<AbortController | null>(null);
  const lastMarkedRead = useRef<string | null>(null);
  const initialRoomIdRef = useRef(initialRoomId);
  const uploadAttachment = transport.uploadAttachment?.bind(transport);
  const loadOlderMessages = transport.loadOlderMessages?.bind(transport);
  const setTyping = transport.setTyping?.bind(transport);
  const capabilities =
    workspace.status === "ready" ? workspace.snapshot.capabilities : null;
  const readOnly = capabilities?.readOnly !== false;

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

  useEffect(
    () => () => {
      searchNavigationController.current?.abort();
      historyController.current?.abort();
    },
    [],
  );

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
  const threadReplies = useMemo(() => {
    if (!projection || !threadRoot) return [];
    const rootId = threadRoot.threadRootId ?? threadRoot.id;
    return [...projection.messages, ...searchContextMessages]
      .filter(
        (message, index, all) =>
          all.findIndex((candidate) => candidate.id === message.id) === index,
      )
      .filter((message) => message.threadRootId === rootId);
  }, [projection, searchContextMessages, threadRoot]);
  const typingIndicators =
    workspace.status === "ready" ? (workspace.snapshot.typing ?? []) : [];
  const currentUserId =
    workspace.status === "ready" ? workspace.snapshot.currentUserId : null;
  const rootTyping = projection
    ? typingIndicators.filter(
        (indicator) =>
          indicator.roomId === projection.room.id &&
          !indicator.threadRootId &&
          indicator.userId !== currentUserId,
      )
    : [];
  const threadTyping =
    projection && threadRoot
      ? typingIndicators.filter(
          (indicator) =>
            indicator.roomId === projection.room.id &&
            indicator.threadRootId === threadRoot.id &&
            indicator.userId !== currentUserId,
        )
      : [];
  const searchRoomId = projection?.room.id;

  useEffect(() => {
    const search = transport.searchMessages?.bind(transport);
    const query = searchQuery.trim();
    if (!searchOpen || !searchRoomId || !search || !query) {
      setServerSearchMessages([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void search(searchRoomId, query, controller.signal)
        .then((messages) => {
          if (!controller.signal.aborted) setServerSearchMessages(messages);
        })
        .catch(() => {
          if (!controller.signal.aborted) setServerSearchMessages([]);
        });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchOpen, searchQuery, searchRoomId, transport]);

  useEffect(() => {
    if (
      mode !== "workspace" ||
      readOnly ||
      !projection ||
      projection.messages.length === 0
    )
      return;
    const latest = projection.messages.at(-1);
    if (!latest || latest.id === lastMarkedRead.current) return;
    lastMarkedRead.current = latest.id;
    void executeChatCommand(
      transport,
      {
        type: "chat.mark-read",
        roomId: projection.room.id,
        messageId: latest.id,
      },
      capabilities,
    ).catch(() => {
      if (lastMarkedRead.current === latest.id) lastMarkedRead.current = null;
    });
  }, [capabilities, mode, projection, readOnly, transport]);

  const selectRoom = (room: ChatRoom) => {
    setSelectedRoomId(room.id);
    setThreadRoot(null);
    setSearchContextMessages([]);
    setSearchOpen(false);
    onRoomChange?.(room);
  };

  const send = async (value: ComposerSubmit) => {
    if (!projection || !capabilities) return;
    const attachments = value.attachments.map(attachmentReference);
    await executeChatCommand(
      transport,
      threadRoot
        ? {
            type: "chat.send-message",
            roomId: projection.room.id,
            body: value.body,
            attachments,
            parentMessageId: threadRoot.id,
            threadRootId: threadRoot.threadRootId ?? threadRoot.id,
          }
        : {
            type: "chat.send-message",
            roomId: projection.room.id,
            body: value.body,
            attachments,
          },
      capabilities,
    );
  };

  const react = async (message: ChatMessage, emoji: string) => {
    if (!capabilities) return;
    await executeChatCommand(
      transport,
      {
        type: "chat.add-reaction",
        roomId: message.roomId,
        messageId: message.id,
        emoji,
      },
      capabilities,
    );
  };

  const roomList =
    workspace.status === "ready" ? (
      <RoomList
        compact={compact || mode === "rail"}
        onCreateDm={readOnly ? undefined : onCreateDm}
        onCreateRoom={readOnly ? undefined : onCreateRoom}
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
                  {!readOnly &&
                  onManageMembers &&
                  projection.room.canManageMembers ? (
                    <button
                      onClick={() => onManageMembers(projection.room)}
                      type="button"
                    >
                      Members
                    </button>
                  ) : null}
                  {!readOnly && onNotificationPreferenceChange ? (
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
                {loadOlderMessages &&
                (historyHasMoreOverride[projection.room.id] ??
                  projection.room.hasOlderMessages) ? (
                  <button
                    className="bluplai-chat__load-older"
                    disabled={historyLoadingRoomId === projection.room.id}
                    onClick={() => {
                      historyController.current?.abort();
                      const controller = new AbortController();
                      historyController.current = controller;
                      setHistoryLoadingRoomId(projection.room.id);
                      setHistoryError(null);
                      void loadOlderMessages(
                        projection.room.id,
                        controller.signal,
                      )
                        .then((result) => {
                          if (controller.signal.aborted) return;
                          setHistoryHasMoreOverride((current) => ({
                            ...current,
                            [projection.room.id]: result.hasMore,
                          }));
                        })
                        .catch((error: unknown) => {
                          if (!controller.signal.aborted) {
                            setHistoryError(errorMessage(error));
                          }
                        })
                        .finally(() => {
                          if (historyController.current === controller) {
                            historyController.current = null;
                            setHistoryLoadingRoomId(null);
                          }
                        });
                    }}
                    type="button"
                  >
                    {historyLoadingRoomId === projection.room.id
                      ? "Loading older messages…"
                      : "Load older messages"}
                  </button>
                ) : null}
                {historyError ? <p role="alert">{historyError}</p> : null}
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
                    onOpenThread={
                      !readOnly ||
                      (projection.repliesByRoot.get(message.id)?.length ?? 0) >
                        0
                        ? setThreadRoot
                        : undefined
                    }
                    onReact={
                      readOnly
                        ? undefined
                        : (item, emoji) => void react(item, emoji)
                    }
                    readState={projection.readState}
                    threadReplyCount={
                      projection.repliesByRoot.get(message.id)?.length ?? 0
                    }
                  />
                ))}
                {rootTyping.length ? (
                  <p className="bluplai-chat__typing" role="status">
                    {rootTyping
                      .map((indicator) => indicator.displayName)
                      .join(", ")}
                    {rootTyping.length === 1 ? " is" : " are"} typing…
                  </p>
                ) : null}
              </div>
              {!readOnly ? (
                <Composer
                  compact={compact}
                  onSubmit={send}
                  onTypingChange={
                    setTyping
                      ? (active) =>
                          setTyping(projection.room.id, {
                            active,
                            parentMessageId: null,
                            threadRootId: null,
                          })
                      : undefined
                  }
                  onUpload={
                    uploadAttachment
                      ? (file, signal) =>
                          uploadAttachment(projection.room.id, file, signal)
                      : undefined
                  }
                  roomName={projection.room.name}
                />
              ) : null}
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
              {threadReplies.map((reply) => (
                <MessageItem
                  compact
                  key={reply.id}
                  message={reply}
                  readState={projection.readState}
                />
              ))}
              {threadTyping.length ? (
                <p className="bluplai-chat__typing" role="status">
                  {threadTyping
                    .map((indicator) => indicator.displayName)
                    .join(", ")}
                  {threadTyping.length === 1 ? " is" : " are"} typing…
                </p>
              ) : null}
              {!readOnly ? (
                <Composer
                  compact
                  onCancelReply={() => setThreadRoot(null)}
                  onSubmit={send}
                  onTypingChange={
                    setTyping
                      ? (active) =>
                          setTyping(projection.room.id, {
                            active,
                            parentMessageId: threadRoot.id,
                            threadRootId: threadRoot.id,
                          })
                      : undefined
                  }
                  onUpload={
                    uploadAttachment
                      ? (file, signal) =>
                          uploadAttachment(projection.room.id, file, signal)
                      : undefined
                  }
                  replyToLabel={threadRoot.author.displayName}
                  roomName={projection.room.name}
                />
              ) : null}
            </aside>
          ) : null}
          {searchOpen && projection ? (
            <SearchPanel
              messages={
                transport.searchMessages
                  ? serverSearchMessages
                  : projection.messages
              }
              onClose={() => {
                setSearchOpen(false);
                setSearchQuery("");
              }}
              onQueryChange={setSearchQuery}
              onSelect={(message) => {
                void (async () => {
                  searchNavigationController.current?.abort();
                  const controller = new AbortController();
                  searchNavigationController.current = controller;
                  try {
                    let context = projection.messages;
                    const rootId = message.threadRootId;
                    const needsContext =
                      !projection.messages.some(
                        (item) => item.id === message.id,
                      ) ||
                      Boolean(
                        rootId &&
                          !projection.messages.some(
                            (item) => item.id === rootId,
                          ),
                      );
                    if (needsContext) {
                      const loadContext =
                        transport.loadMessageContext?.bind(transport);
                      if (!loadContext) return;
                      context = await loadContext(
                        projection.room.id,
                        message.id,
                        controller.signal,
                      );
                      if (controller.signal.aborted) return;
                      setSearchContextMessages(context);
                    }
                    const root = rootId
                      ? context.find((item) => item.id === rootId)
                      : message;
                    if (root) setThreadRoot(root);
                    setSearchOpen(false);
                    setSearchQuery("");
                  } catch {
                    // Keep search open so the user can retry navigation.
                  } finally {
                    if (searchNavigationController.current === controller) {
                      searchNavigationController.current = null;
                    }
                  }
                })();
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
