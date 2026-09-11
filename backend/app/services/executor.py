import ntpath
import posixpath
import tempfile
import threading
import time
import os
import shutil
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Callable

import docker
from docker.errors import APIError, ContainerError, ImageNotFound

LANGUAGE_IMAGES = {
    "python": "python:3.12-slim",
    "javascript": "node:22-alpine",
    "java": "eclipse-temurin:21-jdk",
    "cpp": "gcc:14",
    "c": "gcc:14",
    "go": "golang:1.24-alpine",
    "rust": "rust:1.88-slim",
}


RUN_COMMANDS = {
    "python": lambda f: ["python", "-u", f],
    "javascript": lambda f: ["node", f],
    "java": lambda f: ["java", f],
    "c": lambda f: ["sh", "-c", f"gcc {f} -o /tmp/main && stdbuf -oL -eL /tmp/main"],
    "cpp": lambda f: ["sh", "-c", f"g++ {f} -o /tmp/main && stdbuf -oL -eL /tmp/main"],
    "go": lambda f: ["sh", "-c", f"go run {f}"],
    "rust": lambda f: ["sh", "-c", f"rustc {f} -o /tmp/main && /tmp/main"],
}

FILE_EXT = {
    "python": "py",
    "javascript": "js",
    "java": "java",
    "c": "c",
    "cpp": "cpp",
    "go": "go",
    "rust": "rs",
}

TIMEOUT_SECONDS = 10
CODE_MOUNT_DIR = "/code"

MAX_OUTPUT_CHARS = 20_000
EXEC_UID = "1000:1000"

# Container-side path for the shared code workspace, bind-mounted from the
# host in docker-compose.yml (./backend/exec_tmp:/exec_tmp). Only used when
# EXEC_TMP_HOST_PATH is set — see _code_workspace() below.
EXEC_TMP_CONTAINER_DIR = os.environ.get("EXEC_TMP_CONTAINER_DIR", "/exec_tmp")


def _host_join(host_path: str, *parts: str) -> str:
    """Join paths using the host OS's path separator, auto-detected from *host_path*."""
    if "\\" in host_path or (len(host_path) >= 2 and host_path[1] == ":"):
        return ntpath.join(host_path, *parts)
    return posixpath.join(host_path, *parts)


@contextmanager
def _code_workspace():
    """
    Yields (write_dir, bind_source_dir):
      write_dir       — where THIS process should write the code file.
      bind_source_dir — the path to hand docker-py's `volumes={...}` when
                         spawning the sandbox container.

    These are the same path in local dev (this process talks to Docker
    directly). They differ when running via docker-compose with the host's
    Docker socket mounted in: this process writes into its own container's
    /exec_tmp, but the (host) Docker daemon resolves bind-mount sources
    against the HOST filesystem — so the sandbox container's mount source
    must be the HOST-side path (EXEC_TMP_HOST_PATH + the same run id),
    which is bind-mounted to the same /exec_tmp location on both sides.
    """
    host_path = os.environ.get("EXEC_TMP_HOST_PATH")

    if host_path:
        run_id = uuid.uuid4().hex
        write_dir = os.path.join(EXEC_TMP_CONTAINER_DIR, run_id)
        os.makedirs(write_dir, exist_ok=True)
        try:
            bind_source = _host_join(host_path, run_id)
            yield write_dir, bind_source
        finally:
            shutil.rmtree(write_dir, ignore_errors=True)
    else:
        with tempfile.TemporaryDirectory() as d:
            yield d, d


def _truncate(text: str) -> str:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return text[:MAX_OUTPUT_CHARS] + f"\n...[truncated, {len(text)} chars total]"


