import type { ChatWorkspaceCapabilities } from "./types";

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface GatewayConnectionOptions {
  url: string;
  ticket: string;
  roomIds: string[];
  onEvent: (event: NostrEvent) => void;
  onState?: (state: "connecting" | "connected" | "closed") => void;
  WebSocketImpl?: typeof WebSocket;
}

type GatewayFrame =
  | { type: "authenticated"; read_only: boolean; history_boundary: number }
  | {
      type: "accepted";
      result: Record<string, unknown>;
      request_id?: string;
    }
  | { type: "relay"; frame: unknown[] };

export interface GatewayHistoryCursor {
  createdAt: number;
  eventId: string;
}

export interface GatewayHistoryPage {
  events: NostrEvent[];
  hasMore: boolean;
  nextCursor: GatewayHistoryCursor | null;
}

export interface GatewayTypingContext {
  threadRootId?: string | null;
  parentMessageId?: string | null;
}

const MAX_ROOM_IDS_PER_CHUNK = 100;

function ephemeralCommandId(prefix: "presence" | "typing"): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function roomIdChunks(roomIds: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < roomIds.length; index += MAX_ROOM_IDS_PER_CHUNK) {
    chunks.push(roomIds.slice(index, index + MAX_ROOM_IDS_PER_CHUNK));
  }
  return chunks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNostrEvent(value: unknown): value is NostrEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    /^[0-9a-f]{64}$/.test(value.id) &&
    typeof value.pubkey === "string" &&
    typeof value.created_at === "number" &&
    typeof value.kind === "number" &&
    Array.isArray(value.tags) &&
    typeof value.content === "string" &&
    typeof value.sig === "string"
  );
}

export function eventRoomId(event: NostrEvent): string | null {
  return event.tags.find((tag) => tag[0] === "h")?.[1] ?? null;
}

export function eventReplyTarget(event: NostrEvent): string | null {
  return (
    event.tags.find((tag) => tag[0] === "e" && tag[3] === "reply")?.[1] ?? null
  );
}

export function eventReactionTarget(event: NostrEvent): string | null {
  if (event.kind !== 7) return null;
  return event.tags.find((tag) => tag[0] === "e")?.[1] ?? null;
}

/**
 * One authenticated, ticket-bound browser session. It deliberately exposes
 * only the bounded high-level commands accepted by Bluplai's signing gateway.
 */
