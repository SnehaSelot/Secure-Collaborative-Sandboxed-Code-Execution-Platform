import subprocess
import time
import docker
from docker.errors import APIError, ContainerError, ImageNotFound

client = docker.from_env()

LANGUAGE_IMAGES = {
    "python": "python:3.12-slim",
    "javascript": "node:22-alpine",
    "java": "eclipse-temurin:21-jdk",
    "cpp": "gcc:14",
    "c": "gcc:14",
    "go": "golang:1.24-alpine",
    "rust": "rust:1.88-slim",
}

# {file} = path inside the container where we'll write the user's code
RUN_COMMANDS = {
    "python": lambda f: ["python", f],
    "javascript": lambda f: ["node", f],
    "java": lambda f: ["jshell", "-q", f],
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


def run_code(language: str, code: str) -> dict:
    if language not in LANGUAGE_IMAGES:
        raise ValueError(f"Unsupported language: {language}")
    if not code:
        raise ValueError("Code cannot be empty")

    container = None
    start = time.time()

    try:
        # Write the user's code to a temp file on the HOST, then mount it in.
        # This avoids shell-injection issues from embedding code in a command string.
        import tempfile, os

        tmp_dir = tempfile.mkdtemp()
        filename = f"main.{FILE_EXT[language]}"
        host_path = os.path.join(tmp_dir, filename)
        with open(host_path, "w") as f:
            f.write(code)

        container_path = f"/tmp/{filename}"
        command = RUN_COMMANDS[language](container_path)

        container = client.containers.run(
            LANGUAGE_IMAGES[language],
            command,
            volumes={tmp_dir: {"bind": "/tmp", "mode": "ro"}},
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
