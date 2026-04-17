# MRI X Jas Helper — Product Specification

## 1. Concept & Vision

A **medical-grade AI radiology assistant** that helps MRI and X-ray doctors read, analyze, and diagnose faster and more accurately. Think of it as a second-pair-of-eyes AI that never gets tired, works 24/7, and costs a fraction of traditional medical AI software.

**Core promise:** Affordable, accurate, always-available AI that actually helps radiologists — not a toy demo, not a $50K/year enterprise tool.

**Tagline:** *"Your AI Radiology Second Opinion"*

---

## 2. Design Language

**Aesthetic:** Clinical Modern — clean, trustworthy, precise. Not cold/sterile, but warm-clinical. Think Apple Health meets modern hospital dashboard.

**Colors:**
- Primary: `#0F766E` (medical teal — trust, health)
- Secondary: `#1E293B` (slate dark — professional)
- Accent: `#F59E0B` (amber — attention, warnings)
- Success: `#10B981` (emerald)
- Danger: `#EF4444` (red)
- Background: `#F8FAFC` (off-white)
- Surface: `#FFFFFF`
- Text: `#0F172A`

**Typography:**
- Headings: Inter (700, 600)
- Body: Inter (400, 500)
- Monospace/measurements: JetBrains Mono

**Motion:** Subtle and purposeful — 200ms ease transitions, no bouncy/playful animations. This is medical software.

---

## 3. Tech Stack

### Frontend
- **Next.js 14** (App Router) — modern React, SSR, API routes
- **TypeScript** — strict mode
- **Tailwind CSS** + Radix UI primitives
- **Cornerstone.js** — DICOM rendering and viewing (web-based medical imaging standard)
- **@cornerstonejs/tools** — window/level, pan, zoom, measurement tools
- **shadcn/ui** — accessible component primitives

### Backend
- **FastAPI** (Python 3.11+) — async API server
- **Uvicorn** — ASGI server
- **pydicom** — DICOM file parsing
- **nibabel** — NIfTI format (MRI) support
- **MONAI** — medical image inference (segmentation, classification)
- **TorchIO** — MRI preprocessing and augmentation
- **ONNX Runtime** — fast CPU/GPU inference for deployed models
- **llava-llama3** or **MedLLaVA** — medical VQA (vision-language)

### AI Providers (tiered, user picks)
| Provider | Use Case | Cost |
|---|---|---|
| **Ollama (local)** | Free, no internet, privacy-first | Free (local) |
| **Kimi (Moonshot)** | Report generation, findings explanation | ~$0.03/1K tokens |
| **MiniMax** | Fast analysis, second opinions | ~$0.29/1M in |
| **Deepgram Nova 2 Medical** | Voice-to-text clinical notes | ~$0.0043/min |

### Deployment
- **Railway** — same as AIMS (already paying for it)
- Frontend: Next.js (Nixpacks, Node 20)
- Backend: FastAPI (Docker, Python 3.11)
- Storage: Railway Postgres (metadata), S3/R2 (DICOM files)

---

## 4. Core Features

### 4.1 DICOM / X-Ray Upload & Viewing
- Drag-and-drop DICOM files, folders, or ZIP archives
- Supports: `.dcm`, `.nii`, `.nii.gz`, `.png`, `.jpg`
- Multi-plane viewer (axial, sagittal, coronal) for MRI
- Standard tools: Window/Level, Zoom, Pan, Measure, Annotate
- 1×1, 2×2, MPR layouts

### 4.2 AI Analysis Engine
**Three modes:**
1. **Quick Scan** — fast overall assessment, < 10 seconds, free with Ollama
2. **Deep Analysis** — comprehensive reading with Kimi/MiniMax report, < 60 seconds
3. **Voice Report** — dictation + AI correction with Deepgram + Kimi

**AI reads for:**
- Pathology detection (trained on public datasets: ChestX-ray14, MIMIC, fastMRI)
- Anatomical landmark identification
- Comparison with priors (if prior study uploaded)
- Uncertainty flagging ("AI uncertain about...")

### 4.3 Smart Slice Selection (from DICOMassist)
For MRI with 200+ slices: AI automatically selects the most diagnostically relevant series, orientation, and slice range based on the clinical question asked.

### 4.4 Structured Report Generation
- AI generates findings in clinical language
- Differential diagnosis with probability estimates
- Recommended follow-up
- Editable before finalizing

### 4.5 Multi-Provider Fallback
- If Ollama is offline → auto-switch to Kimi API
- If Kimi fails → fall back to MiniMax
- Always at least one AI available

