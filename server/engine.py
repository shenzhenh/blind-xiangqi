"""Blind Xiangqi (盲棋象棋) — pure Python rule engine (M0, route A).

This module is a dependency-free, standard-library-only port of
``src/engine.js`` (the authoritative implementation).  It keeps the same
semantics, including the subtle information-security invariants:

* L0 operation right uses ``apparent_side`` only (never a hidden piece's
  real ``side``).
* L2 capture permission uses ``apparent_side`` for hidden attackers.
* L3 forward simulation uses ``flip=False`` (``simulate_no_flip``), so a
  probe cannot learn a hidden piece's identity from rejected moves.
* Flip-and-give-check is legal unless ``config.strictCheck`` is enabled.
* S-1: a general can never be captured.  S-2: the side in check must answer.
* Global Fisher-Yates shuffle, mirror / fair balance modes, D4 reveal
  liberation, friendly fire, repetition / perpetual-check / no-capture draws.

API conventions
---------------
* Python callables and public payload keys are ``snake_case``.  Public state
  pieces expose hidden pieces as ``origin_kind`` / ``origin_side`` only; the
  real ``kind`` / ``side`` keys are *absent* while ``face_up`` is false.
* Configuration keys intentionally mirror spec §13 / ``src/engine.js``
  (``camelCase``), because they are a serialized contract (``strictCheck``,
  ``revealOnCapture``, ``draw.noCapturePlies`` ...).  ``merge_config`` accepts
  a plain dict and fills every default exactly like ``mergeConfig`` in JS.
* ``Square`` and ``Piece`` objects are used internally.  Public boundary
  helpers accept ``Square``, ``{file, rank}`` dicts, ``(file, rank)`` tuples
  and objects with ``.file`` / ``.rank`` attributes.
* ``GameState`` is mutable for the same make/unmake performance reasons as
  the JS engine.  ``clone_state`` / ``apply_move_raw`` produce independent
  snapshots; ``Game`` stores snapshots for undo.
"""

from __future__ import annotations

import copy
import math
import random
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional, Sequence

__all__ = [
    "SIDES",
    "KINDS",
    "NAMES",
    "VALUES",
    "SIDE_NAME",
    "SIDE_CHAR",
    "ORIGIN_KIND",
    "ORIGIN_SIDE",
    "ORIGIN_SQUARES",
    "PALACE",
    "OWN_HALF",
    "FORWARD",
    "DEFAULT_CONFIG",
    "REASON_TEXT",
    "INITIAL_PIECE_COUNTS",
    "Square",
    "Piece",
    "GameState",
    "Game",
    "merge_config",
    "create_position",
    "setup",
    "setup_state",
    "empty_state",
    "build_assignment",
    "assignment_is_fair",
    "verify_setup",
    "move_spec",
    "apparent_side",
    "can_operate",
    "pseudo_moves",
    "attacks_square",
    "can_capture",
    "legal_moves_for",
    "has_any_legal_move",
    "all_legal_moves",
    "check_move",
    "apply_move",
    "apply_move_raw",
    "clone_state",
    "simulate",
    "unsimulate",
    "recompute_check",
    "is_in_check",
    "generals_face_to_face",
    "general_square",
    "position_key",
    "evaluate_status",
    "result_text",
    "public_event",
    "public_captured",
    "public_pool",
    "build_public_state",
    "build_ui_state",
    "sample_world",
    "build_oracle_world",
    "on_board",
    "same_sq",
    "other",
    "in_palace",
    "in_own_half",
    "crossed_river",
    "coord",
    "as_square",
    "piece_at",
    "is_alive",
    "alive_pieces",
    "piece_by_id",
    "hash_seed",
    "mulberry32",
    "shuffle",
    "random_seed",
]

# ---------------------------------------------------------------------------
# 0. Constants
# ---------------------------------------------------------------------------

SIDES = ("RED", "BLACK")
KINDS = ("K", "A", "E", "H", "R", "C", "P")

NAMES: dict[str, dict[str, str]] = {
    "RED": {"K": "帅", "A": "仕", "E": "相", "H": "马", "R": "车", "C": "炮", "P": "兵"},
    "BLACK": {"K": "将", "A": "士", "E": "象", "H": "马", "R": "车", "C": "炮", "P": "卒"},
}

VALUES: dict[str, float] = {"K": 1000, "R": 9, "C": 4.5, "H": 4, "A": 2, "E": 2, "P": 1}

SIDE_NAME = {"RED": "红方", "BLACK": "黑方"}
SIDE_CHAR = {"RED": "红", "BLACK": "黑"}

PALACE: dict[str, dict[str, int]] = {
    "RED": {"file_min": 4, "file_max": 6, "rank_min": 1, "rank_max": 3},
    "BLACK": {"file_min": 4, "file_max": 6, "rank_min": 8, "rank_max": 10},
}
OWN_HALF: dict[str, tuple[int, int]] = {"RED": (1, 5), "BLACK": (6, 10)}
FORWARD: dict[str, int] = {"RED": +1, "BLACK": -1}
DIRS: tuple[tuple[int, int], ...] = ((1, 0), (-1, 0), (0, 1), (0, -1))
KNIGHT_OFFSETS: tuple[tuple[int, int, int, int], ...] = (
    (1, 2, 0, 1), (-1, 2, 0, 1),
    (1, -2, 0, -1), (-1, -2, 0, -1),
    (2, 1, 1, 0), (2, -1, 1, 0),
    (-2, 1, -1, 0), (-2, -1, -1, 0),
)


@dataclass(frozen=True, slots=True)
class Square:
    """A board intersection: ``file`` 1..9, ``rank`` 1..10."""

    file: int
    rank: int


@dataclass(slots=True)
class Piece:
    """A physical piece.  ``side`` / ``kind`` are the *real* identity."""

    id: int
    side: str
    kind: str
    face_up: bool
    at: Square


@dataclass(slots=True)
class GameState:
    """Mutable game state.  ``grid[rank][file]`` stores a piece id."""

    config: dict[str, Any]
    seed: str
    layout_seed: Optional[str]
    pieces: list[Piece]
    grid: list[list[Optional[int]]]
    turn: str
    ply: int
    status: str
    draw_reason: Optional[str]
    in_check: dict[str, bool]
    history: list[dict[str, Any]]
    position_counts: dict[str, list[int]]
    plies_since_capture: int
    stats: dict[str, int]
    # Internal id -> Piece index.  Not part of the serialized state.
    by_id: dict[int, Piece] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# 1. Geometry / origin tables
# ---------------------------------------------------------------------------

def _build_origin_kind() -> list[list[Optional[str]]]:
    """§3.3 origin kind matrix, indexed ``[rank][file]`` like engine.js."""
    m: list[list[Optional[str]]] = [[None] * 10 for _ in range(11)]
    back = ["R", "H", "E", "A", "K", "A", "E", "H", "R"]
    for i, k in enumerate(back):
        m[1][i + 1] = k
        m[10][i + 1] = k
    for r in (3, 8):
        m[r][2] = "C"
        m[r][8] = "C"
    for r in (4, 7):
        for f in (1, 3, 5, 7, 9):
            m[r][f] = "P"
    return m


ORIGIN_KIND: list[list[Optional[str]]] = _build_origin_kind()


def ORIGIN_SIDE(sq: Square) -> str:
    """§3.4 origin ownership: rank 1-5 is RED, 6-10 is BLACK."""
    return "RED" if sq.rank <= 5 else "BLACK"


def _build_origin_squares() -> list[Square]:
    out: list[Square] = []
    for rank in range(1, 11):
        for file in range(1, 10):
            kind = ORIGIN_KIND[rank][file]
            if kind is not None and kind != "K":
                out.append(Square(file, rank))
    return out


ORIGIN_SQUARES: list[Square] = _build_origin_squares()
ORIGIN_KEYS: frozenset[str] = frozenset(f"{s.file},{s.rank}" for s in ORIGIN_SQUARES)


