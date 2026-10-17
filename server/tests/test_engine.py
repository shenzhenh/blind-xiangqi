"""Blind Xiangqi Python engine — stdlib ``unittest`` acceptance suite.

Run from the workspace root::

    python -m unittest discover -s server/tests -v

The test numbers mirror spec §14 (T-01..T-56) and the assertions in
``tests/engine.test.cjs``.  A few tests are slightly stronger than the JS
suite: the exhaustive-probe tests call ``check_move`` without mutating the
position, so every candidate target is genuinely evaluated.
"""

from __future__ import annotations

import copy
import json
import os
import sys
import unittest
from collections import Counter
from pathlib import Path

# Make ``server`` importable regardless of the discovery start directory.
_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server import engine as E  # noqa: E402

# The statistical tests default to the full spec counts.  Set
# BLIND_XIANGQI_SLOW=0 to shrink them during quick local iteration.
_SLOW = os.environ.get("BLIND_XIANGQI_SLOW", "1") != "0"
T03_N = 1000 if _SLOW else 100
T05_N = 10000 if _SLOW else 1000


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def S(side: str, kind: str, file: int, rank: int, face_up: bool = True) -> dict:
    return {"side": side, "kind": kind, "file": file, "rank": rank, "faceUp": face_up}


def HIDDEN(side: str, kind: str, file: int, rank: int) -> dict:
    return S(side, kind, file, rank, face_up=False)


def kings() -> list[dict]:
    return [
        S("RED", "K", 5, 1),
        S("BLACK", "K", 5, 10),
        S("BLACK", "P", 5, 6),
    ]


def pos(pieces, turn: str = "RED", config=None) -> E.Game:
    position = {"pieces": pieces, "turn": turn}
    if config is not None:
        position["config"] = config
    return E.Game(position=position, config=config)


def _to_square(value):
    if isinstance(value, dict) and "to" in value:
        value = value["to"]
    return E.as_square(value)


def coords(items) -> list[str]:
    return sorted(E.coord(_to_square(m)) for m in items)


def moves_of(g: E.Game, file: int, rank: int) -> list[str]:
    return coords(g.legal_moves_from(file, rank))


def moves_for_side(g: E.Game, file: int, rank: int, side: str) -> list[str]:
    return coords(E.legal_moves_for(g.state, g.piece_at(file, rank), side))


def try_move(g: E.Game, from_sq, to_sq) -> dict:
    return g.move(from_sq, to_sq)


def do_move(g: E.Game, from_sq, to_sq) -> dict:
    res = try_move(g, from_sq, to_sq)
    assert res["ok"], f"expected legal move {from_sq}->{to_sq}, got {res}"
    return res["event"]


def piece_list(g: E.Game) -> list[dict]:
    return g.ui_state()["pieces"]


def key_sets(pieces: list[dict]) -> list[set]:
    return [set(p) for p in pieces]


# ---------------------------------------------------------------------------
# Opening / shuffle (T-01 .. T-05)
# ---------------------------------------------------------------------------

