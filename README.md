# AIMS VISION PRO

**Local AI-Powered Radiology Workstation** — Prescription-to-Report pipeline with multi-agent verification.

Runs entirely on your machine using local LLMs (Ollama). Zero API costs. All data stays local.

---

## Features

### 5-Step Clinical Workflow

| Step | Name | Description |
|------|------|-------------|
| 1 | **Prescription Capture** | Upload or photograph a referral order. AI (llava:13b) extracts exam type, body region, clinical indication, suspected diagnosis, urgency, contrast requirements. |
| 2 | **Review & Confirm** | AI-extracted data is pre-filled. Doctor reviews and corrects before locking in. |
| 3 | **Multi-Image Upload** | Upload MRI slices or X-ray series (up to 50 files, 100MB each). Each image is analyzed by llava:13b with prescription context. |
| 4 | **AI Analysis + Correlation** | AI findings displayed per image. RAG searches ACR Appropriateness Criteria from Supabase pgvector. Correlation engine compares prescription vs image findings — flags agreements, discrepancies, missed issues. |
| 5 | **Medical Note Generation** | Doctor dictates via voice (Web Speech API) or types notes. AI generates a structured radiology report combining: prescription + image findings + correlation + ACR criteria + doctor's notes. |

### 3-Agent Verification System

```
Agent 1 → Primary Radiologist (llama3.1:8b) → Writes full report
Agent 2 → Specialist Fact-Checker (llama3.1:8b) → Ortho/Pulmonary peer review
Agent 3 → Clinical Accuracy Expert (qwen2.5-medical) → Guidelines & terminology check
Agent 1 → Chief of Radiology → Synthesizes FINAL VERIFIED REPORT
```

### Demo Mode

Two pre-loaded mock cases ready to run with one click:
- **🦵 Knee MRI** — 35yo soccer player, bucket-handle medial meniscus tear + ACL rupture (3 MRI slices)
- **🫁 Chest X-Ray** — 62yo female smoker, RLL community-acquired pneumonia with COPD (2 views)

### Additional Capabilities

- **Voice dictation** — browser-native speech-to-text for doctor's notes
- **Printable reports** — formatted medical document with all findings, ready for patient record
- **Prompt administration** — customizable report templates and system prompts
- **Session memory** — 30-minute session persistence across workflow steps
- **Supabase integration** — reports saved to `lab_reports` table, RAG queries from `medical_knowledge_chunks`
- **Camera capture** — photograph paper prescriptions directly from phone/laptop camera

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    AIMS VISION PRO                    │
├──────────┬──────────┬──────────┬─────────────────────┤
│  Vision  │   RAG    │   Chat   │    Verification     │
│ llava:13b│ bge-m3   │llama3.1  │   3-Agent Pipeline  │
│          │          │  gemma4  │                     │
├──────────┴──────────┴──────────┴─────────────────────┤
│              Supabase (pgvector)                      │
│    medical_knowledge_chunks  │  lab_reports          │
└──────────────────────────────────────────────────────┘
```

**Models used:**
| Model | Size | Role |
|-------|------|------|
| `llava:13b` | 8.0 GB | Vision — image analysis |
| `bge-m3:latest` | 1.2 GB | Embeddings — RAG search |
| `llama3.1:8b` | 4.9 GB | Chat — reports, correlation |
| `qwen2.5-medical:latest` | 4.7 GB | Chat — clinical verification |
| `gemma4:latest` | 9.6 GB | Chat — final synthesis (optional) |

---

## Quick Start

### Prerequisites

- [Ollama](https://ollama.com) installed
- Node.js 18+
- Supabase project with pgvector (or use mock mode)

### Pull Models

```bash
ollama pull llava:13b
ollama pull bge-m3:latest
ollama pull llama3.1:8b
ollama pull qwen2.5-medical:latest
ollama pull gemma4:latest
```

### Pre-load models for speed (optional)

```bash
# Run each briefly to keep model in GPU memory:
ollama run llama3.1:8b    # Ctrl+D to exit
ollama run bge-m3:latest  # Ctrl+D to exit
ollama run qwen2.5-medical:latest  # Ctrl+D to exit
```

### Install & Run

```bash
cd mri-xray-local
npm install
node server.js
```

Open **http://localhost:3002**

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/prescription/analyze` | Upload prescription image → extract structured data |
| `POST` | `/api/images/analyze` | Upload medical images → AI analysis per image |
| `POST` | `/api/correlate` | Compare prescription findings vs image findings |
| `POST` | `/api/generate-note` | Generate structured medical note |
| `POST` | `/api/demo/run` | Run full automated demo pipeline |
| `POST` | `/api/demo/verify` | Run 3-agent verification on generated report |
| `GET` | `/api/demo/cases` | List available demo cases |
| `GET` | `/api/health` | System health + model availability |
| `GET` | `/api/pipeline/check` | Test all 4 pipeline components |
| `GET` | `/api/reports` | List saved radiology reports |
| `POST` | `/api/session/new` | Create new analysis session |

---

## Configuration

Edit the `CONFIG` block in `server.js`:

```javascript
const CONFIG = {
  visionModel: 'llava:13b',        // Image analysis model
  chatModel: 'gemma4:latest',      // Report generation (can swap to llama3.1:8b for speed)
  embedModel: 'bge-m3:latest',     // RAG embeddings
  dbUrl: 'postgresql://...',       // Supabase pooler connection string
};
```

---

## File Structure

```
mri-xray-local/
├── server.js              # Express server — all API logic
├── public/
│   └── index.html         # Web UI — 5-step workflow
├── uploads/               # Temp image storage (auto-cleaned)
├── test-images/           # Sample X-ray/MRI for testing
└── package.json
```

---

## Limitations & Notes

- **llava:13b** requires ~8GB VRAM. Falls back to CPU if GPU memory insufficient.
- **gemma4:latest** (9.6GB) has slow first-load (~5 min). Use `llama3.1:8b` for faster demos.
- **Multi-image batch** processes 2 images at a time to avoid GPU overload.
- **Session memory** is server-side (30 min TTL). Restarting the server clears all sessions.
- **DICOM files** are accepted by file extension but true DICOM parsing is not implemented (images displayed as uploaded).

---

## License

Proprietary — AIMS Medical Platform. All rights reserved.
