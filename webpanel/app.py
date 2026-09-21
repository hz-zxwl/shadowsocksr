#!/usr/bin/env python3
"""Small, self-contained web control panel for ShadowsocksR manyuser."""

import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
from functools import wraps
from pathlib import Path

from flask import Flask, abort, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash


BASE_DIR = Path(__file__).resolve().parent
MUDB_PATH = Path(os.environ.get("SSR_MUDB_PATH", str(BASE_DIR.parent / "mudb.json"))).resolve()
SERVICE_NAME = os.environ.get("SSR_SERVICE_NAME", "shadowsocksr")
CONTROL_SCRIPT = os.environ.get("SSR_CONTROL_SCRIPT", "").strip()
LOG_PATH = os.environ.get("SSR_LOG_PATH", "").strip()
LOG_LINES = max(20, min(int(os.environ.get("SSR_LOG_LINES", "200")), 1000))
USERNAME = os.environ.get("SSR_PANEL_USERNAME", "admin")
PASSWORD = os.environ.get("SSR_PANEL_PASSWORD")
PASSWORD_HASH = os.environ.get("SSR_PANEL_PASSWORD_HASH")
SECRET = os.environ.get("SSR_PANEL_SECRET")
DRY_RUN = os.environ.get("SSR_PANEL_DRY_RUN", "0") == "1"

if not re.fullmatch(r"[A-Za-z0-9_.@-]{1,128}", SERVICE_NAME):
    raise RuntimeError("SSR_SERVICE_NAME contains unsupported characters")
if CONTROL_SCRIPT and not re.fullmatch(r"/etc/(?:rc\.d/)?init\.d/[A-Za-z0-9_.@-]+", CONTROL_SCRIPT):
    raise RuntimeError("SSR_CONTROL_SCRIPT must point to a script under /etc/init.d")

app = Flask(__name__)
app.secret_key = SECRET or secrets.token_hex(32)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Strict",
    SESSION_COOKIE_SECURE=os.environ.get("SSR_PANEL_HTTPS", "0") == "1",
    MAX_CONTENT_LENGTH=64 * 1024,
)

_mudb_lock = threading.RLock()
_boot_time = time.time()

METHODS = ["none"]
PROTOCOLS = ["auth_chain_a"]
OBFS = ["plain"]
ALLOWED_METHODS = METHODS + ["aes-128-ctr", "aes-192-ctr", "aes-256-ctr", "aes-128-cfb", "aes-256-cfb", "chacha20", "chacha20-ietf"]
ALLOWED_PROTOCOLS = PROTOCOLS + ["origin", "auth_sha1_v4", "auth_aes128_md5", "auth_aes128_sha1", "auth_chain_b"]
ALLOWED_OBFS = OBFS + ["http_simple", "http_simple_compatible", "tls1.2_ticket_auth", "tls1.2_ticket_auth_compatible"]


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("authenticated"):
            if request.path.startswith("/api/"):
                return jsonify(error="unauthorized"), 401
            return redirect(url_for("login"))
        return fn(*args, **kwargs)

    return wrapper


def require_csrf():
    supplied = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token")
    if not supplied or not secrets.compare_digest(str(supplied), str(session.get("csrf_token", ""))):
        abort(403, "CSRF validation failed")


def password_valid(candidate):
    if PASSWORD_HASH:
        return check_password_hash(PASSWORD_HASH, candidate)
    return bool(PASSWORD) and secrets.compare_digest(PASSWORD, candidate)


def load_users():
    with _mudb_lock:
        if not MUDB_PATH.exists():
            return []
        with MUDB_PATH.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        if not isinstance(data, list):
            raise ValueError("mudb.json must contain a JSON array")
        return data


def save_users(users):
    with _mudb_lock:
        MUDB_PATH.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix="mudb-", suffix=".json", dir=str(MUDB_PATH.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(users, handle, ensure_ascii=False, sort_keys=True, indent=4)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            if MUDB_PATH.exists():
                shutil.copymode(MUDB_PATH, temp_name)
            os.replace(temp_name, MUDB_PATH)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)


def int_value(data, key, minimum, maximum, default=0):
    try:
        value = int(data.get(key, default))
    except (TypeError, ValueError):
        raise ValueError(f"{key} must be a number")
    if not minimum <= value <= maximum:
        raise ValueError(f"{key} must be between {minimum} and {maximum}")
    return value