class OpeningTests(unittest.TestCase):
    def test_t01_32_pieces_generals_face_up_on_origin(self):
        g = E.Game(seed="t01")
        pieces = piece_list(g)
        self.assertEqual(len(pieces), 32)
        red_k = g.piece_at(5, 1)
        black_k = g.piece_at(5, 10)
        self.assertEqual((red_k.kind, red_k.side, red_k.face_up), ("K", "RED", True))
        self.assertEqual((black_k.kind, black_k.side, black_k.face_up), ("K", "BLACK", True))

    def test_t02_other_30_hidden_on_origin_squares(self):
        g = E.Game(seed="t02")
        hidden = [p for p in piece_list(g) if not p["face_up"]]
        self.assertEqual(len(hidden), 30)
        for p in hidden:
            origin = E.ORIGIN_KIND[p["rank"]][p["file"]]
            self.assertIsNotNone(origin)
            self.assertNotEqual(origin, "K")
        occupied = {(p["file"], p["rank"]) for p in hidden}
        self.assertEqual(len(occupied), 30)

    def test_t03_1000_seeds_no_check_no_face_to_face(self):
        for i in range(T03_N):
            g = E.Game(seed=f"inv-{i}")
            self.assertFalse(g.is_in_check("RED"), f"red check seed {i}")
            self.assertFalse(g.is_in_check("BLACK"), f"black check seed {i}")
            self.assertFalse(E.generals_face_to_face(g.state), f"face seed {i}")

    def test_t04_same_seed_reproducible(self):
        a = E.Game(seed="repro-42")
        b = E.Game(seed="repro-42")
        self.assertEqual(a.get_position_key(), b.get_position_key())
        self.assertEqual(a.ui_state()["pieces"], b.ui_state()["pieces"])

    def test_t05_global_shuffle_red_on_black_half_about_half(self):
        red_on_black_half = 0
        total_red = 0
        for i in range(T05_N):
            g = E.Game(seed=f"mix-{i}")
            for p in g.pieces:
                if p.side != "RED":
                    continue
                total_red += 1
                if p.at.rank >= 6:
                    red_on_black_half += 1
        ratio = red_on_black_half / total_red
        self.assertGreater(ratio, 0.44, f"ratio={ratio}")
        self.assertLess(ratio, 0.56, f"ratio={ratio}")

    def test_balance_mirror_and_fair(self):
        mirror = E.Game(seed="mirror-1", config={"shuffle": {"balance": "mirror"}})
        for p in mirror.pieces:
            if p.kind == "K":
                continue
            m = mirror.piece_at(10 - p.at.file, 11 - p.at.rank)
            self.assertIsNotNone(m)
            self.assertEqual(m.kind, p.kind)
            self.assertNotEqual(m.side, p.side)
        for i in range(40):
            g = E.Game(seed=f"fair-{i}", config={"shuffle": {"balance": "fair"}})
            red = black = 0
            for p in g.pieces:
                if p.kind not in ("R", "H", "C"):
                    continue
                if p.at.rank <= 5:
                    red += 1
                else:
                    black += 1
            self.assertLessEqual(abs(red - black), 2, f"fair imbalance {red}/{black}")

    def test_per_side_scope_keeps_each_side_in_its_half(self):
        g = E.Game(seed="per-side", config={"shuffle": {"scope": "perSide"}})
        for p in g.pieces:
            if p.kind == "K":
                continue
            self.assertEqual(E.ORIGIN_SIDE(p.at), p.side)

    def test_merge_config_and_qdepth_validation(self):
        d = E.merge_config()
        self.assertIsNot(d, E.DEFAULT_CONFIG)
        self.assertEqual(d["draw"]["noCapturePlies"], 120)
        u = E.merge_config({"strictCheck": True, "draw": {"noCapturePlies": 4}, "custom": 7})
        self.assertTrue(u["strictCheck"])
        self.assertEqual(u["draw"]["noCapturePlies"], 4)
        self.assertEqual(u["draw"]["perpetualCheck"], "lose")
        self.assertEqual(u["custom"], 7)
        with self.assertRaises(ValueError):
            E.Game(seed="q0", config={"ai": {"qdepth": 0}})
        with self.assertRaises(ValueError):
            E.Game(seed="qneg", config={"ai": {"qdepth": -1}})
        with self.assertRaises(ValueError):
            E.Game(seed="qnan", config={"ai": {"qdepth": "nope"}})
        g = E.Game(seed="qok", config={"ai": {"qdepth": "4"}})
        self.assertEqual(g.config["ai"]["qdepth"], 4)


# ---------------------------------------------------------------------------
# Hidden-piece movement (T-06 .. T-12)
# ---------------------------------------------------------------------------

class HiddenMoveTests(unittest.TestCase):
    def test_t06_hidden_rook_slides_stops_at_first_piece(self):
        g = pos([HIDDEN("RED", "R", 1, 1)])
        all_moves = moves_of(g, 1, 1)
        self.assertEqual(len(all_moves), 17)
        self.assertIn("f1r10", all_moves)
        self.assertIn("f9r1", all_moves)

        g2 = pos([HIDDEN("RED", "R", 1, 1), S("BLACK", "C", 1, 4)])
        stops = moves_of(g2, 1, 1)
        self.assertIn("f1r4", stops)
        self.assertNotIn("f1r5", stops)

    def test_t07_hidden_advisor_locked_to_palace(self):
        g = pos([HIDDEN("RED", "A", 4, 1)])
        self.assertEqual(moves_of(g, 4, 1), ["f5r2"])

    def test_t08_hidden_elephant_eye_and_river(self):
        g = pos([HIDDEN("RED", "E", 3, 1)])
        self.assertEqual(moves_of(g, 3, 1), ["f1r3", "f5r3"])
        blocked = pos([HIDDEN("RED", "E", 3, 1), S("BLACK", "P", 2, 2)])
        self.assertEqual(moves_of(blocked, 3, 1), ["f5r3"])

    def test_t09_hidden_knight_legs(self):
        g = pos([HIDDEN("RED", "H", 2, 1)])
        self.assertEqual(moves_of(g, 2, 1), ["f1r3", "f3r3", "f4r2"])
        leg_blocked = pos([HIDDEN("RED", "H", 2, 1), S("RED", "P", 2, 2)])
        self.assertEqual(moves_of(leg_blocked, 2, 1), ["f4r2"])

    def test_t10_hidden_cannon_screen(self):
        g = pos([
            HIDDEN("RED", "C", 2, 3),
            S("BLACK", "P", 2, 5),  # screen
            S("BLACK", "R", 2, 8),  # target
        ])
        moves = moves_of(g, 2, 3)
        self.assertIn("f2r8", moves)
        self.assertNotIn("f2r5", moves)
        self.assertIn("f2r4", moves)

        no_screen = pos([HIDDEN("RED", "C", 2, 3), S("BLACK", "R", 2, 8)])
        self.assertNotIn("f2r8", moves_of(no_screen, 2, 3))

        two_screens = pos([
            HIDDEN("RED", "C", 2, 3),
            S("BLACK", "P", 2, 5),
            S("BLACK", "P", 2, 6),
            S("BLACK", "R", 2, 8),
        ])
        self.assertNotIn("f2r8", moves_of(two_screens, 2, 3))

    def test_t11_hidden_pawn_forward_only(self):
        g = pos([HIDDEN("RED", "P", 5, 4)])
        self.assertEqual(moves_of(g, 5, 4), ["f5r5"])

    def test_t12_dark_pawn_uses_origin_direction(self):
        g = pos([HIDDEN("RED", "P", 5, 7)], "BLACK")
        self.assertEqual(moves_of(g, 5, 7), ["f5r6"])
        self.assertEqual(g.piece_at(5, 7).side, "RED")
        self.assertEqual(E.apparent_side(g.piece_at(5, 7)), "BLACK")


