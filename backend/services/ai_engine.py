"""
AI Engine — Multi-provider orchestration with automatic fallback.
Providers in priority order:
  1. Ollama (local, free) — always attempted first
  2. Kimi (Moonshot API) — if Ollama unavailable or user requests
  3. MiniMax — fallback
  4. Deepgram — voice transcription only
"""

import os
import base64
import httpx
import asyncio
from typing import Literal, Optional
from config import get_settings

settings = get_settings()


# ─── Image encoding ─────────────────────────────────────────────────────────

def encode_image_to_base64(image_bytes: bytes) -> str:
    return base64.b64encode(image_bytes).decode("utf-8")


# ─── Ollama (local, free) ────────────────────────────────────────────────────

async def analyze_with_ollama(
    image_bytes: bytes,
    prompt: str,
) -> dict:
    """
    Local inference via Ollama HTTP API.
    No API key needed, runs entirely on local GPU/CPU.
    """
    base_url = settings.ollama_base_url.rstrip("/")
    url = f"{base_url}/api/generate"

    image_b64 = encode_image_to_base64(image_bytes)

    payload = {
        "model": settings.ollama_model,
        "prompt": prompt,
        "images": [image_b64],
        "stream": False,
        "options": {
            "temperature": 0.3,
            "top_p": 0.9,
        },
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            data = response.json()
            return {
                "provider": "ollama",
                "model": settings.ollama_model,
                "text": data.get("response", ""),
                "success": True,
            }
        except httpx.ConnectError:
            return {"provider": "ollama", "success": False, "error": "Ollama not running. Start with: ollama serve"}
        except httpx.HTTPStatusError as e:
            return {"provider": "ollama", "success": False, "error": f"HTTP {e.response.status_code}: {e.response.text[:200]}"}
        except Exception as e:
            return {"provider": "ollama", "success": False, "error": str(e)}


# ─── Ollama (Modal cloud GPU — no local machine needed) ─────────────────────

async def analyze_with_modal_ollama(
    image_bytes: bytes,
    prompt: str,
) -> dict:
    """
    Ollama running on Modal's cloud GPU infrastructure.
    No local machine needed — fully cloud-hosted inference.
    Set MODAL_OLLAMA_URL to your Modal deployed endpoint.
    """
    if not settings.modal_ollama_url:
        return {"provider": "modal", "success": False, "error": "MODAL_OLLAMA_URL not configured"}

    base_url = settings.modal_ollama_url.rstrip("/")
    url = f"{base_url}/api/generate"

    image_b64 = encode_image_to_base64(image_bytes)

    payload = {
        "model": settings.modal_ollama_model,
        "prompt": prompt,
        "images": [image_b64],
        "stream": False,
        "options": {
            "temperature": 0.3,
            "top_p": 0.9,
        },
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            data = response.json()
            return {
                "provider": "modal",
                "model": settings.modal_ollama_model,
                "text": data.get("response", ""),
                "success": True,
            }
        except httpx.ConnectError:
            return {"provider": "modal", "success": False, "error": "Modal Ollama endpoint not reachable. Check MODAL_OLLAMA_URL"}
        except httpx.HTTPStatusError as e:
            return {"provider": "modal", "success": False, "error": f"HTTP {e.response.status_code}: {e.response.text[:200]}"}
        except Exception as e:
            return {"provider": "modal", "success": False, "error": str(e)}


# ─── Kimi (Moonshot) ─────────────────────────────────────────────────────────

async def analyze_with_kimi(
    image_bytes: bytes,
    prompt: str,
) -> dict:
    """
    Kimi/Moonshot AI via their API. Affordable, long context.
    """
    if not settings.kimi_api_key:
        return {"provider": "kimi", "success": False, "error": "KIMI_API_KEY not configured"}

    base_url = "https://api.moonshot.cn/v1"
    url = f"{base_url}/chat/completions"

    image_b64 = encode_image_to_base64(image_bytes)

    payload = {
        "model": "moonshot-v1-8k",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                    {"type": "text", "text": prompt},
                ],
            }
        ],
        "temperature": 0.3,
    }

    headers = {
        "Authorization": f"Bearer {settings.kimi_api_key}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=90.0) as client:
        try:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            return {
                "provider": "kimi",
                "model": "moonshot-v1-8k",
                "text": content,
                "success": True,
            }
        except httpx.HTTPStatusError as e:
            return {"provider": "kimi", "success": False, "error": f"HTTP {e.response.status_code}: {e.response.text[:200]}"}
        except Exception as e:
            return {"provider": "kimi", "success": False, "error": str(e)}


# ─── MiniMax ─────────────────────────────────────────────────────────────────

async def analyze_with_minimax(
    image_bytes: bytes,
    prompt: str,
) -> dict:
    """
    MiniMax API — cost-effective, good for batch analysis.
    Uses their OpenAI-compatible endpoint.
    """
    if not settings.minimax_api_key:
        return {"provider": "minimax", "success": False, "error": "MINIMAX_API_KEY not configured"}

    url = "https://api.minimax.io/v1/text/chatcompletion_v2"

    image_b64 = encode_image_to_base64(image_bytes)

    payload = {
        "model": "MiniMax-Text-01",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                    {"type": "text", "text": prompt},
                ],
            }
        ],
        "temperature": 0.3,
    }

    headers = {
        "Authorization": f"Bearer {settings.minimax_api_key}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=90.0) as client:
        try:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            return {
                "provider": "minimax",
                "model": "MiniMax-Text-01",
                "text": content,
                "success": True,
            }
        except httpx.HTTPStatusError as e:
            return {"provider": "minimax", "success": False, "error": f"HTTP {e.response.status_code}: {e.response.text[:200]}"}
        except Exception as e:
            return {"provider": "minimax", "success": False, "error": str(e)}


# ─── Orchestrator ────────────────────────────────────────────────────────────

async def analyze_image(
    image_bytes: bytes,
    prompt: str,
    preferred_provider: Literal["modal", "ollama", "kimi", "minimax"] = "modal",
    require_provider: Optional[Literal["modal", "ollama", "kimi", "minimax"]] = None,
) -> dict:
    """
    Main entry point. Tries providers in order with automatic fallback.

    Priority order for sellable product:
      1. Modal Ollama (cloud GPU, no local machine needed) — DEFAULT
      2. Local Ollama (user's own GPU, free)
      3. Kimi (Moonshot API, affordable)
      4. MiniMax (fallback)

    Args:
        image_bytes: Raw image data
        prompt: Medical analysis question/prompt
        preferred_provider: Try this one first
        require_provider: Only use this provider (skip fallback)

    Returns:
        dict with provider, model, text, success
    """
    if require_provider:
        # Single provider mode
        if require_provider == "modal":
            return await analyze_with_modal_ollama(image_bytes, prompt)
        elif require_provider == "ollama":
            return await analyze_with_ollama(image_bytes, prompt)
        elif require_provider == "kimi":
            return await analyze_with_kimi(image_bytes, prompt)
        elif require_provider == "minimax":
            return await analyze_with_minimax(image_bytes, prompt)

    # Multi-provider with fallback
    # Priority: Modal (cloud GPU) → local Ollama → Kimi → MiniMax
    order = [preferred_provider]
    others = ["modal", "ollama", "kimi", "minimax"]
    others.remove(preferred_provider)
    order.extend(others)

    last_error = None
    for provider in order:
        if provider == "modal":
            result = await analyze_with_modal_ollama(image_bytes, prompt)
        elif provider == "ollama":
            result = await analyze_with_ollama(image_bytes, prompt)
        elif provider == "kimi":
            result = await analyze_with_kimi(image_bytes, prompt)
        elif provider == "minimax":
            result = await analyze_with_minimax(image_bytes, prompt)
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


# ─── Voice transcription (Deepgram) ─────────────────────────────────────────

async def transcribe_audio(
    audio_bytes: bytes,
    mimetype: str = "audio/webm",
) -> dict:
    """
    Transcribe clinical dictation using Deepgram Nova 2 Medical.
    """
    if not settings.deepgram_api_key:
        return {"provider": "deepgram", "success": False, "error": "DEEPGRAM_API_KEY not configured"}

    url = "https://api.deepgram.com/v1/listen"

    headers = {
        "Authorization": f"Token {settings.deepgram_api_key}",
    }

    params = {
        "model": "nova-2-medical",
        "smart_format": "true",
        "punctuate": "true",
        "language": "en-US",
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            files = {"file": ("audio.webm", audio_bytes, mimetype)}
            response = await client.post(url, files=files, headers=headers, params=params)
            response.raise_for_status()
            data = response.json()
            transcript = data["results"]["channels"][0]["alternatives"][0]["transcript"]
            return {
                "provider": "deepgram",
                "model": "nova-2-medical",
                "text": transcript,
                "success": True,
            }
        except Exception as e:
            return {"provider": "deepgram", "success": False, "error": str(e)}
