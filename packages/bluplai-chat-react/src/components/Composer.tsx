import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type KeyboardEvent,
} from "react";
import type { ChatAttachment, ChatGif, ChatMember } from "../transport/types";
import { ChatIcon } from "./ChatIcon";

export interface ComposerSubmit {
  body: string;
  attachments: ChatAttachment[];
  gifs: ChatGif[];
  mentionedUserIds: string[];
}

export interface ComposerProps {
  roomId: string;
  roomName: string;
  members: ChatMember[];
  draftId?: string;
  disabled?: boolean;
  compact?: boolean;
  replyToLabel?: string;
  onCancelReply?: () => void;
  onSubmit: (value: ComposerSubmit) => Promise<void>;
  onUpload?: (file: File, signal: AbortSignal) => Promise<ChatAttachment>;
  onTypingChange?: (active: boolean) => void;
  searchGifs?: (query: string, signal: AbortSignal) => Promise<ChatGif[]>;
}

type Panel =
  | "mention"
  | "commands"
  | "emoji"
  | "gif"
  | "language"
  | "ai"
  | "more";
type Trigger = {
  panel: "mention" | "commands" | "emoji";
  query: string;
  start: number;
  end: number;
};

type AttachmentItem = {
  tempId: string;
  file: File;
  previewUrl?: string;
  status: "uploading" | "ready" | "error";
  attachment?: ChatAttachment;
  error?: string;
};

type MentionToken = {
  id: string;
  displayName: string;
  start: number;
  end: number;
};

type LanguageOption = {
  code: string;
  label: string;
  nativeLabel: string;
  direction?: "ltr" | "rtl";
};

const LANGUAGES: LanguageOption[] = [
  { code: "auto", label: "Auto-detect", nativeLabel: "Auto" },
  { code: "en", label: "English", nativeLabel: "English", direction: "ltr" },
  { code: "de", label: "German", nativeLabel: "Deutsch", direction: "ltr" },
  { code: "it", label: "Italian", nativeLabel: "Italiano", direction: "ltr" },
  { code: "fr", label: "French", nativeLabel: "Français", direction: "ltr" },
  { code: "es", label: "Spanish", nativeLabel: "Español", direction: "ltr" },
  {
    code: "pt",
    label: "Portuguese",
    nativeLabel: "Português",
    direction: "ltr",
  },
  { code: "ja", label: "Japanese", nativeLabel: "日本語", direction: "ltr" },
  { code: "ar", label: "Arabic", nativeLabel: "العربية", direction: "rtl" },
];

const EMOJIS = [
  ["thumbs up", "👍"],
  ["thumbs down", "👎"],
  ["clap", "👏"],
  ["celebrate", "🎉"],
  ["sparkles", "✨"],
  ["heart", "❤️"],
  ["blue heart", "💙"],
  ["fire", "🔥"],
  ["rocket", "🚀"],
  ["eyes", "👀"],
  ["check", "✅"],
  ["warning", "⚠️"],
  ["question", "❓"],
  ["idea", "💡"],
  ["target", "🎯"],
  ["chart", "📈"],
  ["calendar", "📅"],
  ["pin", "📌"],
  ["memo", "📝"],
  ["folder", "📁"],
  ["link", "🔗"],
  ["wave", "👋"],
  ["smile", "😀"],
  ["laugh", "😂"],
  ["happy", "😊"],
  ["thinking", "🤔"],
  ["mind blown", "🤯"],
  ["cool", "😎"],
  ["sad", "😢"],
  ["angry", "😠"],
  ["party", "🥳"],
  ["salute", "🫡"],
  ["handshake", "🤝"],
  ["muscle", "💪"],
  ["pray", "🙏"],
  ["fingers crossed", "🤞"],
  ["hundred", "💯"],
  ["trophy", "🏆"],
  ["medal", "🥇"],
  ["gift", "🎁"],
  ["coffee", "☕"],
  ["pizza", "🍕"],
  ["globe", "🌍"],
  ["sun", "☀️"],
  ["moon", "🌙"],
  ["robot", "🤖"],
  ["brain", "🧠"],
  ["magic", "🪄"],
] as const;

type CommandAction =
  | "ask-ai"
  | "summarise"
  | "decisions"
  | "tasks"
  | "translate"
  | "file"
  | "gif"
  | "emoji"
  | "language"
  | "format";

const COMMANDS: Array<{
  action: CommandAction;
  label: string;
  description: string;
  keywords: string;
}> = [
  {
    action: "ask-ai",
    label: "Ask Bluplai",
    description: "Bring the AI into this message",
    keywords: "ai agent bluplai ask",
  },
  {
    action: "summarise",
    label: "Summarise room",
    description: "Decisions, risks and next actions",
    keywords: "ai context summary room",
  },
  {
    action: "decisions",
    label: "Find decisions",
    description: "Extract decisions from room context",
    keywords: "ai context decisions",
  },
  {
    action: "tasks",
    label: "Create follow-ups",
    description: "Turn the conversation into tasks",
    keywords: "ai actions tasks follow up",
  },
  {
    action: "translate",
    label: "Translate latest",
    description: "Ask Bluplai to translate the latest message",
    keywords: "ai language translate",
  },
  {
    action: "file",
    label: "Attach files",
    description: "Upload, paste or drag files",
    keywords: "attachment upload image document",
  },
  {
    action: "gif",
    label: "Add a GIF",
    description: "Search GIPHY",
    keywords: "gif giphy media",
  },
  {
    action: "emoji",
    label: "Add emoji",
    description: "Search workspace emoji",
    keywords: "emoji reaction smile",
  },
  {
    action: "language",
    label: "Writing language",
    description: "Spellcheck and text direction",
    keywords: "language locale spellcheck",
  },
  {
    action: "format",
    label: "Formatting",
    description: "Bold, italic and inline code",
    keywords: "format bold italic code",
  },
];

