import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { executeChatCommand } from "./capabilities";
import { Composer, type ComposerSubmit } from "./components/Composer";
import { ChatIcon } from "./components/ChatIcon";
import { MessageItem } from "./components/MessageItem";
import { RoomList } from "./components/RoomList";
import { SearchPanel } from "./components/SearchPanel";
import type {
  BuzzChatTransport,
  ChatAttachment,
  ChatAttachmentReference,
  ChatGif,
  ChatMessage,
  ChatProjectReference,
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
  onOpenRoomList?: () => void;
  onManageMembers?: (room: ChatRoom) => void;
  /** Optional host-owned GIF provider. Omit to hide GIF search entirely. */
  searchGifs?: (query: string, signal: AbortSignal) => Promise<ChatGif[]>;
  /** Host-owned context shown between the room header and message history. */
  roomContext?: ReactNode;
  onNotificationPreferenceChange?: (
    room: ChatRoom,
    preference: "all" | "mentions" | "muted",
  ) => Promise<void> | void;
}

type WorkspaceState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: ChatWorkspaceSnapshot };

const DEFAULT_THREAD_WIDTH = 380;
const MIN_THREAD_WIDTH = 320;
const MAX_THREAD_WIDTH = 720;
const THREAD_WIDTH_STORAGE_KEY = "bluplai-chat.thread-width";

function storedThreadWidth(): number {
  const stored = globalThis.localStorage?.getItem(THREAD_WIDTH_STORAGE_KEY);
  if (stored === null || stored === undefined || stored === "") {
    return DEFAULT_THREAD_WIDTH;
  }
  const value = Number(stored);
  return Number.isFinite(value)
    ? Math.min(MAX_THREAD_WIDTH, Math.max(MIN_THREAD_WIDTH, value))
    : DEFAULT_THREAD_WIDTH;
}

function roomDisclosureLabel(room: ChatRoom): string {
  if (
    room.canonicalRole?.endsWith("_shared") ||
    room.disclosureScope === "shared"
  ) {
    return "Customer shared";
  }
  if (
    room.canonicalRole?.endsWith("_internal") ||
    room.disclosureScope === "internal"
  ) {
    return "Internal";
  }
  if (room.disclosureScope === "private") return "Private";
  if (room.disclosureScope === "dm") return "Direct message";
  return "Channel";
}

