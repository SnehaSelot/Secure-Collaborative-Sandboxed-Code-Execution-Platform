"""
Sandbox Security & Execution Test Suite
=========================================
Covers every test defined in the Sandbox Security & Execution Test Plan
(TEST-01 through TEST-62).

Prerequisites
-------------
* Server running:
      cd backend
      uvicorn app.main:app --host 0.0.0.0 --port 8000

* pip install pytest pytest-asyncio websockets requests docker

* Docker images pre-pulled (first run per language pulls automatically but slow):
      docker pull python:3.12-slim node:22-alpine eclipse-temurin:21-jdk
      docker pull gcc:14 golang:1.24-alpine rust:1.88-slim

Do NOT run yet -- review first.
When ready:
    pytest tests/test_sandbox.py -v
"""

import asyncio
import json
import time
from typing import Any

import docker
import pytest
import requests
import websockets

# ---------------------------------------------------------------------------
# Configuration -- must match executor.py constants exactly
# ---------------------------------------------------------------------------

BASE_HTTP = "http://localhost:8000"
BASE_WS = "ws://localhost:8000/ws/execute"
# Per-language execution timeouts — must mirror executor.TIMEOUT_SECONDS exactly.
TIMEOUT_SECONDS: dict[str, int] = {
    "python": 15,
    "javascript": 15,
    "java": 30,
    "c": 20,
    "cpp": 20,
    "go": 60,  # cold compile of stdlib takes ~25-30 s in the sandbox
    "rust": 60,  # rustc is similarly slow on first compile
}
_DEFAULT_TIMEOUT = 15  # fallback for languages not in the dict above
# Convenience alias used by tests that only run Python code.
_PYTHON_TIMEOUT = TIMEOUT_SECONDS["python"]
MAX_OUTPUT_CHARS = 20_000  # executor.MAX_OUTPUT_CHARS
EXEC_UID = "1000"  # numeric part of executor.EXEC_UID ("1000:1000")
HTTP_TIMEOUT = 60  # generous HTTP timeout for first-run image pulls
# Safety margin added on top of the executor timeout for the ws.recv() guard.
_WS_RECV_MARGIN = 20
# Default ws.recv() timeout guard (used for Python and standalone ws tests)
WS_RECV_TIMEOUT = _PYTHON_TIMEOUT + _WS_RECV_MARGIN


def get_ws_recv_timeout(language: str = "python") -> int:
    return TIMEOUT_SECONDS.get(language, _DEFAULT_TIMEOUT) + _WS_RECV_MARGIN


DOCKER_LABEL = "sandbox=exec-service"

# ---------------------------------------------------------------------------
# Language fixtures
# ---------------------------------------------------------------------------

HELLO_WORLD = {
    "python": 'print("Hello, World!")',
    "javascript": 'console.log("Hello, World!");',
    "java": (
        "public class Main {\n"
        "    public static void main(String[] args) {\n"
        '        System.out.println("Hello, World!");\n'
        "    }\n}\n"
    ),
    "c": (
        "#include <stdio.h>\n"
        "int main() {\n"
        '    printf("Hello, World!\\n");\n'
        "    return 0;\n}\n"
    ),
    "cpp": (
        "#include <iostream>\n"
        "int main() {\n"
        '    std::cout << "Hello, World!" << std::endl;\n'
        "    return 0;\n}\n"
    ),
    "go": (
        'package main\nimport "fmt"\n' 'func main() { fmt.Println("Hello, World!") }\n'
    ),
    "rust": 'fn main() { println!("Hello, World!"); }\n',
}

NO_OUTPUT = {
    "python": "pass",
    "javascript": "// no output",
    "java": "public class Main { public static void main(String[] a) {} }",
    "c": "int main() { return 0; }",
    "cpp": "int main() { return 0; }",
    "go": "package main\nfunc main() {}",
    "rust": "fn main() {}",
}

COMPILE_ERROR = {
    "c": "#include <stdio.h>\nint main() { this is invalid; }",
    "cpp": "#include <iostream>\nint main() { this is invalid; }",
    "rust": "fn main() { this_is_invalid }",
    "go": "package main\nfunc main() { this is invalid }",
    "java": "public class Main { public static void main(String[] a) { int x = ???; } }",
}

ALL_LANGUAGES = list(HELLO_WORLD.keys())

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _run(coro) -> Any:
    """Run an async coroutine from a synchronous pytest test."""
    return asyncio.get_event_loop().run_until_complete(coro)


def http_execute(language: str, code: str) -> dict:
    """POST /execute and return parsed JSON body."""
    r = requests.post(
        f"{BASE_HTTP}/execute",
        json={"language": language, "code": code},
        timeout=HTTP_TIMEOUT,
    )
    r.raise_for_status()
    return r.json()


async def ws_execute_async(
    language: str,
    code: str,
    *,
    disconnect_after: float | None = None,
) -> tuple[list[dict], float]:
    """
    Open /ws/execute, send the payload, collect messages until a ``result``
    or ``error`` message arrives (or disconnect_after seconds elapse).

    Each returned message dict has an extra ``_ts`` key: monotonic seconds
    since the connection was opened.

    Returns (messages, total_elapsed_seconds).
    """
    # Derive a per-language recv timeout: executor's own timeout + a safety
    # margin.  This prevents the test from timing out before the executor does
    # for slow-to-compile languages (Go, Rust).
    ws_recv_timeout = get_ws_recv_timeout(language)

    messages: list[dict] = []
    t0 = time.monotonic()

    async with websockets.connect(BASE_WS, open_timeout=10) as ws:
        await ws.send(json.dumps({"language": language, "code": code}))

        while True:
            if (
                disconnect_after is not None
                and (time.monotonic() - t0) >= disconnect_after
            ):
                break  # intentional early disconnect

            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=ws_recv_timeout)
            except asyncio.TimeoutError:
                raise TimeoutError(
                    f"ws_execute: no result/error within {ws_recv_timeout}s"
                )

            msg = json.loads(raw)
            msg["_ts"] = time.monotonic() - t0
            messages.append(msg)

            if msg["type"] in ("result", "error"):
                break

    return messages, time.monotonic() - t0


