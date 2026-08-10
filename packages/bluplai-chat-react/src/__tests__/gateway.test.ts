import { describe, expect, it, vi } from "vitest";
import {
  BuzzGatewaySession,
  ReadOnlySessionError,
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
    socket.receive({
      type: "authenticated",
      read_only: false,
      history_boundary: 1_786_000_123,
    });
    await connecting;
    expect(JSON.parse(socket.sent[1] ?? "")).toEqual({
      type: "subscribe",
      room_ids: ["room-1"],
      since: 1_786_000_123,
    });
    socket.receive({
      type: "accepted",
      result: { subscription_id: "subscription-1" },
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

  it("authenticates an empty workspace without sending an invalid subscription", async () => {
    FakeWebSocket.instances = [];
    const session = new BuzzGatewaySession({
      url: "wss://gateway.example.test/buzz-chat/ws",
      ticket: "bzt_empty",
      roomIds: [],
      onEvent: vi.fn(),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    const connecting = session.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("gateway socket was not constructed");
    socket.open();
    socket.receive({
      type: "authenticated",
      read_only: false,
      history_boundary: 1_786_000_123,
    });

    await expect(connecting).resolves.toEqual({
      schemaVersion: 1,
      readOnly: false,
      huddleStart: false,
    });
    expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "authenticate", ticket: "bzt_empty" },
    ]);
  });

  it("opens only the exact huddle.start capability advertised by the host", async () => {
    FakeWebSocket.instances = [];
    const session = new BuzzGatewaySession({
      url: "wss://gateway.example.test/buzz-chat/ws",
      ticket: "bzt_huddles",
      roomIds: [],
      onEvent: vi.fn(),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    const connecting = session.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("gateway socket was not constructed");
    socket.open();
    socket.receive({
      type: "authenticated",
      read_only: false,
      history_boundary: 1_786_000_123,
      capabilities: ["huddle.start", "huddle.end", "unknown.future"],
    });

    await expect(connecting).resolves.toEqual({
      schemaVersion: 1,
      readOnly: false,
      huddleStart: true,
    });
  });

  it("keeps Huddles fail-closed when the host omits or malforms capabilities", async () => {
    for (const capabilities of [undefined, ["huddle.end"], "huddle.start"]) {
      FakeWebSocket.instances = [];
      const session = new BuzzGatewaySession({
        url: "wss://gateway.example.test/buzz-chat/ws",
        ticket: "bzt_no_huddles",
        roomIds: [],
        onEvent: vi.fn(),
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      });
      const connecting = session.connect();
      const socket = FakeWebSocket.instances[0];
      if (!socket) throw new Error("gateway socket was not constructed");
      socket.open();
      socket.receive({
        type: "authenticated",
        read_only: false,
        history_boundary: 1_786_000_123,
        ...(capabilities === undefined ? {} : { capabilities }),
      });

      await expect(connecting).resolves.toEqual({
        schemaVersion: 1,
        readOnly: false,
        huddleStart: false,
      });
    }
  });

  it("publishes only bounded presence and typing commands", async () => {
    FakeWebSocket.instances = [];
    const session = new BuzzGatewaySession({
      url: "wss://gateway.example.test/buzz-chat/ws",
      ticket: "bzt_ephemeral",
      roomIds: ["room-1"],
      onEvent: vi.fn(),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    const connecting = session.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("gateway socket was not constructed");
    socket.open();
    socket.receive({
      type: "authenticated",
      read_only: false,
      history_boundary: 1_786_000_123,
    });
    await connecting;

    const presence = session.publishPresence("room-1", "online");
    const typing = session.publishTyping("room-1", {
      parentMessageId: "d".repeat(64),
      threadRootId: "c".repeat(64),
    });
    expect(JSON.parse(socket.sent[2] ?? "")).toMatchObject({
      type: "presence",
      room_id: "room-1",
      status: "online",
    });
    expect(JSON.parse(socket.sent[3] ?? "")).toMatchObject({
      type: "typing",
      room_id: "room-1",
      parent_event_id: "d".repeat(64),
      thread_root_id: "c".repeat(64),
    });
    socket.receive({ type: "accepted", result: { event_id: "1".repeat(64) } });
    socket.receive({ type: "accepted", result: { event_id: "2".repeat(64) } });
    await expect(presence).resolves.toBeUndefined();
    await expect(typing).resolves.toBeUndefined();
  });

  it("chunks more than 100 rooms into one canonical subscription command", async () => {
    FakeWebSocket.instances = [];
    const roomIds = Array.from(
      { length: 101 },
      (_, index) => `room-${index + 1}`,
    );
    const session = new BuzzGatewaySession({
      url: "wss://gateway.example.test/buzz-chat/ws",
      ticket: "bzt_many_rooms",
      roomIds,
      onEvent: vi.fn(),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    const connecting = session.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("gateway socket was not constructed");
    socket.open();
    socket.receive({
      type: "authenticated",
      read_only: false,
      history_boundary: 1_786_000_123,
    });

    await connecting;
    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[1] ?? "")).toEqual({
      type: "subscribe",
      room_id_chunks: [roomIds.slice(0, 100), roomIds.slice(100)],
      since: 1_786_000_123,
    });
  });

  it("rejects connect when the socket closes or the caller aborts before authentication", async () => {
    FakeWebSocket.instances = [];
    const closedSession = new BuzzGatewaySession({
      url: "wss://gateway.example.test/buzz-chat/ws",
      ticket: "bzt_closed",
      roomIds: ["room-1"],
      onEvent: vi.fn(),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    const closedConnection = closedSession.connect();
    const closedSocket = FakeWebSocket.instances[0];
    if (!closedSocket) throw new Error("gateway socket was not constructed");
    closedSocket.close();
    await expect(closedConnection).rejects.toThrow("gateway connection closed");

    const controller = new AbortController();
    const abortedSession = new BuzzGatewaySession({
      url: "wss://gateway.example.test/buzz-chat/ws",
      ticket: "bzt_aborted",
      roomIds: ["room-1"],
      onEvent: vi.fn(),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    const abortedConnection = abortedSession.connect(controller.signal);
    controller.abort();
    await expect(abortedConnection).rejects.toThrow(
      "gateway connection aborted",
    );

    const disposedSession = new BuzzGatewaySession({
      url: "wss://gateway.example.test/buzz-chat/ws",
      ticket: "bzt_disposed",
      roomIds: ["room-1"],
      onEvent: vi.fn(),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    const disposedConnection = disposedSession.connect();
    disposedSession.close();
    await expect(disposedConnection).rejects.toThrow(
      "gateway session disposed",
    );
  });

  it("clears an established session capability when the gateway closes", async () => {
    FakeWebSocket.instances = [];
    const states: string[] = [];
    const session = new BuzzGatewaySession({
      url: "wss://chat.example/ws",
      ticket: "bzt_established_close",
      roomIds: ["room-1"],
      onEvent: vi.fn(),
      onState: (state) => states.push(state),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    const connection = session.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("gateway socket was not constructed");
    socket.open();
    socket.receive({
      type: "authenticated",
      read_only: false,
      history_boundary: 1_786_000_123,
    });
    await connection;

    socket.close();

    await expect(session.execute({ type: "send_message" })).rejects.toThrow(
      "Bluplai Chat session is read-only",
    );
    expect(states).toEqual(["connecting", "connected", "closed"]);
  });

  it("correlates paginated history and server search independently of live subscription", async () => {
    FakeWebSocket.instances = [];
    const session = new BuzzGatewaySession({
      url: "wss://gateway.example.test/buzz-chat/ws",
      ticket: "bzt_history",
      roomIds: ["room-1"],
      onEvent: vi.fn(),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    const connecting = session.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("gateway socket was not constructed");
    socket.open();
    socket.receive({
      type: "authenticated",
      read_only: false,
      history_boundary: 1_786_000_123,
    });
    await connecting;

    const history = session.history(
      "room-1",
      { createdAt: 1_786_000_000, eventId: "c".repeat(64) },
      100,
    );
    const search = session.search("room-1", "archived result", 25);
    const historyRequest = JSON.parse(socket.sent[2] ?? "");
    const searchRequest = JSON.parse(socket.sent[3] ?? "");
    expect(historyRequest).toMatchObject({
      type: "history",
      room_id: "room-1",
      cursor: { created_at: 1_786_000_000, event_id: "c".repeat(64) },
      limit: 100,
    });
    expect(searchRequest).toMatchObject({
      type: "search",
      room_id: "room-1",
      query: "archived result",
      limit: 25,
    });

    const searchEvent = event({
      id: "1".repeat(64),
      content: "archived result",
    });
    socket.receive({
      type: "accepted",
      request_id: searchRequest.request_id,
      result: { events: [searchEvent] },
    });
    socket.receive({
      type: "accepted",
      request_id: historyRequest.request_id,
      result: {
        events: [event()],
        has_more: true,
        next_cursor: { created_at: 1_785_999_999, event_id: "e".repeat(64) },
      },
    });

    await expect(search).resolves.toEqual([searchEvent]);
    await expect(history).resolves.toEqual({
      events: [event()],
      hasMore: true,
      nextCursor: { createdAt: 1_785_999_999, eventId: "e".repeat(64) },
    });
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

  it("retains authenticated read-only capabilities and rejects writes before the socket", async () => {
    FakeWebSocket.instances = [];
    const session = new BuzzGatewaySession({
      url: "wss://gateway.example.test/buzz-chat/ws",
      ticket: "bzt_read_only",
      roomIds: ["room-1"],
      onEvent: vi.fn(),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    const connecting = session.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("gateway socket was not constructed");
    socket.open();
    socket.receive({
      type: "authenticated",
      read_only: true,
      history_boundary: 1_786_000_123,
    });

    await expect(connecting).resolves.toEqual({
      schemaVersion: 1,
      readOnly: true,
      huddleStart: false,
    });
    const sentBeforeWrite = socket.sent.length;
    const history = session.history("room-1", null, 10);
    const historyRequest = JSON.parse(socket.sent.at(-1) ?? "");
    socket.receive({
      type: "accepted",
      request_id: historyRequest.request_id,
      result: { events: [], has_more: false, next_cursor: null },
    });
    await expect(history).resolves.toEqual({
      events: [],
      hasMore: false,
      nextCursor: null,
    });
    await expect(
      session.execute({ type: "send_message", room_id: "room-1" }),
    ).rejects.toBeInstanceOf(ReadOnlySessionError);
    expect(socket.sent).toHaveLength(sentBeforeWrite + 1);
  });
});