def run_code(client: docker.DockerClient, language: str, code: str) -> dict:
    if language not in LANGUAGE_IMAGES:
        raise ValueError(f"Unsupported language: {language}")
    if not code:
        raise ValueError("Code cannot be empty")

    container = None
    start = time.time()

    with _code_workspace() as (write_dir, bind_source):
        filename = f"main.{FILE_EXT[language]}"
        host_write_path = os.path.join(write_dir, filename)
        with open(host_write_path, "w") as f:
            f.write(code)

        container_path = f"{CODE_MOUNT_DIR}/{filename}"
        command = RUN_COMMANDS[language](container_path)

        try:
            container = client.containers.run(
                LANGUAGE_IMAGES[language],
                command,
                volumes={bind_source: {"bind": CODE_MOUNT_DIR, "mode": "ro"}},
                working_dir=CODE_MOUNT_DIR,
                detach=True,
                mem_limit="256m",
                nano_cpus=500_000_000,
                pids_limit=64,
                network_disabled=True,
                user=EXEC_UID,
                ulimits=[
                    docker.types.Ulimit(name="nofile", soft=2048, hard=2048),  # type: ignore
                    docker.types.Ulimit(name="fsize", soft=10_000_000, hard=10_000_000),  # type: ignore
                ],
                environment=["HOME=/tmp"],
                labels={"sandbox": "exec-service"},
            )

            try:
                result = container.wait(timeout=TIMEOUT_SECONDS)
                exit_code = result.get("StatusCode", -1)
                status = "success" if exit_code == 0 else "error"
            except Exception:
                container.kill()
                exit_code = None
                status = "timeout"

            stdout = container.logs(stdout=True, stderr=False).decode(
                "utf-8", errors="replace"
            )
            stderr = container.logs(stdout=False, stderr=True).decode(
                "utf-8", errors="replace"
            )

            return {
                "stdout": _truncate(stdout) if status != "timeout" else "",
                "stderr": _truncate(stderr) if status != "timeout" else "",
                "exit_code": exit_code,
                "status": status,
                "execution_time": time.time() - start,
            }

        except (APIError, ContainerError, ImageNotFound) as e:
            print(f"Internal Error: {e}")  # swap for real logging later
            return {
                "stdout": "",
                "stderr": str(e),
                "exit_code": None,
                "status": "internal_error",
                "execution_time": time.time() - start,
            }

        finally:
            if container is not None:
                try:
                    container.remove(force=True)
                except Exception:
                    pass


# Streaming execution — new sibling of run_code(), used by the WebSocket path.
# run_code() and everything above this line are NOT modified.


@dataclass
class ContainerHolder:
    """Thread-safe wrapper that lets the async WebSocket caller read the
    container ID so it can kill the container on timeout.

    The worker writes ``container_id`` immediately after
    ``client.containers.run()`` returns; the async caller reads it once it
    needs to perform a kill.  A lock is used to make the write/read safe
    across threads.
    """

    _lock: threading.Lock = field(
        default_factory=threading.Lock, init=False, repr=False
    )
    _container_id: str | None = field(default=None, init=False)

    def set(self, container_id: str) -> None:
        with self._lock:
            self._container_id = container_id

    def get(self) -> str | None:
        with self._lock:
            return self._container_id


