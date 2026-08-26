#!/bin/bash
# CLT Quick Start – Linux/macOS/WSL

set -e

echo "=== Centrica Logistics Control Tower ==="
echo "Starting in DEMO_MODE (no database required)"

# Backend
echo "[1/4] Setting up Python environment..."
cd backend
python3 -m venv .venv 2>/dev/null || true
source .venv/bin/activate
pip install -r requirements.txt -q

echo "[2/4] Starting FastAPI backend on http://localhost:8000..."
DEMO_MODE=true uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!
sleep 2

# Frontend
cd ../frontend
echo "[3/4] Installing frontend dependencies..."
npm install --silent

echo "[4/4] Starting React frontend on http://localhost:5173..."

echo ""
echo "=== CLT is running ==="
echo "Frontend:  http://localhost:5173"
echo "API Docs:  http://localhost:8000/docs"
echo "Health:    http://localhost:8000/health"
echo ""
echo "Demo login: supply.director@centrica.com / demo1234"
echo "Press Ctrl+C to stop"
echo ""

VITE_API_URL=http://localhost:8000 VITE_WS_URL=ws://localhost:8000 npm run dev

kill $BACKEND_PID 2>/dev/null || true
