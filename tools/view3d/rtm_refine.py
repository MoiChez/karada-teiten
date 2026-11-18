# RTMPose で 2D の点を細かくする（アプリの src/pose/rtmMerge.ts と同じ決まり）。detect_dataset_rtm.py と eval_real.py で使う
import cv2
import numpy as np
import onnxruntime as ort


def session(path):
    return ort.InferenceSession(path, providers=['CPUExecutionProvider'])


W_IN, H_IN = 192, 256
MEAN = np.array([123.675, 116.28, 103.53], np.float32)
STD = np.array([58.395, 57.12, 57.375], np.float32)
MP_FROM_HALPE = [(0, 0), (2, 1), (5, 2), (7, 3), (8, 4), (11, 5), (12, 6), (13, 7), (14, 8), (15, 9), (16, 10), (23, 11), (24, 12), (25, 13), (26, 14), (27, 15), (28, 16), (29, 24), (30, 25), (31, 20), (32, 21)]
FOLLOW = [(1, 2), (3, 2), (4, 5), (6, 5), (9, 0), (10, 0), (17, 15), (19, 15), (21, 15), (18, 16), (20, 16), (22, 16)]
MIN_SCORE = 0.3


def refine(sess, img, pts):
    """pts: 33 × [x(0..1), y(0..1), 見えている度合い]。置き換えた点を返す"""
    h, w = img.shape[:2]
    xs = [pts[m][0] * w for m, _ in MP_FROM_HALPE]
    ys = [pts[m][1] * h for m, _ in MP_FROM_HALPE]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    if not (x1 > x0 and y1 > y0):
        return pts
    cw, ch = (x1 - x0) * 1.25, (y1 - y0) * 1.25
    if cw * H_IN > ch * W_IN:
        ch = cw * H_IN / W_IN
    else:
        cw = ch * W_IN / H_IN
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    src = np.float32([[cx - cw / 2, cy - ch / 2], [cx + cw / 2, cy - ch / 2], [cx - cw / 2, cy + ch / 2]])
    M = cv2.getAffineTransform(src, np.float32([[0, 0], [W_IN, 0], [0, H_IN]]))
    crop = cv2.warpAffine(img, M, (W_IN, H_IN), flags=cv2.INTER_LINEAR)
    x = (cv2.cvtColor(crop, cv2.COLOR_BGR2RGB).astype(np.float32) - MEAN) / STD
    sx, sy = sess.run(None, {'input': x.transpose(2, 0, 1)[None]})
    px, py = sx[0].argmax(1) / 2.0, sy[0].argmax(1) / 2.0
    score = np.minimum(sx[0].max(1), sy[0].max(1))
    out = [list(p) for p in pts]
    delta = {}
    for m, k in MP_FROM_HALPE:
        if score[k] < MIN_SCORE:
            continue
        nx = (cx - cw / 2 + px[k] * cw / W_IN) / w
        ny = (cy - ch / 2 + py[k] * ch / H_IN) / h
        delta[m] = (nx - out[m][0], ny - out[m][1])
        out[m][0], out[m][1] = nx, ny
    for m, base in FOLLOW:
        if base in delta:
            out[m][0] += delta[base][0]
            out[m][1] += delta[base][1]
    return [[round(p[0], 5), round(p[1], 5), p[2]] for p in out]
