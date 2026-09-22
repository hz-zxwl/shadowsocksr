import json
import tempfile
import unittest
from pathlib import Path

import app as panel


class PanelTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        panel.MUDB_PATH = Path(self.temp.name) / "mudb.json"
        panel.MUDB_PATH.write_text("[]\n", encoding="utf-8")
        panel.PASSWORD = "correct-horse-battery"
        panel.PASSWORD_HASH = None
        panel.DRY_RUN = True
        panel.app.config.update(TESTING=True, SECRET_KEY="test-secret")
        self.client = panel.app.test_client()

    def tearDown(self):
        self.temp.cleanup()

    def login(self):
        response = self.client.post("/login", data={"username": "admin", "password": panel.PASSWORD})
        self.assertEqual(response.status_code, 302)
        with self.client.session_transaction() as sess:
            return sess["csrf_token"]

    def test_login_rejects_bad_password(self):
        response = self.client.post("/login", data={"username": "admin", "password": "wrong"})
        self.assertEqual(response.status_code, 401)

    def test_status_requires_login(self):
        self.assertEqual(self.client.get("/api/status").status_code, 401)

    def test_user_crud_and_reset(self):
        token = self.login()
        headers = {"X-CSRF-Token": token}
        payload = {
            "user": "demo", "port": 32123, "passwd": "secret123",
            "method": "none", "protocol": "auth_chain_a",
            "obfs": "plain", "transfer_gb": 30, "enable": True,
        }
        response = self.client.post("/api/users", json=payload, headers=headers)
        self.assertEqual(response.status_code, 201)
        saved = json.loads(panel.MUDB_PATH.read_text(encoding="utf-8"))
        self.assertEqual(saved[0]["port"], 32123)
        self.assertEqual(saved[0]["transfer_enable"], 30 * 1024**3)

        saved[0]["u"] = 99
        saved[0]["d"] = 88
        panel.MUDB_PATH.write_text(json.dumps(saved), encoding="utf-8")
        response = self.client.post("/api/users/32123/reset-traffic", json={}, headers=headers)
        self.assertEqual(response.status_code, 200)
        saved = json.loads(panel.MUDB_PATH.read_text(encoding="utf-8"))
        self.assertEqual(saved[0]["u"] + saved[0]["d"], 0)

        response = self.client.delete("/api/users/32123", json={}, headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(panel.MUDB_PATH.read_text(encoding="utf-8")), [])

    def test_csrf_is_required(self):
        self.login()
        response = self.client.post("/api/service/restart", json={})
        self.assertEqual(response.status_code, 403)

    def test_dry_run_service_control(self):
        token = self.login()
        response = self.client.post("/api/service/restart", json={}, headers={"X-CSRF-Token": token})
        self.assertEqual(response.status_code, 200)
        self.assertIn("dry-run", response.get_json()["output"])

    def test_toggle_and_ssr_link(self):
        token = self.login()
        headers = {"X-CSRF-Token": token}
        payload = {
            "user": "自用", "port": 40002, "passwd": "zhwl40002",
            "method": "none", "protocol": "auth_chain_a", "obfs": "plain",
            "transfer_gb": 50, "enable": True,
        }
        self.client.post("/api/users", json=payload, headers=headers)
        response = self.client.get("/api/users", headers={"Host": "ssr380.zxwl.xyz:65432"})
        link = response.get_json()["users"][0]["ssr_link"]
        self.assertTrue(link.startswith("ssr://"))
        response = self.client.post("/api/users/40002/toggle", json={"enable": False}, headers=headers)
        self.assertEqual(response.get_json()["enable"], 0)


if __name__ == "__main__":
    unittest.main()