def ws_execute(language: str, code: str, **kw) -> tuple[list[dict], float]:
    """Synchronous wrapper around ws_execute_async."""
    return _run(ws_execute_async(language, code, **kw))


def stdout_of(msgs: list[dict]) -> str:
    return "".join(m.get("data", "") for m in msgs if m.get("type") == "stdout")


def stderr_of(msgs: list[dict]) -> str:
    return "".join(m.get("data", "") for m in msgs if m.get("type") == "stderr")


def result_of(msgs: list[dict]) -> dict | None:
    return next((m for m in msgs if m.get("type") == "result"), None)


def assert_no_orphan_containers():
    """Fail the test if any sandbox-labelled containers still exist."""
    client = docker.from_env()
    surviving = client.containers.list(all=True, filters={"label": DOCKER_LABEL})
    assert surviving == [], "Orphaned sandbox containers: " + ", ".join(
        f"{c.short_id}({c.status})" for c in surviving
    )


@pytest.fixture(scope="session", autouse=True)
def purge_stale_containers():
    """Remove any leftover sandbox containers from a previous (interrupted) test
    run before the session starts, and again at the very end.

    This prevents containers orphaned by a prior run from causing false
    positives in assert_no_orphan_containers() calls throughout the session.
    It does NOT mask real bugs: per-test orphan checks still run after each
    test and catch containers leaked by *this* run.
    """

    def _purge():
        client = docker.from_env()
        for c in client.containers.list(all=True, filters={"label": DOCKER_LABEL}):
            try:
                c.remove(force=True)
            except Exception:
                pass

    _purge()  # before suite
    yield
    _purge()  # after suite


# ---------------------------------------------------------------------------
# 2. Basic Execution Tests
# ---------------------------------------------------------------------------


class TestBasicExecution:
    """TEST-01 through TEST-04."""

    @pytest.mark.parametrize("lang", ALL_LANGUAGES)
    def test_01_hello_world(self, lang):
        """TEST-01: Simple output -- every supported language."""
        msgs, _ = ws_execute(lang, HELLO_WORLD[lang])
        r = result_of(msgs)
        assert r is not None, "No result message received"
        assert r["exit_code"] == 0, f"exit_code={r['exit_code']}"
        assert r["status"] == "success", f"status={r['status']}"
        assert "Hello, World!" in stdout_of(msgs), f"stdout={stdout_of(msgs)!r}"
        assert_no_orphan_containers()

    @pytest.mark.parametrize("lang", ALL_LANGUAGES)
    def test_02_no_output(self, lang):
        """TEST-02: Programs that produce no stdout/stderr exit cleanly."""
        msgs, _ = ws_execute(lang, NO_OUTPUT[lang])
        r = result_of(msgs)
        assert r is not None
        assert r["status"] == "success"
        assert r["exit_code"] == 0
        data_msgs = [m for m in msgs if m["type"] in ("stdout", "stderr")]
        assert data_msgs == [], f"Unexpected output messages: {data_msgs}"
        assert_no_orphan_containers()

    def test_03_runtime_error_captured(self):
        """TEST-03: Runtime error -- stderr captured, non-zero exit code."""
        msgs, _ = ws_execute("python", 'print("before error")\n1 / 0\n')
        r = result_of(msgs)
        assert r["exit_code"] != 0, "Expected non-zero exit code"  # type: ignore
        assert r["status"] == "error"  # type: ignore
        assert "before error" in stdout_of(msgs)
        assert "ZeroDivisionError" in stderr_of(msgs)
        assert_no_orphan_containers()

    @pytest.mark.parametrize("lang", list(COMPILE_ERROR))
    def test_04_compilation_error(self, lang):
        """TEST-04: Compilation error -- non-zero exit, container cleaned up."""
        msgs, _ = ws_execute(lang, COMPILE_ERROR[lang])
        r = result_of(msgs)
        assert r is not None
        assert r["exit_code"] != 0, "Compilation error must produce non-zero exit"
        assert_no_orphan_containers()


# ---------------------------------------------------------------------------
# 3. Streaming Tests
# ---------------------------------------------------------------------------


class TestStreaming:
    """TEST-05 through TEST-09."""

    def test_05_delayed_output_arrives_incrementally(self):
        """TEST-05: FIRST arrives immediately; SECOND arrives ~2 s later.

        The gap between the two messages must NOT be ~0 (which would indicate
        that output is buffered until container exit rather than streamed).
        """
        msgs, _ = ws_execute(
            "python",
            'import time\nprint("FIRST")\ntime.sleep(2)\nprint("SECOND")\n',
        )
        out = [m for m in msgs if m["type"] == "stdout"]
        first_ts = next(m["_ts"] for m in out if "FIRST" in m.get("data", ""))
        second_ts = next(m["_ts"] for m in out if "SECOND" in m.get("data", ""))
        gap = second_ts - first_ts
        assert gap >= 1.2, (
            f"FIRST and SECOND arrived only {gap:.3f}s apart -- "
            "output appears to be batched until execution completes"
        )

    def test_06_multiple_delayed_messages(self):
        """TEST-06: Five messages printed 1 s apart arrive 1 s apart."""
        msgs, elapsed = ws_execute(
            "python",
            "import time\n"
            "for i in range(5):\n"
            "    print(f'message {i}')\n"
            "    time.sleep(1)\n",
        )
        for i in range(5):
            assert f"message {i}" in stdout_of(msgs), f"message {i} missing"
        # 5 prints with 1 s sleep between them => >= 4 s total elapsed
        assert (
            elapsed >= 3.5
        ), f"Elapsed {elapsed:.2f}s -- looks like output was batched"

    def test_07_rapid_output_no_crash(self):
        """TEST-07: 1 000 printed lines handled without crash or corruption."""
        msgs, _ = ws_execute("python", "for i in range(1000):\n    print(i)\n")
        r = result_of(msgs)
        assert r is not None
        assert_no_orphan_containers()

    def test_08_stdout_stderr_interleaving(self):
        """TEST-08: Both stdout and stderr arrive with correct type labels."""
        msgs, _ = ws_execute(
            "python",
            "import sys, time\n"
            "for i in range(5):\n"
            "    print(f'stdout {i}', flush=True)\n"
            "    print(f'stderr {i}', file=sys.stderr, flush=True)\n"
            "    time.sleep(0.2)\n",
        )
        assert [m for m in msgs if m["type"] == "stdout"], "No stdout messages"
        assert [m for m in msgs if m["type"] == "stderr"], "No stderr messages"
        assert "stdout 0" in stdout_of(msgs)
        assert "stderr 0" in stderr_of(msgs)

    def test_09_large_chunk_truncated(self):
        """TEST-09: Output > MAX_OUTPUT_CHARS is truncated; backend stays up."""
        msgs, _ = ws_execute("python", 'print("A" * 200_000)\n')
        total = len(stdout_of(msgs))
        assert (
            total <= MAX_OUTPUT_CHARS + 100
        ), f"stdout length {total} exceeds MAX_OUTPUT_CHARS={MAX_OUTPUT_CHARS}"
        assert_no_orphan_containers()


