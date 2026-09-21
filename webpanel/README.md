# SSR Web Panel

这是一个为本仓库 `manyuser` 模式设计的轻量网页管理面板。它直接读写现有的 `mudb.json`，不迁移用户数据，也不修改 ShadowsocksR 的代理核心。

## 第一版功能

- 管理员登录与 CSRF 防护
- 查看系统负载、内存、硬盘和流量汇总
- 查看 SSR 服务运行状态
- 启动、停止、重启 SSR 服务
- 新增、编辑、删除和停用用户
- 查看与清零用户流量
- 查看 systemd 运行日志
- 移动端自适应后台界面

## 安装

面板需要 Python 3，SSR 核心可以继续使用原来的 Python 环境。

```bash
cd /opt/shadowsocksr
sudo bash webpanel/install.sh
```

安装程序会询问面板账号、密码和 SSR 服务名。你当前的 CentOS 7 服务器会使用
`/etc/init.d/ssrmu` 控制服务、读取 `/usr/local/shadowsocksr/ssserver.log`，并监听测试端口 `0.0.0.0:65432`。

请参考 `deploy/nginx.conf.example` 配置带 HTTPS 的 Nginx 反向代理。不要把 6677 端口直接开放到公网。

## 手动测试运行

```bash
cd webpanel
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
export SSR_PANEL_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
export SSR_PANEL_USERNAME=admin
export SSR_PANEL_PASSWORD='change-this-password'
export SSR_MUDB_PATH="$(cd .. && pwd)/mudb.json"
export SSR_PANEL_DRY_RUN=1
.venv/bin/python app.py
```

浏览器打开 `http://127.0.0.1:6677`。`SSR_PANEL_DRY_RUN=1` 时不会真正调用 systemctl。

## 配置

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `SSR_PANEL_SECRET` | Flask 会话密钥，生产环境必须固定设置 | 每次启动随机生成 |
| `SSR_PANEL_USERNAME` | 管理员用户名 | `admin` |
| `SSR_PANEL_PASSWORD` | 管理员密码 | 无，未配置时禁止登录 |
| `SSR_PANEL_PASSWORD_HASH` | Werkzeug 密码哈希，可替代明文密码 | 无 |
| `SSR_MUDB_PATH` | SSR 用户数据库路径 | 仓库根目录的 `mudb.json` |
| `SSR_SERVICE_NAME` | SSR 服务名 | `shadowsocksr` |
| `SSR_CONTROL_SCRIPT` | SysV 服务控制脚本；设置后优先于 systemd | 无 |
| `SSR_LOG_PATH` | SSR 文本日志路径；设置后优先于 journalctl | 无 |
| `SSR_PANEL_BIND` | 面板监听地址 | `127.0.0.1` |
| `SSR_PANEL_PORT` | 面板监听端口 | `6677` |
| `SSR_PANEL_HTTPS` | HTTPS 反代时设为 `1`，启用 Secure Cookie | `0` |
| `SSR_PANEL_DRY_RUN` | 设为 `1` 时不执行服务控制命令 | `0` |

## 安全说明

- 面板只允许预定义的 `systemctl start/stop/restart`，不接受任意 Shell 命令。
- `mudb.json` 使用同目录临时文件原子替换，避免写入中断造成数据损坏。
- 生产环境建议限制面板域名的访问 IP，并启用 HTTPS。
- `/etc/ssr-panel.env` 权限由安装脚本设为仅 root 可读，密码只保存单向哈希。

## 测试

```bash
cd webpanel
PYTHONPATH=. .venv/bin/python -m unittest discover -s tests -v
```
