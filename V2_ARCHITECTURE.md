# AIMS Vision Pro — v2 Architecture & Implementation Plan

**Status:** Specification complete. Ready for implementation.
**Stack:** Python 3.11+ / FastAPI / SQLAlchemy 2.0 / Supabase / Google Document AI / Resend
**Target:** Replace current Express.js `server.js` (1,420 lines) with modular Python backend + new frontend.

---

## 1. ACR-Style Prompt Template

**File:** `backend/services/slice_selector.py` (NEW)

Replaces the old `get_ai_prompt_from_clinical_question(clinical_question, body_part)` with an ACR-style template.

**New signature:**

```python
def get_ai_prompt_from_clinical_question(
    clinical_question: str,
    body_part: str,
    modality_and_views: str = "",
    age_sex: str = "",
    clinical_history: str = "",
    priors: str = "None available",
) -> str:
```

**Prompt structure:**
```
# ROLE → # CASE → # TASK → # OUTPUT FORMAT → # RULES → # MANDATORY DISCLAIMER
```

**Output format** (four ACR-style headers):
- `## Findings`
- `## Interpretation`
- `## Confidence`
- `## Recommendations`

A module constant `MANDATORY_DISCLAIMER` is exported and re-used by the merger and PDF footer.

---

## 2. QA-Audit Pipeline — Multi-Agent

**File:** `backend/services/multi_agent.py` (NEW)

Replaces single-shot `analyze_image()` with Drafter → 2 parallel critics → deterministic Merger.

| Agent | Role | Prompt |
|-------|------|--------|
| **Drafter** | Primary report writer | Uses `slice_selector.get_ai_prompt_from_clinical_question(...)` |
| **Critic A** | Image-fidelity | `CRITIC_A_PROMPT` — claims unsupported by image, findings missed |
| **Critic B** | Clinical-coherence | `CRITIC_B_PROMPT` — contradictions, hedging mismatches, missing negatives, wrong ICD-10s |

Critics run in `asyncio.gather` — latency = one critic call, not two.

**Merger (Python, deterministic):**
- `_has_real_issues()` checks for non-`- none` bullets
- Only if both critics flag issues → drafter revises against both critique lists
- `_ensure_headers_and_disclaimer()` re-attaches any missing headers + disclaimer

**Returns:** `MultiAgentReport` dataclass
```python
@dataclass
class MultiAgentReport:
    final_report: str
    drafter: str
    critic_a: str
    critic_b: str
    revised: bool
    qa_audit_summary: str
    raw_critiques: dict
```

**Public-facing label:** "Quality Assurance Audit" — only string the doctor sees.

---

## 3. Multi-Modality Entry Point

**File:** `backend/main.py` — rewritten as thin app-bootstrap.

**New routers:**
- `routers/codes.py`
- `routers/ocr.py`
- `routers/reports.py`

**`POST /api/analyze`** → drives `multi_agent.run_pipeline(...)`:

```python
class AnalyzeResponse(BaseModel):
    request_id: str
    final_report: str
    qa_audit_summary: str
    revised: bool
    icd10_candidates: list
    metadata: dict
    drafter_provider: str
    success: bool
    error: str | None = None
```

**New form fields accepted (all optional):**
- `modality_and_views`
- `age_sex`
- `clinical_history`
- `priors`
- `preferred_provider`

**ICD-10 integration:** `medical_codes.suggest_from_findings(final_report)` auto-appended.

**Auth:** Every endpoint gated by `Depends(current_doctor)` (Supabase JWT or open-mode).

**`/health`** reports providers and integrations (DocAI, Supabase, Resend, DB).

**CORS:** Honors `settings.cors_origin` instead of `["*"]`.

---

## 4. ICD-10-CM Lookup

**File:** `backend/services/medical_codes.py` (NEW)

| Function | Description |
|----------|-------------|
| `search(query, limit=10)` | Token-overlap scoring (coverage 70%, specificity 30%) |
| `suggest_from_findings(text, limit=8)` | Splits on sentences, searches per fragment, dedupes by code |

Returns the originating sentence under `matched`.

**Data source:**
- `backend/data/icd10cm-2025.json` if present
- Otherwise: curated `_BOOTSTRAP` list of ~30 codes (`J18.*`, `S83.*`, `M54.*`, `C34.90` …)

**Build script:** `scripts/build-icd10.sh` (NEW) — downloads CMS 2025 tabular ZIP, extracts, converts to JSON.

**Endpoint:** `GET /api/codes/search?q=...&limit=...` (router `routers/codes.py`).

---

## 5. OCR for Prescriptions

**File:** `backend/services/ocr.py` (NEW)

Google Document AI client.

