#!/usr/bin/env python3
"""RecallFlow 模拟登录后端：用于演示「密码错误」场景。

零第三方依赖，基于标准库 http.server。

使用：
    python mock_server.py
    打开 http://127.0.0.1:8000/

预设账号：demo / 123456
密码错误时返回 401，并跳转到 error.html?code=401 展示报错页。
"""

import json
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 8000

USER = {"username": "demo", "password": "123456"}

PAGE_LOGIN = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<title>登录 · RecallFlow</title>
<style>
  :root {
    --primary: #4a90d9; --primary-hover: #3a7cc4; --primary-soft: #4a90d91a;
    --bg: #f0f2f5; --card: #fff; --text: #333; --text-sub: #5f6b7a;
    --border: #e2e5ea; --focus-ring: rgba(74,144,217,0.4);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --primary: #5b9be0; --primary-hover: #6ea9e5; --primary-soft: #5b9be033;
      --bg: #1b1d21; --card: #26292e; --text: #e3e5e8; --text-sub: #9aa0a8;
      --border: #3a3f46; --focus-ring: rgba(91,155,224,0.55);
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    display: grid; place-items: center; padding: 24px;
    background: var(--bg); color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .card {
    width: min(360px, 100%); background: var(--card);
    border: 1px solid var(--border); border-radius: 14px;
    padding: 32px 28px; box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }
  h1 { font-size: 18px; text-align: center; margin-bottom: 4px; }
  .caption { text-align: center; color: var(--text-sub); font-size: 12px; margin-bottom: 22px; }
  label { display: block; font-size: 12px; color: var(--text-sub); margin: 12px 0 6px; }
  input {
    width: 100%; padding: 10px 12px; font: inherit; color: var(--text);
    background: var(--card); border: 1px solid var(--border); border-radius: 8px;
  }
  input:focus { outline: 3px solid var(--focus-ring); outline-offset: 1px; border-color: var(--primary); }
  button {
    width: 100%; margin-top: 20px; padding: 11px 0; font: inherit; font-weight: 600;
    border: none; border-radius: 9px; cursor: pointer;
    background: var(--primary); color: #fff; transition: background 0.15s;
  }
  button:hover { background: var(--primary-hover); }
  .err { min-height: 18px; margin-top: 10px; font-size: 12px; color: #e74c3c; text-align: center; }
  .hint { margin-top: 18px; font-size: 11px; color: var(--text-sub); text-align: center; line-height: 1.6; }
</style>
</head>
<body>
  <form class="card" method="post" action="/api/login">
    <h1>RecallFlow</h1>
    <p class="caption">模拟登录 · 密码错误演示</p>
    <label for="username">用户名</label>
    <input id="username" name="username" type="text" autocomplete="username" required>
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <div class="err" id="err" role="alert"></div>
    <button type="submit">登 录</button>
    <p class="hint">演示账号：demo / 123456<br>输入错误密码即可查看「访问报错」页</p>
  </form>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "RecallFlowMock/1.0"

    def _send(self, status, body, content_type="text/html; charset=utf-8", headers=None):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        if headers:
            for k, v in headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _redirect(self, location, status=302):
        self.send_response(status)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            self._send(200, PAGE_LOGIN)
            return
        if parsed.path == "/api/login":
            self._redirect("/")
            return
        if parsed.path == "/error.html":
            self._serve_static("error.html")
            return
        self._send(404, "Not Found", "text/plain; charset=utf-8")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/login":
            self._send(404, json.dumps({"code": 404, "message": "Not Found"}), "application/json")
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8")
        form = urllib.parse.parse_qs(raw)
        username = (form.get("username") or [""])[0]
        password = (form.get("password") or [""])[0]

        if username == USER["username"] and password == USER["password"]:
            self._send(200, json.dumps({"success": True, "code": 200}, ensure_ascii=False), "application/json")
            return

        # 密码错误：返回 401，并携带可直接跳转的报错页链接
        location = "/error.html?code=401&msg=" + urllib.parse.quote("用户名或密码错误，请重试")
        self._send(
            401,
            json.dumps({"success": False, "code": 401, "message": "用户名或密码错误", "error_url": location},
                       ensure_ascii=False),
            "application/json",
        )

    def _serve_static(self, name):
        try:
            with open(name, "rb") as f:
                self._send(200, f.read())
        except FileNotFoundError:
            self._send(404, "Not Found", "text/plain; charset=utf-8")


def main():
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as e:
        print(f"启动失败（端口 {PORT} 可能被占用）：{e}")
        sys.exit(1)
    print(f"RecallFlow 模拟后端运行于 http://{HOST}:{PORT}/")
    print("演示账号：demo / 123456")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        server.shutdown()


if __name__ == "__main__":
    main()
