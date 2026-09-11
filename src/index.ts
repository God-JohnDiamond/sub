// src/index.ts
// @ts-ignore
import packageJson from '../package.json';
import { Env, ProxyNode } from './types';
import { HTML_PAGE } from './constants';
import { parseContent } from './parser';
import {
  toSingBoxWithTemplate,
  toClashWithTemplate,
  toBase64,
  toSurge,
  toQuantumultX,
  toLoon
} from './generator';
import { deduplicateNodeNames, groupNodesByFlag } from './utils';

const version = packageJson.version || '3.5.0';

// ================= 新增：全局登录限制和 UI =================
const ipLoginAttempts = new Map<string, { count: number, lockUntil: number }>();

// 1:1 还原你提供的深色 UI 截图的登录页
const LOGIN_HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>面板已锁定</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: #171b26; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; color: #ffffff; }
    .container { background: #1c2231; padding: 40px 32px; border-radius: 12px; border: 1px solid #2a3143; box-shadow: 0 12px 32px rgba(0,0,0,0.4); width: 100%; max-width: 380px; text-align: center; box-sizing: border-box; }
    .icon-circle { width: 56px; height: 56px; background: rgba(59, 130, 246, 0.05); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 50%; display: flex; justify-content: center; align-items: center; margin: 0 auto 20px; box-shadow: 0 0 24px rgba(59, 130, 246, 0.15); }
    .icon-circle svg { width: 24px; height: 24px; stroke: #3b82f6; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    h2 { margin: 0 0 12px; font-size: 20px; font-weight: 600; letter-spacing: 0.5px; }
    p { color: #8b949e; font-size: 13px; margin: 0 0 28px; }
    form { display: flex; flex-direction: column; gap: 20px; }
    input { width: 100%; padding: 14px; background: #11151f; border: 1px solid #2a3143; border-radius: 8px; color: #fff; font-size: 20px; text-align: center; letter-spacing: 6px; box-sizing: border-box; outline: none; transition: border-color 0.3s; }
    input:focus { border-color: #3b82f6; }
    input::placeholder { color: #4b5563; font-size: 14px; letter-spacing: normal; vertical-align: middle; }
    button { width: 100%; padding: 14px; background: #3b82f6; color: #fff; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.3s; display: flex; justify-content: center; align-items: center; gap: 8px; }
    button:hover { background: #2563eb; }
    button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .error { color: #ff6b6b; background: rgba(255, 107, 107, 0.1); border: 1px solid rgba(255, 107, 107, 0.2); border-radius: 8px; padding: 12px; font-size: 14px; margin-bottom: 24px; font-weight: 500; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon-circle">
      <!-- 锁定的图标 -->
      <svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
    </div>
    <h2>面板已锁定</h2>
    <p>此区域受管理密码保护，请输入密码解锁</p>
    <!-- ERROR_SLOT -->
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="••••••••••••" required autofocus>
      <button type="submit">
        <!-- 解锁的图标 -->
        <svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>
        解锁面板
      </button>
    </form>
  </div>
</body>
</html>
`;
// ==========================================================

// 密碼鑒權校驗（僅在設置了 PAGE_PASSWORD 時攔截）
function checkAuth(request: Request, env: Env): boolean {
  if (!env.PAGE_PASSWORD || env.PAGE_PASSWORD.trim() === '') {
    return true; // 未設置密碼，免密模式
  }
  const clientPwd = request.headers.get('X-Password') || '';
  return clientPwd === env.PAGE_PASSWORD.trim();
}

// 輔助載入與解析節點
async function loadNodes(urlParam: string): Promise<ProxyNode[]> {
  const inputs = urlParam.split(/[\n\r|]+/); 
  const allNodes: ProxyNode[] = [];

  for (const input of inputs) {
    const trimmed = input.trim(); 
    if (!trimmed) continue;
    
    if (trimmed.startsWith('http')) { 
      try { 
        const separator = trimmed.includes('?') ? '&' : '?';
        const fetchUrl = `${trimmed}${separator}t=${Date.now()}`;
        
        const resp = await fetch(fetchUrl, { 
          headers: { 
            'User-Agent': 'v2rayNG/1.8.5',
            'Accept': '*/*'
          } 
        }); 
        
        if (resp.ok) { 
          const text = await resp.text(); 
          if (!text.trim().startsWith('<')) {
            try {
              const parsed = await parseContent(text);
              allNodes.push(...parsed);
            } catch {}
          }
        }
      } catch {} 
    } else { 
      try {
        const parsed = await parseContent(trimmed);
        allNodes.push(...parsed); 
      } catch {}
    }
  }
  return allNodes;
}

function safeBtoa(str: string): string {
  try {
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) => {
      return String.fromCharCode(parseInt(p1, 16));
    }));
  } catch {
    return btoa(str);
  }
}

async function getArgoScriptFromGithub(node: ProxyNode, port: string, token: string, domain: string): Promise<string> {
  const GITHUB_TEMPLATE_URL = `https://raw.githubusercontent.com/sammy0101/cf-sub-converter/main/argo.sh?t=${Date.now()}`;
  let template = "";
  
  try {
    const res = await fetch(GITHUB_TEMPLATE_URL, { headers: { 'User-Agent': 'v2rayNG/1.8.5' } });
    if (res.ok) {
      template = await res.text();
    } else {
      throw new Error("GitHub Fetch Failed");
    }
  } catch {
    template = `#!/bin/bash
if ! command -v cloudflared &> /dev/null; then
  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
  chmod +x /usr/local/bin/cloudflared
fi
cloudflared tunnel --url http://127.0.0.1:{{VLESS_PORT}}
`;
  }

  const vlessType = node.network || 'ws';
  const vlessPath = node.wsPath || '/';
  const argoNodeName = `${node.name}_Argo`;
  const isTls = node.tls ? "true" : "false";
  const realHost = node.wsHeaders?.Host || node.sni || node.server; 

  return template
    .replace("{{NODE_TYPE}}", node.type)
    .replace("{{VLESS_UUID}}", node.uuid || '')
    .replace("{{VLESS_PATH}}", vlessPath)
    .replace("{{VLESS_TYPE}}", vlessType)
    .replace("{{VLESS_PORT}}", port)
    .replace("{{NODE_NAME}}", argoNodeName)
    .replace("{{TUNNEL_TOKEN}}", token.trim())
    .replace("{{CUSTOM_DOMAIN}}", domain.trim())
    .replace("{{VLESS_TLS}}", isTls)
    .replace("{{ORIGIN_HOST}}", realHost);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Password',
        }
      });
    }

    // GET /argo/sh/:id (公開)
    if (request.method === 'GET' && url.pathname.startsWith('/argo/sh/')) {
      const scriptId = url.pathname.split('/').pop();
      if (env.SUB_CACHE && scriptId) {
        const script = await env.SUB_CACHE.get(`script:${scriptId}`);
        if (script) {
          return new Response(script, {
            headers: { 
              'Content-Type': 'text/plain; charset=utf-8', 
              'Access-Control-Allow-Origin': '*' 
            }
          });
        }
      }
      return new Response('# 错误: 该脚本不存在或已过期，请重新在网页上生成。\nexit 1\n', { 
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // POST /api/parse-argo (公開)
    if (request.method === 'POST' && (url.pathname === '/api/parse-vless' || url.pathname === '/api/parse-argo')) {
      try {
        const body = (await request.json()) as { url?: string };
        const rawUrl = body.url || '';
        if (!rawUrl.trim()) {
          return new Response(JSON.stringify({ error: '请输入有效的节点内容' }), { 
            status: 400, 
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
          });
        }

        const allNodes = await loadNodes(rawUrl);
        const argoCompatibleNodes = allNodes.filter(n => n.type === 'vless' || n.type === 'vmess').map((n, idx) => ({
          index: idx,
          name: n.name,
          server: n.server,
          port: n.port,
          type: n.type,
          host: n.wsHeaders?.Host || n.sni || n.server
        }));

        return new Response(JSON.stringify(argoCompatibleNodes), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ error: msg }), { 
          status: 500, 
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
        });
      }
    }

    // POST /api/argo-generate (公開)
    if (request.method === 'POST' && url.pathname === '/api/argo-generate') {
      try {
        const body = (await request.json()) as {
          url?: string;
          indices?: number[];
          port?: string;
          cleanIp?: string;
          token?: string;
          domain?: string;
        };

        const rawUrl = body.url || '';
        const selectedIndices = body.indices || [];
        const port = body.port || '8080';
        const cleanIp = (body.cleanIp || '').trim();
        const token = body.token || '';
        const domain = body.domain || '';

        if (!rawUrl.trim() || selectedIndices.length === 0) {
          return new Response(JSON.stringify({ error: '无效的参数或未选择节点' }), { 
            status: 400, 
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
          });
        }

        const allNodes = await loadNodes(rawUrl);
        const compatibleNodes = allNodes.filter(n => n.type === 'vless' || n.type === 'vmess');
        const selectedObjects = selectedIndices.map(idx => compatibleNodes[idx]).filter(Boolean);

        let scripts = '';
        const generatedNodesData: Array<{ originalIndex: number; link: string }> = [];

        for (let i = 0; i < selectedObjects.length; i++) {
          const node = selectedObjects[i];
          const originalIndex = selectedIndices[i];
          
          scripts += await getArgoScriptFromGithub(node, port, token, domain) + '\n\n';

          const targetDomain = (token.trim() && domain.trim()) ? domain.trim() : "请在VPS执行一键安装脚本获取临时域名.trycloudflare.com";
          const connectionServer = cleanIp || targetDomain;
          const argoNodeName = `${node.name}_Argo${cleanIp ? '_优选' : ''}`;

          let argoLink = '';
          if (node.type === 'vless') {
            argoLink = `vless://${node.uuid}@${connectionServer}:443?encryption=none&security=tls&type=${node.network || 'ws'}&host=${targetDomain}&sni=${targetDomain}&path=${node.wsPath || '/'}#${encodeURIComponent(argoNodeName)}`;
          } else {
            const vmessObj = {
              v: "2", ps: argoNodeName, add: connectionServer, port: 443, id: node.uuid,
              aid: 0, scy: "auto", net: node.network || 'ws', type: "none",
              host: targetDomain, path: node.wsPath || '/', tls: "tls", sni: targetDomain
            };
            argoLink = 'vmess://' + safeBtoa(JSON.stringify(vmessObj));
          }

          generatedNodesData.push({ originalIndex, link: argoLink });
        }

        let scriptId = '';
        if (env.SUB_CACHE) {
          scriptId = crypto.randomUUID();
          await env.SUB_CACHE.put('script:' + scriptId, scripts, { expirationTtl: 3600 });
        }

        return new Response(JSON.stringify({ 
          scriptId, 
          argoNodes: generatedNodesData 
        }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ error: msg }), { 
          status: 500, 
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
        });
      }
    }

    // GET /version (公開)
    if (request.method === 'GET' && url.pathname === '/version') {
      return new Response(`subconverter v${version} ${url.host} backend\n`, {
        headers: { 
          'Content-Type': 'text/plain; charset=utf-8', 
          'Access-Control-Allow-Origin': '*'
        } 
      });
    }

    // POST /save (公開)
    if (request.method === 'POST' && url.pathname === '/save') {
      try {
        const body = (await request.json()) as { path?: string; content?: string; include?: string; exclude?: string; rename?: string };
        if (!body.path || !body.content) return new Response('Missing path or content', { status: 400 });
        
        const saveData = {
          content: body.content,
          include: body.include || '',
          exclude: body.exclude || '',
          rename: body.rename || ''
        };
        await env.SUB_CACHE.put(body.path, JSON.stringify(saveData));
        
        return new Response('OK', { status: 200 });
      } catch {
        return new Response('Error saving profile', { status: 500 });
      }
    }

    // --- 💥 Favorites API (受密碼保護區域) ---
    const FAVS_KEY = 'favorites';
    const getFavs = async (): Promise<Array<Record<string, string>>> => {
      const data = await env.SUB_CACHE.get(FAVS_KEY);
      return data ? JSON.parse(data) : [];
    };
    const saveFavs = async (favs: Array<Record<string, string>>): Promise<void> => {
      await env.SUB_CACHE.put(FAVS_KEY, JSON.stringify(favs));
    };

    if (request.method === 'GET' && url.pathname === '/favs') {
      if (!checkAuth(request, env)) {
        return new Response(JSON.stringify({ error: '密码错误或未授权', locked: true }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const favs = await getFavs();
      return new Response(JSON.stringify(favs), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    if (request.method === 'POST' && url.pathname === '/favs') {
      if (!checkAuth(request, env)) {
        return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
      try {
        const body = (await request.json()) as Record<string, string>;
        if (!body.name || !body.url) return new Response('Missing name or url', { status: 400 });
        const favs = await getFavs();
        favs.push({
          name: body.name,
          url: body.url,
          include: body.include || '',
          exclude: body.exclude || '',
          rename: body.rename || ''
        });
        await saveFavs(favs);
        return new Response('OK', { status: 200, headers: { 'Access-Control-Allow-Origin': '*' } });
      } catch {
        return new Response('Error saving favorite', { status: 500 });
      }
    }

    if (request.method === 'PUT' && url.pathname === '/favs') {
      if (!checkAuth(request, env)) {
        return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
      try {
        const body = (await request.json()) as { index?: number; name?: string; url?: string; include?: string; exclude?: string; rename?: string };
        if (body.index === undefined || !body.name || !body.url) return new Response('Missing data', { status: 400 });
        const favs = await getFavs();
        if (body.index >= 0 && body.index < favs.length) {
          favs[body.index] = {
            name: body.name,
            url: body.url,
            include: body.include || '',
            exclude: body.exclude || '',
            rename: body.rename || ''
          };
          await saveFavs(favs);
        }
        return new Response('OK', { status: 200, headers: { 'Access-Control-Allow-Origin': '*' } });
      } catch {
        return new Response('Error updating favorite', { status: 500 });
      }
    }

    if (request.method === 'DELETE' && url.pathname === '/favs') {
      if (!checkAuth(request, env)) {
        return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
      try {
        const body = (await request.json()) as { index?: number };
        if (body.index === undefined) return new Response('Missing index', { status: 400 });
        const favs = await getFavs();
        if (body.index >= 0 && body.index < favs.length) {
          favs.splice(body.index, 1);
          await saveFavs(favs);
        }
        return new Response('OK', { status: 200, headers: { 'Access-Control-Allow-Origin': '*' } });
      } catch {
        return new Response('Error deleting favorite', { status: 500 });
      }
    }

    // GET 訂閱路由 (公開免密)
    let urlParam = url.searchParams.get('url') || '';
    let includeParam = url.searchParams.get('include') || '';
    let excludeParam = url.searchParams.get('exclude') || '';
    let renameParam = url.searchParams.get('rename') || '';
    const forceRefresh = url.searchParams.has('force') || url.searchParams.has('nocache');

    const path = decodeURIComponent(url.pathname.slice(1)); 

    if (path && path !== 'sub' && path !== 'favicon.ico' && path !== '') {
      const stored = await env.SUB_CACHE.get(path);
      if (stored) { 
        try {
          const parsed = JSON.parse(stored);
          if (parsed && parsed.content) {
            urlParam = parsed.content;
            if (!includeParam) includeParam = parsed.include || '';
            if (!excludeParam) excludeParam = parsed.exclude || '';
            if (!renameParam) renameParam = parsed.rename || '';
          }
        } catch {
          urlParam = stored; 
        }
      }
    }

      if (!urlParam || urlParam.trim() === '') {
        if (path === 'sub') {
            return new Response('Error: Missing parameter "url"', { status: 400 });
        }

        // ================= 新增：自定义页面鉴权与防爆破 =================
        const REQUIRED_PASS = env.PAGE_PASSWORD?.trim();

        if (REQUIRED_PASS) {
            // 获取访问者的真实 IP
            const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
            const attempt = ipLoginAttempts.get(clientIP) || { count: 0, lockUntil: 0 };

            // 1. 检查 IP 是否已被锁定
            if (attempt.lockUntil > Date.now()) {
                const waitMins = Math.ceil((attempt.lockUntil - Date.now()) / 60000);
                const errorHtml = LOGIN_HTML.replace('<!-- ERROR_SLOT -->', `<div class="error">尝试次数过多，请 ${waitMins} 分钟后再试</div>`);
                return new Response(errorHtml, { status: 429, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
            }

            // 2. 处理表单提交的登录请求
            if (request.method === 'POST' && url.pathname === '/login') {
                const formData = await request.formData().catch(() => null);
                const inputPass = formData?.get('password');

                if (inputPass === REQUIRED_PASS) {
                    // 登录成功：清除该 IP 的错误记录
                    ipLoginAttempts.delete(clientIP);
                    
                    // 生成 Cookie，有效期 30 天
                    const cookieValue = btoa(encodeURIComponent(REQUIRED_PASS));
                    return new Response('', {
                        status: 302, // 重定向回首页
                        headers: {
                            'Location': '/',
                            'Set-Cookie': `panel_auth=${cookieValue}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax`
                        }
                    });
                } else {
                    // 登录失败：记录错误次数
                    attempt.count += 1;
                    let errorMsg = `密码错误，剩余 ${10 - attempt.count} 次机会`;
                    
                    // 连续错 10 次，锁定 15 分钟
                    if (attempt.count >= 10) {
                        attempt.lockUntil = Date.now() + 15 * 60 * 1000;
                        errorMsg = '尝试次数过多，已锁定 15 分钟';
                    }
                    
                    ipLoginAttempts.set(clientIP, attempt);
                    
                    // 防止 Worker 内存溢出，超 5000 条记录自动清空
                    if (ipLoginAttempts.size > 5000) ipLoginAttempts.clear();

                    const errorHtml = LOGIN_HTML.replace('<!-- ERROR_SLOT -->', `<div class="error">${errorMsg}</div>`);
                    return new Response(errorHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
                }
            }

            // 3. 处理正常的 GET 请求（检查 Cookie）
            const cookies = request.headers.get('Cookie') || '';
            const expectedCookie = `panel_auth=${btoa(encodeURIComponent(REQUIRED_PASS))}`;
            
            if (!cookies.includes(expectedCookie)) {
                // 没有 Cookie 或密码已改，展示干净的登录页
                const normalHtml = LOGIN_HTML.replace('<!-- ERROR_SLOT -->', '');
                return new Response(normalHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
            }
            
            // 如果已经登录，但误入了 /login 路径，重定向到首页
            if (url.pathname === '/login') {
                 return Response.redirect(url.origin + '/', 302);
            }
        }
        // ===============================================================

        // 如果没有设置密码，或者 Cookie 验证通过，展示真实的转换面板
        const dynamicHtml = HTML_PAGE.replace('v3.5.0', `v${version}`);
        return new Response(dynamicHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // 解析節點
    const inputs = urlParam.split(/[\n\r|]+/); 
    const allNodes: ProxyNode[] = [];
    let totalUpload = 0;
    let totalDownload = 0;
    let totalTotal = 0;
    let minExpire = 0;
    let hasTrafficInfo = false;

    for (const input of inputs) {
      const trimmed = input.trim(); 
      if (!trimmed) continue;
      
      if (trimmed.startsWith('http')) { 
        try { 
          const separator = trimmed.includes('?') ? '&' : '?';
          const fetchUrl = `${trimmed}${separator}t=${Date.now()}`;
          const resp = await fetch(fetchUrl, { headers: { 'User-Agent': 'v2rayNG/1.8.5' } }); 
          
          if (resp.ok) { 
            const text = await resp.text(); 
            const userInfo = resp.headers.get('subscription-userinfo');
            if (userInfo) {
              hasTrafficInfo = true;
              const uploadMatch = userInfo.match(/upload=(\d+)/i);
              const downloadMatch = userInfo.match(/download=(\d+)/i);
              const totalMatch = userInfo.match(/total=(\d+)/i);
              const expireMatch = userInfo.match(/expire=(\d+)/i);

              totalUpload += uploadMatch ? parseInt(uploadMatch[1]) : 0;
              totalDownload += downloadMatch ? parseInt(downloadMatch[1]) : 0;
              totalTotal += totalMatch ? parseInt(totalMatch[1]) : 0;
              
              const expireVal = expireMatch ? parseInt(expireMatch[1]) : 0;
              if (expireVal > 0) {
                if (minExpire === 0 || expireVal < minExpire) minExpire = expireVal; 
              }
            }

            if (!text.trim().startsWith('<')) {
              try {
                const parsed = await parseContent(text);
                allNodes.push(...parsed);
              } catch {}
            }
          }
        } catch {} 
      } else { 
        try {
          const parsed = await parseContent(trimmed);
          allNodes.push(...parsed); 
        } catch {}
      }
    }

    if (allNodes.length === 0) {
      return new Response('未解析到任何有效节点。', { status: 400 });
    }

    let filteredNodes = allNodes;

    // 替換
    if (renameParam) {
      const rules = renameParam.split('|');
      for (const rule of rules) {
        const trimmedRule = rule.trim();
        if (!trimmedRule) continue;

        if (trimmedRule.startsWith('DEL-')) {
          const search = trimmedRule.substring(4); 
          if (search) {
            filteredNodes.forEach(node => {
              if (node.name) node.name = node.name.split(search).join('');
            });
          }
        } else if (trimmedRule.includes('-')) {
          const idx = trimmedRule.indexOf('-');
          const search = trimmedRule.substring(0, idx).trim();
          const replace = trimmedRule.substring(idx + 1).trim();
          
          if (search && replace !== undefined) {
            if (search.toUpperCase() === 'ALL') {
              filteredNodes.forEach(node => { node.name = replace; });
            } else {
              filteredNodes.forEach(node => {
                if (node.name) node.name = node.name.split(search).join(replace);
              });
            }
          }
        }
      }
    }

    const buildFilterRegex = (param: string): RegExp => {
      const parts = param.split('|').map(part => {
        const trimmed = part.trim();
        if (!trimmed) return '';
        const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return escaped.replace(/[xXｘＸ×]/g, '[xXｘＸ×]');
      }).filter(Boolean);
      return new RegExp(parts.join('|'), 'i');
    };

    if (includeParam) {
      const includeRegex = buildFilterRegex(includeParam);
      filteredNodes = filteredNodes.filter(node => includeRegex.test(node.name));
    }

    if (excludeParam) {
      const excludeRegex = buildFilterRegex(excludeParam);
      filteredNodes = filteredNodes.filter(node => !excludeRegex.test(node.name));
    }

    const sortedNodes = groupNodesByFlag(filteredNodes);
    const uniqueNodes = deduplicateNodeNames(sortedNodes);

    let target = url.searchParams.get('target');

    // 自動探測 User-Agent
    if (!target) {
      const ua = (request.headers.get('User-Agent') || '').toLowerCase();
      if (ua.includes('clash') || ua.includes('mihomo') || ua.includes('stash') || ua.includes('surfboard')) {
        target = 'clash';
      } else if (ua.includes('sing-box') || ua.includes('singbox') || ua.includes('hiddify')) {
        target = 'singbox';
      } else if (ua.includes('surge')) {
        target = 'surge';
      } else if (ua.includes('quantumult')) {
        target = 'quanx';
      } else if (ua.includes('loon')) {
        target = 'loon';
      } else if (ua.includes('v2ray') || ua.includes('shadowrocket')) {
        target = 'base64';
      }
    }

    if (!target) {
      const host = `https://${url.host}`;
      const encodedUrl = encodeURIComponent(urlParam);
      let filterQuery = '';
      if (includeParam) filterQuery += `&include=${encodeURIComponent(includeParam)}`;
      if (excludeParam) filterQuery += `&exclude=${encodeURIComponent(excludeParam)}`;
      if (renameParam) filterQuery += `&rename=${encodeURIComponent(renameParam)}`;

      const htmlInfo = `
<!DOCTYPE html><html><head><meta charset="utf-8"><title>转换完成</title><style>body{background:#0f172a;color:#f8fafc;font-family:sans-serif;padding:40px;text-align:center;}a{display:inline-block;margin:10px;padding:12px 24px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:8px;}</style></head>
<body>
  <h1>⚡ 成功转换 ${uniqueNodes.length} 个节点</h1>
  <div>
    <a href="${host}/?url=${encodedUrl}${filterQuery}&target=clash">Clash Meta (YAML)</a>
    <a href="${host}/?url=${encodedUrl}${filterQuery}&target=singbox">Sing-Box (JSON)</a>
    <a href="${host}/?url=${encodedUrl}${filterQuery}&target=surge">Surge 5</a>
    <a href="${host}/?url=${encodedUrl}${filterQuery}&target=quanx">Quantumult X</a>
    <a href="${host}/?url=${encodedUrl}${filterQuery}&target=loon">Loon</a>
    <a href="${host}/?url=${encodedUrl}${filterQuery}&target=base64">Base64</a>
  </div>
</body></html>`;
      return new Response(htmlInfo, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    let result = '';
    let contentType = 'text/plain';
    let fileExt = '.txt';

    if (target === 'clash') {
      result = await toClashWithTemplate(uniqueNodes, env, forceRefresh);
      contentType = 'text/yaml';
      fileExt = '.yaml';
    } else if (target === 'surge') {
      result = toSurge(uniqueNodes);
      contentType = 'text/plain';
      fileExt = '.conf';
    } else if (target === 'quanx' || target === 'qx') {
      result = toQuantumultX(uniqueNodes);
      contentType = 'text/plain';
      fileExt = '.txt';
    } else if (target === 'loon') {
      result = toLoon(uniqueNodes);
      contentType = 'text/plain';
      fileExt = '.conf';
    } else if (target === 'base64') {
      result = toBase64(uniqueNodes);
      contentType = 'text/plain';
      fileExt = '.txt';
    } else {
      result = await toSingBoxWithTemplate(uniqueNodes, env, forceRefresh);
      contentType = 'application/json';
      fileExt = '.json';
    }

    const filename = `sub${fileExt}`;
    const responseHeaders: Record<string, string> = {
      'Content-Type': `${contentType}; charset=utf-8`, 
      'Access-Control-Allow-Origin': '*', 
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Profile-Update-Interval': '3600',
    };

    if (hasTrafficInfo) {
      let userInfoHeader = `upload=${totalUpload}; download=${totalDownload}; total=${totalTotal}`;
      if (minExpire > 0) userInfoHeader += `; expire=${minExpire}`;
      responseHeaders['subscription-userinfo'] = userInfoHeader;
    }

    return new Response(result, { headers: responseHeaders });
  }
};