---

## 5. Data Flow

```
User uploads DICOM/images
        ↓
  Frontend (Next.js)
        ↓ [DICOM metadata + clinical question]
  Backend (FastAPI)
        ↓
  ┌─────────────────────────────────┐
  │ Step 1: DICOM Parser            │
  │ (extract metadata, validate)     │
  └──────────────┬──────────────────┘
                 ↓
  ┌─────────────────────────────────┐
  │ Step 2: Smart Slice Selector     │
  │ (from clinical question, pick    │
  │  optimal series + slices)        │
  └──────────────┬──────────────────┘
                 ↓
  ┌─────────────────────────────────┐
  │ Step 3: MONAI / LLaVA Inference │
  │ (local model or Ollama)          │
  └──────────────┬──────────────────┘
                 ↓
  ┌─────────────────────────────────┐
  │ Step 4: LLM Report Generator     │
  │ (Kimi/MiniMax → clinical report) │
  └──────────────┬──────────────────┘
                 ↓
  Frontend displays: Viewer + AI findings + Report
```

---

## 6. Deployment Architecture (Railway)

```
┌─────────────────────────────────────────────────────┐
│  Frontend (Next.js)                                 │
│  → https://mri-x-jas-helper.up.railway.app          │
│  Port 3000, Nixpacks (nodejs_20)                    │
└──────────────────────┬──────────────────────────────┘
                       ↓
┌──────────────────────┴──────────────────────────────┐
│  Backend (FastAPI)                                 │
│  → https://mri-x-jas-helper-api.up.railway.app    │
│  Port 8080, Docker (python:3.11-slim)             │
└──────────────────────┬──────────────────────────────┘
                       ↓
┌──────────────────────┴──────────────────────────────┐
│  Ollama (optional, local GPU)                       │
│  → Run on same Railway instance or local machine   │
│  → Models: medllava, llava-llama3, monai-core      │
└─────────────────────────────────────────────────────┘
```

---

## 7. AI Provider Configuration

### Environment Variables (Railway)
```
# AI Providers (at least one required)
OLLAMA_BASE_URL=http://localhost:11434          # Local Ollama
KIMI_API_KEY=sk-kimi-...                        # Moonshot Kimi
MINIMAX_API_KEY=sk-api-REEt8...                 # MiniMax
DEEPGRAM_API_KEY=...                            # Voice transcription

# Storage
DATABASE_URL=postgresql://...                   # Railway Postgres
AWS_ACCESS_KEY_ID=...                           # S3/R2 for DICOM storage
AWS_SECRET_ACCESS_KEY=...
AWS_S3_BUCKET=mri-x-jas-helper
AWS_REGION=us-east-1

# App
NODE_ENV=production
SESSION_SECRET=...
PORT=8080
CORS_ORIGIN=https://mri-x-jas-helper.up.railway.app
```

---

## 8. MVP Scope (v1.0)

**In scope:**
- ✅ PNG/JPG X-ray upload + AI analysis
- ✅ DICOM upload + basic viewing (Cornerstone.js)
- ✅ Quick Scan with Ollama (free, local)
- ✅ Deep Analysis with Kimi API
- ✅ Structured report output
- ✅ Voice dictation (Deepgram + Kimi)

**Out of scope for v1:**
- ❌ Multi-plane MRI MPR (v2)
- ❌ Prior study comparison (v2)
- ❌ MONAI model training (cloud-hosted models only v1)
- ❌ PDF export (v1.1)
- ❌ User accounts / auth (v1.1)

---

## 9. Privacy & Compliance

- All DICOM data processed in-browser when possible
- When sent to API: encrypted in transit (HTTPS/WSS)
- No data stored permanently on server — files processed then discarded
- **EDUCATIONAL / RESEARCH USE ONLY** disclaimer (like Chester-Xray, DICOMassist)
- Not FDA cleared — clearly labeled as "AI assistant, not a certified medical device"

---

## 10. Repository

```
mri-x-jas-helper/
├── frontend/              # Next.js app
│   ├── app/
│   ├── components/
│   ├── lib/
│   └── package.json
├── backend/               # FastAPI app
│   ├── main.py
│   ├── routers/
│   ├── services/
│   │   ├── ai_engine.py
│   │   ├── dicom_parser.py
│   │   ├── slice_selector.py
│   │   └── report_generator.py
│   ├── models/            # ONNX models go here
│   ├── requirements.txt
│   └── Dockerfile
├── docker-compose.yml     # Local dev
├── Railway.json           # Railway deploy config
└── SPEC.md
```
