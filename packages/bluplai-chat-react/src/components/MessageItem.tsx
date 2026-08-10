import type {
  ChatAgentOutput,
  ChatMessage,
  ChatReadState,
} from "../transport/types";
import { ChatIcon } from "./ChatIcon";
import { MessageContent } from "./MessageContent";

function isMessageRead(
  message: ChatMessage,
  readState: ChatReadState | undefined,
): boolean {
  if (!readState) return false;
  return Date.parse(message.createdAt) <= Date.parse(readState.lastReadAt);
}

function reactionLabel(
  emoji: string,
  count: number,
  reactedByCurrentUser: boolean,
): string {
  const people = count === 1 ? "1 person" : `${count} people`;
  const viewer = reactedByCurrentUser ? ", you reacted" : "";
  return `${emoji} reaction, ${people}${viewer}`;
}

const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const INTERNAL_LINKS = [
  new RegExp(`^/notes\\?note=${UUID}(?:&proposal=${UUID})?$`, "i"),
  new RegExp(`^/documents\\?focus=${UUID}$`, "i"),
  new RegExp(`^/whiteboards/${UUID}$`, "i"),
  new RegExp(`^/projects/${UUID}/artifacts/${UUID}$`, "i"),
];

function safeInternalHref(href: string): boolean {
  const hasControl = [...href].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  return (
    !href.includes("\\") &&
    !hasControl &&
    !href.includes("%") &&
    !href.includes("#") &&
    INTERNAL_LINKS.some((pattern) => pattern.test(href))
  );
}

function latestOutputs(
  items: ChatAgentOutput[] | undefined,
): ChatAgentOutput[] {
  const byReplacement = new Map<string, ChatAgentOutput>();
  for (const item of items ?? []) byReplacement.set(item.replacementKey, item);
  return [...byReplacement.values()];
}

