"""
Vercel Serverless API — DICOM Study Processing
Handles multiple DICOM files, smart slice selection, and comprehensive AI analysis.
"""

import json
import os
import io
import uuid
import tempfile
from pathlib import Path
from http.server import BaseHTTPRequestHandler
from typing import Optional
from dataclasses import dataclass, field

from PIL import Image
import numpy as np
import httpx


# ─── DICOM Parser (shared with analyze.py) ───────────────────────────────────


@dataclass
class DicomMetadata:
    patient_id: str = ""
    study_date: str = ""
    modality: str = "UNKNOWN"
    series_description: str = ""
    num_slices: int = 0
    rows: int = 0
    columns: int = 0
    pixel_spacing: tuple = (1.0, 1.0)
    slice_thickness: float = 1.0
    window_center: float = 40.0
    window_width: float = 400.0
    study_description: str = ""
    body_part: str = "CHEST"
    raw_tags: dict = field(default_factory=dict)


def extract_metadata_from_dicom_bytes(data: bytes) -> DicomMetadata:
    metadata = DicomMetadata()
    try:
        import pydicom

        ds = pydicom.dcmread(io.BytesIO(data))
        metadata.patient_id = str(getattr(ds, "PatientID", ""))
        metadata.study_date = str(getattr(ds, "StudyDate", ""))
        metadata.modality = str(getattr(ds, "Modality", "UNKNOWN"))
        metadata.series_description = str(getattr(ds, "SeriesDescription", ""))
        metadata.study_description = str(getattr(ds, "StudyDescription", ""))
        metadata.rows = int(getattr(ds, "Rows", 512))
        metadata.columns = int(getattr(ds, "Columns", 512))
        try:
            ps = ds.PixelSpacing
            metadata.pixel_spacing = (float(ps[0]), float(ps[1]))
        except Exception:
            pass
        try:
            metadata.slice_thickness = float(ds.SliceThickness)
        except Exception:
            pass
        try:
            wc = ds.WindowCenter
            ww = ds.WindowWidth
            metadata.window_center = float(
                wc[0] if isinstance(wc, (list, tuple)) else wc
            )
            metadata.window_width = float(
                ww[0] if isinstance(ww, (list, tuple)) else ww
            )
        except Exception:
            pass
        desc = f"{metadata.study_description} {metadata.series_description}".upper()
        if "CHEST" in desc or "CXR" in desc:
            metadata.body_part = "CHEST"
        elif "BRAIN" in desc or "HEAD" in desc:
            metadata.body_part = "BRAIN"
        elif "KNEE" in desc or "SHOULDER" in desc or "SPINE" in desc:
            metadata.body_part = "MSK"
        elif "ABDOMEN" in desc or "LIVER" in desc or "PANCREAS" in desc:
            metadata.body_part = "ABDOMEN"
        else:
            metadata.body_part = "CHEST"
    except ImportError:
        metadata.modality = "UNKNOWN"
    except Exception:
        pass
    return metadata


def dcm_to_numpy(data: bytes) -> np.ndarray:
    import pydicom

    ds = pydicom.dcmread(io.BytesIO(data))
    pixel_array = ds.pixel_array.astype(np.float32)
    vmin, vmax = pixel_array.min(), pixel_array.max()
    if vmax > vmin:
        pixel_array = (pixel_array - vmin) / (vmax - vmin)
    return pixel_array


def numpy_to_jpeg_bytes(array: np.ndarray, quality: int = 85) -> bytes:
    arr = np.clip(array, 0.0, 1.0)
    arr = (arr * 255).astype(np.uint8)
    img = Image.fromarray(arr, mode="L")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def process_medical_image(file_bytes: bytes, filename: str) -> tuple:
    ext = Path(filename).suffix.lower()
    metadata = DicomMetadata()
    if ext in [".dcm"]:
        metadata = extract_metadata_from_dicom_bytes(file_bytes)
        image_data = dcm_to_numpy(file_bytes)
    elif ext in [".png", ".jpg", ".jpeg"]:
        metadata.modality = "XR"
        metadata.body_part = "CHEST"
        img = Image.open(io.BytesIO(file_bytes)).convert("L")
        image_data = np.array(img).astype(np.float32) / 255.0
    else:
        raise ValueError(f"Unsupported file format: {ext}")
    return metadata, image_data


