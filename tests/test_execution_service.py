"""
End-to-end smoke test for the execution service.

Usage:
    pip install requests
    # in another terminal: uvicorn app.main:app --host 0.0.0.0 --port 8000
    python test_execution_service.py

Note: the first run per language will be slow if that image isn't already
pulled locally (client.containers.run() blocks on the pull before the
container even starts) — that's normal, not a failure. Pre-pull with:
    docker pull python:3.12-slim node:22-alpine eclipse-temurin:21-jdk \
                gcc:14 golang:1.24-alpine rust:1.88-slim
"""

import requests

BASE_URL = "http://localhost:8000"

# One hello-world snippet per language. Each must print "Hello, World!"
# and exit 0 — this is what actually exercises the full path: source file
# written -> mounted read-only at /code -> compiled (where relevant) as
# the non-root exec user -> run -> output captured -> container torn down.
HELLO_WORLD = {
    "python": 'print("Hello, World!")',
    "javascript": 'console.log("Hello, World!");',
    "java": (
        "public class Main {\n"
        "    public static void main(String[] args) {\n"
        '        System.out.println("Hello, World!");\n'
        "    }\n"
        "}\n"
    ),
    "c": (
        "#include <stdio.h>\n"
        "int main() {\n"
        '    printf("Hello, World!\\n");\n'
        "    return 0;\n"
        "}\n"
    ),
    "cpp": (
        "#include <iostream>\n"
        "int main() {\n"
        '    std::cout << "Hello, World!" << std::endl;\n'
        "    return 0;\n"
        "}\n"
    ),
    "go": (
        "package main\n"
        'import "fmt"\n'
        "func main() {\n"
        '    fmt.Println("Hello, World!")\n'
        "}\n"
    ),
    "rust": ("fn main() {\n" '    println!("Hello, World!");\n' "}\n"),
}

ERROR_SNIPPET = {"language": "python", "code": "raise Exception('boom')"}
TIMEOUT_SNIPPET = {"language": "python", "code": "while True:\n    pass\n"}

passed, failed = 0, 0


def check(label, condition, detail: object = ""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS  {label}")
    else:
        failed += 1
        print(f"  FAIL  {label}  {detail}")


def run(language, code):
    """POST /execute — uses a long timeout to allow first-time image pulls."""
    try:
        return requests.post(
            f"{BASE_URL}/execute",
            json={"language": language, "code": code},
            timeout=300,  # first run pulls the Docker image; can take minutes
        )
    except requests.exceptions.ReadTimeout:
        print(
            f"    [WARN] {language}: HTTP read timed out (image pull may still be running)"
        )
        return None
    except requests.exceptions.RequestException as e:
        print(f"    [WARN] {language}: request failed — {e}")
        return None


print("== /health ==")
r = requests.get(f"{BASE_URL}/health", timeout=10)
check("health returns 200", r.status_code == 200, r.text)

print("\n== /languages ==")
r = requests.get(f"{BASE_URL}/languages", timeout=10)
langs = set(r.json().get("languages", []))
check("all 7 languages listed", langs == set(HELLO_WORLD.keys()), langs)

print("\n== hello world per language ==")
for lang, code in HELLO_WORLD.items():
    r = run(lang, code)
    if r is None:
        check(f"{lang}: success + correct output", False, "request failed/timed out")
        continue
    body = r.json() if r.status_code == 200 else {"raw": r.text}
    ok = (
        r.status_code == 200
        and body.get("status") == "success"
        and body.get("exit_code") == 0
        and "Hello, World!" in body.get("stdout", "")
    )
    check(f"{lang}: success + correct output", ok, body)

print("\n== error path (non-zero exit) ==")
r = run(**ERROR_SNIPPET)
if r is None:
    check(
        "runtime exception -> status=error, exit_code != 0",
        False,
        "request failed/timed out",
    )
else:
    body = r.json()
    check(
        "runtime exception -> status=error, exit_code != 0",
        body.get("status") == "error" and body.get("exit_code") not in (0, None),
        body,
    )

print("\n== timeout path ==")
r = run(**TIMEOUT_SNIPPET)
if r is None:
    check("infinite loop -> status=timeout", False, "request failed/timed out")
else:
    body = r.json()
    check("infinite loop -> status=timeout", body.get("status") == "timeout", body)

print(f"\n{passed} passed, {failed} failed")