# ---------------------------------------------------------------------------
# Reveal (T-13 .. T-15)
# ---------------------------------------------------------------------------

class RevealTests(unittest.TestCase):
    def test_t13_hidden_move_reveals_on_destination(self):
        g = pos([HIDDEN("RED", "R", 1, 1)])
        ev = do_move(g, (1, 1), (1, 3))
        self.assertTrue(g.piece_at(1, 3).face_up)
        self.assertEqual(ev["revealed"], {"kind": "R", "side": "RED"})
        self.assertFalse(ev["mover_was_face_up"])

    def test_t14_hidden_capture_move_and_flip_together(self):
        g = pos([HIDDEN("RED", "R", 1, 1), S("BLACK", "P", 1, 4)])
        ev = do_move(g, (1, 1), (1, 4))
        self.assertEqual(ev["captured"]["kind"], "P")
        self.assertTrue(ev["captured"]["was_face_up"])
        self.assertTrue(g.piece_at(1, 4).face_up)
        self.assertIsNone(g.piece_at(1, 1))

    def test_t15_attacked_or_checked_hidden_piece_does_not_reveal(self):
        g = pos([
            *kings(),
            HIDDEN("RED", "R", 1, 1),
            S("BLACK", "R", 1, 5),
            HIDDEN("RED", "H", 9, 1),
        ])
        do_move(g, (9, 1), (9, 2))
        self.assertFalse(g.piece_at(1, 1).face_up)
        view = next(p for p in piece_list(g) if p["file"] == 1 and p["rank"] == 1)
        self.assertNotIn("kind", view)
        self.assertNotIn("side", view)


# ---------------------------------------------------------------------------
# Captures / friendly fire (T-16 .. T-23)
# ---------------------------------------------------------------------------

class CaptureTests(unittest.TestCase):
    def test_t16_face_up_attacks_hidden_with_possible_friendly_fire(self):
        friendly = pos([S("RED", "R", 1, 1), HIDDEN("RED", "P", 1, 4)])
        ev = do_move(friendly, (1, 1), (1, 4))
        self.assertTrue(ev["captured"]["friendly_fire"])
        self.assertEqual(ev["captured"]["kind"], "P")

        enemy = pos([S("RED", "R", 1, 1), HIDDEN("BLACK", "P", 1, 4)])
        ev2 = do_move(enemy, (1, 1), (1, 4))
        self.assertFalse(ev2["captured"]["friendly_fire"])

    def test_t17_face_up_cannot_capture_own_face_up(self):
        g = pos([S("RED", "R", 1, 1), S("RED", "P", 1, 4)])
        res = try_move(g, (1, 1), (1, 4))
        self.assertFalse(res["ok"])
        self.assertEqual(res["code"], "OWN_PIECE")

    def test_t18_hidden_vs_hidden_same_apparent_side_illegal(self):
        g = pos([HIDDEN("RED", "R", 1, 1), HIDDEN("BLACK", "P", 1, 4)])
        res = try_move(g, (1, 1), (1, 4))
        self.assertFalse(res["ok"])
        self.assertEqual(res["code"], "APPARENT_ALLY")
        self.assertNotIn("f1r4", moves_of(g, 1, 1))

    def test_t19_hidden_vs_hidden_opposite_apparent_side_legal(self):
        g = pos([HIDDEN("RED", "R", 1, 1), HIDDEN("RED", "P", 1, 7)])
        self.assertIn("f1r7", moves_of(g, 1, 1))
        ev = do_move(g, (1, 1), (1, 7))
        self.assertFalse(ev["captured"]["was_face_up"])
        self.assertIsNone(g.piece_at(1, 1))

    def test_t20_hidden_vs_face_up_same_apparent_side_illegal(self):
        g = pos([HIDDEN("RED", "R", 1, 1), S("RED", "R", 1, 4)])
        res = try_move(g, (1, 1), (1, 4))
        self.assertEqual(res["code"], "APPARENT_ALLY")

    def test_t21_hidden_vs_face_up_opposite_apparent_side_legal(self):
        g = pos([HIDDEN("RED", "R", 1, 1), S("BLACK", "R", 1, 4)])
        self.assertIn("f1r4", moves_of(g, 1, 1))

    def test_t22_probe_set_independent_of_real_identity(self):
        variants = []
        for side in E.SIDES:
            for kind in ("A", "E", "H", "R", "C", "P"):
                g = pos([
                    HIDDEN(side, kind, 1, 1),
                    S("RED", "R", 5, 5),
                    S("BLACK", "R", 5, 6),
                    HIDDEN("RED", "P", 1, 7),
                    HIDDEN("BLACK", "P", 3, 7),
                ])
                rejected = []
                for f in range(1, 10):
                    for r in range(1, 11):
                        if (f, r) == (1, 1):
                            continue
                        if not E.check_move(g.state, (1, 1), (f, r))["ok"]:
                            rejected.append(E.coord(E.Square(f, r)))
                variants.append(",".join(sorted(rejected)))
        self.assertEqual(len(set(variants)), 1, "rejection set depends on hidden identity")

    def test_t23_hidden_vs_hidden_same_real_side_marks_friendly_fire(self):
        g = pos([HIDDEN("RED", "R", 1, 1), HIDDEN("RED", "P", 1, 7)])
        ev = do_move(g, (1, 1), (1, 7))
        self.assertTrue(ev["captured"]["friendly_fire"])
        self.assertEqual(ev["captured"]["side"], "RED")


