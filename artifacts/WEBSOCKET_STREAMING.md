# WebSocket Streaming — Frontend Integration Guide

> **Endpoint:** `ws://localhost:8000/ws/execute`  
> **Added:** 2026-09-11  
> **Complements:** existing `POST /execute` HTTP endpoint (still works, unchanged)

---

## Why WebSocket?

The old `POST /execute` endpoint holds the HTTP connection open until the container finishes, then dumps all output at once. The new WebSocket endpoint streams stdout/stderr **in real-time** as the container produces it — line by line — and then sends a final `result` message before closing.

| | `POST /execute` | `WS /ws/execute` |
|---|---|---|
| Output delivery | All at once after finish | Streamed live |
| Best for | Simple scripts, quick calls | Interactive output, long-running code |
| Truncation signal | stdout/stderr strings just cut off | Dedicated `stdout_truncated` / `stderr_truncated` event |
| Complexity | Plain `fetch()` | Requires WebSocket handling |

---

## CORS / Origin

CORS middleware does **not** cover WebSocket connections. Instead, the server validates the `Origin` request header explicitly.

**Allowed origins (local dev):**
- `http://localhost:5173`
- `http://127.0.0.1:5173`

If your dev server uses a different port, ask the backend team to add it.  
Connections from any other origin are rejected with WebSocket close code **4003** (`Origin not allowed`) — no messages are sent before close.

---

## Connection Flow

```
Client                             Server
  |                                  |
  |──── WS Upgrade ─────────────────▶|   Origin header checked
  |◀─── 101 Switching Protocols ─────|
  |                                  |
  |──── { language, code } ─────────▶|   input validated
  |                                  |
  |◀─── { type: "stdout", data }─────|  ─┐
  |◀─── { type: "stderr", data }─────|   │  zero or more, real-time
  |◀─── { type: "stdout", data }─────|  ─┘
  |                                  |
  |◀─── { type: "result", ... } ─────|   always last, exactly once
  |◀─── WS Close ────────────────────|
```

---

## Step-by-Step Protocol

### 1. Open the connection

```js
const ws = new WebSocket("ws://localhost:8000/ws/execute");
```

### 2. Send the request — inside `ws.onopen`

Send exactly **one** JSON message:

```json
{
  "language": "python",
  "code": "for i in range(5):\n    print(i)\n"
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `language` | string | ✅ | One of: `c`, `cpp`, `go`, `java`, `javascript`, `python`, `rust` |
| `code` | string | ✅ | Non-empty, non-whitespace |

### 3. Handle incoming messages — `ws.onmessage`

Every server → client message is a JSON object with a `type` field:

#### `stdout` — live standard output chunk

```json
{ "type": "stdout", "data": "0\n1\n2\n" }
```

Append `data` to your output display as it arrives.

#### `stderr` — live standard error / compile error chunk

```json
{ "type": "stderr", "data": "NameError: name 'x' is not defined\n" }
```

#### `stdout_truncated` — output cap reached

```json
{ "type": "stdout_truncated" }
```

Emitted **once** when stdout hits 20 000 characters. Subsequent stdout is dropped server-side. No `data` field. Show a warning in the UI.

#### `stderr_truncated` — same, for stderr

```json
{ "type": "stderr_truncated" }
```

#### `error` — validation / setup failure

```json
{ "type": "error", "message": "Unsupported language 'ruby'. Supported: [...]" }
```

Sent when input is invalid (bad language, empty code, malformed JSON). The connection closes immediately after. No `result` message follows.

#### `result` — final message, always last

```json
{
  "type": "result",
  "exit_code": 0,
  "status": "success",
  "execution_time": 1.23
}
```

| Field | Type | Nullable | Description |
|---|---|---|---|
| `exit_code` | number | Yes — `null` on timeout / internal error | OS process exit code |
| `status` | string | No | `"success"` \| `"error"` \| `"timeout"` \| `"internal_error"` |
| `execution_time` | number | No | Total elapsed seconds |

**Status meanings:**

| `status` | `exit_code` | Meaning |
|---|---|---|
| `"success"` | `0` | Code ran to completion successfully |
| `"error"` | `> 0` | Runtime or compile error — stderr has details |
| `"timeout"` | `null` | Container killed after 10 s wall-clock limit |
| `"internal_error"` | `null` | Docker / host failure |

### 4. Connection closes

After `result` the server closes the WebSocket cleanly. Use `ws.onclose` to finalize UI state (hide spinner, enable run button, etc.).

---

## Guarantees

- `result` is **always the last message** — no stdout/stderr arrives after it.
- There is **exactly one** `result` message per execution.
- If the client disconnects early, the server detects it, stops streaming, and the container is cleaned up server-side.

---

## Error Scenarios

| Scenario | What the client receives |
|---|---|
| Disallowed Origin | WS close code **4003**, no messages |
| Invalid JSON payload | `{ type: "error", message: "Invalid JSON payload" }` → close |
| Unknown language | `{ type: "error", message: "Unsupported language '...' ..." }` → close |
| Empty / whitespace code | `{ type: "error", message: "Code cannot be empty" }` → close |
| Execution timeout (10 s) | Normal stream ends; `result` has `status: "timeout"`, `exit_code: null` |
| Output truncated (20 000 chars) | `stdout_truncated` or `stderr_truncated` event, then execution continues |

---

## Resource Limits (for UI display)

Fetch these live from `GET /limits`:

| Limit | Value |
|---|---|
| Execution timeout | **10 seconds** |
| Memory | **256 MB** |
| Max output (stdout / stderr each) | **20 000 characters** |
| Network | **Disabled** inside sandbox |
| CPU | **0.5 cores** |

---

## JavaScript Examples

### Minimal working example

```js
const ws = new WebSocket("ws://localhost:8000/ws/execute");

