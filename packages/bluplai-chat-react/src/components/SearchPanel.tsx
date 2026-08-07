import type { RefObject } from "react";
import type { ChatMessage } from "../transport/types";
import { ChatIcon } from "./ChatIcon";

export interface SearchPanelProps {
  query: string;
  messages: ChatMessage[];
  onQueryChange: (value: string) => void;
  onClose: () => void;
  onSelect: (message: ChatMessage) => void;
  onEscape?: () => void;
  closeButtonRef?: RefObject<HTMLButtonElement>;
  status?: "idle" | "loading" | "error";
}

export function SearchPanel({
  query,
  messages,
  onQueryChange,
  onClose,
  onSelect,
  onEscape,
  closeButtonRef,
  status = "idle",
}: SearchPanelProps) {
  const normalized = query.trim().toLocaleLowerCase();
  const results = normalized
    ? messages.filter(
        (message) =>
          message.body.toLocaleLowerCase().includes(normalized) ||
          message.author.displayName.toLocaleLowerCase().includes(normalized),
      )
    : [];
  return (
    <aside
      aria-label="Search messages"
      className="bluplai-chat__search-panel"
      onKeyDown={(event) => {
        if (event.key === "Escape") onEscape?.();
      }}
    >
      <header>
        <strong>Search</strong>
        <button
          aria-label="Close search"
          onClick={onClose}
          ref={closeButtonRef}
          type="button"
        >
          <ChatIcon name="x" />
        </button>
      </header>
      <label className="bluplai-chat__search-field">
        <ChatIcon name="search" />
        <input
          aria-label="Search messages"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search this conversation"
          type="search"
          value={query}
        />
      </label>
      <div aria-live="polite" className="bluplai-chat__search-results">
        {status === "loading" ? <p>Searching messages…</p> : null}
        {status === "error" ? (
          <p role="alert">Search couldn’t be completed. Try again.</p>
        ) : null}
        {status === "idle" && normalized && results.length === 0 ? (
          <p>No matching messages.</p>
        ) : null}
        {results.map((message) => (
          <button
            key={message.id}
            onClick={() => onSelect(message)}
            type="button"
          >
            <strong>{message.author.displayName}</strong>
            <span>{message.body}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
