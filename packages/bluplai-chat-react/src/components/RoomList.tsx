import type { ChatRoom } from "../transport/types";

export interface RoomListProps {
  rooms: ChatRoom[];
  selectedRoomId: string | null;
  compact?: boolean;
  onSelect: (room: ChatRoom) => void;
  onCreateRoom?: () => void;
  onCreateDm?: () => void;
}

function scopeIcon(room: ChatRoom): string {
  if (room.disclosureScope === "dm") return "◉";
  if (room.disclosureScope === "private") return "◆";
  if (room.disclosureScope === "shared") return "◎";
  return "#";
}

function roomButtonLabel(room: ChatRoom): string {
  return room.unreadCount > 0
    ? `${room.name}, ${room.unreadCount} unread`
    : room.name;
}

export function RoomList({
  rooms,
  selectedRoomId,
  compact,
  onSelect,
  onCreateRoom,
  onCreateDm,
}: RoomListProps) {
  const channels = rooms.filter((room) => room.disclosureScope !== "dm");
  const dms = rooms.filter((room) => room.disclosureScope === "dm");
  const renderRooms = (items: ChatRoom[]) =>
    items.map((room) => (
      <button
        aria-current={room.id === selectedRoomId ? "page" : undefined}
        aria-label={roomButtonLabel(room)}
        key={room.id}
        onClick={() => onSelect(room)}
        type="button"
      >
        <span aria-hidden="true" className="bluplai-chat__room-icon">
          {scopeIcon(room)}
        </span>
        <span className="bluplai-chat__room-name">{room.name}</span>
        {room.unreadCount > 0 ? (
          <span aria-hidden="true" className="bluplai-chat__unread-count">
            {room.unreadCount > 99 ? "99+" : room.unreadCount}
          </span>
        ) : null}
      </button>
    ));

  return (
    <nav
      aria-label="Chat rooms"
      className={[
        "bluplai-chat__rooms",
        compact ? "bluplai-chat__rooms--compact" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="bluplai-chat__room-section-header">
        <span>Channels</span>
        {onCreateRoom ? (
          <button
            aria-label="Create channel"
            onClick={onCreateRoom}
            type="button"
          >
            +
          </button>
        ) : null}
      </div>
      {renderRooms(channels)}
      <div className="bluplai-chat__room-section-header">
        <span>Direct messages</span>
        {onCreateDm ? (
          <button
            aria-label="Start direct message"
            onClick={onCreateDm}
            type="button"
          >
            +
          </button>
        ) : null}
      </div>
      {renderRooms(dms)}
    </nav>
  );
}
