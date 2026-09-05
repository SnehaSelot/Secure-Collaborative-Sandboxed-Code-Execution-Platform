import tempfile
import time
import os
import shutil
import uuid
from contextlib import contextmanager

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
    "python": lambda f: ["python", f],
    "javascript": lambda f: ["node", f],
    "java": lambda f: ["java", f],
    "c": lambda f: ["sh", "-c", f"gcc {f} -o /tmp/main && /tmp/main"],
    "cpp": lambda f: ["sh", "-c", f"g++ {f} -o /tmp/main && /tmp/main"],
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
            yield write_dir, f"{host_path.rstrip('/')}/{run_id}"
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
            )

            try:
                result = container.wait(timeout=TIMEOUT_SECONDS)
                exit_code = result.get("StatusCode", -1)
                status = "success" if exit_code == 0 else "error"
            except Exception:
                container.kill()
                return {
                    "stdout": "",
                    "stderr": "",
                    "exit_code": None,
                    "status": "timeout",
                    "execution_time": time.time() - start,
                }

            stdout = container.logs(stdout=True, stderr=False).decode(
                "utf-8", errors="replace"
            )
            stderr = container.logs(stdout=False, stderr=True).decode(
                "utf-8", errors="replace"
            )

            return {
                "stdout": _truncate(stdout),
                "stderr": _truncate(stderr),
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