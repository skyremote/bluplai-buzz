import React from "react";
import { createRoot } from "react-dom/client";
import { BluplaiChat } from "../src/BluplaiChat";
import { ChatIcon, type ChatIconName } from "../src/components/ChatIcon";
import type {
  BuzzChatTransport,
  ChatWorkspaceSnapshot,
} from "../src/transport/types";
import "../src/styles.css";

const snapshot: ChatWorkspaceSnapshot = {
  capabilities: { schemaVersion: 1, readOnly: false },
  activeRoomId: "launch",
  currentUserId: "daniel",
  rooms: [
    {
      id: "launch",
      name: "bluplai-launch-check",
      topic: "Production verification for BluPlai Chat powered by Buzz",
      unreadCount: 0,
      disclosureScope: "internal",
      canonicalRole: "project_internal",
      accountName: "Bluplai",
      projectName: "Production launch",
      followed: true,
      memberIds: ["daniel", "leandro", "bluplai"],
      notificationPreference: "all",
      canManageMembers: true,
    },
    {
      id: "product",
      name: "product-feedback",
      topic: "Customer evidence and product decisions",
      unreadCount: 4,
      disclosureScope: "internal",
      memberIds: ["daniel", "leandro"],
    },
    {
      id: "customers",
      name: "customer-success",
      topic: "Account health and next actions",
      unreadCount: 1,
      disclosureScope: "shared",
      memberIds: ["daniel", "leandro"],
    },
    {
      id: "dm",
      name: "Leandro Piorkowski",
      unreadCount: 2,
      disclosureScope: "dm",
      memberIds: ["daniel", "leandro"],
    },
  ],
  members: [
    {
      id: "daniel",
      displayName: "Daniel Wright",
      presence: "online",
      role: "owner",
    },
    {
      id: "leandro",
      displayName: "Leandro Piorkowski",
      presence: "online",
      role: "admin",
    },
    {
      id: "bluplai",
      displayName: "Bluplai",
      presence: "online",
      role: "agent",
    },
  ],
  messages: [
    {
      id: "m1",
      roomId: "launch",
      author: { id: "daniel", displayName: "Daniel Wright" },
      body: "The new chat needs to feel like a real workspace—not a card sitting inside BluPlai.",
      createdAt: "2026-08-07T16:26:00Z",
      reactions: [{ emoji: "👍", count: 2, reactedByCurrentUser: false }],
    },
    {
      id: "m2",
      roomId: "launch",
      author: { id: "bluplai", displayName: "Bluplai", role: "agent" },
      body: "Understood. I’ll keep the channel context, messages, files and next actions together here. Mention @Bluplai whenever you want me to join the conversation.",
      createdAt: "2026-08-07T16:29:00Z",
      reactions: [{ emoji: "✨", count: 1, reactedByCurrentUser: true }],
    },
    {
      id: "m3",
      roomId: "launch",
      author: { id: "leandro", displayName: "Leandro Piorkowski" },
      body: "This hierarchy is much clearer. The conversation is primary and the controls stay available without taking over the page.",
      createdAt: "2026-08-07T16:34:00Z",
      reactions: [],
      attachments: [
        {
          id: "a1",
          name: "launch-readiness.pdf",
          kind: "file",
          downloadUrl: "#",
          sha256: "demo",
        },
      ],
    },
    {
      id: "m4",
      roomId: "launch",
      author: { id: "daniel", displayName: "Daniel Wright" },
      body: "@Bluplai summarise the final launch risks and assign the follow-ups.",
      createdAt: "2026-08-07T16:42:00Z",
      reactions: [],
      deliveryState: "sent",
    },
    {
      id: "m5",
      roomId: "launch",
      author: { id: "bluplai", displayName: "Bluplai", role: "agent" },
      body: "## Launch review\n\n| Area | Status |\n| --- | --- |\n| Mobile composer | **Ready** |\n| Agent handoffs | `In thread` |\n\n- Confirm the owner\n- Share the release note",
      createdAt: "2026-08-07T16:43:00Z",
      parentMessageId: "m4",
      threadRootId: "m4",
      reactions: [],
    },
  ],
  readStates: [
    {
      roomId: "launch",
      lastReadAt: "2026-08-07T16:42:00Z",
      lastReadMessageId: "m4",
    },
  ],
  typing: [{ roomId: "launch", userId: "bluplai", displayName: "Bluplai" }],
};

const transport: BuzzChatTransport = {
  loadWorkspace: async () => snapshot,
  subscribe: () => () => undefined,
  execute: async () => ({ ok: true }),
  uploadAttachment: async (_roomId, file) => ({
    id: "upload",
    name: file.name,
    kind: "file",
    downloadUrl: "#",
    sha256: "demo",
  }),
};

const demoGifs = [
  {
    id: "demo-celebrate",
    title: "Celebrate",
    url: "https://media.giphy.com/media/26BRuo6sLetdllPAQ/giphy.gif",
    previewUrl: "https://media.giphy.com/media/26BRuo6sLetdllPAQ/giphy.gif",
  },
  {
    id: "demo-approved",
    title: "Approved",
    url: "https://media.giphy.com/media/111ebonMs90YLu/giphy.gif",
    previewUrl: "https://media.giphy.com/media/111ebonMs90YLu/giphy.gif",
  },
  {
    id: "demo-yes",
    title: "Yes",
    url: "https://media.giphy.com/media/nXxOjZrbnbRxS/giphy.gif",
    previewUrl: "https://media.giphy.com/media/nXxOjZrbnbRxS/giphy.gif",
  },
];

function App() {
  return (
    <div className="demo-shell">
      <aside className="demo-icon-rail">
        <div
          style={{
            alignItems: "center",
            background: "#3157d9",
            borderRadius: 12,
            display: "flex",
            fontWeight: 800,
            height: 38,
            justifyContent: "center",
            width: 38,
          }}
        >
          B
        </div>
        {(
          ["message", "members", "hash", "sparkles", "bell"] as ChatIconName[]
        ).map((item, index) => (
          <div
            key={item}
            style={{
              alignItems: "center",
              background: index === 2 ? "rgba(255,255,255,.15)" : "transparent",
              borderRadius: 10,
              display: "flex",
              height: 38,
              justifyContent: "center",
              opacity: index === 2 ? 1 : 0.6,
              width: 38,
            }}
          >
            <ChatIcon name={item} />
          </div>
        ))}
      </aside>
      <aside className="demo-room-rail">
        <BluplaiChat compact mode="rail" transport={transport} />
      </aside>
      <main style={{ minWidth: 0 }}>
        <BluplaiChat
          onManageMembers={() => undefined}
          onNotificationPreferenceChange={() => undefined}
          onOpenRoomList={() => undefined}
          roomContext={
            <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
              <span
                style={{
                  alignItems: "center",
                  background: "#3157d9",
                  borderRadius: 8,
                  color: "white",
                  display: "flex",
                  fontSize: 13,
                  fontWeight: 750,
                  height: 30,
                  justifyContent: "center",
                  width: 30,
                }}
              >
                AI
              </span>
              <div>
                <strong style={{ display: "block", fontSize: 12 }}>
                  Bluplai is in this conversation
                </strong>
                <span style={{ color: "#626a78", fontSize: 11 }}>
                  Visible and ready — mention @Bluplai
                </span>
              </div>
            </div>
          }
          searchGifs={async (query) =>
            demoGifs.filter((gif) =>
              gif.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
            )
          }
          showRoomList={false}
          transport={transport}
        />
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
