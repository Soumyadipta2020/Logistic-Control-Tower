FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libpq-dev curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# --workers 1 is load-bearing, not a default. All real-time state (the synthetic
# world, agent decisions, WebSocket connections) lives in this process's memory,
# so a second worker serves a second, divergent world. app.main._assert_single_process
# refuses to start if WEB_CONCURRENCY/UVICORN_WORKERS says otherwise.
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1
