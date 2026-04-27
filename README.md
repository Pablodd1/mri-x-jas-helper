# MedView Pro - MRI & X-Ray Viewer

Medical imaging viewer for doctors to upload, view, annotate, and analyze X-rays and MRIs.

## Quick Start (Works NOW!)

Visit: **https://mri-x-jas-helper.vercel.app**

1. Upload an X-ray or MRI image
2. Enter patient details
3. Use viewer tools (pan, zoom, rotate)
4. Draw annotations on findings
5. Add clinical notes
6. Export reports

## Features

### ✅ Working (No API Required)
- Upload X-rays, MRIs, CT scans (JPG, PNG)
- Full image viewer with pan/zoom/rotate
- Draw and annotate findings
- Measure distances
- Add physician notes & impressions
- Filter by modality
- Export text reports
- Local browser storage

### 🔄 Coming Soon (Needs Config)
- AI-powered image analysis
- DICOM support
- Cloud sync to Supabase

## Environment Variables

To enable AI analysis, add to Vercel:
```
MINIMAX_API_KEY=your_minimax_api_key
```

## Project Structure

```
frontend/
├── public/
│   └── index.html    # Main viewer app (works standalone!)
├── backend/        # Python AI backend (optional)
├── vercel.json     # Vercel config
└── README.md

backend/
├── api/             # FastAPI server
├── rag/             # Medical RAG system
└── models/          # AI models
```

## Deployment

Vercel auto-deploys from GitHub:
https://mri-x-jas-helper.vercel.app

## Tech Stack

- Frontend: Vanilla JS + HTML5 Canvas
- Storage: Browser LocalStorage (or Supabase)
- Backend (optional): Python FastAPI + MiniMax API