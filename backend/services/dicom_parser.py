"""
DICOM Parser — Extract metadata, validate, and prepare medical images for AI analysis.
Supports: .dcm (DICOM), .nii / .nii.gz (NIfTI), .png, .jpg
"""

import io
import zipfile
from pathlib import Path
from typing import Optional
from dataclasses import dataclass, field
from enum import Enum

from PIL import Image
import numpy as np


class Modality(Enum):
    XR = "XR"   # X-Ray
    CT = "CT"   # Computed Tomography
    MR = "MR"   # Magnetic Resonance
    US = "US"   # Ultrasound
    UNKNOWN = "UNKNOWN"


@dataclass
class DicomMetadata:
    patient_id: str = ""
    study_date: str = ""
    modality: str = "UNKNOWN"
    series_description: str = ""
    num_slices: int = 0
    rows: int = 0
    columns: int = 0
    pixel_spacing: tuple = (1.0, 1.0)
    slice_thickness: float = 1.0
    window_center: float = 40.0
    window_width: float = 400.0
    study_description: str = ""
    body_part: str = "CHEST"  # Default
    raw_tags: dict = field(default_factory=dict)


@dataclass
class ProcessedImage:
    metadata: DicomMetadata
    image_data: np.ndarray  # 2D numpy array, H x W, float32 normalized 0-1
    original_format: str   # "dcm", "nii", "png", "jpg"


def extract_metadata_from_dicom_bytes(data: bytes) -> DicomMetadata:
    """
    Parse DICOM metadata from raw bytes.
    Falls back to defaults if pydicom is not available or parsing fails.
    """
    metadata = DicomMetadata()

    try:
        import pydicom

        ds = pydicom.dcmread(io.BytesIO(data))

        metadata.patient_id = str(getattr(ds, "PatientID", ""))
        metadata.study_date = str(getattr(ds, "StudyDate", ""))
        metadata.modality = str(getattr(ds, "Modality", "UNKNOWN"))
        metadata.series_description = str(getattr(ds, "SeriesDescription", ""))
        metadata.study_description = str(getattr(ds, "StudyDescription", ""))
        metadata.rows = int(getattr(ds, "Rows", 512))
        metadata.columns = int(getattr(ds, "Columns", 512))

        try:
            ps = ds.PixelSpacing
            metadata.pixel_spacing = (float(ps[0]), float(ps[1]))
        except Exception:
            pass

        try:
            metadata.slice_thickness = float(ds.SliceThickness)
        except Exception:
            pass

        try:
            wc = ds.WindowCenter
            ww = ds.WindowWidth
            metadata.window_center = float(wc[0] if isinstance(wc, (list, tuple)) else wc)
            metadata.window_width = float(ww[0] if isinstance(ww, (list, tuple)) else ww)
        except Exception:
            pass

        # Infer body part from study/series description
        desc = f"{metadata.study_description} {metadata.series_description}".upper()
        if "CHEST" in desc or "CXR" in desc:
            metadata.body_part = "CHEST"
        elif "BRAIN" in desc or "HEAD" in desc:
            metadata.body_part = "BRAIN"
        elif "KNEE" in desc or "SHOULDER" in desc or "SPINE" in desc:
            metadata.body_part = "MSK"
        elif "ABDOMEN" in desc or "LIVER" in desc or "PANCREAS" in desc:
            metadata.body_part = "ABDOMEN"
        else:
            metadata.body_part = "CHEST"  # safe default

    except ImportError:
        metadata.modality = "UNKNOWN"
    except Exception as e:
        # Even if parsing fails, return defaults
        pass

    return metadata


def dcm_to_numpy(data: bytes) -> np.ndarray:
    """Convert DICOM pixel data to normalized numpy array."""
    try:
        import pydicom

        ds = pydicom.dcmread(io.BytesIO(data))
        pixel_array = ds.pixel_array.astype(np.float32)

        # Normalize to 0-1 range
        vmin, vmax = pixel_array.min(), pixel_array.max()
        if vmax > vmin:
            pixel_array = (pixel_array - vmin) / (vmax - vmin)

        return pixel_array

    except ImportError:
        raise ImportError("pydicom is required for DICOM processing. Install: pip install pydicom")
    except Exception as e:
        raise ValueError(f"Failed to convert DICOM to numpy: {e}")


def nii_to_numpy(data: bytes) -> np.ndarray:
    """Convert NIfTI (.nii / .nii.gz) to numpy array."""
    try:
        import nibabel as nib

        # Write to temp file since nibabel needs file path for .nii.gz
        import tempfile, os
        with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=False) as f:
            f.write(data)
            fname = f.name

        img = nib.load(fname)
        array = img.get_fdata().astype(np.float32)
        os.unlink(fname)

        # Normalize
        vmin, vmax = array.min(), array.max()
        if vmax > vmin:
            array = (array - vmin) / (vmax - vmin)

        # Take middle slice for 3D volumes
        if len(array.shape) == 3:
            mid = array.shape[2] // 2
            array = array[:, :, mid]

        return array

    except ImportError:
        raise ImportError("nibabel is required for NIfTI processing. Install: pip install nibabel")
    except Exception as e:
        raise ValueError(f"Failed to convert NIfTI to numpy: {e}")


def image_to_numpy(data: bytes) -> np.ndarray:
    """Convert PNG/JPG to normalized numpy array."""
    img = Image.open(io.BytesIO(data)).convert("L")  # Grayscale
    arr = np.array(img).astype(np.float32) / 255.0
    return arr


def numpy_to_jpeg_bytes(array: np.ndarray, quality: int = 85) -> bytes:
    """Convert normalized numpy array back to JPEG bytes."""
    # Ensure 0-1 range
    arr = np.clip(array, 0.0, 1.0)
    # Scale to 0-255 uint8
    arr = (arr * 255).astype(np.uint8)
    img = Image.fromarray(arr, mode="L")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def process_medical_image(
    file_bytes: bytes,
    filename: str,
) -> ProcessedImage:
    """
    Universal processor for all supported medical image formats.
    Returns normalized numpy array + metadata.
    """
    ext = Path(filename).suffix.lower()

    metadata = DicomMetadata()
    image_data: np.ndarray

    if ext in [".dcm"]:
        metadata = extract_metadata_from_dicom_bytes(file_bytes)
        image_data = dcm_to_numpy(file_bytes)

    elif ext in [".nii", ".gz"] and ".nii" in filename.lower():
        metadata.modality = "MR"
        image_data = nii_to_numpy(file_bytes)

    elif ext in [".png", ".jpg", ".jpeg"]:
        metadata.modality = "XR"
        metadata.body_part = "CHEST"  # Default for plain radiographs
        image_data = image_to_numpy(file_bytes)

    else:
        raise ValueError(f"Unsupported file format: {ext}. Supported: .dcm, .nii, .nii.gz, .png, .jpg")

    return ProcessedImage(
        metadata=metadata,
        image_data=image_data,
        original_format=ext.lstrip("."),
    )


def process_dicom_zip(zip_bytes: bytes) -> list[ProcessedImage]:
    """
    Extract all DICOM files from a ZIP archive and process them.
    Returns list of processed images sorted by series.
    """
    images = []

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for name in zf.namelist():
            if name.lower().endswith(".dcm"):
                try:
                    data = zf.read(name)
                    processed = process_medical_image(data, name)
                    images.append(processed)
                except Exception:
                    continue  # Skip corrupt files

    # Sort by series description
    images.sort(key=lambda x: x.metadata.series_description)

    return images
