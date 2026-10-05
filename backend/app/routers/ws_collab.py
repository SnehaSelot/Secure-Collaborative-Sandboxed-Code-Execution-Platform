"""
app/routers/ws_collab.py — Yjs collaboration WebSocket endpoint.

    ws://host/ws/collab/{room_id}

    room_id = "{session_id}:{file_id}"   (both UUIDs, colon-separated)

Speaks the standard y-websocket wire protocol, so the frontend can use the
stock client with no custom code:

    import { WebsocketProvider } from "y-websocket";
    const provider = new WebsocketProvider(
        "ws://localhost:8000/ws/collab",
        `${sessionId}:${fileId}`,
        ydoc,
        { params: { token: accessToken } }
    );

(y-websocket appends "/<roomId>" to the base URL.)
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Protocol

from fastapi import APIRouter, HTTPException, WebSocket
from pycrdt import (
    Doc,
    Text,
    YMessageType,
    create_sync_message,
    create_update_message,
    handle_sync_message,
    write_var_uint,
)

from app.auth import CollabUser, verify_token
from app.config import (
    COLLAB_CLIENT_QUEUE_MAXSIZE,
    COLLAB_MAX_MESSAGE_BYTES,
    COLLAB_MAX_ROOM_CLIENTS,
    COLLAB_ROOM_IDLE_SECONDS,
    _WS_ALLOWED_ORIGINS,
    get_settings,
)
from app.db import (
    get_file,
    get_session,
    is_participant,
    touch_session,
    upsert_file_snapshot,
    wake_session,
)

logger = logging.getLogger("exec-service")

router = APIRouter()

# room_id = "{session_id}:{file_id}" — both lowercase UUID hex + hyphens + colon
_ROOM_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

# Custom close codes (4000-4999 are application-defined).
_CLOSE_BAD_ORIGIN = 4003
_CLOSE_BAD_ROOM = 4400
_CLOSE_UNAUTHORIZED = 4401
_CLOSE_FORBIDDEN = 4403
_CLOSE_NOT_FOUND = 4404
_CLOSE_SESSION_CLOSED = 4409
_CLOSE_ROOM_FULL = 4429


# ---------------------------------------------------------------------------
# Persistence interface (B5)
# ---------------------------------------------------------------------------


class YStateStore(Protocol):
    """Where room documents live between sessions."""

    async def load(self, room_id: str) -> bytes | None: ...
    async def save(self, room_id: str, state: bytes) -> None: ...


class InMemoryStateStore:
    """Default store: survives rooms being evicted, not a process restart.

    Used in tests and when COLLAB_PERSIST_ENABLED=False.
    """

    def __init__(self) -> None:
        self._data: dict[str, bytes] = {}

    async def load(self, room_id: str) -> bytes | None:
        return self._data.get(room_id)

    async def save(self, room_id: str, state: bytes) -> None:
        self._data[room_id] = state


class DbStateStore:
    """Postgres-backed store: reads/writes files.yjs_state (B5).

    room_id is "{session_id}:{file_id}".
    Also extracts plain text from the Y.Text "content" key and writes it
    to files.content so the rest of the app can read it without pycrdt.
    """

    async def load(self, room_id: str) -> bytes | None:
        session_id, file_id = _split_room_id(room_id)
        if session_id is None or file_id is None:
            return None
        row = await get_file(session_id, file_id)
        if row is None:
            return None
        return row.get("yjs_state")

    async def save(self, room_id: str, state: bytes) -> None:
        session_id, file_id = _split_room_id(room_id)
        if session_id is None or file_id is None:
            return
        # Attempt to extract plain text from the Y.Text named "content"
        content: str | None = None
        try:
            doc = Doc()
            doc.apply_update(state)
            text_map = doc.get("content", type=Text)
            content = str(text_map) if text_map is not None else None
        except Exception:
            pass  # non-text doc or key missing — skip content extraction
        await upsert_file_snapshot(session_id, file_id, state, content)


def _split_room_id(room_id: str) -> tuple[str, str] | tuple[None, None]:
    """Parse "{session_id}:{file_id}" into its two UUID parts."""
    parts = room_id.split(":", 1)
    if len(parts) != 2:
        return None, None
    session_id, file_id = parts
    if not (_UUID_RE.match(session_id) and _UUID_RE.match(file_id)):
        return None, None
    return session_id, file_id


_store: YStateStore = InMemoryStateStore()


def set_state_store(store: YStateStore) -> None:
    global _store
    _store = store


# ---------------------------------------------------------------------------
# Awareness wire helpers
# ---------------------------------------------------------------------------


def _read_var_uint(buf: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        if pos >= len(buf):
            raise ValueError("truncated varint")
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if byte < 0x80:
            return result, pos
        shift += 7
        if shift > 63:
            raise ValueError("varint too large")


def _parse_awareness(payload: bytes) -> list[tuple[int, int, str]]:
    """Decode the *inner* awareness payload into (client_id, clock, state_json)."""
    pos = 0
    count, pos = _read_var_uint(payload, pos)
    entries = []
    for _ in range(count):
        cid, pos = _read_var_uint(payload, pos)
        clock, pos = _read_var_uint(payload, pos)
        length, pos = _read_var_uint(payload, pos)
        raw = payload[pos : pos + length]
        if len(raw) != length:
            raise ValueError("truncated awareness state")
        pos += length
        entries.append((cid, clock, raw.decode("utf-8")))
    return entries


def _encode_awareness(entries: list[tuple[int, int, str]]) -> bytes:
    """Build a full AWARENESS message (type byte + length-prefixed payload)."""
    inner = bytearray(write_var_uint(len(entries)))
    for cid, clock, state in entries:
        raw = state.encode("utf-8")
        inner += write_var_uint(cid)
        inner += write_var_uint(clock)
        inner += write_var_uint(len(raw))
        inner += raw
    return bytes([YMessageType.AWARENESS]) + write_var_uint(len(inner)) + bytes(inner)


# ---------------------------------------------------------------------------
# Rooms
# ---------------------------------------------------------------------------


@dataclass(eq=False)
class _Client:
    ws: WebSocket
    user: CollabUser
    outbox: asyncio.Queue = field(
        default_factory=lambda: asyncio.Queue(maxsize=COLLAB_CLIENT_QUEUE_MAXSIZE)
    )
    awareness_ids: set[int] = field(default_factory=set)
    dropped: bool = False


async def _safe_close(ws: WebSocket, code: int, reason: str = "") -> None:
    try:
        await ws.close(code=code, reason=reason)
    except Exception:
        pass


class _Room:
    def __init__(self, room_id: str) -> None:
        self.room_id = room_id
        self.doc = Doc()
        self.clients: set[_Client] = set()
        self.awareness: dict[int, tuple[int, str]] = {}  # id -> (clock, json)
        self.dirty = False
        self.evict_handle: asyncio.TimerHandle | None = None
        self._snapshot_task: asyncio.Task | None = None
        self._origin: _Client | None = None
        self.doc.observe(self._on_update)

    def _on_update(self, event) -> None:
        self.dirty = True
        self.broadcast(
            create_update_message(event.update),
            exclude=self._origin,
        )

    def send(self, client: _Client, msg: bytes) -> None:
        if client.dropped:
            return
        try:
            client.outbox.put_nowait(msg)
        except asyncio.QueueFull:
            client.dropped = True
            logger.warning("Collab client too slow in room %s — dropping", self.room_id)
            asyncio.ensure_future(_safe_close(client.ws, 1013))

    def broadcast(self, msg: bytes, exclude: "_Client | None" = None) -> None:
        for c in list(self.clients):
            if c is not exclude:
                self.send(c, msg)

    def cancel_eviction(self) -> None:
        if self.evict_handle is not None:
            self.evict_handle.cancel()
            self.evict_handle = None

    async def save(self) -> None:
        if not self.dirty:
            return
        await _store.save(self.room_id, self.doc.get_update())
        self.dirty = False

    def _start_snapshot_loop(self) -> None:
        """Start periodic debounced snapshot if persistence is enabled."""
        settings = get_settings()
        if not settings.COLLAB_PERSIST_ENABLED:
            return
        if self._snapshot_task is not None and not self._snapshot_task.done():
            return
        self._snapshot_task = asyncio.ensure_future(self._snapshot_loop())

    def _stop_snapshot_loop(self) -> None:
        if self._snapshot_task is not None:
            self._snapshot_task.cancel()
            self._snapshot_task = None

    async def _snapshot_loop(self) -> None:
        settings = get_settings()
        interval = settings.COLLAB_SNAPSHOT_INTERVAL
        try:
            while True:
                await asyncio.sleep(interval)
                if self.dirty:
                    try:
                        await self.save()
                        logger.debug(
                            "Collab room %s: periodic snapshot saved", self.room_id
                        )
                    except Exception:
                        logger.exception(
                            "Collab room %s: periodic snapshot failed", self.room_id
                        )
        except asyncio.CancelledError:
            pass


_rooms: dict[str, _Room] = {}
_registry_lock = asyncio.Lock()


async def close_room_for_file(file_id: str, code: int = 4404, reason: str = "File deleted") -> None:
    """
    Close any active in-memory room for this file_id without saving snapshot.
    Prevents resurrected rows on file deletion.
    """
    async with _registry_lock:
        to_remove = [r for rid, r in _rooms.items() if rid.endswith(f":{file_id}")]
        for room in to_remove:
            room.cancel_eviction()
            room._stop_snapshot_loop()
            room.dirty = False  # skip flush
            for c in list(room.clients):
                c.dropped = True
                asyncio.ensure_future(_safe_close(c.ws, code, reason))
            _rooms.pop(room.room_id, None)
            logger.info("Closed collab room %s for deleted file %s", room.room_id, file_id)


async def _join_room(room_id: str, client: _Client) -> _Room | None:
    """Fetch (or create + load) the room and add the client; None if full."""
    async with _registry_lock:
        room = _rooms.get(room_id)
        if room is None:
            room = _Room(room_id)
            settings = get_settings()
            if settings.COLLAB_PERSIST_ENABLED:
                saved = await _store.load(room_id)
                if saved:
                    room.doc.apply_update(saved)
                    room.dirty = False
                else:
                    session_id, file_id = _split_room_id(room_id)
                    if session_id and file_id:
                        row = await get_file(session_id, file_id)
                        if row and row.get("content"):
                            text_val = row["content"]
                            ytext = Text()
                            room.doc["content"] = ytext
                            ytext += text_val
                            room.dirty = True
                            await room.save()
            _rooms[room_id] = room
        if len(room.clients) >= COLLAB_MAX_ROOM_CLIENTS:
            return None
        room.cancel_eviction()
        room.clients.add(client)
        room._start_snapshot_loop()
        return room


def _schedule_eviction(room: _Room) -> None:
    room.cancel_eviction()
    loop = asyncio.get_running_loop()
    room.evict_handle = loop.call_later(
        COLLAB_ROOM_IDLE_SECONDS, lambda: asyncio.ensure_future(_evict(room))
    )


async def _evict(room: _Room) -> None:
    async with _registry_lock:
        if room.clients or _rooms.get(room.room_id) is not room:
            return
        room._stop_snapshot_loop()
        settings = get_settings()
        if settings.COLLAB_PERSIST_ENABLED:
            try:
                await room.save()
            except Exception:
                logger.exception(
                    "Saving room %s failed — keeping it in memory", room.room_id
                )
                _schedule_eviction(room)
                return
        del _rooms[room.room_id]
        logger.info("Collab room %s evicted", room.room_id)


async def flush_all_rooms() -> None:
    """Persist every dirty room. Call from the app shutdown hook."""
    settings = get_settings()
    for room in list(_rooms.values()):
        room._stop_snapshot_loop()
        if settings.COLLAB_PERSIST_ENABLED:
            try:
                await room.save()
            except Exception:
                logger.exception("Flushing room %s failed", room.room_id)


def collab_stats() -> dict:
    return {
        "rooms": len(_rooms),
        "clients": sum(len(r.clients) for r in _rooms.values()),
    }


# ---------------------------------------------------------------------------
# Message handling
# ---------------------------------------------------------------------------


def _handle_message(room: _Room, client: _Client, data: bytes) -> None:
    """Process one binary frame. Raises ValueError on malformed input."""
    if len(data) < 2:
        raise ValueError("frame too short")
    mtype = data[0]

    if mtype == YMessageType.SYNC:
        room._origin = client
        try:
            reply = handle_sync_message(data[1:], room.doc)
        except Exception as exc:
            raise ValueError(f"bad sync message: {exc}") from exc
        finally:
            room._origin = None
        if reply is not None:
            room.send(client, reply)

    elif mtype == YMessageType.AWARENESS:
        length, pos = _read_var_uint(data, 1)
        payload = data[pos : pos + length]
        if len(payload) != length:
            raise ValueError("truncated awareness frame")
        for cid, clock, state in _parse_awareness(payload):
            current = room.awareness.get(cid)
            if current is not None and clock < current[0]:
                continue  # stale
            if state == "null":
                room.awareness.pop(cid, None)
                client.awareness_ids.discard(cid)
            else:
                json.loads(state)  # reject garbage
                room.awareness[cid] = (clock, state)
                client.awareness_ids.add(cid)
        room.broadcast(data, exclude=client)


def _leave_room(room: _Room, client: _Client) -> None:
    room.clients.discard(client)

    # Tell remaining peers this connection's cursors are gone.
    removed = []
    for cid in client.awareness_ids:
        entry = room.awareness.pop(cid, None)
        if entry is not None:
            removed.append((cid, entry[0] + 1, "null"))
    if removed and room.clients:
        room.broadcast(_encode_awareness(removed))

    if not room.clients:
        room._stop_snapshot_loop()
        _schedule_eviction(room)


async def _sender(client: _Client) -> None:
    try:
        while True:
            msg = await client.outbox.get()
            await client.ws.send_bytes(msg)
    except asyncio.CancelledError:
        raise
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Internal WS auth helper (does not log token)
# ---------------------------------------------------------------------------


async def _get_current_user_ws(token: str) -> CollabUser | None:
    """Validate the ?token= query param. Returns None on failure."""
    if not token:
        return None
    try:
        return verify_token(token)
    except HTTPException:
        return None


# ---------------------------------------------------------------------------
# Endpoint (B1 + B3 + B4 + B5)
# ---------------------------------------------------------------------------


@router.websocket("/ws/collab/{room_id}")
async def ws_collab(websocket: WebSocket, room_id: str, token: str = ""):
    # B1: configurable origin check (before accept)
    origin = websocket.headers.get("origin", "")
    if origin and origin not in _WS_ALLOWED_ORIGINS:
        await websocket.close(code=_CLOSE_BAD_ORIGIN, reason="Origin not allowed")
        return

    # Room ID must match the allowed pattern
    if not _ROOM_ID_RE.match(room_id):
        await websocket.close(code=_CLOSE_BAD_ROOM, reason="Invalid room id")
        return

    # B3: validate token BEFORE accepting — never log the raw token
    user = await _get_current_user_ws(token)
    if user is None:
        await websocket.close(code=_CLOSE_UNAUTHORIZED, reason="Unauthenticated")
        return

    # B4: parse room_id into session_id + file_id
    session_id, file_id = _split_room_id(room_id)
    if session_id is None or file_id is None:
        await websocket.close(
            code=_CLOSE_BAD_ROOM,
            reason="room_id must be {session_id}:{file_id}",
        )
        return

    # B4: session must exist
    sess = await get_session(session_id)
    if sess is None:
        await websocket.close(code=_CLOSE_NOT_FOUND, reason="Session not found")
        return

    # B4: session must not be closed
    if sess["status"] == "closed":
        await websocket.close(code=_CLOSE_SESSION_CLOSED, reason="Session is closed")
        return

    # Part 1.5: Wake hibernated session
    if sess["status"] == "hibernated":
        await wake_session(session_id)

    # B4: file must belong to this session
    file_row = await get_file(session_id, file_id)
    if file_row is None:
        await websocket.close(code=_CLOSE_NOT_FOUND, reason="File not found in session")
        return

    # B4: user must be owner or open participant
    authorized = await is_participant(session_id, user.id)
    if not authorized:
        await websocket.close(code=_CLOSE_FORBIDDEN, reason="Not a member of this session")
        return

    # All checks passed — accept the WebSocket
    await websocket.accept()

    client = _Client(ws=websocket, user=user)
    room = await _join_room(room_id, client)
    if room is None:
        await websocket.close(code=_CLOSE_ROOM_FULL, reason="Room is full")
        return

    sender = asyncio.ensure_future(_sender(client))
    _touch_task: asyncio.Task | None = None

    try:
        room.send(client, create_sync_message(room.doc))
        if room.awareness:
            room.send(
                client,
                _encode_awareness(
                    [(c, ck, st) for c, (ck, st) in room.awareness.items()]
                ),
            )

        _touch_task = asyncio.ensure_future(touch_session(session_id))

        while True:
            msg = await websocket.receive()
            if msg["type"] == "websocket.disconnect":
                break
            data = msg.get("bytes")
            if data is None:
                await websocket.close(code=1003, reason="Binary frames only")
                break
            if len(data) > COLLAB_MAX_MESSAGE_BYTES:
                await websocket.close(code=1009, reason="Message too large")
                break
            try:
                _handle_message(room, client, data)
            except ValueError as exc:
                logger.warning("Collab room %s: bad frame: %s", room_id, exc)
                await websocket.close(code=1003, reason="Malformed message")
                break
    except Exception:
        logger.exception("Collab handler error in room %s", room_id)
    finally:
        _leave_room(room, client)
        sender.cancel()
        try:
            await sender
        except asyncio.CancelledError:
            pass
        if _touch_task is not None:
            try:
                await _touch_task
            except Exception:
                pass