# ---------------------------------------------------------------------------
# 4. Timeout Tests
# ---------------------------------------------------------------------------


class TestTimeout:
    """TEST-10 through TEST-13."""

    def test_10_infinite_loop_killed_at_timeout(self):
        """TEST-10: Infinite loop terminates at TIMEOUT_SECONDS."""
        start = time.monotonic()
        msgs, _ = ws_execute("python", "while True:\n    pass\n")
        elapsed = time.monotonic() - start
        r = result_of(msgs)
        assert r["status"] == "timeout"  # type: ignore
        assert (
            elapsed < _PYTHON_TIMEOUT + 5
        ), f"Took {elapsed:.1f}s (expected <{_PYTHON_TIMEOUT+5})"
        assert_no_orphan_containers()

    def test_11_sleep_beyond_timeout_output_check(self):
        """TEST-11: Output before sleep arrives; output after sleep never arrives."""
        msgs, _ = ws_execute(
            "python",
            'print("starting")\nimport time\ntime.sleep(60)\nprint("should never appear")\n',
        )
        r = result_of(msgs)
        assert r["status"] == "timeout"  # type: ignore
        assert "starting" in stdout_of(msgs)
        assert "should never appear" not in stdout_of(msgs)
        assert_no_orphan_containers()

    def test_12_cpu_intensive_still_times_out(self):
        """TEST-12: CPU-saturating loop terminates on schedule."""
        start = time.monotonic()
        msgs, _ = ws_execute("python", "while True:\n    x = 1234567 * 7654321\n")
        elapsed = time.monotonic() - start
        assert result_of(msgs)["status"] == "timeout"  # type: ignore
        assert elapsed < _PYTHON_TIMEOUT + 5
        assert_no_orphan_containers()

    @pytest.mark.parametrize("delta", [-1, 0, 1])
    def test_13_timeout_boundary(self, delta):
        """TEST-13: Boundary behaviour: sleep(TIMEOUT +/- delta)."""
        sleep = max(0, _PYTHON_TIMEOUT + delta)
        msgs, _ = ws_execute(
            "python", f"import time\ntime.sleep({sleep})\nprint('done')\n"
        )
        r = result_of(msgs)
        assert r is not None
        if delta < 0:
            assert (
                r["status"] == "success"
            ), f"delta={delta} should succeed, got {r['status']}"
        elif delta > 0:
            assert (
                r["status"] == "timeout"
            ), f"delta={delta} should timeout, got {r['status']}"
        # delta==0 is a deliberate race -- either outcome is acceptable
        assert_no_orphan_containers()


# ---------------------------------------------------------------------------
# 5. Process / PID Limit Tests
# ---------------------------------------------------------------------------


class TestPIDLimits:
    """TEST-14 through TEST-16."""

    def test_14_pid_limit_prevents_mass_process_creation(self):
        """TEST-14: pids_limit=64 prevents creating 1 000 child processes."""
        msgs, _ = ws_execute(
            "python",
            "import subprocess\n"
            "procs = []\n"
            "for i in range(1000):\n"
            "    try:\n"
            '        procs.append(subprocess.Popen(["sleep", "60"]))\n'
            "    except Exception as e:\n"
            '        print("stopped:", e)\n'
            "        break\n",
        )
        combined = stdout_of(msgs) + stderr_of(msgs)
        r = result_of(msgs)
        assert r is not None
        assert "stopped" in combined or r["status"] in (
            "timeout",
            "error",
        ), "PID limit did not appear to trigger -- 1000 processes may have been created"
        assert_no_orphan_containers()

    def test_15_bounded_fork_below_limit(self):
        """TEST-15: Attempting 200 processes stays well below 200 (pids_limit=64)."""
        msgs, _ = ws_execute(
            "python",
            "import subprocess\n"
            "created = 0\n"
            "for _ in range(200):\n"
            "    try:\n"
            '        subprocess.Popen(["sleep", "1"])\n'
            "        created += 1\n"
            "    except Exception:\n"
            "        break\n"
            "print(f'created {created}')\n",
        )
        out = stdout_of(msgs)
        if "created" in out:
            lines = [l for l in out.splitlines() if l.startswith("created")]
            if lines:
                n = int(lines[0].split()[1])
                assert n < 200, f"Created {n} processes -- pids_limit not enforced"
        assert_no_orphan_containers()

    def test_16_child_process_dies_with_container(self):
        """TEST-16: Child process spawned in container does not survive on host."""
        msgs, _ = ws_execute(
            "python",
            "import subprocess\n"
            'subprocess.Popen(["sleep", "60"])\n'
            'print("parent exiting")\n',
        )
        assert "parent exiting" in stdout_of(msgs)
        # Container removed -- any child processes inside it must be gone too
        assert_no_orphan_containers()


# ---------------------------------------------------------------------------
# 6. Container Cleanup Tests
# ---------------------------------------------------------------------------


