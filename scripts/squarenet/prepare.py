# Downloads the two labelled photo sets and writes, into OUT:
#   img/<name>.rgb.gz   each photo as raw RGB bytes, gzipped
#   labels.json         per photo: size, split, source and every piece's box
# Usage: python prepare.py OUT   (needs pyarrow and pillow)
import io, json, gzip, os, sys, urllib.request
import pyarrow.parquet as pq
from PIL import Image

OUT = sys.argv[1]
os.makedirs(f'{OUT}/img', exist_ok=True)
HF = 'https://huggingface.co/datasets'
SETS = {
    # Public domain. Categories 2-7 are black pieces, 8-13 white.
    'rf': ('roboflow-chess-pieces (public domain)', {
        'train': f'{HF}/Francesco/chess-pieces-mjzgj/resolve/main/data/train-00000-of-00001-bcd13d50cd74d2c1.parquet',
        'valid': f'{HF}/Francesco/chess-pieces-mjzgj/resolve/main/data/validation-00000-of-00001-cb162a365c7941ff.parquet',
        'test': f'{HF}/Francesco/chess-pieces-mjzgj/resolve/main/data/test-00000-of-00001-0b2f1390889e6971.parquet'}),
    # CC BY 4.0. Classes 0-5 are black pieces, 6-11 white; boxes in YOLO form.
    'dom': ('chess-piece-detection by gustoguardian (CC BY 4.0)', {
        s: f'{HF}/dopaul/chess-pieces-dominique/resolve/main/data/{s}-00000-of-00001.parquet' for s in ['train', 'valid', 'test']}),
}

def rows(url):
    # Kept in OUT/raw, so a rerun doesn't fetch them again.
    path = f"{OUT}/raw/{url.split('/datasets/')[1].replace('/', '_')}"
    os.makedirs(f'{OUT}/raw', exist_ok=True)
    for attempt in range(4):
        if os.path.exists(path): break
        try:
            urllib.request.urlretrieve(url, path + '.part'); os.rename(path + '.part', path)
        except OSError as e:
            print('retrying download:', e, flush=True)
    return pq.read_table(path).to_pylist()

def save(name, data):
    im = Image.open(io.BytesIO(data)).convert('RGB')
    with gzip.open(f'{OUT}/img/{name}.rgb.gz', 'wb', 1) as f:
        f.write(im.tobytes())
    return im.size

out = []
for key, (source, urls) in SETS.items():
    for split, url in urls.items():
        for r in rows(url):
            if key == 'rf':
                o = r['objects']
                if len(o['category']) < 4: continue  # close-ups of single pieces
                name = f"rf-{split}-{r['image_id']}"
                w, h = save(name, r['image']['bytes'])
                pieces = [{'colour': 'w' if c >= 8 else 'b' if c >= 2 else '?', 'box': b} for c, b in zip(o['category'], o['bbox'])]
            else:
                a = r['annotations']
                if len(a['class_id']) < 4: continue
                name = f"dom-{split}-{r['image_id']}".replace('/', '_')
                w, h = save(name, r['image']['bytes'])
                pieces = [{'colour': 'b' if c < 6 else 'w', 'box': [(x - bw / 2) * w, (y - bh / 2) * h, bw * w, bh * h]}
                          for c, x, y, bw, bh in zip(a['class_id'], a['x_center'], a['y_center'], a['width'], a['height'])]
            out.append({'file': name, 'split': split, 'w': w, 'h': h, 'source': source, 'pieces': pieces})
        print(key, split, len(out), flush=True)
json.dump(out, open(f'{OUT}/labels.json', 'w'))
