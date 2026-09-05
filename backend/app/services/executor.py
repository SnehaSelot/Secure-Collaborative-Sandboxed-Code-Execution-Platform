import tempfile
import time
import os
import shutil

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
                "stdout": stdout,
                "stderr": stderr,
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