# MedView Pro - MRI & X-Ray Viewer

Fully functional medical imaging viewer that works without external AI APIs!

## What's Working NOW (No AI Required)

### Features
- **Image Upload** - Drag & drop X-rays, MRIs, CT scans (supports JPG, PNG)
- **Image Viewer** - Pan, zoom, rotate, flip with mouse controls
- **Drawing Tools** - Mark findings with colored lines/circles
- **Measurement Tool** - Measure distances in mm (approximate)
- **Notes & Impression** - Add clinical notes for each study
- **Export Reports** - Download study reports as text
- **Local Storage** - All data stored in browser (no database needed)
- **Filter by Modality** - Filter X-Ray, MRI, CT

### How to Use
1. Go to https://mri-x-jas-helper.vercel.app
2. Drop an X-ray or MRI image onto the upload area
3. Fill in patient info and save
4. Use tools to view, annotate, measure
5. Add notes and export reports

## What's NOT Working (Needs AI Backend)

- AI-powered analysis/suggestions
- Cloud sync between devices
- DICOM format support

## To Enable AI Analysis Later

Add to Vercel environment variables:
```
MINIMAX_API_KEY=your_key
OLLAMA_URL=http://localhost:11434
```

Then deploy the Python backend from the `backend/` folder.

## Tech Stack

- Pure HTML/CSS/JavaScript (works in any browser)
- Local Storage for persistence
- Canvas API for image rendering
- No dependencies needed

## Browser Support

- Chrome (recommended)
- Firefox
- Safari
- Edge

## Files

- `public/index.html` - Main application
- `vercel.json` - Vercel configuration