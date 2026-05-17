"""Generate synthetic sample medical images for AIMS VISION PRO demo"""
from PIL import Image, ImageDraw, ImageFont
import struct, zlib, math, os

SAMPLES = '/home/jasme/mri-xray-local/samples'

# ── 1. Prescription Form ──
img = Image.new('RGB', (1200, 800), 'white')
draw = ImageDraw.Draw(img)
draw.rectangle([0, 0, 1200, 80], fill='#1a5276')
try:
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 24)
    font_sm = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 14)
    font_md = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 18)
except:
    font = ImageFont.load_default(); font_sm = font; font_md = font

draw.text((30, 18), "INNOVATE MEDICAL WELLNESS", fill='white', font=font)
draw.text((30, 50), "Diagnostic Imaging Referral Form", fill='#aed6f1', font=font_sm)

y = 100
draw.text((30, y), "PATIENT INFORMATION", fill='#1a5276', font=font)
y += 30
draw.rectangle([30, y, 570, y+28], outline='#999', width=1)
draw.text((38, y+4), "Name: John Smith", fill='#333', font=font_md)
draw.rectangle([590, y, 1170, y+28], outline='#999', width=1)
draw.text((598, y+4), "DOB: 05/15/1985  Age: 40  MRN: 7845231", fill='#333', font=font_md)

y = 175
draw.text((30, y), "EXAM ORDERED", fill='#1a5276', font=font)
y += 30
draw.rectangle([34, y+4, 46, y+16], fill='#1a5276')
draw.text((56, y+2), "MRI", fill='#1a5276', font=font_md)
draw.rectangle([120, y+4, 132, y+16], outline='#333', width=1)
draw.text((142, y+2), "X-ray", fill='#666', font=font_md)
draw.rectangle([220, y+4, 232, y+16], outline='#333', width=1)
draw.text((242, y+2), "CT Scan", fill='#666', font=font_md)
draw.rectangle([340, y+4, 352, y+16], outline='#333', width=1)
draw.text((362, y+2), "Ultrasound", fill='#666', font=font_md)

y = 230
draw.text((30, y), "BODY REGION: Right Knee", fill='#333', font=font_md)
draw.rectangle([30, y+28, 500, y+54], outline='#999', width=1)
draw.text((38, y+33), "Right Knee - suspect medial meniscus tear", fill='#555', font=font_sm)

y = 300
draw.text((30, y), "CLINICAL INDICATION", fill='#1a5276', font=font)
y += 28
draw.rectangle([30, y, 1170, y+75], outline='#999', width=1)
draw.text((38, y+5), "35-year-old male soccer player with acute right knee injury during", fill='#333', font=font_md)
draw.text((38, y+28), "pivoting maneuver. Audible pop. Immediate swelling. Unable to bear weight.", fill='#333', font=font_md)
draw.text((38, y+50), "Positive Lachman and McMurray tests. Rule out ACL tear, meniscus injury.", fill='#333', font=font_md)

y = 420
draw.text((30, y), "URGENCY:", fill='#1a5276', font=font)
draw.rectangle([32, y+28, 44, y+40], outline='#333', width=1)
draw.text((54, y+26), "Routine", fill='#666', font=font_md)
draw.rectangle([32, y+50, 44, y+62], fill='#c0392b')
draw.text((54, y+48), "URGENT", fill='#c0392b', font=font_md)

y = 500
draw.text((30, y), "CONTRAST: Without contrast", fill='#333', font=font_md)

y = 540
draw.text((30, y), "REFERRING PHYSICIAN: Dr. Michael Torres, Sports Medicine", fill='#333', font=font_md)
draw.text((30, y+28), "FACILITY: Miami Sports Medicine and Orthopedics Center", fill='#333', font=font_md)
draw.text((30, y+55), "DATE: 05/08/2026    SIGNATURE: _________________________", fill='#333', font=font_md)

img.save(f'{SAMPLES}/prescription_form.jpg', 'JPEG', quality=90)
print(f"OK prescription_form.jpg: {os.path.getsize(f'{SAMPLES}/prescription_form.jpg')} bytes")

# ── 2. Knee MRI-like image ──
def make_png(width, height, pixels_func, filename):
    raw = b''
    for y in range(height):
        raw += b'\x00'
        for x in range(width):
            v = pixels_func(x, y)
            raw += bytes([v, v, v])
    def chunk(ctype, data):
        c = ctype + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw))
    png += chunk(b'IEND', b'')
    with open(f'{SAMPLES}/{filename}', 'wb') as f:
        f.write(png)
    print(f"OK {filename}: {os.path.getsize(f'{SAMPLES}/{filename}')} bytes")

def knee_pixel(x, y):
    w, h = 500, 500
    cx, cy = w/2, h/2
    v = 30 + int(15 * math.sin(x/20) * math.cos(y/20))
    r = math.sqrt((x-cx)**2 + (y-cy)**2)
    if 100 < r < 160:
        v = max(v, 180 + int(40 * math.sin(r/8)))
    if 110 < r < 140:
        v = max(v, 220)
    v += int(10 * math.sin(x/3) * math.cos(y/5))
    if r < 60:
        v -= 30
    if 80 < r < 120 and 180 < (math.atan2(y-cy, x-cx) * 180/math.pi) % 360 < 300:
        v = 200
    return max(0, min(255, v))

make_png(500, 500, knee_pixel, 'knee_mri_sample.png')

# ── 3. Chest X-ray-like image ──
def chest_pixel(x, y):
    w, h = 600, 500
    v = 200 + int(15 * math.sin(x/30) * math.cos(y/25))
    if 270 < x < 330:
        v -= 30
    if 80 < x < 260 and 60 < y < 440:
        dist = min(abs(x-170)//2, abs(y-250)//3)
        dark = int(60 * (1 - dist/60)) if dist < 60 else 0
        v -= max(0, dark)
    if 340 < x < 520 and 60 < y < 440:
        dist = min(abs(x-430)//2, abs(y-250)//3)
        dark = int(60 * (1 - dist/60)) if dist < 60 else 0
        v -= max(0, dark)
    if 230 < x < 350 and 180 < y < 320:
        r2 = ((x-290)/40)**2 + ((y-250)/50)**2
        if r2 < 1:
            v += int(40 * (1-r2))
    for rib in range(100, 440, 30):
        if abs(y - rib) < 3:
            v += 20
    v += int(10 * math.sin(x/7) * math.cos(y/9))
    return max(0, min(255, v))

make_png(600, 500, chest_pixel, 'chest_xray_sample.png')

print("\nAll sample images generated successfully!")