def clean_text(data, key, max_len, default=""):
    value = str(data.get(key, default)).strip()
    if len(value) > max_len or any(ord(char) < 32 for char in value):
        raise ValueError(f"invalid {key}")
    return value


def normalize_user(data, existing=None):
    current = dict(existing or {})
    port = int_value(data, "port", 1, 65535, current.get("port", 0))
    transfer_gb = int_value(data, "transfer_gb", 0, 1024 * 1024, int(current.get("transfer_enable", 50 * 1024**3) / 1024**3))
    method = clean_text(data, "method", 64, current.get("method", "none"))
    protocol = clean_text(data, "protocol", 64, current.get("protocol", "auth_chain_a"))
    obfs = clean_text(data, "obfs", 64, current.get("obfs", "plain"))
    if method not in ALLOWED_METHODS or protocol not in ALLOWED_PROTOCOLS or obfs not in ALLOWED_OBFS:
        raise ValueError("unsupported method, protocol, or obfs")
    current.update(
        user=clean_text(data, "user", 80, current.get("user", f"user-{port}")) or f"user-{port}",
        port=port,
        passwd=clean_text(data, "passwd", 128, current.get("passwd", "")) or secrets.token_urlsafe(9),
        method=method,
        protocol=protocol,
        protocol_param=clean_text(data, "protocol_param", 256, current.get("protocol_param", "")),
        obfs=obfs,
        obfs_param=clean_text(data, "obfs_param", 256, current.get("obfs_param", "")),
        transfer_enable=transfer_gb * 1024**3,
        enable=1 if data.get("enable", current.get("enable", 1)) in (True, 1, "1", "true", "on") else 0,
        u=int(current.get("u", 0)),
        d=int(current.get("d", 0)),
    )
    return current


def service_command(action):
    if action not in {"start", "stop", "restart"}:
        raise ValueError("unsupported service action")
    if DRY_RUN:
        return True, "dry-run: service action %s" % action
    command = [CONTROL_SCRIPT, action] if CONTROL_SCRIPT else ["systemctl", action, SERVICE_NAME]
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               universal_newlines=True, timeout=20, check=False)
    output = (completed.stdout or completed.stderr or "").strip()
    return completed.returncode == 0, output


def service_status():
    if DRY_RUN:
        return {"active": True, "status": "running", "detail": "dry-run"}
    try:
        if CONTROL_SCRIPT:
            completed = subprocess.run([CONTROL_SCRIPT, "status"], stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, universal_newlines=True,
                                       timeout=5, check=False)
            detail = (completed.stdout or completed.stderr).strip()
            return {"active": completed.returncode == 0, "status": "running" if completed.returncode == 0 else "stopped", "detail": detail}
        completed = subprocess.run(["systemctl", "is-active", SERVICE_NAME], stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, universal_newlines=True,
                                   timeout=5, check=False)
        status = completed.stdout.strip() or "unknown"
        return {"active": completed.returncode == 0, "status": status}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"active": False, "status": "unavailable", "detail": str(exc)}


def proc_metrics():
    load = os.getloadavg() if hasattr(os, "getloadavg") else (0, 0, 0)
    memory_total = memory_available = 0
    try:
        values = {}
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            key, value = line.split(":", 1)
            values[key] = int(value.strip().split()[0]) * 1024
        memory_total = values.get("MemTotal", 0)
        memory_available = values.get("MemAvailable", 0)
    except (OSError, ValueError):
        pass
    disk = shutil.disk_usage("/")
    return {
        "load": [round(item, 2) for item in load],
        "memory_total": memory_total,
        "memory_used": max(0, memory_total - memory_available),
        "disk_total": disk.total,
        "disk_used": disk.used,
        "uptime": int(time.time() - _boot_time),
    }


def public_user(user):
    result = dict(user)
    result["used"] = int(user.get("u", 0)) + int(user.get("d", 0))
    result["transfer_gb"] = round(int(user.get("transfer_enable", 0)) / 1024**3, 3)
    return result


@app.get("/login")
def login():
    if session.get("authenticated"):
        return redirect(url_for("index"))
    return render_template("login.html", configured=bool(PASSWORD or PASSWORD_HASH), error=None)


