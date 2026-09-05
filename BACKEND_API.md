# Backend API Contract

This document specifies the exact API contract currently implemented in the backend service. It defines the communication protocol between the frontend and backend teams.

---

## Base Information

- **Backend Framework:** FastAPI (Python 3.12+)
- **Base URL (Local Development):** `http://localhost:8000`
- **API Version:** `0.1.0`
- **Default Content-Type:** `application/json`
- **Authentication:** Not implemented (endpoints are currently public / unauthenticated)

---

## 1. Health / System Endpoints

### GET /health

**Purpose:**  
Checks the operational health and availability of the backend API service.

**Authentication:**  
- Not required

**Request**

Headers:
```text
None required
```

Path parameters:
```text
None
```

Query parameters:
```text
None
```

Request body:
```text
None
```

**Success Response**

HTTP status:
```text
200
```

Response body:
```json
{
  "status": "ok"
}
```

Response fields:

| Field | Type | Description |
| ----- | ---- | ----------- |
| `status` | string | Health indicator, returns `"ok"` when operational. |

**Error Responses**

No specific error responses are returned under standard operation.

---

### GET /limits

**Purpose:**  
Retrieves the active resource limits and security constraints enforced on code execution containers.

**Authentication:**  
- Not required

**Request**

Headers:
```text
None required
```

Path parameters:
```text
None
```

Query parameters:
```text
None
```

Request body:
```text
None
```

**Success Response**

HTTP status:
```text
200
```

Response body:
```json
{
  "timeout_seconds": 10,
  "memory_limit": "256m",
  "max_processes": 64,
  "max_open_files": 2048,
  "max_file_size_bytes": 10000000,
  "max_output_chars": 20000
}
```

Response fields:

| Field | Type | Description |
| ----- | ---- | ----------- |
| `timeout_seconds` | integer | Maximum execution duration before container termination (10 seconds). |
| `memory_limit` | string | Container memory limit (`"256m"`). |
| `max_processes` | integer | Maximum process/thread limit (`64`). |
| `max_open_files` | integer | Maximum open file descriptor ulimit (`2048`). |
| `max_file_size_bytes` | integer | Maximum file size allowed in `/tmp` (`10000000` bytes / ~10MB). |
| `max_output_chars` | integer | Maximum character length of stdout/stderr before truncation (`20000` characters). |

**Error Responses**

No specific error responses are returned under standard operation.

---

## 2. Execution Endpoints

### GET /languages

**Purpose:**  
Returns the list of supported programming languages accepted by the execution engine.

**Authentication:**  
- Not required

**Request**

Headers:
```text
None required
```

Path parameters:
```text
None
```

Query parameters:
```text
None
```

Request body:
```text
None
```

**Success Response**

HTTP status:
```text
200
```

Response body:
```json
{
  "languages": [
    "c",
    "cpp",
    "go",
    "java",
    "javascript",
    "python",
    "rust"
  ]
}
```

Response fields:

| Field | Type | Description |
| ----- | ---- | ----------- |
| `languages` | array of strings | Alphabetically sorted list of language identifiers supported by `/execute`. |

**Error Responses**

No specific error responses are returned under standard operation.

---

### POST /execute

**Purpose:**  
Executes user-supplied code inside an isolated Docker sandbox container and returns execution results, logs, and timing metrics.

**Authentication:**  
- Not required

**Request**

Headers:
```text
Content-Type: application/json
```

Path parameters:
```text
None
```

Query parameters:
```text
None
```

Request body:
```json
{
  "language": "python",
  "code": "print(1 + 1)"
}
```

Request fields:

| Field | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| `language` | string | Yes | Target language identifier. Must be one of: `"c"`, `"cpp"`, `"go"`, `"java"`, `"javascript"`, `"python"`, `"rust"`. |
| `code` | string | Yes | Source code string to run. Cannot be empty or whitespace-only. |

**Success Response**

HTTP status:
```text
200
```

Response body:
```json
{
  "stdout": "2\n",
  "stderr": "",
  "exit_code": 0,
  "status": "success",
  "execution_time": 0.42
}
```

Response fields:

| Field | Type | Nullable | Description |
| ----- | ---- | -------- | ----------- |
| `stdout` | string | No | Standard output captured from the program. Truncated if output exceeds 20,000 characters. |
| `stderr` | string | No | Standard error captured from compilation or runtime. Truncated if output exceeds 20,000 characters. |
| `exit_code` | integer | Yes | Process exit code (`0` for success, non-zero for runtime/compilation error). Set to `null` on timeout or internal failure. |
| `status` | string | No | Execution state classifier. Possible values:<br>- `"success"`: Process exited with return code `0`.<br>- `"error"`: Process exited with a non-zero return code.<br>- `"timeout"`: Execution exceeded the 10-second timeout limit.<br>- `"internal_error"`: Docker daemon or service failure occurred. |
| `execution_time` | number | No | Elapsed execution duration in seconds. |

**Status Values & Behavior Reference**

| `status` Value | `exit_code` | Condition |
| -------------- | ----------- | --------- |
| `"success"` | `0` | Code compiled and ran to completion successfully. |
| `"error"` | `> 0` | Code failed compilation or threw a runtime error. Details in `stderr`. |
| `"timeout"` | `null` | Container was killed after exceeding the 10-second wall-clock timeout. |
| `"internal_error"` | `null` | Docker engine or host system error encountered during execution. |