class TestContainerCleanup:
    """TEST-17 through TEST-20."""

    def test_17_normal_cleanup(self):
        """TEST-17: Container removed after normal completion."""
        ws_execute("python", 'print("ok")\n')
        assert_no_orphan_containers()

    def test_18_cleanup_after_runtime_error(self):
        """TEST-18: Container removed after runtime crash."""
        ws_execute("python", "raise Exception('crash')\n")
        assert_no_orphan_containers()

    def test_19_cleanup_after_compilation_failure(self):
        """TEST-19: Container removed after compilation failure."""
        ws_execute("cpp", COMPILE_ERROR["cpp"])
        assert_no_orphan_containers()

    def test_20_cleanup_after_timeout(self):
        """TEST-20: Container removed after timeout kill."""
        msgs, _ = ws_execute("python", "while True:\n    pass\n")
        assert result_of(msgs)["status"] == "timeout"  # type: ignore
        time.sleep(0.5)  # brief pause to allow Docker remove to complete
        assert_no_orphan_containers()


# ---------------------------------------------------------------------------
# 7. Memory Limit Tests
# ---------------------------------------------------------------------------


class TestMemoryLimits:
    """TEST-22 through TEST-23."""

    def test_22_one_gib_allocation_denied(self):
        """TEST-22: Allocating 1 GiB fails -- mem_limit=256m."""
        msgs, _ = ws_execute(
            "python",
            "x = bytearray(1024 * 1024 * 1024)\nprint('allocated')\n",
        )
        assert "allocated" not in stdout_of(
            msgs
        ), "1 GiB allocation succeeded -- mem_limit not enforced"
        assert result_of(msgs)["status"] in ("error", "timeout")  # type: ignore
        assert_no_orphan_containers()

    def test_23_gradual_allocation_hits_limit(self):
        """TEST-23: Gradual 10 MiB-at-a-time allocation hits limit cleanly."""
        msgs, _ = ws_execute(
            "python",
            "data = []\n"
            "while True:\n"
            "    data.append(bytearray(10 * 1024 * 1024))\n",
        )
        assert result_of(msgs)["status"] in ("error", "timeout")  # type: ignore
        assert_no_orphan_containers()


# ---------------------------------------------------------------------------
# 8. CPU Limit Tests
# ---------------------------------------------------------------------------


class TestCPULimits:
    """TEST-24 through TEST-25."""

    def test_24_cpu_saturating_loop_bounded(self):
        """TEST-24: Infinite loop is bounded -- timeout fires inside window."""
        start = time.monotonic()
        msgs, _ = ws_execute("python", "while True:\n    pass\n")
        elapsed = time.monotonic() - start
        assert result_of(msgs)["status"] == "timeout"  # type: ignore
        assert elapsed < _PYTHON_TIMEOUT * 2, f"Took {elapsed:.1f}s"
        assert_no_orphan_containers()

    def test_25_multiple_cpu_hungry_containers(self):
        """TEST-25: Four simultaneous CPU-saturating runs all timeout cleanly."""

        async def run_all():
            tasks = [
                asyncio.create_task(
                    ws_execute_async("python", "while True:\n    pass\n")
                )
                for _ in range(4)
            ]
            return await asyncio.gather(*tasks, return_exceptions=True)

        results = _run(run_all())
        for result in results:
            assert not isinstance(result, Exception), f"Task raised: {result}"
            msgs, _ = result
            assert result_of(msgs)["status"] == "timeout"  # type: ignore
        assert_no_orphan_containers()


# ---------------------------------------------------------------------------
# 9. Output Flooding / Queue Pressure
# ---------------------------------------------------------------------------


class TestOutputFlooding:
    """TEST-26 through TEST-30."""

    def test_26_massive_stdout_truncated(self):
        """TEST-26: 1 M print lines -- output limit enforced, backend stays up."""
        msgs, _ = ws_execute(
            "python", "for i in range(1_000_000):\n    print('A' * 32)\n"
        )
        assert len(stdout_of(msgs)) <= MAX_OUTPUT_CHARS + 100
        assert_no_orphan_containers()

    def test_27_massive_stderr_truncated(self):
        """TEST-27: 1 M stderr lines -- limit enforced."""
        msgs, _ = ws_execute(
            "python",
            "import sys\n"
            "for i in range(1_000_000):\n    print('E', file=sys.stderr)\n",
        )
        assert len(stderr_of(msgs)) <= MAX_OUTPUT_CHARS + 100
        assert_no_orphan_containers()

    def test_28_simultaneous_flood_both_streams(self):
        """TEST-28: Simultaneous stdout+stderr flood -- neither stream blocks."""
        msgs, _ = ws_execute(
            "python",
            "import sys\n"
            "for i in range(100_000):\n"
            "    print('o', i)\n"
            "    print('e', i, file=sys.stderr)\n",
        )
        assert result_of(msgs) is not None
        assert_no_orphan_containers()

    def test_29_tiny_chunks_one_char_at_a_time(self):
        """TEST-29: 26 single-character flushes -- all received correctly."""
        msgs, _ = ws_execute(
            "python",
            "import sys, time\n"
            "for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ':\n"
            "    sys.stdout.write(c)\n"
            "    sys.stdout.flush()\n"
            "    time.sleep(0.05)\n",
        )
        r = result_of(msgs)
        assert r["status"] == "success"  # type: ignore
        combined = stdout_of(msgs).replace("\n", "")
        assert "ABCDEFGHIJKLMNOPQRSTUVWXYZ" in combined
        assert_no_orphan_containers()

    def test_30_slow_client_queue_bounded(self):
        """TEST-30: Slow consumer (50 ms delay per message) -- no deadlock or OOM.

        Policy: chunks are dropped (not queued unboundedly) when the consumer
        falls behind.  The worker continues draining Docker output so it does
        not stall.  A result message always arrives.
        """

        async def slow_client():
            messages = []
            async with websockets.connect(BASE_WS, open_timeout=10) as ws:
                await ws.send(
                    json.dumps(
                        {
                            "language": "python",
                            "code": "for i in range(10_000):\n    print('x' * 100)\n",
                        }
                    )
                )
                while True:
                    raw = await asyncio.wait_for(ws.recv(), timeout=WS_RECV_TIMEOUT)
                    await asyncio.sleep(0.05)  # deliberate slow-down
                    msg = json.loads(raw)
                    messages.append(msg)
                    if msg["type"] in ("result", "error"):
                        break
            return messages

        msgs = _run(slow_client())
        assert result_of(msgs) is not None
        assert_no_orphan_containers()


