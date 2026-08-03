import type { ChatMessage, ChatReadState } from "../transport/types";

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

export interface MessageItemProps {
  message: ChatMessage;
  readState?: ChatReadState;
  compact?: boolean;
  threadReplyCount?: number;
  onReact?: (message: ChatMessage, emoji: string) => void;
  onOpenThread?: (message: ChatMessage) => void;
}

export function MessageItem({
  message,
  readState,
  compact,
  threadReplyCount = 0,
  onReact,
  onOpenThread,
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
        <p>{message.body}</p>
        {message.attachments?.length ? (
          <div className="bluplai-chat__attachments">
            {message.attachments.map((attachment) => (
              <a href={attachment.downloadUrl} key={attachment.id}>
                {attachment.kind === "image" && attachment.thumbnailUrl ? (
                  <img alt={attachment.name} src={attachment.thumbnailUrl} />
                ) : (
                  <span aria-hidden="true">↧</span>
                )}
                <span>{attachment.name}</span>
              </a>
            ))}
          </div>
        ) : null}
        <div className="bluplai-chat__message-actions">
          {message.reactions.map((reaction) => (
            <button
              aria-label={reactionLabel(
                reaction.emoji,
                reaction.count,
                reaction.reactedByCurrentUser,
              )}
              aria-pressed={reaction.reactedByCurrentUser}
              disabled={reaction.reactedByCurrentUser}
              key={reaction.emoji}
              onClick={() => onReact?.(message, reaction.emoji)}
              type="button"
            >
              <span aria-hidden="true">{reaction.emoji}</span>
              <span>{reaction.count}</span>
            </button>
          ))}
          {onReact &&
          !message.reactions.some((reaction) => reaction.emoji === "👍") ? (
            <button
              aria-label="Add thumbs up reaction"
              onClick={() => onReact(message, "👍")}
              type="button"
            >
              <span aria-hidden="true">＋👍</span>
            </button>
          ) : null}
          {onOpenThread ? (
            <button onClick={() => onOpenThread(message)} type="button">
              {threadReplyCount > 0
                ? `${threadReplyCount} ${threadReplyCount === 1 ? "reply" : "replies"}`
                : "Reply"}
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
