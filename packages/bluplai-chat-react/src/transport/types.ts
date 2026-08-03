/** A person or agent displayed in Bluplai Chat. */
export interface ChatAuthor {
  id: string;
  displayName: string;
  avatarUrl?: string | null;
}

/** A viewer-relative aggregate reaction attached to a message. */
export interface ChatReaction {
  emoji: string;
  count: number;
  reactedByCurrentUser: boolean;
}

/** A room-authorised media object. The URL always points back at Bluplai. */
export interface ChatAttachment {
  id: string;
  name: string;
  contentType?: string | null;
  byteSize?: number | null;
  kind: "image" | "file";
  downloadUrl: string;
  thumbnailUrl?: string | null;
}

export interface ChatMember extends ChatAuthor {
  presence: "online" | "away" | "offline";
  role: "owner" | "admin" | "member" | "guest" | "agent";
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
  memberIds?: string[];
  notificationPreference?: "all" | "mentions" | "muted";
  canManageMembers?: boolean;
}

/** The current viewer's monotonic room read frontier. */
export interface ChatReadState {
  roomId: string;
  lastReadAt: string;
  lastReadMessageId?: string | null;
}

/** An atomic chat projection used for initial load and realtime replacement. */
export interface ChatWorkspaceSnapshot {
  activeRoomId: string | null;
  currentUserId: string;
  rooms: ChatRoom[];
  messages: ChatMessage[];
  readStates: ChatReadState[];
  members?: ChatMember[];
}

/** Commands that the browser chat package may send to its host transport. */
export type AllowedChatCommand =
  | {
      type: "chat.send-message";
      roomId: string;
      body: string;
      mentionedUserIds?: string[];
      threadRootId?: string;
      parentMessageId?: string;
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

/**
 * Browser-only boundary implemented by the host. Bluplai supplies a managed
 * gateway adapter; the Buzz desktop may supply a direct-relay adapter later.
 */
export interface BuzzChatTransport {
  loadWorkspace(options: LoadWorkspaceOptions): Promise<ChatWorkspaceSnapshot>;
  subscribe(listener: (snapshot: ChatWorkspaceSnapshot) => void): () => void;
  execute(command: AllowedChatCommand): Promise<ChatCommandResult>;
  uploadAttachment?(
    roomId: string,
    file: File,
    signal: AbortSignal,
  ): Promise<ChatAttachment>;
}