# ─── AI Engine (shared with analyze.py) ──────────────────────────────────────


def encode_image_to_base64(image_bytes: bytes) -> str:
    import base64

    return base64.b64encode(image_bytes).decode("utf-8")


def analyze_with_modal_ollama(image_bytes: bytes, prompt: str) -> dict:
    modal_url = os.environ.get("MODAL_OLLAMA_URL", "")
    if not modal_url:
        return {
            "provider": "modal",
            "success": False,
            "error": "MODAL_OLLAMA_URL not configured",
        }
    model = os.environ.get("MODAL_OLLAMA_MODEL", "llava-llama3")
    image_b64 = encode_image_to_base64(image_bytes)
    payload = {
        "model": model,
        "prompt": prompt,
        "images": [image_b64],
        "stream": False,
        "options": {"temperature": 0.3, "top_p": 0.9},
    }
    try:
        with httpx.Client(timeout=60.0) as client:
            response = client.post(
                f"{modal_url.rstrip('/')}/api/generate", json=payload
            )
            response.raise_for_status()
            data = response.json()
            return {
                "provider": "modal",
                "model": model,
                "text": data.get("response", ""),
                "success": True,
            }
    except Exception as e:
        return {"provider": "modal", "success": False, "error": str(e)}


def analyze_with_ollama(image_bytes: bytes, prompt: str) -> dict:
    base_url = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434").rstrip("/")
    model = os.environ.get("OLLAMA_MODEL", "llava-llama3")
    image_b64 = encode_image_to_base64(image_bytes)
    payload = {
        "model": model,
        "prompt": prompt,
        "images": [image_b64],
        "stream": False,
        "options": {"temperature": 0.3, "top_p": 0.9},
    }
    try:
        with httpx.Client(timeout=60.0) as client:
            response = client.post(f"{base_url}/api/generate", json=payload)
            response.raise_for_status()
            data = response.json()
            return {
                "provider": "ollama",
                "model": model,
                "text": data.get("response", ""),
                "success": True,
            }
    except Exception as e:
        return {"provider": "ollama", "success": False, "error": str(e)}


def analyze_with_kimi(image_bytes: bytes, prompt: str) -> dict:
    kimi_key = os.environ.get("KIMI_API_KEY", "")
    if not kimi_key:
        return {
            "provider": "kimi",
            "success": False,
            "error": "KIMI_API_KEY not configured",
        }
    image_b64 = encode_image_to_base64(image_bytes)
    payload = {
        "model": "moonshot-v1-8k",
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
                    },
                    {"type": "text", "text": prompt},
                ],
            }
        ],
        "temperature": 0.3,
    }
    headers = {
        "Authorization": f"Bearer {kimi_key}",
        "Content-Type": "application/json",
    }
    try:
        with httpx.Client(timeout=90.0) as client:
            response = client.post(
                "https://api.moonshot.cn/v1/chat/completions",
                json=payload,
                headers=headers,
            )
            response.raise_for_status()
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            return {
                "provider": "kimi",
                "model": "moonshot-v1-8k",
                "text": content,
                "success": True,
            }
    except Exception as e:
        return {"provider": "kimi", "success": False, "error": str(e)}