**Error Responses**

1. **Unsupported Language (`400 Bad Request`)**
   - Occurs when `language` is not in the supported language list.
   ```json
   {
     "detail": "Unsupported language 'ruby'. Supported: ['c', 'cpp', 'go', 'java', 'javascript', 'python', 'rust']"
   }
   ```

2. **Empty Code (`400 Bad Request`)**
   - Occurs when `code` is empty or contains only whitespace.
   ```json
   {
     "detail": "Code cannot be empty"
   }
   ```

3. **Validation Error (`422 Unprocessable Entity`)**
   - Occurs when required fields (`language` or `code`) are missing or have invalid types.
   ```json
   {
     "detail": [
       {
         "type": "missing",
         "loc": ["body", "language"],
         "msg": "Field required"
       }
     ]
   }
   ```

4. **Internal Server Error (`500 Internal Server Error`)**
   - Occurs on unexpected backend exceptions during request handling.
   ```json
   {
     "detail": "Internal error running code"
   }
   ```

---

## Frontend Integration Summary

| Frontend Action | HTTP Method | Endpoint | Request Body | Response Summary |
| --------------- | ----------- | -------- | ------------ | ---------------- |
| Check backend health | `GET` | `/health` | None | `{"status": "ok"}` |
| Get supported languages | `GET` | `/languages` | None | `{"languages": [...]}` |
| Query sandbox limits | `GET` | `/limits` | None | `{"timeout_seconds": 10, ...}` |
| Execute code | `POST` | `/execute` | `{"language": "...", "code": "..."}` | `{"stdout": "...", "stderr": "...", "exit_code": 0, "status": "success", "execution_time": 0.42}` |

---

## Example Frontend Calls

### 1. Execute Code (`POST /execute`)

```javascript
const API_BASE_URL = "http://localhost:8000";

async function executeCode(language, code) {
  const response = await fetch(`${API_BASE_URL}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      language: language,
      code: code
    })
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.detail || `Execution failed with status ${response.status}`);
  }

  const result = await response.json();
  // result structure: { stdout, stderr, exit_code, status, execution_time }
  return result;
}

// Example usage:
executeCode("python", "print('Hello from sandbox!')")
  .then(res => console.log("Execution output:", res.stdout))
  .catch(err => console.error("Execution error:", err));
```

### 2. Fetch Supported Languages (`GET /languages`)

```javascript
const API_BASE_URL = "http://localhost:8000";

async function getSupportedLanguages() {
  const response = await fetch(`${API_BASE_URL}/languages`);
  if (!response.ok) {
    throw new Error(`Failed to fetch languages: ${response.status}`);
  }
  const data = await response.json();
  // data structure: { languages: ["c", "cpp", "go", "java", "javascript", "python", "rust"] }
  return data.languages;
}
```

### 3. Query Sandbox Limits (`GET /limits`)

```javascript
const API_BASE_URL = "http://localhost:8000";

async function getSandboxLimits() {
  const response = await fetch(`${API_BASE_URL}/limits`);
  if (!response.ok) {
    throw new Error(`Failed to fetch limits: ${response.status}`);
  }
  const data = await response.json();
  // data structure: { timeout_seconds: 10, memory_limit: "256m", ... }
  return data;
}
```

### 4. Check Backend Health (`GET /health`)

```javascript
const API_BASE_URL = "http://localhost:8000";

async function checkHealth() {
  const response = await fetch(`${API_BASE_URL}/health`);
  if (!response.ok) {
    return false;
  }
  const data = await response.json();
  return data.status === "ok";
}
```

---

## Current Implementation vs Planned API

### Implemented (Available Now)

The following endpoints are currently implemented, tested, and operational in `backend/app/main.py`:

- `GET /health` — Service health probe.
- `GET /languages` — List of supported execution languages.
- `GET /limits` — Active sandbox runtime security limits and constraints.
- `POST /execute` — Sandboxed multi-language code execution.

### Planned / Not Yet Implemented

The following features and endpoints mentioned in the platform architecture and requirements are **NOT yet implemented** in the backend:

- **Authentication & User Management** (e.g., `POST /auth/register`, `POST /auth/login`, `GET /users/me`, JWT session management) — *TBD / NOT IMPLEMENTED*
- **Collaborative Sessions & WebSockets** (e.g., `POST /sessions`, `GET /sessions/:id`, `/ws/collaborate`) — *TBD / NOT IMPLEMENTED*
- **AI-Assisted Code Risk Analysis** (e.g., `POST /analysis/risk`, pre-execution AST / AI security scans) — *TBD / NOT IMPLEMENTED*
- **Execution Auditing & Telemetry** (e.g., `GET /audits/executions`, persistent database audit trails) — *TBD / NOT IMPLEMENTED*
- **Admin Dashboard** (e.g., `GET /admin/metrics`, cluster status monitoring) — *TBD / NOT IMPLEMENTED*
- **Workspace File Management** (e.g., multi-file projects, file tree operations, workspace persistence) — *TBD / NOT IMPLEMENTED*