function AgentOutputCard({
  item,
  onApproveAction,
  onDenyAction,
  onCancelRun,
  onRetryJob,
}: {
  item: ChatAgentOutput;
  onApproveAction?: (actionId: string) => void;
  onDenyAction?: (actionId: string) => void;
  onCancelRun?: (runId: string) => void;
  onRetryJob?: (jobId: string) => void;
}) {
  if (item.kind === "progress") {
    return (
      <section
        aria-live="polite"
        className="bluplai-chat__agent-card"
        data-kind="progress"
      >
        <span className="bluplai-chat__agent-pulse" aria-hidden="true" />
        <strong>{item.label}</strong>
        {item.canCancel && onCancelRun ? (
          <button
            aria-label={`Stop ${item.label}`}
            onClick={() => onCancelRun(item.runId)}
            type="button"
          >
            Stop
          </button>
        ) : null}
      </section>
    );
  }
  if (item.kind === "approval") {
    return (
      <section
        aria-label={`${item.label} approval`}
        className="bluplai-chat__agent-card"
        data-kind="approval"
      >
        <strong>{item.label}</strong>
        {Object.entries(item.preview).length ? (
          <dl className="bluplai-chat__agent-preview">
            {Object.entries(item.preview).map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{Array.isArray(value) ? value.join(", ") : value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {item.state === "pending" && item.canApprove ? (
          <div className="bluplai-chat__agent-card-actions">
            {onApproveAction ? (
              <button
                aria-label={`Approve ${item.label}`}
                onClick={() => onApproveAction(item.actionId)}
                type="button"
              >
                Approve
              </button>
            ) : null}
            {onDenyAction ? (
              <button
                aria-label={`Deny ${item.label}`}
                onClick={() => onDenyAction(item.actionId)}
                type="button"
              >
                Deny
              </button>
            ) : null}
          </div>
        ) : (
          <span className="bluplai-chat__agent-state">
            {item.state.replaceAll("_", " ")}
          </span>
        )}
      </section>
    );
  }
  if (item.kind === "job") {
    const percent = Math.max(0, Math.min(100, item.percent ?? 0));
    return (
      <section className="bluplai-chat__agent-card" data-kind="job">
        <strong>{item.label}</strong>
        {item.state === "queued" || item.state === "running" ? (
          <>
            <div
              aria-label={`${item.label} progress`}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={percent}
              className="bluplai-chat__agent-progress"
              role="progressbar"
            >
              <span style={{ width: `${percent}%` }} />
            </div>
            <small>{percent}%</small>
          </>
        ) : (
          <>
            <span className="bluplai-chat__agent-state">
              {item.state.replaceAll("_", " ")}
            </span>
            {item.canRetry && onRetryJob ? (
              <button
                aria-label={`Retry ${item.label}`}
                onClick={() => onRetryJob(item.jobId)}
                type="button"
              >
                Retry
              </button>
            ) : null}
          </>
        )}
      </section>
    );
  }
  if (item.kind === "deep_link") {
    return safeInternalHref(item.href) ? (
      <a className="bluplai-chat__agent-deep-link" href={item.href}>
        {item.label}
      </a>
    ) : null;
  }
  if (item.kind === "connector_state") {
    return (
      <section
        className="bluplai-chat__agent-card"
        data-kind="connector_state"
        role="status"
      >
        <strong>{item.label}</strong>
        <span>{item.state.replaceAll("_", " ")}</span>
        {item.recoveryHref ? (
          <a href={item.recoveryHref}>Open integrations</a>
        ) : null}
      </section>
    );
  }
  return (
    <section
      className="bluplai-chat__agent-card"
      data-kind="failure"
      role="alert"
    >
      <strong>{item.label}</strong>
    </section>
  );
}

export interface MessageItemProps {
  message: ChatMessage;
  readState?: ChatReadState;
  compact?: boolean;
  deepLinkTarget?: boolean;
  threadReplyCount?: number;
  mentionNames?: string[];
  onReact?: (message: ChatMessage, emoji: string) => void;
  onOpenThread?: (message: ChatMessage) => void;
  onApproveAction?: (actionId: string) => void;
  onDenyAction?: (actionId: string) => void;
  onCancelRun?: (runId: string) => void;
  onRetryJob?: (jobId: string) => void;
}

export function MessageItem({
  message,
  readState,
  compact,
  deepLinkTarget = false,
  threadReplyCount = 0,
  mentionNames,
  onReact,
  onOpenThread,
  onApproveAction,
  onDenyAction,
  onCancelRun,
  onRetryJob,
}: MessageItemProps) {
  const read = isMessageRead(message, readState);
  const initials = message.author.displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return (
    <article
      aria-label={`Message from ${message.author.displayName}`}
      className={[
        "bluplai-chat__message",
        compact ? "bluplai-chat__message--compact" : "",
        message.deliveryState === "failed"
          ? "bluplai-chat__message--failed"
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-deep-link-target={deepLinkTarget || undefined}
      data-message-id={message.id}
      tabIndex={deepLinkTarget ? -1 : undefined}
    >
      <div className="bluplai-chat__avatar" aria-hidden="true">
        {message.author.avatarUrl ? (
          <img alt="" src={message.author.avatarUrl} />
        ) : (
          initials || "?"
        )}
      </div>
      <div className="bluplai-chat__message-body">
        <header className="bluplai-chat__message-header">
          <strong>{message.author.displayName}</strong>
          <time dateTime={message.createdAt}>
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
          <span
            aria-label={read ? "Read message" : "Unread message"}
            className="bluplai-chat__sr-only"
            role="status"
          >
            {read ? "Read message" : "Unread message"}
          </span>
          {message.deliveryState && message.deliveryState !== "sent" ? (
            <span className="bluplai-chat__delivery-state">
              {message.deliveryState}
            </span>
          ) : null}
        </header>
        <MessageContent body={message.body} mentionNames={mentionNames} />
        {message.agentOutputs?.length ? (
          <div className="bluplai-chat__agent-outputs">
            {latestOutputs(message.agentOutputs).map((item) => (
              <AgentOutputCard
                item={item}
                key={item.replacementKey}
                onApproveAction={onApproveAction}
                onCancelRun={onCancelRun}
                onDenyAction={onDenyAction}
                onRetryJob={onRetryJob}
              />
            ))}
          </div>
        ) : null}
        {message.attachments?.length ? (
          <div className="bluplai-chat__attachments">
            {message.attachments.map((attachment) => (
              <a
                download={attachment.name}
                href={attachment.downloadUrl}
                key={attachment.id}
                rel="noopener noreferrer"
              >
                {attachment.kind === "image" && attachment.thumbnailUrl ? (
                  <img alt={attachment.name} src={attachment.thumbnailUrl} />
                ) : (
                  <ChatIcon name="paperclip" />
                )}
                <span>{attachment.name}</span>
              </a>
            ))}
          </div>
        ) : null}
        {message.reactions.length > 0 || threadReplyCount > 0 ? (
          <div className="bluplai-chat__message-reactions">
            {message.reactions.map((reaction) => (
              <button
                aria-label={reactionLabel(
                  reaction.emoji,
                  reaction.count,
                  reaction.reactedByCurrentUser,
                )}
                aria-pressed={reaction.reactedByCurrentUser}
                disabled={!onReact || reaction.reactedByCurrentUser}
                key={reaction.emoji}
                onClick={() => onReact?.(message, reaction.emoji)}
                type="button"
              >
                <span aria-hidden="true">{reaction.emoji}</span>
                <span>{reaction.count}</span>
              </button>
            ))}
            {threadReplyCount > 0 && onOpenThread ? (
              <button
                className="bluplai-chat__thread-count"
                onClick={() => onOpenThread(message)}
                type="button"
              >
                <ChatIcon name="message" />
                {threadReplyCount}{" "}
                {threadReplyCount === 1 ? "reply" : "replies"}
              </button>
            ) : null}
          </div>
        ) : null}
        {onReact || onOpenThread ? (
          <div className="bluplai-chat__message-hover-actions">
            {onReact &&
            !message.reactions.some((reaction) => reaction.emoji === "👍") ? (
              <button
                aria-label="Add thumbs up reaction"
                onClick={() => onReact(message, "👍")}
                type="button"
              >
                <ChatIcon name="smile" />
              </button>
            ) : null}
            {onOpenThread ? (
              <button
                aria-label={
                  threadReplyCount > 0 ? "Open thread" : "Reply in thread"
                }
                onClick={() => onOpenThread(message)}
                type="button"
              >
                <ChatIcon name="message" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}