# ---------------------------------------------------------------------------
# 10. WebSocket Disconnect Tests
# ---------------------------------------------------------------------------


class TestWebSocketDisconnect:
    """TEST-31 through TEST-33."""

    def test_31_disconnect_during_execution(self):
        """TEST-31: Client disconnects mid-execution -- no orphan container."""

        async def run():
            async with websockets.connect(BASE_WS, open_timeout=10) as ws:
                await ws.send(
                    json.dumps(
                        {
                            "language": "python",
                            "code": (
                                "import time\n"
                                "for i in range(10):\n"
                                "    print(i)\n"
                                "    time.sleep(1)\n"
                            ),
                        }
                    )
                )
                # Receive at least one message, then disconnect
                await asyncio.wait_for(ws.recv(), timeout=15)
                # WebSocket context exits here -> close frame sent

        _run(run())
        # Wait for container timeout + cleanup
        time.sleep(_PYTHON_TIMEOUT + 2)
        assert_no_orphan_containers()

    def test_32_disconnect_during_output_flood(self):
        """TEST-32: Disconnect during high-output execution -- no crash, no orphan."""

        async def run():
            async with websockets.connect(BASE_WS, open_timeout=10) as ws:
                await ws.send(
                    json.dumps(
                        {
                            "language": "python",
                            "code": "for i in range(1_000_000):\n    print('flood', i)\n",
                        }
                    )
                )
                for _ in range(3):
                    try:
                        await asyncio.wait_for(ws.recv(), timeout=10)
                    except Exception:
                        break
                # disconnect

        _run(run())
        time.sleep(_PYTHON_TIMEOUT + 2)
        assert_no_orphan_containers()

    def test_33_disconnect_near_timeout(self):
        """TEST-33: Disconnect-vs-timeout race -- no orphan container."""

        async def run():
            async with websockets.connect(BASE_WS, open_timeout=10) as ws:
                await ws.send(
                    json.dumps(
                        {
                            "language": "python",
                            "code": "while True:\n    pass\n",
                        }
                    )
                )
                await asyncio.sleep(_PYTHON_TIMEOUT - 0.5)
                # intentional disconnect just before the timeout fires

        _run(run())
        time.sleep(3)
        assert_no_orphan_containers()


# ---------------------------------------------------------------------------
# 11. Concurrent Execution Tests
# ---------------------------------------------------------------------------


class TestConcurrentExecution:
    """TEST-34 through TEST-36."""

    def test_34_two_sessions_isolated(self):
        """TEST-34: Output from session A never appears in session B."""

        async def run():
            a = asyncio.create_task(
                ws_execute_async(
                    "python",
                    "import time\n"
                    "for i in range(5):\n    print('A', i)\n    time.sleep(0.5)\n",
                )
            )
            b = asyncio.create_task(
                ws_execute_async(
                    "python",
                    "import time\n"
                    "for i in range(5):\n    print('B', i)\n    time.sleep(0.5)\n",
                )
            )
            return await asyncio.gather(a, b)

        (msgs_a, _), (msgs_b, _) = _run(run())
        out_a = stdout_of(msgs_a)
        out_b = stdout_of(msgs_b)
        assert "A 0" in out_a and "B" not in out_a, f"A received B's output: {out_a!r}"
        assert "B 0" in out_b and "A" not in out_b, f"B received A's output: {out_b!r}"
        assert_no_orphan_containers()

    def test_35_ten_simultaneous_sessions(self):
        """TEST-35: 10 concurrent executions are isolated -- each sees only its own output."""

        async def run():
            tasks = [
                asyncio.create_task(
                    ws_execute_async("python", f"print('session_{i}')\n")
                )
                for i in range(10)
            ]
            return await asyncio.gather(*tasks, return_exceptions=True)

        results = _run(run())
        for i, res in enumerate(results):
            assert not isinstance(res, Exception), f"Session {i} raised: {res}"
            msgs, _ = res
            assert result_of(msgs)["status"] == "success", f"Session {i} did not succeed"  # type: ignore
            assert f"session_{i}" in stdout_of(
                msgs
            ), f"Session {i} is missing its output"
        # Brief pause: 10 concurrent container.remove() calls race inside the
        # ThreadPoolExecutor; wait for all Docker removes to complete before
        # checking for orphans.
        time.sleep(1)
        assert_no_orphan_containers()

    def test_36_one_timeout_does_not_affect_other(self):
        """TEST-36: A times out; B completes successfully and unaffected."""

        async def run():
            a = asyncio.create_task(
                ws_execute_async("python", "while True:\n    pass\n")
            )
            b = asyncio.create_task(ws_execute_async("python", "print('B done')\n"))
            # return_exceptions=True captures any ws_execute_async TimeoutError
            # as a value instead of letting it abort the gather early.
            return await asyncio.gather(a, b, return_exceptions=True)

        results = _run(run())
        assert not isinstance(
            results[0], Exception
        ), f"Session A raised unexpectedly: {results[0]}"
        assert not isinstance(
            results[1], Exception
        ), f"Session B raised unexpectedly: {results[1]}"
        (msgs_a, _), (msgs_b, _) = results

        r_a = result_of(msgs_a)
        assert r_a is not None, (
            f"Session A: no 'result' message received — "
            f"server never sent final status. msgs={msgs_a}"
        )
        assert (
            r_a["status"] == "timeout"
        ), f"Session A: expected 'timeout', got {r_a['status']!r}"

        r_b = result_of(msgs_b)
        assert (
            r_b is not None
        ), f"Session B: no 'result' message received. msgs={msgs_b}"
        assert (
            r_b["status"] == "success"
        ), f"Session B: expected 'success', got {r_b['status']!r}"
        assert "B done" in stdout_of(msgs_b)

        time.sleep(2)  # allow server-side container.remove() calls to settle
        assert_no_orphan_containers()


# ---------------------------------------------------------------------------
# 12. Workspace Isolation
# ---------------------------------------------------------------------------