**Required env vars:**
- `GOOGLE_DOCAI_PROJECT_ID`
- `GOOGLE_DOCAI_LOCATION`
- `GOOGLE_DOCAI_PROCESSOR_ID`
- `GOOGLE_APPLICATION_CREDENTIALS` (service account)

**Function:** `extract_prescription(image_bytes, mime_type) → OCRResult`

```python
@dataclass
class OCRResult:
    success: bool
    raw_text: str | None = None
    patient_name: str | None = None
    dob: str | None = None
    rx_list: list[str] | None = None
    allergies: str | None = None
    provider: str | None = None
    error: str | None = None
```

**Post-DocAI parsing** (`_parse_structured()`) — regex extraction:
- `Patient: …` → patient_name
- DOB patterns
- Allergy lines
- Rx lines (`Drug 500 mg q8h`)

Graceful fallback: if SDK/env not configured → `success=False` with clear error string.

**Endpoint:** `POST /api/ocr/prescription` (router `routers/ocr.py`).

---

## 6. Auth

**File:** `backend/services/auth.py` (NEW)

**`current_doctor()`** — FastAPI dependency returning a `Doctor` dataclass:

```python
@dataclass
class Doctor:
    id: str
    email: str
    name: str | None = None
    role: str = "doctor"
```

**Validation:**
- Supabase JWT (HS256, audience `authenticated`)
- Secret from `SUPABASE_JWT_SECRET` env var

**Open mode** (dev/smoke tests):
- If `SUPABASE_JWT_SECRET` is empty → every request gets `Doctor(id="open-mode", email="dev@local")`

**Token format:** `Authorization: Bearer <jwt>`

---

## 7. Reports Persistence

**File:** `backend/services/reports_store.py` (NEW)

SQLAlchemy 2.0 models:

| Table | Purpose |
|-------|---------|
| `reports` | One row per radiology report |
| `report_revisions` | Every doctor edit; signed reports immutable |
| `audit_log` | State transitions: created, edited, signed, downloaded, emailed |

**Helpers:**
- `create_report(...)` → writes Report + AuditLog(created)
- `update_report(rid, ...)` → rejects if status == "signed"
- `sign_report(rid, signature=...)` → status → "signed", writes AuditLog
- `get_report(rid)`
- `log_event(rid, event=..., detail=...)`

**Database:** `DATABASE_URL` falls back to `sqlite:///./mri_x_jas_helper.db` — works on first boot without Postgres. SQLAlchemy auto-creates schema.

---

## 8. PDF + Email

**Files:** `backend/services/pdf_export.py`, `backend/services/email_send.py` (NEW)

### PDF Export — `render_pdf(report)`
1. Renders HTML via Jinja-style `.format()` with patient meta, report body, ICD-10 list, QA-Audit summary, signature block, disclaimer footer
2. **WeasyPrint** first
3. **ReportLab** fallback (if system libs missing)
4. **Hand-rolled minimal PDF** (`_tiny_text_pdf`) — last-ditch so `/pdf` never 500s

### Email Send — `send_signed_report(...)`
- HTTPS POST to `https://api.resend.com/emails`
- PDF as base64 attachment
- If `RESEND_API_KEY` missing → `{"success": False, "error": "RESEND_API_KEY not configured"}` (recorded as audit event)

---

## 9. Routers

**Files:** `backend/routers/codes.py`, `backend/routers/ocr.py`, `backend/routers/reports.py` (NEW)

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| `GET` | `/api/codes/search?q=…&limit=…` | ICD-10 lookup | Open |
| `POST` | `/api/ocr/prescription` | OCR a prescription photo | Doctor |
| `POST` | `/api/reports` | Create draft from analyze response | Doctor |
| `GET` | `/api/reports/{id}` | Read report | Doctor |
| `PATCH` | `/api/reports/{id}` | Edit (409 if signed) | Doctor |
| `POST` | `/api/reports/{id}/sign` | Lock + audit | Doctor |
| `GET` | `/api/reports/{id}/pdf` | Download PDF | Doctor |
| `POST` | `/api/reports/{id}/email` | Email signed PDF | Doctor |

---

## 10. Config / Requirements / Docker

### `backend/config.py`
Adds `google_docai_*`, `supabase_*`, `database_url`, `resend_*`. All default to empty strings.

### `backend/.env.example` — fully redocumented

**Sections:** AI providers, OCR, Auth, Reports DB, Email, S3, App.

### `backend/requirements.txt`
```
SQLAlchemy==2.0.30
psycopg[binary]==3.1.18
PyJWT==2.8.0
google-cloud-documentai==2.27.0
weasyprint==62.3
reportlab==4.1.0
Jinja2==3.1.4
pytest==8.2.0
pytest-asyncio==0.23.6
```
(Resend uses plain HTTPS, no SDK.)

