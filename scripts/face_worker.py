"""Private JSON-lines face extractor. Images and embeddings never go to logs or files."""
import base64
import hashlib
import json
from pathlib import Path
import sys

import cv2 as cv
import numpy as np

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'config/face-models.json').read_text())
paths = {}
for model in manifest['models']:
    target = root / 'models' / model['file']
    if hashlib.sha256(target.read_bytes()).hexdigest() != model['sha256']:
        raise RuntimeError('Face model checksum mismatch. Run face:setup.')
    paths[model['name']] = str(target)

cv.setNumThreads(2)
detector = cv.FaceDetectorYN.create(paths['detector'], '', (320, 320), 0.85, 0.3, 5000)
recognizer = cv.FaceRecognizerSF.create(paths['recognizer'], '')
print(json.dumps({'ready': True, 'model': manifest['id']}), flush=True)

def extract(encoded):
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) > 500000:
        return {'error': 'image_too_large'}
    image = cv.imdecode(np.frombuffer(raw, dtype=np.uint8), cv.IMREAD_COLOR)
    if image is None:
        return {'error': 'invalid_image'}
    h, w = image.shape[:2]
    if w > 1280 or h > 1280 or min(w, h) < 160:
        return {'error': 'invalid_dimensions'}
    detector.setInputSize((w, h))
    faces = detector.detect(image)[1]
    if faces is None:
        return {'count': 0, 'model': manifest['id']}
    if len(faces) != 1:
        return {'count': len(faces), 'model': manifest['id']}
    face = faces[0]
    x, y, fw, fh = [int(v) for v in face[:4]]
    if min(fw, fh) < 80 or x < 0 or y < 0 or x + fw > w or y + fh > h:
        return {'error': 'face_too_small', 'count': 1}
    crop = image[y:y+fh, x:x+fw]
    gray = cv.cvtColor(crop, cv.COLOR_BGR2GRAY)
    if not 35 < float(gray.mean()) < 225 or float(cv.Laplacian(gray, cv.CV_64F).var()) < 18:
        return {'error': 'poor_quality', 'count': 1}
    aligned = recognizer.alignCrop(image, face)
    embedding = recognizer.feature(aligned).reshape(-1).astype(float)
    norm = float(np.linalg.norm(embedding))
    if norm <= 0 or not np.isfinite(embedding).all():
        return {'error': 'invalid_features'}
    embedding /= norm
    eyes = face[4:8].reshape(2, 2)
    eye_distance = float(np.linalg.norm(eyes[0] - eyes[1]))
    yaw = (float(face[8]) - float(eyes[:, 0].mean())) / max(eye_distance, 1)
    return {'count': 1, 'embedding': embedding.tolist(), 'yaw': yaw,
            'box': [x / w, y / h, fw / w, fh / h], 'model': manifest['id']}

for line in sys.stdin:
    request = None
    try:
        if len(line) > 700000:
            raise ValueError('oversized request')
        request = json.loads(line)
        result = extract(request['image'])
    except Exception:
        result = {'error': 'face_processing_failed'}
    print(json.dumps({'id': request.get('id') if request else None, **result}), flush=True)
    request = None
    result = None
    line = ''
