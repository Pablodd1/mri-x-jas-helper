#!/usr/bin/env python3
"""
Vision Agent — AIMS Insight v3.0
Processes medical images (X-ray, MRI, CT) using MONAI and vision models.
Part of the multi-agent medical imaging pipeline.
"""
import sys
import json
import base64
from pathlib import Path

def analyze_medical_image(image_path: str, modality: str = "xray", ai_provider: str = "ollama") -> dict:
    """Analyze a medical image using the configured AI provider + optional MONAI processing."""
    ext = Path(image_path).suffix.lower()
    
    results = {
        "modality": modality,
        "image": image_path,
        "provider": ai_provider,
        "findings": [],
        "segmentation": None,
        "status": "processing"
    }
    
    # Try MONAI-based analysis if available
    try:
        run_monai = __import__("run_monai_seg", fromlist=["segment"])
        seg_result = run_monai.segment(image_path, modality)
        if seg_result:
            results["segmentation"] = seg_result
    except ImportError:
        pass  # MONAI not available, fallback to AI vision
    
    # AI vision analysis (via Ollama llava or cloud API)
    try:
        import requests
        import os
        
        if ai_provider == "ollama":
            ollama_host = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
            with open(image_path, "rb") as f:
                img_b64 = base64.b64encode(f.read()).decode()
            
            payload = {
                "model": "llava:13b",
                "prompt": f"""Analyze this {modality.upper()} medical image.
Focus on:
1. Anatomical structures visible
2. Any abnormalities or findings
3. Clinical significance
4. Recommended follow-up

Provide a structured radiology-style analysis.""",
                "images": [img_b64],
                "stream": False
            }
            resp = requests.post(f"{ollama_host}/api/generate", json=payload, timeout=120)
            if resp.status_code == 200:
                results["ai_analysis"] = resp.json().get("response", "")
                
        elif ai_provider == "kimi":
            api_key = os.environ.get("KIMI_API_KEY", "")
            base_url = os.environ.get("KIMI_BASE_URL", "https://api.moonshot.cn/v1")
            if api_key:
                with open(image_path, "rb") as f:
                    img_b64 = base64.b64encode(f.read()).decode()
                resp = requests.post(
                    f"{base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}"},
                    json={
                        "model": "kimi-k2.6-vl",
                        "messages": [{
                            "role": "user",
                            "content": [
                                {"type": "text", "text": f"Analyze this {modality} medical image in detail."},
                                {"type": "image_url", "image_url": {"url": f"data:image/{ext[1:]};base64,{img_b64}"}}
                            ]
                        }]
                    },
                    timeout=120
                )
                if resp.status_code == 200:
                    results["ai_analysis"] = resp.json()["choices"][0]["message"]["content"]
        
        results["status"] = "complete"
    except Exception as e:
        results["status"] = "error"
        results["error"] = str(e)
    
    return results


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="AIMS Vision Agent")
    parser.add_argument("image", help="Medical image path")
    parser.add_argument("--modality", "-m", choices=["xray", "mri", "ct", "ultrasound"], default="xray")
    parser.add_argument("--provider", "-p", choices=["ollama", "kimi", "deepseek"], default="ollama")
    parser.add_argument("--output", "-o", help="Output path")
    args = parser.parse_args()
    
    result = analyze_medical_image(args.image, args.modality, args.provider)
    output_path = args.output or f"vision_output_{Path(args.image).stem}.json"
    with open(output_path, "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result, indent=2))