def analyze_with_minimax(image_bytes: bytes, prompt: str) -> dict:
    minimax_key = os.environ.get("MINIMAX_API_KEY", "")
    if not minimax_key:
        return {
            "provider": "minimax",
            "success": False,
            "error": "MINIMAX_API_KEY not configured",
        }
    image_b64 = encode_image_to_base64(image_bytes)
    payload = {
        "model": "MiniMax-Text-01",
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
                    },
                    {"type": "text", "text": prompt},
                ],
            }
        ],
        "temperature": 0.3,
    }
    headers = {
        "Authorization": f"Bearer {minimax_key}",
        "Content-Type": "application/json",
    }
    try:
        with httpx.Client(timeout=90.0) as client:
            response = client.post(
                "https://api.minimax.io/v1/text/chatcompletion_v2",
                json=payload,
                headers=headers,
            )
            response.raise_for_status()
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            return {
                "provider": "minimax",
                "model": "MiniMax-Text-01",
                "text": content,
                "success": True,
            }
    except Exception as e:
        return {"provider": "minimax", "success": False, "error": str(e)}


def analyze_image(
    image_bytes: bytes, prompt: str, preferred_provider: str = "modal"
) -> dict:
    order = [preferred_provider]
    others = ["modal", "ollama", "kimi", "minimax"]
    if preferred_provider in others:
        others.remove(preferred_provider)
    order.extend(others)
    last_error = None
    for provider in order:
        if provider == "modal":
            result = analyze_with_modal_ollama(image_bytes, prompt)
        elif provider == "ollama":
            result = analyze_with_ollama(image_bytes, prompt)
        elif provider == "kimi":
            result = analyze_with_kimi(image_bytes, prompt)
        elif provider == "minimax":
            result = analyze_with_minimax(image_bytes, prompt)
        else:
            continue
        if result.get("success"):
            return result
        last_error = result.get("error", "Unknown error")
    return {
        "provider": "none",
        "success": False,
        "error": f"All providers failed. Last error: {last_error}",
    }


# ─── Report Generator ────────────────────────────────────────────────────────

from datetime import datetime

REPORT_TEMPLATE = """RADIOLOGY AI ASSIST REPORT
Generated: {timestamp}
Study Type: {study_type}
Clinical Question: {clinical_question}
AI Provider: {provider} ({model})

{'='*60}
FINDINGS
{'='*60}
{findings}

{'='*60}
INTERPRETATION
{'='*60}
{interpretation}

{'='*60}
DIFFERENTIAL DIAGNOSIS
{'='*60}
{differential}

{'='*60}
AI CONFIDENCE LEVEL: {confidence}
{'='*60}

RECOMMENDATIONS:
{recommendations}

---
DISCLAIMER: This report was generated by an AI assistant and is intended
for educational and research purposes only. It is NOT a certified medical
report and should NOT be used for clinical decision-making without review
by a qualified radiologist.
"""


def _parse_ai_sections(text: str) -> dict:
    sections = {}
    current_section = "raw"
    current_content = []
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("##"):
            if current_content:
                sections[current_section.lower()] = "\n".join(current_content).strip()
            current_section = line.lstrip("#").strip().lower()
            current_content = []
        else:
            current_content.append(line)
    if current_content:
        sections[current_section.lower()] = "\n".join(current_content).strip()
    return sections


def format_clinical_report(
    raw_ai_output: str,
    study_type: str,
    clinical_question: str,
    provider: str,
    model: str,
) -> str:
    sections = _parse_ai_sections(raw_ai_output)
    findings = sections.get("findings", raw_ai_output)
    interpretation = sections.get("interpretation", "See findings above.")
    differential = sections.get(
        "differential diagnosis", sections.get("differential", "Not specified.")
    )
    confidence = sections.get(
        "confidence", sections.get("confidence level", "Not specified.")
    )
    recommendations = sections.get(
        "recommendations", sections.get("recommendation", "None.")
    )
    timestamp = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    return REPORT_TEMPLATE.format(
        timestamp=timestamp,
        study_type=study_type,
        clinical_question=clinical_question,
        provider=provider,
        model=model,
        findings=findings,
        interpretation=interpretation,
        differential=differential,
        confidence=confidence,
        recommendations=recommendations,
    )


# ─── Slice Selector ──────────────────────────────────────────────────────────

