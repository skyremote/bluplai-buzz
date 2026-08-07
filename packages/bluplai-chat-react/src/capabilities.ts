import type {
  AllowedChatCommand,
  BuzzChatTransport,
  ChatCommand,
  ChatCommandResult,
  ChatWorkspaceCapabilities,
} from "./transport/types";
import { ReadOnlySessionError } from "./transport/gateway";

/** Render and command capabilities available in Bluplai's browser package. */
export const BLUPLAI_CHAT_CAPABILITIES = Object.freeze({
  rooms: true,
  threads: true,
  reactions: true,
  attachments: true,
  search: true,
  presence: true,
  notificationPreferences: true,
  readState: true,
  git: false,
  workflows: false,
  projects: false,
  canvas: false,
  huddles: false,
  acp: false,
});

/** Fail-closed state used until an authenticated gateway frame grants writes. */
export const READ_ONLY_CHAT_CAPABILITIES: ChatWorkspaceCapabilities =
  Object.freeze({ schemaVersion: 1, readOnly: true });

const ALLOWED_COMMAND_TYPES = new Set<AllowedChatCommand["type"]>([
  "chat.send-message",
  "chat.add-reaction",
  "chat.mark-read",
]);

const COMMAND_SURFACES: Record<string, string> = {
  "git.open-repository": "git",
  "workflow.run": "workflows",
  "project.open": "projects",
  "canvas.open": "canvas",
  "huddle.start": "huddles",
  "acp.launch-agent": "acp",
};

/** A stable, host-observable error returned for every denied capability. */
export class CapabilityDeniedError extends Error {
  readonly code = "CAPABILITY_DENIED";
  readonly commandType: string;
  readonly surface: string;

  constructor(commandType: string) {
    const surface = COMMAND_SURFACES[commandType] ?? "unknown";
    super(`Bluplai Chat does not permit the ${surface} capability`);
    this.name = "CapabilityDeniedError";
    this.commandType = commandType;
    this.surface = surface;
  }
}

/** Returns whether an untrusted command is part of the browser chat contract. */
export function isAllowedChatCommand(
  command: ChatCommand,
): command is AllowedChatCommand {
  return ALLOWED_COMMAND_TYPES.has(command.type as AllowedChatCommand["type"]);
}

/**
 * Executes a command only after the package-level capability check. Hosts
 * should expose this function, not their transport's raw execute method.
 */
export async function executeChatCommand(
  transport: BuzzChatTransport,
  command: ChatCommand,
  capabilities: ChatWorkspaceCapabilities,
): Promise<ChatCommandResult> {
  if (!isAllowedChatCommand(command)) {
    throw new CapabilityDeniedError(command.type);
  }
  if (capabilities.readOnly) throw new ReadOnlySessionError();

  return transport.execute(command);
}
