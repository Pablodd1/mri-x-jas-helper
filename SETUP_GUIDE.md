# MRI X Jas Helper — Deployment Setup Guide
# Run this ONCE to configure everything, then every future push auto-deploys

## STEP 1: Get Your API Keys

### Modal (GPU Cloud) — ~$0.30/hr
1. Go to https://modal.com → Sign up (get $15 free credits)
2. Run: `pip install modal && modal setup`
3. Deploy Ollama:
   ```bash
   cd ~/projects/mri-x-jas-helper/backend
   modal deploy modal_ollama.py
   ```
4. Copy the Modal URL it gives you (e.g. `https://mri-x-jas-helper-ollama-xxx.modal.run`)

### Railway (Backend) — ~$5-7/mo
1. Go to https://railway.app → Sign up, connect GitHub
2. Go to Account Settings → Copy your **Railway Token**

### Vercel (Frontend) — FREE
1. Go to https://vercel.com → Sign up, connect GitHub
2. Go to Settings → Tokens → Create **Vercel Token**

### Kimi API (Fallback) — ~$5-15/mo
1. Go to https://console.moonshot.cn → API Keys → Create
2. Copy the key (starts with `sk-kimi-`)

### Deepgram (Voice) — ~$2-5/mo
1. Go to https://console.deepgram.com → Sign up
2. Create a key, copy it

---

## STEP 2: Add GitHub Secrets

1. Go to: https://github.com/Pablodd1/mri-x-jas-helper → Settings → Secrets and variables → Actions

2. Add these **Repository Secrets** (click "New repository secret" for each):

| Secret Name | Value |
|---|---|
| `RAILWAY_TOKEN` | Your Railway account token |
| `MODAL_OLLAMA_URL` | Your Modal deployed URL (e.g. `https://mri-x-jas-helper-ollama-xxx.modal.run`) |
| `MODAL_OLLAMA_MODEL` | `llava-llama3` |
| `KIMI_API_KEY` | Your Kimi API key (`sk-kimi-...`) |
| `MINIMAX_API_KEY` | (optional) Your MiniMax key |
| `DEEPGRAM_API_KEY` | (optional) Your Deepgram key |
| `VERCEL_TOKEN` | Your Vercel token |
| `BACKEND_URL` | `https://mri-x-jas-helper-backend.up.railway.app` |

3. Go to **Variables** (not Secrets) → Actions:
   - Add `RAILWAY_PROJECT_ID` = your Railway project ID (found in Railway project URL or settings)

---

## STEP 3: Link Railway to the Backend

1. Go to Railway → Create New Project → Deploy from GitHub → select `Pablodd1/mri-x-jas-helper` → choose `backend/` directory
2. Railway will show "Waiting for deployment" — don't click Deploy yet
3. Copy the **Project ID** from the Railway URL or Project Settings
4. Add it as a GitHub Actions variable: `RAILWAY_PROJECT_ID`

**Alternative (manual deploy instead of GitHub Actions):**
1. In Railway, go to your project → Variables tab
2. Add all these:
   ```
   MODAL_OLLAMA_URL=https://your-modal-url.modal.run
   MODAL_OLLAMA_MODEL=llava-llama3
   KIMI_API_KEY=sk-kimi-...
   MINIMAX_API_KEY=sk-api-...
   DEEPGRAM_API_KEY=...
   PORT=8080
   NODE_ENV=production
   CORS_ORIGIN=https://mri-x-jas-helper.vercel.app
   ```
3. Click **Deploy** — Railway auto-detects Dockerfile → builds → deploys

---

## STEP 4: Link Vercel to the Frontend

1. Go to Vercel → New Project → Import `Pablodd1/mri-x-jas-helper`
2. Set **Root Directory** to: `frontend`
3. Under **Environment Variables** add:
   ```
   NEXT_PUBLIC_API_URL = https://your-railway-backend.up.railway.app
   ```
4. Click **Deploy**

---

## STEP 5: Verify Everything Works

1. Open your Vercel frontend URL
2. Upload a chest X-ray (try the Chester-Xray sample images from `~/repos/medical-ai/chester-xray/examples/`)
3. Select "Deep Analysis" mode and "Modal" provider
4. Click Analyze
5. Should get a response in 10-60 seconds

---

## Future Updates

From now on, just push to GitHub:
```bash
cd ~/projects/mri-x-jas-helper
git add -A
git commit -m "your changes"
git push origin main
```

GitHub Actions will automatically:
- Deploy backend to Railway
- Deploy frontend to Vercel

---

## Troubleshooting

**"Ollama not running"** → Modal URL not set correctly in Railway variables

**"Transcription failed"** → Deepgram key not set or expired

**"Module not found"** → Missing `pip install` in Dockerfile — edit backend/requirements.txt then push

**Railway build fails** → Check Railway deployment logs at railway.app → your project → Deployments tab