const AI_PROMPTS = [
  [
    "Summarise this room",
    "Summarise this conversation. Call out decisions, risks and next actions.",
  ],
  [
    "Find the decisions",
    "Review this conversation and list the decisions already made, with any unresolved questions.",
  ],
  [
    "Create follow-ups",
    "Turn the follow-ups in this conversation into a clear action list with suggested owners.",
  ],
  [
    "Draft a response",
    "Draft a concise response to the latest message using the context and files in this room.",
  ],
] as const;

const MAX_ATTACHMENTS = 10;

function temporaryId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function safeStorageGet(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Draft persistence is a convenience; messaging remains available.
  }
}

function storedMentionTokens(key: string, body: string): MentionToken[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(
      (token): token is MentionToken =>
        typeof token?.id === "string" &&
        typeof token?.displayName === "string" &&
        Number.isInteger(token?.start) &&
        Number.isInteger(token?.end) &&
        body.slice(token.start, token.end) === `@${token.displayName}`,
    );
  } catch {
    return [];
  }
}

function reconcileMentionTokens(
  previousBody: string,
  nextBody: string,
  tokens: MentionToken[],
): MentionToken[] {
  let start = 0;
  while (
    start < previousBody.length &&
    start < nextBody.length &&
    previousBody[start] === nextBody[start]
  )
    start += 1;

  let previousEnd = previousBody.length;
  let nextEnd = nextBody.length;
  while (
    previousEnd > start &&
    nextEnd > start &&
    previousBody[previousEnd - 1] === nextBody[nextEnd - 1]
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  const delta = nextEnd - previousEnd;
  return tokens.flatMap((token) => {
    const shifted =
      token.end <= start
        ? token
        : token.start >= previousEnd
          ? { ...token, start: token.start + delta, end: token.end + delta }
          : null;
    if (
      !shifted ||
      nextBody.slice(shifted.start, shifted.end) !== `@${shifted.displayName}`
    )
      return [];
    return [shifted];
  });
}

function resolveTrigger(value: string, caret: number): Trigger | null {
  const before = value.slice(0, caret);
  const mention = before.match(/(?:^|\s)@([^\s@]*)$/u);
  if (mention) {
    return {
      panel: "mention",
      query: mention[1] ?? "",
      start: caret - (mention[1]?.length ?? 0) - 1,
      end: caret,
    };
  }
  const command = before.match(/(?:^|\s)\/([^\s/]*)$/u);
  if (command) {
    return {
      panel: "commands",
      query: command[1] ?? "",
      start: caret - (command[1]?.length ?? 0) - 1,
      end: caret,
    };
  }
  const emoji = before.match(/(?:^|\s):([\p{L}\p{N}_+-]{1,32})$/u);
  if (emoji) {
    return {
      panel: "emoji",
      query: emoji[1] ?? "",
      start: caret - (emoji[1]?.length ?? 0) - 1,
      end: caret,
    };
  }
  return null;
}

export function Composer({
  roomId,
  roomName,
  members,
  draftId,
  disabled,
  compact,
  replyToLabel,
  onCancelReply,
  onSubmit,
  onUpload,
  onTypingChange,
  searchGifs,
}: ComposerProps) {
  const draftKey = `bluplai-chat:draft:${roomId}:${draftId ?? "root"}`;
  const mentionsKey = `${draftKey}:mentions`;
  const suggestionId = useId().replaceAll(":", "");
  const [body, setBody] = useState(() => safeStorageGet(draftKey));
  const [attachmentItems, setAttachmentItems] = useState<AttachmentItem[]>([]);
  const [gifs, setGifs] = useState<ChatGif[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [emojiQuery, setEmojiQuery] = useState("");
  const [gifQuery, setGifQuery] = useState("");
  const [gifResults, setGifResults] = useState<ChatGif[]>([]);
  const [gifStatus, setGifStatus] = useState<"idle" | "loading" | "error">(
    "idle",
  );
  const [formatOpen, setFormatOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [languageCode, setLanguageCode] = useState(
    () => safeStorageGet("bluplai-chat:language") || "auto",
  );
  const [mentionTokens, setMentionTokens] = useState<MentionToken[]>(() =>
    storedMentionTokens(mentionsKey, safeStorageGet(draftKey)),
  );
  const composerRef = useRef<HTMLFormElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadControllers = useRef(new Map<string, AbortController>());
  const attachmentItemsRef = useRef<AttachmentItem[]>([]);
  const typingActive = useRef(false);
  const onTypingChangeRef = useRef(onTypingChange);
  const panelOriginRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    onTypingChangeRef.current = onTypingChange;
  }, [onTypingChange]);

  useEffect(() => {
    attachmentItemsRef.current = attachmentItems;
  }, [attachmentItems]);

  useEffect(() => {
    for (const controller of uploadControllers.current.values())
      controller.abort();
    uploadControllers.current.clear();
    for (const item of attachmentItemsRef.current) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    setAttachmentItems([]);
    setGifs([]);
    if (typingActive.current) {
      typingActive.current = false;
      onTypingChangeRef.current?.(false);
    }
    const storedBody = safeStorageGet(draftKey);
    setBody(storedBody);
    setMentionTokens(storedMentionTokens(mentionsKey, storedBody));
    setPanel(null);
    setTrigger(null);
  }, [draftKey, mentionsKey]);

  useEffect(() => {
    safeStorageSet(draftKey, body);
    safeStorageSet(
      mentionsKey,
      mentionTokens.length ? JSON.stringify(mentionTokens) : "",
    );
  }, [body, draftKey, mentionTokens, mentionsKey]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) {
        setPanel(null);
        setTrigger(null);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  useEffect(
    () => () => {
      for (const controller of uploadControllers.current.values())
        controller.abort();
      uploadControllers.current.clear();
      for (const item of attachmentItemsRef.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
      if (typingActive.current) onTypingChangeRef.current?.(false);
    },
    [],
  );

  useEffect(() => {
    if (panel !== "gif" || !searchGifs) return;
    const controller = new AbortController();
    setGifStatus("loading");
    const timer = window.setTimeout(() => {
      void searchGifs(gifQuery, controller.signal)
        .then((results) => {
          if (!controller.signal.aborted) {
            setGifResults(results);
            setGifStatus("idle");
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setGifResults([]);
            setGifStatus("error");
          }
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [gifQuery, panel, searchGifs]);

  useEffect(() => {
    if (
      !panel ||
      trigger ||
      !["emoji", "gif", "language", "ai", "more"].includes(panel)
    )
      return;
    const frame = window.requestAnimationFrame(() => {
      composerRef.current
        ?.querySelector<HTMLElement>(
          ".bluplai-chat__composer-popover input, .bluplai-chat__composer-popover button",
        )
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [panel, trigger]);

  const updateTyping = (active: boolean) => {
    if (typingActive.current === active) return;
    typingActive.current = active;
    onTypingChangeRef.current?.(active);
  };

  const selectedLanguage =
    LANGUAGES.find((item) => item.code === languageCode) ?? LANGUAGES[0];
  const agent = members.find((member) => member.role === "agent");

  const mentionOptions = useMemo(() => {
    const query =
      trigger?.panel === "mention" ? trigger.query.toLocaleLowerCase() : "";
    return members
      .filter(
        (member) =>
          !query || member.displayName.toLocaleLowerCase().includes(query),
      )
      .sort((left, right) => {
        if (left.role === "agent" && right.role !== "agent") return -1;
        if (right.role === "agent" && left.role !== "agent") return 1;
        if (left.presence === "online" && right.presence !== "online")
          return -1;
        if (right.presence === "online" && left.presence !== "online") return 1;
        return left.displayName.localeCompare(right.displayName);
      })
      .slice(0, 8);
  }, [members, trigger]);

  const commandOptions = useMemo(() => {
    const query =
      trigger?.panel === "commands" ? trigger.query.toLocaleLowerCase() : "";
    return COMMANDS.filter((command) => {
      if (command.action === "gif" && !searchGifs) return false;
      if (
        ["ask-ai", "summarise", "decisions", "tasks", "translate"].includes(
          command.action,
        ) &&
        !agent
      )
        return false;
      return (
        !query ||
        `${command.label} ${command.keywords}`
          .toLocaleLowerCase()
          .includes(query)
      );
    });
  }, [agent, searchGifs, trigger]);

  const emojiOptions = useMemo(() => {
    const query = (
      trigger?.panel === "emoji" ? trigger.query : emojiQuery
    ).toLocaleLowerCase();
    return EMOJIS.filter(([name]) => !query || name.includes(query)).slice(
      0,
      48,
    );
  }, [emojiQuery, trigger]);

  const replaceRange = useCallback(
    (
      start: number,
      end: number,
      value: string,
      mention?: Pick<MentionToken, "id" | "displayName">,
    ) => {
      const nextBody = `${body.slice(0, start)}${value}${body.slice(end)}`;
      setMentionTokens((current) => {
        const reconciled = reconcileMentionTokens(body, nextBody, current);
        return mention
          ? [
              ...reconciled,
              {
                ...mention,
                start,
                end: start + mention.displayName.length + 1,
              },
            ].sort((left, right) => left.start - right.start)
          : reconciled;
      });
      setBody(nextBody);
      window.requestAnimationFrame(() => {
        const next = start + value.length;
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(next, next);
      });
    },
    [body],
  );

  const insertAtCaret = (value: string) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? body.length;
    const end = textarea?.selectionEnd ?? start;
    replaceRange(start, end, value);
  };

  const selectMention = (member: ChatMember) => {
    const value = `@${member.displayName} `;
    if (trigger?.panel === "mention")
      replaceRange(trigger.start, trigger.end, value, member);
    else {
      const textarea = textareaRef.current;
      const start = textarea?.selectionStart ?? body.length;
      const end = textarea?.selectionEnd ?? start;
      replaceRange(start, end, value, member);
    }
    setPanel(null);
    setTrigger(null);
  };

  const applyAgentPrompt = (prompt: string) => {
    if (!agent) return;
    const mention = `@${agent.displayName}`;
    const prefix = `${mention} ${prompt}`;
    const nextBody = body.trim() ? `${prefix}\n\n${body}` : prefix;
    const shift = body.trim() ? prefix.length + 2 : 0;
    setMentionTokens((current) => [
      {
        id: agent.id,
        displayName: agent.displayName,
        start: 0,
        end: mention.length,
      },
      ...current.map((token) => ({
        ...token,
        start: token.start + shift,
        end: token.end + shift,
      })),
    ]);
    setBody(nextBody);
    setPanel(null);
    setTrigger(null);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const clearTypedTrigger = () => {
    if (trigger) replaceRange(trigger.start, trigger.end, "");
    setTrigger(null);
  };

  const runCommand = (action: CommandAction) => {
    if (trigger?.panel === "commands") clearTypedTrigger();
    if (action === "ask-ai" && agent) selectMention(agent);
    else if (action === "summarise")
      applyAgentPrompt(
        "Summarise this conversation. Call out decisions, risks and next actions.",
      );
    else if (action === "decisions")
      applyAgentPrompt(
        "Review this conversation and list the decisions already made, with any unresolved questions.",
      );
    else if (action === "tasks")
      applyAgentPrompt(
        "Turn the follow-ups in this conversation into a clear action list with suggested owners.",
      );
    else if (action === "translate")
      applyAgentPrompt(
        `Translate the latest message into ${selectedLanguage?.code === "auto" ? "my preferred language" : selectedLanguage?.label}.`,
      );
    else if (action === "file") fileInputRef.current?.click();
    else if (action === "gif" && searchGifs) setPanel("gif");
    else if (action === "emoji") setPanel("emoji");
    else if (action === "language") setPanel("language");
    else if (action === "format") {
      setFormatOpen(true);
      setPanel(null);
    }
  };

  const selectEmoji = (emoji: string) => {
    if (trigger?.panel === "emoji")
      replaceRange(trigger.start, trigger.end, `${emoji} `);
    else insertAtCaret(emoji);
    setPanel(null);
    setTrigger(null);
    setEmojiQuery("");
  };

  const wrapSelection = (prefix: string, suffix = prefix) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? body.length;
    const end = textarea?.selectionEnd ?? start;
    const selected = body.slice(start, end) || "text";
    replaceRange(start, end, `${prefix}${selected}${suffix}`);
  };

  const uploadItem = useCallback(
    async (item: AttachmentItem) => {
      if (!onUpload) return;
      const controller = new AbortController();
      uploadControllers.current.set(item.tempId, controller);
      setAttachmentItems((current) =>
        current.map((candidate) =>
          candidate.tempId === item.tempId
            ? { ...candidate, status: "uploading", error: undefined }
            : candidate,
        ),
      );
      try {
        const attachment = await onUpload(item.file, controller.signal);
        if (!controller.signal.aborted) {
          setAttachmentItems((current) =>
            current.map((candidate) =>
              candidate.tempId === item.tempId
                ? { ...candidate, attachment, status: "ready" }
                : candidate,
            ),
          );
        }
      } catch (caught) {
        if (!controller.signal.aborted) {
          setAttachmentItems((current) =>
            current.map((candidate) =>
              candidate.tempId === item.tempId
                ? {
                    ...candidate,
                    status: "error",
                    error:
                      caught instanceof Error
                        ? caught.message
                        : "Upload failed",
                  }
                : candidate,
            ),
          );
        }
      } finally {
        uploadControllers.current.delete(item.tempId);
      }
    },
    [onUpload],
  );

  const queueFiles = (files: File[]) => {
    if (!onUpload || files.length === 0) return;
    const available = Math.max(0, MAX_ATTACHMENTS - attachmentItems.length);
    const additions = files.slice(0, available).map<AttachmentItem>((file) => ({
      tempId: temporaryId(),
      file,
      previewUrl:
        file.type.startsWith("image/") &&
        typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(file)
          : undefined,
      status: "uploading",
    }));
    if (files.length > available)
      setError(`You can attach up to ${MAX_ATTACHMENTS} files to one message.`);
    setAttachmentItems((current) => [...current, ...additions]);
    for (const item of additions) void uploadItem(item);
  };

  const removeAttachment = (tempId: string) => {
    uploadControllers.current.get(tempId)?.abort();
    uploadControllers.current.delete(tempId);
    setAttachmentItems((current) => {
      const removed = current.find((item) => item.tempId === tempId);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((item) => item.tempId !== tempId);
    });
  };

  const resetAttachments = () => {
    for (const item of attachmentItems) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    setAttachmentItems([]);
  };

  const hasPendingUploads = attachmentItems.some(
    (item) => item.status === "uploading",
  );
  const hasFailedUploads = attachmentItems.some(
    (item) => item.status === "error",
  );
  const readyAttachments = attachmentItems.flatMap((item) =>
    item.attachment ? [item.attachment] : [],
  );
  const canSend =
    Boolean(body.trim() || readyAttachments.length || gifs.length) &&
    !hasPendingUploads &&
    !hasFailedUploads;

  const submit = async () => {
    if (!canSend || submitting || disabled) return;
    updateTyping(false);
    setSubmitting(true);
    setError(null);
    try {
      const retainedMentionIds = Array.from(
        new Set(
          mentionTokens
            .filter(
              (token) =>
                body.slice(token.start, token.end) === `@${token.displayName}`,
            )
            .map((token) => token.id),
        ),
      );
      await onSubmit({
        body: body.trim(),
        attachments: readyAttachments,
        gifs,
        mentionedUserIds: retainedMentionIds,
      });
      setBody("");
      safeStorageSet(draftKey, "");
      safeStorageSet(mentionsKey, "");
      resetAttachments();
      setGifs([]);
      setMentionTokens([]);
      setPanel(null);
      setTrigger(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Message failed to send",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleSuggestionKey = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): boolean => {
    if (!panel || !trigger) return false;
    const options =
      panel === "mention"
        ? mentionOptions
        : panel === "commands"
          ? commandOptions
          : emojiOptions;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) => {
        if (options.length === 0) return 0;
        return event.key === "ArrowDown"
          ? (current + 1) % options.length
          : (current - 1 + options.length) % options.length;
      });
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && options.length) {
      event.preventDefault();
      if (panel === "mention")
        selectMention(mentionOptions[selectedIndex] as ChatMember);
      else if (panel === "commands")
        runCommand(commandOptions[selectedIndex]?.action as CommandAction);
      else selectEmoji(emojiOptions[selectedIndex]?.[1] ?? "");
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setPanel(null);
      setTrigger(null);
      return true;
    }
    return false;
  };

  const closeManualPanel = (restoreFocus = false) => {
    setPanel(null);
    setTrigger(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => panelOriginRef.current?.focus());
    }
  };

  const openManualPanel = (next: Panel) => {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      !active.closest(".bluplai-chat__composer-popover")
    )
      panelOriginRef.current = active;
    setSelectedIndex(0);
    setPanel((current) => (current === next ? null : next));
    setTrigger(null);
  };

  const handleManualPanelKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeManualPanel(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ),
    );
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : event.key === "ArrowDown"
            ? (current + 1 + buttons.length) % buttons.length
            : (current - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  const optionId = (kind: string, value: string | number) =>
    `${suggestionId}-${kind}-${String(value).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const activeSuggestionId =
    panel === "mention" && mentionOptions[selectedIndex]
      ? optionId("mention", mentionOptions[selectedIndex].id)
      : panel === "commands" && commandOptions[selectedIndex]
        ? optionId("command", commandOptions[selectedIndex].action)
        : panel === "emoji" && trigger && emojiOptions[selectedIndex]
          ? optionId("emoji", emojiOptions[selectedIndex][0])
          : undefined;

  const renderPanel = () => {
    if (!panel) return null;
    if (panel === "mention") {
      return (
        <div
          aria-label="Mention someone"
          className="bluplai-chat__composer-popover"
          id={`${suggestionId}-suggestions`}
          role="listbox"
        >
          <header>
            <strong>People and AI</strong>
            <span>Enter to mention</span>
          </header>
          {mentionOptions.length ? (
            mentionOptions.map((member, index) => (
              <button
                aria-selected={index === selectedIndex}
                className={index === selectedIndex ? "is-selected" : ""}
                id={optionId("mention", member.id)}
                key={member.id}
                onClick={() => selectMention(member)}
                onMouseDown={(event) => event.preventDefault()}
                role="option"
                type="button"
              >
                <span className="bluplai-chat__suggestion-avatar">
                  {member.role === "agent" ? (
                    <ChatIcon name="sparkles" />
                  ) : (
                    member.displayName.slice(0, 1).toUpperCase()
                  )}
                </span>
                <span>
                  <strong>{member.displayName}</strong>
                  <small>
                    {member.role === "agent"
                      ? "AI agent · uses this room's context"
                      : member.role}
                  </small>
                </span>
                <i data-presence={member.presence} />
              </button>
            ))
          ) : (
            <p>No matching members in this room.</p>
          )}
        </div>
      );
    }
    if (panel === "commands") {
      return (
        <div
          aria-label="Message commands"
          className="bluplai-chat__composer-popover bluplai-chat__composer-command-menu"
          id={`${suggestionId}-suggestions`}
          role="listbox"
        >
          <header>
            <strong>Message actions</strong>
            <span>Type to filter</span>
          </header>
          {commandOptions.map((command, index) => (
            <button
              aria-selected={index === selectedIndex}
              className={index === selectedIndex ? "is-selected" : ""}
              id={optionId("command", command.action)}
              key={command.action}
              onClick={() => runCommand(command.action)}
              onMouseDown={(event) => event.preventDefault()}
              role="option"
              type="button"
            >
              <span className="bluplai-chat__command-icon">
                {command.action.includes("ai") ||
                ["summarise", "decisions", "tasks", "translate"].includes(
                  command.action,
                ) ? (
                  <ChatIcon name="sparkles" />
                ) : command.action === "file" ? (
                  <ChatIcon name="paperclip" />
                ) : command.action === "language" ? (
                  <ChatIcon name="language" />
                ) : command.action === "format" ? (
                  <ChatIcon name="format" />
                ) : command.action === "emoji" ? (
                  <ChatIcon name="smile" />
                ) : (
                  <span>GIF</span>
                )}
              </span>
              <span>
                <strong>{command.label}</strong>
                <small>{command.description}</small>
              </span>
            </button>
          ))}
        </div>
      );
    }
    if (panel === "emoji") {
      return (
        <div
          aria-label="Choose an emoji"
          className="bluplai-chat__composer-popover bluplai-chat__emoji-panel"
          onKeyDown={handleManualPanelKey}
          role="dialog"
        >
          <header>
            <strong>Emoji</strong>
            <span>{emojiOptions.length} results</span>
          </header>
          {!trigger ? (
            <input
              aria-label="Search emoji"
              onChange={(event) => setEmojiQuery(event.target.value)}
              placeholder="Search emoji"
              value={emojiQuery}
            />
          ) : null}
          <div
            className="bluplai-chat__emoji-grid"
            id={`${suggestionId}-suggestions`}
            role="listbox"
          >
            {emojiOptions.map(([name, emoji], index) => (
              <button
                aria-label={name}
                aria-selected={index === selectedIndex}
                className={index === selectedIndex ? "is-selected" : ""}
                id={optionId("emoji", name)}
                key={`${name}-${emoji}`}
                onClick={() => selectEmoji(emoji)}
                role="option"
                title={name}
                type="button"
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      );
    }
    if (panel === "gif") {
      return (
        <div
          aria-label="Choose a GIF"
          className="bluplai-chat__composer-popover bluplai-chat__gif-panel"
          onKeyDown={handleManualPanelKey}
          role="dialog"
        >
          <header>
            <strong>GIFs</strong>
            <span>Powered by GIPHY</span>
          </header>
          <input
            aria-label="Search GIFs"
            onChange={(event) => setGifQuery(event.target.value)}
            placeholder="Search GIFs"
            value={gifQuery}
          />
          {gifStatus === "loading" ? <p role="status">Finding GIFs…</p> : null}
          {gifStatus === "error" ? (
            <p role="alert">GIF search is unavailable. Try again.</p>
          ) : null}
          {gifStatus === "idle" && gifResults.length === 0 ? (
            <p>No GIFs found.</p>
          ) : null}
          <div className="bluplai-chat__gif-grid">
            {gifResults.map((gif) => (
              <button
                key={gif.id}
                onClick={() => {
                  setGifs((current) => [...current.slice(0, 3), gif]);
                  setPanel(null);
                  textareaRef.current?.focus();
                }}
                type="button"
              >
                <img
                  alt={gif.title || "GIF"}
                  loading="lazy"
                  src={gif.previewUrl}
                />
              </button>
            ))}
          </div>
        </div>
      );
    }
    if (panel === "language") {
      return (
        <div
          aria-label="Writing language"
          className="bluplai-chat__composer-popover bluplai-chat__language-panel"
          onKeyDown={handleManualPanelKey}
          role="dialog"
        >
          <header>
            <strong>Writing language</strong>
            <span>Spellcheck and direction</span>
          </header>
          {LANGUAGES.map((language) => (
            <button
              aria-pressed={language.code === languageCode}
              key={language.code}
              onClick={() => {
                setLanguageCode(language.code);
                safeStorageSet("bluplai-chat:language", language.code);
                setPanel(null);
                textareaRef.current?.focus();
              }}
              type="button"
            >
              <span>
                <strong>{language.nativeLabel}</strong>
                <small>{language.label}</small>
              </span>
              {language.code === languageCode ? (
                <span className="bluplai-chat__language-check">Selected</span>
              ) : null}
            </button>
          ))}
        </div>
      );
    }
    if (panel === "more") {
      return (
        <div
          aria-label="More message tools"
          className="bluplai-chat__composer-popover bluplai-chat__more-panel"
          onKeyDown={handleManualPanelKey}
          role="dialog"
        >
          <header>
            <strong>More message tools</strong>
            <span>Escape to close</span>
          </header>
          <button
            onClick={() => {
              setFormatOpen(true);
              closeManualPanel(true);
            }}
            type="button"
          >
            <ChatIcon name="format" />
            <span>
              <strong>Formatting</strong>
              <small>Bold, italic and inline code</small>
            </span>
          </button>
          <button onClick={() => openManualPanel("emoji")} type="button">
            <ChatIcon name="smile" />
            <span>
              <strong>Emoji</strong>
              <small>Search and add emoji</small>
            </span>
          </button>
          {searchGifs ? (
            <button onClick={() => openManualPanel("gif")} type="button">
              <span className="bluplai-chat__more-gif">GIF</span>
              <span>
                <strong>GIF</strong>
                <small>Search GIPHY</small>
              </span>
            </button>
          ) : null}
          <button onClick={() => openManualPanel("language")} type="button">
            <ChatIcon name="language" />
            <span>
              <strong>Writing language</strong>
              <small>Spellcheck and text direction</small>
            </span>
          </button>
        </div>
      );
    }
    return (
      <div
        aria-label="Ask Bluplai with room context"
        className="bluplai-chat__composer-popover bluplai-chat__ai-panel"
        onKeyDown={handleManualPanelKey}
        role="dialog"
      >
        <header>
          <strong>Ask Bluplai</strong>
          <span>Uses messages and files in this room</span>
        </header>
        {AI_PROMPTS.map(([label, prompt]) => (
          <button
            key={label}
            onClick={() => applyAgentPrompt(prompt)}
            type="button"
          >
            <ChatIcon name="sparkles" />
            <span>
              <strong>{label}</strong>
              <small>{prompt}</small>
            </span>
          </button>
        ))}
        <button
          onClick={() =>
            applyAgentPrompt(
              `Translate the latest message into ${selectedLanguage?.code === "auto" ? "my preferred language" : selectedLanguage?.label}.`,
            )
          }
          type="button"
        >
          <ChatIcon name="language" />
          <span>
            <strong>Translate latest</strong>
            <small>Use {selectedLanguage?.label.toLocaleLowerCase()}</small>
          </span>
        </button>
      </div>
    );
  };

  return (
    <form
      className={[
        "bluplai-chat__composer",
        compact ? "bluplai-chat__composer--compact" : "",
        dragOver ? "bluplai-chat__composer--dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onDragEnter={(event) => {
        if (onUpload && event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragOver(false);
      }}
      onDragOver={(event) => {
        if (onUpload && event.dataTransfer.types.includes("Files"))
          event.preventDefault();
      }}
      onDrop={(event) => {
        setDragOver(false);
        if (onUpload && event.dataTransfer.files.length) {
          event.preventDefault();
          queueFiles(Array.from(event.dataTransfer.files));
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      ref={composerRef}
    >
      {renderPanel()}
      {replyToLabel ? (
        <div className="bluplai-chat__replying-to">
          <span>
            Replying to <strong>{replyToLabel}</strong>
          </span>
          <button
            aria-label="Cancel reply"
            onClick={onCancelReply}
            type="button"
          >
            <ChatIcon name="x" />
          </button>
        </div>
      ) : null}
      {attachmentItems.length || gifs.length ? (
        <ul className="bluplai-chat__composer-attachments">
          {attachmentItems.map((item) => (
            <li data-status={item.status} key={item.tempId}>
              {item.previewUrl ? (
                <img alt="" src={item.previewUrl} />
              ) : (
                <span className="bluplai-chat__attachment-file">
                  <ChatIcon name="file" />
                </span>
              )}
              <span className="bluplai-chat__attachment-copy">
                <strong>{item.file.name}</strong>
                <small>
                  {item.status === "uploading"
                    ? "Uploading…"
                    : item.status === "error"
                      ? item.error
                      : formatBytes(item.file.size)}
                </small>
              </span>
              {item.status === "error" ? (
                <button
                  aria-label={`Retry ${item.file.name}`}
                  onClick={() => void uploadItem(item)}
                  type="button"
                >
                  Retry
                </button>
              ) : null}
              <button
                aria-label={`Remove ${item.file.name}`}
                onClick={() => removeAttachment(item.tempId)}
                type="button"
              >
                <ChatIcon name="x" />
              </button>
            </li>
          ))}
          {gifs.map((gif) => (
            <li className="bluplai-chat__composer-gif" key={gif.id}>
              <img alt={gif.title || "GIF"} src={gif.previewUrl} />
              <span>GIF</span>
              <button
                aria-label={`Remove ${gif.title || "GIF"}`}
                onClick={() =>
                  setGifs((current) =>
                    current.filter((item) => item.id !== gif.id),
                  )
                }
                type="button"
              >
                <ChatIcon name="x" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="bluplai-chat__composer-shell">
        {formatOpen ? (
          <div
            aria-label="Formatting"
            className="bluplai-chat__format-toolbar"
            role="toolbar"
          >
            <button
              aria-label="Bold"
              onClick={() => wrapSelection("**")}
              type="button"
            >
              <ChatIcon name="bold" />
            </button>
            <button
              aria-label="Italic"
              onClick={() => wrapSelection("*")}
              type="button"
            >
              <ChatIcon name="italic" />
            </button>
            <button
              aria-label="Inline code"
              onClick={() => wrapSelection("`")}
              type="button"
            >
              <ChatIcon name="code" />
            </button>
            <span>Markdown formatting</span>
            <button
              aria-label="Close formatting"
              onClick={() => setFormatOpen(false)}
              type="button"
            >
              <ChatIcon name="x" />
            </button>
          </div>
        ) : null}
        <textarea
          aria-activedescendant={activeSuggestionId}
          aria-autocomplete={panel && trigger ? "list" : undefined}
          aria-controls={
            panel && trigger ? `${suggestionId}-suggestions` : undefined
          }
          aria-expanded={Boolean(panel && trigger)}
          aria-haspopup="listbox"
          aria-label={`Message ${roomName}`}
          dir={selectedLanguage?.direction ?? "auto"}
          disabled={disabled || submitting}
          lang={
            selectedLanguage?.code === "auto"
              ? undefined
              : selectedLanguage?.code
          }
          onBlur={() => updateTyping(false)}
          onChange={(event) => {
            const value = event.target.value;
            const caret = event.target.selectionStart ?? value.length;
            setMentionTokens((current) =>
              reconcileMentionTokens(body, value, current),
            );
            setBody(value);
            updateTyping(Boolean(value.trim()));
            const nextTrigger = resolveTrigger(value, caret);
            setSelectedIndex(0);
            setTrigger(nextTrigger);
            setPanel(nextTrigger?.panel ?? null);
          }}
          onKeyDown={(event) => {
            if (handleSuggestionKey(event)) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length && onUpload) {
              event.preventDefault();
              queueFiles(files);
            }
          }}
          placeholder={`Message ${roomName} · @ people or AI · / for actions`}
          ref={textareaRef}
          rows={compact ? 1 : 2}
          role="combobox"
          spellCheck
          value={body}
        />
        <div className="bluplai-chat__composer-toolbar">
          <div
            aria-label="Add to message"
            className="bluplai-chat__composer-actions"
            role="toolbar"
          >
            {onUpload ? (
              <button
                aria-label="Attach files"
                onClick={() => fileInputRef.current?.click()}
                title="Attach files"
                type="button"
              >
                <ChatIcon name="plus" />
              </button>
            ) : null}
            <input
              className="bluplai-chat__sr-only"
              multiple
              onChange={(event) => {
                queueFiles(Array.from(event.target.files ?? []));
                event.currentTarget.value = "";
              }}
              ref={fileInputRef}
              type="file"
            />
            <button
              aria-label="Formatting"
              aria-pressed={formatOpen}
              className="bluplai-chat__composer-action--secondary"
              onClick={() => {
                setFormatOpen((current) => !current);
                setPanel(null);
              }}
              title="Formatting"
              type="button"
            >
              <ChatIcon name="format" />
            </button>
            <button
              aria-label="Emoji"
              className="bluplai-chat__composer-action--secondary"
              onClick={() => openManualPanel("emoji")}
              title="Emoji"
              type="button"
            >
              <ChatIcon name="smile" />
            </button>
            {searchGifs ? (
              <button
                aria-label="GIF"
                className="bluplai-chat__composer-action--secondary bluplai-chat__gif-button"
                onClick={() => openManualPanel("gif")}
                title="GIF"
                type="button"
              >
                GIF
              </button>
            ) : null}
            <button
              aria-label="Mention someone"
              onClick={() => {
                insertAtCaret("@");
                window.requestAnimationFrame(() => {
                  const textarea = textareaRef.current;
                  if (!textarea) return;
                  const next = resolveTrigger(
                    textarea.value,
                    textarea.selectionStart,
                  );
                  setTrigger(next);
                  setPanel("mention");
                });
              }}
              title="Mention someone"
              type="button"
            >
              <ChatIcon name="at" />
            </button>
            {agent ? (
              <button
                aria-label="Ask Bluplai"
                onClick={() => openManualPanel("ai")}
                title="Ask Bluplai with room context"
                type="button"
              >
                <ChatIcon name="sparkles" />
              </button>
            ) : null}
            <button
              aria-label={`Writing language: ${selectedLanguage?.label}`}
              className="bluplai-chat__composer-action--secondary bluplai-chat__language-button"
              onClick={() => openManualPanel("language")}
              title="Writing language"
              type="button"
            >
              <ChatIcon name="language" />
              <span>
                {selectedLanguage?.code === "auto"
                  ? "Auto"
                  : selectedLanguage?.code.toUpperCase()}
              </span>
            </button>
            <button
              aria-label="More message tools"
              className="bluplai-chat__mobile-more-button"
              onClick={() => openManualPanel("more")}
              title="More message tools"
              type="button"
            >
              <ChatIcon name="more" />
            </button>
            <span className="bluplai-chat__composer-hint">
              Enter to send · Shift + Enter for a new line
            </span>
          </div>
          <button
            aria-label={
              submitting
                ? "Sending…"
                : hasPendingUploads
                  ? "Files are uploading"
                  : hasFailedUploads
                    ? "Resolve failed uploads before sending"
                    : "Send"
            }
            disabled={disabled || submitting || !canSend}
            type="submit"
          >
            <span>{submitting ? "Sending…" : "Send"}</span>
            <ChatIcon name="send" />
          </button>
        </div>
        {dragOver ? (
          <div className="bluplai-chat__drop-target">
            <ChatIcon name="paperclip" />
            <strong>Drop files to add them</strong>
            <span>Images, documents and media</span>
          </div>
        ) : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}
