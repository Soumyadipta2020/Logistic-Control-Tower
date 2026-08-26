import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app.config import get_settings
from app.database import init_db
from app.redis_client import get_redis, close_redis
from app.synthetic.state import synthetic_state
from app.synthetic.cadence import TICK_INTERVAL_S
from app.services.websocket_manager import ws_manager
from app.services.agent_engine import agent_engine, flush_agent_state

from fastapi import Request

from app.routers import auth, visibility, demand, field, risk, iot, reverse, exceptions, analytics, webhooks, demo, transport, agents
from app.routers.exceptions import open_exception_counts

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("clt")

settings = get_settings()
scheduler = AsyncIOScheduler()


async def broadcast_tick():
    state = synthetic_state.get_snapshot()
    await ws_manager.broadcast("visibility", "throughput", state.get("warehouse_status", []))
    # Every engineer, but only the fields that actually move on a position tick —
    # the client patches these onto the roster it already holds.
    #
    # This used to be capped at 50. A capped list is not a cheaper update, it is
    # a DIFFERENT update: any consumer treating the payload as the current roster
    # silently loses three quarters of the fleet. Slimming the fields is the
    # right economy (~6 keys instead of the full record, van stock included);
    # dropping engineers is not.
    slim_engineers = [
        {k: e[k] for k in ("engineer_code", "latitude", "longitude", "job_status", "region", "van_stock_low")}
        for e in state.get("engineer_locations", [])
        if "latitude" in e
    ]
    await ws_manager.broadcast("visibility", "engineer_location", slim_engineers)

    open_p1 = [e for e in state.get("exceptions", []) if e.get("priority") == "P1" and e.get("status") == "open"]
    # Always broadcast, including an empty list — otherwise clients that
    # received a P1 banner earlier have no way to learn it's been cleared.
    await ws_manager.broadcast("exceptions", "p1_active", open_p1)
    # Open/P1 counts, previously produced by a per-connection loop inside
    # /ws/exceptions (which broadcast N× per tick for N clients). Single
    # producer now, same as every other event on these channels.
    await ws_manager.broadcast("exceptions", "exceptions_tick", open_exception_counts(state))


async def agent_autonomy_tick():
    """Let ATLAS act on its own recommendations without waiting to be watched.

    `run_autonomous_cycle` used to fire only from `fleet()` and
    `recommendations()` — that is, only when somebody opened the ATLAS panel. So
    an action whose policy class needed no human still sat in the queue until a
    human turned up to look at it, which is precisely the wait autonomy exists to
    remove. On the heartbeat it self-executes what its gates allow as soon as the
    state raises it. Nothing about the gating changes: `_action_auto_eligible`
    still decides, the master switch still overrides everything, and any
    recommendation that fails a gate stays in the approvals queue for a person.

    This is `async def` and contains no `await` for the same reason
    `synthetic_state.tick` does: the cycle mutates the live snapshot through
    `apply_resolution`, and running it on the loop with no await point makes that
    atomic relative to every request handler serialising the same dicts. Do not
    move it to a thread and do not add an await inside it.
    """
    try:
        executed = agent_engine.run_autonomous_cycle()
    except Exception as e:
        logger.warning("Autonomous cycle failed: %s", type(e).__name__)
        return
    if executed:
        logger.info("ATLAS self-executed %d action(s) on the heartbeat", executed)


def _assert_single_process() -> None:
    """This app keeps its entire live world in this process's memory.

    That is the right call — the synthetic world is regenerable, not user data,
    and a restart is *meant* to revert to baseline. But it only holds for ONE
    process. Every piece of live state is a per-process singleton:
    `synthetic_state._snapshot`, `agent_engine._decisions`, `ws_manager.active`,
    `atlas_chat._proposals`, `llm._active_model`. Run a second worker and each
    one runs its own scheduler tick over its own copy of the world, so
    round-robined requests return different KPIs and different exception lists;
    a WebSocket client on worker A never sees a scenario applied on worker B;
    and both workers race to write the same `agent_state.json`.

    None of that fails loudly — it just makes the app quietly incoherent. Until
    the state layer is genuinely shared (see the Redis seam noted in the deploy
    configs), refuse to start rather than serve contradictions.
    """
    for var in ("WEB_CONCURRENCY", "UVICORN_WORKERS", "GUNICORN_WORKERS"):
        raw = os.environ.get(var)
        if raw and raw.strip().isdigit() and int(raw) > 1:
            raise RuntimeError(
                f"{var}={raw} but this service holds all real-time state in-process "
                f"and must run with exactly one worker. See _assert_single_process()."
            )


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("CLT starting up...")
    _assert_single_process()

    try:
        await init_db()
        logger.info("Database initialised")
    except Exception as e:
        logger.warning(f"DB init skipped (likely no DB in demo): {e}")

    synthetic_state.initialize()
    logger.info("Synthetic state initialised")

    # The operator's choice of reasoning model outlives the process that was
    # running when they made it.
    from app.services import llm
    await llm.load_active_model()

    # One fast heartbeat; each parameter family inside the engine then moves on
    # its own realistic interval (see app/synthetic/cadence.py). Positions tick
    # every beat, warehouse throughput every 5 minutes, supplier scorecards
    # hourly — as their real source systems do.
    scheduler.add_job(synthetic_state.tick, "interval", seconds=TICK_INTERVAL_S, id="state_tick")
    # Start broadcast 5s after tick so it always reads the freshly updated state
    scheduler.add_job(broadcast_tick, "interval", seconds=TICK_INTERVAL_S, id="ws_broadcast",
                      start_date=datetime.now() + timedelta(seconds=5))
    # ATLAS runs on the same heartbeat, offset so it reasons over state the tick
    # has already refreshed rather than the previous cycle's.
    scheduler.add_job(agent_autonomy_tick, "interval", seconds=TICK_INTERVAL_S, id="agent_autonomy",
                      start_date=datetime.now() + timedelta(seconds=10))
    scheduler.start()
    logger.info("Background scheduler started")

    yield

    scheduler.shutdown()
    await flush_agent_state()  # a debounced approval write must not be lost on exit
    await close_redis()
    logger.info("CLT shut down cleanly")


app = FastAPI(
    title="EXL Logistics Control Tower",
    version="1.0.0",
    description="CLT API – Engineering Solution v1.0",
    lifespan=lifespan,
)

app.add_middleware(GZipMiddleware, minimum_size=500)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_cache_headers(request: Request, call_next):
    response = await call_next(request)
    if request.method == "GET" and response.status_code == 200:
        # Synthetic state mutates on scenario/plan/baseline actions and the
        # frontend refetches on demand via React Query invalidation — a
        # browser-level HTTP cache here would silently serve stale data for
        # up to max-age seconds after those actions, undermining that
        # refetch. Let the client (which already manages its own
        # staleTime/refetchInterval) decide freshness instead.
        response.headers["Cache-Control"] = "no-store"
    return response


app.include_router(auth.router)
app.include_router(visibility.router)
app.include_router(demand.router)
app.include_router(field.router)
app.include_router(transport.router)
app.include_router(risk.router)
app.include_router(iot.router)
app.include_router(reverse.router)
app.include_router(exceptions.router)
app.include_router(analytics.router)
app.include_router(webhooks.router)
app.include_router(demo.router)
app.include_router(agents.router)


@app.get("/health")
async def health():
    return {"status": "ok", "demo_mode": settings.demo_mode, "version": "1.0.0"}


@app.get("/")
async def root():
    return {
        "name": "EXL Logistics Control Tower API",
        "version": "1.0.0",
        "docs": "/docs",
        "demo_mode": settings.demo_mode,
    }
