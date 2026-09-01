"""Request and response models for the converter API (§17, §18).

Both directions stay small by design. §17 forbids sending the document in the
convert request, and §18 forbids returning ZIP bytes in the response — the
binaries move over presigned Blob URLs, never through a Function body.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class ConvertRequest(BaseModel):
    """The §17 body: a job token plus presigned URLs. No file content."""

    model_config = {"extra": "forbid"}

    jobToken: str = Field(min_length=1)
    sourceGetUrl: str = Field(min_length=1)
    resultPutUrl: str = Field(min_length=1)

    # Optional: the job still completes without them.
    sourceDeleteUrl: str | None = None
    # D-002. Absent means the client is relying solely on the open response.
    statusPutUrl: str | None = None


class ConvertResponse(BaseModel):
    """The §18 success body. Small, and never the ZIP itself."""

    status: str = "success"
    jobId: str
    resultPathname: str
    resultBytes: int
    warnings: list[str] = Field(default_factory=list)

    # Useful to the UI and cheap to include.
    pagesOrSlides: int | None = None
    mediaCount: int = 0
    elapsedMs: int = 0
    # Restates the product guarantee on every single response (§64, §73).
    aiTokensUsed: int = 0


class ErrorResponse(BaseModel):
    """The §46 error body. Never carries internal detail."""

    code: str
    message: str
