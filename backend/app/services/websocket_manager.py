import json
import asyncio
from datetime import datetime, timezone
from fastapi import WebSocket
from typing import Any


class ConnectionManager:
    def __init__(self):
        self.active: dict[str, list[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, channel: str):
        await websocket.accept()
        self.active.setdefault(channel, []).append(websocket)

    def disconnect(self, websocket: WebSocket, channel: str):
        conns = self.active.get(channel, [])
        if websocket in conns:
            conns.remove(websocket)

    @staticmethod
    def _envelope(event_type: str, payload: Any) -> str:
        return json.dumps({
            "type": event_type,
            "payload": payload,
            "ts": datetime.now(timezone.utc).isoformat(),
        })

    async def send(self, websocket: WebSocket, event_type: str, payload: Any) -> None:
        """Deliver to ONE socket. Used to prime a client the moment it connects,
        so a freshly opened page is live immediately instead of waiting out a
        broadcast interval — and without a per-connection loop that would push
        the same payload to everybody else N times over."""
        try:
            await websocket.send_text(self._envelope(event_type, payload))
        except Exception:
            pass

    async def broadcast(self, channel: str, event_type: str, payload: Any):
        message = self._envelope(event_type, payload)
        dead = []
        # Iterate a copy. `send_text` is an await point, and `connect`/`disconnect`
        # mutate this very list — a client dropping mid-broadcast used to shift the
        # indices under the loop and silently skip a live socket (which then sat on
        # stale data until its next poll).
        for ws in list(self.active.get(channel, [])):
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws, channel)

    async def broadcast_all(self, event_type: str, payload: Any):
        for channel in list(self.active.keys()):
            await self.broadcast(channel, event_type, payload)


ws_manager = ConnectionManager()
