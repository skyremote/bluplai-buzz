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
}

/** A room visible to the current Bluplai organisation member. */
export interface ChatRoom {
  id: string;
  name: string;
  topic?: string | null;
  unreadCount: number;
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
}

/** Commands that the browser chat package may send to its host transport. */
export type AllowedChatCommand =
  | {
      type: "chat.send-message";
      roomId: string;
      body: string;
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
}