class TestWorkspaceIsolation:
    """TEST-37 through TEST-40."""

    def test_37_parent_directory_traversal_blocked(self):
        """TEST-37: ../escape cannot reach outside the /code mount."""
        msgs, _ = ws_execute(
            "python",
            "try:\n"
            "    open('../escape')\n"
            "    print('ESCAPED')\n"
            "except Exception as e:\n"
            "    print('blocked:', e)\n",
        )
        assert "ESCAPED" not in stdout_of(msgs)

    def test_38_process_is_not_root(self):
        """TEST-38: Container process runs as uid 1000, not root."""
        msgs, _ = ws_execute("python", "import os\nprint('uid:', os.getuid())\n")
        out = stdout_of(msgs)
        assert "uid: 0" not in out, "Container is running as root"
        assert f"uid: {EXEC_UID}" in out, f"Expected uid {EXEC_UID}, got: {out!r}"

    def test_39_absolute_path_traversal_blocked(self):
        """TEST-39: ../../../../etc/shadow traversal cannot read host file."""
        msgs, _ = ws_execute(
            "python",
            "try:\n"
            "    d = open('../../../../etc/shadow').read()\n"
            "    print('TRAVERSED')\n"
            "except Exception:\n"
            "    print('blocked')\n",
        )
        assert "TRAVERSED" not in stdout_of(msgs)

    def test_40_workspace_isolated_between_sessions(self):
        """TEST-40: /tmp written in session A is invisible to session B.

        Each execution runs in a distinct container with its own /tmp.
        """
        code_a = "open('/tmp/secret.txt', 'w').write('SECRET')\nprint('A wrote')\n"
        code_b = (
            "try:\n"
            "    print('got:', open('/tmp/secret.txt').read())\n"
            "except FileNotFoundError:\n"
            "    print('not found')\n"
        )

        async def run():
            msgs_a, _ = await ws_execute_async("python", code_a)
            msgs_b, _ = await ws_execute_async("python", code_b)
            return msgs_a, msgs_b

        msgs_a, msgs_b = _run(run())
        assert "A wrote" in stdout_of(msgs_a)
        assert "SECRET" not in stdout_of(
            msgs_b
        ), "Session B read session A's /tmp/secret.txt -- workspaces not isolated"


# ---------------------------------------------------------------------------
# 13. Network Isolation
# ---------------------------------------------------------------------------


class TestNetworkIsolation:
    """TEST-41 through TEST-43."""

    def test_41_http_request_blocked(self):
        """TEST-41: urllib.request.urlopen fails -- network_disabled=True."""
        msgs, _ = ws_execute(
            "python",
            "import urllib.request\n"
            "try:\n"
            "    urllib.request.urlopen('https://example.com', timeout=5)\n"
            "    print('CONNECTED')\n"
            "except Exception as e:\n"
            "    print('blocked:', type(e).__name__)\n",
        )
        assert "CONNECTED" not in stdout_of(msgs)
        assert "blocked" in stdout_of(msgs)

    def test_42_raw_socket_blocked(self):
        """TEST-42: socket.connect to 8.8.8.8:53 fails."""
        msgs, _ = ws_execute(
            "python",
            "import socket\n"
            "try:\n"
            "    s = socket.socket()\n"
            "    s.settimeout(3)\n"
            "    s.connect(('8.8.8.8', 53))\n"
            "    print('CONNECTED')\n"
            "except Exception as e:\n"
            "    print('blocked:', type(e).__name__)\n",
        )
        assert "CONNECTED" not in stdout_of(msgs)

    def test_43_dns_resolution_blocked(self):
        """TEST-43: gethostbyname fails -- no DNS without network."""
        msgs, _ = ws_execute(
            "python",
            "import socket\n"
            "try:\n"
            "    ip = socket.gethostbyname('example.com')\n"
            "    print('RESOLVED:', ip)\n"
            "except Exception as e:\n"
            "    print('blocked:', type(e).__name__)\n",
        )
        assert "RESOLVED" not in stdout_of(msgs)


# ---------------------------------------------------------------------------
# 14. Docker / Host Isolation
# ---------------------------------------------------------------------------


class TestDockerHostIsolation:
    """TEST-44, TEST-46, TEST-47."""

    def test_44_docker_socket_not_mounted(self):
        """TEST-44: /var/run/docker.sock must not exist inside the container."""
        msgs, _ = ws_execute(
            "python",
            "import os\n" "print('exists:', os.path.exists('/var/run/docker.sock'))\n",
        )
        assert "exists: True" not in stdout_of(
            msgs
        ), "Docker socket is accessible inside the sandbox"

    def test_46_runs_as_uid_1000_not_root(self):
        """TEST-46: Container process is uid 1000 (EXEC_UID), not root."""
        msgs, _ = ws_execute("python", "import os\nprint('uid:', os.getuid())\n")
        out = stdout_of(msgs)
        assert f"uid: {EXEC_UID}" in out, f"Expected uid {EXEC_UID}, got: {out!r}"
        assert "uid: 0" not in out

    def test_47_setuid_0_fails(self):
        """TEST-47: Attempting setuid(0) must not succeed (returns -1/EPERM)."""
        msgs, _ = ws_execute(
            "python",
            "import ctypes\n"
            "ret = ctypes.CDLL(None).setuid(0)\n"
            "print('ret:', ret)\n",
        )
        # setuid(0) returns 0 only on success -- must return -1 (EPERM)
        assert "ret: 0" not in stdout_of(msgs)


# ---------------------------------------------------------------------------
# 15. Read-Only Filesystem Tests
# ---------------------------------------------------------------------------


class TestReadOnlyFilesystem:
    """TEST-48 through TEST-49."""

    def test_48_code_mount_is_read_only(self):
        """TEST-48: Writing to /code/main.py fails -- mount mode=ro."""
        msgs, _ = ws_execute(
            "python",
            "try:\n"
            "    open('/code/main.py', 'w').write('x')\n"
            "    print('WRITE_OK')\n"
            "except Exception:\n"
            "    print('blocked')\n",
        )
        assert "WRITE_OK" not in stdout_of(
            msgs
        ), "/code mount is writable -- must be ro"

    def test_49_tmp_is_writable(self):
        """TEST-49: /tmp is writable (HOME=/tmp is intentional)."""
        msgs, _ = ws_execute(
            "python",
            "open('/tmp/t.txt', 'w').write('ok')\nprint('written')\n",
        )
        assert "written" in stdout_of(msgs), "/tmp must be writable (HOME=/tmp)"


