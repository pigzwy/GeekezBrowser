# GeekezBrowser Control Server API 文档

本文档描述 GeekezBrowser 二开的 Control Server API，用于通过 HTTP 接口管理浏览器环境，支持 CDP (Chrome DevTools Protocol) 自动化。

## 启动方式

### 环境变量配置

```bash
# 设置 Chrome 路径（必须）
export CHROME_PATH=/usr/bin/google-chrome

# 可选：永久添加到 ~/.bashrc
echo 'export CHROME_PATH=/usr/bin/google-chrome' >> ~/.bashrc
```

### 启动命令

```bash
# 基本启动
CHROME_PATH=/usr/bin/google-chrome npm start -- --control-port=19527

# Linux 下可能需要 --no-sandbox
CHROME_PATH=/usr/bin/google-chrome npm start -- --control-port=19527 --no-sandbox
```

### 启动参数

| 参数 | 环境变量 | 默认值 | 说明 |
|------|----------|--------|------|
| `--control-port` | `GEEKEZ_CONTROL_PORT` | 无 | Control Server 端口，不设置则不启动 |
| `--control-host` | `GEEKEZ_CONTROL_HOST` | `127.0.0.1` | Control Server 监听地址 |
| `--control-token` | `GEEKEZ_CONTROL_TOKEN` | 无 | Bearer Token 认证（可选） |

### 启动成功日志

```
[Control] Listening on http://127.0.0.1:19527
[API] Server auto-started on http://localhost:12138
```

---

## API 端点

### 基础信息

- **Base URL**: `http://127.0.0.1:19527`
- **认证**: 如设置了 token，需要 `Authorization: Bearer {token}` header

---

### 1. 健康检查

检查 Control Server 是否正常运行。

```bash
curl http://127.0.0.1:19527/health
```

**响应**:
```json
{"ok": true}
```

---

### 2. 列出所有环境

获取所有浏览器配置文件列表。

```bash
curl http://127.0.0.1:19527/profiles
```

**响应**:
```json
{
  "ok": true,
  "profiles": [
    {
      "id": "8c51fd36-41bd-4fc3-961e-44f753417cc2",
      "name": "test-123-new",
      "debugPort": null,
      "tags": []
    },
    {
      "id": "dec7200b-45cd-4425-a07e-cc21aebfb574",
      "name": "123",
      "debugPort": 9222,
      "tags": ["production"]
    }
  ]
}
```

---

### 3. 启动环境（获取 CDP 连接）

启动指定的浏览器环境，返回 CDP WebSocket 端点用于自动化。

```bash
curl -X POST "http://127.0.0.1:19527/profiles/{profile_id}/launch" \
  -H "Content-Type: application/json" \
  -d '{
    "debugPort": 0,
    "enableRemoteDebugging": true
  }'
```

**请求参数**:

| 参数 | 类型 | 说明 |
|------|------|------|
| `debugPort` | number | 调试端口。`0` 或 `"auto"` 自动分配 |
| `enableRemoteDebugging` | boolean | 是否启用远程调试 |
| `watermarkStyle` | string | 水印样式（可选） |

**响应**:
```json
{
  "ok": true,
  "profileId": "8c51fd36-41bd-4fc3-961e-44f753417cc2",
  "message": null,
  "debugPort": 37957,
  "wsEndpoint": "ws://127.0.0.1:37957/devtools/browser/a2ac635a-9fdc-4a3e-9274-fe2b0175e2f8"
}
```

**重要**: `wsEndpoint` 用于 Puppeteer/Playwright 连接浏览器进行自动化操作。

---

### 4. 关闭环境

关闭指定的浏览器环境。

```bash
curl -X POST "http://127.0.0.1:19527/profiles/{profile_id}/stop"
```

**响应（成功关闭）**:
```json
{
  "ok": true,
  "profileId": "8c51fd36-41bd-4fc3-961e-44f753417cc2",
  "message": "Stopped"
}
```

**响应（环境未运行）**:
```json
{
  "ok": true,
  "profileId": "8c51fd36-41bd-4fc3-961e-44f753417cc2",
  "message": "Not running"
}
```

---

## 配合上游 API Server 使用

Control Server (19527) 主要用于启动/关闭和获取 CDP 连接。创建/删除/编辑环境需要使用上游 API Server (12138)。

### 创建新环境

```bash
curl -X POST "http://127.0.0.1:12138/api/profiles" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-new-profile"}'
```

**响应**:
```json
{
  "success": true,
  "profile": {
    "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "name": "my-new-profile"
  }
}
```

### 删除环境

```bash
curl -X DELETE "http://127.0.0.1:12138/api/profiles/{profile_id}"
```

