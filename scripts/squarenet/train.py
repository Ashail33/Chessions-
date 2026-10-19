# Trains the square model (empty / white piece / black piece) on the cut-outs
# from build-data.mjs and writes its weights to src/squarenet-weights.js.
# Usage: python train.py OUT [epochs]   (needs torch and numpy)
#
# Photos are kept whole within a split, so the test photos are photos the
# model never saw. Some photos in the sets have boxes that don't belong to
# them; a first round of training finds those (the model disagrees with more
# than 10 of their 64 labels), they are dropped, and the model is trained again.
import base64, json, os, sys
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F

torch.manual_seed(0); np.random.seed(0); torch.set_num_threads(os.cpu_count() or 4)
OUT = sys.argv[1]
EPOCHS = int(sys.argv[2]) if len(sys.argv) > 2 else 80
WEIGHTS_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../src/squarenet-weights.js')

m = json.load(open(f'{OUT}/patches.json')); W, H = m['PATCH_W'], m['PATCH_H']
X = torch.tensor(np.fromfile(f'{OUT}/patches.bin', dtype=np.uint8).reshape(-1, 64, H, W, 3)).permute(0, 1, 4, 2, 3).float() / 255
Y = np.array([x['label'] for x in m['meta']])
SPLIT = np.array([x['split'] for x in m['meta']])
SRC = np.array(['rf' if 'roboflow' in x['source'] else 'dom' for x in m['meta']])

class Net(nn.Module):
    def __init__(s):
        super().__init__()
        s.c1 = nn.Conv2d(3, 8, 3, padding=1); s.c2 = nn.Conv2d(8, 16, 3, padding=1); s.c3 = nn.Conv2d(16, 24, 3, padding=1)
        s.f1 = nn.Linear(24 * (H // 8) * (W // 8), 32); s.f2 = nn.Linear(32, 3)
    def forward(s, x):
        for c in (s.c1, s.c2, s.c3): x = F.max_pool2d(F.relu(c(x)), 2)
        return s.f2(F.relu(s.f1(x.flatten(1))))

def normalise(x):
    # Each colour channel over the whole board, as squarenet.js does.
    mu = x.mean(dim=(1, 3, 4), keepdim=True); sd = x.std(dim=(1, 3, 4), keepdim=True) + 1e-3
    return (x - mu) / sd

def batch(idx, aug):
    x = X[idx].clone()
    if aug:
        b = len(idx)
        # Exposure, white balance, contrast.
        gain = torch.exp(torch.randn(b, 1, 3, 1, 1) * 0.15) * torch.exp(torch.randn(b, 1, 1, 1, 1) * 0.3)
        x = (x * gain + torch.randn(b, 1, 3, 1, 1) * 0.05).clamp(0, 1) ** torch.exp(torch.randn(b, 1, 1, 1, 1) * 0.25)
        # Other board colours: swap channels and mix them a little (white and
        # black pieces stay white and black).
        for k in range(b):
            if np.random.rand() < 0.6:
                M = torch.eye(3)[torch.randperm(3)] * 0.8 + torch.rand(3, 3) * 0.066
                x[k] = torch.einsum('ij,sjhw->sihw', M / M.sum(1, keepdim=True), x[k])
            if np.random.rand() < 0.15:
                x[k] = x[k].mean(1, keepdim=True).expand_as(x[k]).clone()
    x = normalise(x).flatten(0, 1); y = torch.tensor(Y[idx]).flatten()
    if aug:
        x = x + torch.randn_like(x) * 0.08
        flip = torch.rand(len(x)) < 0.5; x[flip] = x[flip].flip(-1)
        x = torch.roll(x, (np.random.randint(-2, 3), np.random.randint(-2, 3)), (2, 3))
    k = y >= 0
    return x[k], y[k]

def confusion(net, idx):
    net.eval()
    with torch.no_grad():
        x, y = batch(idx, False); p = net(x).argmax(1)
    c = np.zeros((3, 3), int)
    np.add.at(c, (y.numpy(), p.numpy()), 1)
    return c

def train(split):
    net = Net(); tr = np.where(split == 'train')[0]; va = np.where(split == 'valid')[0]
    cnt = np.bincount(Y[tr][Y[tr] >= 0], minlength=3)
    wts = torch.tensor((cnt.sum() / cnt / 3) ** 0.5, dtype=torch.float32)
    opt = torch.optim.AdamW(net.parameters(), 3e-3, weight_decay=1e-3)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, 3e-3, total_steps=EPOCHS * (len(tr) // 8 + 1))
    best = (1e9, None)
    for ep in range(EPOCHS):
        net.train(); np.random.shuffle(tr)
        for i in range(0, len(tr), 8):
            x, y = batch(tr[i:i + 8], True)
            loss = F.cross_entropy(net(x), y, weight=wts, label_smoothing=0.05)
            opt.zero_grad(); loss.backward(); opt.step(); sched.step()
        if ep % 5 == 4 or ep == EPOCHS - 1:
            c = confusion(net, va); err = c.sum() - np.trace(c)
            print(f'  epoch {ep + 1}: {err} of {c.sum()} validation squares wrong', flush=True)
            if err <= best[0]: best = (err, {k: v.clone() for k, v in net.state_dict().items()})
    net.load_state_dict(best[1])
    return net

print('round 1'); net = train(SPLIT)
bad = [i for i in range(len(Y)) if (lambda c: c.sum() - np.trace(c))(confusion(net, [i])) > 10]
print('photos whose labels the model mostly disagrees with:', len(bad))
split = SPLIT.copy(); split[bad] = 'dropped'
print('round 2'); net = train(split)
for name, sel in [('all', split == 'test'), ('roboflow board', (split == 'test') & (SRC == 'rf')), ('dominique board', (split == 'test') & (SRC == 'dom'))]:
    c = confusion(net, np.where(sel)[0])
    print(f'test, {name}: {np.trace(c) / c.sum():.4f} of squares right; rows empty/white/black true, columns read: {c.tolist()}')

sd = net.state_dict(); order = ['c1.weight', 'c1.bias', 'c2.weight', 'c2.bias', 'c3.weight', 'c3.bias', 'f1.weight', 'f1.bias', 'f2.weight', 'f2.bias']
flat = np.concatenate([sd[k].numpy().astype('<f4').ravel() for k in order])
open(WEIGHTS_JS, 'w').write(f"""// Weights of the square model (squarenet.js), written by
// scripts/squarenet/train.py: {len(flat)} float32 values, little-endian, base64.
export const SHAPES = {json.dumps({k: list(sd[k].shape) for k in order})};
export const WEIGHTS = '{base64.b64encode(flat.tobytes()).decode()}';
""")
print('wrote', WEIGHTS_JS)