# ---------------------------------------------------------------------------
# 16. File Size / Resource Limits
# ---------------------------------------------------------------------------


class TestFileLimits:
    """TEST-50."""

    def test_50_large_file_creation_stopped_by_ulimit(self):
        """TEST-50: Creating a file >10 MiB fails -- fsize ulimit enforced."""
        msgs, _ = ws_execute(
            "python",
            "try:\n"
            "    with open('/tmp/big.bin', 'wb') as f:\n"
            "        written = 0\n"
            "        while written < 20 * 1024 * 1024:\n"
            "            f.write(b'A' * 1024 * 1024)\n"
            "            written += 1024 * 1024\n"
            "    print('WROTE_FULL')\n"
            "except Exception as e:\n"
            "    print('stopped:', type(e).__name__)\n",
        )
        out = stdout_of(msgs) + stderr_of(msgs)
        assert (
            "WROTE_FULL" not in out
        ), "fsize ulimit not enforced -- 20 MiB file was written"


# ---------------------------------------------------------------------------
# 17. Protocol / Input Validation Tests
# ---------------------------------------------------------------------------


class TestInputValidation:
    """TEST-52 through TEST-55."""

    # --- WebSocket path ---

    def test_52_ws_unknown_language_error(self):
        """TEST-52 (WS): Unknown language returns error message; no container."""

        async def check():
            async with websockets.connect(BASE_WS, open_timeout=10) as ws:
                await ws.send(json.dumps({"language": "brainfuck", "code": "+++"}))
                raw = await asyncio.wait_for(ws.recv(), timeout=10)
                return json.loads(raw)

        msg = _run(check())
        assert msg["type"] == "error"
        assert_no_orphan_containers()

    def test_53_ws_empty_code_error(self):
        """TEST-53 (WS): Empty code returns error message; no container."""

        async def check():
            async with websockets.connect(BASE_WS, open_timeout=10) as ws:
                await ws.send(json.dumps({"language": "python", "code": ""}))
                raw = await asyncio.wait_for(ws.recv(), timeout=10)
                return json.loads(raw)

        msg = _run(check())
        assert msg["type"] == "error"
        assert_no_orphan_containers()

    # --- HTTP path ---

    def test_52b_http_unknown_language_400(self):
        """TEST-52 (HTTP): Unknown language -> 400 Bad Request."""
        r = requests.post(
            f"{BASE_HTTP}/execute",
            json={"language": "brainfuck", "code": "+++"},
            timeout=10,
        )
        assert r.status_code == 400

    def test_53b_http_empty_code_400(self):
        """TEST-53 (HTTP): Empty code -> 400 Bad Request."""
        r = requests.post(
            f"{BASE_HTTP}/execute",
            json={"language": "python", "code": ""},
            timeout=10,
        )
        assert r.status_code == 400

    def test_54_very_large_source_code_stable(self):
        """TEST-54: ~700 KB source code -- server stays stable."""
        large = "x = 1\n" * 100_000  # ~700 KB

        async def check():
            async with websockets.connect(
                BASE_WS, open_timeout=10, max_size=10 * 1024 * 1024
            ) as ws:
                await ws.send(json.dumps({"language": "python", "code": large}))
                while True:
                    raw = await asyncio.wait_for(ws.recv(), timeout=WS_RECV_TIMEOUT)
                    msg = json.loads(raw)
                    if msg["type"] in ("result", "error"):
                        return msg

        msg = _run(check())
        assert msg["type"] in ("result", "error")
        assert_no_orphan_containers()

    def test_55_malformed_ws_messages_no_crash(self):
        """TEST-55: Malformed payloads -- server does not crash or hang."""
        payloads = [
            "not json at all",
            json.dumps({"language": "python"}),  # missing code
            json.dumps({"code": "print(1)"}),  # missing language
            json.dumps({"language": 999, "code": True}),  # wrong types
            json.dumps({}),  # empty object
        ]

        async def send_one(payload: str):
            async with websockets.connect(BASE_WS, open_timeout=10) as ws:
                await ws.send(payload)
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=10)
                    return json.loads(raw)
                except Exception:
                    return None

        for payload in payloads:
            _run(send_one(payload))
            # Server must still be alive after each malformed message
            health = requests.get(f"{BASE_HTTP}/health", timeout=5)
            assert (
                health.status_code == 200
            ), f"Server appears down after malformed payload: {payload!r}"


# ---------------------------------------------------------------------------
# 18. Race Condition Tests
# ---------------------------------------------------------------------------


class TestRaceConditions:
    """TEST-56 through TEST-58."""

    def test_56_natural_completion_vs_timeout_boundary(self):
        """TEST-56: Near-timeout runs (x5) produce consistent, valid states."""
        code = f"import time\ntime.sleep({_PYTHON_TIMEOUT - 0.5})\nprint('done')\n"
        for attempt in range(5):
            msgs, _ = ws_execute("python", code)
            r = result_of(msgs)
            assert r is not None, f"No result on attempt {attempt}"
            assert r["status"] in (
                "success",
                "timeout",
            ), f"Unexpected status {r['status']} on attempt {attempt}"
            assert_no_orphan_containers()

    def test_57_timeout_vs_cleanup_no_orphan(self):
        """TEST-57: sleep(_PYTHON_TIMEOUT) repeated 5x -- no orphan containers."""
        for _ in range(5):
            ws_execute("python", f"import time\ntime.sleep({_PYTHON_TIMEOUT})\n")
            time.sleep(0.5)
            assert_no_orphan_containers()

    def test_58_disconnect_at_multiple_moments(self):
        """TEST-58: Disconnect at 0.1 s, 0.5 s, and TIMEOUT-0.5 s -- no leaks."""
        code = "import time\nfor i in range(100):\n    print(i)\n    time.sleep(0.3)\n"
        for delay in [0.1, 0.5, _PYTHON_TIMEOUT - 0.5]:

            async def run(d=delay):
                async with websockets.connect(BASE_WS, open_timeout=10) as ws:
                    await ws.send(json.dumps({"language": "python", "code": code}))
                    await asyncio.sleep(d)
                    # intentional disconnect

            _run(run())
            time.sleep(_PYTHON_TIMEOUT + 2)  # wait for container cleanup
            assert_no_orphan_containers()