ws.onopen = () => {
  ws.send(JSON.stringify({
    language: "python",
    code: "for i in range(5):\n    print(i)\n",
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === "stdout")           console.log("[out]", msg.data);
  else if (msg.type === "stderr")      console.error("[err]", msg.data);
  else if (msg.type === "stdout_truncated") console.warn("stdout truncated");
  else if (msg.type === "stderr_truncated") console.warn("stderr truncated");
  else if (msg.type === "error")       console.error("setup error:", msg.message);
  else if (msg.type === "result")      console.log("done:", msg.status, msg.execution_time + "s");
};

ws.onerror = (e) => console.error("WebSocket error", e);
ws.onclose = () => console.log("connection closed");
```

### Reusable helper with cancel support

```js
/**
 * streamExecute — runs code via the WebSocket streaming endpoint.
 *
 * @param {string} language
 * @param {string} code
 * @param {{
 *   onStdout?: (chunk: string) => void,
 *   onStderr?: (chunk: string) => void,
 *   onTruncated?: (which: "stdout_truncated"|"stderr_truncated") => void,
 *   onResult?: (result: { exit_code: number|null, status: string, execution_time: number }) => void,
 *   onError?: (message: string) => void,
 * }} callbacks
 * @returns {() => void}  Call this to cancel / close early.
 */
export function streamExecute(language, code, callbacks) {
  const { onStdout, onStderr, onTruncated, onResult, onError } = callbacks;
  const ws = new WebSocket("ws://localhost:8000/ws/execute");

  ws.onopen = () => {
    ws.send(JSON.stringify({ language, code }));
  };

  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    switch (msg.type) {
      case "stdout":            onStdout?.(msg.data); break;
      case "stderr":            onStderr?.(msg.data); break;
      case "stdout_truncated":
      case "stderr_truncated":  onTruncated?.(msg.type); break;
      case "result":            onResult?.(msg); break;
      case "error":             onError?.(msg.message); break;
    }
  };

  ws.onerror = () => onError?.("WebSocket connection error");

  return () => ws.close();   // cancel function
}
```

### React hook

```jsx
import { useCallback, useRef, useState } from "react";

export function useStreamExecution() {
  const [output, setOutput] = useState({ stdout: "", stderr: "" });
  const [status, setStatus] = useState(null); // null | "running" | "success" | "error" | "timeout" | "internal_error"
  const [executionTime, setExecutionTime] = useState(null);
  const [truncated, setTruncated] = useState({ stdout: false, stderr: false });
  const wsRef = useRef(null);

  const run = useCallback((language, code) => {
    wsRef.current?.close();

    setOutput({ stdout: "", stderr: "" });
    setStatus("running");
    setExecutionTime(null);
    setTruncated({ stdout: false, stderr: false });

    const ws = new WebSocket("ws://localhost:8000/ws/execute");
    wsRef.current = ws;

    ws.onopen = () => ws.send(JSON.stringify({ language, code }));

    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.type === "stdout")
        setOutput((o) => ({ ...o, stdout: o.stdout + msg.data }));
      else if (msg.type === "stderr")
        setOutput((o) => ({ ...o, stderr: o.stderr + msg.data }));
      else if (msg.type === "stdout_truncated")
        setTruncated((t) => ({ ...t, stdout: true }));
      else if (msg.type === "stderr_truncated")
        setTruncated((t) => ({ ...t, stderr: true }));
      else if (msg.type === "result") {
        setStatus(msg.status);
        setExecutionTime(msg.execution_time);
      } else if (msg.type === "error") {
        setStatus("error");
        setOutput((o) => ({ ...o, stderr: msg.message }));
      }
    };

    ws.onerror = () => setStatus("error");
  }, []);

  const cancel = useCallback(() => {
    wsRef.current?.close();
    setStatus(null);
  }, []);

  return { output, status, executionTime, truncated, run, cancel };
}

// Usage in a component:
//
// const { output, status, run, cancel } = useStreamExecution();
//
// <button onClick={() => run("python", code)}>Run</button>
// <button onClick={cancel} disabled={status !== "running"}>Stop</button>
// <pre>{output.stdout}</pre>
// <pre style={{ color: "red" }}>{output.stderr}</pre>
// {status && <span>Status: {status}</span>}
```

---

## What Has NOT Changed

- `GET /health`, `GET /languages`, `GET /limits` — unchanged.
- `POST /execute` — still works exactly as documented in `BACKEND_API.md`. The WebSocket endpoint is additive.
