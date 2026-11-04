FROM python:3.12-slim

LABEL org.opencontainers.image.title="ObsiBook — Obsidian Web E-Book Reader"
LABEL org.opencontainers.image.description="100% Read-Only Cross-Device Web E-Book Reader for Obsidian Vaults with Built-in Cloudflare Domain Tunnel"
LABEL org.opencontainers.image.authors="kimmingil"
LABEL org.opencontainers.image.licenses="MIT"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OBSIDIAN_VAULT_PATH=/vault \
    DATA_DIR=/app/data \
    APP_PORT=8500 \
    TZ=Asia/Seoul

WORKDIR /app

# Install curl and official cloudflared binary for built-in Domain & Remote Access Manager
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}" -o /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /vault /app/data && chmod -R 777 /app/data

EXPOSE 8500

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8500/api/health')" || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8500"]