@app.post("/login")
def login_post():
    if not (PASSWORD or PASSWORD_HASH):
        return render_template("login.html", configured=False, error="管理员密码尚未配置"), 503
    username = request.form.get("username", "")
    password = request.form.get("password", "")
    if not secrets.compare_digest(username, USERNAME) or not password_valid(password):
        time.sleep(0.4)
        return render_template("login.html", configured=True, error="用户名或密码错误"), 401
    session.clear()
    session["authenticated"] = True
    session["csrf_token"] = secrets.token_urlsafe(32)
    return redirect(url_for("index"))


@app.post("/logout")
@login_required
def logout():
    require_csrf()
    session.clear()
    return redirect(url_for("login"))


@app.get("/")
@login_required
def index():
    return render_template("index.html", csrf_token=session["csrf_token"], methods=METHODS, protocols=PROTOCOLS, obfs_list=OBFS)


@app.get("/api/status")
@login_required
def api_status():
    users = load_users()
    uploaded = sum(int(item.get("u", 0)) for item in users)
    downloaded = sum(int(item.get("d", 0)) for item in users)
    return jsonify(service=service_status(), metrics=proc_metrics(), totals={"users": len(users), "upload": uploaded, "download": downloaded})


@app.post("/api/service/<action>")
@login_required
def api_service(action):
    require_csrf()
    try:
        ok, output = service_command(action)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    return jsonify(ok=ok, output=output), (200 if ok else 500)


@app.get("/api/users")
@login_required
def api_users():
    return jsonify(users=[public_user(item) for item in load_users()])


@app.post("/api/users")
@login_required
def api_users_create():
    require_csrf()
    try:
        payload = request.get_json(force=True)
        user = normalize_user(payload)
        users = load_users()
        if any(int(item.get("port", 0)) == user["port"] for item in users):
            return jsonify(error="端口已经存在"), 409
        users.append(user)
        save_users(users)
        return jsonify(user=public_user(user)), 201
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        return jsonify(error=str(exc)), 400


@app.put("/api/users/<int:port>")
@login_required
def api_users_update(port):
    require_csrf()
    try:
        payload = request.get_json(force=True)
        users = load_users()
        index = next((i for i, item in enumerate(users) if int(item.get("port", 0)) == port), None)
        if index is None:
            return jsonify(error="用户不存在"), 404
        updated = normalize_user(payload, users[index])
        if updated["port"] != port and any(int(item.get("port", 0)) == updated["port"] for item in users):
            return jsonify(error="端口已经存在"), 409
        users[index] = updated
        save_users(users)
        return jsonify(user=public_user(updated))
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        return jsonify(error=str(exc)), 400


@app.delete("/api/users/<int:port>")
@login_required
def api_users_delete(port):
    require_csrf()
    users = load_users()
    kept = [item for item in users if int(item.get("port", 0)) != port]
    if len(kept) == len(users):
        return jsonify(error="用户不存在"), 404
    save_users(kept)
    return jsonify(ok=True)


@app.post("/api/users/<int:port>/reset-traffic")
@login_required
def api_users_reset(port):
    require_csrf()
    users = load_users()
    for item in users:
        if int(item.get("port", 0)) == port:
            item["u"] = 0
            item["d"] = 0
            save_users(users)
            return jsonify(ok=True)
    return jsonify(error="用户不存在"), 404


@app.get("/api/logs")
@login_required
def api_logs():
    if DRY_RUN:
        return jsonify(logs="测试模式：暂无服务日志。")
    try:
        if LOG_PATH:
            path = Path(LOG_PATH).resolve()
            if not path.is_file():
                return jsonify(logs="日志文件尚未生成：%s" % path)
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[-LOG_LINES:]
            return jsonify(logs="\n".join(lines)[-100_000:])
        completed = subprocess.run(["journalctl", "-u", SERVICE_NAME, "-n", str(LOG_LINES), "--no-pager"],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   universal_newlines=True, timeout=10, check=False)
        return jsonify(logs=(completed.stdout or completed.stderr)[-100_000:])
    except (OSError, subprocess.TimeoutExpired) as exc:
        return jsonify(error=str(exc)), 500


@app.get("/healthz")
def healthz():
    return jsonify(ok=True)


if __name__ == "__main__":
    app.run(host=os.environ.get("SSR_PANEL_BIND", "127.0.0.1"),
            port=int(os.environ.get("SSR_PANEL_PORT", "6677")))