# ---------------------------------------------------------------------------
# Region constraints D4 (T-24 .. T-29)
# ---------------------------------------------------------------------------

class RegionTests(unittest.TestCase):
    def test_t24_hidden_advisor_locked(self):
        g = pos([HIDDEN("RED", "A", 4, 1)])
        self.assertEqual(moves_of(g, 4, 1), ["f5r2"])

    def test_t25_hidden_elephant_cannot_cross_river(self):
        g = pos([HIDDEN("RED", "E", 3, 1)])
        self.assertEqual(moves_of(g, 3, 1), ["f1r3", "f5r3"])

    def test_t26_revealed_advisor_moves_anywhere_diagonally(self):
        g = pos([HIDDEN("RED", "A", 1, 1)])
        do_move(g, (1, 1), (1, 9))
        p = g.piece_at(1, 9)
        self.assertEqual((p.kind, p.side, p.face_up), ("A", "RED", True))
        self.assertEqual(moves_for_side(g, 1, 9, "RED"), ["f2r10", "f2r8"])

    def test_t27_revealed_elephant_can_cross_river(self):
        g = pos([HIDDEN("RED", "E", 1, 1)])
        do_move(g, (1, 1), (1, 7))
        p = g.piece_at(1, 7)
        self.assertEqual(p.kind, "E")
        self.assertEqual(moves_for_side(g, 1, 7, "RED"), ["f3r5", "f3r9"])

    def test_t28_generals_always_palace_bound(self):
        g = pos([S("RED", "K", 5, 1), S("BLACK", "K", 5, 10), S("BLACK", "P", 5, 6)])
        self.assertEqual(moves_of(g, 5, 1), ["f4r1", "f5r2", "f6r1"])
        corner = pos([S("RED", "K", 4, 3), S("BLACK", "K", 5, 10), S("BLACK", "P", 5, 6)])
        self.assertEqual(moves_of(corner, 4, 3), ["f4r2", "f5r3"])

    def test_t29_face_up_pawn_river_rules(self):
        home = pos([S("RED", "P", 4, 4)])
        self.assertEqual(moves_of(home, 4, 4), ["f4r5"])
        crossed = pos([S("RED", "P", 4, 6)])
        self.assertEqual(moves_of(crossed, 4, 6), ["f3r6", "f4r7", "f5r6"])


# ---------------------------------------------------------------------------
# Rule boundaries (T-30 .. T-34)
# ---------------------------------------------------------------------------