### `backend/Dockerfile`
WeasyPrint runtime libs: `libcairo2`, `libpango-1.0-0`, `libpangocairo-1.0-0`, `libgdk-pixbuf-2.0-0`, `libffi8`, `shared-mime-info`, `fonts-dejavu`.

---

## 11. Frontend — 4-Step Doctor Workflow

### Files (all NEW)

| File | Purpose |
|------|---------|
| `frontend/public/landing.html` | Marketing site. Feature card for "Quality Assurance Audit." FAQ truthfully describes multimodal foundation models. Footer links to disclaimer. |
| `frontend/public/app.html` | 4-step tabset for the doctor workflow |
| `frontend/public/app.js` | Single module: `fetchJSON()` helper, per-step controllers, JWT from localStorage |
| `frontend/public/auth.html` | Supabase magic-link sign-in. Falls back to open mode if no `SUPABASE_URL`. |
| `frontend/public/index.html` | Replaced with redirect shim to `/landing.html`. |

### 4 Steps

| Step | Tab | Actions |
|------|-----|---------|
| **Intake** | File picker → `POST /api/ocr/prescription` → editable patient/DOB/allergies/Rx list | |
| **Imaging** | File + clinical question + modality/views + age/sex + history + priors + provider → `POST /api/analyze` | |
| **Review & Code** | Editable report textarea, ICD-10 candidates (top 3 pre-checked), `/api/codes/search` typeahead, manual chips, Save draft → `POST/PATCH /api/reports` | |
| **Sign & Send** | Typed signature → `POST /api/reports/{id}/sign`. Buttons: Download PDF, Email, Copy text. | |

### `frontend/vercel.json`
```json
{
  "rewrites": [
    {"source": "/", "destination": "/landing.html"},
    {"source": "/app", "destination": "/app.html"},
    {"source": "/login", "destination": "/auth.html"}
  ],
  "cleanUrls": true
}
```

---

## 12. Documentation

| File | Status | Content |
|------|--------|---------|
| `README.md` | Rewrite | Doctor workflow, what's in the box, public-facing names vs. implementation, env-var minimum-to-boot, deploy targets, disclaimer |
| `SETUP_GUIDE.md` | Expanded | Google DocAI, Supabase, Resend sections; full GitHub Secrets table |
| `LANDING_COPY.md` | NEW | Source of truth for marketing copy. Internal note mapping "Quality Assurance Audit" → drafter + 2 critics + merger. Legal reviews this file without reading HTML. |

---

## 13. Tests & CI

### `backend/tests/test_smoke.py` (NEW) — 9 cases

1. Prompt template contains all four ACR headers, disclaimer, substituted clinical question + age/sex
2. `_has_real_issues()` distinguishes `- none` from real bullets
3. `_ensure_headers_and_disclaimer()` re-attaches missing headers
4. `medical_codes.search("pneumonia")` returns `J18.*` candidates
5. `medical_codes.search("")` returns `[]`
6. `GET /health` returns providers + integrations dicts
7. `GET /api/codes/search?q=pneumonia` returns `J18.*`
8. `POST /api/analyze` with no provider keys → `success=False`, structured error (no 500)
9. Full report cycle: POST → PATCH → POST /sign → PATCH returns 409 → GET /pdf returns bytes starting with `%PDF`

### `.github/workflows/deploy-backend.yml`
- New **test job:** `pytest tests/test_smoke.py` against Python 3.11 + SQLite `DATABASE_URL`
- Railway deploy job now requires test passing
- Passthroughs: `GOOGLE_*`, `SUPABASE_*`, `DATABASE_URL`, `RESEND_*`, `CORS_ORIGIN`

---

## 14. Risks & Notes

| Risk | Mitigation |
|------|-----------|
| **"Quality Assurance Audit" naming** | Architecture truthfully disclosed in `LANDING_COPY.md`, README, FAQ, report footer, and `/health`. If counsel pushes back, only the feature card + QA-Audit banner in `landing.html` need to change. |
| **All-in-one PR** | If review surfaces issues, safest split: prompt + landing + critics → OCR + ICD lookup → auth + sign-off + PDF/email |
| **CPT codes out of scope** | AMA license required. ICD-10-CM only. |
| **Slow first-load for gemma4** | 9.6GB, ~5 min. Use llama3.1:8b for demos. |
| **WeasyPrint system deps** | Dockerfile includes them. Dev machines: `apt install libcairo2 libpango-1.0-0 ...` or fall through to ReportLab. |

---

## Production Cutover Checklist

1. Merge v2 branch to `main`
2. Populate Railway secrets per `SETUP_GUIDE.md`
3. Run `scripts/build-icd10.sh` once on the host
4. Smoke test end-to-end before announcing
5. Verify `/health` shows all providers green
