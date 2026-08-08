/** A person or agent displayed in Bluplai Chat. */
export interface ChatAuthor {
  id: string;
  displayName: string;
  avatarUrl?: string | null;
  /** Distinguishes human replies from direct AI continuations. */
  role?: "owner" | "admin" | "member" | "guest" | "agent";
}

/** A viewer-relative aggregate reaction attached to a message. */
export interface ChatReaction {
  emoji: string;
  count: number;
  reactedByCurrentUser: boolean;
}

/** Durable media metadata carried by a signed chat event. */
export interface ChatAttachmentReference {
  id: string;
  sha256: string;
  name: string;
  contentType?: string | null;
  byteSize?: number | null;
  kind: "image" | "file";
}

/** A room-authorised media object resolved to a browser-safe URL by the host. */
export interface ChatAttachment {
  id: string;
  /** Optional for source compatibility; newly uploaded media always supplies it. */
  sha256?: string;
  name: string;
  contentType?: string | null;
  byteSize?: number | null;
  kind: "image" | "file";
  downloadUrl: string;
  thumbnailUrl?: string | null;
}

/** A provider-neutral GIF result supplied by the host application. */
export interface ChatGif {
  id: string;
  title: string;
  url: string;
  previewUrl: string;
  stillUrl?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface ChatMember extends ChatAuthor {
  presence: "online" | "away" | "offline";
  role: "owner" | "admin" | "member" | "guest" | "agent";
}

/** A project that can be referenced as structured AI context in chat. */
export interface ChatProjectReference {
  id: string;
  displayName: string;
  accountId: string;
  accountName?: string | null;
}

export interface ChatTypingIndicator {
  roomId: string;
  userId: string;
  displayName: string;
  threadRootId?: string | null;
}

export interface ChatTypingState {
  active: boolean;
  threadRootId?: string | null;
  parentMessageId?: string | null;
}

/** A browser-safe message projection supplied by a host transport. */
export interface ChatMessage {
  id: string;
  roomId: string;
  author: ChatAuthor;
  body: string;
  createdAt: string;
  editedAt?: string | null;
  parentMessageId?: string | null;
  threadRootId?: string | null;
  reactions: ChatReaction[];
  attachments?: ChatAttachment[];
  deliveryState?: "sending" | "sent" | "failed";
}

/** A room visible to the current Bluplai organisation member. */
export interface ChatRoom {
  id: string;
  conversationId?: string | null;
  name: string;
  topic?: string | null;
  unreadCount: number;
  disclosureScope?: "internal" | "shared" | "private" | "dm";
  accountId?: string | null;
  projectId?: string | null;
  canonicalRole?:
    | "account_internal"
    | "account_shared"
    | "project_internal"
    | "project_shared"
    | null;
  accountName?: string | null;
  projectName?: string | null;
  followed?: boolean;
  memberIds?: string[];
  notificationPreference?: "all" | "mentions" | "muted";
  canManageMembers?: boolean;
  /** True when the relay has durable history older than the retained window. */
  hasOlderMessages?: boolean;
}

/** The current viewer's monotonic room read frontier. */
export interface ChatReadState {
  roomId: string;
  lastReadAt: string;
  lastReadMessageId?: string | null;
}

/** Versioned permissions established by the authenticated gateway session. */
export interface ChatWorkspaceCapabilities {
  schemaVersion: 1;
  readOnly: boolean;
}

/** An atomic chat projection used for initial load and realtime replacement. */
export interface ChatWorkspaceSnapshot {
  capabilities: ChatWorkspaceCapabilities;
  activeRoomId: string | null;
  currentUserId: string;
  rooms: ChatRoom[];
  /** Projects the current viewer may explicitly add to Bluplai's AI scope. */
  projects?: ChatProjectReference[];
  messages: ChatMessage[];
  readStates: ChatReadState[];
  members?: ChatMember[];
  typing?: ChatTypingIndicator[];
}

/** Commands that the browser chat package may send to its host transport. */
export type AllowedChatCommand =
  | {
      type: "chat.send-message";
      roomId: string;
      body: string;
      mentionedUserIds?: string[];
      mentionedProjectIds?: string[];
      threadRootId?: string;
      parentMessageId?: string;
      attachments?: ChatAttachmentReference[];
    }
  | {
      type: "chat.add-reaction";
      roomId: string;
      messageId: string;
      emoji: string;
    }
  | {
      type: "chat.mark-read";
      roomId: string;
      messageId: string;
    };

/** Buzz developer surfaces deliberately excluded from Bluplai Chat. */
export type HiddenSurfaceCommand =
  | { type: "git.open-repository" }
  | { type: "workflow.run" }
  | { type: "project.open" }
  | { type: "canvas.open" }
  | { type: "huddle.start" }
  | { type: "acp.launch-agent" };

/** Every command accepted at the package's capability-enforcement boundary. */
export type ChatCommand = AllowedChatCommand | HiddenSurfaceCommand;

/** Host acknowledgement for a command that passed capability enforcement. */
export interface ChatCommandResult {
  ok: boolean;
  message?: string;
  eventId?: string;
}

/** Options passed to the transport's abortable initial workspace read. */
export interface LoadWorkspaceOptions {
  signal: AbortSignal;
}

export interface ChatHistoryLoadResult {
  hasMore: boolean;
}

/**
 * Browser-only boundary implemented by the host. Bluplai supplies a managed
 * gateway adapter; the Buzz desktop may supply a direct-relay adapter later.
 */
export interface BuzzChatTransport {
  /** Last authorised in-memory projection, used to avoid a loading flash on remount. */
  getSnapshot?(): ChatWorkspaceSnapshot | null;
  loadWorkspace(options: LoadWorkspaceOptions): Promise<ChatWorkspaceSnapshot>;
  subscribe(listener: (snapshot: ChatWorkspaceSnapshot) => void): () => void;
  execute(command: AllowedChatCommand): Promise<ChatCommandResult>;
  /** Server-backed room search; local filtering is only a compatibility fallback. */
  searchMessages?(
    roomId: string,
    query: string,
    signal: AbortSignal,
  ): Promise<ChatMessage[]>;
  /** Load the minimum message context needed to navigate to a search hit. */
  loadMessageContext?(
    roomId: string,
    messageId: string,
    signal: AbortSignal,
  ): Promise<ChatMessage[]>;
  /** Extend the retained room window by one server-issued history page. */
  loadOlderMessages?(
    roomId: string,
    signal: AbortSignal,
  ): Promise<ChatHistoryLoadResult>;
  /** Publish or stop the current viewer's ephemeral typing heartbeat. */
  setTyping?(roomId: string, state: ChatTypingState): void;
  uploadAttachment?(
    roomId: string,
    file: File,
    signal: AbortSignal,
  ): Promise<ChatAttachment>;
}
