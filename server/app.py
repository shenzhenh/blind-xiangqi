"""Blind Xiangqi — FastAPI PvP server (spec v1.11 §21).

This is deliberately small: a server-authoritative game store + REST endpoints
that only ever return ``PublicState``.  It is the first slice of route A
(Python engine, client without rules).  WebSocket rooms / account / clock are
the next milestone (§18), not implemented here.

Run:
    python -m uvicorn server.app:app --host 127.0.0.1 --port 8000

The service is dependency-light apart from FastAPI/Uvicorn; the rules engine
itself is stdlib-only.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import string
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

try:  # works both as ``python -m uvicorn server.app:app`` and from server/
    from . import engine
except ImportError:  # pragma: no cover - direct script usage
    import engine  # type: ignore


app = FastAPI(title="Blind Xiangqi API", version="1.11.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # local/M0; tighten before public deployment
    allow_methods=["*"],
    allow_headers=["*"],
)

_GAMES: dict[str, "GameRecord"] = {}
_LOCK = threading.RLock()


class GameRecord:
    def __init__(self, game: engine.Game) -> None:
        self.game = game
        self.seq = 0
        self.created = time.time()


class NewGameBody(BaseModel):
    seed: Optional[str] = None
    config: Optional[dict[str, Any]] = None


class MoveBody(BaseModel):
    from_: dict[str, int] = Field(alias="from")
    to: dict[str, int]
    seq: Optional[int] = None

    model_config = {"populate_by_name": True}


class ResignBody(BaseModel):
    side: Optional[str] = None


def _public(rec: GameRecord) -> dict[str, Any]:
    return rec.game.public_state()


def _get(game_id: str) -> GameRecord:
    rec = _GAMES.get(game_id)
    if not rec:
        raise HTTPException(status_code=404, detail="game not found")
    return rec


@app.get("/api/health")
def health() -> dict[str, Any]:
    with _LOCK:
        return {"ok": True, "engine": "python", "games": len(_GAMES), "version": "1.11.0"}


@app.post("/api/games")
def create_game(body: NewGameBody) -> dict[str, Any]:
    try:
        game = engine.Game(seed=body.seed, config=body.config)
    except Exception as exc:  # config validation errors are client errors
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    game_id = uuid.uuid4().hex
    rec = GameRecord(game)
    with _LOCK:
        _GAMES[game_id] = rec
    return {"game_id": game_id, "public": _public(rec)}


@app.get("/api/games/{game_id}")
def get_game(game_id: str) -> dict[str, Any]:
    with _LOCK:
        rec = _get(game_id)
        return {"game_id": game_id, "public": _public(rec)}


@app.post("/api/games/{game_id}/move")
def move(game_id: str, body: MoveBody) -> dict[str, Any]:
    with _LOCK:
        rec = _get(game_id)
        if body.seq is not None and body.seq <= rec.seq:
            # 幂等：重复/过期包不执行，也不改变状态
            return {"ok": False, "code": "STALE", "public": _public(rec)}
        result = rec.game.move(body.from_, body.to)
        if not result.get("ok"):
            # 对局中正常只剩 ILLEGAL/STALE/GAME_OVER；不把具体规则原因出网
            return {"ok": False, "code": "GAME_OVER" if result.get("code") == "GAME_OVER" else "ILLEGAL",
                    "public": _public(rec)}
        if body.seq is not None:
            rec.seq = body.seq
        event = engine.public_event(result["event"], rec.game.config)
        return {"ok": True, "event": event, "public": _public(rec)}


@app.post("/api/games/{game_id}/resign")
def resign(game_id: str, body: ResignBody) -> dict[str, Any]:
    with _LOCK:
        rec = _get(game_id)
        result = rec.game.resign(body.side)
        if not result.get("ok"):
            return {"ok": False, "code": result.get("code", "ILLEGAL"), "public": _public(rec)}
        return {"ok": True, "public": _public(rec)}


@app.post("/api/games/{game_id}/draw")
def agree_draw(game_id: str) -> dict[str, Any]:
    with _LOCK:
        rec = _get(game_id)
        result = rec.game.agree_draw()
        if not result.get("ok"):
            return {"ok": False, "code": result.get("code", "ILLEGAL"), "public": _public(rec)}
        return {"ok": True, "public": _public(rec)}


@app.post("/api/games/{game_id}/undo")
def undo(game_id: str) -> dict[str, Any]:
    with _LOCK:
        rec = _get(game_id)
        result = rec.game.undo()
        if not result.get("ok"):
            return {"ok": False, "code": result.get("code", "UNDO_DISABLED"), "public": _public(rec)}
        return {"ok": True, "public": _public(rec)}


# ---------------------------------------------------------------------------
# WebSocket rooms (M2a): room code, server-authoritative moves, resync.
# This is intentionally minimal: no clock/spectator/rematch yet.
# ---------------------------------------------------------------------------
ROOM_ALPHABET = string.ascii_uppercase + string.digits
ROOMS: dict[str, "Room"] = {}
ROOMS_LOCK = asyncio.Lock()


def _room_code() -> str:
    while True:
        code = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(6))
        if code not in ROOMS:
            return code


class Room:
    def __init__(self, code: str, game: engine.Game) -> None:
        self.code = code
        self.game = game
        self.players: dict[str, WebSocket] = {}
        self.seq = {"RED": 0, "BLACK": 0}
        self.lock = asyncio.Lock()

    def public(self) -> dict[str, Any]:
        return self.game.public_state()

    async def send(self, side: str, payload: dict[str, Any]) -> None:
        ws = self.players.get(side)
        if ws is None:
            return
        try:
            await ws.send_json(payload)
        except Exception:
            self.players.pop(side, None)

    async def broadcast(self, make_payload) -> None:
        for side in list(self.players.keys()):
            try:
                await self.send(side, make_payload(side))
            except Exception:
                self.players.pop(side, None)

    def sync_payload(self, side: str, events: Optional[list[dict[str, Any]]] = None) -> dict[str, Any]:
        return {
            "t": "sync",
            "room": self.code,
            "you": side,
            "ply": self.game.ply,
            "public": self.public(),
            "events": events or [],
        }


def _room_error(ws: WebSocket, code: str, message: str = "") -> dict[str, Any]:
    return {"t": "error", "code": code, "message": message}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    room: Optional[Room] = None
    me: Optional[str] = None
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({"t": "error", "code": "BAD_JSON"})
                continue
            t = msg.get("t")

            if t == "create":
                async with ROOMS_LOCK:
                    code = _room_code()
                    try:
                        game = engine.Game(seed=msg.get("seed"), config=msg.get("config"))
                    except Exception as exc:
                        await ws.send_json({"t": "error", "code": "BAD_CONFIG", "message": str(exc)})
                        continue
                    room = Room(code, game)
                    ROOMS[code] = room
                    room.players["RED"] = ws
                me = "RED"
                await ws.send_json(room.sync_payload("RED"))
                continue

            if t == "join":
                code = str(msg.get("room") or "").upper()
                async with ROOMS_LOCK:
                    target = ROOMS.get(code)
                    if target is None:
                        await ws.send_json({"t": "error", "code": "ROOM_NOT_FOUND"})
                        continue
                    if "BLACK" in target.players:
                        await ws.send_json({"t": "error", "code": "ROOM_FULL"})
                        continue
                    room = target
                    room.players["BLACK"] = ws
                me = "BLACK"
                await room.send("RED", {"t": "opp.joined", "room": room.code})
                await room.broadcast(lambda side: room.sync_payload(side))
                continue

            if room is None or me is None:
                await ws.send_json(_room_error(ws, "NO_ROOM"))
                continue

            async with room.lock:
                if t == "move":
                    seq = msg.get("seq")
                    if isinstance(seq, int) and seq <= room.seq[me]:
                        await ws.send_json({"t": "moveErr", "seq": seq, "code": "STALE"})
                        continue
                    if room.game.turn != me:
                        await ws.send_json({"t": "moveErr", "seq": seq, "code": "NOT_YOUR_TURN"})
                        continue
                    result = room.game.move(msg.get("from") or {}, msg.get("to") or {})
                    if not result.get("ok"):
                        await ws.send_json({"t": "moveErr", "seq": seq, "code": "ILLEGAL"})
                        continue
                    if isinstance(seq, int):
                        room.seq[me] = seq
                    event = engine.public_event(result["event"], room.game.config)
                    await room.broadcast(lambda side: {
                        "t": "moveOk",
                        "room": room.code,
                        "ply": room.game.ply,
                        "event": event,
                        "public": room.public(),
                    })
                    if room.game.status != "PLAYING":
                        truth = room.game.final_reveal()
                        await room.broadcast(lambda side: {
                            "t": "end",
                            "room": room.code,
                            "status": room.game.status,
                            "public": room.public(),
                            "truth": truth,
                        })
                    continue

                if t == "resync":
                    await ws.send_json(room.sync_payload(me))
                    continue

                if t == "resign":
                    result = room.game.resign(me)
                    if result.get("ok"):
                        truth = room.game.final_reveal()
                        await room.broadcast(lambda side: {
                            "t": "end",
                            "room": room.code,
                            "status": room.game.status,
                            "public": room.public(),
                            "truth": truth,
                        })
                    continue

                if t == "ping":
                    await ws.send_json({"t": "pong", "ts": msg.get("ts")})
                    continue

                await ws.send_json({"t": "error", "code": "UNKNOWN"})
    except WebSocketDisconnect:
        pass
    finally:
        if room is not None and me is not None:
            if room.players.get(me) is ws:
                room.players.pop(me, None)
            await room.broadcast(lambda side: {"t": "opp.left", "room": room.code, "graceMs": 60000})


# ---------------------------------------------------------------------------
# Route-A H5 (M1 slice): same-origin static files, no client rule engine.
# Mounts must come after all /api routes so those keep priority.
# ---------------------------------------------------------------------------
_ROOT = Path(__file__).resolve().parents[1]
_WEB = _ROOT / "web"


@app.get("/src/styles.css", include_in_schema=False)
def shared_styles() -> FileResponse:
    """PvE/PvP shared visual CSS."""
    return FileResponse(_ROOT / "src" / "styles.css", media_type="text/css")


@app.get("/", include_in_schema=False)
def pve_home() -> FileResponse:
    """人机对战就是首页：本地前端、直接开局，不再套一层服务器 Home。"""
    return FileResponse(_ROOT / "index.html", media_type="text/html")


@app.get("/local", include_in_schema=False)
def local_redirect(request: Request) -> RedirectResponse:
    q = request.url.query
    return RedirectResponse(url="/" + (f"?{q}" if q else ""))


@app.get("/pvp", include_in_schema=False)
def pvp_redirect() -> RedirectResponse:
    return RedirectResponse(url="/pvp/")


@app.get("/pvp/", include_in_schema=False)
def pvp_index() -> FileResponse:
    """Old PvP-first home; links back to the PvE homepage."""
    return FileResponse(_WEB / "pvp.html", media_type="text/html")


@app.get("/local/", include_in_schema=False)
def local_compat_redirect(request: Request) -> RedirectResponse:
    q = request.url.query
    return RedirectResponse(url="/" + (f"?{q}" if q else ""))


# 根页面是本地 PvE，因此 /src 必须可加载 engine/AI；PvP 页面自身不加载它们。
app.mount("/src", StaticFiles(directory=str(_ROOT / "src")), name="src")
app.mount("/local/src", StaticFiles(directory=str(_ROOT / "src")), name="local-src")


if _WEB.is_dir():
    app.mount("/", StaticFiles(directory=str(_WEB), html=True), name="web")
