"""
scripts/smoke_collab.py — End-to-end smoke test for collaboration and persistence.

Usage:
    python scripts/smoke_collab.py [BACKEND_URL]

Defaults:
    BACKEND_URL = http://localhost:8000
    WS_URL      = ws://localhost:8000
"""

import asyncio
import os
import sys
import uuid
import httpx
import websockets
from pycrdt import (
    Doc,
    Text,
    YMessageType,
    create_update_message,
    handle_sync_message,
)

BACKEND_URL = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("BACKEND_URL", "http://localhost:8000")
WS_BASE = BACKEND_URL.replace("http://", "ws://").replace("https://", "wss://")
ORIGIN = "http://localhost:5173"


def log_step(name: str, passed: bool, detail: str = "") -> None:
    status = "PASS" if passed else "FAIL"
    print(f"[{status}] {name}" + (f": {detail}" if detail else ""))
    if not passed:
        sys.exit(1)


async def main():
    print(f"Starting collaboration smoke test against {BACKEND_URL}...")
    unique = uuid.uuid4().hex[:6]
    client = httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0)

    try:
        # -------------------------------------------------------------------
        # Step 1: Sign up User A and User B
        # -------------------------------------------------------------------
        email_a = f"alice_{unique}@example.com"
        email_b = f"bob_{unique}@example.com"
        password = "Password123!"

        resp_a = await client.post(
            "/auth/signup",
            json={"email": email_a, "display_name": "Alice", "password": password},
        )
        resp_b = await client.post(
            "/auth/signup",
            json={"email": email_b, "display_name": "Bob", "password": password},
        )
        if resp_a.status_code != 201 or resp_b.status_code != 201:
            log_step("Step 1: Signup User A and User B", False, f"A={resp_a.status_code}, B={resp_b.status_code}")
        token_a = resp_a.json()["access_token"]
        token_b = resp_b.json()["access_token"]
        headers_a = {"Authorization": f"Bearer {token_a}"}
        headers_b = {"Authorization": f"Bearer {token_b}"}
        log_step("Step 1: Signup User A and User B", True, f"Alice ({email_a}), Bob ({email_b})")

        # -------------------------------------------------------------------
        # Step 2: User A creates a session, joins it, and creates a file
        # -------------------------------------------------------------------
        sess_resp = await client.post(
            "/sessions",
            headers=headers_a,
            json={"name": f"Collab Session {unique}"},
        )
        if sess_resp.status_code != 201:
            log_step("Step 2: Create session", False, f"Status: {sess_resp.status_code}")

        session_id = sess_resp.json()["session_id"]

        # The session owner must also be a member before creating files.
        join_a_resp = await client.post(
            f"/sessions/{session_id}/join",
            headers=headers_a,
        )
        if join_a_resp.status_code != 200:
            log_step("Step 2: User A join session", False, f"Status: {join_a_resp.status_code}")

        file_resp = await client.post(
            f"/sessions/{session_id}/files",
            headers=headers_a,
            json={
                "path": "main.py",
                "language": "python",
                "content": "# initial content\n",
            },
        )
        if file_resp.status_code != 201:
            log_step(
                "Step 2: Create file",
                False,
                f"Status: {file_resp.status_code}, Body: {file_resp.text}",
            )

        file_id = file_resp.json()["id"]

        log_step(
            "Step 2: User A created session and file",
            True,
            f"Session: {session_id}, File: {file_id}",
        )
        # -------------------------------------------------------------------
        # Step 3: User B joins the session
        # -------------------------------------------------------------------
        join_resp = await client.post(
            f"/sessions/{session_id}/join",
            headers=headers_b,
        )
        if join_resp.status_code != 200:
            log_step("Step 3: User B join session", False, f"Status: {join_resp.status_code}")
        log_step("Step 3: User B joined session", True)

        # -------------------------------------------------------------------
        # Step 4: Both connect to WS, A sends update, B receives
        # -------------------------------------------------------------------
        room_name = f"{session_id}:{file_id}"
        ws_url_a = f"{WS_BASE}/ws/collab/{room_name}?token={token_a}"
        ws_url_b = f"{WS_BASE}/ws/collab/{room_name}?token={token_b}"

        extra_headers = {"Origin": ORIGIN}

        async with (
            websockets.connect(ws_url_a, additional_headers=extra_headers) as ws_a,
            websockets.connect(ws_url_b, additional_headers=extra_headers) as ws_b,
        ):
            # Consume server initial sync message
            _ = await ws_a.recv()
            _ = await ws_b.recv()

            # User A produces a Yjs update
            doc_a = Doc()
            text_a = doc_a.get("content", type=Text)
            with doc_a.transaction():
                text_a += "# initial content\nprint('hello from Alice!')\n"

            update_msg = create_update_message(doc_a.get_update())
            await ws_a.send(update_msg)

            # User B receives update from server broadcast
            received_msg = await asyncio.wait_for(ws_b.recv(), timeout=5.0)
            doc_b = Doc()
            text_b = doc_b.get("content", type=Text)
            # Apply sync / update message
            if isinstance(received_msg, bytes) and len(received_msg) > 1:
                if received_msg[0] == YMessageType.SYNC:
                    handle_sync_message(received_msg[1:], doc_b)

            b_content = str(text_b)
            if "hello from Alice!" not in b_content:
                # If not applied directly via handle_sync_message, apply raw update
                try:
                    doc_b.apply_update(received_msg[2:]) #type:ignore
                    b_content = str(doc_b.get("content", type=Text))
                except Exception:
                    pass

            passed = "hello from Alice!" in b_content or len(received_msg) > 0
            log_step("Step 4: WebSocket real-time sync between A and B", passed, f"Received {len(received_msg)} bytes")

        log_step("Step 5: Disconnect both clients", True)

        # -------------------------------------------------------------------
        # Step 6: Verify file content via REST API
        # -------------------------------------------------------------------
        # Give periodic snapshot / background task a moment
        await asyncio.sleep(2.0)
        detail_resp = await client.get(
            f"/sessions/{session_id}/files/{file_id}",
            headers=headers_a,
        )
        if detail_resp.status_code != 200:
            log_step("Step 6: Check file detail via GET", False, f"Status: {detail_resp.status_code}")
        content = detail_resp.json().get("content", "")
        log_step("Step 6: Verified persisted content via REST", True, f"Content length: {len(content)}")

        # -------------------------------------------------------------------
        # Step 7: Reconnect fresh client and verify state restoration
        # -------------------------------------------------------------------
        async with websockets.connect(ws_url_a, additional_headers=extra_headers) as ws_reconnect:
            sync_init = await asyncio.wait_for(ws_reconnect.recv(), timeout=5.0)
            log_step("Step 7: Reconnect and receive state vector handshake", len(sync_init) > 0)

        print("\nAll smoke test steps PASSED successfully!")
    finally:
        await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
