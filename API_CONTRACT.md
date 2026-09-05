# Sandbox API Contract

Base URL for local development:

```text
http://localhost:8000
```

All request and response bodies use JSON unless stated otherwise.


The execution routes are implemented in `backend/app/app.py`.

The current Docker command starts `app.main:app` instead, which exposes only `/` and `/health`. To make `/execute` and `/languages` reachable from the frontend, the deployment entrypoint must start the app in `backend/app/app.py` (for example, `app.app:app`) or the routes must be moved into `main.py`.

The schemas below describe the intended frontend-facing contract.

## `GET /`

Returns a basic service message.

### Response `200 OK`

```json
{
  "message": "Sandbox API is running"
}
```

## `GET /health`

Checks whether the API process is running.

### Response `200 OK`

```json
{
  "status": "ok"
}
```

> Note: the currently active `backend/app/main.py` returns `{"status": "healthy"}`. The frontend should treat any `200 OK` health response as healthy, or the implementation should be normalized before relying on the value.

## `GET /languages`

Returns the languages accepted by `POST /execute`.

### Response `200 OK`

```json
{
  "languages": ["c", "cpp", "go", "java", "javascript", "python", "rust"]
}
```

The frontend should use this response to populate its language selector rather than hard-coding the list.

## `POST /execute`

Runs source code inside a restricted Docker container.

### Request headers

```http
Content-Type: application/json
```

### Request body

```json
{
  "language": "python",
  "code": "print(1 + 1)"
}
```

| Field      | Type   | Required | Description                                                      |
| ---------- | ------ | -------- | ---------------------------------------------------------------- |
| `language` | string | yes      | One of the values returned by `GET /languages`.                  |
| `code`     | string | yes      | Source code to execute. It must not be empty or whitespace-only. |

### Success response `200 OK`

```json
{
  "stdout": "2\n",
  "stderr": "",
  "exit_code": 0,
  "status": "success",
  "execution_time": 0.42
}
```

| Field            | Type    | Nullable | Description                                                                                              |
| ---------------- | ------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `stdout`         | string  | no       | Standard output produced by the program.                                                                 |
| `stderr`         | string  | no       | Standard error produced by the program, including compiler or runtime errors.                            |
| `exit_code`      | integer | yes      | Process exit code. `null` when no exit code is available, such as a timeout or internal execution error. |
| `status`         | string  | no       | One of `success`, `error`, `timeout`, or `internal_error`.                                               |
| `execution_time` | number  | no       | Execution duration in seconds.                                                                           |

### Status meanings

| Status           | Meaning                                          | Typical frontend behavior                                                |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| `success`        | The program exited with code `0`.                | Show `stdout` as the successful result.                                  |
| `error`          | The program ran but exited with a non-zero code. | Show `stderr` as a compile/runtime error and retain `stdout` if present. |
| `timeout`        | Execution exceeded the 10-second limit.          | Show a timeout message; `exit_code` is `null`.                           |
| `internal_error` | The execution service or Docker failed.          | Show a service error and allow retry; `exit_code` is `null`.             |

The frontend should inspect `status`, not only `exit_code`, because timeouts and internal errors have a `null` exit code.

### Invalid request response `400 Bad Request`

Unsupported language:

```json
{
  "detail": "Unsupported language 'ruby'. Supported: ['c', 'cpp', 'go', 'java', 'javascript', 'python', 'rust']"
}
```

Empty or whitespace-only code:

```json
{
  "detail": "Code cannot be empty"
}
```

Malformed or missing request fields are returned by FastAPI as a validation response, typically `422 Unprocessable Entity`:

```json
{
  "detail": [
    {
      "loc": ["body", "language"],
      "msg": "Field required",
      "type": "missing"
    }
  ]
}
```

### Internal API response `500 Internal Server Error`

```json
{
  "detail": "Internal error running code"
}
```

## Frontend TypeScript types

```ts
export type ExecutionStatus =
  | "success"
  | "error"
  | "timeout"
  | "internal_error";

export interface ExecuteRequest {
  language: string;
  code: string;
}

export interface ExecuteResponse {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  status: ExecutionStatus;
  execution_time: number;
}

export interface ApiError {
  detail:
    | string
    | Array<{
        loc: Array<string | number>;
        msg: string;
        type: string;
      }>;
}
```

## Frontend request example

```ts
const response = await fetch("http://localhost:8000/execute", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    language: "python",
    code: "print(1 + 1)",
  }),
});

const payload = await response.json();

if (!response.ok) {
  throw new Error(
    typeof payload.detail === "string"
      ? payload.detail
      : "The request was invalid",
  );
}

const result = payload as ExecuteResponse;
```

## Supported languages

| Value        | Source file extension |
| ------------ | --------------------- |
| `python`     | `.py`                 |
| `javascript` | `.js`                 |
| `java`       | `.java`               |
| `c`          | `.c`                  |
| `cpp`        | `.cpp`                |
| `go`         | `.go`                 |
| `rust`       | `.rs`                 |

## Execution limits relevant to the frontend

- Maximum execution time: 10 seconds.
- Network access is disabled inside the execution container.
- Memory limit: 256 MB.
- CPU limit: 0.5 CPU.
- The source file is mounted read-only.
- Compiled output is written inside the container and is not returned to the frontend.
