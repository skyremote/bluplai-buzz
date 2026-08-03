import { describe, expect, it, vi } from "vitest";
import {
  BuzzGatewaySession,
  eventReactionTarget,
  eventReplyTarget,
  eventRoomId,
  isNostrEvent,
  type NostrEvent,
} from "../index";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

function event(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "e".repeat(64),
    pubkey: "a".repeat(64),
    created_at: 1_786_000_000,
    kind: 9,
    tags: [["h", "room-1"]],
    content: "hello",
    sig: "b".repeat(128),
    ...overrides,
  };
}

describe("managed browser gateway", () => {
  it("authenticates first, subscribes, routes events, and resolves commands", async () => {
    FakeWebSocket.instances = [];
    const onEvent = vi.fn();
    const session = new BuzzGatewaySession({
      url: "wss://gateway.example.test/buzz-chat/ws",
      ticket: "bzt_one_time",
      roomIds: ["room-1"],
      onEvent,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    const connecting = session.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("gateway socket was not constructed");
    socket.open();
    expect(JSON.parse(socket.sent[0] ?? "")).toEqual({
      type: "authenticate",
      ticket: "bzt_one_time",
    });
    socket.receive({ type: "authenticated", read_only: false });
    await connecting;
    expect(JSON.parse(socket.sent[1] ?? "")).toEqual({
      type: "subscribe",
      room_ids: ["room-1"],
    });

    const accepted = session.execute({
      type: "send_message",
      command_id: "web_12345678",
      room_id: "room-1",
      content: "hello",
    });
    const relayEvent = event();
    socket.receive({
      type: "relay",
      frame: ["EVENT", "subscription-1", relayEvent],
    });
    socket.receive({ type: "accepted", result: { event_id: relayEvent.id } });
    expect(onEvent).toHaveBeenCalledWith(relayEvent);
    await expect(accepted).resolves.toEqual({ event_id: relayEvent.id });
    session.close();
    expect(socket.readyState).toBe(3);
  });

  it("validates events and extracts only bounded room/thread/reaction tags", () => {
    const reply = event({
      tags: [
        ["h", "room-1"],
        ["e", "c".repeat(64), "", "reply"],
      ],
    });
    const reaction = event({
      kind: 7,
      tags: [
        ["h", "room-1"],
        ["e", "d".repeat(64)],
      ],
    });
    expect(isNostrEvent(reply)).toBe(true);
    expect(isNostrEvent({ ...reply, id: "not-an-event" })).toBe(false);
    expect(eventRoomId(reply)).toBe("room-1");
    expect(eventReplyTarget(reply)).toBe("c".repeat(64));
    expect(eventReactionTarget(reaction)).toBe("d".repeat(64));
    expect(eventReactionTarget(reply)).toBeNull();
  });
});
