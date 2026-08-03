import type { ChatMessage } from "../transport/types";

export interface SearchPanelProps {
  query: string;
  messages: ChatMessage[];
  onQueryChange: (value: string) => void;
  onClose: () => void;
  onSelect: (message: ChatMessage) => void;
}

export function SearchPanel({
  query,
  messages,
  onQueryChange,
  onClose,
  onSelect,
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
    <aside aria-label="Search messages" className="bluplai-chat__search-panel">
      <header>
        <strong>Search</strong>
        <button aria-label="Close search" onClick={onClose} type="button">
          ×
        </button>
      </header>
      <input
        aria-label="Search messages"
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Search this room"
        type="search"
        value={query}
      />
      <div aria-live="polite" className="bluplai-chat__search-results">
        {normalized && results.length === 0 ? (
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