class BoundaryTests(unittest.TestCase):
    def test_t30_face_to_face_move_rejected(self):
        g = pos([S("RED", "K", 5, 1), S("BLACK", "K", 5, 10), S("RED", "R", 5, 5)])
        res = try_move(g, (5, 5), (4, 5))
        self.assertFalse(res["ok"])
        self.assertEqual(res["code"], "FACE_TO_FACE")
        self.assertTrue(try_move(g, (5, 5), (5, 4))["ok"])

    def test_t31_self_check_move_rejected(self):
        g = pos([S("RED", "K", 5, 1), S("RED", "R", 3, 1), S("BLACK", "R", 1, 1)])
        res = try_move(g, (3, 1), (3, 2))
        self.assertFalse(res["ok"])
        self.assertEqual(res["code"], "SEND_CHECK")
        self.assertTrue(try_move(g, (3, 1), (4, 1))["ok"])

    def test_t32_hidden_attacks_general_by_origin_kind(self):
        g = pos([S("RED", "K", 1, 3), HIDDEN("BLACK", "R", 1, 10)])
        self.assertTrue(g.is_in_check("RED"))
        blocked = pos([S("RED", "K", 1, 3), HIDDEN("BLACK", "R", 1, 10), S("BLACK", "P", 1, 6)])
        self.assertFalse(blocked.is_in_check("RED"))

    def test_t33_revealed_pawn_direction_reverses(self):
        g = pos([HIDDEN("RED", "P", 3, 7)], "BLACK")
        do_move(g, (3, 7), (3, 6))
        p = g.piece_at(3, 6)
        self.assertEqual(p.side, "RED")
        self.assertEqual(g.turn, "RED")
        self.assertEqual(moves_of(g, 3, 6), ["f2r6", "f3r7", "f4r6"])
        self.assertNotIn("f3r5", moves_of(g, 3, 6))

    def test_t34_stuck_pawn_no_moves_but_game_continues(self):
        g = pos([
            S("RED", "K", 5, 1),
            S("BLACK", "K", 5, 10),   # overwritten below on (5,10) by the red pawn
            S("BLACK", "P", 5, 6),
            S("RED", "P", 5, 10),
            S("RED", "R", 4, 10),
            S("RED", "R", 6, 10),
        ])
        self.assertEqual(moves_of(g, 5, 10), [])
        res = E.evaluate_status(g.state)
        self.assertEqual(res["status"], "PLAYING")

    def test_check_move_error_codes(self):
        g = pos([S("RED", "K", 5, 1), S("BLACK", "K", 5, 10), S("BLACK", "P", 5, 6)])
        self.assertEqual(E.check_move(g.state, (0, 1), (1, 1))["code"], "OUT_OF_BOARD")
        self.assertEqual(E.check_move(g.state, (5, 1), (5, 1))["code"], "SAME_SQUARE")
        self.assertEqual(E.check_move(g.state, (4, 4), (4, 5))["code"], "NO_PIECE")
        black_k = E.piece_at(g.state, E.Square(5, 10))
        self.assertEqual(E.check_move(g.state, black_k.at, (4, 10))["code"], "NOT_YOUR_PIECE")
        g2 = pos([S("RED", "R", 1, 1)])
        self.assertEqual(E.check_move(g2.state, (1, 1), (2, 2))["code"], "GEOMETRY")


# ---------------------------------------------------------------------------
# Endings (T-35 .. T-39)
# ---------------------------------------------------------------------------

class EndingTests(unittest.TestCase):
    def test_t35_checkmate(self):
        g = pos([
            S("RED", "K", 5, 1),
            S("BLACK", "K", 5, 10),
            S("BLACK", "R", 5, 3),
            S("BLACK", "R", 1, 1),
            S("BLACK", "R", 6, 10),
        ])
        self.assertTrue(g.is_in_check("RED"))
        res = E.evaluate_status(g.state)
        self.assertEqual(res["status"], "BLACK_WIN")
        self.assertEqual(res["reason"], "CHECKMATE")

    def test_t36_stalemate(self):
        g = pos([
            S("RED", "K", 5, 1),
            S("BLACK", "K", 5, 10),
            S("BLACK", "R", 4, 3),
            S("BLACK", "R", 6, 3),
            S("BLACK", "R", 1, 2),
            S("BLACK", "P", 5, 5),
        ])
        self.assertFalse(g.is_in_check("RED"))
        res = E.evaluate_status(g.state)
        self.assertEqual(res["status"], "BLACK_WIN")
        self.assertEqual(res["reason"], "STALEMATE")

    def test_t37_perpetual_check_loses(self):
        g = pos(
            [
                S("RED", "K", 5, 1),
                S("BLACK", "K", 5, 10),
                S("BLACK", "P", 5, 6),
                S("BLACK", "R", 5, 3),
            ],
            "RED",
        )
        self.assertTrue(g.is_in_check("RED"))
        cycle = [
            ((5, 1), (4, 1)),
            ((5, 3), (4, 3)),
            ((4, 1), (5, 1)),
            ((4, 3), (5, 3)),
        ]
        for _ in range(2):
            for f, t in cycle:
                do_move(g, f, t)
        self.assertEqual(g.status, "RED_WIN")
        self.assertEqual(g.draw_reason, "PERPETUAL_CHECK")

    def test_t38_threefold_repetition_draw(self):
        g = pos(
            [
                S("RED", "K", 5, 1),
                S("BLACK", "K", 5, 10),
                S("BLACK", "P", 5, 5),
            ],
            "RED",
        )
        cycle = [
            ((5, 1), (4, 1)),
            ((5, 10), (6, 10)),
            ((4, 1), (5, 1)),
            ((6, 10), (5, 10)),
        ]
        for _ in range(2):
            for f, t in cycle:
                do_move(g, f, t)
        self.assertEqual(g.status, "DRAW")
        self.assertEqual(g.draw_reason, "REPETITION")

    def test_t39_no_capture_draw(self):
        g = pos(
            [
                S("RED", "K", 5, 1),
                S("BLACK", "K", 5, 10),
                S("BLACK", "P", 5, 5),
            ],
            "RED",
            {"draw": {"noCapturePlies": 4, "repetition": 99}},
        )
        do_move(g, (5, 1), (4, 1))
        do_move(g, (5, 10), (6, 10))
        do_move(g, (4, 1), (5, 1))
        do_move(g, (6, 10), (5, 10))
        self.assertEqual(g.status, "DRAW")
        self.assertEqual(g.draw_reason, "NO_CAPTURE")

    def test_result_text(self):
        self.assertEqual(E.result_text("DRAW", "REPETITION"), "和棋 · 三次重复局面")
        self.assertEqual(E.result_text("RED_WIN", "CHECKMATE"), "红方胜 · 黑方被将死")
        self.assertEqual(E.result_text("BLACK_WIN", "STALEMATE"), "黑方胜 · 红方无子可动（困毙）")
        self.assertEqual(E.result_text("RED_WIN", "RESIGN"), "红方胜 · 黑方认输")
        self.assertEqual(E.result_text("PLAYING", None), "对局进行中")


