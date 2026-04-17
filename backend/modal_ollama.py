"""
Modal — Cloud GPU Ollama Deployment for MRI X Jas Helper

Deploys Ollama with vision models on Modal's GPU infrastructure.
This replaces local Ollama so the app doesn't depend on your machine.

Setup:
  1. pip install modal
  2. modal setup  (one-time, links your account)
  3. modal deploy modal_ollama.py

Cost: ~$0.30/hr while running. Idle = $0.
Free tier: 2 hours GPU/month + $15 credits on signup.
"""

import modal

# ─── App definition ────────────────────────────────────────────────────────────

app = modal.App("mri-x-jas-helper-ollama")

# ─── Image ────────────────────────────────────────────────────────────────────

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("httpx", "torch")
    .pip_install("ollama", "fastapi", "uvicorn")
    .env({"OLLAMA_HOST": "0.0.0.0:11434"})
)

# ─── Volume for model storage ─────────────────────────────────────────────────

volume = modal.Volume.from_name(
    "mri-x-jas-helper-models",
    create_if_missing=True,
)

# ─── Ollama serve command ─────────────────────────────────────────────────────

MODEL_NAME = "llava-llama3"  # Vision-language model
# Alternatives: "llava:7b", "moondream:latest", "axion:latest"

@app.function(
    image=image,
    gpu="T4",              # "T4" (cheap) or "A10G" (faster) or "A100" (best)
    memory=8192,
    volumes={"/root/.ollama": volume},
    timeout=3600,
    retries=2,
)
def run_ollama():
    """
    Start Ollama server and pull model.
    The volume persists models across cold starts.
    """
    import subprocess, time, os

    ollama_path = "/usr/local/bin/ollama"

    # Pull model if not present
    print(f"Ensuring model '{MODEL_NAME}' is available...")
    result = subprocess.run(
        [ollama_path, "pull", MODEL_NAME],
        capture_output=True,
        text=True,
        timeout=1800,  # 30 min timeout for model pull
    )
    if result.returncode != 0:
        print(f"Warning: ollama pull returned {result.returncode}")
        print(result.stderr[:500])
    else:
        print(f"Model '{MODEL_NAME}' ready ✓")

    # Start Ollama server
    print("Starting Ollama server on 0.0.0.0:11434...")
    proc = subprocess.Popen(
        [ollama_path, "serve", "--host", "0.0.0.0"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    # Wait for server to be ready
    time.sleep(5)

    # Health check
    for i in range(10):
        result = subprocess.run([ollama_path, "list"], capture_output=True, text=True)
        if result.returncode == 0:
            print(f"Ollama server ready ✓ (check {i+1}/10)")
            break
        time.sleep(2)

    print("Ollama is running. Keeping container alive...")
    # Keep alive — Modal will keep this running
    while True:
        time.sleep(60)


# ─── Web endpoint ─────────────────────────────────────────────────────────────

@app.function(
    image=image,
    gpu="T4",
    memory=8192,
    volumes={"/root/.ollama": volume},
    allow_concurrent_inputs=10,
)
@modal.asgi_app()
def ollama_api():
    """
    Expose Ollama as an ASGI-compatible web endpoint.
    The /api/... routes mirror Ollama's REST API exactly.
    """
    import subprocess, uvicorn, sys
    from fastapi import FastAPI, Request
    from fastapi.responses import StreamingResponse, JSONResponse
    import httpx

    # Start ollama serve as background process
    import threading, time

    def start_ollama():
        subprocess.run(["/usr/local/bin/ollama", "pull", MODEL_NAME], capture_output=True)
        subprocess.Popen(
            ["/usr/local/bin/ollama", "serve", "--host", "0.0.0.0"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(5)

    thread = threading.Thread(target=start_ollama, daemon=True)
    thread.start()

    # Create a proxy app that forwards to Ollama
    ollama_base = "http://127.0.0.1:11434"

    fastapi_app = FastAPI(title="MRI X Jas Helper — Ollama Proxy")

    @app.get("/")
    async def root():
        return {"model": MODEL_NAME, "status": "running", "provider": "modal-gpu"}

    @app.get("/health")
    async def health():
        return {"status": "ok", "model": MODEL_NAME}

    @app.api_route("/{path:path}", methods=["GET", "POST", "DELETE"])
    async def proxy(path: str, request: Request):
        """Proxy all Ollama API calls."""
        async with httpx.AsyncClient(timeout=300.0) as client:
            body = await request.body()
            headers = dict(request.headers)
            headers.pop("host", None)

            url = f"{ollama_base}/{path}"
            upstream = client.build_request(request.method, url, content=body, headers=headers)
            response = await client.send(upstream, stream=request.headers.get("accept") == "text/event-stream")
            return StreamingResponse(
                response.aiter_bytes(),
                status_code=response.status_code,
                headers=dict(response.headers),
            )

    return fastapi_app


# ─── CLI trigger ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # modal run modal_ollama.py  — start Ollama in background
    # modal deploy modal_ollama.py  — deploy as persistent web service
    # modal scale app gpu=T4  — scale GPU count
    print("Run: modal deploy modal_ollama.py")
    print("Then set OLLAMA_BASE_URL to the Modal endpoint in Railway")
