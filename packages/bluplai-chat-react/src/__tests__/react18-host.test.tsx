import { cleanup, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BluplaiChat,
  CapabilityDeniedError,
  executeChatCommand,
  type BuzzChatTransport,
  type ChatCommand,
  type ChatWorkspaceSnapshot,
} from "../index";

const workspace: ChatWorkspaceSnapshot = {
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

    const thread = screen.getByRole("region", {
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
      executeChatCommand(transport, { type }),
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

    await expect(executeChatCommand(transport, command)).resolves.toEqual({
      ok: true,
    });
    expect(commands).toEqual([command]);
  });
});