def stream_run_code(
    client: docker.DockerClient,
    language: str,
    code: str,
    emit: Callable[[dict], None],
    container_holder: ContainerHolder,
) -> tuple[int | None, str, float]:
    """Run *code* in the sandbox and call *emit* for each stdout/stderr chunk.

    This function is **transport-agnostic**: it knows nothing about WebSockets
    or asyncio queues.  The caller supplies *emit* and is responsible for
    forwarding messages to the WebSocket.

    Parameters
    ----------
    client:
        The Docker client (shared with the HTTP path).
    language:
        One of the supported language keys.
    code:
        Source code to execute.
    emit:
        Called from the worker thread with a message dict
        Must be thread-safe (the caller uses ``loop.call_soon_threadsafe``).
    container_holder:
        Receives the container ID immediately after the container starts so
        that the async caller can kill it on timeout.

    Returns
    -------
    (exit_code, status, execution_time)
        *status* is ``"success"``, ``"error"``, or ``"internal_error"``.
        The caller overrides it to ``"timeout"`` when it issued a kill.


    """
    if language not in LANGUAGE_IMAGES:
        raise ValueError(f"Unsupported language: {language}")
    if not code:
        raise ValueError("Code cannot be empty")

    container = None
    start = time.time()

    with _code_workspace() as (write_dir, bind_source):
        filename = f"main.{FILE_EXT[language]}"
        host_write_path = os.path.join(write_dir, filename)
        with open(host_write_path, "w") as f:
            f.write(code)

        container_path = f"{CODE_MOUNT_DIR}/{filename}"
        command = RUN_COMMANDS[language](container_path)

        try:
            # Do NOT change any of these without also updating run_code().
            container = client.containers.run(
                LANGUAGE_IMAGES[language],
                command,
                volumes={bind_source: {"bind": CODE_MOUNT_DIR, "mode": "ro"}},
                working_dir=CODE_MOUNT_DIR,
                detach=True,
                mem_limit="256m",
                nano_cpus=500_000_000,
                pids_limit=64,
                network_disabled=True,
                user=EXEC_UID,
                ulimits=[
                    docker.types.Ulimit(name="nofile", soft=2048, hard=2048),  # type: ignore
                    docker.types.Ulimit(name="fsize", soft=10_000_000, hard=10_000_000),  # type: ignore
                ],
                environment=["HOME=/tmp"],
                labels={"sandbox": "exec-service"},
            )

            container_id = container.id

            if container_id is None:
                raise RuntimeError("Container started without an ID")

            # Expose the container ID to the async caller before entering the
            # blocking log-stream loop so it can issue a kill on timeout.
            container_holder.set(container_id)

            # Incremental output streaming via attach() with demux=True.
            #
            # client.api.attach() returns a CancellableStream (generator) of
            # (stdout_bytes|None, stderr_bytes|None) tuples when demux=True and
            # stream=True.  Iterating it blocks the current thread until the
            # container exits and the connection is closed by the daemon.
            #
            # This is intentional: stream_run_code() runs inside a thread-pool
            # worker so blocking here is safe.
            stdout_sent = 0  # running char counts for truncation

            stderr_sent = 0
            stdout_truncated = False
            stderr_truncated = False

            attach_stream = client.api.attach(
                container_id,
                stream=True,
                stdout=True,
                stderr=True,
                logs=False,  # don't replay historical output; we start fresh
                demux=True,
            )

            try:
                for stdout_chunk, stderr_chunk in attach_stream:
                    # Each iteration yields exactly one non-None side.
                    # Handle stdout and stderr explicitly so mutable counters
                    # are updated correctly (tuple unpacking copies int/bool).

                    # --- stdout ---
                    if stdout_chunk is not None:
                        text = stdout_chunk.decode("utf-8", errors="replace")
                        if not stdout_truncated:
                            remaining = MAX_OUTPUT_CHARS - stdout_sent
                            if remaining <= 0:
                                emit({"type": "stdout_truncated"})
                                stdout_truncated = True
                            elif len(text) > remaining:
                                emit({"type": "stdout", "data": text[:remaining]})
                                emit({"type": "stdout_truncated"})
                                stdout_sent += remaining
                                stdout_truncated = True
                            else:
                                emit({"type": "stdout", "data": text})
                                stdout_sent += len(text)
                        # else: stream truncated — keep draining, discard data

                    # --- stderr ---
                    if stderr_chunk is not None:
                        text = stderr_chunk.decode("utf-8", errors="replace")
                        if not stderr_truncated:
                            remaining = MAX_OUTPUT_CHARS - stderr_sent
                            if remaining <= 0:
                                emit({"type": "stderr_truncated"})
                                stderr_truncated = True
                            elif len(text) > remaining:
                                emit({"type": "stderr", "data": text[:remaining]})
                                emit({"type": "stderr_truncated"})
                                stderr_sent += remaining
                                stderr_truncated = True
                            else:
                                emit({"type": "stderr", "data": text})
                                stderr_sent += len(text)
                        # else: stream truncated — keep draining, discard data

            finally:
                # Always close the attach response so the underlying socket is
                # released, even if iteration was interrupted.
                try:
                    attach_stream.close()
                except Exception:
                    pass

            # ------------------------------------------------------------------
            # Determine exit code after the stream has ended.
            # container.reload() refreshes attrs from the Docker daemon.
            # ------------------------------------------------------------------
            try:
                container.reload()
                exit_code: int | None = container.attrs["State"]["ExitCode"]
            except Exception:
                exit_code = None

            status = "success" if exit_code == 0 else "error"
            return exit_code, status, time.time() - start

        except (APIError, ContainerError, ImageNotFound) as e:
            print(f"Internal Error (stream): {e}")
            emit({"type": "stderr", "data": f"[Internal error: {e}]"})
            return None, "internal_error", time.time() - start

        finally:
            if container is not None:
                try:
                    container.remove(force=True)
                except Exception:
                    pass
