#!/usr/bin/env python3
"""
Diagnosis Agent — AIMS Insight v3.0
Takes vision findings and generates structured diagnosis, treatment suggestions.
Part of the multi-agent medical imaging pipeline.
"""
import sys
import json
from pathlib import Path
import requests


def generate_diagnosis(vision_output_path: str, patient_history: dict = None) -> dict:
    """Generate clinical diagnosis from vision analysis findings."""
    
    with open(vision_output_path) as f:
        vision_data = json.load(f)
    
    findings_text = vision_data.get("ai_analysis", "No AI analysis available")
    modality = vision_data.get("modality", "unknown")
    
    # Build structured diagnosis
    diagnosis = {
        "modality": modality,
        "based_on": vision_output_path,
        "findings_summary": findings_text[:1000],
        "impression": "",
        "recommendations": [],
        "ddx": [],
        "confidence": "moderate"
    }
    
    # Try to enhance with LLM analysis
    try:
        ollama_host = "http://localhost:11434"
        prompt = f"""You are a radiologist. Analyze these medical imaging findings and provide:

CLINICAL IMPRESSION:
DIFFERENTIAL DIAGNOSIS (list top 3):
RECOMMENDATIONS:
CONFIDENCE LEVEL (low/moderate/high):
KEY FINDINGS:

Modality: {modality}
Findings: {findings_text[:2000]}

Patient context: {json.dumps(patient_history or {})[:500]}
"""
        resp = requests.post(f"{ollama_host}/api/generate", json={
            "model": "deepseek-r1:7b",
            "prompt": prompt,
            "stream": False
        }, timeout=60)
        
        if resp.status_code == 200:
            enhanced = resp.json().get("response", "")
            diagnosis["enhanced_analysis"] = enhanced
            diagnosis["confidence"] = "high"
            
            # Extract structured fields
            lines = enhanced.split("\n")
            for line in lines:
                ll = line.lower().strip()
                if ll.startswith("clinical impression") or ll.startswith("impression"):
                    diagnosis["impression"] = ":".join(line.split(":")[1:]).strip()
                elif ll.startswith("recommendation"):
                    diagnosis["recommendations"].append(line.split(":")[1].strip() if ":" in line else line)
                    
    except Exception as e:
        diagnosis["error"] = str(e)
    
    return diagnosis


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="AIMS Diagnosis Agent")
    parser.add_argument("vision_json", help="Vision agent output JSON")
    parser.add_argument("--output", "-o", help="Output path")
    args = parser.parse_args()
    
    result = generate_diagnosis(args.vision_json)
    output_path = args.output or Path(args.vision_json).parent / "diagnosis_output.json"
    with open(output_path, "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result, indent=2))