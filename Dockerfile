# ===========================================================================
# J.A.R.V.I.S. Level 10 — Ubiquitous Sentience
# Multi-stage Python build -> minimal slim runtime (<150 MB final image)
# Target: Fly.io Machines (shared-cpu-1x 256MB) multi-region.
#
# Stage 1 — build: install pinned deps into a lean venv w/ build cache.
# Stage 2 — runtime: python slim + ONLY the venv and app sources.
# ===========================================================================
FROM python:3.12-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Build-time base for wheels (cryptography compiles C); slim has none by default.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libffi-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY requirements.txt ./
RUN python -m venv --copies /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

# ---------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

# Security/hardening: non-root user, no bash shell, minimal deps for healthcheck.
RUN useradd --create-home --shell /usr/sbin/nologin jarvis \
    && apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only the virtualenv from the build stage, then the app source.
COPY --from=builder /opt/venv /opt/venv
COPY --chown=jarvis:jarvis . /app

# OOM-killer protection: run app as its own user; python reserves address space
# but RSS stays within the 256MB instance. To reduce RSS:
ENV PYTHONUNBUFFERED=1 \
    PYTHONHASHSEED=0 \
    OMP_NUM_THREADS=1 \
    MPLCONFIGDIR=/tmp \
    PATH="/opt/venv/bin:$PATH"

# make entrypoint + healthcheck executable
RUN chmod +x /app/healthcheck.sh /app/app.py 2>/dev/null || true

USER jarvis
EXPOSE 8080

# Default: run the ASGI app (Uvicorn single worker). Override CMD for the L9
# legacy monitor or an ephemeral worker by passing a different command.
CMD ["uvicorn", "api.webhook:app", "--host", "0.0.0.0", "--port", "8080", \
     "--workers", "1", "--no-access-log"]