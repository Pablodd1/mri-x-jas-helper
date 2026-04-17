"""
Smart Slice Selector — Selects optimal series and slices for AI analysis.
Derived from DICOMassist's approach: given a clinical question,
pick the most diagnostically relevant slices.

This is the "brain" that decides WHAT to send to the AI model,
because sending 200 slices gives garbage results.
"""

from typing import Optional
import numpy as np

# Clinical question → preferred modality, orientation, and weighting
CLINICAL_PREFERENCE_MAP = {
    "acl tear": {
        "body_part": "MSK",
        "orientations": ["sagittal", "coronal"],
        "weightings": ["PD", "T2", "STIR"],
        "focus": "Sagittal PD and coronal STIR for ACL visualization",
    },
    "meniscus": {
        "body_part": "MSK",
        "orientations": ["sagittal", "coronal"],
        "weightings": ["PD", "T2"],
        "focus": "Sagittal PD for meniscus body and horns",
    },
    "brain tumor": {
        "body_part": "BRAIN",
        "orientations": ["axial"],
        "weightings": ["T1+C", "T1", "FLAIR", "T2"],
        "focus": "Post-contrast T1 for tumor, FLAIR for edema",
    },
    "stroke": {
        "body_part": "BRAIN",
        "orientations": ["axial"],
        "weightings": ["DWI", "FLAIR", "T2"],
        "focus": "DWI for acute infarct, FLAIR for chronic",
    },
    "cervical spine": {
        "body_part": "SPINE",
        "orientations": ["sagittal", "axial"],
        "weightings": ["T2", "T1"],
        "focus": "Sagittal T2 for cord compression, axial for foraminal stenosis",
    },
    "chest xray": {
        "body_part": "CHEST",
        "orientations": ["PA", "AP", "lateral"],
        "weightings": [],
        "focus": "PA chest radiograph for lungs, heart, mediastinum",
    },
    "lung nodule": {
        "body_part": "CHEST",
        "orientations": ["axial"],
        "weightings": ["thin", "HRCT"],
        "focus": "Thin-slice axial for pulmonary nodules",
    },
    "liver lesion": {
        "body_part": "ABDOMEN",
        "orientations": ["axial"],
        "weightings": ["T1+C", "T2", "DWI"],
        "focus": "Arterial and portal venous phase for lesion characterization",
    },
    "default": {
        "body_part": "CHEST",
        "orientations": ["axial", "sagittal", "coronal"],
        "weightings": [],
        "focus": "Comprehensive review of all available series",
    },
}


def infer_clinical_question_from_tags(tags: list[str]) -> dict:
    """
    Match clinical question from user-selected tags.
    """
    combined = " ".join(tags).lower()

    for key, prefs in CLINICAL_PREFERENCE_MAP.items():
        if key == "default":
            continue
        if any(word in combined for word in key.split()):
            return prefs

    return CLINICAL_PREFERENCE_MAP["default"]


def select_slices_for_series(
    series_metadata: dict,
    clinical_preference: dict,
    max_slices: int = 12,
) -> list[int]:
    """
    Given a series' metadata and clinical question, return the best
    slice indices to send to AI analysis.

    Args:
        series_metadata: Dict with keys: num_slices, orientation,
                         weighting, series_description
        clinical_preference: Dict from CLINICAL_PREFERENCE_MAP
        max_slices: Maximum slices to return (AI context limit)

    Returns:
        List of slice indices to include
    """
    num_slices = series_metadata.get("num_slices", 0)
    orientation = series_metadata.get("orientation", "").upper()
    weighting = series_metadata.get("weighting", "").upper()
    series_desc = series_metadata.get("series_description", "").upper()

    pref_orientations = [o.upper() for o in clinical_preference.get("orientations", [])]
    pref_weightings = [w.upper() for w in clinical_preference.get("weightings", [])]

    # Score this series
    score = 0

    # Orientation match
    if any(o in orientation for o in pref_orientations):
        score += 10

    # Weighting match
    if any(w in weighting for w in pref_weightings):
        score += 8

    # Description keyword match
    focus = clinical_preference.get("focus", "").upper()
    if any(word in series_desc for word in focus.split()[:3]):
        score += 5

    if score == 0:
        return []  # Skip this series

    # Select slices: uniform sampling from the series
    if num_slices <= max_slices:
        return list(range(num_slices))

    # Pick evenly distributed slices (start, mid, end regions)
    indices = []
    step = num_slices / max_slices
    for i in range(max_slices):
        idx = int(i * step)
        indices.append(min(idx, num_slices - 1))

    return sorted(set(indices))


def get_ai_prompt_from_clinical_question(
    clinical_question: str,
    body_part: str,
) -> str:
    """
    Generate a targeted AI analysis prompt from the clinical question.
    This prompt tells the AI model WHAT to look for.
    """
    base_prompt = f"""You are a board-certified radiologist analyzing a {body_part} medical image.

CLINICAL QUESTION: {clinical_question}

TASK:
1. Describe what you see in this image
2. Identify any abnormal findings
3. Provide a differential diagnosis if applicable
4. Rate your confidence level (High / Medium / Low)
5. Recommend follow-up if needed

IMPORTANT:
- Use professional radiological language
- Be specific about anatomical findings
- If you are uncertain, say so clearly
- Do not overstate findings

Format your response with clear sections:
## Findings
## Interpretation  
## Confidence
## Recommendations
"""

    return base_prompt
