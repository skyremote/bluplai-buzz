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
  | { type: "authenticated"; read_only: boolean }
  | { type: "accepted"; result: Record<string, unknown> }
  | { type: "relay"; frame: unknown[] };

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
 * only the four high-level commands accepted by Bluplai's signing gateway.
 */
export class BuzzGatewaySession {
  private readonly options: GatewayConnectionOptions;
  private socket: WebSocket | null = null;
  private readonly pending: Array<{
    resolve: (result: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(options: GatewayConnectionOptions) {
    this.options = options;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.socket) return;
    const Socket = this.options.WebSocketImpl ?? WebSocket;
    this.options.onState?.("connecting");
    await new Promise<void>((resolve, reject) => {
      const socket = new Socket(this.options.url);
      this.socket = socket;
      const fail = (message: string) => {
        this.socket = null;
        reject(new Error(message));
      };
      const abort = () => {
        socket.close(1000, "aborted");
        fail("gateway connection aborted");
      };
      signal?.addEventListener("abort", abort, { once: true });
      socket.onopen = () => {
        socket.send(
          JSON.stringify({ type: "authenticate", ticket: this.options.ticket }),
        );
      };
      socket.onerror = () => fail("gateway connection failed");
      socket.onclose = () => {
        this.options.onState?.("closed");
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
          this.options.onState?.("connected");
          socket.send(
            JSON.stringify({
              type: "subscribe",
              room_ids: this.options.roomIds,
            }),
          );
          signal?.removeEventListener("abort", abort);
          resolve();
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
          this.pending.shift()?.resolve(frame.result);
        }
      };
    });
  }

  execute(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (socket?.readyState !== 1) {
      return Promise.reject(new Error("gateway is not connected"));
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      socket.send(JSON.stringify(command));
    });
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < 2) {
      socket.close(1000, "workspace disposed");
    }
    this.rejectPending("gateway session disposed");
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.splice(0)) {
      pending.reject(new Error(message));
    }
  }
}
