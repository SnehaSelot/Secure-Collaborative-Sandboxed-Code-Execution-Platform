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

PIDS_LIMIT = {
    "python": 32,
    "javascript": 32,
    "c": 32,
    "cpp": 32,
    "rust": 64,
    "java": 64,
    "go": 128,  # compiler forks more subprocesses
}

# Per-language fsize ulimit (bytes) — max size of a single file a process may write.
# Go's compiler writes multi-MB runtime .a object files into $WORK during `go run`;
# the default 10 MB kills compilation with "file too large".
_DEFAULT_FSIZE = 10_000_000
FSIZE_LIMIT = {
    "go": 256_000_000,  # runtime .a artefacts can be 100+ MB
    "rust": 64_000_000,  # rustc rlib / incremental artefacts
    "c": 32_000_000,
    "cpp": 32_000_000,
    "java": 32_000_000,
}

# Per-language execution timeout (seconds).
# Compiled languages need extra time: Go/Rust compile the full runtime on first run.
_DEFAULT_TIMEOUT = 15
TIMEOUT_SECONDS = {
    "python": 15,
    "javascript": 15,
    "java": 30,
    "c": 20,
    "cpp": 20,
    "go": 60,  # cold compile of stdlib takes ~25-30 s in the sandbox
    "rust": 60,  # rustc is similarly slow on first compile
}

# Per-language extra environment variables injected into the sandbox container.
# Go: disable the module proxy and checksum DB — with network_disabled=True the
# container cannot reach proxy.golang.org or sum.golang.org, so Go hangs for
# 20-40 s waiting for those TCP connections to time out before falling back to
# local-only mode.  GOPROXY=off short-circuits that stall immediately.
EXTRA_ENV: dict[str, list[str]] = {
    "go": [
        "GOPROXY=off",  # never try the module proxy
        "GONOSUMDB=*",  # skip checksum-DB lookups for all modules
        "GOFLAGS=-buildvcs=false",  # don't try to read git/VCS metadata
        "GOPATH=/tmp/gopath",  # explicit writable GOPATH inside the container
        "GOCACHE=/tmp/gocache",  # explicit writable build cache
    ],
}

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
                pids_limit=PIDS_LIMIT.get(language, 64),
                network_disabled=True,
                user=EXEC_UID,
                ulimits=[
                    docker.types.Ulimit(name="nofile", soft=2048, hard=2048),  # type: ignore
                    docker.types.Ulimit(  # type: ignore
                        name="fsize",
                        soft=FSIZE_LIMIT.get(language, _DEFAULT_FSIZE),
                        hard=FSIZE_LIMIT.get(language, _DEFAULT_FSIZE),
                    ),
                ],
                environment=["HOME=/tmp"] + EXTRA_ENV.get(language, []),
                labels={"sandbox": "exec-service"},
            )

            try:
                result = container.wait(
                    timeout=TIMEOUT_SECONDS.get(language, _DEFAULT_TIMEOUT)
                )
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
    needs to perform a kill.  ``set_stream`` / ``close_stream`` let the kill
    path close the Docker attach socket directly, which immediately unblocks
    the streaming worker thread without waiting for a container-level signal.

    A single lock guards both fields so that a kill racing with stream
    registration is always safe.
    """

    _lock: threading.Lock = field(
        default_factory=threading.Lock, init=False, repr=False
    )
    _container_id: str | None = field(default=None, init=False)
    # docker-py CancellableStream (or any object with .close())
    _attach_stream: object | None = field(default=None, init=False)

    def set(self, container_id: str) -> None:
        with self._lock:
            self._container_id = container_id

    def get(self) -> str | None:
        with self._lock:
            return self._container_id

    def set_stream(self, stream: object) -> None:
        """Register the attach stream so close_stream() can reach it."""
        with self._lock:
            self._attach_stream = stream

    def close_stream(self) -> None:
        """Close the attach stream from the kill path to unblock the worker.

        Closing the underlying socket causes the blocked socket read inside
        the docker-py generator to raise immediately, breaking the streaming
        loop without waiting for the container to exit.

        Safe to call before the stream is registered (no-op) or after it
        has already been closed (also a no-op).
        """
        with self._lock:
            stream = self._attach_stream
            self._attach_stream = None  # prevent double-close
        if stream is not None:
            try:
                stream.close()  # type: ignore[union-attr]
            except Exception:
                pass


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
            # Create container without starting it yet.
            # Attaching before start guarantees that initial output is never lost.
            container = client.containers.create(
                LANGUAGE_IMAGES[language],
                command,
                volumes={bind_source: {"bind": CODE_MOUNT_DIR, "mode": "ro"}},
                working_dir=CODE_MOUNT_DIR,
                mem_limit="256m",
                nano_cpus=500_000_000,
                pids_limit=PIDS_LIMIT.get(language, 64),
                network_disabled=True,
                user=EXEC_UID,
                ulimits=[
                    docker.types.Ulimit(name="nofile", soft=2048, hard=2048),  # type: ignore
                    docker.types.Ulimit(  # type: ignore
                        name="fsize",
                        soft=FSIZE_LIMIT.get(language, _DEFAULT_FSIZE),
                        hard=FSIZE_LIMIT.get(language, _DEFAULT_FSIZE),
                    ),
                ],
                environment=["HOME=/tmp"] + EXTRA_ENV.get(language, []),
                labels={"sandbox": "exec-service"},
            )

            container_id = container.id

            if container_id is None:
                raise RuntimeError("Container started without an ID")

            # Expose the container ID to the async caller before entering the
            # blocking log-stream loop so it can issue a kill on timeout.
            container_holder.set(container_id)

            # Incremental output streaming via attach() with demux=True.
            stdout_sent = 0  # running char counts for truncation

            stderr_sent = 0
            stdout_truncated = False
            stderr_truncated = False

            attach_stream = client.api.attach(
                container_id,
                stream=True,
                stdout=True,
                stderr=True,
                demux=True,
            )

            # Register the stream in the holder so the kill path can call
            # holder.close_stream() to interrupt the blocking socket read
            # immediately, without waiting for the container to exit first.
            container_holder.set_stream(attach_stream)

            # Start container only AFTER attaching, guaranteeing no initial
            # output is ever missed due to race conditions.
            container.start()

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

            except Exception:
                # The attach stream was forcibly closed by the kill path
                # (container_holder.close_stream()), or a transient network
                # error occurred.  Stop streaming; the container will be
                # killed and removed in the outer finally block.
                pass
            finally:
                # Deregister from the holder to prevent a second close()
                # arriving from the kill path after we already cleaned up.
                # Then release the socket unconditionally.
                container_holder.close_stream()
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
