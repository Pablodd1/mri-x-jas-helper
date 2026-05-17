"""Generate synthetic medical sample images using ONLY Python stdlib (no Pillow)"""
import struct, zlib, math, os

SAMPLES = '/home/jasme/mri-xray-local/samples'

def make_png(width, height, pixels_func, filename):
    raw = b''
    for y in range(height):
        raw += b'\x00'  # filter none
        for x in range(width):
            v = pixels_func(x, y)
            raw += bytes([v, v, v])  # RGB grayscale
    
    def chunk(ctype, data):
        c = ctype + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw))
    png += chunk(b'IEND', b'')
    
    path = f'{SAMPLES}/{filename}'
    with open(path, 'wb') as f:
        f.write(png)
    size_kb = os.path.getsize(path) / 1024
    print(f"  OK {filename}: {size_kb:.1f} KB")
    return path

print("Generating sample medical images...")

# 1. Knee MRI-like (dark background with bone-like bright circular structures)
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
    angle = (math.atan2(y-cy, x-cx) * 180/math.pi) % 360
    if 80 < r < 120 and 180 < angle < 300:
        v = 200
    return max(0, min(255, v))

make_png(500, 500, knee_pixel, 'knee_mri_sample_01.png')

# 2. Second knee MRI slice (coronal-like)
def knee_coronal(x, y):
    w, h = 500, 500
    cx, cy = w/2, h/2
    v = 25 + int(20 * math.sin(x/25) * math.cos(y/18))
    r = math.sqrt((x-cx)**2 + (y-cy)**2)
    if 90 < r < 170:
        v = max(v, 170 + int(30 * math.sin(r/10)))
    if r < 70:
        v -= 40
    for notch in range(2):
        nx = cx + (-80 if notch == 0 else 80)
        ny = cy
        r2 = math.sqrt((x-nx)**2 + (y-ny)**2)
        if 15 < r2 < 35:
            v = max(v, 190)
    v += int(12 * math.sin(x/5) * math.cos(y/7))
    return max(0, min(255, v))

make_png(500, 500, knee_coronal, 'knee_mri_sample_02.png')

# 3. Chest X-ray PA view (lighter with lung fields)
def chest_pa(x, y):
    w, h = 600, 500
    v = 200 + int(15 * math.sin(x/30) * math.cos(y/25))
    # Spine
    if 270 < x < 330:
        v -= 30
    # Left lung - darker
    if 80 < x < 260 and 60 < y < 440:
        dist = min(abs(x-170)//2, abs(y-250)//3)
        dark = int(60 * (1 - dist/60)) if dist < 60 else 0
        v -= max(0, dark)
    # Right lung - darker
    if 340 < x < 520 and 60 < y < 440:
        dist = min(abs(x-430)//2, abs(y-250)//3)
        dark = int(60 * (1 - dist/60)) if dist < 60 else 0
        v -= max(0, dark)
    # Heart (center-left, brighter density)
    if 230 < x < 350 and 180 < y < 320:
        r2 = ((x-290)/40)**2 + ((y-250)/50)**2
        if r2 < 1:
            v += int(40 * (1-r2))
    # Ribs
    for rib in range(100, 440, 30):
        if abs(y - rib) < 3:
            v += 20
    v += int(10 * math.sin(x/7) * math.cos(y/9))
    return max(0, min(255, v))

make_png(600, 500, chest_pa, 'chest_xray_pa_sample.png')

# 4. Chest X-ray lateral view
def chest_lateral(x, y):
    w, h = 500, 600
    v = 190 + int(15 * math.sin(x/25) * math.cos(y/20))
    # Spine (posterior)
    if 380 < x < 430:
        v += 40
    # Sternum (anterior)
    if 50 < x < 90:
        v += 20
    # Lung field
    if 100 < x < 370 and 30 < y < 570:
        v -= int(25 * math.sin((x-235)/60) * math.cos((y-300)/80))
    # Heart (lower anterior)
    if 80 < x < 250 and 280 < y < 420:
        r2 = ((x-165)/60)**2 + ((y-350)/50)**2
        if r2 < 1:
            v += int(35 * (1-r2))
    v += int(8 * math.sin(x/8) * math.cos(y/6))
    return max(0, min(255, v))

make_png(500, 600, chest_lateral, 'chest_xray_lateral_sample.png')

# 5. Prescription-like form (simple version without Pillow - create as BMP)
# BMP is simpler to generate with stdlib
def make_bmp_rgb(width, height, pixels_func, filename):
    row_size = (width * 3 + 3) // 4 * 4
    pixel_data = b''
    for y in range(height-1, -1, -1):  # BMP rows are bottom-up
        row = b''
        for x in range(width):
            r, g, b = pixels_func(x, y)
            row += bytes([b, g, r])  # BMP is BGR
        row += b'\x00' * (row_size - len(row))
        pixel_data += row
    
    file_size = 54 + len(pixel_data)
    header = struct.pack('<2sIHHIIiiHHIIiiII',
        b'BM', file_size, 0, 0, 54,
        40, width, height, 1, 24,  # 24-bit color
        0, len(pixel_data), 2835, 2835, 0, 0)
    
    path = f'{SAMPLES}/{filename}'
    with open(path, 'wb') as f:
        f.write(header + pixel_data)
    size_kb = os.path.getsize(path) / 1024
    print(f"  OK {filename}: {size_kb:.1f} KB")
    return path

def prescription_pixel(x, y):
    w, h = 600, 400
    # White background
    r, g, b = 255, 255, 255
    # Header bar
    if y < 45:
        r, g, b = 26, 82, 118  # Dark blue
    # Lines
    if y in (60, 90, 130, 170, 210, 250, 280, 310, 345, 370):
        if 20 < x < 580:
            r, g, b = 150, 150, 150
    # Check boxes
    if 138 < y < 158 and 25 < x < 45:
        r, g, b = 26, 82, 118  # Filled checkbox for MRI
    if 138 < y < 158 and 100 < x < 120:
        r, g, b = 200, 200, 200  # Empty checkbox
    # Some text simulation marks
    if 50 < y < 70 and 30 < x < 250:
        r, g, b = 50, 50, 50
    if 100 < y < 120 and 30 < x < 350:
        r, g, b = 50, 50, 50
    if 180 < y < 200 and 30 < x < 500:
        r, g, b = 50, 50, 50
    if 220 < y < 240 and 30 < x < 480:
        r, g, b = 50, 50, 50
    if 290 < y < 310 and 30 < x < 400:
        r, g, b = 50, 50, 50
    return r, g, b

make_bmp_rgb(600, 400, prescription_pixel, 'prescription_form.bmp')

print(f"\nDone! All 5 sample images in {SAMPLES}/")
os.system(f"ls -lh {SAMPLES}/*.png {SAMPLES}/*.bmp 2>/dev/null")
