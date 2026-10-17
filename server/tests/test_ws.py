"""WebSocket room smoke tests (M2a)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.app import app  # noqa: E402


class WebsocketTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)

    def test_create_join_move_and_resync(self) -> None:
        with self.client.websocket_connect("/ws") as red:
            red.send_json({"t": "create", "seed": "ws-1"})
            sync = red.receive_json()
            self.assertEqual(sync["t"], "sync")
            self.assertEqual(sync["you"], "RED")
            room = sync["room"]
            self.assertEqual(len(sync["public"]["pieces"]), 32)
            move = sync["public"]["legal_moves"][0]

            with self.client.websocket_connect("/ws") as black:
                black.send_json({"t": "join", "room": room})
                joined = red.receive_json()
                self.assertEqual(joined["t"], "opp.joined")
                # both receive their own sync
                red_sync = red.receive_json()
                black_sync = black.receive_json()
                self.assertEqual(red_sync["t"], "sync")
                self.assertEqual(black_sync["t"], "sync")
                self.assertEqual(black_sync["you"], "BLACK")

                red.send_json({"t": "move", "seq": 1, "from": move["from"], "to": move["to"]})
                red_ok = red.receive_json()
                black_ok = black.receive_json()
                self.assertEqual(red_ok["t"], "moveOk")
                self.assertEqual(black_ok["t"], "moveOk")
                self.assertEqual(red_ok["public"]["ply"], 1)
                self.assertEqual(red_ok["public"]["turn"], "BLACK")

                # duplicate seq is idempotent
                red.send_json({"t": "move", "seq": 1, "from": move["from"], "to": move["to"]})
                stale = red.receive_json()
                self.assertEqual(stale["t"], "moveErr")
                self.assertEqual(stale["code"], "STALE")

                black.send_json({"t": "resync", "lastPly": 0})
                sync2 = black.receive_json()
                self.assertEqual(sync2["t"], "sync")
                self.assertEqual(sync2["public"]["ply"], 1)

    def test_wrong_turn_and_unknown_room(self) -> None:
        with self.client.websocket_connect("/ws") as ws:
            ws.send_json({"t": "join", "room": "ZZZZZZ"})
            err = ws.receive_json()
            self.assertEqual(err["code"], "ROOM_NOT_FOUND")

            ws.send_json({"t": "create", "seed": "ws-2"})
            sync = ws.receive_json()
            room = sync["room"]
            mv = sync["public"]["legal_moves"][0]
            # RED can move; BLACK is not connected, but a second connection can join.
            with self.client.websocket_connect("/ws") as black:
                black.send_json({"t": "join", "room": room})
                self.assertEqual(ws.receive_json()["t"], "opp.joined")  # red
                self.assertEqual(ws.receive_json()["t"], "sync")       # red sync
                black_sync = black.receive_json()
                self.assertEqual(black_sync["t"], "sync")
                # black tries to move before red
                black.send_json({"t": "move", "seq": 1, "from": mv["from"], "to": mv["to"]})
                err = black.receive_json()
                self.assertEqual(err["t"], "moveErr")
                self.assertEqual(err["code"], "NOT_YOUR_TURN")


if __name__ == "__main__":
    unittest.main()