CLINICAL_PREFERENCE_MAP = {
    "acl tear": {
        "body_part": "MSK",
        "orientations": ["sagittal", "coronal"],
        "weightings": ["PD", "T2", "STIR"],
        "focus": "Sagittal PD and coronal STIR for ACL visualization",
    },
    "meniscus": {
        "body_part": "MSK",
        "orientations": ["sagittal", "coronal"],
        "weightings": ["PD", "T2"],
        "focus": "Sagittal PD for meniscus body and horns",
    },
    "brain tumor": {
        "body_part": "BRAIN",
        "orientations": ["axial"],
        "weightings": ["T1+C", "T1", "FLAIR", "T2"],
        "focus": "Post-contrast T1 for tumor, FLAIR for edema",
    },
    "stroke": {
        "body_part": "BRAIN",
        "orientations": ["axial"],
        "weightings": ["DWI", "FLAIR", "T2"],
        "focus": "DWI for acute infarct, FLAIR for chronic",
    },
    "cervical spine": {
        "body_part": "SPINE",
        "orientations": ["sagittal", "axial"],
        "weightings": ["T2", "T1"],
        "focus": "Sagittal T2 for cord compression, axial for foraminal stenosis",
    },
    "chest xray": {
        "body_part": "CHEST",
        "orientations": ["PA", "AP", "lateral"],
        "weightings": [],
        "focus": "PA chest radiograph for lungs, heart, mediastinum",
    },
    "lung nodule": {
        "body_part": "CHEST",
        "orientations": ["axial"],
        "weightings": ["thin", "HRCT"],
        "focus": "Thin-slice axial for pulmonary nodules",
    },
    "liver lesion": {
        "body_part": "ABDOMEN",
        "orientations": ["axial"],
        "weightings": ["T1+C", "T2", "DWI"],
        "focus": "Arterial and portal venous phase for lesion characterization",
    },
    "default": {
        "body_part": "CHEST",
        "orientations": ["axial", "sagittal", "coronal"],
        "weightings": [],
        "focus": "Comprehensive review of all available series",
    },
}


def infer_clinical_question_from_tags(tags: list) -> dict:
    combined = " ".join(tags).lower()
    for key, prefs in CLINICAL_PREFERENCE_MAP.items():
        if key == "default":
            continue
        if any(word in combined for word in key.split()):
            return prefs
    return CLINICAL_PREFERENCE_MAP["default"]


def get_ai_prompt_from_clinical_question(clinical_question: str, body_part: str) -> str:
    return f"""You are a board-certified radiologist analyzing a {body_part} medical image.

CLINICAL QUESTION: {clinical_question}

TASK:
1. Describe what you see in this image
2. Identify any abnormal findings
3. Provide a differential diagnosis if applicable
4. Rate your confidence level (High / Medium / Low)
5. Recommend follow-up if needed

IMPORTANT:
- Use professional radiological language
- Be specific about anatomical findings
- If you are uncertain, say so clearly
- Do not overstate findings

Format your response with clear sections:
## Findings
## Interpretation
## Confidence
## Recommendations
"""


