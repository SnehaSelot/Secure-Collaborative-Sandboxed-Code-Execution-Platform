import tempfile
import time
import os

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

# Most language base images have a world-writable /tmp (mode 1777), so a
# non-root UID can still write build output there. Verified OK for
# python/node/gcc/rust images; double-check eclipse-temurin (java) and
# golang:alpine specifically if you hit permission errors after this change —
# if one image's /tmp isn't world-writable, drop `user=` for that language
# only rather than removing it everywhere.
EXEC_UID = "1000:1000"


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

    with tempfile.TemporaryDirectory() as tmp_dir:
        filename = f"main.{FILE_EXT[language]}"
        host_path = os.path.join(tmp_dir, filename)
        with open(host_path, "w") as f:
            f.write(code)

        container_path = f"{CODE_MOUNT_DIR}/{filename}"
        command = RUN_COMMANDS[language](container_path)

        try:
            container = client.containers.run(
                LANGUAGE_IMAGES[language],
                command,
                volumes={tmp_dir: {"bind": CODE_MOUNT_DIR, "mode": "ro"}},
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