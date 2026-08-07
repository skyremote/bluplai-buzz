import { useEffect, useRef, useState } from "react";
import type { ChatAttachment } from "../transport/types";
import { ChatIcon } from "./ChatIcon";

export interface ComposerSubmit {
  body: string;
  attachments: ChatAttachment[];
}

export interface ComposerProps {
  roomName: string;
  disabled?: boolean;
  compact?: boolean;
  replyToLabel?: string;
  onCancelReply?: () => void;
  onSubmit: (value: ComposerSubmit) => Promise<void>;
  onUpload?: (file: File, signal: AbortSignal) => Promise<ChatAttachment>;
  onTypingChange?: (active: boolean) => void;
}

export function Composer({
  roomName,
  disabled,
  compact,
  replyToLabel,
  onCancelReply,
  onSubmit,
  onUpload,
  onTypingChange,
}: ComposerProps) {
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const typingActive = useRef(false);
  const onTypingChangeRef = useRef(onTypingChange);

  useEffect(() => {
    onTypingChangeRef.current = onTypingChange;
  }, [onTypingChange]);

  const updateTyping = (active: boolean) => {
    if (typingActive.current === active) return;
    typingActive.current = active;
    onTypingChangeRef.current?.(active);
  };

  useEffect(
    () => () => {
      uploadController.current?.abort();
      uploadController.current = null;
      if (typingActive.current) onTypingChangeRef.current?.(false);
    },
    [],
  );

  const submit = async () => {
    if ((!body.trim() && attachments.length === 0) || submitting || disabled)
      return;
    updateTyping(false);
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ body: body.trim(), attachments });
      setBody("");
      setAttachments([]);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Message failed to send",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const upload = async (file: File) => {
    if (!onUpload) return;
    uploadController.current?.abort();
    const controller = new AbortController();
    uploadController.current = controller;
    setError(null);
    try {
      const attachment = await onUpload(file, controller.signal);
      setAttachments((current) => [...current, attachment]);
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : "Upload failed");
      }
    } finally {
      if (uploadController.current === controller) {
        uploadController.current = null;
      }
    }
  };

  return (
    <div
      className={
        compact
          ? "bluplai-chat__composer bluplai-chat__composer--compact"
          : "bluplai-chat__composer"
      }
    >
      {replyToLabel ? (
        <div className="bluplai-chat__replying-to">
          <span>Replying to {replyToLabel}</span>
          <button
            aria-label="Cancel reply"
            onClick={onCancelReply}
            type="button"
          >
            <ChatIcon name="x" />
          </button>
        </div>
      ) : null}
      {attachments.length ? (
        <div className="bluplai-chat__composer-attachments">
          {attachments.map((attachment) => (
            <span key={attachment.id}>
              {attachment.name}
              <button
                aria-label={`Remove ${attachment.name}`}
                onClick={() =>
                  setAttachments((current) =>
                    current.filter((item) => item.id !== attachment.id),
                  )
                }
                type="button"
              >
                <ChatIcon name="x" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="bluplai-chat__composer-shell">
        <textarea
          aria-label={`Message ${roomName}`}
          disabled={disabled || submitting}
          onBlur={() => updateTyping(false)}
          onChange={(event) => {
            setBody(event.target.value);
            updateTyping(Boolean(event.target.value.trim()));
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={`Message ${roomName}`}
          rows={compact ? 1 : 2}
          value={body}
        />
        <div className="bluplai-chat__composer-toolbar">
          <div>
            {onUpload ? (
              <label className="bluplai-chat__composer-icon-button">
                <ChatIcon name="paperclip" />
                <span className="bluplai-chat__sr-only">Attach file</span>
                <input
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void upload(file);
                    event.currentTarget.value = "";
                  }}
                  type="file"
                />
              </label>
            ) : null}
            <span className="bluplai-chat__composer-hint">
              Enter to send · Shift + Enter for a new line
            </span>
          </div>
          <button
            aria-label={submitting ? "Sending…" : "Send"}
            disabled={
              disabled ||
              submitting ||
              (!body.trim() && attachments.length === 0)
            }
            onClick={() => void submit()}
            type="button"
          >
            <span>{submitting ? "Sending…" : "Send"}</span>
            <ChatIcon name="send" />
          </button>
        </div>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
