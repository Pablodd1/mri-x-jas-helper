"""
MRI X Jas Helper — Backend API
FastAPI server with multi-provider AI orchestration.
"""

import asyncio
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional
import uuid
import tempfile
import os

from config import get_settings
from services.ai_engine import analyze_image, transcribe_audio
from services.dicom_parser import process_medical_image, process_dicom_zip, DicomMetadata
from services.slice_selector import (
    select_slices_for_series,
    get_ai_prompt_from_clinical_question,
    infer_clinical_question_from_tags,
)
from services.report_generator import format_clinical_report, generate_quick_scan_summary

settings = get_settings()

app = FastAPI(
    title="MRI X Jas Helper API",
    description="Medical AI Radiology Assistant — Analyzes MRI, X-ray, CT images with AI",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # TODO: restrict to frontend domain in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Models ───────────────────────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    clinical_question: str
    tags: list[str] = []
    preferred_provider: str = "ollama"
    mode: str = "quick_scan"  # "quick_scan" | "deep_analysis"


class AnalyzeResponse(BaseModel):
    request_id: str
    mode: str
    report: str
    quick_summary: str
    provider: str
    model: str
    metadata: dict
    estimated_cost_usd: float
    success: bool
    error: Optional[str] = None


class TranscribeRequest(BaseModel):
    pass  # Audio sent as multipart


class HealthResponse(BaseModel):
    status: str
    providers: dict
    version: str
    modal: dict = {}


# ─── Health Check ────────────────────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Check API health and available AI providers."""
    return HealthResponse(
        status="ok",
        providers={
            "ollama": bool(settings.ollama_base_url),
            "kimi": bool(settings.kimi_api_key),
            "minimax": bool(settings.minimax_api_key),
            "deepgram": bool(settings.deepgram_api_key),
        },
        version="1.0.0",
        modal={
            "configured": bool(settings.modal_ollama_url),
            "url": settings.modal_ollama_url[:50] + "..." if settings.modal_ollama_url else "",
            "model": settings.modal_ollama_model,
        },
    )


# ─── AI Analysis ──────────────────────────────────────────────────────────────

@app.post("/api/analyze", response_model=AnalyzeResponse)
async def analyze_medical_image(
    file: UploadFile = File(...),
    clinical_question: str = Form(...),
    tags: str = Form("[]"),  # JSON array as string
    preferred_provider: str = Form("ollama"),
    mode: str = Form("quick_scan"),
):
    """
    Upload a medical image (DICOM, NIfTI, PNG, JPG) and get AI analysis.

    Modes:
    - quick_scan: Fast (< 10s), uses Ollama if available
    - deep_analysis: Comprehensive report, uses Kimi/MiniMax
    """
    request_id = str(uuid.uuid4())[:8]
    import json

    try:
        tags_list = json.loads(tags) if tags else []
    except json.JSONDecodeError:
        tags_list = []

    # Read uploaded file
    file_bytes = await file.read()

    # Process image (extract metadata)
    try:
        processed = process_medical_image(file_bytes, file.filename or "image.dcm")
        metadata = processed.metadata
        image_for_ai = processed.image_data
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to process image: {e}")

    # Convert numpy array to JPEG bytes for AI
    from services.dicom_parser import numpy_to_jpeg_bytes
    image_jpeg = numpy_to_jpeg_bytes(image_for_ai)

    # Determine prompt based on clinical question
    body_part = metadata.body_part or "CHEST"
    system_prompt = get_ai_prompt_from_clinical_question(clinical_question, body_part)

    if mode == "quick_scan":
        system_prompt = (
            f"Answer in 2-3 sentences maximum. {system_prompt}"
        )

    # Run AI analysis
    result = await analyze_image(
        image_bytes=image_jpeg,
        prompt=system_prompt,
        preferred_provider=preferred_provider,
    )

    if not result.get("success"):
        return AnalyzeResponse(
            request_id=request_id,
            mode=mode,
            report="",
            quick_summary="",
            provider=result.get("provider", "none"),
            model="",
            metadata=_metadata_to_dict(metadata),
            estimated_cost_usd=0.0,
            success=False,
            error=result.get("error", "Analysis failed"),
        )

    # Generate report
    raw_output = result.get("text", "")
    report = format_clinical_report(
        raw_ai_output=raw_output,
        study_type=f"{metadata.modality} - {body_part}",
        clinical_question=clinical_question,
        provider=result.get("provider", ""),
        model=result.get("model", ""),
    )

    quick_summary = generate_quick_scan_summary(raw_output) if mode == "quick_scan" else ""

    # Estimate cost
    estimated_cost = (
        0.0 if result.get("provider") == "ollama"
        else len(raw_output) / 4 * 0.03 / 1000  # rough estimate
    )

    return AnalyzeResponse(
        request_id=request_id,
        mode=mode,
        report=report,
        quick_summary=quick_summary,
        provider=result.get("provider", ""),
        model=result.get("model", ""),
        metadata=_metadata_to_dict(metadata),
        estimated_cost_usd=estimated_cost,
        success=True,
        error=None,
    )


# ─── Voice Transcription ─────────────────────────────────────────────────────

@app.post("/api/transcribe")
async def transcribe_clinical_note(
    audio: UploadFile = File(...),
):
    """
    Transcribe voice dictation using Deepgram Nova 2 Medical.
    """
    audio_bytes = await audio.read()

    result = await transcribe_audio(audio_bytes, mimetype=audio.content_type or "audio/webm")

    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("error", "Transcription failed"))

    return {
        "transcript": result.get("text", ""),
        "provider": "deepgram",
        "model": "nova-2-medical",
        "success": True,
    }