function roomRecordLabel(room: ChatRoom): string | null {
  return (
    [room.accountName, room.projectName].filter(Boolean).join(" / ") || null
  );
}

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
  onOpenRoomList,
  onManageMembers,
  searchGifs,
  roomContext,
  onNotificationPreferenceChange,
}: BluplaiChatProps) {
  const [workspace, setWorkspace] = useState<WorkspaceState>({
    status: "loading",
  });
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [threadRoot, setThreadRoot] = useState<ChatMessage | null>(null);
  const [threadWidth, setThreadWidth] = useState(storedThreadWidth);
  const [threadExpanded, setThreadExpanded] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [serverSearchMessages, setServerSearchMessages] = useState<
    ChatMessage[]
  >([]);
  const [searchStatus, setSearchStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
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
  const previousFocus = useRef<HTMLElement | null>(null);
  const searchCloseButton = useRef<HTMLButtonElement | null>(null);
  const threadCloseButton = useRef<HTMLButtonElement | null>(null);
  const threadExpandButton = useRef<HTMLButtonElement | null>(null);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
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
  const mentionProjects = useMemo<ChatProjectReference[]>(() => {
    if (workspace.status !== "ready") return [];
    const byId = new Map<string, ChatProjectReference>();
    for (const project of workspace.snapshot.projects ?? []) {
      byId.set(project.id, project);
    }
    for (const room of workspace.snapshot.rooms) {
      if (!room.projectId || !room.projectName || !room.accountId) continue;
      byId.set(room.projectId, {
        id: room.projectId,
        displayName: room.projectName,
        accountId: room.accountId,
        accountName: room.accountName,
      });
    }
    return [...byId.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }, [workspace]);
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
  const threadAiTarget = useMemo(() => {
    if (!threadRoot) return null;
    const latest = threadReplies.at(-1) ?? threadRoot;
    return latest.author.role === "agent" ? latest : null;
  }, [threadReplies, threadRoot]);
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
      setSearchStatus("idle");
      return;
    }
    const controller = new AbortController();
    setSearchStatus("loading");
    const timer = window.setTimeout(() => {
      void search(searchRoomId, query, controller.signal)
        .then((messages) => {
          if (!controller.signal.aborted) {
            setServerSearchMessages(messages);
            setSearchStatus("idle");
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setServerSearchMessages([]);
            setSearchStatus("error");
          }
        });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchOpen, searchQuery, searchRoomId, transport]);

  useEffect(() => {
    if (threadRoot) threadCloseButton.current?.focus();
    else if (searchOpen) searchCloseButton.current?.focus();
  }, [searchOpen, threadRoot]);

  const rememberFocus = () => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  };

  const restoreFocus = () => {
    window.requestAnimationFrame(() => previousFocus.current?.focus());
  };

  const closeThread = () => {
    setThreadRoot(null);
    setThreadExpanded(false);
    restoreFocus();
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
    restoreFocus();
  };

  const openThread = (message: ChatMessage) => {
    rememberFocus();
    setThreadRoot(message);
    setThreadExpanded(false);
  };

  const updateThreadWidth = (nextWidth: number) => {
    const bounded = Math.min(
      MAX_THREAD_WIDTH,
      Math.max(MIN_THREAD_WIDTH, nextWidth),
    );
    setThreadWidth(bounded);
    globalThis.localStorage?.setItem(THREAD_WIDTH_STORAGE_KEY, String(bounded));
  };

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
    const body = [value.body, ...value.gifs.map((gif) => gif.url)]
      .filter(Boolean)
      .join("\n");
    const mentions = value.mentionedUserIds.length
      ? { mentionedUserIds: value.mentionedUserIds }
      : {};
    const projectMentions = value.mentionedProjectIds.length
      ? { mentionedProjectIds: value.mentionedProjectIds }
      : {};
    await executeChatCommand(
      transport,
      threadRoot
        ? {
            type: "chat.send-message",
            roomId: projection.room.id,
            body,
            ...mentions,
            ...projectMentions,
            attachments,
            parentMessageId: threadAiTarget?.id ?? threadRoot.id,
            threadRootId: threadRoot.threadRootId ?? threadRoot.id,
          }
        : {
            type: "chat.send-message",
            roomId: projection.room.id,
            body,
            ...mentions,
            ...projectMentions,
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
  const workspaceStyle = {
    "--bluplai-chat-thread-width": `${threadWidth}px`,
  } as CSSProperties;

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
      {mode === "rail" ? (
        <header className="bluplai-chat__brand">
          <div className="bluplai-chat__brand-mark">
            <ChatIcon name="message" />
          </div>
          <h2 aria-label="Bluplai Chat, powered by Buzz">
            <span>Bluplai Chat</span>
            <span>Powered by Buzz</span>
          </h2>
        </header>
      ) : (
        <h2 className="bluplai-chat__sr-only">Bluplai Chat, powered by Buzz</h2>
      )}
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
            threadExpanded ? "bluplai-chat__workspace--thread-expanded" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={workspaceStyle}
        >
          {showRoomList ? roomList : null}
          {projection ? (
            <main className="bluplai-chat__timeline">
              <header className="bluplai-chat__room-header">
                {onOpenRoomList ? (
                  <button
                    aria-label="Open channels and direct messages"
                    className="bluplai-chat__mobile-room-menu"
                    onClick={onOpenRoomList}
                    type="button"
                  >
                    <ChatIcon name="message" />
                  </button>
                ) : null}
                <div className="bluplai-chat__room-heading">
                  <div className="bluplai-chat__room-title-row">
                    <span className="bluplai-chat__room-title-icon">
                      <ChatIcon
                        name={
                          projection.room.disclosureScope === "private"
                            ? "lock"
                            : projection.room.disclosureScope === "dm"
                              ? "at"
                              : "hash"
                        }
                      />
                    </span>
                    <h1>{projection.room.name}</h1>
                    <span className="bluplai-chat__scope-badge">
                      {roomDisclosureLabel(projection.room)}
                    </span>
                  </div>
                  {roomRecordLabel(projection.room) ? (
                    <p className="bluplai-chat__record-context">
                      {roomRecordLabel(projection.room)}
                    </p>
                  ) : projection.room.topic ? (
                    <p>{projection.room.topic}</p>
                  ) : null}
                </div>
                <div className="bluplai-chat__room-actions">
                  {projection.members.length ? (
                    <div
                      className="bluplai-chat__member-stack"
                      title={`${projection.members.filter((member) => member.presence === "online").length} of ${projection.members.length} members online`}
                    >
                      <span className="bluplai-chat__sr-only">
                        {
                          projection.members.filter(
                            (member) => member.presence === "online",
                          ).length
                        }
                        /{projection.members.length} online
                      </span>
                      {projection.members.slice(0, 3).map((member) => (
                        <span
                          className="bluplai-chat__member-avatar"
                          key={member.id}
                        >
                          {member.avatarUrl ? (
                            <img alt="" src={member.avatarUrl} />
                          ) : (
                            member.displayName.slice(0, 1).toUpperCase()
                          )}
                          <i data-presence={member.presence} />
                        </span>
                      ))}
                      <span className="bluplai-chat__member-count">
                        {projection.members.length}
                      </span>
                    </div>
                  ) : null}
                  <button
                    aria-label="Search"
                    onClick={() => {
                      rememberFocus();
                      setSearchOpen(true);
                    }}
                    title="Search conversation"
                    type="button"
                  >
                    <ChatIcon name="search" />
                  </button>
                  {!readOnly &&
                  onManageMembers &&
                  projection.room.canManageMembers ? (
                    <button
                      aria-label="Members"
                      onClick={() => onManageMembers(projection.room)}
                      title="Manage members"
                      type="button"
                    >
                      <ChatIcon name="members" />
                    </button>
                  ) : null}
                  {!readOnly && onNotificationPreferenceChange ? (
                    <label
                      className="bluplai-chat__notification-select"
                      title="Notification preference"
                    >
                      <ChatIcon name="bell" />
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
                        <option value="mentions">Mentions only</option>
                        <option value="muted">Muted</option>
                      </select>
                      <ChatIcon name="chevron-down" />
                    </label>
                  ) : null}
                </div>
              </header>
              {roomContext ? (
                <div className="bluplai-chat__room-context">{roomContext}</div>
              ) : null}
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
                    mentionNames={[
                      ...projection.members.map((member) => member.displayName),
                      ...mentionProjects.map((project) => project.displayName),
                    ]}
                    onOpenThread={
                      !readOnly ||
                      (projection.repliesByRoot.get(message.id)?.length ?? 0) >
                        0
                        ? openThread
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
                  members={projection.members}
                  projects={mentionProjects}
                  roomId={projection.room.id}
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
                  searchGifs={searchGifs}
                />
              ) : null}
            </main>
          ) : (
            <div className="bluplai-chat__state">Select a room to begin.</div>
          )}
          {threadRoot && projection ? (
            <hr
              aria-label="Resize thread"
              aria-orientation="vertical"
              aria-valuemax={MAX_THREAD_WIDTH}
              aria-valuemin={MIN_THREAD_WIDTH}
              aria-valuenow={threadWidth}
              className="bluplai-chat__thread-resizer"
              onDoubleClick={() => updateThreadWidth(DEFAULT_THREAD_WIDTH)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft")
                  updateThreadWidth(threadWidth + 16);
                else if (event.key === "ArrowRight")
                  updateThreadWidth(threadWidth - 16);
                else if (event.key === "Home")
                  updateThreadWidth(MIN_THREAD_WIDTH);
                else if (event.key === "End")
                  updateThreadWidth(MAX_THREAD_WIDTH);
                else return;
                event.preventDefault();
              }}
              onPointerDown={(event) => {
                resizeStart.current = { x: event.clientX, width: threadWidth };
                event.currentTarget.setPointerCapture?.(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (!resizeStart.current) return;
                updateThreadWidth(
                  resizeStart.current.width +
                    resizeStart.current.x -
                    event.clientX,
                );
              }}
              onPointerUp={() => {
                resizeStart.current = null;
              }}
              tabIndex={0}
            />
          ) : null}
          {threadRoot && projection ? (
            <aside
              aria-label={`Thread replies to ${threadRoot.body}`}
              className="bluplai-chat__thread-panel"
              onKeyDown={(event) => {
                if (event.key === "Escape") closeThread();
              }}
            >
              <header>
                <strong>Thread</strong>
                <div className="bluplai-chat__thread-actions">
                  <button
                    aria-label={
                      threadExpanded ? "Restore split view" : "Expand thread"
                    }
                    onClick={() => setThreadExpanded((current) => !current)}
                    ref={threadExpandButton}
                    type="button"
                  >
                    <ChatIcon name={threadExpanded ? "shrink" : "expand"} />
                  </button>
                  <button
                    aria-label="Close thread"
                    onClick={closeThread}
                    ref={threadCloseButton}
                    type="button"
                  >
                    <ChatIcon name="x" />
                  </button>
                </div>
              </header>
              <MessageItem
                compact
                message={threadRoot}
                mentionNames={[
                  ...projection.members.map((member) => member.displayName),
                  ...mentionProjects.map((project) => project.displayName),
                ]}
                readState={projection.readState}
              />
              {threadReplies.map((reply) => (
                <MessageItem
                  compact
                  key={reply.id}
                  message={reply}
                  mentionNames={[
                    ...projection.members.map((member) => member.displayName),
                    ...mentionProjects.map((project) => project.displayName),
                  ]}
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
                  draftId={threadRoot.id}
                  members={projection.members}
                  projects={mentionProjects}
                  roomId={projection.room.id}
                  onCancelReply={closeThread}
                  onSubmit={send}
                  onTypingChange={
                    setTyping
                      ? (active) =>
                          setTyping(projection.room.id, {
                            active,
                            parentMessageId:
                              threadAiTarget?.id ?? threadRoot.id,
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
                  replyMode={threadAiTarget ? "ai" : "thread"}
                  replyToLabel={threadAiTarget?.author.displayName ?? "thread"}
                  roomName={projection.room.name}
                  searchGifs={searchGifs}
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
              closeButtonRef={searchCloseButton}
              onClose={closeSearch}
              onEscape={closeSearch}
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
              status={transport.searchMessages ? searchStatus : "idle"}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export { commandId };
