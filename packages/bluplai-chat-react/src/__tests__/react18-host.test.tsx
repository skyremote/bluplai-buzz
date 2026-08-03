import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BluplaiChat,
  CapabilityDeniedError,
  ReadOnlySessionError,
  executeChatCommand,
  type BuzzChatTransport,
  type ChatAttachment,
  type ChatCommand,
  type ChatWorkspaceSnapshot,
} from "../index";

const workspace: ChatWorkspaceSnapshot = {
  capabilities: { schemaVersion: 1, readOnly: false },
  activeRoomId: "room-general",
  currentUserId: "user-daniel",
  rooms: [
    {
      id: "room-general",
      name: "General",
      topic: "Customer outcomes",
      unreadCount: 1,
    },
    {
      id: "room-ideas",
      name: "Ideas",
      unreadCount: 0,
    },
  ],
  messages: [
    {
      id: "message-root",
      roomId: "room-general",
      author: { id: "user-leandro", displayName: "Leandro" },
      body: "Launch plan",
      createdAt: "2026-08-03T08:00:00.000Z",
      reactions: [
        {
          emoji: "👍",
          count: 2,
          reactedByCurrentUser: true,
        },
      ],
    },
    {
      id: "message-reply",
      roomId: "room-general",
      author: { id: "user-daniel", displayName: "Daniel" },
      body: "Ship the compatibility gate first",
      createdAt: "2026-08-03T08:05:00.000Z",
      threadRootId: "message-root",
      parentMessageId: "message-root",
      reactions: [],
    },
  ],
  readStates: [
    {
      roomId: "room-general",
      lastReadAt: "2026-08-03T08:02:00.000Z",
      lastReadMessageId: "message-root",
    },
  ],
};

function createTransport(snapshot: ChatWorkspaceSnapshot = workspace) {
  const commands: ChatCommand[] = [];
  const disconnect = vi.fn();
  const transport: BuzzChatTransport = {
    execute: vi.fn(async (command) => {
      commands.push(command);
      return { ok: true };
    }),
    loadWorkspace: vi.fn(async () => snapshot),
    subscribe: vi.fn(() => disconnect),
  };

  return { commands, disconnect, transport };
}

afterEach(() => {
  cleanup();
});

