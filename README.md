# 🏥 MRI X Jas Helper

**AI Radiology Second Opinion** — A medical-grade AI assistant for MRI and X-ray analysis. Accurate, affordable, always-available AI that helps radiologists and physicians work at their best.

> ⚠️ **For Educational and Research Use Only** — Not a certified medical device. All AI analysis must be reviewed by a qualified radiologist.

---

## 🎯 What is this?

MRI X Jas Helper is a standalone SaaS application that sells/packages the best open-source medical imaging AI into a professional, deployable product. It analyzes X-rays and MRI scans using vision-language AI models, generates structured radiological reports, and provides a second opinion for medical professionals.

**No local machine required** — everything runs on cloud GPU infrastructure you control.

---

## 🏗️ Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  USER'S BROWSER                                                    │
│  Next.js 14 (Vercel) — React + Tailwind + Cornerstone.js         │
│  https://mri-x-jas-helper.vercel.app                              │
└─────────────────────────────┬────────────────────────────────────┘
                              │ HTTPS
┌─────────────────────────────┴────────────────────────────────────┐
│  FASTAPI BACKEND (Railway)                                        │
│  • /api/analyze       — Image AI analysis                         │
│  • /api/transcribe    — Voice dictation (Deepgram)               │
│  • /api/process-study — Full DICOM study processing               │
│  • /health            — Provider status                          │
│  Python 3.11 · Uvicorn · Port 8080                               │
└────────┬─────────────────────────────────────┬───────────────────┘
         │                                     │
    ┌────┴────────────────────┐        ┌──────┴──────────────────────┐
    │  MODAL (Cloud GPU)      │        │  CLOUD APIs                │
    │  Ollama on NVIDIA T4/A10│        │  • Kimi (Moonshot) $0.03/1K│
    │  llava-llama3 vision    │        │  • MiniMax $0.29/1M        │
    │  No local machine needed│        │  • Deepgram Nova 2 Med $$.  │
    │  ~$0.30/hr idle=$0      │        └────────────────────────────┘
    └─────────────────────────┘
```

**Stack:**
- **Frontend:** Next.js 14, React, Tailwind CSS, Cornerstone.js (DICOM viewer)
- **Backend:** FastAPI (Python 3.11), Uvicorn
- **AI Inference:** Modal (cloud GPU Ollama), Kimi API, MiniMax API
- **Transcription:** Deepgram Nova 2 Medical
- **Deployment:** Vercel (frontend), Railway (backend), Modal (AI GPU)

---

## ⚡ Quick Start (5 Minutes)

### Step 1 — Deploy Modal AI (Cloud GPU)

```bash
# Install Modal CLI
pip install modal
modal setup   # One-time, links your account (get $15 free credits)

# Navigate to backend and deploy Ollama on Modal GPU
cd backend
modal deploy modal_ollama.py

# Modal will give you a URL like:
# https://mri-x-jas-helper-ollama-xxx.modal.run
# COPY THIS — you'll need it for Step 2
```

**Modal Cost:** ~$0.30/hr GPU (T4). Idle = $0. Free tier: 2 hours GPU/month + $15 credits.

---

### Step 2 — Deploy Backend (Railway)

```bash
# Go to https://railway.app
# 1. Click "New Project" → "Deploy from GitHub repo"
# 2. Connect your GitHub: github.com/Pablodd1/mri-x-jas-helper
# 3. Select the "backend" directory
# 4. Add these Environment Variables:

MODAL_OLLAMA_URL=https://your-modal-app.modal.run   # ← from Step 1
MODAL_OLLAMA_MODEL=llava-llama3
KIMI_API_KEY=sk-kimi-...          # Optional, for fallback
MINIMAX_API_KEY=sk-api-...        # Optional, for fallback
DEEPGRAM_API_KEY=...              # Optional, for voice
PORT=8080
CORS_ORIGIN=https://mri-x-jas-helper.vercel.app

