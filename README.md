# 🏢 ABC Logistics Control Tower (CLT)

[![FastAPI](https://img.shields.io/badge/FastAPI-0.111.0-009688?style=flat-square&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![React](https://img.shields.io/badge/React-18.3.1-61DAFB?style=flat-square&logo=react&logoColor=black)](https://reactjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4.5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-5.2.13-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vitejs.dev)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white)](https://python.org)
[![License](https://img.shields.io/badge/License-Proprietary-blue?style=flat-square)](#)

> **Enterprise-grade, AI-orchestrated Supply Chain & Field Service Logistics Control Tower with autonomous resolution agents, real-time IoT telemetry, multi-echelon network simulation, and predictive optimization.**

---

## 📑 Table of Contents

- [Overview](#-overview)
- [System Architecture](#-system-architecture)
- [Key Modules & Capabilities](#-key-modules--capabilities)
- [ATLAS: Autonomous AI Agent Engine](#-atlas-autonomous-ai-agent-engine)
- [Tech Stack](#-tech-stack)
- [Quickstart Guide](#-quickstart-guide)
  - [Option 1: One-Click Python Launcher (Recommended)](#option-1-one-click-python-launcher-recommended)
  - [Option 2: Docker Compose](#option-2-docker-compose)
  - [Option 3: Manual Local Setup](#option-3-manual-local-setup)
- [Environment Configuration](#-environment-configuration)
- [Demo Accounts & RBAC Roles](#-demo-accounts--rbac-roles)
- [API & WebSocket Channels](#-api--websocket-channels)
- [Repository Structure](#-repository-structure)
- [Simulation & Cadence Engine](#-simulation--cadence-engine)
- [License & Acknowledgements](#-license--acknowledgements)

---

## 🌟 Overview

The **ABC Logistics Control Tower (CLT)** is an end-to-end intelligent operational cockpit designed for high-consequence field logistics, parts fulfillment, inventory distribution, and engineer dispatch networks.

Integrating real-time geospatial tracking, multi-tier inventory visibility, automated exception management, and autonomous AI reasoning, CLT empowers operators to shift from **reactive firefighting** to **predictive, autonomous supply chain orchestration**.

### 🧭 System Architecture & Decision Flow

```text
  +-----------------------------------------------------------------------+
  |              Web Cockpit  /  Mobile App  /  Voice  /  API             |
  +-----------------------------------+-----------------------------------+
                                      |
                                      v
  +-----------------------------------------------------------------------+
  |                         FastAPI API Gateway                           |
  |               JWT Auth  /  RBAC  /  WebSocket Feeds                   |
  +-----------------------------------+-----------------------------------+
                                      |
                                      v
  +-----------------------------------------------------------------------+
  |                        ATLAS AI Orchestrator                          |
  |                   Intent  -->  Plan  -->  Execute                     |
  +-----------------------------------+-----------------------------------+
                                      |
         +-------------+--------------+--------------+-------------+
         |             |              |              |             |
         v             v              v              v             v
   +-----------+ +-----------+  +-----------+  +-----------+ +-----------+
   |Visibility | |  Demand   |  | Transport |  | Risk & SLA| |  ESG/Eco  |
   |   Agent   | |Inventory  |  |  Routing  |  |Exceptions | |Reduction  |
   +-----+-----+ +-----+-----+  +-----+-----+  +-----+-----+ +-----+-----+
         |             |              |              |             |
         +-------------+--------------+--------------+-------------+
                                      |
                                      v
  +-----------------------------------------------------------------------+
  |                       Policy & Governance Gateway                     |
  |        Safety Guardrails  /  < £25k Auto-Execute  /  Audit Logs       |
  +-----------------------------------+-----------------------------------+
                                      |
         +-------------+--------------+--------------+-------------+
         |             |              |              |             |
         v             v              v              v             v
    [WMS / TMS]   [Smart Lockers] [Van Fleet]   [Salesforce FS]  [ERP / SAP]
```

### 💼 How Leaders Use the Control Tower

| Leadership Role | Key Questions Answered | Strategic Action Enabled |
|---|---|---|
| **Chief Operating Officer (COO)** | *"Are our field engineers meeting customer SLAs today without cost overruns?"* | Real-time visibility into OTIF, regional bottlenecks, and automated SLA breach prevention. |
| **VP of Supply Chain** | *"Where is excess inventory trapped, and which parts risk stockouts?"* | Autonomous multi-tier stock rebalancing between central RDCs, regional depots, and engineer vans. |
| **Finance Director (CFO)** | *"How much are emergency shipments and penalty claims costing us?"* | Automatic containment of expedited freight premiums and proactive SLA penalty avoidance. |
| **Chief Sustainability Officer (CSO)** | *"Are we on track for net-zero carbon reduction and circular parts reuse?"* | Live Scope 1/2/3 emissions tracking, green routing, and WEEE-compliant parts reconditioning metrics. |

---

## 🚀 Key Modules & Capabilities

### 1. 📊 Executive Dashboard & Real-Time KPIs
- High-level executive overview tracking **On-Time In-Full (OTIF)**, **First-Time Fix Rates (FTFR)**, **Stockout Risk Scores**, **P1 Incidents**, **Fleet Utilization**, and **Transport Spend Variance**.
- Live trend analytics with comparative historical benchmarks and sparkline distributions.

### 2. 🗺️ End-to-End Visibility & Live Map
- Interactive geospatial tracking built on **Leaflet** with hardware-accelerated rendering.
- Live positions of **Regional Distribution Centers (RDCs)**, **Local Depots**, **Locker Banks**, and **Field Engineer Vans**.
- Real-time GPS movements broadcasted via low-latency WebSockets with van stock health overlays and route vectoring.

### 3. 📦 Demand Forecasting & Multi-Tier Inventory
- Multi-echelon stock level monitoring across RDCs, depots, smart locker networks, and mobile van stocks.
- Predictive replenishment alerts, safety stock dynamically scaled by lead-time volatility, and automated reorder triggers.

### 4. 🚚 Transport & Fleet Operations
- Vehicle load factor optimization, transit line tracking, dispatch scheduling, and inter-hub transfers.
- Carrier performance scorecards, demurrage tracking, and deadhead / empty-mile reduction algorithms.

### 5. ⚠️ Disruption & Exception Management
- Automated detection and categorization of P1, P2, and P3 incidents (delayed shipments, stockouts, van stock mismatches, temperature breaches).
- One-click resolution playbooks (emergency courier re-routing, locker failover drops, supplier expedite orders, peer van-to-van parts transfers).

### 6. 🤖 ATLAS AI Command Center
- Intelligent logistics co-pilot with autonomous execution capabilities, voice recognition, and real-time operational reasoning.
- Context-aware querying: inspect current bottleneck states, ask for root causes, or command complex multi-step supply actions.

### 7. 🧪 What-If Supply Chain Simulator
- Stress-test the logistics network under extreme operational conditions:
  - *Severe Weather Disruption & Road Closures*
  - *Supplier Lead Time Spikes & Factory Shutdowns*
  - *Cold-Chain Temperature Sensor Anomalies*
  - *Spike in Emergency Boiler Replacement Demand*
- Real-time instant recalculation of impact on SLA adherence, costs, and recovery times.

### 8. 📡 IoT Telemetry & Cold Chain Monitoring
- Real-time temperature, humidity, and vibration monitoring for temperature-sensitive parts and warehouse storage zones.
- Immediate threshold alerts with automated quarantine routing.

### 9. 🌱 Sustainability & ESG Intelligence
- Live computation of **Scope 1, Scope 2, and Scope 3 carbon emissions**.
- Fleet electrification tracking, EV charging optimization, and green routing impact scores.

---

## 🤖 ATLAS: Autonomous AI Agent Engine

**ATLAS** (Autonomous Tactical Logistics Agent System) serves as the autonomous brain of the Control Tower.

```text
  +-----------------------------------------------------------------------+
  |                     Synthetic State Engine (Tick)                     |
  |                Periodic Cadence Snapshot & Live Telemetry             |
  +-----------------------------------+-----------------------------------+
                                      |
                                      v
  +-----------------------------------------------------------------------+
  |                           ATLAS Agent Engine                          |
  |             Detects Bottlenecks, P1 Stockouts & SLA Risks             |
  +-----------------------------------+-----------------------------------+
                                      |
                    +-----------------+-----------------+
                    |                                   |
         (AI Reasoning Active)                (Deterministic Mode)
                    |                                   |
                    v                                   v
  +-----------------------------------+ +---------------------------------+
  |      Multi-LLM Strategy Layer     | |   Rule-Based Expert System      |
  | Gemini / Claude / GPT / DeepSeek  | |     Operational Playbooks       |
  +-----------------+-----------------+ +---------------+-----------------+
                    |                                   |
                    +-----------------+-----------------+
                                      |
                                      v
  +-----------------------------------------------------------------------+
  |                      Policy & Safety Gating Engine                    |
  |          Evaluates Spend Limits, Autonomy Class & Impact Risk         |
  +-----------------------------------+-----------------------------------+
                                      |
                 +--------------------+--------------------+
                 |                                         |
     [Safe / < £25k Threshold]                 [High-Risk / Exceeds Limit]
                 |                                         |
                 v                                         v
  +-------------------------------+         +-----------------------------+
  |    Autonomous Self-Execution  |         |   Operator Approvals Inbox  |
  |  • Re-route / Balance Stock   |         |   Human-in-the-Loop Review  |
  |  • Mutates Live World State   |         |   Approve / Reject Action   |
  +---------------+---------------+         +--------------+--------------+
                  |                                        |
                  +-------------------+--------------------+
                                      |
                                      v
  +-----------------------------------------------------------------------+
  |                    Real-Time WebSocket Broadcast                      |
  |                 Instant Update to Operator Cockpit                    |
  +-----------------------------------------------------------------------+
```

### Multi-Provider Reasoning
ATLAS dynamically routes requests across leading foundation models or works completely offline:
- **Direct Google AI Studio**: Native integration with Gemini models (`gemini-2.5-flash`, `gemini-1.5-pro`, `gemini-3.5-flash-lite`).
- **OpenRouter Gateway**: Connects with Anthropic Claude, OpenAI GPT-4o, DeepSeek-V3/R1, Qwen, and Grok.
- **Zero-Key Deterministic Fallback**: If no API keys are provided or offline mode is toggled, ATLAS executes grounded, deterministic domain heuristics.
- **Voice Operations**: Integrated Speech-to-Text (STT) and Text-to-Speech (TTS) audio communication for field engineers and dispatchers.

---

## 🛠️ Tech Stack

| Layer | Technologies |
|---|---|
| **Backend Framework** | [FastAPI](https://fastapi.tiangolo.com/) (Async Python 3.10+), Pydantic v2, Uvicorn |
| **Scheduler & Cadence** | [APScheduler](https://apscheduler.readthedocs.io/) (Interval-based realistic state updates) |
| **Database & ORM** | [SQLAlchemy 2.0](https://www.sqlalchemy.org/) with Async Engine ([AsyncPG](https://github.com/MagicStack/asyncpg) / [aiosqlite](https://github.com/omnilib/aiosqlite)) |
| **Caching & PubSub** | [Redis 7](https://redis.io/) / In-memory WebSockets with JSON streaming |
| **Authentication** | JWT (HS256) with Passlib Bcrypt & Granular RBAC Permissions |
| **Frontend Framework** | [React 18](https://reactjs.org/) + [TypeScript 5](https://www.typescriptlang.org/) + [Vite 5](https://vitejs.dev/) |
| **State & Data Fetching** | [Zustand](https://github.com/pmndrs/zustand) + [TanStack React Query v5](https://tanstack.com/query/latest) |
| **Maps & Geospatial** | [Leaflet](https://leafletjs.com/) + [React-Leaflet](https://react-leaflet.js.org/) |
| **Charts & Visualizations** | [Recharts](https://recharts.org/) + [Lucide Icons](https://lucide.dev/) |
| **Containerization** | [Docker](https://www.docker.com/) & Docker Compose (Multi-stage builds) |

---

## ⚡ Quickstart Guide

### Prerequisites
- **Python 3.10+** (with `pip`)
- **Node.js 18+** & `npm`
- *(Optional)* **Docker & Docker Compose** (for containerized setup with Postgres & Redis)

---

### Option 1: One-Click Python Launcher (Recommended)

The easiest way to run the entire stack locally with zero database setup required (defaults to SQLite + in-memory state engine):

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Soumyadipta2020/Logistic-Control-Tower.git
   cd Logistic-Control-Tower
   ```

2. **Install dependencies**:
   ```bash
   # Backend dependencies
   pip install -r backend/requirements.txt

   # Frontend dependencies
   cd frontend
   npm install
   cd ..
   ```

3. **Launch the orchestrator**:
   ```bash
   python app.py
   ```

> 💡 `app.py` starts both the FastAPI backend on `http://127.0.0.1:8000` and the Vite frontend on `http://localhost:5173`, streaming unified logs and automatically opening your default web browser.

---

### Option 2: Docker Compose

Spin up the complete multi-service production-ready stack (FastAPI Backend + Vite Frontend + PostgreSQL 16 + Redis 7):

```bash
# Start all services in the background
docker compose up --build

# To run in detached mode
docker compose up -d
```

- **Frontend**: `http://localhost:5173`
- **Backend API**: `http://localhost:8000`
- **Interactive Swagger API Docs**: `http://localhost:8000/docs`

---

### Option 3: Manual Local Setup

#### 1. Backend Setup
```bash
cd backend
python -m venv .venv

# On Linux/macOS:
source .venv/bin/activate
# On Windows:
.venv\Scripts\activate

pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

#### 2. Frontend Setup
```bash
cd frontend
npm install
npm run dev
```

---

## ⚙️ Environment Configuration

Create a `.env` file in the root directory (or copy from `.env.example`):

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `sqlite+aiosqlite:///./clt_local.db` | Database connection string (PostgreSQL or SQLite) |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis caching and pub/sub URL |
| `DEMO_MODE` | `true` | Enables continuous realistic synthetic supply network simulation |
| `ENVIRONMENT` | `development` | `development` or `production` (tightens CORS and logging) |
| `SECRET_KEY` | `clt-super-secret-key-change-in-production` | Secret key for signing session JWT tokens |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `480` | JWT token lifespan in minutes |
| `GOOGLE_API_KEY` | `""` | Optional: Google AI Studio API key for native Gemini reasoning |
| `OPENROUTER_API_KEY` | `""` | Optional: OpenRouter API key for Claude, GPT, DeepSeek, etc. |
| `LLM_MODEL` | `gemini-3.5-flash-lite` | Default reasoning model for ATLAS AI Engine |
| `LLM_ENABLED` | `true` | Set to `false` for 100% deterministic rule-based execution |
| `VITE_API_URL` | `http://localhost:8000` | Backend API URL used by the frontend |
| `VITE_WS_URL` | `ws://localhost:8000` | WebSocket endpoint for real-time telemetry streaming |

---

## 👥 Demo Accounts & RBAC Roles

The system features granular **Role-Based Access Control (RBAC)**. You can log in using any of the pre-configured demo users below (all use password: `demo1234`):

| Email | Role | Name | Permissions & Scope |
|---|---|---|---|
| `supply.director@abc.com` | **Supply Chain Director** | Sarah Chen | Full executive authority (`read:all`, `write:all`, `export:all`) |
| `logistics.ops@abc.com` | **Logistics Operations** | James Okafor | Operations, exceptions, transfers, locker overrides, PO authorizations |
| `field.dispatcher@abc.com` | **Field Dispatcher** | Maria Santos | Field engineer dispatch, van-to-van stock transfers, locker reservations |
| `finance.analyst@abc.com` | **Finance Analyst** | David Williams | Cost tracking, SLA penalty analysis, financial exports |
| `engineer@abc.com` | **Field Engineer** | Tom Briggs | Assigned jobs, personal van stock health, job completion |
| `sustainability@abc.com` | **Sustainability Lead** | Emma Clarke | Scope 1/2/3 carbon analytics, reverse logistics, fleet electrification |
| `procurement@abc.com` | **Procurement Manager** | Raj Patel | Supplier performance scorecards, purchase order creation, lead time audits |

---

## 📡 API & WebSocket Channels

### REST API Endpoints
Interactive OpenAPI documentation is available at `http://localhost:8000/docs`.

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/auth/login` | `POST` | Authenticate user and issue JWT bearer token |
| `/api/v1/auth/demo-users` | `GET` | List available demo users and role configurations |
| `/api/v1/visibility/summary` | `GET` | Retrieve network-wide operational status snapshot |
| `/api/v1/visibility/map-data` | `GET` | Geospatial nodes (warehouses, depots, vans, lockers) |
| `/api/v1/demand/forecast` | `GET` | Multi-tier demand forecast curves and safety stock levels |
| `/api/v1/transport/fleet` | `GET` | Active vehicle positions, fuel levels, and load factors |
| `/api/v1/exceptions` | `GET` | Active exception backlog categorized by priority (P1/P2/P3) |
| `/api/v1/exceptions/{id}/resolve` | `POST` | Execute playbook resolution on an exception |
| `/api/v1/agents/recommendations` | `GET` | Action recommendations generated by ATLAS |
| `/api/v1/agents/approve/{id}` | `POST` | Approve an autonomous agent resolution proposal |
| `/api/v1/demo/scenarios` | `POST` | Trigger what-if simulation scenarios (weather, supply shock) |
| `/api/v1/iot/telemetry` | `GET` | Real-time sensor feeds (temperature, humidity, cold-chain) |

### Real-Time WebSocket Feeds
Connect to `ws://localhost:8000/ws/{channel}`:
- **`/ws/visibility`**: Position ticks for engineer vans, depot throughput changes, locker occupancy.
- **`/ws/exceptions`**: Instant P1 alert broadcasts and resolved incident updates.
- **`/ws/agents`**: Real-time streaming of ATLAS reasoning and proposal generation.

---

## 📂 Repository Structure

```plaintext
Logistic-Control-Tower/
├── app.py                      # Cross-platform concurrent runner (FastAPI + Vite)
├── docker-compose.yml          # Multi-container orchestration (Backend + Frontend + Postgres + Redis)
├── render.yaml                 # Infrastructure-as-code blueprint for cloud deployment
├── start.sh / start.ps1        # One-click startup scripts for Unix & Windows
├── .env.example                # Configuration template
│
├── backend/
│   ├── Dockerfile              # Python 3.11 slim container definition
│   ├── requirements.txt        # Backend dependencies
│   ├── clt_local.db            # SQLite persistent local store
│   └── app/
│       ├── main.py             # FastAPI entrypoint, lifespan lifecycle & background jobs
│       ├── config.py           # Pydantic Settings environment parsing
│       ├── database.py         # SQLAlchemy async engine & session management
│       ├── redis_client.py     # Async Redis client wrapper
│       ├── auth/               # JWT authentication, password hashing & RBAC authorization
│       ├── models/             # SQLAlchemy ORM database models
│       ├── routers/            # Modular API routes (auth, visibility, demand, transport, etc.)
│       ├── services/           # Business logic & integrations:
│       │   ├── agent_engine.py # ATLAS autonomous agent decision engine
│       │   ├── atlas_chat.py   # AI conversational & tool execution orchestration
│       │   ├── llm.py          # Multi-LLM provider abstraction (Google Gemini / OpenRouter)
│       │   ├── speech.py       # Text-to-Speech & Speech-to-Text streaming
│       │   └── websocket_manager.py # WebSocket connection pooling & broadcasting
│       └── synthetic/          # Synthetic supply chain simulation:
│           ├── state.py        # Master in-memory network state snapshot
│           ├── actions.py      # Action dispatchers (re-routes, expedites, POs)
│           ├── cadence.py      # Real-time realistic cadence intervals
│           ├── resolutions.py  # Playbook execution algorithms
│           └── routing.py      # Geospatial routing & distance metrics
│
└── frontend/
    ├── Dockerfile              # Node.js build container definition
    ├── package.json            # NPM dependencies & scripts
    ├── tsconfig.json           # TypeScript configuration
    ├── vite.config.ts          # Vite build & proxy settings
    ├── index.html              # HTML shell
    └── src/
        ├── App.tsx             # Root application component, routing & permissions guard
        ├── main.tsx            # React DOM mounting
        ├── index.css           # Global design system & theme tokens
        ├── components/         # Reusable UI component library (AppShell, Modals, Badges)
        ├── context/            # React context providers (ThemeContext, SocketContext)
        ├── hooks/              # Custom hooks (usePermissions, useWebSocket, useAuth)
        ├── store/              # Zustand global state store
        ├── lib/                # API client axios instances & formatting helpers
        └── pages/              # Module view pages:
            ├── DashboardPage.tsx       # Executive KPI dashboard
            ├── VisibilityPage.tsx      # Geospatial live map & asset tracking
            ├── TransportPage.tsx       # Fleet & vehicle routing management
            ├── DemandPage.tsx          # Inventory planning & demand curves
            ├── ExceptionsPage.tsx      # Incident triage & resolution workflow
            ├── AgentsPage.tsx          # ATLAS AI Command Center & approvals
            ├── SimulatorPage.tsx       # What-if scenario disruption simulator
            ├── RiskPage.tsx            # Supplier risk & network bottlenecks
            ├── IoTPage.tsx             # Cold-chain & sensor telemetry
            ├── SustainabilityPage.tsx  # ESG Scope 1/2/3 carbon tracking
            └── LoginPage.tsx           # Authentication & role selector
```

---

## ⏱️ Simulation & Cadence Engine

To deliver realistic operational dynamics without requiring hundreds of live enterprise ERP/WMS/TMS connections, CLT features a **Cadence-Based Synthetic World Engine**:

- **Van Positions (`every 1 tick / 5s`)**: Engineers move along actual UK road coordinates according to their active job assignments.
- **Warehouse Throughput (`every 5m cadence`)**: Inbound and outbound bin movements fluctuate with realistic operational peaks.
- **Incident Generation (`stochastic decay`)**: Realistic logistics failures (traffic delays, component shortages, sensor spikes) occur with probability curves matching real-world field operations.
- **Atomic State Consistency**: All state transitions occur within single-threaded event loops, preventing race conditions and ensuring deterministic replayability.

---

## 📄 License & Contact

Designed and engineered for enterprise supply chain visibility and intelligent logistics control.

*For enterprise licensing, integration inquiries, or customization, please contact the development team.*
