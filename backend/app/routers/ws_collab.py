"""
app/routers/ws_collab.py — Yjs collaboration WebSocket endpoint.

    ws://host/ws/collab/{room_id}

Speaks the standard y-websocket wire protocol, so the frontend can use the
stock client with no custom code:

    import { WebsocketProvider } from "y-websocket";
    const provider = new WebsocketProvider(
        "ws://localhost:8000/ws/collab", roomId, ydoc
    );

(y-websocket appends "/<roomId>" to the base URL.)

What the server does
--------------------
* Keeps one authoritative server-side Y.Doc (pycrdt) per room.  Because the
  server holds the full state, late joiners sync even when nobody else is
  online, and the doc can be persisted (-> Files.yjs_state) without needing a
  browser to be connected.
* Sync protocol: on connect the server sends SYNC_STEP1; it answers the
  client's SYNC_STEP1 with SYNC_STEP2; every update it receives is applied to
  the room doc and fanned out to the other clients in the room.
* Awareness (cursors / presence): relayed, cached per room so newcomers see
  existing users immediately, and cleared when a connection drops so ghost
  cursors don't linger.
* Persistence: through the small YStateStore interface below.  When the last
  client leaves, the room stays warm for COLLAB_ROOM_IDLE_SECONDS, is saved,
  then evicted.  Swap InMemoryStateStore for a Postgres-backed store later.

Everything here runs on the event loop (no threads, no Docker), so it cannot
interact with _executor_pool / _cleanup_pool used by the execution routes.

Requires:  pip install pycrdt
"""

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Protocol

from fastapi import APIRouter, WebSocket
from pycrdt import (
    Doc,
    YMessageType,
    create_sync_message,
    create_update_message,
    handle_sync_message,
    write_var_uint,
)

from app.config import (
    _WS_ALLOWED_ORIGINS,
    COLLAB_CLIENT_QUEUE_MAXSIZE,
    COLLAB_MAX_MESSAGE_BYTES,
    COLLAB_MAX_ROOM_CLIENTS,
    COLLAB_ROOM_IDLE_SECONDS,
)

logger = logging.getLogger("exec-service")

router = APIRouter()

_ROOM_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")

# Custom close codes (4000-4999 are application-defined).
_CLOSE_BAD_ORIGIN = 4003
_CLOSE_BAD_ROOM = 4400
_CLOSE_UNAUTHORIZED = 4401
_CLOSE_ROOM_FULL = 4429


# ---------------------------------------------------------------------------
# Persistence interface
# ---------------------------------------------------------------------------


class YStateStore(Protocol):
    """Where room documents live between sessions."""

    async def load(self, room_id: str) -> bytes | None: ...

    async def save(self, room_id: str, state: bytes) -> None: ...


class InMemoryStateStore:
    """Default store: survives rooms being evicted, not a process restart.

    Replace with a Postgres-backed store (Files.yjs_state) via
    set_state_store() once the DB layer exists.
    """

    def __init__(self) -> None:
        self._data: dict[str, bytes] = {}

    async def load(self, room_id: str) -> bytes | None:
        return self._data.get(room_id)

    async def save(self, room_id: str, state: bytes) -> None:
        self._data[room_id] = state


_store: YStateStore = InMemoryStateStore()


def set_state_store(store: YStateStore) -> None:
    global _store
    _store = store


# ---------------------------------------------------------------------------
# Awareness wire helpers
#
# Awareness update payload = varUint count, then per entry:
#   varUint clientID, varUint clock, varString JSON-state ("null" = removed)
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
    outbox: asyncio.Queue = field(
        default_factory=lambda: asyncio.Queue(maxsize=COLLAB_CLIENT_QUEUE_MAXSIZE)
    )
    awareness_ids: set[int] = field(default_factory=set)
    dropped: bool = False


async def _safe_close(ws: WebSocket, code: int) -> None:
    try:
        await ws.close(code=code)
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
        # The client whose message is currently being applied.  Set around
        # handle_sync_message() (synchronous), so the doc observer can skip
        # echoing an update back to the client that produced it.
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
            # Too slow to keep up.  Drop the connection; on reconnect the
            # y-websocket client re-syncs from the server doc, so nothing is lost.
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


_rooms: dict[str, _Room] = {}
_registry_lock = asyncio.Lock()


async def _join_room(room_id: str, client: _Client) -> _Room | None:
    """Fetch (or create + load) the room and add the client; None if full."""
    async with _registry_lock:
        room = _rooms.get(room_id)
        if room is None:
            room = _Room(room_id)
            saved = await _store.load(room_id)
            if saved:
                room.doc.apply_update(saved)
                room.dirty = False
            _rooms[room_id] = room
        if len(room.clients) >= COLLAB_MAX_ROOM_CLIENTS:
            return None
        room.cancel_eviction()
        room.clients.add(client)
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
        try:
            await room.save()
        except Exception:
            # Never discard unsaved state: keep the room and retry later.
            logger.exception("Saving room %s failed — keeping it in memory", room.room_id)
            _schedule_eviction(room)
            return
        del _rooms[room.room_id]
        logger.info("Collab room %s evicted", room.room_id)


async def flush_all_rooms() -> None:
    """Persist every dirty room.  Call from the app shutdown hook."""
    for room in list(_rooms.values()):
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
    """Process one binary frame.  Raises ValueError on malformed input."""
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

    # Other message types (e.g. y-websocket auth = 2) are ignored.


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
        _schedule_eviction(room)


async def _sender(client: _Client) -> None:
    try:
        while True:
            msg = await client.outbox.get()
            await client.ws.send_bytes(msg)
    except asyncio.CancelledError:
        raise
    except Exception:
        pass  # socket died; the receive loop will notice and clean up


async def _authorize(websocket: WebSocket, room_id: str) -> bool:
    """Hook for auth / RBAC (e.g. validate a token query param and check that
    the user participates in this session).  Currently allows everyone."""
    return True


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.websocket("/ws/collab/{room_id}")
async def ws_collab(websocket: WebSocket, room_id: str):
    origin = websocket.headers.get("origin", "")
    if origin and origin not in _WS_ALLOWED_ORIGINS:
        await websocket.close(code=_CLOSE_BAD_ORIGIN, reason="Origin not allowed")
        return

    if not _ROOM_ID_RE.match(room_id):
        await websocket.close(code=_CLOSE_BAD_ROOM, reason="Invalid room id")
        return

    if not await _authorize(websocket, room_id):
        await websocket.close(code=_CLOSE_UNAUTHORIZED, reason="Unauthorized")
        return

    await websocket.accept()

    client = _Client(ws=websocket)
    room = await _join_room(room_id, client)
    if room is None:
        await websocket.close(code=_CLOSE_ROOM_FULL, reason="Room is full")
        return

    sender = asyncio.ensure_future(_sender(client))
    try:
        # Kick off the handshake: our state vector (client answers with
        # whatever we're missing) and everyone's current presence.
        room.send(client, create_sync_message(room.doc))
        if room.awareness:
            room.send(
                client,
                _encode_awareness([(c, ck, st) for c, (ck, st) in room.awareness.items()]),
            )

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