# Railway auto-detects Dockerfile → deploys
# Copy the deployed URL: https://mri-x-jas-helper.up.railway.app
```

---

### Step 3 — Deploy Frontend (Vercel)

```bash
# Go to https://vercel.com
# 1. Click "New Project" → Import "mri-x-jas-helper" repo
# 2. Set root directory to: frontend/
# 3. Add Environment Variable:
NEXT_PUBLIC_API_URL=https://your-railway-backend.up.railway.app

# Click Deploy — done in ~2 minutes
# Your app is live at: https://mri-x-jas-helper.vercel.app
```

---

### Step 4 — (Optional) Custom Domain

Point your domain (e.g., `ai.medicalbillingmb.com`) to Vercel for a professional URL.

---

## 💰 Monthly Cost Estimate

| Service | Plan | Cost |
|---------|------|------|
| Vercel | Hobby (free) | **$0** |
| Railway | Starter | **$5-7/mo** |
| Modal GPU | Pay-as-you-go | **~$20-40/mo** (if running 24/7) |
| Kimi API | Pay-per-use | **~$5-15/mo** (depends on usage) |
| Deepgram | Pay-per-use | **~$2-5/mo** |
| **Total** | | **~$32-65/month** |

> 💡 **Tip:** Modal GPU can scale to zero when idle. Average radiology practice using ~50 scans/day pays ~$20-30/mo for Modal. You can price your SaaS at $49-199/mo per seat and profit.

---

## 🔧 Configuration

### Environment Variables

**Backend (Railway):**
```bash
# AI Providers
MODAL_OLLAMA_URL=https://your-modal-app.modal.run   # REQUIRED for cloud deployment
MODAL_OLLAMA_MODEL=llava-llama3
OLLAMA_BASE_URL=http://localhost:11434              # For local dev only
KIMI_API_KEY=sk-kimi-...                           # Optional
MINIMAX_API_KEY=sk-api-...                         # Optional
DEEPGRAM_API_KEY=...                               # Optional

# App
PORT=8080
CORS_ORIGIN=https://your-frontend.vercel.app
SESSION_SECRET=your-random-secret-here
```

**Frontend (Vercel):**
```bash
NEXT_PUBLIC_API_URL=https://your-railway-backend.up.railway.app
```

---

## 📡 API Reference

### `POST /api/analyze`
Upload a medical image and get AI analysis.

```bash
curl -X POST https://your-backend.up.railway.app/api/analyze \
  -F "file=@xray.jpg" \
  -F "clinical_question=General chest X-ray review" \
  -F "mode=deep_analysis" \
  -F "preferred_provider=modal"
```

### `POST /api/transcribe`
Transcribe voice dictation.

```bash
curl -X POST https://your-backend.up.railway.app/api/transcribe \
  -F "audio=@recording.webm"
```

### `POST /api/process-study`
Process a full DICOM study with smart slice selection.

```bash
curl -X POST https://your-backend.up.railway.app/api/process-study \
  -F "files=@slice1.dcm" -F "files=@slice2.dcm" \
  -F "clinical_question=ACL tear evaluation" \
  -F "preferred_provider=modal"
```

### `GET /health`
Check API health and available providers.

```bash
curl https://your-backend.up.railway.app/health
```

---

## 🤖 AI Providers

| Provider | Type | Cost | Best For |
|----------|------|------|----------|
| **Modal Ollama** | Cloud GPU | ~$0.30/hr | **Recommended** — no local machine, reliable |
| **Local Ollama** | Self-hosted GPU | Free | Self-hosters with own GPU |
| **Kimi (Moonshot)** | API | ~$0.03/1K tokens | Report generation, fallback |
| **MiniMax** | API | ~$0.29/1M tokens | Cheap batch analysis |

**Fallback Chain:** Modal → Local Ollama → Kimi → MiniMax (automatic)

---

## 📁 Supported File Formats

| Format | Extension | Notes |
|--------|----------|-------|
| DICOM | `.dcm` | Standard for MRI, CT, X-ray |
| NIfTI | `.nii`, `.nii.gz` | MRI volumetric data |
| PNG | `.png` | Chest X-rays, photos of films |
| JPEG | `.jpg`, `.jpeg` | Scanned films, screenshots |

---

## 🔒 Privacy & Security

- DICOM/images processed in-browser on frontend — no unnecessary uploads
- When sent to backend: HTTPS encrypted in transit
- Modal Ollama: your data stays on Modal's GPU servers (they don't train on it)
- Kimi/MiniMax/Deepgram: review each provider's data policy before use with patient data
- **No patient data stored permanently** on any server

---

## 🔧 Troubleshooting

### "Modal Ollama endpoint not reachable"
```bash
# Check your Modal deployment is running
modal app list

