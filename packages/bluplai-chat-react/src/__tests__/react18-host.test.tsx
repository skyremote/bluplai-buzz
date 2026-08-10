import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { MessageItem } from "../components/MessageItem";

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

const interactiveWorkspace: ChatWorkspaceSnapshot = {
  ...workspace,
  rooms: workspace.rooms.map((room) =>
    room.id === "room-general"
      ? {
          ...room,
          memberIds: ["user-daniel", "user-leandro", "bluplai"],
        }
      : room,
  ),
  members: [
    {
      id: "user-daniel",
      displayName: "Daniel",
      presence: "online",
      role: "admin",
    },
    {
      id: "user-leandro",
      displayName: "Leandro Piorkowski",
      presence: "online",
      role: "member",
    },
    {
      id: "bluplai",
      displayName: "Bluplai",
      presence: "online",
      role: "agent",
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

const storedDrafts = new Map<string, string>();

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => storedDrafts.clear(),
      getItem: (key: string) => storedDrafts.get(key) ?? null,
      removeItem: (key: string) => storedDrafts.delete(key),
      setItem: (key: string, value: string) => storedDrafts.set(key, value),
    },
  });
});

afterEach(() => {
  cleanup();
  storedDrafts.clear();
});

describe("React 18 host compatibility", () => {
  it("opens a retained room at its newest message", () => {
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(960);
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(320);
    const { transport } = createTransport();
    const retainedTransport = transport as BuzzChatTransport & {
      getSnapshot: () => ChatWorkspaceSnapshot;
    };
    retainedTransport.getSnapshot = () => workspace;

    render(<BluplaiChat transport={retainedTransport} />);

    expect(
      screen.getByRole("log", { name: "Messages in General" }).scrollTop,
    ).toBe(960);
    scrollHeight.mockRestore();
    clientHeight.mockRestore();
  });

  it("forces attachment links to download without retaining opener access", () => {
    render(
      <MessageItem
        message={{
          id: "message-attachment",
          roomId: "room-general",
          author: { id: "user-leandro", displayName: "Leandro" },
          body: "Review this file",
          createdAt: "2026-08-03T08:00:00.000Z",
          reactions: [],
          attachments: [
            {
              id: "media-html",
              name: "evidence.html",
              kind: "file",
              contentType: "text/html",
              downloadUrl: "blob:active-content",
            },
          ],
        }}
      />,
    );

    const link = screen.getByRole("link", { name: /evidence\.html/i });
    expect(link.getAttribute("download")).toBe("evidence.html");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders GFM tables, headings, lists, links, and code as message content", () => {
    render(
      <MessageItem
        message={{
          id: "message-markdown",
          roomId: "room-general",
          author: { id: "bluplai", displayName: "Bluplai" },
          body: [
            "## Project comparison",
            "",
            "| Project | Status |",
            "| --- | --- |",
            "| Alpha | **Ready** |",
            "| Beta | `Blocked` |",
            "",
            "- @Bluplai confirm owner",
            "- Share [plan](https://example.com/plan)",
          ].join("\n"),
          createdAt: "2026-08-03T08:00:00.000Z",
          reactions: [],
        }}
        mentionNames={["Bluplai"]}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Project comparison" }),
    ).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Scrollable message table" }),
    ).toBeTruthy();
    expect(screen.getByText("@Bluplai").closest("li")).toBeTruthy();
    expect(screen.getByText("@Bluplai").className).toContain(
      "bluplai-chat__mention",
    );
    expect(
      screen.getByRole("link", { name: "plan" }).getAttribute("target"),
    ).toBe("_blank");
    expect(screen.getByText("Blocked").tagName).toBe("CODE");
  });

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

  it("renders a retained workspace on the first remount frame", () => {
    const { transport } = createTransport();
    const retainedTransport = transport as BuzzChatTransport & {
      getSnapshot: () => ChatWorkspaceSnapshot;
    };
    retainedTransport.getSnapshot = () => workspace;
    retainedTransport.loadWorkspace = vi.fn(
      () => new Promise<ChatWorkspaceSnapshot>(() => undefined),
    );

    render(<BluplaiChat transport={retainedTransport} />);

    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
    expect(screen.queryByText("Loading Bluplai Chat…")).toBeNull();
  });

  it("keeps a retained workspace visible when background refresh fails", async () => {
    const { transport } = createTransport();
    const retainedTransport = transport as BuzzChatTransport & {
      getSnapshot: () => ChatWorkspaceSnapshot;
    };
    retainedTransport.getSnapshot = () => workspace;
    retainedTransport.loadWorkspace = vi.fn(async () => {
      throw new Error("offline");
    });

    render(<BluplaiChat transport={retainedTransport} />);
    await waitFor(() =>
      expect(retainedTransport.loadWorkspace).toHaveBeenCalledOnce(),
    );

    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
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
    expect(within(thread).getByText("Replying in thread")).toBeTruthy();
    expect(
      within(thread).getByRole("log", { name: "Thread messages" }),
    ).toBeTruthy();
  });

  it.each([
    "sending",
    "sent",
  ] as const)("withholds thread and reaction actions while an optimistic message is %s", async (deliveryState) => {
    const rootMessage = workspace.messages.find(
      (message) => message.id === "message-root",
    );
    if (!rootMessage) throw new Error("root fixture is unavailable");
    const pendingWorkspace: ChatWorkspaceSnapshot = {
      ...workspace,
      messages: [
        {
          ...rootMessage,
          id: "local:pending",
          deliveryState,
        },
      ],
    };
    const { transport } = createTransport(pendingWorkspace);
    render(<BluplaiChat transport={transport} />);

    const message = await screen.findByRole("article", {
      name: "Message from Leandro",
    });
    expect(
      within(message).queryByRole("button", { name: "Reply in thread" }),
    ).toBeNull();
    expect(
      within(message).queryByRole("button", {
        name: "Add thumbs up reaction",
      }),
    ).toBeNull();
  });

  it("shows when a direct reply will ask Bluplai", async () => {
    const agentWorkspace: ChatWorkspaceSnapshot = {
      ...interactiveWorkspace,
      messages: [
        {
          id: "message-agent",
          roomId: "room-general",
          author: {
            id: "bluplai",
            displayName: "Bluplai",
            role: "agent",
          } as ChatWorkspaceSnapshot["messages"][number]["author"],
          body: "I found three renewal risks.",
          createdAt: "2026-08-03T08:00:00.000Z",
          reactions: [],
        },
      ],
    };
    const { transport } = createTransport(agentWorkspace);
    render(<BluplaiChat transport={transport} />);

    const message = await screen.findByRole("article", {
      name: "Message from Bluplai",
    });
    fireEvent.click(
      within(message).getByRole("button", { name: "Reply in thread" }),
    );

    expect(screen.getByText("Asking Bluplai")).toBeTruthy();
  });

  it("directs an AI continuation to the latest Bluplai response", async () => {
    const aiReply = {
      id: "message-ai-reply",
      roomId: "room-general",
      author: {
        id: "bluplai",
        displayName: "Bluplai",
        role: "agent",
      } as ChatWorkspaceSnapshot["messages"][number]["author"],
      body: "The account is waiting on procurement.",
      createdAt: "2026-08-03T08:06:00.000Z",
      threadRootId: "message-root",
      parentMessageId: "message-root",
      reactions: [],
    };
    const { commands, transport } = createTransport({
      ...interactiveWorkspace,
      messages: [...workspace.messages, aiReply],
    });
    render(<BluplaiChat transport={transport} />);
    fireEvent.click(await screen.findByRole("button", { name: "2 replies" }));
    const composers = screen.getAllByRole("combobox", {
      name: /message general/i,
    });
    const threadComposer = composers.at(-1);
    expect(threadComposer).toBeDefined();
    if (!threadComposer) return;
    fireEvent.change(threadComposer, {
      target: { value: "What should we do next?" },
    });
    const form = threadComposer.closest("form");
    expect(form).toBeTruthy();
    if (!form) return;
    fireEvent.submit(form);

    await waitFor(() =>
      expect(commands.at(-1)).toMatchObject({
        type: "chat.send-message",
        parentMessageId: "message-ai-reply",
        threadRootId: "message-root",
      }),
    );
  });

  it("supports keyboard resizing and expanding a thread", async () => {
    const { transport } = createTransport();
    render(<BluplaiChat transport={transport} />);
    fireEvent.click(await screen.findByRole("button", { name: "1 reply" }));

    const separator = screen.getByRole("separator", { name: "Resize thread" });
    expect(separator.getAttribute("aria-valuenow")).toBe("380");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator.getAttribute("aria-valuenow")).toBe("396");

    fireEvent.click(screen.getByRole("button", { name: "Expand thread" }));
    expect(
      screen.getByRole("button", { name: "Restore split view" }),
    ).toBeTruthy();
  });

  it("renders structured record and disclosure labels", async () => {
    const recordWorkspace: ChatWorkspaceSnapshot = {
      ...workspace,
      rooms: [
        {
          ...workspace.rooms[0],
          disclosureScope: "shared",
          canonicalRole: "project_shared",
          accountName: "Autodesk",
          projectName: "AI Revenue Studio",
          followed: true,
        } as ChatWorkspaceSnapshot["rooms"][number],
      ],
    };
    const { transport } = createTransport(recordWorkspace);
    render(<BluplaiChat transport={transport} />);

    expect(await screen.findByText("Customer shared")).toBeTruthy();
    expect(screen.getByText("Autodesk / AI Revenue Studio")).toBeTruthy();
  });

  it("renders live presence and publishes bounded typing state", async () => {
    const liveWorkspace: ChatWorkspaceSnapshot = {
      ...workspace,
      rooms: workspace.rooms.map((room) =>
        room.id === "room-general"
          ? { ...room, memberIds: ["user-daniel", "user-leandro"] }
          : room,
      ),
      members: [
        {
          id: "user-daniel",
          displayName: "Daniel",
          presence: "online",
          role: "admin",
        },
        {
          id: "user-leandro",
          displayName: "Leandro",
          presence: "online",
          role: "member",
        },
      ],
      typing: [
        {
          roomId: "room-general",
          userId: "user-leandro",
          displayName: "Leandro",
          threadRootId: null,
        },
      ],
    };
    const { transport } = createTransport(liveWorkspace);
    transport.setTyping = vi.fn();
    render(<BluplaiChat transport={transport} />);

    expect(await screen.findByText("2/2 online")).toBeTruthy();
    expect(screen.getByText("Leandro is typing…")).toBeTruthy();
    const composer = screen.getByRole("combobox", { name: "Message General" });
    fireEvent.change(composer, { target: { value: "Draft" } });
    expect(transport.setTyping).toHaveBeenLastCalledWith("room-general", {
      active: true,
      parentMessageId: null,
      threadRootId: null,
    });
    fireEvent.change(composer, { target: { value: "" } });
    expect(transport.setTyping).toHaveBeenLastCalledWith("room-general", {
      active: false,
      parentMessageId: null,
      threadRootId: null,
    });
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
    const composer = await screen.findByRole("combobox", {
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

  it("opens live AI mention suggestions while typing and sends the selected identity", async () => {
    const { commands, transport } = createTransport(interactiveWorkspace);
    render(<BluplaiChat transport={transport} />);
    const composer = await screen.findByRole("combobox", {
      name: "Message General",
    });

    fireEvent.change(composer, {
      target: { selectionStart: 4, value: "@blu" },
    });
    const option = await screen.findByRole("option", { name: /Bluplai/i });
    expect(option.textContent).toContain("uses this room's context");
    expect(composer.getAttribute("aria-expanded")).toBe("true");
    expect(composer.getAttribute("aria-controls")).toBeTruthy();
    expect(composer.getAttribute("aria-activedescendant")).toBe(option.id);
    fireEvent.keyDown(composer, { key: "Enter" });
    expect((composer as HTMLTextAreaElement).value).toBe("@Bluplai ");

    fireEvent.change(composer, {
      target: { value: "@Bluplai summarise the launch risks" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(
        commands.find((command) => command.type === "chat.send-message"),
      ).toEqual({
        type: "chat.send-message",
        roomId: "room-general",
        body: "@Bluplai summarise the launch risks",
        mentionedUserIds: ["bluplai"],
        attachments: [],
      }),
    );
  });

  it("preserves stable multi-word mention identities with a room draft", async () => {
    const first = createTransport(interactiveWorkspace);
    const mounted = render(<BluplaiChat transport={first.transport} />);
    const composer = await screen.findByRole("combobox", {
      name: "Message General",
    });
    fireEvent.change(composer, {
      target: { selectionStart: 4, value: "@lea" },
    });
    fireEvent.click(await screen.findByRole("option", { name: /Leandro/i }));
    fireEvent.change(composer, {
      target: { value: "@Leandro Piorkowski review the customer plan" },
    });
    mounted.unmount();

    const second = createTransport(interactiveWorkspace);
    render(<BluplaiChat transport={second.transport} />);
    const restored = await screen.findByRole("combobox", {
      name: "Message General",
    });
    expect((restored as HTMLTextAreaElement).value).toBe(
      "@Leandro Piorkowski review the customer plan",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(
        second.commands.find((command) => command.type === "chat.send-message"),
      ).toMatchObject({ mentionedUserIds: ["user-leandro"] }),
    );
  });

  it("sends multiple structured project mentions for comparison", async () => {
    const projectWorkspace: ChatWorkspaceSnapshot = {
      ...interactiveWorkspace,
      projects: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          displayName: "Selling at AI Speed",
          accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          accountName: "Autodesk",
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          displayName: "Enterprise Renewal",
          accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          accountName: "Autodesk",
        },
      ],
    };
    const { commands, transport } = createTransport(projectWorkspace);
    render(<BluplaiChat transport={transport} />);
    const composer = await screen.findByRole("combobox", {
      name: "Message General",
    });

    fireEvent.change(composer, {
      target: { selectionStart: 5, value: "@Sell" },
    });
    fireEvent.click(
      await screen.findByRole("option", {
        name: /Selling at AI Speed.*project/i,
      }),
    );
    fireEvent.change(composer, {
      target: {
        selectionStart: 42,
        value: "@Selling at AI Speed compare with @Enter",
      },
    });
    fireEvent.click(
      await screen.findByRole("option", {
        name: /Enterprise Renewal.*project/i,
      }),
    );
    fireEvent.change(composer, {
      target: {
        value:
          "@Selling at AI Speed compare with @Enterprise Renewal and identify what is missing",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(
        commands.find((command) => command.type === "chat.send-message"),
      ).toMatchObject({
        mentionedProjectIds: [
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222",
        ],
      }),
    );
  });

  it("isolates uploads and transient composer state when switching rooms", async () => {
    const { transport } = createTransport(interactiveWorkspace);
    let uploadSignal: AbortSignal | undefined;
    transport.uploadAttachment = vi.fn((_roomId, _file, signal) => {
      uploadSignal = signal;
      return new Promise<ChatAttachment>(() => undefined);
    });
    render(<BluplaiChat transport={transport} />);
    await screen.findByRole("combobox", { name: "Message General" });
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("attachment input was not rendered");
    fireEvent.change(input, {
      target: {
        files: [new File(["data"], "room-only.png", { type: "image/png" })],
      },
    });
    await screen.findByText("room-only.png");

    fireEvent.click(screen.getByRole("button", { name: "Ideas" }));

    await waitFor(() => expect(uploadSignal?.aborted).toBe(true));
    expect(screen.queryByText("room-only.png")).toBeNull();
    expect(
      (
        screen.getByRole("combobox", {
          name: "Message Ideas",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("");
  });

  it("offers slash actions, room-context AI prompts, and searchable emoji", async () => {
    const { transport } = createTransport(interactiveWorkspace);
    render(<BluplaiChat transport={transport} />);
    const composer = await screen.findByRole("combobox", {
      name: "Message General",
    });

    fireEvent.change(composer, {
      target: { selectionStart: 4, value: "/sum" },
    });
    expect(
      await screen.findByRole("option", { name: /Summarise room/i }),
    ).toBeTruthy();
    fireEvent.keyDown(composer, { key: "Enter" });
    expect((composer as HTMLTextAreaElement).value).toContain("@Bluplai");
    expect((composer as HTMLTextAreaElement).value).toContain(
      "decisions, risks and next actions",
    );

    fireEvent.click(screen.getByRole("button", { name: "Emoji" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search emoji" }), {
      target: { value: "rocket" },
    });
    fireEvent.click(screen.getByRole("option", { name: "rocket" }));
    expect((composer as HTMLTextAreaElement).value).toContain("🚀");
  });

  it("searches and sends GIFs through the host-owned provider", async () => {
    const { commands, transport } = createTransport(interactiveWorkspace);
    const searchGifs = vi.fn(async () => [
      {
        id: "celebrate",
        title: "Celebrate",
        url: "https://media.giphy.com/media/celebrate/giphy.gif",
        previewUrl: "https://media.giphy.com/media/celebrate/preview.gif",
      },
    ]);
    render(<BluplaiChat searchGifs={searchGifs} transport={transport} />);
    await screen.findByRole("combobox", { name: "Message General" });

    fireEvent.click(screen.getByRole("button", { name: "GIF" }));
    expect(await screen.findByAltText("Celebrate")).toBeTruthy();
    expect(searchGifs).toHaveBeenCalledWith("", expect.any(AbortSignal));
    fireEvent.click(screen.getByAltText("Celebrate"));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(
        commands.find((command) => command.type === "chat.send-message"),
      ).toEqual({
        type: "chat.send-message",
        roomId: "room-general",
        body: "https://media.giphy.com/media/celebrate/giphy.gif",
        attachments: [],
      }),
    );
  });

  it("persists room drafts and applies writing language direction", async () => {
    const first = createTransport(interactiveWorkspace);
    const mounted = render(<BluplaiChat transport={first.transport} />);
    const composer = await screen.findByRole("combobox", {
      name: "Message General",
    });
    fireEvent.change(composer, { target: { value: "A durable draft" } });
    mounted.unmount();

    const second = createTransport(interactiveWorkspace);
    render(<BluplaiChat transport={second.transport} />);
    const restored = await screen.findByRole("combobox", {
      name: "Message General",
    });
    expect((restored as HTMLTextAreaElement).value).toBe("A durable draft");

    fireEvent.click(
      screen.getByRole("button", { name: "Writing language: Auto-detect" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /العربيةArabic/i }));
    expect(restored.getAttribute("dir")).toBe("rtl");
    expect(restored.getAttribute("lang")).toBe("ar");
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

    await screen.findByRole("combobox", { name: "Message General" });
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
    await screen.findByRole("combobox", { name: "Message General" });
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
      screen.queryByRole("combobox", { name: "Message General" }),
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
    "acp.launch-agent",
  ] as const)("rejects hidden %s commands before transport", async (type) => {
    const { commands, transport } = createTransport();

    await expect(
      executeChatCommand(transport, { type }, workspace.capabilities),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(commands).toEqual([]);
  });

  it("permits only huddle.start when its authenticated capability is exact", async () => {
    const { commands, transport } = createTransport();
    const command: ChatCommand = {
      type: "huddle.start",
      source: { roomId: "room-general", threadRootEventId: null },
      mode: "orchestrated",
      recordingRequested: false,
      retentionDays: 365,
      participants: [],
      correlationId: "correlation-1",
    };

    await expect(
      executeChatCommand(transport, command, {
        schemaVersion: 1,
        readOnly: false,
        huddleStart: false,
      }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(
      executeChatCommand(transport, command, {
        schemaVersion: 1,
        readOnly: false,
        huddleStart: true,
      }),
    ).resolves.toEqual({ ok: true });
    expect(commands).toEqual([command]);
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

describe("typed agent output rendering", () => {
  it("renders and replaces accessible output cards while callbacks receive IDs only", () => {
    const rootMessage = workspace.messages[0];
    if (!rootMessage) throw new Error("root message fixture missing");
    const approve = vi.fn();
    const deny = vi.fn();
    const cancel = vi.fn();
    const retry = vi.fn();
    const message = {
      ...rootMessage,
      agentOutputs: [
        {
          kind: "progress" as const,
          id: "11111111-1111-4111-8111-111111111111",
          replacementKey: "run:11111111-1111-4111-8111-111111111111",
          runId: "11111111-1111-4111-8111-111111111111",
          state: "running" as const,
          label: "Dale is checking project context",
          canCancel: true,
        },
        {
          kind: "progress" as const,
          id: "11111111-1111-4111-8111-111111111111",
          replacementKey: "run:11111111-1111-4111-8111-111111111111",
          runId: "11111111-1111-4111-8111-111111111111",
          state: "publishing" as const,
          label: "Dale is preparing the answer",
          canCancel: true,
        },
        {
          kind: "approval" as const,
          id: "22222222-2222-4222-8222-222222222222",
          replacementKey: "action:22222222-2222-4222-8222-222222222222",
          runId: "11111111-1111-4111-8111-111111111111",
          actionId: "22222222-2222-4222-8222-222222222222",
          state: "pending" as const,
          label: "Send email",
          preview: { To: ["megan@example.com"], Subject: "Project update" },
          canApprove: true,
        },
        {
          kind: "job" as const,
          id: "33333333-3333-4333-8333-333333333333",
          replacementKey: "job:33333333-3333-4333-8333-333333333333",
          runId: "11111111-1111-4111-8111-111111111111",
          jobId: "33333333-3333-4333-8333-333333333333",
          state: "running" as const,
          label: "Generate artifact",
          percent: 42,
          canRetry: false,
        },
        {
          kind: "job" as const,
          id: "55555555-5555-4555-8555-555555555555",
          replacementKey: "job:55555555-5555-4555-8555-555555555555",
          runId: "11111111-1111-4111-8111-111111111111",
          jobId: "55555555-5555-4555-8555-555555555555",
          state: "failed" as const,
          label: "Generate image",
          percent: null,
          canRetry: true,
        },
        {
          kind: "deep_link" as const,
          id: "44444444-4444-4444-8444-444444444444",
          replacementKey: "result:44444444-4444-4444-8444-444444444444",
          runId: "11111111-1111-4111-8111-111111111111",
          label: "Open document",
          href: "/documents?focus=44444444-4444-4444-8444-444444444444",
        },
      ],
    };

    render(
      <MessageItem
        message={message}
        onApproveAction={approve}
        onCancelRun={cancel}
        onDenyAction={deny}
        onRetryJob={retry}
      />,
    );

    expect(screen.queryByText("Dale is checking project context")).toBeNull();
    expect(screen.getByText("Dale is preparing the answer")).not.toBeNull();
    expect(
      screen
        .getByRole("progressbar", { name: "Generate artifact progress" })
        .getAttribute("aria-valuenow"),
    ).toBe("42");
    fireEvent.click(screen.getByRole("button", { name: "Approve Send email" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny Send email" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Stop Dale is preparing the answer" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Retry Generate image" }),
    );
    expect(approve).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(deny).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
    expect(cancel).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(retry).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555");
    expect(
      screen.getByRole("link", { name: "Open document" }).getAttribute("href"),
    ).toBe("/documents?focus=44444444-4444-4444-8444-444444444444");
  });

  it("keeps raw HTML inert, blocks Markdown images, and rejects unsafe links", () => {
    const rootMessage = workspace.messages[0];
    if (!rootMessage) throw new Error("root message fixture missing");
    render(
      <MessageItem
        message={{
          ...rootMessage,
          body: '<img src="https://evil.test/a.png"> ![remote](https://evil.test/b.png) [bad](javascript:alert(1)) [safe](https://bluplai.com)',
        }}
      />,
    );

    expect(screen.queryByRole("img", { name: "remote" })).toBeNull();
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "safe" }).getAttribute("href"),
    ).toBe("https://bluplai.com");
    expect(screen.getByText(/<img src=/)).not.toBeNull();
  });
});
