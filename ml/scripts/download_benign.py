# ml/scripts/download_benign.py
import random, time, pathlib, collections
import requests

OUT = pathlib.Path("ml/data/raw/pypi_benign")
OUT.mkdir(parents=True, exist_ok=True)

TOP_URL = "https://hugovk.github.io/top-pypi-packages/top-pypi-packages.min.json"
session = requests.Session()
session.headers["User-Agent"] = "glasshouse-research/0.1 (benign dataset download)"

print("Fetching top packages list...")
top = session.get(TOP_URL, timeout=30).json()
names = [r["project"] for r in top["rows"]]
print(f"  {len(names)} packages in list")

random.seed(42)
sample = names[:1500] + random.sample(names[1500:], 1500)  # popular + long tail
total = len(sample)

stats = collections.Counter()
failures = []          # (name, reason) for later inspection
start = time.time()

for i, n in enumerate(sample, 1):
    status = "ok"
    try:
        r = session.get(f"https://pypi.org/pypi/{n}/json", timeout=20)
        r.raise_for_status()
        info = r.json()

        sdist = next((u for u in info["urls"] if u["packagetype"] == "sdist"), None)
        if sdist is None:
            status = "no_sdist"
        else:
            dest = OUT / sdist["filename"]
            if dest.exists():
                status = "already_have"
            else:
                f = session.get(sdist["url"], timeout=60)
                f.raise_for_status()
                dest.write_bytes(f.content)
                status = "downloaded"
    except requests.HTTPError as e:
        status = "http_error"
        failures.append((n, str(e)))
    except requests.RequestException as e:
        status = "network_error"
        failures.append((n, type(e).__name__))
    except Exception as e:
        status = "other_error"
        failures.append((n, f"{type(e).__name__}: {e}"))

    stats[status] += 1

    elapsed = time.time() - start
    eta = elapsed / i * (total - i)
    print(f"[{i}/{total}] {n:<35} {status:<13} "
          f"elapsed {elapsed/60:4.1f}m  ETA {eta/60:4.1f}m")

    time.sleep(0.2)  # be polite to PyPI (now runs on failures too)

print("\n=== Summary ===")
for k, v in stats.most_common():
    print(f"  {k:<14} {v}")
print(f"  total time     {(time.time()-start)/60:.1f} min")
print(f"  files on disk  {len(list(OUT.iterdir()))}")

if failures:
    log = OUT.parent / "pypi_benign_failures.txt"
    log.write_text("\n".join(f"{n}\t{why}" for n, why in failures), encoding="utf-8")
    print(f"  failure log -> {log}")
    