# If not, redeploy
modal deploy backend/modal_ollama.py

# Verify the URL matches MODAL_OLLAMA_URL in Railway
```

### "Transcription failed"
```bash
# Verify Deepgram key is set in Railway
DEEPGRAM_API_KEY=your-real-key
```

### Backend won't start on Railway
```bash
# Check Railway logs:
railway logs --project your-project

# Common issues:
# - Missing MODAL_OLLAMA_URL (required)
# - PORT not set (should be 8080)
# - CORS origin mismatch
```

---

## 📁 Project Structure

```
mri-x-jas-helper/
├── backend/
│   ├── main.py              # FastAPI app — API endpoints
│   ├── config.py            # Environment configuration
│   ├── requirements.txt    # Python dependencies
│   ├── Dockerfile          # Railway container
│   ├── modal_ollama.py     # Modal GPU deployment script
│   └── services/
│       ├── ai_engine.py     # Multi-provider AI orchestrator
│       ├── dicom_parser.py  # DICOM/NIfTI/PNG/JPG processor
│       ├── slice_selector.py # Smart slice selection
│       └── report_generator.py # Clinical report formatter
├── frontend/
│   ├── app/
│   │   ├── page.tsx        # Main UI (drop zone, analysis, report)
│   │   ├── layout.tsx      # Root layout with fonts
│   │   └── globals.css     # Tailwind + custom styles
│   ├── package.json
│   ├── Dockerfile          # Multi-stage Next.js build
│   └── railway.json        # Railway Nixpacks config
├── docker-compose.yml      # Local dev with Ollama + GPU
├── scripts/
│   └── setup-ollama.sh     # Pull models for local dev
├── SPEC.md                 # Product specification
└── README.md               # This file
```

---

## 🚀 Roadmap

- [ ] **v1.1** — PDF report export
- [ ] **v1.2** — User auth (per-seat licensing)
- [ ] **v2.0** — Multi-plane MRI MPR (3D reconstruction)
- [ ] **v2.0** — Prior study comparison
- [ ] **v2.0** — MONAI model integration (segmentation)
- [ ] **v2.1** — CT support
- [ ] **v2.2** — Mobile app (React Native)
- [ ] **v3.0** — FDA 510(k) clearance pathway (consultation)

---

## ⚖️ Disclaimer

**MRI X Jas Helper is for EDUCATIONAL AND RESEARCH USE ONLY.**

This tool is an AI assistant and is **NOT** a certified medical device. It has not been cleared or approved by the FDA, EMA, or any other regulatory body for clinical diagnosis or treatment decisions. Use of this tool for clinical decision-making without review by a qualified, licensed radiologist is at the user's own risk.

The developers of this software make no representations or warranties of any kind, express or implied, regarding the accuracy, reliability, or appropriateness of the analysis provided by this tool. In no event shall the developers be liable for any damages arising from the use of this tool.

---

## 📄 License

MIT License — see [LICENSE](./LICENSE)

---

## 🔗 Key Links

- **GitHub:** github.com/Pablodd1/mri-x-jas-helper
- **Modal:** modal.com (cloud GPU)
- **Railway:** railway.app (backend hosting)
- **Vercel:** vercel.com (frontend hosting)
- **Deepgram:** console.deepgram.com (transcription)
- **Kimi API:** moonshot.cn (language model)
