import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HuddlePanel,
  type HuddleSnapshot,
  type HuddleTransport,
} from "../index";

const roomSource = { roomId: "room-northstar", threadRootEventId: null };

function snapshot(overrides: Partial<HuddleSnapshot> = {}): HuddleSnapshot {
  return {
    id: "huddle-1",
    source: roomSource,
    lifecycle: {
      state: "active",
      generation: 2,
      mode: "orchestrated",
      startedAt: "2026-08-10T12:00:00.000Z",
      endedAt: null,
    },
    recording: {
      requested: true,
      active: false,
      consentRevision: 3,
      retentionDays: 365,
    },
    participants: [
      {
        type: "human",
        id: "user-daniel",
        displayName: "Daniel",
        state: "joined",
        consent: "pending",
        isCurrentUser: true,
      },
      {
        type: "agent",
        id: "agent-researcher",
        displayName: "Researcher",
        state: "joined",
        consent: "not_required",
        detail: "Checking Northstar Renewal",
      },
    ],
    transcript: [
      {
        stableTurnId: "a".repeat(64),
        signedEventId: "b".repeat(64),
        role: "human",
        participantId: "user-daniel",
        content: "What changed in the renewal?",
        absoluteTimeMs: 1_786_000_000_000,
      },
    ],
    progress: {
      state: "checking_context",
      label: "Checking account context",
      detail: "Researcher is checking Northstar Renewal",
    },
    outputs: [],
    connection: "connected",
    canEnd: true,
    ...overrides,
  };
}

function transport(initial = snapshot()): HuddleTransport {
  return {
    start: vi.fn(async () => initial),
    join: vi.fn(async () => ({
      snapshot: initial,
      credential: {
        huddleId: initial.id,
        roomId: initial.source.roomId,
        generation: initial.lifecycle.generation,
        credentialId: "credential-1",
        provider: "elevenlabs" as const,
        providerToken: "secret-short-lived-token",
        providerConversationId: "conversation-1",
        expiresAt: "2026-08-10T12:05:00.000Z",
      },
    })),
    leave: vi.fn(async () => ({
      ...initial,
      connection: "left" as const,
      participants: initial.participants.map((participant) =>
        participant.isCurrentUser
          ? { ...participant, state: "left" as const }
          : participant,
      ),
    })),
    end: vi.fn(async () => ({
      ...initial,
      lifecycle: {
        ...initial.lifecycle,
        state: "ended" as const,
        endedAt: "now",
      },
    })),
    setRecordingConsent: vi.fn(async (_id, consent) => ({
      ...initial,
      participants: initial.participants.map((participant) =>
        participant.isCurrentUser ? { ...participant, consent } : participant,
      ),
    })),
    refresh: vi.fn(async () => initial),
    subscribe: vi.fn(() => vi.fn()),
  };
}

afterEach(cleanup);

