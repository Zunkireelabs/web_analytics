# syntax=docker/dockerfile:1
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# sentence-transformers pulls in torch; installing the CPU-only wheel first
# keeps pip from also downloading torch's default CUDA/GPU dependencies
# (several GB of nvidia_* wheels this CPU-only deploy server never uses).
#
# --mount=type=cache (not --no-cache-dir) on both installs: a BuildKit cache
# mount persists pip's downloaded wheels (scipy, torch, tokenizers,
# transformers, sentence-transformers — the packages that timed out the
# 2026-09-16 staging deploy) across builds, independent of this image's own
# layer cache. It survives the `docker system prune` that wipes image layers
# and forced a full from-network re-download on 2026-08-13, so a cold-cache
# rebuild reinstalls from the local cache instead of re-fetching every wheel
# over the network. `docker builder prune` is the only thing that clears it.
#
# Retried up to 3 times (2026-09-16, second failure of the same kind): the
# cache mount above only helps once a wheel has been downloaded once — it
# does nothing for the FIRST download of a new/updated dependency, and this
# build still failed on a fresh network blip mid-download:
#   pip._vendor.urllib3.exceptions.ProtocolError: ("Connection broken:
#   BrokenPipeError(32, 'Broken pipe')", ...)
# That error is raised from inside response.read() while STREAMING an
# already-established download (confirmed against pip's own traceback), not
# while opening the connection — so pip's own `--retries` flag does not cover
# it: that flag only retries a failed connection ATTEMPT, never a stream that
# broke partway through. A shell-level retry restarts pip entirely, and the
# cache mount makes every retry after the first cheap (only the one wheel
# that broke needs re-fetching; everything pip already saved to
# /root/.cache/pip is reused instantly). Fails the build for real (`exit 1`)
# only after all 3 attempts are exhausted — a silent success on a still-empty
# install would be worse than a clear, actionable failure.
RUN --mount=type=cache,target=/root/.cache/pip \
    n=0; until [ "$n" -ge 3 ]; do \
      pip install torch --index-url https://download.pytorch.org/whl/cpu && exit 0; \
      n=$((n + 1)); echo "pip install (torch) failed — attempt $n/3"; sleep 5; \
    done; \
    echo "pip install (torch) failed after 3 attempts" >&2; exit 1
RUN --mount=type=cache,target=/root/.cache/pip \
    n=0; until [ "$n" -ge 3 ]; do \
      pip install -r requirements.txt && exit 0; \
      n=$((n + 1)); echo "pip install (requirements.txt) failed — attempt $n/3"; sleep 5; \
    done; \
    echo "pip install (requirements.txt) failed after 3 attempts" >&2; exit 1

COPY . .

EXPOSE 8000

CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