# ---------------------------------------------------------------------------
# Information security (T-40 .. T-42)
# ---------------------------------------------------------------------------

class SecurityTests(unittest.TestCase):
    def test_t40_downstream_views_have_no_hidden_identity(self):
        g = E.Game(seed="sec-1")
        view = g.ui_state()
        for p in view["pieces"]:
            if p["face_up"]:
                continue
            self.assertNotIn("kind", p)
            self.assertNotIn("side", p)
        serialized = json.dumps(view)
        self.assertEqual(serialized.count('"kind"'), 2)
        self.assertEqual(json.dumps(g.to_json()).count('"kind"'), 0)

        pub = g.public_state()
        for p in pub["pieces"]:
            if p["face_up"]:
                continue
            self.assertNotIn("kind", p)
            self.assertNotIn("side", p)
            self.assertIn("origin_kind", p)
            self.assertIn("origin_side", p)

    def test_t41_can_capture_hidden_branch_reads_only_apparent_side(self):
        mover = E.Piece(1, "BLACK", "R", False, E.Square(1, 1))
        target_hit = E.Piece(2, "RED", "P", False, E.Square(1, 7))      # apparent BLACK
        target_ally = E.Piece(3, "BLACK", "P", False, E.Square(1, 4))   # apparent RED
        self.assertTrue(E.can_capture(mover, target_hit))
        self.assertFalse(E.can_capture(mover, target_ally))

    def test_t42_illegal_move_payload_does_not_leak_side(self):
        g = pos([HIDDEN("RED", "R", 1, 1), HIDDEN("BLACK", "P", 1, 4)])
        res = try_move(g, (1, 1), (1, 4))
        text = json.dumps(res)
        self.assertEqual(res["code"], "APPARENT_ALLY")
        for needle in ("RED", "BLACK", "红", "黑"):
            self.assertNotIn(needle, text)

    def test_public_pool_and_sample_world(self):
        g = E.Game(seed="world-1")
        pub = g.public_state()
        self.assertEqual(len(pub["pool"]), 30)
        world = E.sample_world(pub, E.mulberry32(12345))
        hidden_world = [p for p in world.pieces if not p.face_up]
        self.assertEqual(len(hidden_world), 30)
        self.assertEqual(
            Counter((p.side, p.kind) for p in hidden_world),
            Counter((p["side"], p["kind"]) for p in pub["pool"]),
        )
        self.assertEqual(world.turn, pub["turn"])
        self.assertEqual(world.ply, pub["ply"])

        pub2 = copy.deepcopy(pub)
        pub2["pool"] = []
        with self.assertRaises(ValueError):
            E.sample_world(pub2, E.mulberry32(1))

    def test_oracle_world_has_real_identities(self):
        g = E.Game(seed="oracle-1")
        world = g.oracle_world()
        self.assertEqual(len(world.pieces), 32)
        for p in g.pieces:
            if not E.is_alive(g.state, p):
                continue
            w = E.piece_by_id(world, p.id)
            self.assertIsNotNone(w)
            self.assertEqual((w.side, w.kind, w.face_up), (p.side, p.kind, p.face_up))

    def test_public_pool_shrinks_after_reveal(self):
        g = E.Game(seed="pool-reveal")
        view = g.ui_state()
        chosen = None
        for pid in sorted(view["moves_by_id"]):
            p_hidden = E.piece_by_id(g.state, pid)
            if p_hidden is None or p_hidden.face_up:
                continue
            for mv in view["moves_by_id"][pid]:
                if mv["capture"] is None:
                    chosen = (pid, mv)
                    break
            if chosen:
                break
        self.assertIsNotNone(chosen)
        pid, mv = chosen
        p = E.piece_by_id(g.state, pid)
        res = g.move((p.at.file, p.at.rank), (mv["to"]["file"], mv["to"]["rank"]))
        self.assertTrue(res["ok"])
        self.assertEqual(len(g.public_pool()), 29)


# ---------------------------------------------------------------------------
# Operation right + check baseline (T-48 .. T-56)
# ---------------------------------------------------------------------------

