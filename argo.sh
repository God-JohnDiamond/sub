#!/bin/bash
# Cloudflare Argo Tunnel 一键部署脚本 (增强版 2.0)
# 项目网址: https://github.com/sammy0101/cf-sub-converter

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

NODE_TYPE="{{NODE_TYPE}}"
VLESS_UUID="{{VLESS_UUID}}"
VLESS_PATH="{{VLESS_PATH}}"
VLESS_TYPE="{{VLESS_TYPE}}"
VLESS_PORT="{{VLESS_PORT}}"
NODE_NAME="{{NODE_NAME}}"
TUNNEL_TOKEN="{{TUNNEL_TOKEN}}"
CUSTOM_DOMAIN="{{CUSTOM_DOMAIN}}"
VLESS_TLS="{{VLESS_TLS}}"
ORIGIN_HOST="{{ORIGIN_HOST}}"

echo -e "${GREEN}=== 开始部署 Cloudflare Argo 隧道 (${NODE_NAME}) ===${NC}"

if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}错误: 请使用 root 权限执行此脚本！${NC}"
  exit 1
fi

# 1. 安装 cloudflared
if ! command -v cloudflared &> /dev/null; then
    echo "正在下载安装 cloudflared..."
    curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
    chmod +x /usr/local/bin/cloudflared
else
    echo "cloudflared 已存在，跳过安装。"
fi

SAFE_NODE_NAME=$(echo "$NODE_NAME" | sed 's/[^a-zA-Z0-9]/_/g')

# 2. 自动探测与修正端口
DETECTED_PORT="$VLESS_PORT"
if command -v ss &> /dev/null; then
    if ! ss -tln | grep -qE ":$VLESS_PORT([[:space:]]|$)"; then
        echo -e "${RED}警告: 本地转发端口 $VLESS_PORT 未监听，正在探测...${NC}"
        if ss -tln | grep -qE ":443([[:space:]]|$)"; then
            echo -e "${GREEN}自动修正：转发目标为 443 端口。${NC}"
            DETECTED_PORT="443"
        elif ss -tln | grep -qE ":80([[:space:]]|$)"; then
            echo -e "${GREEN}自动修正：转发目标为 80 端口。${NC}"
            DETECTED_PORT="80"
        fi
    fi
fi

# 3. 智能探测 TLS
DETECTED_TLS="false"
if curl -s -k --connect-timeout 2 "https://127.0.0.1:$DETECTED_PORT" &>/dev/null; then
    echo "检测到本地为 HTTPS 加密端口，开启 TLS 转发与 SNI 对齐。"
    DETECTED_TLS="true"
fi

LOCAL_URL="http://127.0.0.1:$DETECTED_PORT"
EXTRA_ARGS=""
if [ "$DETECTED_TLS" = "true" ]; then
    LOCAL_URL="https://127.0.0.1:$DETECTED_PORT"
    EXTRA_ARGS="--no-tls-verify"
fi

if [ -n "$ORIGIN_HOST" ]; then
    EXTRA_ARGS="$EXTRA_ARGS --http-host-header $ORIGIN_HOST"
    if [ "$DETECTED_TLS" = "true" ]; then
        EXTRA_ARGS="$EXTRA_ARGS --origin-server-name $ORIGIN_HOST"
    fi
fi

# 4. 启动隧道
if [ -n "$TUNNEL_TOKEN" ]; then
    echo -e "${GREEN}【固定隧道模式】正在启动服务...${NC}"
    cloudflared service uninstall &> /dev/null
    cloudflared service install "$TUNNEL_TOKEN"
    systemctl daemon-reload
    systemctl enable cloudflared
    systemctl restart cloudflared
    echo -e "${GREEN}固定域名隧道部署完成！${NC}"
else
    echo -e "${GREEN}【临时隧道模式】正在启动 Quick Tunnel...${NC}"
    systemctl stop cloudflared-argo-${SAFE_NODE_NAME} &> /dev/null
    
    cat <<EOF > /etc/systemd/system/cloudflared-argo-${SAFE_NODE_NAME}.service
[Unit]
Description=Cloudflare Argo Tunnel for ${NODE_NAME}
After=network.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/cloudflared tunnel --url $LOCAL_URL $EXTRA_ARGS
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable cloudflared-argo-${SAFE_NODE_NAME}
    systemctl start cloudflared-argo-${SAFE_NODE_NAME}
    
    echo "正在等待 Cloudflare 分配临时域名..."
    TEMP_DOMAIN=""
    for i in {1..15}; do
        sleep 1
        TEMP_DOMAIN=$(journalctl -u cloudflared-argo-${SAFE_NODE_NAME} -n 50 --no-pager 2>/dev/null | grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' | tail -n 1 | cut -d'/' -f3)
        if [ -n "$TEMP_DOMAIN" ]; then
            break
        fi
    done
    
    if [ -n "$TEMP_DOMAIN" ]; then
        echo -e "${GREEN}获取临时域名成功: $TEMP_DOMAIN${NC}"
    else
        echo -e "${RED}超时未获取到域名，请手动检查 journalctl -u cloudflared-argo-${SAFE_NODE_NAME}${NC}"
    fi
fi
