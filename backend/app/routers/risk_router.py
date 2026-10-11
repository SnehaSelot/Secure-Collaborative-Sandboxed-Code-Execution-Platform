"""
app/routers/risk_router.py — on-demand risk analysis (no execution).

Routes
------
POST /risk/analyze — score code and return the decision + findings.

Backs the "Analyze" button on RiskAnalysisPage.  Requires a valid token
(same get_current_user dependency as /collab/stats).

Semantics differ from the execution routes on purpose: this is an *analysis*,
so a "block" verdict is a normal 200 result the UI renders, not an HTTP error.
Only a failure of the risk engine itself (fail-closed) is an error (503),
because that is not a verdict about the code.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.auth import CollabUser, get_current_user
from app.services.executor import LANGUAGE_IMAGES
from risk.analyzer import RiskContext, assess_and_record

logger = logging.getLogger("exec-service")

router = APIRouter(prefix="/risk", tags=["risk"])

# Payload cap.  The scorer only scans the first 400k chars (anything larger is
# reported as blocked/oversized), so a bigger body is pointless to accept.
MAX_ANALYZE_CHARS = 1_000_000


class AnalyzeRequest(BaseModel):
    language: str = Field(..., description=f"One of: {', '.join(LANGUAGE_IMAGES)}")
    code: str = Field(
        ..., max_length=MAX_ANALYZE_CHARS, description="Source code to analyze"
    )


@router.post("/analyze")
async def analyze(req: AnalyzeRequest, user: CollabUser = Depends(get_current_user)):
    if req.language not in LANGUAGE_IMAGES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported language '{req.language}'. Supported: {sorted(LANGUAGE_IMAGES)}",
        )
    if not req.code.strip():
        raise HTTPException(status_code=400, detail="Code cannot be empty")

    # origin="analyze" keeps these audit rows distinct from real execution
    # attempts.  assess_and_record() never raises.
    decision = await assess_and_record(
        req.code,
        req.language,
        RiskContext(actor_id=str(user.id), origin="analyze"),
    )

    if decision.error:
        return JSONResponse(
            status_code=503,
            content={"status": "risk_unavailable", "risk": decision.to_dict()},
        )
    return decision.to_dict()
