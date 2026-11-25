"""Install checksum-pinned OpenCV Zoo models. No staff images are downloaded or sent."""
import hashlib
import json
from pathlib import Path
import urllib.request
import time

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'config/face-models.json').read_text())
out = root / 'models'
out.mkdir(exist_ok=True)
for model in manifest['models']:
    target = out / model['file']
    if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() != model['sha256']:
        temporary = target.with_suffix('.download')
        for attempt in range(10):
            try:
                offset = temporary.stat().st_size if temporary.exists() else 0
                request = urllib.request.Request(model['url'], headers={'Range': f'bytes={offset}-'} if offset else {})
                with urllib.request.urlopen(request, timeout=45) as response:
                    resume = offset and response.status == 206
                    with temporary.open('ab' if resume else 'wb') as stream:
                        while block := response.read(256 * 1024):
                            stream.write(block)
                if hashlib.sha256(temporary.read_bytes()).hexdigest() != model['sha256']:
                    temporary.unlink(missing_ok=True)
                    raise RuntimeError(f"Checksum mismatch: {model['file']}")
                temporary.replace(target)
                break
            except Exception:
                if attempt == 9:
                    raise
                print(f"Retrying {model['file']} ({attempt + 1}/10); partial bytes retained", flush=True)
                time.sleep(3)
    license_file = out / f"face-{model['name']}.LICENSE.txt"
    if not license_file.exists():
        with urllib.request.urlopen(model['license_url'], timeout=30) as response:
            license_file.write_bytes(response.read())
    print(f"Verified {model['file']} ({model['license']})", flush=True)