def _build_piece_defs() -> list[dict[str, Any]]:
    defs: list[dict[str, Any]] = []
    pid = 1
    for side in SIDES:
        defs.append({"id": pid, "side": side, "kind": "K"})
        pid += 1
        for kind, n in (("A", 2), ("E", 2), ("H", 2), ("R", 2), ("C", 2), ("P", 5)):
            for _ in range(n):
                defs.append({"id": pid, "side": side, "kind": kind})
                pid += 1
    return defs


PIECE_DEFS: list[dict[str, Any]] = _build_piece_defs()
POOL_DEFS: list[dict[str, Any]] = [d for d in PIECE_DEFS if d["kind"] != "K"]
KING_DEF: dict[str, dict[str, Any]] = {
    "RED": next(d for d in PIECE_DEFS if d["side"] == "RED" and d["kind"] == "K"),
    "BLACK": next(d for d in PIECE_DEFS if d["side"] == "BLACK" and d["kind"] == "K"),
}

INITIAL_PIECE_COUNTS: dict[str, int] = {"A": 2, "E": 2, "H": 2, "R": 2, "C": 2, "P": 5}
POOL_KIND_ORDER: tuple[str, ...] = ("A", "E", "H", "R", "C", "P")

# ---------------------------------------------------------------------------
# 2. Default configuration (§13).  Keys mirror the JS/spec wire format.
# ---------------------------------------------------------------------------

DEFAULT_CONFIG: dict[str, Any] = {
    "shuffle": {"scope": "global", "balance": "none"},
    "visibility": "none",
    "hidden": {"regionLimited": True},
    "revealed": {"regionLimits": "free", "kingBoundToPalace": True},
    "friendlyFire": "allow",
    "attackHidden": {"confirm": "none"},
    "revealOnCapture": True,
    "showLegalMoves": True,
    "showCheck": True,
    "highlightCheckAttacker": True,
    "undo": False,
    "strictCheck": False,
    "draw": {"repetition": 3, "perpetualCheck": "lose", "noCapturePlies": 120},
    "timer": {"mode": "none"},
    "notation": "coord",
    "mode": "pve",
    "ai": {
        "side": "red",
        "difficulty": "normal",
        "honesty": "honest",
        "thinkMs": 250,
        "fakeDelayMs": [200, 600],
        "sampleCount": 32,
        "qdepth": 4,
        "riskLambda": 0.6,
        "riskMode": "mean",
        "worstCaseScreen": True,
        "consistentWorlds": False,
        "seed": None,
        "hintPerGame": 3,
    },
}

_MISSING = object()


