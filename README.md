# MRI X Jas Helper

**AI Radiology Second Opinion** — A medical-grade AI assistant for MRI and X-ray analysis.

---

## What is this?

MRI X Jas Helper is a standalone AI tool that helps radiologists and physicians read, analyze, and understand medical imaging (MRI, X-ray, CT) with AI-powered insights. It's designed to be:

- ✅ **Accurate** — Uses vision-language AI models trained on medical imaging
- ✅ **Affordable** — Powered by Ollama (free local), Kimi, and MiniMax APIs
- ✅ **Private** — All processing done locally when using Ollama
- ✅ **Fast** — Quick Scan mode delivers results in under 10 seconds
- ✅ **Separated from AIMS** — This is its own independent application

---

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- Or Node.js 20+ and Python 3.11+ (for manual setup)
- For GPU acceleration: NVIDIA GPU with CUDA (optional)

### Option 1: Docker Compose (Recommended)

```bash
# Clone and start
git clone <repo-url> mri-x-jas-helper
cd mri-x-jas-helper
docker compose up --build

# Frontend: http://localhost:3000
# Backend API: http://localhost:8080
# API Docs: http://localhost:8080/docs
```

### Option 2: Manual Setup

**Backend:**
```bash
cd backend
python -m venv venv && source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
# Add your API keys to .env (copy from .env.example)
uvicorn main:app --reload --port 8080
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev
# Open http://localhost:3000
```

**Ollama (for free local inference):**
```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Pull vision model
ollama pull llava-llama3

# Pull medical-specific model (if available)
ollama pull medllava

# Verify it's running
ollama list
```

---

## Configuration

Create `backend/.env` with your API keys:

```bash
# AI Providers
KIMI_API_KEY=sk-kimi-your-key          # Get from moonshot.cn
MINIMAX_API_KEY=sk-api-your-key         # Get from minimax.io
DEEPGRAM_API_KEY=your-deepgram-key      # Get from deepgram.com

# Ollama (local, free)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llava-llama3

# App
PORT=8080
CORS_ORIGIN=http://localhost:3000
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend (Next.js 14)                                      │
│  React + Tailwind + Cornerstone.js (DICOM viewer)          │
│  http://localhost:3000                                       │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP / REST
┌────────────────────────┴────────────────────────────────────┐
│  Backend (FastAPI)                                           │
│  • /api/analyze      — Image AI analysis                     │
│  • /api/transcribe   — Voice dictation                       │
│  • /api/process-study — Full DICOM study processing         │
│  Port 8080                                                   │
└────────────────────────┬────────────────────────────────────┘
                         │
     ┌───────────────────┼───────────────────────┐
     ▼                   ▼                       ▼
  Ollama            Kimi (API)              MiniMax (API)
  (local GPU)       $0.03/1K tokens         $0.29/1M
     │
     └─► llava-llama3 (vision model)
```

---

## Features

### 🔍 Quick Scan Mode
- Under 10 seconds response time
- Uses Ollama (free, local GPU) when available
- One-paragraph summary of findings

### 🧠 Deep Analysis Mode
- Comprehensive radiological report
- Structured sections: Findings, Interpretation, Differential, Recommendations
- Uses Kimi or MiniMax API

### 🎙️ Voice Dictation
- Record clinical notes with your microphone
- Deepgram Nova 2 Medical transcribes to text
- Text becomes the clinical question for analysis

### 📋 Smart Slice Selection
- For MRI studies with 200+ slices, AI automatically selects the most diagnostically relevant images
- No more sending everything and getting garbage results

### 📊 Multi-Provider Fallback
- If Ollama is offline → auto-switches to Kimi
- If Kimi fails → falls back to MiniMax
- Always at least one AI available

---

## Supported File Formats

| Format | Extension | Notes |
|--------|----------|-------|
| DICOM | `.dcm` | Standard medical imaging |
| NIfTI | `.nii`, `.nii.gz` | MRI volumetric data |
| PNG | `.png` | Chest X-rays, screenshots |
| JPEG | `.jpg`, `.jpeg` | Photos of films, scans |

---

## Deployment on Railway

### Backend
1. Create new Railway project → Provision PostgreSQL (optional)
2. Connect repo or upload `backend/` directory
3. Set environment variables from `.env.example`
4. Railway auto-detects Docker → deploys

### Frontend
1. Create new Railway project
2. Connect repo or upload `frontend/` directory
3. Set `NEXT_PUBLIC_API_URL` to your backend URL
4. Railway uses Nixpacks → deploys automatically

---

## Disclaimer

⚠️ **MRI X Jas Helper is for EDUCATIONAL AND RESEARCH USE ONLY.**

This tool is an AI assistant and is **NOT** a certified medical device. It has not been cleared by the FDA or any regulatory body for clinical diagnosis. All AI-generated analysis must be reviewed by a qualified, licensed radiologist before making any clinical decisions. The developers assume no liability for decisions made based on this tool's output.

---

## License

MIT License — see LICENSE file.