class OperationRightTests(unittest.TestCase):
    def test_t48_only_red_origin_hidden_pieces_operable(self):
        g = E.Game(seed="op-1")
        view = g.ui_state()
        hidden = [p for p in view["pieces"] if not p["face_up"]]
        operable_hidden = [p for p in hidden if g.can_operate(g.piece_at(p["file"], p["rank"]))]
        self.assertEqual(len(operable_hidden), 15)
        for p in hidden:
            self.assertEqual(g.can_operate(g.piece_at(p["file"], p["rank"])), p["rank"] <= 5)
        self.assertEqual(len(view["operable_ids"]), 16)

    def test_t49_hidden_black_on_red_origin_is_operable(self):
        g = pos([HIDDEN("BLACK", "R", 1, 1), *kings()])
        self.assertTrue(g.can_operate(g.piece_at(1, 1)))
        self.assertGreater(len(moves_of(g, 1, 1)), 0)

    def test_t50_hidden_red_on_black_origin_is_not_operable(self):
        g = pos([HIDDEN("RED", "R", 1, 10), *kings()])
        self.assertFalse(g.can_operate(g.piece_at(1, 10)))
        self.assertEqual(moves_of(g, 1, 10), [])

    def test_t51_hidden_red_on_black_origin_checks_red_general(self):
        g = pos([S("RED", "K", 1, 3), HIDDEN("RED", "R", 1, 10)])
        self.assertEqual(E.apparent_side(g.piece_at(1, 10)), "BLACK")
        self.assertTrue(g.is_in_check("RED"))

    def test_t52_flip_and_give_check_is_legal(self):
        g = pos([
            S("RED", "K", 5, 1),
            S("BLACK", "K", 5, 10),
            S("BLACK", "P", 5, 7),
            HIDDEN("BLACK", "R", 2, 3),
        ])
        res = try_move(g, (2, 3), (5, 3))
        self.assertTrue(res["ok"], "flip-and-give-check must not be rejected")
        self.assertEqual(res["event"]["revealed"], {"kind": "R", "side": "BLACK"})
        self.assertTrue(g.is_in_check("RED"))
        self.assertEqual(g.status, "PLAYING")
        self.assertEqual(g.turn, "BLACK")

    def test_t53_s1_general_never_captured(self):
        g = pos(
            [
                S("RED", "K", 5, 1),
                S("BLACK", "K", 5, 10),
                S("BLACK", "R", 5, 2),
            ],
            "BLACK",
        )
        res = try_move(g, (5, 2), (5, 1))
        self.assertFalse(res["ok"])
        self.assertEqual(res["code"], "GENERAL_SHIELD")
        self.assertNotIn("f5r1", moves_of(g, 5, 2))

    def test_t54_s2_all_legal_moves_escape_check(self):
        g = pos([
            S("RED", "K", 5, 1),
            S("BLACK", "K", 5, 10),
            S("BLACK", "R", 5, 3),
            S("BLACK", "P", 5, 7),
            S("RED", "R", 1, 2),
        ])
        self.assertTrue(g.is_in_check("RED"))
        moves = g.all_legal_moves("RED")
        self.assertGreater(len(moves), 0)
        for mv in moves:
            nxt = E.apply_move_raw(g.state, mv["from"], mv["to"], False)
            self.assertFalse(E.is_in_check(nxt, "RED"), f"legal move leaves check: {mv}")
        self.assertTrue(any(E.coord(mv["to"]) == "f5r2" for mv in moves))

    def test_t55_exhaustive_probe_set_is_identity_independent(self):
        variants = []
        for side in E.SIDES:
            for kind in ("A", "E", "H", "R", "C", "P"):
                g = pos([
                    HIDDEN(side, kind, 1, 1),
                    *kings(),
                    S("RED", "R", 5, 5),
                    HIDDEN("BLACK", "P", 1, 7),
                ])
                rejected = []
                for f in range(1, 10):
                    for r in range(1, 11):
                        if (f, r) == (1, 1):
                            continue
                        if not E.check_move(g.state, (1, 1), (f, r))["ok"]:
                            rejected.append(E.coord(E.Square(f, r)))
                variants.append(",".join(sorted(rejected)))
        self.assertEqual(len(set(variants)), 1, "probe set depends on hidden identity")

    def test_t56_audit_benchmarks(self):
        l0 = pos([HIDDEN("BLACK", "R", 1, 1), *kings()])
        self.assertTrue(l0.can_operate(l0.piece_at(1, 1)))

        l3 = pos([
            S("RED", "K", 5, 1),
            S("BLACK", "K", 5, 10),
            S("BLACK", "P", 5, 7),
            HIDDEN("BLACK", "R", 2, 3),
        ])
        self.assertTrue(try_move(l3, (2, 3), (5, 3))["ok"])

        check = pos([S("RED", "K", 1, 3), HIDDEN("RED", "R", 1, 10)])
        self.assertTrue(check.is_in_check("RED"))

    def test_strict_check_rejects_flip_and_give_check(self):
        strict = E.Game(
            position={
                "pieces": [
                    S("RED", "K", 5, 1),
                    S("BLACK", "K", 5, 10),
                    S("BLACK", "P", 5, 7),
                    HIDDEN("BLACK", "R", 2, 3),
                ],
                "turn": "RED",
                "config": {"strictCheck": True},
            }
        )
        res = strict.move((2, 3), (5, 3))
        self.assertFalse(res["ok"])
        self.assertEqual(res["code"], "SEND_CHECK")


# ---------------------------------------------------------------------------
# Attack/move-generation consistency + Game API
# ---------------------------------------------------------------------------