### 获取单个环境详情

```bash
curl "http://127.0.0.1:12138/api/profiles/{profile_id}"
```

### 编辑环境

```bash
curl -X PUT "http://127.0.0.1:12138/api/profiles/{profile_id}" \
  -H "Content-Type: application/json" \
  -d '{"name": "new-name", "tags": ["tag1", "tag2"]}'
```

---

## 完整自动化流程示例

### Python 示例

```python
import requests
from playwright.sync_api import sync_playwright

CONTROL_SERVER = "http://127.0.0.1:19527"
API_SERVER = "http://127.0.0.1:12138"

# 1. 创建新环境
resp = requests.post(f"{API_SERVER}/api/profiles", json={"name": "auto-test"})
profile_id = resp.json()["profile"]["id"]
print(f"Created profile: {profile_id}")

# 2. 启动环境并获取 CDP 连接
resp = requests.post(
    f"{CONTROL_SERVER}/profiles/{profile_id}/launch",
    json={"debugPort": 0, "enableRemoteDebugging": True}
)
data = resp.json()
ws_endpoint = data["wsEndpoint"]
print(f"CDP Endpoint: {ws_endpoint}")

# 3. 使用 Playwright 连接并操作
with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(ws_endpoint)
    page = browser.contexts[0].pages[0]
    page.goto("https://www.google.com")
    print(f"Page title: {page.title()}")
    browser.close()

# 4. 关闭环境
requests.post(f"{CONTROL_SERVER}/profiles/{profile_id}/stop")
print("Profile stopped")

# 5. 删除环境（可选）
requests.delete(f"{API_SERVER}/api/profiles/{profile_id}")
print("Profile deleted")
```

### Node.js 示例

```javascript
const puppeteer = require('puppeteer-core');

const CONTROL_SERVER = 'http://127.0.0.1:19527';
const API_SERVER = 'http://127.0.0.1:12138';

async function main() {
  // 1. 创建新环境
  let resp = await fetch(`${API_SERVER}/api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'auto-test-node' })
  });
  const { profile } = await resp.json();
  console.log('Created profile:', profile.id);

  // 2. 启动环境
  resp = await fetch(`${CONTROL_SERVER}/profiles/${profile.id}/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ debugPort: 0, enableRemoteDebugging: true })
  });
  const { wsEndpoint } = await resp.json();
  console.log('CDP Endpoint:', wsEndpoint);

  // 3. 连接并操作
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  await page.goto('https://www.google.com');
  console.log('Page title:', await page.title());
  browser.disconnect();

  // 4. 关闭环境
  await fetch(`${CONTROL_SERVER}/profiles/${profile.id}/stop`, { method: 'POST' });
  console.log('Profile stopped');

  // 5. 删除环境
  await fetch(`${API_SERVER}/api/profiles/${profile.id}`, { method: 'DELETE' });
  console.log('Profile deleted');
}

main().catch(console.error);
```

---

## 二开功能列表

本次二开在上游 v1.3.4 基础上添加了以下功能：

### 1. Control Server (端口 19527)
- `GET /health` - 健康检查
- `GET /profiles` - 列出环境
- `POST /profiles/{id}/launch` - 启动环境（返回 CDP wsEndpoint）
- `POST /profiles/{id}/stop` - 关闭环境

### 2. Chrome 路径自动检测
支持通过环境变量指定 Chrome 路径：
- `CHROME_PATH`
- `PUPPETEER_EXECUTABLE_PATH`

### 3. IP 地理位置自动检测
创建/保存环境时，如果配置了代理且未手动设置时区/语言，会自动：
- 通过代理检测出口 IP 位置
- 自动设置对应的 timezone、language、geolocation

### 4. 任务栏图标修复
添加 `--class=GeekezBrowser-{profile_id}` 参数，确保启动的 Chrome 窗口在 Linux 任务栏正确显示。

---

## API 对比

| 功能 | Control Server (19527) | API Server (12138) |
|------|------------------------|---------------------|
| 健康检查 | ✅ `GET /health` | ✅ `GET /api/status` |
| 列出环境 | ✅ `GET /profiles` | ✅ `GET /api/profiles` |
| 创建环境 | ❌ | ✅ `POST /api/profiles` |
| 编辑环境 | ❌ | ✅ `PUT /api/profiles/:id` |
| 删除环境 | ❌ | ✅ `DELETE /api/profiles/:id` |
| 启动环境 | ✅ 返回 CDP | ✅ 不返回 CDP |
| 关闭环境 | ✅ | ✅ |

**推荐使用方式**：
- 创建/编辑/删除 → API Server (12138)
- 启动/关闭/CDP 自动化 → Control Server (19527)