def merge_config(user: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """Deep-ish merge of ``user`` over ``DEFAULT_CONFIG`` (JS ``mergeConfig``).

    Nested objects are merged one level exactly like ``Object.assign``.
    Unknown custom keys are preserved.  ``None`` values override defaults
    (only *missing* keys fall back), matching JS ``undefined`` semantics.
    """
    if user is not None and not isinstance(user, dict):
        user = None
    out: dict[str, Any] = {}
    for key, base in DEFAULT_CONFIG.items():
        given = _MISSING if user is None else user.get(key, _MISSING)
        if isinstance(base, dict):
            extra = given if isinstance(given, dict) else {}
            out[key] = {**base, **extra}
        else:
            out[key] = base if given is _MISSING else given
    if user:
        for k, v in user.items():
            if k not in out:
                out[k] = v
    return out


REASON_TEXT = {
    "CHECKMATE": "将死",
    "STALEMATE": "困毙",
    "RESIGN": "认输",
    "TIMEOUT": "超时",
    "PERPETUAL_CHECK": "长将判负",
    "REPETITION": "三次重复局面",
    "NO_CAPTURE": "自然限着（120 半步无吃子）",
    "AGREEMENT": "双方同意和棋",
}

# ---------------------------------------------------------------------------
# 3. Basic helpers
# ---------------------------------------------------------------------------

def as_square(value: Any, rank: Optional[int] = None) -> Square:
    """Coerce a square-like value to :class:`Square`."""
    if rank is not None:
        return Square(int(value), int(rank))
    if isinstance(value, Square):
        return value
    if isinstance(value, dict):
        return Square(int(value["file"]), int(value["rank"]))
    if isinstance(value, (tuple, list)) and len(value) >= 2:
        return Square(int(value[0]), int(value[1]))
    if hasattr(value, "file") and hasattr(value, "rank"):
        return Square(int(value.file), int(value.rank))
    raise TypeError(f"cannot convert {value!r} to Square")


def on_board(s: Optional[Any]) -> bool:
    return s is not None and 1 <= s.file <= 9 and 1 <= s.rank <= 10


def same_sq(a: Any, b: Any) -> bool:
    return a is not None and b is not None and a.file == b.file and a.rank == b.rank


def other(side: str) -> str:
    return "BLACK" if side == "RED" else "RED"


def in_palace(s: Square, side: str) -> bool:
    p = PALACE[side]
    return (
        p["file_min"] <= s.file <= p["file_max"]
        and p["rank_min"] <= s.rank <= p["rank_max"]
    )


def in_own_half(s: Square, side: str) -> bool:
    lo, hi = OWN_HALF[side]
    return lo <= s.rank <= hi


def crossed_river(s: Square, side: str) -> bool:
    return s.rank >= 6 if side == "RED" else s.rank <= 5


def coord(s: Square) -> str:
    return f"f{s.file}r{s.rank}"


def _sign(n: int) -> int:
    return 1 if n > 0 else (-1 if n < 0 else 0)


# ---------------------------------------------------------------------------
# 4. RNG / shuffle (bit-for-bit JS-compatible)
# ---------------------------------------------------------------------------

def _u32(n: int) -> int:
    return n & 0xFFFFFFFF


def _i32(n: int) -> int:
    n &= 0xFFFFFFFF
    return n - 0x100000000 if n & 0x80000000 else n


def _imul(a: int, b: int) -> int:
    """JavaScript ``Math.imul`` (low 32 bits, signed)."""
    return _i32(a * b)


def hash_seed(seed: Any) -> int:
    """FNV-1a-ish 32-bit hash using UTF-16 code units (JS ``hashSeed``)."""
    h = 2166136261
    s = str(seed)
    data = s.encode("utf-16-le", "surrogatepass")
    for i in range(0, len(data), 2):
        code = data[i] | (data[i + 1] << 8)
        h ^= code
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def mulberry32(a: int) -> Callable[[], float]:
    """Deterministic 32-bit PRNG matching JS ``mulberry32`` exactly."""
    x = _i32(a)

    def rand() -> float:
        nonlocal x
        x = _i32(x + 0x6D2B79F5)
        t = _imul(_i32(x ^ (_u32(x) >> 15)), _i32(1 | x))
        t = _i32(_i32(t + _imul(_i32(t ^ (_u32(t) >> 7)), _i32(61 | t))) ^ t)
        t = _i32(t ^ (_u32(t) >> 14))
        return _u32(t) / 4294967296.0

    return rand


def shuffle(arr: list[Any], rand: Callable[[], float]) -> list[Any]:
    """Unbiased Fisher-Yates shuffle, in place, identical to engine.js."""
    for i in range(len(arr) - 1, 0, -1):
        j = int(math.floor(rand() * (i + 1)))
        arr[i], arr[j] = arr[j], arr[i]
    return arr


def random_seed() -> str:
    """A fresh seed string (not reproducible; pass an explicit seed for that)."""
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"

    def b36(n: int) -> str:
        if n == 0:
            return "0"
        out = ""
        while n:
            n, r = divmod(n, 36)
            out = digits[r] + out
        return out

    return b36(int(time.time() * 1000)) + "-" + b36(random.getrandbits(32))[:6]


# ---------------------------------------------------------------------------
# 5. State construction / queries
# ---------------------------------------------------------------------------

def empty_state(config: Optional[dict[str, Any]] = None, seed: Optional[str] = None) -> GameState:
    actual_seed = seed if seed else random_seed()
    return GameState(
        config=config if config is not None else merge_config(),
        seed=actual_seed,
        layout_seed=seed if seed else None,
        pieces=[],
        grid=[[None] * 10 for _ in range(11)],
        turn="RED",
        ply=0,
        status="PLAYING",
        draw_reason=None,
        in_check={"RED": False, "BLACK": False},
        history=[],
        position_counts={},
        plies_since_capture=0,
        stats={
            "flips": 0,
            "captures": 0,
            "friendlyFire": 0,
            "hiddenMoves": 0,
            "checks": 0,
            "selfChecks": 0,
        },
        by_id={},
    )


def piece_at(state: GameState, s: Square) -> Optional[Piece]:
    """Return the alive piece at ``s`` or ``None``."""
    if not on_board(s):
        return None
    pid = state.grid[s.rank][s.file]
    if pid is None:
        return None
    p = state.by_id.get(pid)
    if p is None:  # tolerate externally assembled states
        for q in state.pieces:
            if q.id == pid:
                p = q
                state.by_id[pid] = q
                break
    return p


def is_alive(state: GameState, p: Optional[Piece]) -> bool:
    if p is None or not on_board(p.at):
        return False
    return state.grid[p.at.rank][p.at.file] == p.id


def alive_pieces(state: GameState) -> list[Piece]:
    return [p for p in state.pieces if is_alive(state, p)]


def piece_by_id(state: GameState, pid: int) -> Optional[Piece]:
    p = state.by_id.get(pid)
    if p is not None:
        return p
    for q in state.pieces:
        if q.id == pid:
            state.by_id[pid] = q
            return q
    return None


def general_square(state: GameState, side: str) -> Optional[Square]:
    for p in state.pieces:
        if p.kind == "K" and p.side == side and is_alive(state, p):
            return p.at
    return None


# ---------------------------------------------------------------------------
# 6. moveSpec / apparentSide (§4.4)
# ---------------------------------------------------------------------------

def move_spec(p: Piece, config: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """The authoritative movement spec (§4.4)."""
    cfg = config if config is not None else DEFAULT_CONFIG
    if p.face_up:
        region_limited = p.kind == "K" or p.kind == "P"
        if cfg["revealed"]["regionLimits"] == "classic" and p.kind in ("A", "E"):
            region_limited = True
        if p.kind == "K" and not cfg["revealed"]["kingBoundToPalace"]:
            region_limited = False
        return {"kind": p.kind, "side": p.side, "region_limited": region_limited}
    origin_kind = None
    if 0 <= p.at.rank < len(ORIGIN_KIND) and 0 <= p.at.file < len(ORIGIN_KIND[0]):
        origin_kind = ORIGIN_KIND[p.at.rank][p.at.file]
    return {
        "kind": origin_kind or "P",
        "side": ORIGIN_SIDE(p.at),
        "region_limited": bool(cfg["hidden"]["regionLimited"]),
    }


def apparent_side(p: Piece) -> str:
    """Public apparent side; the sole basis for friend/foe decisions."""
    return p.side if p.face_up else ORIGIN_SIDE(p.at)


def can_operate(p: Optional[Piece], turn: str) -> bool:
    """§6.0 operation right (never reads a hidden piece's real side)."""
    return p is not None and apparent_side(p) == turn


# ---------------------------------------------------------------------------
# 7. Move generation (§10.3)
# ---------------------------------------------------------------------------

def pseudo_moves(state: GameState, p: Piece) -> list[Square]:
    """L1 reachable squares (includes occupied targets; no L2/L3 checks)."""
    cfg = state.config
    spec = move_spec(p, cfg)
    kind = spec["kind"]
    side = spec["side"]
    region_limited = spec["region_limited"]
    at = p.at
    out: list[Square] = []

    def occ(s: Square) -> Optional[Piece]:
        return piece_at(state, s)

    if kind == "K":
        for df, dr in DIRS:
            s = Square(at.file + df, at.rank + dr)
            if not on_board(s):
                continue
            if region_limited and not in_palace(s, side):
                continue
            out.append(s)
    elif kind == "A":
        for df, dr in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
            s = Square(at.file + df, at.rank + dr)
            if not on_board(s):
                continue
            if region_limited and not in_palace(s, side):
                continue
            out.append(s)
    elif kind == "E":
        for df, dr in ((2, 2), (2, -2), (-2, 2), (-2, -2)):
            s = Square(at.file + df, at.rank + dr)
            if not on_board(s):
                continue
            if region_limited and not in_own_half(s, side):
                continue
            if occ(Square(at.file + df // 2, at.rank + dr // 2)):
                continue
            out.append(s)
    elif kind == "H":
        for df, dr, lf, lr in KNIGHT_OFFSETS:
            s = Square(at.file + df, at.rank + dr)
            if not on_board(s):
                continue
            if occ(Square(at.file + lf, at.rank + lr)):
                continue
            out.append(s)
    elif kind == "R":
        for df, dr in DIRS:
            s = Square(at.file + df, at.rank + dr)
            while on_board(s):
                out.append(s)
                if occ(s):
                    break
                s = Square(s.file + df, s.rank + dr)
    elif kind == "C":
        for df, dr in DIRS:
            s = Square(at.file + df, at.rank + dr)
            # 1) non-screen segment: rook-like sliding.
            while on_board(s) and occ(s) is None:
                out.append(s)
                s = Square(s.file + df, s.rank + dr)
            if not on_board(s):
                continue
            # 2) jump over the screen.
            s = Square(s.file + df, s.rank + dr)
            # 3) first piece after the screen is the capture target.
            while on_board(s) and occ(s) is None:
                s = Square(s.file + df, s.rank + dr)
            if on_board(s):
                out.append(s)
    elif kind == "P":
        f = FORWARD[side]
        fwd = Square(at.file, at.rank + f)
        if on_board(fwd):
            out.append(fwd)
        if crossed_river(at, side):
            for df in (-1, 1):
                s = Square(at.file + df, at.rank)
                if on_board(s):
                    out.append(s)
    return out


def attacks_square(state: GameState, p: Optional[Piece], target: Square) -> bool:
    """O(1)-ish single-square attack test, consistent with ``pseudo_moves``."""
    if p is None or not on_board(target):
        return False
    spec = move_spec(p, state.config)
    kind = spec["kind"]
    side = spec["side"]
    region_limited = spec["region_limited"]
    at = p.at
    df = target.file - at.file
    dr = target.rank - at.rank

    if kind == "K":
        return abs(df) + abs(dr) == 1 and (not region_limited or in_palace(target, side))
    if kind == "A":
        return abs(df) == 1 and abs(dr) == 1 and (not region_limited or in_palace(target, side))
    if kind == "E":
        if abs(df) != 2 or abs(dr) != 2:
            return False
        if region_limited and not in_own_half(target, side):
            return False
        return piece_at(state, Square(at.file + df // 2, at.rank + dr // 2)) is None
    if kind == "H":
        af, ar = abs(df), abs(dr)
        if not ((af == 1 and ar == 2) or (af == 2 and ar == 1)):
            return False
        lf = _sign(df) if af == 2 else 0
        lr = _sign(dr) if ar == 2 else 0
        return piece_at(state, Square(at.file + lf, at.rank + lr)) is None
    if kind == "R":
        return _line_attacks(state, at, target, 0)
    if kind == "C":
        return _line_attacks(state, at, target, 1)
    if kind == "P":
        if df == 0 and dr == FORWARD[side]:
            return True
        if dr == 0 and abs(df) == 1 and crossed_river(at, side):
            return True
        return False
    return False


def _line_attacks(state: GameState, from_sq: Square, to_sq: Square, screens_needed: int) -> bool:
    if from_sq.file != to_sq.file and from_sq.rank != to_sq.rank:
        return False
    df = _sign(to_sq.file - from_sq.file)
    dr = _sign(to_sq.rank - from_sq.rank)
    f, r = from_sq.file + df, from_sq.rank + dr
    screens = 0
    while f != to_sq.file or r != to_sq.rank:
        if state.grid[r][f] is not None:
            screens += 1
        if screens > screens_needed:
            return False
        f += df
        r += dr
    return screens == screens_needed


def can_capture(mover: Piece, target: Optional[Piece]) -> bool:
    """§6.5 attack matrix.  S-1: generals are never capturable."""
    if target is None:
        return False
    if target.face_up and target.kind == "K":
        return False  # S-1
    if mover.face_up:
        # Face-up mover: may attack any hidden piece; real sides for face-up.
        return (not target.face_up) or target.side != mover.side
    # Hidden mover: apparent sides only (never the real side).
    return apparent_side(mover) != apparent_side(target)


# ---------------------------------------------------------------------------
# 8. Simulation / make-unmake / check
# ---------------------------------------------------------------------------

def simulate(state: GameState, p: Piece, to: Square, flip: bool) -> dict[str, Any]:
    """In-place make for forward simulation.  Returns an undo record."""
    from_sq = p.at
    target = piece_at(state, to)
    undo = {
        "p": p,
        "from": from_sq,
        "to": to,
        "target": target,
        "face_up": p.face_up,
    }
    state.grid[from_sq.rank][from_sq.file] = None
    state.grid[to.rank][to.file] = p.id
    p.at = to
    if flip and not p.face_up:
        p.face_up = True
    return undo


def unsimulate(state: GameState, undo: dict[str, Any]) -> None:
    p: Piece = undo["p"]
    from_sq: Square = undo["from"]
    to_sq: Square = undo["to"]
    target: Optional[Piece] = undo["target"]
    p.at = from_sq
    p.face_up = undo["face_up"]
    state.grid[to_sq.rank][to_sq.file] = target.id if target is not None else None
    state.grid[from_sq.rank][from_sq.file] = p.id


def is_in_check(state: GameState, side: str) -> bool:
    """§7.4 check definition, based on ``apparent_side`` only."""
    gs = general_square(state, side)
    if gs is None:
        return False
    for p in state.pieces:
        if not is_alive(state, p):
            continue
        if apparent_side(p) == side:
            continue
        if attacks_square(state, p, gs):
            return True
    return False


def generals_face_to_face(state: GameState) -> bool:
    """§7.3 flying-general test (hidden pieces count as blockers)."""
    a = general_square(state, "RED")
    b = general_square(state, "BLACK")
    if a is None or b is None or a.file != b.file:
        return False
    lo, hi = (a.rank, b.rank) if a.rank < b.rank else (b.rank, a.rank)
    for r in range(lo + 1, hi):
        if state.grid[r][a.file] is not None:
            return False
    return True


def recompute_check(state: GameState) -> None:
    state.in_check["RED"] = is_in_check(state, "RED")
    state.in_check["BLACK"] = is_in_check(state, "BLACK")


# ---------------------------------------------------------------------------
# 9. Legality (§7)
# ---------------------------------------------------------------------------

def legal_moves_for(state: GameState, p: Optional[Piece], side: str) -> list[dict[str, Any]]:
    """All legal moves for ``p`` when it is ``side``'s turn.

    Each entry: ``{"to": Square, "capture": None | {id, face_up[, kind, side]}}``.
    Hidden capture targets never expose real kind/side.
    """
    if p is None or not is_alive(state, p):
        return []
    if apparent_side(p) != side:
        return []
    cfg = state.config
    strict = bool(cfg["strictCheck"])
    out: list[dict[str, Any]] = []
    for to in pseudo_moves(state, p):
        target = piece_at(state, to)
        if target is not None and target.id == p.id:
            continue
        if target is not None and target.face_up and target.kind == "K":
            continue  # S-1
        if target is not None and not can_capture(p, target):
            continue
        undo = simulate(state, p, to, strict)  # L3 must use flip=False normally
        ok = (not is_in_check(state, side)) and (not generals_face_to_face(state))
        unsimulate(state, undo)
        if not ok:
            continue
        capture: Optional[dict[str, Any]] = None
        if target is not None:
            capture = {"id": target.id, "face_up": target.face_up}
            if target.face_up:
                capture["kind"] = target.kind
                capture["side"] = target.side
        out.append({"to": to, "capture": capture})
    return out


def has_any_legal_move(state: GameState, side: str) -> bool:
    cfg = state.config
    strict = bool(cfg["strictCheck"])
    for p in state.pieces:
        if not is_alive(state, p) or apparent_side(p) != side:
            continue
        for to in pseudo_moves(state, p):
            target = piece_at(state, to)
            if target is not None and target.face_up and target.kind == "K":
                continue
            if target is not None and not can_capture(p, target):
                continue
            undo = simulate(state, p, to, strict)
            ok = (not is_in_check(state, side)) and (not generals_face_to_face(state))
            unsimulate(state, undo)
            if ok:
                return True
    return False


def all_legal_moves(state: GameState, side: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for p in state.pieces:
        if not is_alive(state, p) or apparent_side(p) != side:
            continue
        from_sq = p.at
        for mv in legal_moves_for(state, p, side):
            out.append(
                {
                    "from": from_sq,
                    "to": mv["to"],
                    "capture": mv["capture"],
                    "piece_id": p.id,
                }
            )
    return out


def check_move(state: GameState, from_sq: Any, to_sq: Any) -> dict[str, Any]:
    """Detailed legality check used by ``Game.move`` / UI hints.

    Failure codes: ``OUT_OF_BOARD | SAME_SQUARE | NO_PIECE | NOT_YOUR_PIECE |
    GENERAL_SHIELD | GEOMETRY | OWN_PIECE | APPARENT_ALLY | SEND_CHECK |
    FACE_TO_FACE``.  Failure payloads contain only ``ok`` and ``code`` so they
    never leak hidden identity (T-42).
    """
    from_sq = as_square(from_sq)
    to_sq = as_square(to_sq)
    if not on_board(from_sq) or not on_board(to_sq):
        return {"ok": False, "code": "OUT_OF_BOARD"}
    if same_sq(from_sq, to_sq):
        return {"ok": False, "code": "SAME_SQUARE"}
    mover = piece_at(state, from_sq)
    if mover is None:
        return {"ok": False, "code": "NO_PIECE"}
    if apparent_side(mover) != state.turn:
        return {"ok": False, "code": "NOT_YOUR_PIECE"}
    target = piece_at(state, to_sq)
    if target is not None and target.face_up and target.kind == "K":
        return {"ok": False, "code": "GENERAL_SHIELD"}
    if not any(same_sq(s, to_sq) for s in pseudo_moves(state, mover)):
        return {"ok": False, "code": "GEOMETRY"}
    if target is not None and not can_capture(mover, target):
        return {"ok": False, "code": "OWN_PIECE" if mover.face_up else "APPARENT_ALLY"}
    undo = simulate(state, mover, to_sq, bool(state.config["strictCheck"]))
    checked = is_in_check(state, state.turn)
    if checked:
        unsimulate(state, undo)
        return {"ok": False, "code": "SEND_CHECK"}
    faced = generals_face_to_face(state)
    if faced:
        unsimulate(state, undo)
        return {"ok": False, "code": "FACE_TO_FACE"}
    unsimulate(state, undo)
    return {"ok": True, "mover": mover, "target": target}


# ---------------------------------------------------------------------------
# 10. Applying moves (§10.5)
# ---------------------------------------------------------------------------

def apply_move(state: GameState, from_sq: Any, to_sq: Any) -> dict[str, Any]:
    """Execute a move in place and return a raw internal ``MoveEvent`` dict.

    No legality check is performed here (that is ``check_move`` / ``Game.move``).
    The event contains real captured identities; use :func:`public_event` for
    any client-facing projection.
    """
    from_sq = as_square(from_sq)
    to_sq = as_square(to_sq)
    mover = piece_at(state, from_sq)
    target = piece_at(state, to_sq)
    if mover is None:
        raise ValueError(f"apply_move: no piece at {coord(from_sq)}")

    ev: dict[str, Any] = {
        "ply": state.ply + 1,
        "side": state.turn,
        "from": Square(from_sq.file, from_sq.rank),
        "to": Square(to_sq.file, to_sq.rank),
        "mover_id": mover.id,
        "mover_was_face_up": mover.face_up,
        "captured": None,
        "revealed": None,
    }

    if target is not None:
        state.grid[target.at.rank][target.at.file] = None
        ev["captured"] = {
            "id": target.id,
            "kind": target.kind,
            "side": target.side,
            "was_face_up": target.face_up,
            "friendly_fire": target.side == mover.side,
        }
        state.stats["captures"] += 1
        if ev["captured"]["friendly_fire"]:
            state.stats["friendlyFire"] += 1
        state.plies_since_capture = 0
    else:
        state.plies_since_capture += 1

    # Move.
    state.grid[from_sq.rank][from_sq.file] = None
    mover.at = Square(to_sq.file, to_sq.rank)
    state.grid[to_sq.rank][to_sq.file] = mover.id

    # Flip on the destination square (may change apparentSide -> recompute).
    if not mover.face_up:
        mover.face_up = True
        ev["revealed"] = {"kind": mover.kind, "side": mover.side}
        state.stats["flips"] += 1
        state.stats["hiddenMoves"] += 1

    state.ply = ev["ply"]
    state.turn = other(state.turn)
    recompute_check(state)
    ev["check"] = {"RED": state.in_check["RED"], "BLACK": state.in_check["BLACK"]}
    if ev["check"][other(ev["side"])]:
        state.stats["checks"] += 1
    if ev["check"][ev["side"]]:
        state.stats["selfChecks"] += 1
    ev["notation"] = coord(ev["from"]) + "→" + coord(ev["to"])

    state.history.append(ev)
    record_position(state)
    evaluate_status(state)
    return ev


def clone_state(state: GameState) -> GameState:
    """Independent deep copy (pieces, grid, history, counts, stats)."""
    pieces: list[Piece] = []
    by_id: dict[int, Piece] = {}
    for p in state.pieces:
        q = Piece(p.id, p.side, p.kind, p.face_up, Square(p.at.file, p.at.rank))
        pieces.append(q)
        by_id.setdefault(q.id, q)
    grid: list[list[Optional[int]]] = [[None] * 10 for _ in range(11)]
    for p in state.pieces:
        if on_board(p.at) and state.grid[p.at.rank][p.at.file] == p.id:
            grid[p.at.rank][p.at.file] = p.id
    return GameState(
        config=copy.deepcopy(state.config),
        seed=state.seed,
        layout_seed=state.layout_seed,
        pieces=pieces,
        grid=grid,
        turn=state.turn,
        ply=state.ply,
        status=state.status,
        draw_reason=state.draw_reason,
        in_check={"RED": state.in_check["RED"], "BLACK": state.in_check["BLACK"]},
        history=copy.deepcopy(state.history),
        position_counts={k: list(v) for k, v in state.position_counts.items()},
        plies_since_capture=state.plies_since_capture,
        stats=dict(state.stats),
        by_id=by_id,
    )


def apply_move_raw(state: GameState, from_sq: Any, to_sq: Any, flip: bool) -> GameState:
    """Pure forward simulation: copy, move, optional flip; no turn/status update."""
    from_sq = as_square(from_sq)
    to_sq = as_square(to_sq)
    nxt = clone_state(state)
    p = piece_at(nxt, from_sq)
    if p is None:
        raise ValueError("apply_move_raw: no piece")
    simulate(nxt, p, to_sq, bool(flip))
    recompute_check(nxt)
    return nxt


# ---------------------------------------------------------------------------
# 11. Repetition / terminal status (§7.6 / §9)
# ---------------------------------------------------------------------------

def position_key(state: GameState) -> str:
    """§9.2 position key; includes ``turn`` and ``face_up``."""
    parts = sorted(
        f"{p.at.rank}{p.at.file}:{p.side}{p.kind}:{1 if p.face_up else 0}"
        for p in alive_pieces(state)
    )
    return state.turn + "|" + ",".join(parts)


def record_position(state: GameState) -> str:
    key = position_key(state)
    state.position_counts.setdefault(key, []).append(state.ply)
    return key


def perpetual_check_loser(state: GameState, key: str) -> Optional[str]:
    """§9.3 perpetual check: every move by the mover since the first
    occurrence must have given check."""
    if state.config["draw"]["perpetualCheck"] != "lose":
        return None
    occ = state.position_counts.get(key)
    repetition = state.config["draw"]["repetition"]
    if not occ or len(occ) < repetition:
        return None
    first = occ[0]
    last_side = other(state.turn)
    eventos = [
        e for e in state.history
        if e.get("ply", 0) > first and e.get("side") == last_side
    ]
    if not eventos:
        return None
    all_check = all((e.get("check") or {}).get(other(last_side)) for e in eventos)
    return last_side if all_check else None


def _set_status(state: GameState, status: str, reason: Optional[str]) -> dict[str, Any]:
    state.status = status
    state.draw_reason = reason
    return {"status": status, "reason": reason}


def evaluate_status(state: GameState) -> dict[str, Any]:
    """Evaluate and set ``state.status`` / ``draw_reason`` (§7.6)."""
    side = state.turn
    if not has_any_legal_move(state, side):
        mate = is_in_check(state, side)
        return _set_status(
            state, "BLACK_WIN" if side == "RED" else "RED_WIN",
            "CHECKMATE" if mate else "STALEMATE",
        )
    key = position_key(state)
    loser = perpetual_check_loser(state, key)
    if loser:
        return _set_status(
            state, "BLACK_WIN" if loser == "RED" else "RED_WIN", "PERPETUAL_CHECK",
        )
    occ = state.position_counts.get(key)
    if occ and len(occ) >= state.config["draw"]["repetition"]:
        return _set_status(state, "DRAW", "REPETITION")
    if state.plies_since_capture >= state.config["draw"]["noCapturePlies"]:
        return _set_status(state, "DRAW", "NO_CAPTURE")
    return _set_status(state, "PLAYING", None)


def result_text(status: str, reason: Optional[str]) -> str:
    """Chinese result string (§9.4)."""
    if status == "DRAW":
        return "和棋 · " + (REASON_TEXT.get(reason) or "")
    if status in ("RED_WIN", "BLACK_WIN"):
        win = "红方" if status == "RED_WIN" else "黑方"
        lose = "黑方" if status == "RED_WIN" else "红方"
        why = (
            "长将判负" if reason == "PERPETUAL_CHECK"
            else "认输" if reason == "RESIGN"
            else "超时" if reason == "TIMEOUT"
            else "被将死" if reason == "CHECKMATE"
            else "无子可动（困毙）" if reason == "STALEMATE"
            else (REASON_TEXT.get(reason) or "")
        )
        return win + "胜 · " + lose + why
    return "对局进行中"


# ---------------------------------------------------------------------------
# 12. Setup / shuffle (§5)
# ---------------------------------------------------------------------------

def build_assignment(rand: Callable[[], float], cfg: dict[str, Any]) -> list[tuple[dict[str, Any], Square]]:
    """Build the 30 hidden-piece assignment (including balance modes)."""
    scope = cfg["shuffle"]["scope"]
    balance = cfg["shuffle"]["balance"]
    red_defs = [d for d in POOL_DEFS if d["side"] == "RED"]
    black_defs = [d for d in POOL_DEFS if d["side"] == "BLACK"]
    red_squares = [s for s in ORIGIN_SQUARES if ORIGIN_SIDE(s) == "RED"]
    black_squares = [s for s in ORIGIN_SQUARES if ORIGIN_SIDE(s) == "BLACK"]
    out: list[tuple[dict[str, Any], Square]] = []

    if scope == "perSide":
        r = shuffle(list(red_defs), rand)
        b = shuffle(list(black_defs), rand)
        for s, d in zip(red_squares, r):
            out.append((d, s))
        for s, d in zip(black_squares, b):
            out.append((d, s))
        return out

    if balance == "mirror":
        r = shuffle(list(red_defs), rand)
        by_kind: dict[str, list[dict[str, Any]]] = {}
        for d in black_defs:
            by_kind.setdefault(d["kind"], []).append(d)
        for s, red in zip(red_squares, r):
            out.append((red, s))
            out.append((by_kind[red["kind"]].pop(), Square(10 - s.file, 11 - s.rank)))
        return out

    all_defs = shuffle(list(POOL_DEFS), rand)
    for s, d in zip(ORIGIN_SQUARES, all_defs):
        out.append((d, s))
    return out


def assignment_is_fair(assignment: Sequence[tuple[dict[str, Any], Square]]) -> bool:
    red_strong = 0
    black_strong = 0
    for d, s in assignment:
        if d["kind"] not in ("R", "H", "C"):
            continue
        if ORIGIN_SIDE(s) == "RED":
            red_strong += 1
        else:
            black_strong += 1
    return abs(red_strong - black_strong) <= 2


def place_assignment(state: GameState, assignment: Sequence[tuple[dict[str, Any], Square]]) -> None:
    state.pieces = []
    state.grid = [[None] * 10 for _ in range(11)]
    state.by_id = {}
    for d, s in assignment:
        p = Piece(d["id"], d["side"], d["kind"], False, Square(s.file, s.rank))
        state.pieces.append(p)
        state.by_id.setdefault(p.id, p)
        state.grid[p.at.rank][p.at.file] = p.id
    for side in SIDES:
        d = KING_DEF[side]
        at = Square(5, 1) if side == "RED" else Square(5, 10)
        king = Piece(d["id"], side, "K", True, at)
        state.pieces.append(king)
        state.by_id.setdefault(king.id, king)
        state.grid[at.rank][at.file] = king.id


def reset_for_setup(state: GameState) -> None:
    state.pieces = []
    state.grid = [[None] * 10 for _ in range(11)]
    state.turn = "RED"
    state.ply = 0
    state.status = "PLAYING"
    state.draw_reason = None
    state.in_check = {"RED": False, "BLACK": False}
    state.history = []
    state.position_counts = {}
    state.plies_since_capture = 0
    state.stats = {
        "flips": 0,
        "captures": 0,
        "friendlyFire": 0,
        "hiddenMoves": 0,
        "checks": 0,
        "selfChecks": 0,
    }
    state.by_id = {}


def verify_setup(state: GameState) -> Optional[str]:
    """§5.3 / §8.8 startup invariants; returns an error string or ``None``."""
    alive = alive_pieces(state)
    if len(alive) != 32:
        return "INV-1: piece count"
    hidden = [p for p in alive if not p.face_up]
    if len(hidden) != 30:
        return "INV-1: hidden count"
    if not all(f"{p.at.file},{p.at.rank}" in ORIGIN_KEYS for p in hidden):
        return "INV-1: hidden off origin"
    if is_in_check(state, "RED") or is_in_check(state, "BLACK"):
        return "INV-2: check at setup"
    if generals_face_to_face(state):
        return "INV-3: face to face"
    for p in hidden:
        if not pseudo_moves(state, p):
            return "INV-4: hidden immobilized"
    return None


def setup_state(state: GameState) -> GameState:
    """Run setup with up to 300 derived seeds, asserting §5.3 invariants."""
    reset_for_setup(state)
    cfg = state.config
    last_error: Optional[str] = None
    for attempt in range(300):
        use_seed = str(state.seed) if attempt == 0 else f"{state.seed}#{attempt}"
        rand = mulberry32(hash_seed(use_seed))
        assignment = build_assignment(rand, cfg)
        if cfg["shuffle"]["balance"] == "fair" and not assignment_is_fair(assignment):
            continue
        reset_for_setup(state)
        place_assignment(state, assignment)
        state.layout_seed = use_seed
        err = verify_setup(state)
        if err:
            last_error = err
            continue
        record_position(state)
        evaluate_status(state)
        return state
    raise RuntimeError(f"setup failed after 300 attempts: {last_error}")


def setup(seed: Optional[str] = None, config: Optional[dict[str, Any]] = None) -> "Game":
    """Convenience: create a fresh, set-up game."""
    return Game(seed=seed, config=config)


# ---------------------------------------------------------------------------
# 13. Public view / belief helpers (§11.1 / §12)
# ---------------------------------------------------------------------------

def public_captured(cap: Optional[dict[str, Any]], config: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Sanitize a capture event for public consumption."""
    if cap is None:
        return None
    revealed = bool(
        cap["was_face_up"] or config["revealOnCapture"] or cap["friendly_fire"]
    )
    out: dict[str, Any] = {
        "id": cap["id"],
        "was_face_up": cap["was_face_up"],
        "friendly_fire": cap["friendly_fire"],
        "hidden_when_captured": not cap["was_face_up"],
        "revealed": revealed,
    }
    # An unrevealed hidden piece must not ship real kind/side (not even keys).
    if revealed:
        out["kind"] = cap["kind"]
        out["side"] = cap["side"]
    return out


def public_event(ev: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    """Public ``MoveEvent`` projection."""
    return {
        "ply": ev["ply"],
        "side": ev["side"],
        "from": {"file": ev["from"].file, "rank": ev["from"].rank},
        "to": {"file": ev["to"].file, "rank": ev["to"].rank},
        "notation": ev["notation"],
        "mover_id": ev["mover_id"],
        "mover_was_face_up": ev["mover_was_face_up"],
        "revealed": (
            {"kind": ev["revealed"]["kind"], "side": ev["revealed"]["side"]}
            if ev.get("revealed") else None
        ),
        "captured": public_captured(ev.get("captured"), config),
        "check": {
            "RED": bool((ev.get("check") or {}).get("RED")),
            "BLACK": bool((ev.get("check") or {}).get("BLACK")),
        },
    }


def public_pool(state: GameState) -> list[dict[str, str]]:
    """Remaining unknown identity multiset (§12.3).

    Derived only from public information: initial 30 pieces minus revealed
    pieces and revealed captures.  (Mirrors engine.js, including its treatment
    of unrevealed captures.)
    """
    counts = {
        "RED": dict(INITIAL_PIECE_COUNTS),
        "BLACK": dict(INITIAL_PIECE_COUNTS),
    }
    for p in state.pieces:
        if p.kind == "K":
            continue
        known = p.face_up
        if not known and not is_alive(state, p):
            ev = next(
                (e for e in state.history if e.get("captured") and e["captured"]["id"] == p.id),
                None,
            )
            if ev is not None:
                c = ev["captured"]
                known = bool(c["was_face_up"] or state.config["revealOnCapture"] or c["friendly_fire"])
        if not known:
            continue
        side_counts = counts.get(p.side)
        if side_counts is None or p.kind not in side_counts:
            continue
        side_counts[p.kind] = max(0, side_counts[p.kind] - 1)
    pool: list[dict[str, str]] = []
    for side in SIDES:
        for kind in POOL_KIND_ORDER:
            for _ in range(counts[side][kind]):
                pool.append({"side": side, "kind": kind})
    return pool


def build_ui_state(state: GameState) -> dict[str, Any]:
    """UI-facing public state; hidden pieces never carry kind/side."""
    alive = alive_pieces(state)
    pieces: list[dict[str, Any]] = []
    for p in alive:
        base: dict[str, Any] = {
            "id": p.id,
            "file": p.at.file,
            "rank": p.at.rank,
            "face_up": p.face_up,
            "is_general": p.kind == "K",
        }
        if p.face_up:
            base["kind"] = p.kind
            base["side"] = p.side
        pieces.append(base)

    operable_ids: list[int] = []
    moves_by_id: dict[int, list[dict[str, Any]]] = {}
    if state.status == "PLAYING":
        for p in alive:
            if apparent_side(p) != state.turn:
                continue
            operable_ids.append(p.id)
            moves_by_id[p.id] = [
                {
                    "to": {"file": mv["to"].file, "rank": mv["to"].rank},
                    "capture": mv["capture"],
                }
                for mv in legal_moves_for(state, p, state.turn)
            ]
    # JS object integer keys enumerate in ascending numeric order; mirror that
    # so cross-language consumers iterate ``moves_by_id`` identically.
    moves_by_id = {pid: moves_by_id[pid] for pid in sorted(moves_by_id)}

    checker_squares: dict[str, list[dict[str, int]]] = {"RED": [], "BLACK": []}
    for side in SIDES:
        if not state.in_check[side]:
            continue
        gs = general_square(state, side)
        if gs is None:
            continue
        for p in alive:
            if apparent_side(p) == side:
                continue
            if attacks_square(state, p, gs):
                checker_squares[side].append({"file": p.at.file, "rank": p.at.rank})

    last = state.history[-1] if state.history else None
    captures: list[dict[str, Any]] = []
    for ev in state.history:
        if ev.get("captured") is None:
            continue
        c = public_captured(ev["captured"], state.config)
        assert c is not None
        c = {
            **c,
            "by_side": ev["side"],
            "ply": ev["ply"],
            "at": {"file": ev["to"].file, "rank": ev["to"].rank},
        }
        captures.append(c)

    return {
        "seed": state.seed,
        "layout_seed": state.layout_seed,
        "ply": state.ply,
        "turn": state.turn,
        "status": state.status,
        "draw_reason": state.draw_reason,
        "in_check": {"RED": state.in_check["RED"], "BLACK": state.in_check["BLACK"]},
        "checker_squares": checker_squares,
        "pieces": pieces,
        "operable_ids": operable_ids,
        "moves_by_id": moves_by_id,
        "last_move": (
            {
                "from": {"file": last["from"].file, "rank": last["from"].rank},
                "to": {"file": last["to"].file, "rank": last["to"].rank},
                "ply": last["ply"],
                "side": last["side"],
            }
            if last else None
        ),
        "history": [public_event(e, state.config) for e in state.history],
        "captures": captures,
        "stats": dict(state.stats),
        "config": copy.deepcopy(state.config),
        "can_undo": bool(state.config["undo"] and state.history),
        "result": None if state.status == "PLAYING" else result_text(state.status, state.draw_reason),
        "result_reason": state.draw_reason,
    }


def build_public_state(state: GameState) -> dict[str, Any]:
    """AI/server public state (§12.2 / P-1).

    Hidden pieces expose ``origin_kind`` / ``origin_side`` only; real
    ``kind`` / ``side`` keys are absent.  Also contains the full legal-move
    table for the side to move (§20.3 ``legal`` payload).
    """
    alive = alive_pieces(state)
    pieces: list[dict[str, Any]] = []
    for p in alive:
        base: dict[str, Any] = {
            "id": p.id,
            "file": p.at.file,
            "rank": p.at.rank,
            "face_up": p.face_up,
            "is_general": p.kind == "K",
        }
        if p.face_up:
            base["kind"] = p.kind
            base["side"] = p.side
        else:
            base["origin_kind"] = ORIGIN_KIND[p.at.rank][p.at.file]
            base["origin_side"] = ORIGIN_SIDE(p.at)
        pieces.append(base)

    legal_moves: list[dict[str, Any]] = []
    if state.status == "PLAYING":
        for mv in all_legal_moves(state, state.turn):
            cap: Optional[dict[str, Any]] = None
            if mv["capture"] is not None:
                c = mv["capture"]
                cap = {"id": c["id"], "face_up": c["face_up"], "hidden": not c["face_up"]}
                if c["face_up"]:
                    cap["kind"] = c["kind"]
                    cap["side"] = c["side"]
            legal_moves.append(
                {
                    "from": {"file": mv["from"].file, "rank": mv["from"].rank},
                    "to": {"file": mv["to"].file, "rank": mv["to"].rank},
                    "piece_id": mv["piece_id"],
                    "capture": cap,
                }
            )

    ui = build_ui_state(state)
    return {
        "seed": state.seed,
        "layout_seed": state.layout_seed,
        "ply": state.ply,
        "turn": state.turn,
        "status": state.status,
        "draw_reason": state.draw_reason,
        "in_check": {"RED": state.in_check["RED"], "BLACK": state.in_check["BLACK"]},
        "pieces": pieces,
        "hidden_count": sum(1 for p in pieces if not p["face_up"]),
        "hidden_squares": [
            {"id": p["id"], "file": p["file"], "rank": p["rank"]}
            for p in pieces if not p["face_up"]
        ],
        "legal_moves": legal_moves,
        "pool": public_pool(state),
        "history": ui["history"],
        "stats": ui["stats"],
        "config": copy.deepcopy(state.config),
        "kings": {
            "RED": _sq_dict(general_square(state, "RED")),
            "BLACK": _sq_dict(general_square(state, "BLACK")),
        },
    }


def _sq_dict(s: Optional[Square]) -> Optional[dict[str, int]]:
    return None if s is None else {"file": s.file, "rank": s.rank}


def sample_world(public_state: dict[str, Any], rng: Callable[[], float]) -> GameState:
    """Sample a complete world from a public state + belief pool (§12.5.3)."""
    hidden = sorted(
        (p for p in public_state["pieces"] if not p["face_up"]),
        key=lambda p: p["id"],
    )
    pool = [dict(x) for x in public_state["pool"]]
    if len(pool) < len(hidden):
        raise ValueError("belief pool smaller than hidden count")
    shuffle(pool, rng)
    assigned = {h["id"]: pool[i] for i, h in enumerate(hidden)}
    specs: list[dict[str, Any]] = []
    for p in public_state["pieces"]:
        if p["face_up"]:
            specs.append(
                {
                    "id": p["id"], "side": p["side"], "kind": p["kind"],
                    "faceUp": True, "file": p["file"], "rank": p["rank"],
                }
            )
        else:
            a = assigned[p["id"]]
            specs.append(
                {
                    "id": p["id"], "side": a["side"], "kind": a["kind"],
                    "faceUp": False, "file": p["file"], "rank": p["rank"],
                }
            )
    world = create_position(
        {
            "pieces": specs,
            "turn": public_state["turn"],
            "config": public_state["config"],
            "seed": public_state["seed"],
        }
    )
    world.ply = public_state["ply"]
    return world


def build_oracle_world(state: GameState) -> GameState:
    """Oracle-only world with real identities (UI must mark it)."""
    specs = [
        {
            "id": p.id, "side": p.side, "kind": p.kind,
            "faceUp": p.face_up, "file": p.at.file, "rank": p.at.rank,
        }
        for p in alive_pieces(state)
    ]
    world = create_position(
        {"pieces": specs, "turn": state.turn, "config": state.config, "seed": state.seed}
    )
    world.ply = state.ply
    return world


# ---------------------------------------------------------------------------
# 14. Game wrapper
# ---------------------------------------------------------------------------

def _js_number(value: Any) -> float:
    """Best-effort JS ``Number(value)`` for config validation."""
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip()
        if s == "":
            return 0.0
        try:
            return float(s)
        except ValueError:
            return float("nan")
    if value is None:
        return 0.0
    return float("nan")


class Game:
    """Lightweight game wrapper around :class:`GameState` (JS ``class Game``)."""

    MAX_SNAPSHOTS = 400

    def __init__(
        self,
        position: Optional[dict[str, Any]] = None,
        config: Optional[dict[str, Any]] = None,
        seed: Optional[str] = None,
    ) -> None:
        pos_config = position.get("config") if isinstance(position, dict) else None
        self.config = merge_config(config if config is not None else pos_config)
        qdepth = _js_number(self.config.get("ai", {}).get("qdepth"))
        if not math.isfinite(qdepth) or qdepth <= 0:
            raise ValueError("AI: ai.qdepth must be > 0 (quiescence is mandatory)")
        self.config["ai"]["qdepth"] = int(qdepth) if qdepth.is_integer() else qdepth

        pos_seed = position.get("seed") if isinstance(position, dict) else None
        raw_seed = seed if seed else pos_seed
        self.seed = str(raw_seed) if raw_seed else random_seed()
        self._snapshots: list[GameState] = []
        if position is not None:
            pos = dict(position)
            pos["config"] = self.config
            pos["seed"] = self.seed
            self.state = create_position(pos)
        else:
            self.state = empty_state(self.config, self.seed)
            setup_state(self.state)

    # -- constructors ------------------------------------------------------

    @classmethod
    def from_position(cls, position: dict[str, Any]) -> "Game":
        return cls(
            position=position,
            seed=position.get("seed") or "position",
            config=position.get("config"),
        )

    # -- queries -----------------------------------------------------------

    @property
    def turn(self) -> str:
        return self.state.turn

    @property
    def ply(self) -> int:
        return self.state.ply

    @property
    def status(self) -> str:
        return self.state.status

    @property
    def draw_reason(self) -> Optional[str]:
        return self.state.draw_reason

    @property
    def in_check(self) -> dict[str, bool]:
        return self.state.in_check

    @property
    def pieces(self) -> list[Piece]:
        return self.state.pieces

    @property
    def history(self) -> list[dict[str, Any]]:
        return self.state.history

    @property
    def stats(self) -> dict[str, int]:
        return self.state.stats

    def piece_at(self, a: Any, b: Optional[int] = None) -> Optional[Piece]:
        return piece_at(self.state, as_square(a, b))

    def can_operate(self, p: Optional[Piece]) -> bool:
        return can_operate(p, self.state.turn)

    def legal_moves_from(self, a: Any, b: Optional[int] = None) -> list[dict[str, Any]]:
        s = as_square(a, b)
        p = piece_at(self.state, s)
        if p is None:
            return []
        return legal_moves_for(self.state, p, self.state.turn)

    def all_legal_moves(self, side: Optional[str] = None) -> list[dict[str, Any]]:
        return all_legal_moves(self.state, side or self.state.turn)

    def is_in_check(self, side: str) -> bool:
        return is_in_check(self.state, side)

    def get_position_key(self) -> str:
        return position_key(self.state)

    # -- operations --------------------------------------------------------

    def move(self, from_sq: Any, to_sq: Any) -> dict[str, Any]:
        """Execute a legal move.

        Returns the **raw internal** event (it contains real captured
        identities for server-side truth).  Network/UI layers must project it
        through :func:`public_event` before sending it to a client.
        """
        if self.state.status != "PLAYING":
            return {"ok": False, "code": "GAME_OVER", "message": "对局已结束"}
        f = as_square(from_sq)
        t = as_square(to_sq)
        res = check_move(self.state, f, t)
        if not res["ok"]:
            return res
        self._snapshots.append(clone_state(self.state))
        if len(self._snapshots) > self.MAX_SNAPSHOTS:
            self._snapshots.pop(0)
        event = apply_move(self.state, f, t)
        return {"ok": True, "event": event}

    def undo(self) -> dict[str, Any]:
        if not self.config["undo"]:
            return {"ok": False, "code": "UNDO_DISABLED"}
        if not self._snapshots:
            return {"ok": False, "code": "NO_HISTORY"}
        self.state = self._snapshots.pop()
        return {"ok": True}

    def resign(self, side: Optional[str] = None) -> dict[str, Any]:
        if self.state.status != "PLAYING":
            return {"ok": False, "code": "GAME_OVER"}
        loser = side or self.state.turn
        self.state.status = "BLACK_WIN" if loser == "RED" else "RED_WIN"
        self.state.draw_reason = "RESIGN"
        return {"ok": True}

    def agree_draw(self) -> dict[str, Any]:
        if self.state.status != "PLAYING":
            return {"ok": False, "code": "GAME_OVER"}
        self.state.status = "DRAW"
        self.state.draw_reason = "AGREEMENT"
        return {"ok": True}

    # -- views -------------------------------------------------------------

    def ui_state(self) -> dict[str, Any]:
        return build_ui_state(self.state)

    def public_state(self) -> dict[str, Any]:
        return build_public_state(self.state)

    def public_pool(self) -> list[dict[str, str]]:
        return public_pool(self.state)

    def oracle_world(self) -> GameState:
        return build_oracle_world(self.state)

    def final_reveal(self) -> list[dict[str, Any]]:
        """Post-game reveal of all 32 real identities (§9.4)."""
        if self.state.status == "PLAYING":
            raise ValueError("finalReveal only after game over")
        out: list[dict[str, Any]] = []
        for p in self.state.pieces:
            alive = is_alive(self.state, p)
            cap = next(
                (e for e in self.state.history if e.get("captured") and e["captured"]["id"] == p.id),
                None,
            )
            out.append(
                {
                    "id": p.id,
                    "side": p.side,
                    "kind": p.kind,
                    "face_up": p.face_up,
                    "alive": alive,
                    "at": {"file": p.at.file, "rank": p.at.rank},
                    "captured_by": cap["side"] if cap else None,
                    "captured_ply": cap["ply"] if cap else None,
                }
            )
        return out

    def preview_public(self, from_sq: Any, to_sq: Any) -> Optional[dict[str, Any]]:
        """Public-information-only preview (used by honest AI)."""
        st = self.state
        f = as_square(from_sq)
        t = as_square(to_sq)
        p = piece_at(st, f)
        if p is None:
            return None
        undo = simulate(st, p, t, False)
        enemies = [
            q for q in alive_pieces(st)
            if apparent_side(q) != apparent_side(p) and attacks_square(st, q, t)
        ]
        self_check = is_in_check(st, st.turn)
        faced = generals_face_to_face(st)
        gives_check = is_in_check(st, other(p.side)) if p.face_up else None
        unsimulate(st, undo)
        return {
            "attackers": [{"id": q.id, "file": q.at.file, "rank": q.at.rank} for q in enemies],
            "self_check": self_check,
            "faced": faced,
            "gives_check": gives_check,
        }

    def to_json(self) -> dict[str, Any]:
        """JSON-serializable summary (public history; no hidden identities)."""
        view = self.ui_state()
        return {
            "game": "blind-xiangqi",
            "version": 1,
            "seed": self.seed,
            "turn": view["turn"],
            "ply": view["ply"],
            "status": view["status"],
            "draw_reason": view["draw_reason"],
            "config": view["config"],
            "history": view["history"],
        }

    def export_text(self) -> str:
        """Human-readable game record (seed + coordinate notation)."""
        lines: list[str] = []
        lines.append("盲棋象棋 Blind Xiangqi · 战报")
        lines.append("seed: " + self.seed)
        lines.append("结果: " + result_text(self.state.status, self.state.draw_reason))
        lines.append("手数: " + str(self.state.ply) + " 半步")
        lines.append("---")
        for ev in self.state.history:
            tags: list[str] = []
            if ev.get("revealed"):
                r = ev["revealed"]
                tags.append("翻" + SIDE_CHAR[r["side"]] + NAMES[r["side"]][r["kind"]])
            if ev.get("captured"):
                c = ev["captured"]
                revealed = bool(
                    c["was_face_up"]
                    or self.state.config["revealOnCapture"]
                    or c["friendly_fire"]
                )
                if revealed:
                    tags.append(
                        "吃" + SIDE_CHAR[c["side"]] + NAMES[c["side"]][c["kind"]]
                        + ("" if c["was_face_up"] else "·暗")
                    )
                else:
                    tags.append("吃暗子")
                if c["friendly_fire"]:
                    tags.append("误伤")
            if (ev.get("check") or {}).get(other(ev["side"])):
                tags.append("将")
            lines.append(
                f"{ev['ply']:>3}. {SIDE_CHAR[ev['side']]} {ev['notation']}"
                + ("  " + " ".join(tags) if tags else "")
            )
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# 15. Position construction (tests / scenarios / teaching)
# ---------------------------------------------------------------------------

def create_position(options: dict[str, Any]) -> GameState:
    """Construct a synthetic position from piece specs.

    Each spec uses JS-compatible keys: ``id?``, ``side``, ``kind``, ``file``,
    ``rank``, ``faceUp?`` (default ``True``).  Turn defaults to RED.
    ``status`` stays PLAYING; callers may call :func:`evaluate_status`.
    """
    options = options or {}
    state = empty_state(merge_config(options.get("config")), options.get("seed") or "position")
    state.pieces = []
    state.grid = [[None] * 10 for _ in range(11)]
    state.by_id = {}
    next_id = 1000
    for spec in options.get("pieces") or []:
        if spec.get("id") is not None:
            pid = spec["id"]
        else:
            pid = next_id
            next_id += 1
        face_up = spec.get("faceUp", spec.get("face_up", True)) is not False
        p = Piece(pid, spec["side"], spec["kind"], face_up, Square(spec["file"], spec["rank"]))
        state.pieces.append(p)
        state.by_id.setdefault(p.id, p)
        state.grid[p.at.rank][p.at.file] = p.id
    state.turn = options.get("turn") or "RED"
    state.ply = 0
    state.status = "PLAYING"
    state.draw_reason = None
    state.plies_since_capture = 0
    state.position_counts = {}
    state.history = []
    recompute_check(state)
    record_position(state)
    return state