describe("React 18 host compatibility", () => {
  it("mounts and unmounts under React 18.3 without owning the host runtime", async () => {
    expect(React.version).toBe("18.3.1");
    const { disconnect, transport } = createTransport();

    const mounted = render(<BluplaiChat transport={transport} />);

    expect(
      await screen.findByRole("heading", {
        name: "Bluplai Chat, powered by Buzz",
      }),
    ).toBeTruthy();
    mounted.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("renders rooms, threads, reactions, and read state from the transport", async () => {
    const { transport } = createTransport();
    render(<BluplaiChat transport={transport} />);

    expect(
      await screen.findByRole("button", { name: "General, 1 unread" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ideas" })).toBeTruthy();

    const root = screen.getByRole("article", { name: "Message from Leandro" });
    expect(within(root).getByText("Launch plan")).toBeTruthy();
    expect(within(root).getByLabelText("Read message")).toBeTruthy();
    expect(
      within(root).getByRole("button", {
        name: "👍 reaction, 2 people, you reacted",
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "1 reply" }));
    const thread = screen.getByRole("complementary", {
      name: "Thread replies to Launch plan",
    });
    expect(
      within(thread).getByText("Ship the compatibility gate first"),
    ).toBeTruthy();
    expect(within(thread).getByLabelText("Unread message")).toBeTruthy();
  });

  it("renders a recoverable error instead of an empty or desktop-only shell", async () => {
    const { transport } = createTransport();
    transport.loadWorkspace = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });

    render(<BluplaiChat transport={transport} />);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Unable to load Bluplai Chat: gateway unavailable",
    );
  });

  it("renders an intentional empty state when no rooms are available", async () => {
    const { transport } = createTransport({
      capabilities: { schemaVersion: 1, readOnly: false },
      activeRoomId: null,
      currentUserId: "user-daniel",
      messages: [],
      readStates: [],
      rooms: [],
    });

    render(<BluplaiChat transport={transport} />);

    expect(
      await screen.findByText("No chat rooms are available."),
    ).toBeTruthy();
  });

  it("sends through the bounded composer and searches the active room", async () => {
    const { commands, transport } = createTransport();
    render(<BluplaiChat transport={transport} />);
    const composer = await screen.findByRole("textbox", {
      name: "Message General",
    });
    fireEvent.change(composer, { target: { value: "We should ship" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(
        commands.some(
          (command) =>
            command.type === "chat.send-message" &&
            command.body === "We should ship",
        ),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const search = screen.getByRole("searchbox", {
      name: "Search messages",
    });
    fireEvent.change(search, { target: { value: "compatibility" } });
    expect(screen.getByText("Ship the compatibility gate first")).toBeTruthy();
  });

  it("uses server-backed search when the host exposes history search", async () => {
    const { transport } = createTransport();
    transport.searchMessages = vi.fn(async () => [
      {
        id: "archived-message",
        roomId: "room-general",
        author: { id: "user-leandro", displayName: "Leandro" },
        body: "Archived server-only customer decision",
        createdAt: "2024-01-01T08:00:00.000Z",
        reactions: [],
      },
    ]);
    render(<BluplaiChat transport={transport} />);
    await screen.findByRole("button", { name: "Search" });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search messages" }),
      { target: { value: "customer decision" } },
    );

    expect(
      await screen.findByText("Archived server-only customer decision"),
    ).toBeTruthy();
    expect(transport.searchMessages).toHaveBeenCalledWith(
      "room-general",
      "customer decision",
      expect.any(AbortSignal),
    );
  });

  it("loads older room history on demand and hides the control at exhaustion", async () => {
    const historyWorkspace: ChatWorkspaceSnapshot = {
      ...workspace,
      rooms: workspace.rooms.map((room) =>
        room.id === "room-general" ? { ...room, hasOlderMessages: true } : room,
      ),
    };
    const { transport } = createTransport(historyWorkspace);
    transport.loadOlderMessages = vi.fn(async () => ({ hasMore: false }));
    render(<BluplaiChat transport={transport} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Load older messages" }),
    );

    await waitFor(() =>
      expect(transport.loadOlderMessages).toHaveBeenCalledWith(
        "room-general",
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Load older messages" }),
      ).toBeNull(),
    );
  });

  it("loads server context before navigating to an archived reply", async () => {
    const { transport } = createTransport();
    const archivedRoot = {
      id: "archived-root",
      roomId: "room-general",
      author: { id: "user-daniel", displayName: "Daniel" },
      body: "Archived root decision",
      createdAt: "2024-01-01T07:00:00.000Z",
      reactions: [],
    };
    const archivedReply = {
      id: "archived-reply",
      roomId: "room-general",
      author: { id: "user-leandro", displayName: "Leandro" },
      body: "Archived reply evidence",
      createdAt: "2024-01-01T08:00:00.000Z",
      parentMessageId: archivedRoot.id,
      threadRootId: archivedRoot.id,
      reactions: [],
    };
    transport.searchMessages = vi.fn(async () => [archivedReply]);
    transport.loadMessageContext = vi.fn(async () => [
      archivedRoot,
      archivedReply,
    ]);
    render(<BluplaiChat transport={transport} />);
    fireEvent.click(await screen.findByRole("button", { name: "Search" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search messages" }),
      { target: { value: "reply evidence" } },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Archived reply evidence/ }),
    );

    await waitFor(() =>
      expect(transport.loadMessageContext).toHaveBeenCalledWith(
        "room-general",
        "archived-reply",
        expect.any(AbortSignal),
      ),
    );
    const thread = await screen.findByRole("complementary", {
      name: "Thread replies to Archived root decision",
    });
    expect(within(thread).getByText("Archived root decision")).toBeTruthy();
    expect(within(thread).getByText("Archived reply evidence")).toBeTruthy();
    expect(screen.getAllByText("Archived root decision")).toHaveLength(1);
    expect(
      screen.queryByRole("searchbox", { name: "Search messages" }),
    ).toBeNull();
  });

  it("sends durable attachment references instead of browser URLs", async () => {
    const { commands, transport } = createTransport();
    transport.uploadAttachment = vi.fn(async () => ({
      id: "media-1",
      sha256: "a".repeat(64),
      name: "launch.png",
      contentType: "image/png",
      byteSize: 4,
      kind: "image" as const,
      downloadUrl: "blob:local-preview",
      thumbnailUrl: "blob:local-thumbnail",
    }));
    render(<BluplaiChat transport={transport} />);

    await screen.findByRole("textbox", { name: "Message General" });
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("attachment input was not rendered");
    fireEvent.change(input, {
      target: {
        files: [new File(["data"], "launch.png", { type: "image/png" })],
      },
    });
    await screen.findByText("launch.png");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(
        commands.find((command) => command.type === "chat.send-message"),
      ).toEqual({
        type: "chat.send-message",
        roomId: "room-general",
        body: "",
        attachments: [
          {
            id: "media-1",
            sha256: "a".repeat(64),
            name: "launch.png",
            contentType: "image/png",
            byteSize: 4,
            kind: "image",
          },
        ],
      }),
    );
  });

  it("uploads and sends durable attachments from a thread composer", async () => {
    const { commands, transport } = createTransport();
    transport.uploadAttachment = vi.fn(async () => ({
      id: "media-thread-1",
      sha256: "b".repeat(64),
      name: "thread-evidence.pdf",
      contentType: "application/pdf",
      byteSize: 8,
      kind: "file" as const,
      downloadUrl: "blob:thread-preview",
    }));
    render(<BluplaiChat transport={transport} />);

    fireEvent.click(await screen.findByRole("button", { name: "1 reply" }));
    const thread = screen.getByRole("complementary", {
      name: "Thread replies to Launch plan",
    });
    const input = thread.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("thread attachment input was not rendered");
    fireEvent.change(input, {
      target: {
        files: [
          new File(["evidence"], "thread-evidence.pdf", {
            type: "application/pdf",
          }),
        ],
      },
    });
    await within(thread).findByText("thread-evidence.pdf");
    fireEvent.click(within(thread).getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(
        commands.find(
          (command) =>
            command.type === "chat.send-message" &&
            command.threadRootId === "message-root",
        ),
      ).toEqual({
        type: "chat.send-message",
        roomId: "room-general",
        body: "",
        threadRootId: "message-root",
        parentMessageId: "message-root",
        attachments: [
          {
            id: "media-thread-1",
            sha256: "b".repeat(64),
            name: "thread-evidence.pdf",
            contentType: "application/pdf",
            byteSize: 8,
            kind: "file",
          },
        ],
      }),
    );
  });

  it("aborts an active attachment upload when the composer unmounts", async () => {
    const { transport } = createTransport();
    let uploadSignal: AbortSignal | undefined;
    transport.uploadAttachment = vi.fn((_roomId, _file, signal) => {
      uploadSignal = signal;
      return new Promise<ChatAttachment>(() => undefined);
    });
    const mounted = render(<BluplaiChat transport={transport} />);
    await screen.findByRole("textbox", { name: "Message General" });
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("attachment input was not rendered");
    fireEvent.change(input, {
      target: {
        files: [new File(["data"], "pending.png", { type: "image/png" })],
      },
    });
    await waitFor(() => expect(uploadSignal).toBeInstanceOf(AbortSignal));

    mounted.unmount();

    expect(uploadSignal?.aborted).toBe(true);
  });

  it("supports a compact room-only sidecar surface", async () => {
    const { commands, transport } = createTransport();
    render(<BluplaiChat compact mode="rail" transport={transport} />);
    expect(
      await screen.findByRole("button", { name: "General, 1 unread" }),
    ).toBeTruthy();
    expect(screen.queryByRole("main")).toBeNull();
    await waitFor(() => expect(transport.loadWorkspace).toHaveBeenCalledOnce());
    expect(commands).toEqual([]);
  });

  it("hides every mutation and does not dispatch read state in a read-only workspace", async () => {
    const readOnlyWorkspace: ChatWorkspaceSnapshot = {
      ...workspace,
      capabilities: { schemaVersion: 1, readOnly: true },
      rooms: workspace.rooms.map((room) => ({
        ...room,
        canManageMembers: true,
      })),
      messages: workspace.messages.map((message) => ({
        ...message,
        reactions: message.reactions.map((reaction) => ({
          ...reaction,
          reactedByCurrentUser: false,
        })),
      })),
    };
    const { commands, transport } = createTransport(readOnlyWorkspace);
    transport.uploadAttachment = vi.fn();
    const hostMutations = {
      createRoom: vi.fn(),
      createDm: vi.fn(),
      manageMembers: vi.fn(),
      notifications: vi.fn(),
    };

    render(
      <BluplaiChat
        onCreateDm={hostMutations.createDm}
        onCreateRoom={hostMutations.createRoom}
        onManageMembers={hostMutations.manageMembers}
        onNotificationPreferenceChange={hostMutations.notifications}
        transport={transport}
      />,
    );

    await screen.findByRole("heading", { name: "General" });
    expect(
      screen.queryByRole("textbox", { name: "Message General" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Attach file")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create channel" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Start direct message" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Members" })).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Notification preference" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add thumbs up reaction" }),
    ).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "👍 reaction, 2 people" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(commands).toEqual([]);
    expect(
      Object.values(hostMutations).every(
        (mutation) => mutation.mock.calls.length === 0,
      ),
    ).toBe(true);
  });
});

describe("capability command boundary", () => {
  it.each([
    "git.open-repository",
    "workflow.run",
    "project.open",
    "canvas.open",
    "huddle.start",
    "acp.launch-agent",
  ] as const)("rejects hidden %s commands before transport", async (type) => {
    const { commands, transport } = createTransport();

    await expect(
      executeChatCommand(transport, { type }, workspace.capabilities),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(commands).toEqual([]);
  });

  it("passes browser chat commands through the same guarded entry point", async () => {
    const { commands, transport } = createTransport();
    const command: ChatCommand = {
      type: "chat.mark-read",
      roomId: "room-general",
      messageId: "message-root",
    };

    await expect(
      executeChatCommand(transport, command, workspace.capabilities),
    ).resolves.toEqual({ ok: true });
    expect(commands).toEqual([command]);
  });

  it("rejects every chat mutation when the authenticated capability is read-only", async () => {
    const { commands, transport } = createTransport();
    await expect(
      executeChatCommand(
        transport,
        {
          type: "chat.send-message",
          roomId: "room-general",
          body: "blocked",
        },
        { schemaVersion: 1, readOnly: true },
      ),
    ).rejects.toBeInstanceOf(ReadOnlySessionError);
    expect(commands).toEqual([]);
  });
});
