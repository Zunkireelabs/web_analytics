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
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install torch --index-url https://download.pytorch.org/whl/cpu
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
