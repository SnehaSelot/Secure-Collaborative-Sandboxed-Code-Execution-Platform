# Viva Questions & Answers

## Secure Collaborative Sandboxed Code Execution Platform

> [!IMPORTANT]
> Covers all major project aspects: System Architecture, Sandboxed Execution, WebSocket Streaming, Real-time Collaboration (Yjs/CRDT), ML Risk Analysis, Authentication & Security, Database Design, and DevOps.

---

## 🏗️ Section 1: System Architecture & Overview

---

**Q1. What is this project and what problem does it solve?**

**A:** It is a **production-grade collaborative cloud IDE** that allows multiple users to write and execute code simultaneously in a secure environment. It solves three core problems:

1. **Security** — Untrusted user code must be isolated to prevent host system compromise.
2. **Collaboration** — Multiple users should be able to co-edit code in real time (like Google Docs).
3. **Risk** — Malicious code (supply-chain attacks, malware) must be detected and blocked _before_ execution.

---

**Q2. What is the high-level architecture of this system?**

**A:** The system is a **microservices-inspired monolith** (single FastAPI backend with well-separated modules) backed by:

- **FastAPI (Python)** — REST + WebSocket API server (`/execute`, `/ws/execute`, `/ws/collab/{room}`)
- **PostgreSQL** — Persistent store for users, sessions, files, audit logs, risk assessments
- **Docker** — Each code execution runs in an isolated, ephemeral Docker _sibling_ container (not Docker-in-Docker)
- **ML Risk Engine** — A logistic regression model + rules engine that scores code before execution
- **Yjs/pycrdt** — CRDT-based real-time collaborative editing over WebSocket

---

**Q3. What is Docker-in-Docker vs. sibling containers, and which does this project use?**

**A:**

- **Docker-in-Docker (DinD):** A Docker daemon runs _inside_ a Docker container. Complex, security-prone, requires privileged mode.
- **Sibling containers:** The API container mounts the **host's Docker socket** (`/var/run/docker.sock`) and instructs the host daemon to create new containers. These containers are siblings of the API container, not children.

This project uses **sibling containers**. The `docker-compose.yml` mounts `/var/run/docker.sock:/var/run/docker.sock` into the API container, and `executor.py` calls `docker.from_env()` to communicate with the host daemon.

---

**Q4. Why does the project use `EXEC_TMP_HOST_PATH`?**

**A:** This solves a **bind-mount path resolution** problem. When the API container (running via docker-compose) asks the _host_ Docker daemon to bind-mount a directory into a sandbox container, the host daemon resolves paths against the **host filesystem**, not the API container's filesystem.

The code writes files to `/exec_tmp` inside the API container, but tells Docker to mount `EXEC_TMP_HOST_PATH/{run_id}` (the corresponding host-side path) into the sandbox. Both paths point to the same physical directory.

---

**Q5. What framework is used for the backend and why?**

**A:** **FastAPI** (Python) is used because:

- Native **async/await** support — essential for non-blocking WebSocket handling and concurrently managing many execution streams
- Built-in **Pydantic** validation for request/response models
- Auto-generated OpenAPI/Swagger docs
- Easy WebSocket support via Starlette (underlying framework)
- **`@asynccontextmanager` lifespan** for clean startup/shutdown hooks (DB init, ML model warm-up, reaper start)

---

## ⚙️ Section 2: Sandboxed Code Execution

---

**Q6. How does code execution work end-to-end?**

**A:**

1. Client sends `POST /execute` or connects to `WS /ws/execute` with `{language, code, stdin}`.
2. Request goes through the **risk gate** (`assess_and_record()`). If blocked → 403/close. If flagged → warn but proceed.
3. A **unique temporary directory** is created (`_code_workspace()`) and the code is written to a file (e.g., `main.py`).
4. A Docker container is created with: the code directory bind-mounted read-only, no network, memory limit 256 MB, CPU limit 0.5 cores, PID limits, file size ulimits.
5. The container runs the appropriate command (e.g., `python -u /code/main.py`).
6. Stdout/stderr are collected, the container is removed, and results are returned.

---

**Q7. What security constraints are applied to sandbox containers?**

**A:** Multiple layers:

| Constraint                           | Value        | Purpose                                     |
| ------------------------------------ | ------------ | ------------------------------------------- |
| `network_disabled=True`              | No network   | Prevent data exfiltration, C2 callbacks     |
| `mem_limit="256m"`                   | 256 MB RAM   | Prevent OOM bomb                            |
| `nano_cpus=500_000_000`              | 0.5 CPU      | Prevent CPU starvation                      |
| `pids_limit`                         | 32–128       | Prevent fork bomb                           |
| `ulimit nofile`                      | 2048         | Limit file descriptor exhaustion            |
| `ulimit fsize`                       | 10 MB–256 MB | Prevent disk exhaustion                     |
| `user="1000:1000"`                   | Non-root     | Privilege reduction                         |
| Code volume `mode="ro"`              | Read-only    | Code cannot modify itself                   |
| `labels={"sandbox": "exec-service"}` | Tagged       | Allows orphan reaper to identify containers |

---

**Q8. What are per-language timeouts and why do Go and Rust have 60 seconds?**

**A:** `TIMEOUT_SECONDS` in `executor.py`:

- Python/JS: 15s — interpreted, fast startup
- Java: 30s — JVM warm-up time
- C/C++: 20s — compile + run
- **Go/Rust: 60s** — because `go run` and `rustc` perform a **full compilation** on first run in the cold sandbox (no build cache pre-populated). The Go stdlib compilation alone can take 25–30 seconds.

---

**Q9. What is the `ContainerHolder` class and why is it needed?**

**A:** `ContainerHolder` is a **thread-safe wrapper** used in streaming execution. The problem is:

- The container runs in a **worker thread** (via `run_in_executor`).
- The timeout logic runs on the **async event loop**.
- When a timeout fires, the event loop needs to _kill_ the container, but the container ID is only known to the worker thread.

`ContainerHolder` bridges this with a lock-protected container ID. The worker calls `holder.set(container_id)` immediately after creation, and the async timeout handler calls `holder.get()` to retrieve it for killing. It also holds a reference to the `attach_stream` so the kill path can close the Docker socket immediately, unblocking the blocking stream read without waiting for the container to exit.

---

**Q10. What is the difference between `run_code()` and `stream_run_code()`?**

**A:**

- **`run_code()`** — Used by `POST /execute`. Blocks until the container finishes, then returns `{stdout, stderr, exit_code, status}`. All output is collected at once.
- **`stream_run_code()`** — Used by `WS /ws/execute`. Attaches to the Docker output stream **before** the container starts (to avoid race conditions), then yields stdout/stderr chunks as they are produced via an `emit(msg)` callback. This enables **true incremental streaming** — the client sees output as soon as it's produced.

The attach-before-start approach is critical: attaching _after_ `container.start()` could miss initial output.

---

**Q11. What is the orphan reaper and why is it needed?**

**A:** The **orphan reaper** (`reaper.py`) is a background `asyncio.Task` that runs every 30 seconds. It scans all Docker containers with the label `sandbox=exec-service` and **force-removes** any that have been running longer than 120 seconds (`MAX_CONTAINER_AGE`).

This is a **defense-in-depth** safety net for scenarios where:

- A kill failed (network hiccup, Docker daemon anomaly)
- A container somehow survived the `finally: container.remove(force=True)` block
- A pause/cgroup signal prevented the process from responding to SIGKILL

It runs on the **`_cleanup_pool`** (dedicated thread pool for kills) so it can never be starved by busy execution workers.

---

**Q12. Why are there two separate thread pools (`_executor_pool` and `_cleanup_pool`)?**

**A:** This is a **critical safety property**. If all `_executor_pool` threads are blocked on long-running containers, and a timeout fires, the kill operation (`kill_container()`) is also sync and needs a thread. If we submitted it to the same saturated `_executor_pool`, it would queue behind the stuck workers — **deadlock**.

By maintaining a **separate `_cleanup_pool`** (with 4 dedicated threads reserved exclusively for kills and reaper sweeps), the kill can always get a free thread immediately, guaranteeing timeouts are enforced even under maximum load.

---

## 🔌 Section 3: WebSocket Streaming Execution

---

**Q13. Explain the WebSocket execution flow step by step.**

**A:** From `ws_execute.py`:

1. **Accept + Origin check** — Validate the `Origin` header against the configured regex. Close with code 4003 if rejected.
2. **Receive JSON** — Parse `{language, code, stdin}`.
3. **Validate input** — Check language support, non-empty code, stdin type/length.
4. **Risk gate** — `assess_and_record()`. If blocked → send error message + close. If flagged → send warning, continue.
5. **Setup** — Create `asyncio.Queue(maxsize=128)` and `ContainerHolder`.
6. **Submit worker** — `loop.run_in_executor(_executor_pool, worker)`. Worker calls `stream_run_code()` and posts chunks to the queue via `emit()`.
7. **Launch drain task concurrently** — `_drain()` reads from queue and forwards to WebSocket as chunks arrive. This enables true real-time delivery.
8. **Race: worker vs. timeout** — `asyncio.wait({worker_future, timeout_task}, FIRST_COMPLETED)`.
9. **If timeout fires** — Kill container on `_cleanup_pool`. Await worker to let cleanup run.
10. **Await drain** — Ensures all buffered output is sent before the final message.
11. **Send `result` message** — `{exit_code, status, execution_time}`. Close connection.

---

**Q14. Why is the `_drain()` task launched concurrently with the worker, rather than after it finishes?**

**A:** This was a critical bug fix. The original design awaited the worker first, then drained the queue — all chunks sat in the queue until execution _completed_, producing a burst of messages with identical timestamps.

By launching `drain_task` _concurrently_, each `queue.get()` fires immediately as `emit()` posts chunks, giving **true incremental delivery** — the client sees partial output in real time, not all at once at the end.

---

**Q15. What happens when the WebSocket client disconnects mid-execution?**

**A:** The `_drain()` function catches `WebSocketDisconnect`. It then:

1. Sets `disconnect_requested = True`.
2. Gets the container ID from `ContainerHolder`.
3. Kills the container on `_cleanup_pool` (so the kill doesn't starve execution threads).
4. Continues draining the queue in a `while True` loop, **discarding all messages**, until the `_WORKER_DONE` sentinel arrives. This is essential to ensure the worker thread finishes cleanly and is not leaked.

Finally, the main handler skips sending the `result` message (client is gone) and returns.

---

**Q16. What is the `emit()` function's backpressure mechanism?**

**A:** `emit()` uses `loop.call_soon_threadsafe(queue.put_nowait, msg)`. The queue has `maxsize=128`. If the queue is full (`asyncio.QueueFull`), **the chunk is dropped silently**. This prevents unbounded memory growth when the WebSocket consumer (the client) is too slow to drain messages. The Docker stream keeps being iterated by the worker so it doesn't stall — only the delivery to the slow client is throttled.

---

## 👥 Section 4: Real-Time Collaboration (Yjs/CRDT)

---

**Q17. What is Yjs and what is a CRDT?**

**A:** **Yjs** is a **CRDT (Conflict-free Replicated Data Type)** library for real-time collaboration. A CRDT is a data structure that can be updated independently and concurrently by multiple clients, and all copies eventually converge to the same state **without requiring a central authority** to resolve conflicts.

In this project, `pycrdt` (the Python port of Yjs) is used server-side. The `_Room` class holds a `Doc()` (a Yjs document). Every edit from any client is applied to this shared document, which then broadcasts the minimal delta (not the full document) to all other clients.

---

**Q18. What is the room ID format and how is it structured?**

**A:** The room ID is `"{session_id}:{file_id}"` — two UUIDs joined by a colon. This uniquely identifies a **specific file within a specific session**. The regex `_ROOM_ID_RE` validates the format, and `_split_room_id()` parses it into its two UUID parts. Example: `"550e8400-e29b-41d4-a716-446655440000:6ba7b810-9dad-11d1-80b4-00c04fd430c8"`.

---

**Q19. Explain the authorization flow for the collaboration WebSocket (`/ws/collab/{room_id}`).**

**A:** All checks happen **before** `websocket.accept()`:

1. **Origin check** — Validate `Origin` header against configured regex (close 4003 if rejected).
2. **Room ID format** — Must match `_ROOM_ID_RE` (close 4400 if invalid).
3. **Token validation** — `?token=` query param is validated via JWT (`verify_token`). Non-HTTP WS can't send `Authorization` headers at connection time, so the token is passed as a query param.
4. **Account status** — User must be `active` (not suspended/banned).
5. **Parse room ID** — Extract `session_id` and `file_id`.
6. **Session exists** — DB lookup; 4404 if not found.
7. **Session not closed** — 4409 if closed.
8. **Hibernate wake** — If session is `hibernated`, wake it to `active`.
9. **File belongs to session** — DB lookup; 4404 if not found.
10. **User is participant** — `is_participant(session_id, user.id)`; 4403 if not.
11. **Room capacity** — Max `COLLAB_MAX_ROOM_CLIENTS` (20) clients per room; 4429 if full.

---

**Q20. What are the two Yjs message types handled and how are they processed?**

**A:**

- **`YMessageType.SYNC`** — Handles the Yjs sync protocol (step 1: client sends its state vector; server replies with the diff; step 2: client sends its update). `handle_sync_message()` from `pycrdt` applies the update to `room.doc`. The `room._origin` is set to the sending client before the update, so `_on_update` (which broadcasts) can exclude the sender (loop prevention).

- **`YMessageType.AWARENESS`** — Carries cursor positions, user names, and other ephemeral metadata. The payload is parsed manually using variable-length unsigned integers (varint encoding). Stale updates (lower clock than current) are ignored. A `null` state removes the client's awareness. The message is broadcast to all _other_ clients immediately.

---

**Q21. How is collaborative document state persisted?**

**A:** Via the `YStateStore` protocol with two implementations:

- **`InMemoryStateStore`** — Default (tests, `COLLAB_PERSIST_ENABLED=False`). Survives room eviction but not process restart.
- **`DbStateStore`** — Reads/writes `files.yjs_state` (a binary blob) in PostgreSQL. On save, it also extracts the plain text from the `Y.Text["content"]` key and writes it to `files.content` so the rest of the app can read file content without understanding Yjs.

Snapshots are written:

- **Periodically** — every `COLLAB_SNAPSHOT_INTERVAL` (30s) via `_snapshot_loop()` if `dirty=True`.
- **On room eviction** — when the last client leaves and the idle timer (`COLLAB_ROOM_IDLE_SECONDS` = 60s) fires.
- **On server shutdown** — `flush_all_rooms()` is called from the `lifespan` context manager.

---

**Q22. What is room eviction and how does the idle timer work?**

**A:** When the last client leaves a room, `_leave_room()` calls `_schedule_eviction(room)`. This uses `loop.call_later(COLLAB_ROOM_IDLE_SECONDS, ...)` to schedule `_evict()` after 60 seconds. If a new client joins before the timer fires, `cancel_eviction()` cancels it. When the eviction fires:

1. If the room has clients (race condition), abort.
2. Stop the snapshot loop.
3. If persistence enabled, save the Yjs state to DB.
4. Delete the room from `_rooms`.

This prevents unbounded memory growth from inactive rooms while ensuring the state is durably saved.

---

**Q23. What custom WebSocket close codes does the collaboration endpoint use and why?**

**A:** WebSocket close codes 4000–4999 are **application-defined**. The project uses:

- `4003` — Bad origin
- `4400` — Bad room format
- `4401` — Unauthenticated
- `4403` — Forbidden (not a participant)
- `4404` — Not found (session or file)
- `4409` — Session is closed
- `4429` — Room full (too many clients)

Using specific codes allows the frontend (`y-websocket` client) to distinguish between "unauthorized" and "room full" and display appropriate UI messages.

---

## 🛡️ Section 5: ML Risk Analysis (GlassHouse)

---

**Q24. What is the risk analysis pipeline?**

**A:** It is a **hybrid rules + ML** system called "GlassHouse":

1. **Rules engine** (`scorer.py`) — Regex-based rules that match known dangerous patterns (shell exec, network calls, crypto miners, etc.). Fast (~21ms median for 1000 lines). Produces a score (0–100) and a list of `Finding` objects.
2. **ML model** (`engine.py`) — Logistic regression classifier (`py_risk.joblib`) that predicts the probability of malicious code using 18 hand-engineered features.
3. **Combined score** — `max(rules_score, ml_score)` so either component can flag code.
4. **Decision** — `allow` (< flag threshold), `flag` (≥ flag, < block threshold), or `block` (≥ block threshold).
5. Default thresholds: `flag=40`, `block=80` (on a 0–100 scale).

---

**Q25. What are the 18 features used by the ML model and how are they grouped?**

**A:** From `features.py` (`FEATURE_NAMES`):

**Shape/Length features (4):**

- `log_lines`, `log_chars`, `log_max_line_len`, `mean_line_len`

**Content statistics (5):**

- `char_entropy` — Shannon entropy of characters (high = obfuscated)
- `non_ascii_ratio` — Fraction of non-ASCII characters
- `log_longest_b64_run` — Length of longest base64-like string
- `hex_escape_ratio` — Density of `\xHH` escape sequences
- `comment_ratio` — Fraction of comment lines (malware tends to have fewer)

**Behaviour counts (9) — all log1p-scaled:**

- `log_exec_eval` — `eval()`, `exec()`, `compile()`
- `log_shell_exec` — `os.system()`, `subprocess`, `pty.spawn`
- `log_network` — `socket`, `requests`, `urllib`, etc.
- `log_decode` — `base64`, `zlib`, `marshal`, `.decode('hex')` etc.
- `log_dyn_import` — `__import__`, `importlib`, `getattr`/`setattr`
- `log_sensitive` — `.ssh`, `.aws`, `/etc/passwd`, `os.environ`
- `log_url_ip` — URLs and IP addresses
- `log_chr_obf` — `chr()` calls, reverse slices `[::-1]`
- `log_imports` — Total import statements

---

**Q26. What ML algorithm is used and why?**

**A:** **Logistic Regression** with a `StandardScaler` preprocessing pipeline (from scikit-learn). Reasons:

- **Interpretable** — Coefficients directly show which features drive the decision (e.g., `log_network` coef=1.871 is the strongest predictor).
- **Fast inference** — ~10ms median for a 1000-line file. Critical for a security gate on every execution.
- **Low memory** — The model artifact is tiny (a `.joblib` file vs. multi-GB neural network).
- **`class_weight="balanced"`** — Handles the 18% malicious prevalence in the dataset without manually oversampling.
- **Latency-critical path** — A neural network would add 100s–1000s of ms per call.

---

**Q27. What are the model's performance metrics?**

**A:** From `train_metrics.json` (test set):

| Mode           | Precision | Recall    | F1        | ROC-AUC   |
| -------------- | --------- | --------- | --------- | --------- |
| Rules only     | 0.893     | 0.188     | 0.310     | 0.850     |
| ML only        | 0.795     | 0.902     | 0.845     | 0.965     |
| **Rules + ML** | **0.791** | **0.922** | **0.851** | **0.965** |

Key insight: Rules alone have **high precision but very low recall** (0.188) — they only catch well-known patterns. ML dramatically improves recall to 0.92, meaning it catches ~92% of malicious samples. The combined system is best overall (highest F1 and recall).

Training prevalence was 50% (balanced), but test set prevalence is 18.09% (realistic).

---

**Q28. Why are count features log1p-scaled?**

**A:** Raw counts are highly skewed — most code has 0 network calls, but an attacker might have 50+. Log1p (`log(1 + count)`) compresses this range:

- `log1p(0) = 0` — zero stays zero
- `log1p(1) = 0.69` — one occurrence
- `log1p(50) = 3.93` — fifty occurrences (not 50x the weight of 1)

This prevents high-frequency malware from completely dominating the decision, and allows the `StandardScaler` in the pipeline to normalize features more effectively.

---

**Q29. What is the `assess_and_record()` function and why does it "never raise"?**

**A:** `assess_and_record()` is the **single risk gate** shared by all execution paths (HTTP and WebSocket). It is designed to **never raise an exception** because:

- If it raised, a router that forgot to catch the exception would crash, potentially **allowing malicious code through** (a security failure).
- Instead, any unexpected engine failure becomes a `RiskDecision` with `error` set, and `RISK_FAIL_CLOSED=True` (the default) means this decision is **"block"** — fail secure.

The function: fetches thresholds (with TTL cache and DB fallback), scores the code in a worker thread, applies policy (including the oversized-input blocking rule), and persists the audit log.

---

**Q30. What is `RISK_FAIL_CLOSED` and what are the trade-offs?**

**A:** `RISK_FAIL_CLOSED` (default: `True`) controls what happens when the **risk engine itself crashes** (not a model failure — those fall back to rules-only):

- **`True` (fail-closed)** — Engine error → block execution. Security-first: no code runs if safety cannot be guaranteed. Can cause false positives during outages.
- **`False` (fail-open)** — Engine error → allow execution + write an audit log. Availability-first: users can still run code during transient failures. Risk: malicious code could slip through during the window.

Production must use fail-closed. The config validation in `validate_startup_config()` logs a warning if fail-open is configured.

---

**Q31. What happens with oversized code submissions?**

**A:** The rules engine only scans the first `MAX_SCAN_CHARS` characters. If input exceeds this:

1. The scorer adds an `oversized_input` finding with weight 0.30 (below the flag threshold).
2. The scorer sets `result.truncated = True`.
3. `_decision_from_result()` in `analyzer.py` detects `truncated=True` and **overrides any `allow` or `flag` decision to `block`**, with reason `"input_exceeds_scan_limit"`.

Rationale: A large file that pads benign code before the scan limit and hides a payload after it would otherwise receive an "allow" — this is a bypass attack. Unscanned code cannot be vouched for, so it is blocked.

---

**Q32. Where does the ML scoring run relative to the event loop?**

**A:** It runs via `asyncio.to_thread()` — in a **new thread from the default `asyncio` thread pool** (not `_executor_pool` or `_cleanup_pool`). This is intentional: `_executor_pool` could be saturated by stuck workers, and `_cleanup_pool` is reserved for container kills. Using `asyncio.to_thread()` ensures the risk gate always gets a thread and cannot deadlock.

---

## 🔐 Section 6: Authentication & Security

---

**Q33. How does authentication work?**

**A:**

- **Registration** (`POST /auth/signup`): User provides `email`, `display_name`, `password`. Password is hashed with **bcrypt** (`auth.hash_password()`). A JWT is issued immediately.
- **Login** (`POST /auth/login`): Email + password are verified against the stored bcrypt hash. An account status check ensures suspended users cannot log in (critically: the error message is the same whether the account doesn't exist or is suspended, preventing enumeration).
- **JWT payload**: `{sub: user_id, name: display_name, exp: ...}`. Signed with `HS256` using `COLLAB_JWT_SECRET`.
- **HTTP protection**: `Authorization: Bearer <token>` header, decoded by `get_current_user()`.
- **WS protection**: `?token=<token>` query parameter (HTTP headers cannot be set on initial WS handshake in most browser APIs).

---

**Q34. Why does login return the same error for "user not found" and "wrong password"?**

**A:** To prevent **user enumeration**. If the API returned different errors ("email not registered" vs. "wrong password"), an attacker could use the login endpoint to discover which email addresses are registered. By returning `"Invalid email or password"` in both cases, no information about email existence is leaked.

Similarly, a suspended account returns the same error — revealing that an account is suspended could be a privacy violation.

---

**Q35. What is the bcrypt 72-byte password limit and how is it handled?**

**A:** bcrypt silently **truncates passwords at 72 bytes**. Two passwords that differ only after byte 72 would hash to the same value, creating a false login. The `SignupRequest` validator in `auth_router.py` explicitly rejects any password whose UTF-8 encoding exceeds 72 bytes:

```python
if len(v.encode("utf-8")) > 72:
    raise ValueError("Password cannot exceed 72 bytes")
```

Note: 72 _bytes_, not characters — a single emoji can be 4 bytes.

---

**Q36. How is origin validation implemented and why is regex used?**

**A:** The `COLLAB_ALLOWED_ORIGIN_REGEX` in `config.py` matches `http://localhost`, `127.x.x.x`, and RFC-1918 private IP ranges (`10.x.x.x`, `192.168.x.x`, `172.16-31.x.x`). It covers any port. Regex is used (instead of an explicit list) to:

- Handle **any LAN IP** without configuration changes during development
- Be easily overrideable via an environment variable for production deployments

Both `CORSMiddleware` (`allow_origin_regex=`) and the manual `is_allowed_origin()` check in WebSocket handlers use the same compiled pattern.

---

**Q37. Why does the server validate JWT _before_ accepting the WebSocket connection?**

**A:** For efficiency and security. `websocket.accept()` completes the HTTP upgrade handshake. If we accepted first and then found the token invalid, we'd need to close the just-opened WebSocket, wasting a round-trip. More importantly, in load-balanced environments, accepting then closing can trigger reconnection loops. Validating before `accept()` lets us close with a proper HTTP 4xx code (or WebSocket close code 4401) before any resources are allocated.

---

**Q38. What is the `apply_token_redaction_filter()` and why is it needed?**

**A:** The `?token=` query parameter on WebSocket URLs would normally appear in access logs, exposing JWTs in log files. The `logging_filters.py` module applies a log filter that **redacts the token value** from logged URLs (replacing it with `[REDACTED]`). This is called at app startup in the `lifespan` function before any request can be processed.

---

## 🗄️ Section 7: Database & Sessions

---

**Q39. What are the session states and transitions?**

**A:** Sessions have three states:

- **`active`** — Session is live; participants can join and collaborate.
- **`hibernated`** — Session went idle (e.g., a scheduled background task set it). No new connections accepted without first waking it.
- **`closed`** — Permanently closed by the owner/admin. No joins allowed; WS connection attempts receive `_CLOSE_SESSION_CLOSED` (4409).

Transitions: `active` ↔ `hibernated` (via `wake_session()`/background job); `active` or `hibernated` → `closed` (admin/owner action, via `close_rooms_for_session()` which also disconnects all live WebSocket clients).

---

**Q40. What does `upsert_file_snapshot()` do?**

**A:** `upsert_file_snapshot()` writes (or updates) two fields on the `files` table row:

- `yjs_state` — Raw binary Yjs document state (`bytes`), used to restore the CRDT document when a room is re-opened.
- `content` — Plain text extracted from the `Y.Text["content"]` key, allowing non-Yjs-aware parts of the app (REST API, admin tools) to read file content without loading pycrdt.

The extraction is done with a try/except — if the doc doesn't have a `"content"` text key (e.g., a binary file), the content field is left as-is.

---

**Q41. What is stored in the audit log?**

**A:** The `audit_logs` table records every significant security event. For risk analysis, it stores:

- `actor_id`, `session_id` — Who did it
- `action` — `"risk.allow"`, `"risk.flag"`, `"risk.block"`, `"risk.engine_error"`
- `entity_type` / `entity_id` — Links to the execution or risk check
- `code_sha256` — SHA-256 hash of the submitted code (for deduplication/forensics without storing the code)
- `code_chars` — Size of submission
- `score`, `thresholds`, `model`, `rules` — Full risk decision context

The source code itself is **never stored** — only its hash. This is privacy-by-design.

---

## 🐳 Section 8: DevOps & Configuration

---

**Q42. What does `validate_startup_config()` do and when does it block startup?**

**A:** Called at startup in the `lifespan` function. It enforces **production safety invariants**:

1. If `ENV=production` and `COLLAB_JWT_SECRET` is the default placeholder or < 32 characters → `RuntimeError` (startup refused).
2. If risk thresholds are invalid (`flag ≥ block` or outside 0–100) → `RuntimeError`.
3. If `ENV=production` and `RISK_ENABLED=False` → `RuntimeError` (cannot run production without risk analysis).
4. In non-production, violations produce loud warnings but don't block startup.

---

**Q43. How are settings managed and why is `@lru_cache` used on `get_settings()`?**

**A:** Settings use **pydantic-settings** `BaseSettings`, which reads from environment variables and `.env` files. `@lru_cache` on `get_settings()` ensures the settings object is created **once** and cached — subsequent calls return the same instance. This is important because:

- Settings construction reads from env/disk (has I/O cost)
- `get_settings()` is called from many places per request
- Tests can clear the cache to inject different settings per test case

---

**Q44. Why does the `lifespan` function warm up the ML model asynchronously?**

**A:** `joblib.load()` (which loads the `.joblib` model file) is **blocking I/O**. Calling it directly on the asyncio event loop would block all requests during startup. Using `await asyncio.to_thread(risk_warm_up)` offloads it to a worker thread so the event loop remains responsive. A missing/corrupt model is **not fatal** — the engine falls back to rules-only mode and logs a warning.

---

**Q45. What language images are supported and how is the command determined?**

**A:** From `executor.py`:

- `python` → `python:3.12-slim`, runs `python -u /code/main.py` (`-u` for unbuffered output, enabling real-time streaming)
- `javascript` → `node:22-alpine`, runs `node /code/main.js`
- `java` → `eclipse-temurin:21-jdk`, runs `java /code/Main.java`
- `c` / `cpp` → `gcc:14`, runs a shell command that compiles with `gcc`/`g++` and then executes with `stdbuf -oL -eL` (line-buffered output)
- `go` → `golang:1.24-alpine`, runs `go run /code/main.go`
- `rust` → `rust:1.88-slim`, compiles with `rustc` then runs the binary

---

## 🧪 Section 9: Testing & Data

---

**Q46. What test files exist and what do they cover?**

**A:**

- `test_execution_service.py` — Tests for the HTTP and WebSocket execution endpoints, language support, error handling, timeout behavior
- `test_risk.py` — Unit tests for the risk analysis rules engine, scorer, and feature extraction
- `test_risk_ml_integration.py` — Integration tests verifying the ML model + rules combination works end-to-end
- `test_sandbox.py` — Tests for sandbox isolation, container cleanup, and security constraints

---

**Q47. How is the ML training data collected and prepared?**

**A:** The ML pipeline (`ml/` directory):

1. **`download_benign.py`** — Downloads benign Python packages from PyPI (real-world, safe code)
2. **`archives_to_jsonl.py`** — Extracts `.py` files from archives into JSONL format
3. **`ingest.py`** — Combines benign and malicious samples, assigns labels
4. **`split.py`** — Stratified train/val/test split (with manifest for reproducibility)
5. **`features.py`** — Runs `risk/features.py`'s `extract()` function on each sample → `.npz` feature matrices
6. **`train.py`** — Trains logistic regression, selects threshold on val set, evaluates on test set, saves `models/py_risk.joblib`

Training used **3,336 samples** with 50% prevalence (balanced), 18 features, seed=42 for reproducibility.

---

**Q48. Why is the threshold selected on the validation set and frozen for the test set?**

**A:** This is **proper ML evaluation discipline** to prevent **data leakage**:

- The validation set is used to tune the decision threshold (choosing the probability cutoff that maximizes F1).
- The test set is only touched once for final evaluation — it simulates a truly unseen deployment.
- If the threshold were optimized on the test set, the reported metrics would be overly optimistic and not representative of real-world performance.

The function `best_f1_threshold(y_val, val_probability)` selects the threshold from the precision-recall curve that maximizes F1 on validation, then `flag_probability = 0.7434` is frozen and applied to test predictions.

---

**Q49. What is the `FEATURES_VERSION` constant and why does it exist?**

**A:** `FEATURES_VERSION = 1` is an integer version stamp for the feature schema. The training pipeline saves this into the `.npz` feature files and the `py_risk.joblib` model bundle. At load time, the engine verifies that the model's version matches `FEATURES_VERSION` in the current code. If they differ (e.g., a feature was added/removed/renamed), the engine **refuses to load the model** with a clear error rather than silently producing wrong predictions. This prevents silent accuracy degradation from schema mismatches between training and inference code.

---

**Q50. What are some limitations or potential improvements of this project?**

**A:**

1. **Frontend** — No frontend is included in the repository; it needs a React/Next.js client using `y-websocket`.
2. **Single-language risk model** — The ML model is Python-only (`py_risk.joblib`). JavaScript, Java, C/C++ submissions fall back to rules-only.
3. **Static Docker images** — Language images are pinned; a supply-chain compromise of `python:3.12-slim` would affect all Python executions.
4. **No rate limiting** — `POST /execute` and `WS /ws/execute` have no per-user rate limits, making them susceptible to resource exhaustion.
5. **gVisor/Kata Containers** — For stronger kernel-level isolation, sandboxes could use gVisor (runc replacement) instead of standard Docker containers.
6. **Model retraining** — The model is static; a CI/CD pipeline for periodic retraining on new malware samples would improve detection over time.
7. **Horizontal scaling** — The in-memory `_rooms` dict means Yjs state is not shared across multiple API instances; Redis Pub/Sub would be needed for multi-instance deployments.

---

_Generated from full codebase analysis — covers [`main.py`](file:///c:/Users/aryam/.vscode/Project/Secure-Collaborative-Sandboxed-Code-Execution-Platform/backend/app/main.py), [`executor.py`](file:///c:/Users/aryam/.vscode/Project/Secure-Collaborative-Sandboxed-Code-Execution-Platform/backend/app/services/executor.py), [`ws_execute.py`](file:///c:/Users/aryam/.vscode/Project/Secure-Collaborative-Sandboxed-Code-Execution-Platform/backend/app/routers/ws_execute.py), [`ws_collab.py`](file:///c:/Users/aryam/.vscode/Project/Secure-Collaborative-Sandboxed-Code-Execution-Platform/backend/app/routers/ws_collab.py), [`analyzer.py`](file:///c:/Users/aryam/.vscode/Project/Secure-Collaborative-Sandboxed-Code-Execution-Platform/backend/risk/analyzer.py), [`features.py`](file:///c:/Users/aryam/.vscode/Project/Secure-Collaborative-Sandboxed-Code-Execution-Platform/backend/risk/features.py), [`train.py`](file:///c:/Users/aryam/.vscode/Project/Secure-Collaborative-Sandboxed-Code-Execution-Platform/ml/train.py), [`config.py`](file:///c:/Users/aryam/.vscode/Project/Secure-Collaborative-Sandboxed-Code-Execution-Platform/backend/app/config.py), and more._