# ─── DICOM Study Processing ──────────────────────────────────────────────────

@app.post("/api/process-study")
async def process_dicom_study(
    files: list[UploadFile] = File(...),
    clinical_question: str = Form(...),
    tags: str = Form("[]"),
    preferred_provider: str = Form("ollama"),
):
    """
    Upload multiple DICOM files (a full study), get smart slice selection
    and comprehensive AI analysis across the study.
    """
    request_id = str(uuid.uuid4())[:8]
    import json

    try:
        tags_list = json.loads(tags) if tags else []
    except json.JSONDecodeError:
        tags_list = []

    clinical_pref = infer_clinical_question_from_tags(tags_list + [clinical_question])

    all_metadata = []
    all_images = []

    for file in files:
        try:
            file_bytes = await file.read()
            processed = process_medical_image(file_bytes, file.filename or "study.dcm")
            all_metadata.append(processed.metadata)
            all_images.append(processed)
        except Exception as e:
            continue  # Skip problematic files

    if not all_images:
        raise HTTPException(status_code=400, detail="No valid images found in study")

    # Select best slices based on clinical question
    best_slices = []
    for img in all_images:
        series_meta = {
            "num_slices": img.metadata.num_slices or 1,
            "orientation": "",  # Would need to parse DICOM orientation tags
            "weighting": img.metadata.series_description,
            "series_description": img.metadata.series_description,
        }
        selected = select_slices_for_series(series_meta, clinical_pref, max_slices=12)
        if selected:
            best_slices.extend([(img, idx) for idx in selected])

    # Limit total slices to avoid token overflow
    best_slices = best_slices[:24]

    # Generate comprehensive prompt
    prompt = f"""Analyze this medical imaging study.

STUDY INFO:
- Modality: {all_metadata[0].modality or 'UNKNOWN'}
- Body Part: {clinical_pref['body_part']}
- Clinical Question: {clinical_question}
- Number of series: {len(all_metadata)}
- Images being analyzed: {len(best_slices)}

TASK: Provide a comprehensive analysis addressing the clinical question.
Be thorough — you are viewing multiple slices from a study.
"""

    from services.dicom_parser import numpy_to_jpeg_bytes

    # Analyze each selected image
    results = []
    for img, slice_idx in best_slices[:6]:  # Limit to 6 for cost
        jpeg_bytes = numpy_to_jpeg_bytes(img.image_data)
        result = await analyze_image(
            image_bytes=jpeg_bytes,
            prompt=prompt,
            preferred_provider=preferred_provider,
        )
        if result.get("success"):
            results.append(result.get("text", ""))

    combined_analysis = "\n\n---\n\n".join(results) if results else "No successful analysis"

    report = format_clinical_report(
        raw_ai_output=combined_analysis,
        study_type=f"{all_metadata[0].modality or 'MR'} Study",
        clinical_question=clinical_question,
        provider=results[0].get("provider") if results else "none",
        model=results[0].get("model") if results else "",
    )

    return {
        "request_id": request_id,
        "num_series": len(all_metadata),
        "num_slices_analyzed": len(best_slices),
        "report": report,
        "metadata": [_metadata_to_dict(m) for m in all_metadata[:10]],  # First 10
        "success": True,
    }


# ─── Utility ─────────────────────────────────────────────────────────────────

def _metadata_to_dict(m: DicomMetadata) -> dict:
    return {
        "patient_id": m.patient_id,
        "study_date": m.study_date,
        "modality": m.modality,
        "series_description": m.series_description,
        "study_description": m.study_description,
        "num_slices": m.num_slices,
        "rows": m.rows,
        "columns": m.columns,
        "pixel_spacing": m.pixel_spacing,
        "slice_thickness": m.slice_thickness,
        "window_center": m.window_center,
        "window_width": m.window_width,
        "body_part": m.body_part,
    }


# ─── Startup ──────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    print("🏥 MRI X Jas Helper API starting...")
    print(f"   Ollama: {settings.ollama_base_url}")
    print(f"   Kimi:   {'✓ configured' if settings.kimi_api_key else '✗ not set'}")
    print(f"   MiniMax: {'✓ configured' if settings.minimax_api_key else '✗ not set'}")
    print(f"   Deepgram: {'✓ configured' if settings.deepgram_api_key else '✗ not set'}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=settings.port)
