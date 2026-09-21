#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 root 运行：sudo bash webpanel/install.sh"
  exit 1
fi

PANEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSR_DIR="$(cd "${PANEL_DIR}/.." && pwd)"
VENV_DIR="${PANEL_DIR}/.venv"
ENV_FILE="/etc/ssr-panel.env"
SERVICE_FILE="/etc/systemd/system/ssr-web-panel.service"

command -v python3 >/dev/null 2>&1 || { echo "缺少 python3，请先安装。"; exit 1; }

read -r -p "面板用户名 [admin]: " PANEL_USER
PANEL_USER="${PANEL_USER:-admin}"
read -r -s -p "面板密码（至少 10 位）: " PANEL_PASSWORD
echo
if [[ ${#PANEL_PASSWORD} -lt 10 ]]; then
  echo "密码长度不能少于 10 位。"
  exit 1
fi
read -r -p "SSR systemd 服务名 [shadowsocksr]: " SSR_SERVICE
SSR_SERVICE="${SSR_SERVICE:-shadowsocksr}"
if [[ ! "${PANEL_USER}" =~ ^[A-Za-z0-9_.@-]{1,128}$ ]] || [[ ! "${SSR_SERVICE}" =~ ^[A-Za-z0-9_.@-]{1,128}$ ]]; then
  echo "用户名或服务名包含不支持的字符。"
  exit 1
fi

python3 -m venv "${VENV_DIR}"
"${VENV_DIR}/bin/pip" install --disable-pip-version-check -r "${PANEL_DIR}/requirements.txt"

PANEL_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
PANEL_PASSWORD_HASH="$(PANEL_PASSWORD_INPUT="${PANEL_PASSWORD}" "${VENV_DIR}/bin/python" -c 'import os; from werkzeug.security import generate_password_hash; print(generate_password_hash(os.environ["PANEL_PASSWORD_INPUT"]))')"
unset PANEL_PASSWORD
umask 077
printf '%s\n' \
  "SSR_PANEL_SECRET=${PANEL_SECRET}" \
  "SSR_PANEL_USERNAME=${PANEL_USER}" \
  "SSR_PANEL_PASSWORD_HASH=${PANEL_PASSWORD_HASH}" \
  "SSR_MUDB_PATH=${SSR_DIR}/mudb.json" \
  "SSR_SERVICE_NAME=${SSR_SERVICE}" \
  > "${ENV_FILE}"

sed \
  -e "s|@@PANEL_DIR@@|${PANEL_DIR}|g" \
  -e "s|@@VENV_DIR@@|${VENV_DIR}|g" \
  "${PANEL_DIR}/deploy/ssr-web-panel.service" > "${SERVICE_FILE}"

systemctl daemon-reload
systemctl enable --now ssr-web-panel

echo
echo "SSR Panel 已启动：127.0.0.1:6677"
echo "请通过 Nginx + HTTPS 反向代理访问，不要把 6677 端口直接暴露到公网。"
echo "环境配置：${ENV_FILE}"