class ConsistencyTests(unittest.TestCase):
    def test_attacks_square_matches_pseudo_moves(self):
        checked = 0
        for game_index in range(2):
            g = E.Game(seed=f"consistency-{game_index}")
            for _ in range(8):
                st = g.state
                for p in st.pieces:
                    if not E.is_alive(st, p):
                        continue
                    pseudo = {(s.file, s.rank) for s in E.pseudo_moves(st, p)}
                    for f in range(1, 10):
                        for r in range(1, 11):
                            if (f, r) == (p.at.file, p.at.rank):
                                continue
                            if st.grid[r][f] is None:
                                continue
                            attacked = E.attacks_square(st, p, E.Square(f, r))
                            self.assertEqual(
                                attacked, (f, r) in pseudo,
                                f"mismatch {E.coord(p.at)} kind={p.kind} -> f{f}r{r}",
                            )
                            checked += 1
                view = g.ui_state()
                chosen = None
                for pid, mvs in view["moves_by_id"].items():
                    if mvs:
                        chosen = (pid, mvs[0])
                        break
                if chosen is None:
                    break
                pid, mv = chosen
                p = E.piece_by_id(st, pid)
                res = g.move(
                    (p.at.file, p.at.rank),
                    (mv["to"]["file"], mv["to"]["rank"]),
                )
                self.assertTrue(res["ok"])
        self.assertGreater(checked, 1000)


class GameApiTests(unittest.TestCase):
    def test_undo_resign_draw_and_game_over(self):
        g = E.Game(seed="api-1", config={"undo": True})
        key0 = g.get_position_key()
        res = g.move((5, 1), (4, 1))
        self.assertTrue(res["ok"])
        self.assertEqual(g.ply, 1)
        self.assertEqual(g.turn, "BLACK")
        self.assertTrue(g.undo()["ok"])
        self.assertEqual(g.get_position_key(), key0)
        self.assertEqual(g.turn, "RED")
        self.assertFalse(g.undo()["ok"])
        self.assertEqual(g.undo()["code"], "NO_HISTORY")

        no_undo = E.Game(seed="api-2")
        self.assertEqual(no_undo.undo()["code"], "UNDO_DISABLED")

        self.assertTrue(g.resign("RED")["ok"])
        self.assertEqual(g.status, "BLACK_WIN")
        self.assertEqual(g.draw_reason, "RESIGN")
        self.assertEqual(g.move((5, 1), (4, 1))["code"], "GAME_OVER")
        self.assertEqual(g.resign()["code"], "GAME_OVER")

        d = E.Game(seed="api-3")
        self.assertTrue(d.agree_draw()["ok"])
        self.assertEqual(d.status, "DRAW")
        self.assertEqual(d.draw_reason, "AGREEMENT")

    def test_final_reveal_and_export(self):
        g = E.Game(seed="api-4")
        with self.assertRaises(ValueError):
            g.final_reveal()
        g.resign("BLACK")
        reveal = g.final_reveal()
        self.assertEqual(len(reveal), 32)
        self.assertTrue(any(p["kind"] == "K" and p["side"] == "RED" for p in reveal))
        text = g.export_text()
        self.assertIn("seed: api-4", text)
        self.assertIn("结果: 红方胜 · 黑方认输", text)
        data = g.to_json()
        self.assertEqual(data["game"], "blind-xiangqi")
        self.assertEqual(data["version"], 1)
        self.assertEqual(data["status"], "RED_WIN")
        json.dumps(data)  # must be JSON-serializable

    def test_apply_move_raw_is_pure_snapshot(self):
        g = E.Game(seed="api-5")
        before = g.get_position_key()
        p = g.piece_at(5, 1)
        nxt = E.apply_move_raw(g.state, p.at, E.Square(4, 1), False)
        self.assertEqual(g.get_position_key(), before)
        self.assertNotEqual(E.position_key(nxt), before)
        self.assertEqual(E.piece_at(nxt, E.Square(4, 1)).id, p.id)

    def test_create_position_defaults_and_move_events(self):
        st = E.create_position(
            {
                "pieces": [
                    {"side": "RED", "kind": "R", "file": 1, "rank": 1},
                    {"side": "BLACK", "kind": "P", "file": 1, "rank": 4, "faceUp": False},
                ]
            }
        )
        self.assertTrue(E.piece_at(st, E.Square(1, 1)).face_up)
        self.assertFalse(E.piece_at(st, E.Square(1, 4)).face_up)
        self.assertEqual(st.turn, "RED")
        ev = E.apply_move(st, E.Square(1, 1), E.Square(1, 4))
        self.assertEqual(ev["ply"], 1)
        self.assertEqual(ev["notation"], "f1r1→f1r4")
        self.assertEqual(ev["captured"]["friendly_fire"], False)

    def test_preview_public_does_not_mutate(self):
        g = E.Game(seed="api-6")
        before = g.get_position_key()
        p = g.piece_at(5, 1)
        preview = g.preview_public(p.at, E.Square(4, 1))
        self.assertIsNotNone(preview)
        self.assertEqual(g.get_position_key(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