export class BuzzGatewaySession {
  private readonly options: GatewayConnectionOptions;
  private socket: WebSocket | null = null;
  private sessionCapabilities: ChatWorkspaceCapabilities | null = null;
  private failPendingConnection: ((message: string) => void) | null = null;
  private readonly pending: Array<{
    resolve: (result: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }> = [];
  private readonly pendingReads = new Map<
    string,
    {
      resolve: (result: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(options: GatewayConnectionOptions) {
    this.options = options;
  }

  async connect(signal?: AbortSignal): Promise<ChatWorkspaceCapabilities> {
    if (this.sessionCapabilities) return this.sessionCapabilities;
    if (this.socket) throw new Error("gateway connection is already pending");
    if (signal?.aborted) throw new Error("gateway connection aborted");
    const Socket = this.options.WebSocketImpl ?? WebSocket;
    this.options.onState?.("connecting");
    return new Promise<ChatWorkspaceCapabilities>((resolve, reject) => {
      const socket = new Socket(this.options.url);
      this.socket = socket;
      let settled = false;
      const cleanup = () => {
        signal?.removeEventListener("abort", abort);
        if (this.failPendingConnection === fail) {
          this.failPendingConnection = null;
        }
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        if (this.socket === socket) this.socket = null;
        cleanup();
        reject(new Error(message));
      };
      const abort = () => {
        fail("gateway connection aborted");
        socket.close(1000, "aborted");
      };
      this.failPendingConnection = fail;
      signal?.addEventListener("abort", abort, { once: true });
      socket.onopen = () => {
        socket.send(
          JSON.stringify({ type: "authenticate", ticket: this.options.ticket }),
        );
      };
      socket.onerror = () => fail("gateway connection failed");
      socket.onclose = () => {
        if (this.socket === socket) this.socket = null;
        this.sessionCapabilities = null;
        this.options.onState?.("closed");
        fail("gateway connection closed");
        this.rejectPending("gateway connection closed");
      };
      socket.onmessage = (message) => {
        let frame: GatewayFrame;
        try {
          frame = JSON.parse(String(message.data)) as GatewayFrame;
        } catch {
          socket.close(1002, "invalid frame");
          return;
        }
        if (frame.type === "authenticated") {
          if (
            typeof frame.read_only !== "boolean" ||
            !Number.isSafeInteger(frame.history_boundary) ||
            frame.history_boundary < 0
          ) {
            socket.close(1002, "invalid authenticated frame");
            fail("gateway authentication capabilities are invalid");
            return;
          }
          this.sessionCapabilities = Object.freeze({
            schemaVersion: 1,
            readOnly: frame.read_only,
          });
          this.options.onState?.("connected");
          if (this.options.roomIds.length > 0) {
            const chunks = roomIdChunks(this.options.roomIds);
            socket.send(
              JSON.stringify({
                type: "subscribe",
                ...(chunks.length === 1
                  ? { room_ids: chunks[0] }
                  : { room_id_chunks: chunks }),
                since: frame.history_boundary,
              }),
            );
          }
          settled = true;
          cleanup();
          resolve(this.sessionCapabilities);
          return;
        }
        if (frame.type === "relay") {
          const relay = frame.frame;
          if (relay[0] === "EVENT" && isNostrEvent(relay[2])) {
            this.options.onEvent(relay[2]);
          }
          return;
        }
        if (frame.type === "accepted") {
          if (frame.request_id) {
            const pending = this.pendingReads.get(frame.request_id);
            if (pending) {
              this.pendingReads.delete(frame.request_id);
              pending.resolve(frame.result);
            }
            return;
          }
          if (typeof frame.result.subscription_id === "string") return;
          this.pending.shift()?.resolve(frame.result);
        }
      };
    });
  }

  execute(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.sessionCapabilities?.readOnly !== false) {
      return Promise.reject(new ReadOnlySessionError());
    }
    const socket = this.socket;
    if (socket?.readyState !== 1) {
      return Promise.reject(new Error("gateway is not connected"));
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      socket.send(JSON.stringify(command));
    });
  }

  async history(
    roomId: string,
    cursor: GatewayHistoryCursor | null,
    limit = 100,
  ): Promise<GatewayHistoryPage> {
    const result = await this.readRequest({
      type: "history",
      room_id: roomId,
      cursor: cursor
        ? { created_at: cursor.createdAt, event_id: cursor.eventId }
        : null,
      limit,
    });
    const events = result.events;
    const next = result.next_cursor;
    if (
      !Array.isArray(events) ||
      !events.every(isNostrEvent) ||
      typeof result.has_more !== "boolean" ||
      !(
        next === null ||
        (isRecord(next) &&
          Number.isSafeInteger(next.created_at) &&
          typeof next.event_id === "string" &&
          /^[0-9a-f]{64}$/.test(next.event_id))
      )
    ) {
      throw new Error("gateway history response is invalid");
    }
    return {
      events,
      hasMore: result.has_more,
      nextCursor:
        next === null
          ? null
          : {
              createdAt: next.created_at as number,
              eventId: next.event_id as string,
            },
    };
  }

  async search(
    roomId: string,
    query: string,
    limit = 50,
  ): Promise<NostrEvent[]> {
    const result = await this.readRequest({
      type: "search",
      room_id: roomId,
      query,
      limit,
    });
    if (!Array.isArray(result.events) || !result.events.every(isNostrEvent)) {
      throw new Error("gateway search response is invalid");
    }
    return result.events;
  }

  async publishPresence(
    roomId: string,
    status: "online" | "away" | "offline",
  ): Promise<void> {
    await this.execute({
      type: "presence",
      command_id: ephemeralCommandId("presence"),
      room_id: roomId,
      status,
    });
  }

  async publishTyping(
    roomId: string,
    context: GatewayTypingContext = {},
  ): Promise<void> {
    await this.execute({
      type: "typing",
      command_id: ephemeralCommandId("typing"),
      room_id: roomId,
      thread_root_id: context.threadRootId ?? null,
      parent_event_id: context.parentMessageId ?? null,
    });
  }

  close(): void {
    const socket = this.socket;
    this.failPendingConnection?.("gateway session disposed");
    this.socket = null;
    this.sessionCapabilities = null;
    if (socket && socket.readyState < 2) {
      socket.close(1000, "workspace disposed");
    }
    this.rejectPending("gateway session disposed");
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.splice(0)) {
      pending.reject(new Error(message));
    }
    for (const pending of this.pendingReads.values()) {
      pending.reject(new Error(message));
    }
    this.pendingReads.clear();
  }

  private readRequest(
    command: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!this.sessionCapabilities || socket?.readyState !== 1) {
      return Promise.reject(new Error("gateway is not connected"));
    }
    const requestId = `read_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
    return new Promise((resolve, reject) => {
      this.pendingReads.set(requestId, { resolve, reject });
      socket.send(JSON.stringify({ ...command, request_id: requestId }));
    });
  }
}

/** Stable failure for writes attempted before or during a read-only session. */
export class ReadOnlySessionError extends Error {
  readonly code = "READ_ONLY_SESSION";

  constructor() {
    super("Bluplai Chat session is read-only");
    this.name = "ReadOnlySessionError";
  }
}
