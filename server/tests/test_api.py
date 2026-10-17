"""HTTP API smoke tests (M0 route A slice)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.app import app  # noqa: E402


class ApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)

    def test_health(self) -> None:
        r = self.client.get("/api/health")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["ok"])

    def test_create_public_hides_identity_and_exposes_legal(self) -> None:
        r = self.client.post("/api/games", json={"seed": "api-1"})
        self.assertEqual(r.status_code, 200)
        data = r.json()
        pub = data["public"]
        self.assertEqual(len(pub["pieces"]), 32)
        self.assertEqual(pub["hidden_count"], 30)
        self.assertGreater(len(pub["legal_moves"]), 0)
        for p in pub["pieces"]:
            if not p["face_up"]:
                self.assertNotIn("kind", p)
                self.assertNotIn("side", p)
                self.assertIn("origin_kind", p)
                self.assertIn("origin_side", p)

    def test_move_and_public_event_and_stale(self) -> None:
        created = self.client.post("/api/games", json={"seed": "api-2"}).json()
        game_id = created["game_id"]
        move = created["public"]["legal_moves"][0]
        r = self.client.post(
            f"/api/games/{game_id}/move",
            json={"from": move["from"], "to": move["to"], "seq": 1},
        )
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertTrue(data["ok"])
        self.assertEqual(data["public"]["ply"], 1)
        self.assertIn("event", data)
        self.assertNotIn("kind", data["event"].get("captured") or {})

        # duplicate seq is idempotent
        r2 = self.client.post(
            f"/api/games/{game_id}/move",
            json={"from": move["from"], "to": move["to"], "seq": 1},
        )
        self.assertEqual(r2.json()["code"], "STALE")
        self.assertEqual(r2.json()["public"]["ply"], 1)

    def test_illegal_does_not_expose_reason(self) -> None:
        created = self.client.post("/api/games", json={"seed": "api-3"}).json()
        game_id = created["game_id"]
        r = self.client.post(
            f"/api/games/{game_id}/move",
            json={"from": {"file": 1, "rank": 1}, "to": {"file": 1, "rank": 10}, "seq": 1},
        )
        self.assertEqual(r.json()["code"], "ILLEGAL")
        self.assertEqual(r.json()["public"]["ply"], 0)

    def test_get_and_resign(self) -> None:
        created = self.client.post("/api/games", json={"seed": "api-4"}).json()
        game_id = created["game_id"]
        pub = self.client.get(f"/api/games/{game_id}").json()["public"]
        self.assertEqual(pub["turn"], "RED")
        r = self.client.post(f"/api/games/{game_id}/resign", json={"side": "RED"})
        self.assertTrue(r.json()["ok"])
        self.assertEqual(r.json()["public"]["status"], "BLACK_WIN")

    def test_root_is_pve_and_pvp_page_is_separate(self) -> None:
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        # 首页就是本地 PvE 页面，直接加载 engine/AI。
        self.assertIn("src/engine.js", page.text)
        self.assertIn("src/ai.js", page.text)
        self.assertIn('id="startBtn"', page.text)
        self.assertEqual(self.client.get("/src/engine.js").status_code, 200)
        self.assertEqual(self.client.get("/src/ai.js").status_code, 200)

        pvp = self.client.get("/pvp/")
        self.assertEqual(pvp.status_code, 200)
        self.assertIn('id="onlineBtn"', pvp.text)
        self.assertIn('id="pveBtn"', pvp.text)
        # PvP 页面自身不加载 engine/AI（虽然 PvE 首页需要 /src）。
        self.assertNotIn("/src/engine.js", pvp.text)
        self.assertNotIn("/src/ai.js", pvp.text)
        self.assertEqual(self.client.get("/pvp/").status_code, 200)
        self.assertEqual(self.client.get("/app.js").status_code, 200)
        self.assertEqual(self.client.get("/client.css").status_code, 200)

        local = self.client.get("/local/", follow_redirects=False)
        self.assertIn(local.status_code, (307, 308))
        self.assertEqual(local.headers.get("location"), "/")
        local_auto = self.client.get("/local/?autostart=1", follow_redirects=False)
        self.assertEqual(local_auto.headers.get("location"), "/?autostart=1")
        self.assertEqual(self.client.get("/local/src/engine.js").status_code, 200)
        self.assertEqual(self.client.get("/local/src/ai.js").status_code, 200)


if __name__ == "__main__":
    unittest.main()