# ---------------------------------------------------------------------------
# 19. Stress / Abuse Combinations
# ---------------------------------------------------------------------------


class TestStressAbuse:
    """TEST-59 through TEST-62."""

    def test_59_cpu_plus_output_flood(self):
        """TEST-59: CPU saturation + output flood -- all limits hold simultaneously."""
        msgs, elapsed = ws_execute("python", "while True:\n    print('A' * 32)\n")
        assert result_of(msgs)["status"] == "timeout"  # type: ignore
        assert len(stdout_of(msgs)) <= MAX_OUTPUT_CHARS + 100
        assert elapsed < _PYTHON_TIMEOUT + 5
        assert_no_orphan_containers()

    def test_60_memory_allocation_plus_output(self):
        """TEST-60: Memory allocation + output production -- both limits active."""
        msgs, _ = ws_execute(
            "python",
            "data = []\ni = 0\n"
            "while True:\n"
            "    data.append(bytearray(1024 * 1024))\n"
            "    print(f'allocated {i} MiB')\n"
            "    i += 1\n",
        )
        r = result_of(msgs)
        assert r["status"] in ("error", "timeout")  # type: ignore
        assert len(stdout_of(msgs)) <= MAX_OUTPUT_CHARS + 100
        assert_no_orphan_containers()

    def test_61_process_creation_plus_timeout(self):
        """TEST-61: PID limit + timeout both fire correctly together."""
        msgs, elapsed = ws_execute(
            "python",
            "import subprocess, time\n"
            "for i in range(1000):\n"
            "    try:\n"
            '        subprocess.Popen(["sleep", "60"])\n'
            "    except Exception:\n"
            "        break\n"
            "time.sleep(60)\n",
        )
        assert result_of(msgs)["status"] == "timeout"  # type: ignore
        assert elapsed < _PYTHON_TIMEOUT + 5
        assert_no_orphan_containers()

    def test_62_everything_combined(self):
        """TEST-62: CPU + memory + processes + network + filesystem + output + timeout."""
        msgs, elapsed = ws_execute(
            "python",
            "import subprocess, socket, time, os\n"
            # spawn child processes
            "procs = []\n"
            "for _ in range(50):\n"
            "    try: procs.append(subprocess.Popen(['sleep', '60']))\n"
            "    except Exception: pass\n"
            # network attempt
            "try:\n"
            "    s = socket.socket()\n"
            "    s.connect(('8.8.8.8', 53))\n"
            "except Exception: pass\n"
            # host filesystem escape attempt
            "try: open('/etc/shadow').read()\n" "except Exception: pass\n"
            # memory
            "data = []\n"
            "for _ in range(300):\n"
            "    try: data.append(bytearray(1024 * 1024))\n"
            "    except Exception: break\n"
            # output flood
            "for i in range(100_000):\n    print('flood', i)\n"
            # keep alive past timeout
            "while True: pass\n",
        )
        r = result_of(msgs)
        assert r["status"] in ("timeout", "error")  # type: ignore
        assert elapsed < _PYTHON_TIMEOUT + 10
        assert len(stdout_of(msgs)) <= MAX_OUTPUT_CHARS + 100
        assert_no_orphan_containers()


# ---------------------------------------------------------------------------
# 23. WebSocket Protocol Correctness
# ---------------------------------------------------------------------------


class TestWebSocketProtocol:

    def test_result_is_always_last_message(self):
        """Result message arrives last, before WebSocket close."""
        msgs, _ = ws_execute("python", 'print("hi")\n')
        assert (
            msgs[-1]["type"] == "result"
        ), f"Last message type is {msgs[-1]['type']!r}, expected 'result'"

    def test_no_output_after_result(self):
        """No stdout/stderr messages appear after the result message."""
        msgs, _ = ws_execute(
            "python",
            "import time\n" "for i in range(3):\n    print(i)\n    time.sleep(0.3)\n",
        )
        idx = next((i for i, m in enumerate(msgs) if m["type"] == "result"), None)
        assert idx is not None, "No result message found"
        post = [m for m in msgs[idx + 1 :] if m["type"] in ("stdout", "stderr")]
        assert post == [], f"Output arrived after result: {post}"

    def test_timeout_produces_exactly_one_result(self):
        """Timeout -> exactly one result with status=timeout, no duplicates."""
        msgs, _ = ws_execute("python", "while True:\n    pass\n")
        results = [m for m in msgs if m["type"] == "result"]
        assert len(results) == 1, f"Expected 1 result, got {len(results)}"
        assert results[0]["status"] == "timeout"


# ---------------------------------------------------------------------------
# HTTP Endpoints -- regression tests (streaming changes must not break /execute)
# ---------------------------------------------------------------------------


class TestHTTPEndpoints:

    def test_health_ok(self):
        """GET /health returns 200 {status: ok}."""
        r = requests.get(f"{BASE_HTTP}/health", timeout=10)
        assert r.status_code == 200
        assert r.json()["status"] == "ok"

    def test_languages_lists_all_seven(self):
        """GET /languages lists exactly the 7 supported languages."""
        r = requests.get(f"{BASE_HTTP}/languages", timeout=10)
        assert r.status_code == 200
        assert set(r.json()["languages"]) == set(ALL_LANGUAGES)

    def test_limits_fields_present(self):
        """GET /limits returns expected resource-limit fields."""
        r = requests.get(f"{BASE_HTTP}/limits", timeout=10)
        assert r.status_code == 200
        body = r.json()
        assert "timeout_seconds" in body
        assert "max_output_chars" in body

    @pytest.mark.parametrize("lang", ALL_LANGUAGES)
    def test_http_execute_hello_world(self, lang):
        """POST /execute works for every language (streaming must not break HTTP path)."""
        body = http_execute(lang, HELLO_WORLD[lang])
        assert body["status"] == "success"
        assert body["exit_code"] == 0
        assert "Hello, World!" in body["stdout"]