describe("Huddle package UI", () => {
  it("fails closed until the host grants huddle.start, then sends the exact source", async () => {
    const huddles = transport();
    const { rerender } = render(
      <HuddlePanel
        capabilities={{ schemaVersion: 1, readOnly: false }}
        currentUserId="user-daniel"
        participantName="Daniel"
        source={roomSource}
        transport={huddles}
      />,
    );
    expect(screen.queryByRole("button", { name: "Start Huddle" })).toBeNull();
    expect(
      screen.getByText("Huddles are unavailable in this workspace."),
    ).toBeTruthy();

    rerender(
      <HuddlePanel
        capabilities={{
          schemaVersion: 1,
          readOnly: false,
          huddleStart: true,
        }}
        currentUserId="user-daniel"
        participantName="Daniel"
        source={roomSource}
        transport={huddles}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start Huddle" }));
    await waitFor(() => expect(huddles.start).toHaveBeenCalledOnce());
    expect(huddles.start).toHaveBeenCalledWith(
      expect.objectContaining({
        source: roomSource,
        mode: "orchestrated",
        recordingRequested: false,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("supports consent, leave and end without exposing the media credential", async () => {
    const active = snapshot();
    const huddles = transport(active);
    const onCredential = vi.fn();
    render(
      <HuddlePanel
        capabilities={{ schemaVersion: 1, readOnly: false, huddleStart: true }}
        currentUserId="user-daniel"
        initialSnapshot={{
          ...active,
          connection: "ready_to_join",
          participants: active.participants.map((participant) =>
            participant.isCurrentUser
              ? { ...participant, state: "invited" }
              : participant,
          ),
        }}
        onCredential={onCredential}
        participantName="Daniel"
        source={roomSource}
        transport={huddles}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Join Huddle" }));
    await waitFor(() => expect(onCredential).toHaveBeenCalledOnce());
    expect(screen.queryByText("secret-short-lived-token")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Allow recording" }));
    await waitFor(() =>
      expect(huddles.setRecordingConsent).toHaveBeenCalledWith(
        "huddle-1",
        "granted",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Leave Huddle" }));
    await waitFor(() => expect(huddles.leave).toHaveBeenCalledOnce());

    const ended = transport(active);
    const mounted = render(
      <HuddlePanel
        capabilities={{ schemaVersion: 1, readOnly: false, huddleStart: true }}
        currentUserId="user-daniel"
        initialSnapshot={active}
        participantName="Daniel"
        source={roomSource}
        transport={ended}
      />,
    );
    const endButton = screen
      .getAllByRole("button", { name: "End Huddle" })
      .at(-1);
    if (!endButton) throw new Error("End Huddle control was not rendered");
    fireEvent.click(endButton);
    await waitFor(() => expect(ended.end).toHaveBeenCalledOnce());
    mounted.unmount();
  });

  it("renders roster, signed live transcript, detailed progress and output references", () => {
    const firstTurn = snapshot().transcript[0];
    if (!firstTurn) throw new Error("Transcript fixture is empty");
    const active = snapshot({
      transcript: [
        firstTurn,
        firstTurn,
        {
          stableTurnId: "c".repeat(64),
          signedEventId: "d".repeat(64),
          role: "agent",
          participantId: "agent-researcher",
          content: "Renewal risk increased after the sponsor left.",
          absoluteTimeMs: 1_786_000_001_000,
        },
      ],
      outputs: [
        {
          id: "summary-1",
          kind: "summary",
          state: "completed",
          label: "Huddle summary",
          href: "/chat/huddles/huddle-1/summary",
          signedEventIds: ["d".repeat(64)],
        },
        {
          id: "action-1",
          kind: "proposed_action",
          state: "awaiting_approval",
          label: "Follow up renewal",
          href: "/chat/approvals/action-1",
          signedEventIds: ["d".repeat(64)],
        },
      ],
    });
    render(
      <HuddlePanel
        capabilities={{ schemaVersion: 1, readOnly: false, huddleStart: true }}
        currentUserId="user-daniel"
        initialSnapshot={active}
        participantName="Daniel"
        source={roomSource}
        transport={transport(active)}
      />,
    );

    expect(
      screen.getByRole("list", { name: "Huddle participants" }).textContent,
    ).toContain("Daniel");
    expect(
      screen.getByRole("list", { name: "Huddle participants" }).textContent,
    ).toContain("Researcher");
    expect(screen.getByRole("status").textContent).toContain(
      "Researcher is checking Northstar Renewal",
    );
    expect(screen.getAllByText("What changed in the renewal?")).toHaveLength(1);
    expect(
      screen.getByRole("feed", { name: "Live signed transcript" }).textContent,
    ).toContain("Renewal risk increased");
    expect(
      screen.getByRole("link", { name: "Huddle summary" }).getAttribute("href"),
    ).toBe("/chat/huddles/huddle-1/summary");
    expect(
      screen
        .getByRole("link", { name: "Follow up renewal" })
        .getAttribute("href"),
    ).toBe("/chat/approvals/action-1");
  });

  it("provides 44px mobile controls, safe-area padding and interruption rejoin", async () => {
    const interrupted = snapshot({ connection: "interrupted" });
    const huddles = transport(interrupted);
    render(
      <HuddlePanel
        capabilities={{ schemaVersion: 1, readOnly: false, huddleStart: true }}
        currentUserId="user-daniel"
        initialSnapshot={interrupted}
        participantName="Daniel"
        source={roomSource}
        transport={huddles}
      />,
    );

    expect(screen.getByRole("region", { name: "Huddle" })).toBeTruthy();
    const styles = readFileSync(
      resolve(process.cwd(), "src/styles.css"),
      "utf8",
    );
    expect(styles).toContain(
      "padding-top: max(18px, env(safe-area-inset-top, 0px))",
    );
    expect(styles).toContain(
      "padding-bottom: max(18px, env(safe-area-inset-bottom, 0px))",
    );
    const rejoin = screen.getByRole("button", { name: "Rejoin Huddle" });
    expect(rejoin.style.minHeight).toBe("44px");
    expect(rejoin.style.minWidth).toBe("44px");
    expect(screen.getByRole("status").textContent).toContain(
      "Connection interrupted. Rejoin the Huddle.",
    );
    fireEvent.click(rejoin);
    await waitFor(() => expect(huddles.join).toHaveBeenCalledOnce());
  });

  it("announces background continuation and refreshes authority on return", async () => {
    const active = snapshot();
    const huddles = transport(active);
    render(
      <HuddlePanel
        capabilities={{ schemaVersion: 1, readOnly: false, huddleStart: true }}
        currentUserId="user-daniel"
        initialSnapshot={active}
        participantName="Daniel"
        source={roomSource}
        transport={huddles}
      />,
    );

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.getByRole("status").textContent).toContain(
      "Huddle continues in the background.",
    );

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(huddles.refresh).toHaveBeenCalledOnce());
  });
});