def select_slices_for_series(
    series_meta: dict, clinical_pref: dict, max_slices: int = 12
) -> list:
    num_slices = series_meta.get("num_slices", 1)
    if num_slices <= max_slices:
        return list(range(num_slices))
    step = max(1, num_slices // max_slices)
    return list(range(0, num_slices, step))[:max_slices]


# ─── Multipart Parser ────────────────────────────────────────────────────────


def parse_multipart(body: bytes, content_type: str) -> dict:
    result = {}
    boundary = (
        content_type.split("boundary=")[1] if "boundary=" in content_type else None
    )
    if not boundary:
        return result
    boundary_bytes = f"--{boundary}".encode()
    parts = body.split(boundary_bytes)
    for part in parts[1:]:
        if part.startswith(b"--"):
            break
        if b"\r\n\r\n" in part:
            headers, data = part.split(b"\r\n\r\n", 1)
            data = data.rstrip(b"\r\n")
            headers_str = headers.decode("utf-8", errors="ignore")
            name_match = None
            for line in headers_str.split("\r\n"):
                if 'name="' in line:
                    name_match = line.split('name="')[1].split('"')[0]
                    break
            if name_match:
                if 'filename="' in headers_str:
                    filename = headers_str.split('filename="')[1].split('"')[0]
                    result[name_match] = {"filename": filename, "data": data}
                else:
                    result[name_match] = data.decode("utf-8", errors="ignore")
    return result


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


# ─── Vercel Handler ──────────────────────────────────────────────────────────


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            content_type = self.headers.get("Content-Type", "")
            body = self.rfile.read(content_length)

            fields = parse_multipart(body, content_type)

            files = []
            i = 0
            while True:
                key = f"file_{i}" if i > 0 else "file"
                if key in fields and isinstance(fields[key], dict):
                    files.append(fields[key])
                    i += 1
                elif i == 0 and "files" in fields:
                    files.append(fields["files"])
                    i += 1
                else:
                    break

            if not files:
                self.send_error_response(400, {"error": "No files uploaded"})
                return

            clinical_question = fields.get(
                "clinical_question", "Describe what you see in this medical study."
            )
            tags_str = fields.get("tags", "[]")
            preferred_provider = fields.get("preferred_provider", "modal")

            try:
                tags_list = json.loads(tags_str) if tags_str else []
            except json.JSONDecodeError:
                tags_list = []

            clinical_pref = infer_clinical_question_from_tags(
                tags_list + [clinical_question]
            )

            all_metadata = []
            all_images = []

            for file_field in files:
                try:
                    file_bytes = file_field["data"]
                    filename = file_field.get("filename", "study.dcm")
                    metadata, image_data = process_medical_image(file_bytes, filename)
                    all_metadata.append(metadata)
                    all_images.append((metadata, image_data))
                except Exception:
                    continue

            if not all_images:
                self.send_error_response(
                    400, {"error": "No valid images found in study"}
                )
                return

            best_slices = []
            for idx, (meta, img_data) in enumerate(all_images):
                series_meta = {
                    "num_slices": meta.num_slices or 1,
                    "orientation": "",
                    "weighting": meta.series_description,
                    "series_description": meta.series_description,
                }
                selected = select_slices_for_series(
                    series_meta, clinical_pref, max_slices=12
                )
                if selected:
                    best_slices.append((idx, 0))

            best_slices = best_slices[:24]

            prompt = f"""Analyze this medical imaging study.

STUDY INFO:
- Modality: {all_metadata[0].modality or "UNKNOWN"}
- Body Part: {clinical_pref["body_part"]}
- Clinical Question: {clinical_question}
- Number of series: {len(all_metadata)}
- Images being analyzed: {len(best_slices)}

TASK: Provide a comprehensive analysis addressing the clinical question.
Be thorough — you are viewing multiple slices from a study.
"""

            results = []
            for img_idx, _ in best_slices[:6]:
                meta, img_data = all_images[img_idx]
                jpeg_bytes = numpy_to_jpeg_bytes(img_data)
                result = analyze_image(
                    image_bytes=jpeg_bytes,
                    prompt=prompt,
                    preferred_provider=preferred_provider,
                )
                if result.get("success"):
                    results.append(result.get("text", ""))

            combined_analysis = (
                "\n\n---\n\n".join(results) if results else "No successful analysis"
            )

            report = format_clinical_report(
                raw_ai_output=combined_analysis,
                study_type=f"{all_metadata[0].modality or 'MR'} Study",
                clinical_question=clinical_question,
                provider=results[0].get("provider") if results else "none",
                model=results[0].get("model") if results else "",
            )

            request_id = str(uuid.uuid4())[:8]

            response = {
                "request_id": request_id,
                "num_series": len(all_metadata),
                "num_slices_analyzed": len(best_slices),
                "report": report,
                "metadata": [_metadata_to_dict(m) for m in all_metadata[:10]],
                "success": True,
            }

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(response).encode("utf-8"))

        except Exception as e:
            self.send_error_response(500, {"error": str(e)})

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def send_error_response(self, status: int, body: dict):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode("utf-8"))
