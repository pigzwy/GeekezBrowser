const { app, BrowserWindow, ipcMain, dialog, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { spawn, exec } = require('child_process');
const getPort = require('get-port');
const puppeteer = require('puppeteer'); // 使用原生 puppeteer，不带 extra
const { v4: uuidv4 } = require('uuid');
const yaml = require('js-yaml');
const { SocksProxyAgent } = require('socks-proxy-agent');
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);


// Hardware acceleration enabled for better UI performance
// Only disable if GPU compatibility issues occur

const { generateXrayConfig } = require('./utils');
const { generateFingerprint, getInjectScript } = require('./fingerprint');

const isDev = !app.isPackaged;
const RESOURCES_BIN = isDev ? path.join(__dirname, 'resources', 'bin') : path.join(process.resourcesPath, 'bin');
// Use platform+arch specific directory for xray binary
const PLATFORM_ARCH = `${process.platform}-${process.arch}`; // e.g., darwin-arm64, darwin-x64, win32-x64
const BIN_DIR = path.join(RESOURCES_BIN, PLATFORM_ARCH);
const BIN_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'xray.exe' : 'xray');
// Fallback to old location for backward compatibility
const BIN_DIR_LEGACY = RESOURCES_BIN;
const BIN_PATH_LEGACY = path.join(BIN_DIR_LEGACY, process.platform === 'win32' ? 'xray.exe' : 'xray');

// 自定义数据目录支持
const APP_CONFIG_FILE = path.join(app.getPath('userData'), 'app-config.json');
const DEFAULT_DATA_PATH = path.join(app.getPath('userData'), 'BrowserProfiles');

// 读取自定义数据目录
function getCustomDataPath() {
    try {
        if (fs.existsSync(APP_CONFIG_FILE)) {
            const config = fs.readJsonSync(APP_CONFIG_FILE);
            if (config.customDataPath && fs.existsSync(config.customDataPath)) {
                return config.customDataPath;
            }
        }
    } catch (e) {
        console.error('Failed to read custom data path:', e);
    }
    return DEFAULT_DATA_PATH;
}

const DATA_PATH = getCustomDataPath();
const TRASH_PATH = path.join(app.getPath('userData'), '_Trash_Bin');
const PROFILES_FILE = path.join(DATA_PATH, 'profiles.json');
const SETTINGS_FILE = path.join(DATA_PATH, 'settings.json');

fs.ensureDirSync(DATA_PATH);
fs.ensureDirSync(TRASH_PATH);

let activeProcesses = {};
let apiServer = null;
let apiServerRunning = false;
let mainWindow = null; // Global reference for API-to-UI communication

// ============================================================================
// REST API Server
// ============================================================================
function createApiServer(port) {
    const server = http.createServer(async (req, res) => {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        const url = new URL(req.url, `http://localhost:${port}`);
        const pathname = url.pathname;
        const method = req.method;

        // Parse body for POST/PUT
        let body = '';
        if (method === 'POST' || method === 'PUT') {
            body = await new Promise(resolve => {
                let data = '';
                req.on('data', chunk => data += chunk);
                req.on('end', () => resolve(data));
            });
        }

        try {
            const result = await handleApiRequest(method, pathname, body, url.searchParams);
            res.writeHead(result.status || 200);
            res.end(JSON.stringify(result.data || result));
        } catch (err) {
            console.error('API Error:', err);
            res.writeHead(500);
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
    });

    return server;
}

async function handleApiRequest(method, pathname, body, params) {
    let profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : {};

    // Helper: Find profile by ID or Name
    const findProfile = (idOrName) => {
        return profiles.find(p => p.id === idOrName || p.name === idOrName);
    };

    // Helper: Generate unique name
    const generateUniqueName = (baseName) => {
        if (!profiles.find(p => p.name === baseName)) return baseName;
        let suffix = 2;
        while (profiles.find(p => p.name === `${baseName}-${String(suffix).padStart(2, '0')}`)) {
            suffix++;
        }
        return `${baseName}-${String(suffix).padStart(2, '0')}`;
    };

    // GET /api/status
    if (method === 'GET' && pathname === '/api/status') {
        return { success: true, running: Object.keys(activeProcesses), count: Object.keys(activeProcesses).length };
    }

    // GET /api/profiles
    if (method === 'GET' && pathname === '/api/profiles') {
        return { success: true, profiles: profiles.map(p => ({ id: p.id, name: p.name, tags: p.tags, running: !!activeProcesses[p.id] })) };
    }

    // GET /api/profiles/:idOrName
    const profileMatch = pathname.match(/^\/api\/profiles\/([^\/]+)$/);
    if (method === 'GET' && profileMatch) {
        const profile = findProfile(decodeURIComponent(profileMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };
        return { success: true, profile: { ...profile, running: !!activeProcesses[profile.id] } };
    }

    // POST /api/profiles - Create with unique name
    if (method === 'POST' && pathname === '/api/profiles') {
        const data = JSON.parse(body);
        const id = uuidv4();
        const fingerprint = await generateFingerprint({});
        const baseName = data.name || `Profile-${Date.now()}`;
        const uniqueName = generateUniqueName(baseName);
        const newProfile = {
            id,
            name: uniqueName,
            proxyStr: data.proxyStr || '',
            tags: data.tags || [],
            fingerprint,
            createdAt: Date.now()
        };
        profiles.push(newProfile);
        await fs.writeJson(PROFILES_FILE, profiles);
        notifyUIRefresh(); // Notify UI to refresh
        return { success: true, profile: newProfile };
    }

    // PUT /api/profiles/:idOrName - Edit
    if (method === 'PUT' && profileMatch) {
        const profile = findProfile(decodeURIComponent(profileMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };
        const idx = profiles.findIndex(p => p.id === profile.id);
        const data = JSON.parse(body);
        // If name changed, ensure uniqueness
        if (data.name && data.name !== profile.name) {
            data.name = generateUniqueName(data.name);
        }
        profiles[idx] = { ...profiles[idx], ...data };
        await fs.writeJson(PROFILES_FILE, profiles);
        return { success: true, profile: profiles[idx] };
    }

    // DELETE /api/profiles/:idOrName
    if (method === 'DELETE' && profileMatch) {
        const profile = findProfile(decodeURIComponent(profileMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };
        profiles = profiles.filter(p => p.id !== profile.id);
        await fs.writeJson(PROFILES_FILE, profiles);
        notifyUIRefresh(); // Notify UI to refresh
        return { success: true, message: 'Profile deleted' };
    }

    // GET /api/open/:idOrName - Launch profile
    const openMatch = pathname.match(/^\/api\/open\/([^\/]+)$/);
    if (method === 'GET' && openMatch) {
        const profile = findProfile(decodeURIComponent(openMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };
        if (activeProcesses[profile.id]) return { success: true, message: 'Already running', profileId: profile.id };
        // Trigger launch via IPC to main window
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('api-launch-profile', profile.id);
        }
        return { success: true, message: 'Launch requested', profileId: profile.id, name: profile.name };
    }

    // POST /api/profiles/:idOrName/stop - Stop profile
    const stopMatch = pathname.match(/^\/api\/profiles\/([^\/]+)\/stop$/);
    if (method === 'POST' && stopMatch) {
        const profile = findProfile(decodeURIComponent(stopMatch[1]));
        if (!profile) return { status: 404, data: { success: false, error: 'Profile not found' } };
        const proc = activeProcesses[profile.id];
        if (!proc) return { status: 404, data: { success: false, error: 'Profile not running' } };

        // Align with in-app cleanup behavior (see: ipcMain.handle('delete-profile'))
        // Puppeteer 已断开，使用进程管理关闭浏览器
        await forceKill(proc.xrayPid);

        // 关闭 Chrome 进程
        try {
            if (proc.chromeProcess && !proc.chromeProcess.killed) {
                proc.chromeProcess.kill();
            } else if (proc.chromePid) {
                await forceKill(proc.chromePid);
            }
        } catch (e) {
            try {
                console.warn('Failed to close browser for profile:', profile.id, e && e.message ? e.message : e);
            } catch (_) { }
        }

        // Close log file descriptor (Windows needs this)
        if (proc.logFd !== undefined) {
            try {
                fs.closeSync(proc.logFd);
            } catch (e) { }
        }

        delete activeProcesses[profile.id];
        await new Promise(r => setTimeout(r, 200));
        return { success: true, message: 'Profile stopped' };
    }

    // GET /api/export/all?password=xxx - Export full backup
    if (method === 'GET' && pathname === '/api/export/all') {
        const password = params.get('password');
        if (!password) return { status: 400, data: { success: false, error: 'Password required. Use ?password=yourpassword' } };

        // Build backup data
        const backupData = {
            version: 1,
            createdAt: Date.now(),
            profiles: profiles.map(p => ({ ...p, fingerprint: cleanFingerprint ? cleanFingerprint(p.fingerprint) : p.fingerprint })),
            preProxies: settings.preProxies || [],
            subscriptions: settings.subscriptions || [],
            browserData: {}
        };

        // Collect browser data
        for (const profile of profiles) {
            const profileDataDir = path.join(DATA_PATH, profile.id, 'browser_data');
            if (fs.existsSync(profileDataDir)) {
                const defaultDir = path.join(profileDataDir, 'Default');
                if (fs.existsSync(defaultDir)) {
                    const browserFiles = {};
                    const filesToBackup = ['Bookmarks', 'Cookies', 'Login Data', 'Web Data', 'Preferences'];
                    for (const fileName of filesToBackup) {
                        const filePath = path.join(defaultDir, fileName);
                        if (fs.existsSync(filePath)) {
                            try {
                                const content = await fs.readFile(filePath);
                                browserFiles[fileName] = content.toString('base64');
                            } catch (err) { }
                        }
                    }
                    if (Object.keys(browserFiles).length > 0) {
                        backupData.browserData[profile.id] = browserFiles;
                    }
                }
            }
        }

        // Compress and encrypt
        const jsonStr = JSON.stringify(backupData);
        const compressed = await gzip(Buffer.from(jsonStr, 'utf8'));
        const encrypted = encryptData(compressed, password);

        return {
            success: true,
            data: encrypted.toString('base64'),
            filename: `GeekEZ_FullBackup_${Date.now()}.geekez`,
            profileCount: profiles.length
        };
    }

    // GET /api/export/fingerprint - Export YAML fingerprints
    if (method === 'GET' && pathname === '/api/export/fingerprint') {
        const exportData = profiles.map(p => ({
            id: p.id,
            name: p.name,
            proxyStr: p.proxyStr,
            tags: p.tags,
            fingerprint: cleanFingerprint ? cleanFingerprint(p.fingerprint) : p.fingerprint
        }));
        const yamlStr = yaml.dump(exportData, { lineWidth: -1, noRefs: true });
        return {
            success: true,
            data: yamlStr,
            filename: `GeekEZ_Profiles_${Date.now()}.yaml`,
            profileCount: profiles.length
        };
    }

    // POST /api/import - Import backup (YAML or encrypted)
    if (method === 'POST' && pathname === '/api/import') {
        try {
            const data = JSON.parse(body);
            const content = data.content;
            const password = data.password;

            if (!content) return { status: 400, data: { success: false, error: 'Content required' } };

            // Try YAML first
            try {
                const yamlData = yaml.load(content);
                if (Array.isArray(yamlData)) {
                    let imported = 0;
                    for (const item of yamlData) {
                        const name = generateUniqueName(item.name || `Imported-${Date.now()}`);
                        const newProfile = {
                            id: uuidv4(),
                            name,
                            proxyStr: item.proxyStr || '',
                            tags: item.tags || [],
                            fingerprint: item.fingerprint || await generateFingerprint({}),
                            createdAt: Date.now()
                        };
                        profiles.push(newProfile);
                        imported++;
                    }
                    await fs.writeJson(PROFILES_FILE, profiles);
                    notifyUIRefresh(); // Notify UI to refresh
                    return { success: true, message: `Imported ${imported} profiles from YAML`, count: imported };
                }
            } catch (yamlErr) { }

            // Try encrypted backup
            if (!password) return { status: 400, data: { success: false, error: 'Password required for encrypted backup' } };

            try {
                const encrypted = Buffer.from(content, 'base64');
                const decrypted = decryptData(encrypted, password);
                const decompressed = await gunzip(decrypted);
                const backupData = JSON.parse(decompressed.toString('utf8'));

                let imported = 0;
                for (const profile of backupData.profiles || []) {
                    const name = generateUniqueName(profile.name);
                    const newProfile = { ...profile, id: uuidv4(), name };
                    profiles.push(newProfile);
                    imported++;
                }
                await fs.writeJson(PROFILES_FILE, profiles);
                notifyUIRefresh(); // Notify UI to refresh
                return { success: true, message: `Imported ${imported} profiles from backup`, count: imported };
            } catch (decryptErr) {
                return { status: 400, data: { success: false, error: 'Invalid password or corrupted backup' } };
            }
        } catch (err) {
            return { status: 400, data: { success: false, error: err.message } };
        }
    }

    return { status: 404, data: { success: false, error: 'Endpoint not found' } };
}

// API Server IPC handlers
ipcMain.handle('start-api-server', async (e, { port }) => {
    if (apiServerRunning) {
        return { success: false, error: 'API server already running' };
    }
    try {
        apiServer = createApiServer(port);
        await new Promise((resolve, reject) => {
            apiServer.listen(port, '127.0.0.1', () => resolve());
            apiServer.on('error', reject);
        });
        apiServerRunning = true;
        console.log(`🔌 API Server started on http://localhost:${port}`);
        return { success: true, port };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('stop-api-server', async () => {
    if (!apiServer) return { success: true };
    return new Promise(resolve => {
        apiServer.close(() => {
            apiServer = null;
            apiServerRunning = false;
            console.log('🔌 API Server stopped');
            resolve({ success: true });
        });
    });
});

ipcMain.handle('get-api-status', () => {
    return { running: apiServerRunning };
});


function forceKill(pid) {
    return new Promise((resolve) => {
        if (!pid) return resolve();
        try {
            if (process.platform === 'win32') exec(`taskkill /pid ${pid} /T /F`, () => resolve());
            else { process.kill(pid, 'SIGKILL'); resolve(); }
        } catch (e) { resolve(); }
    });
}

function getChromiumPath() {
    // 优先级 1：环境变量指定的路径
    const envPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
    if (envPath && fs.existsSync(envPath)) return envPath;

    // 优先级 2：系统安装的正版 Chrome（推荐！避免 Chrome for Testing 被检测）
    const systemChrome = findSystemChrome();
    if (systemChrome) {
        console.log('[Chrome] Using system Chrome:', systemChrome);
        return systemChrome;
    }

    // 优先级 3：Puppeteer 自带的 Chrome for Testing（降级方案）
    const basePath = isDev ? path.join(__dirname, 'resources', 'puppeteer') : path.join(process.resourcesPath, 'puppeteer');

    if (!fs.existsSync(basePath)) return null;
    function findFile(dir, filename) {
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    const res = findFile(fullPath, filename);
                    if (res) return res;
                } else if (file === filename) {
                    return fullPath;
                }
            }
        } catch (e) {
            return null;
        }
        return null;
    }

    // macOS: Chrome binary is inside .app/Contents/MacOS/
    if (process.platform === 'darwin') {
        return findFile(basePath, 'Google Chrome for Testing');
    }

    // Windows
    if (process.platform === 'win32') {
        return findFile(basePath, 'chrome.exe');
    }

    return findFile(basePath, 'chrome');
}

/**
 * 查找系统安装的正版 Chrome
 * 正版 Chrome 不会被 Stripe/Cloudflare 标记为 "Chrome for Testing"
 */
function findSystemChrome() {
    if (process.platform === 'win32') {
        // Windows: 检查常见安装路径
        const candidates = [
            path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ];
        for (const p of candidates) {
            if (p && fs.existsSync(p)) return p;
        }
    } else if (process.platform === 'darwin') {
        // macOS: 检查 Applications
        const candidates = [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            path.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) return p;
        }
    } else {
        // Linux
        const candidates = [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) return p;
        }
    }
    return null;
}

let controlServer = null;

function getArgValue(name) {
    const argv = process.argv || [];
    const idx = argv.indexOf(name);
    if (idx > -1) {
        const value = argv[idx + 1];
        if (value && typeof value === 'string' && !value.startsWith('--')) return value;
    }
    const prefix = name + '=';
    const kv = argv.find(a => typeof a === 'string' && a.startsWith(prefix));
    if (kv) return kv.slice(prefix.length);
    return null;
}

function getControlConfig() {
    const host = getArgValue('--control-host') || process.env.GEEKEZ_CONTROL_HOST || '127.0.0.1';
    const portRaw = getArgValue('--control-port') || process.env.GEEKEZ_CONTROL_PORT || '';
    const tokenRaw = getArgValue('--control-token') || process.env.GEEKEZ_CONTROL_TOKEN || '';
    const port = portRaw ? Number(portRaw) : null;
    const token = tokenRaw ? String(tokenRaw) : null;
    return { host, port: Number.isFinite(port) ? port : null, token };
}

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => {
            data += chunk.toString('utf8');
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

async function readJsonBody(req) {
    const text = await readBody(req);
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error('Invalid JSON');
    }
}

async function startControlServer() {
    if (controlServer) return;
    const cfg = getControlConfig();
    if (!cfg.port) return;

    controlServer = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url || '/', `http://${cfg.host}:${cfg.port}`);
            if (cfg.token) {
                const auth = String(req.headers.authorization || '');
                if (auth !== `Bearer ${cfg.token}`) {
                    return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
                }
            }

            if (req.method === 'GET' && url.pathname === '/health') {
                return sendJson(res, 200, { ok: true });
            }

            if (req.method === 'GET' && url.pathname === '/profiles') {
                const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
                const items = (profiles || []).map(p => ({
                    id: p.id,
                    name: p.name,
                    debugPort: p.debugPort || null,
                    tags: p.tags || []
                }));
                return sendJson(res, 200, { ok: true, profiles: items });
            }

            const launchMatch = url.pathname.match(/^\/profiles\/([0-9a-fA-F-]{36})\/launch$/);
            if (req.method === 'POST' && launchMatch) {
                const profileId = launchMatch[1];
                const body = await readJsonBody(req);

                let profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
                const idx = (profiles || []).findIndex(p => p.id === profileId);
                if (idx === -1) return sendJson(res, 404, { ok: false, error: 'Profile not found' });

                const profile = profiles[idx];
                const requestedDebugPort = body && Object.prototype.hasOwnProperty.call(body, 'debugPort') ? body.debugPort : undefined;
                const requestedEnableRemoteDebugging = body && Object.prototype.hasOwnProperty.call(body, 'enableRemoteDebugging') ? body.enableRemoteDebugging : undefined;
                const requestedRemoteDebuggingAddress = body && body.remoteDebuggingAddress ? body.remoteDebuggingAddress : undefined;

                let mutatedProfiles = false;
                if (requestedDebugPort === 0 || requestedDebugPort === 'auto') {
                    profile.debugPort = await getPort();
                    mutatedProfiles = true;
                } else if (typeof requestedDebugPort === 'number' && Number.isFinite(requestedDebugPort)) {
                    profile.debugPort = requestedDebugPort;
                    mutatedProfiles = true;
                }

                // 保存远程调试绑定地址到 profile（供启动时读取）
                if (requestedRemoteDebuggingAddress) {
                    profile.remoteDebuggingAddress = requestedRemoteDebuggingAddress;
                    mutatedProfiles = true;
                }

                if (mutatedProfiles) {
                    profiles[idx] = profile;
                    await fs.writeJson(PROFILES_FILE, profiles);
                }

                if (requestedEnableRemoteDebugging !== undefined || profile.debugPort) {
                    const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : {};
                    if (requestedEnableRemoteDebugging !== undefined) settings.enableRemoteDebugging = !!requestedEnableRemoteDebugging;
                    else settings.enableRemoteDebugging = true;
                    await fs.writeJson(SETTINGS_FILE, settings);
                }

                const message = await launchProfileCore(null, profileId, body ? body.watermarkStyle : undefined);
                const proc = activeProcesses[profileId];
                const wsEndpoint = proc ? proc.wsEndpoint || null : null;
                return sendJson(res, 200, {
                    ok: true,
                    profileId,
                    message: message || null,
                    debugPort: profile.debugPort || null,
                    wsEndpoint
                });
            }

            const stopMatch = url.pathname.match(/^\/profiles\/([0-9a-fA-F-]{36})\/stop$/);
            if (req.method === 'POST' && stopMatch) {
                const profileId = stopMatch[1];
                const proc = activeProcesses[profileId];
                if (!proc) {
                    return sendJson(res, 200, { ok: true, profileId, message: 'Not running' });
                }
                try {
                    // Puppeteer 已断开，使用进程管理关闭浏览器
                    if (proc.chromeProcess && !proc.chromeProcess.killed) {
                        proc.chromeProcess.kill();
                    } else if (proc.chromePid) {
                        await forceKill(proc.chromePid);
                    }
                    // 清理 xray 进程
                    await forceKill(proc.xrayPid);
                    // 关闭日志文件描述符
                    if (proc.logFd !== undefined) {
                        try { fs.closeSync(proc.logFd); } catch (e) { }
                    }
                    delete activeProcesses[profileId];
                    return sendJson(res, 200, { ok: true, profileId, message: 'Stopped' });
                } catch (err) {
                    return sendJson(res, 500, { ok: false, error: err.message || 'Failed to stop' });
                }
            }

            return sendJson(res, 404, { ok: false, error: 'Not found' });
        } catch (err) {
            return sendJson(res, 500, { ok: false, error: err && err.message ? err.message : 'Internal error' });
        }
    });

    controlServer.on('error', (err) => {
        console.error('[Control] Server error:', err && err.message ? err.message : err);
    });

    controlServer.listen(cfg.port, cfg.host, () => {
        console.log(`[Control] Listening on http://${cfg.host}:${cfg.port}`);
    });
}

// ============================================================================
// IP Geolocation Detection (通过代理检测 IP 位置信息)
// ============================================================================
const COUNTRY_LANGUAGE_MAP = {
    'CN': 'zh-CN', 'TW': 'zh-TW', 'HK': 'zh-HK', 'JP': 'ja', 'KR': 'ko',
    'US': 'en-US', 'GB': 'en-GB', 'AU': 'en-AU', 'CA': 'en-CA',
    'DE': 'de', 'FR': 'fr', 'ES': 'es', 'IT': 'it', 'PT': 'pt',
    'RU': 'ru', 'BR': 'pt-BR', 'MX': 'es-MX', 'AR': 'es-AR',
    'IN': 'hi', 'TH': 'th', 'VN': 'vi', 'ID': 'id', 'MY': 'ms',
    'PH': 'en-PH', 'SG': 'en-SG', 'NL': 'nl', 'PL': 'pl', 'TR': 'tr',
    'SA': 'ar', 'AE': 'ar', 'IL': 'he', 'SE': 'sv', 'NO': 'nb', 'DK': 'da', 'FI': 'fi'
};

async function detectIpInfo(proxyStr) {
    if (!proxyStr) return null;
    
    const tempPort = await getPort();
    const tempConfigPath = path.join(app.getPath('userData'), `ip_detect_${tempPort}.json`);
    
    try {
        const { parseProxyLink } = require('./utils');
        let outbound;
        try {
            outbound = parseProxyLink(proxyStr, "ip_detect");
        } catch (err) {
            console.log('[IP Detect] Failed to parse proxy:', err.message);
            return null;
        }
        
        const config = {
            log: { loglevel: "none" },
            inbounds: [{ port: tempPort, listen: "127.0.0.1", protocol: "socks", settings: { udp: true } }],
            outbounds: [outbound, { protocol: "freedom", tag: "direct" }],
            routing: { rules: [{ type: "field", outboundTag: "ip_detect", port: "0-65535" }] }
        };
        
        await fs.writeJson(tempConfigPath, config);
        
        // 启动 xray
        const xrayBinPath = fs.existsSync(BIN_PATH) ? BIN_PATH : BIN_PATH_LEGACY;
        const xrayBinDir = fs.existsSync(BIN_PATH) ? BIN_DIR : BIN_DIR_LEGACY;
        const xrayProcess = spawn(xrayBinPath, ['-c', tempConfigPath], {
            cwd: xrayBinDir,
            env: { ...process.env, 'XRAY_LOCATION_ASSET': RESOURCES_BIN },
            stdio: 'ignore',
            windowsHide: true
        });
        
        await new Promise(r => setTimeout(r, 800));
        
        const agent = new SocksProxyAgent(`socks5://127.0.0.1:${tempPort}`);
        
        const result = await new Promise((resolve) => {
            const req = http.get('http://ip-api.com/json/?fields=status,country,countryCode,city,lat,lon,timezone', {
                agent,
                timeout: 8000
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.status === 'success') {
                            resolve({
                                country: json.country,
                                countryCode: json.countryCode,
                                city: json.city,
                                lat: json.lat,
                                lon: json.lon,
                                timezone: json.timezone,
                                language: COUNTRY_LANGUAGE_MAP[json.countryCode] || 'en-US'
                            });
                        } else {
                            resolve(null);
                        }
                    } catch (e) {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
        });
        
        await forceKill(xrayProcess.pid);
        try { fs.unlinkSync(tempConfigPath); } catch (e) { }
        
        if (result) {
            console.log(`[IP Detect] Success: ${result.city}, ${result.country} (${result.timezone})`);
        }
        return result;
        
    } catch (err) {
        console.error('[IP Detect] Error:', err.message);
        try { fs.unlinkSync(tempConfigPath); } catch (e) { }
        return null;
    }
}

// Settings management
function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
    return { enableRemoteDebugging: false };
}

function saveSettings(settings) {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
        return true;
    } catch (e) {
        console.error('Failed to save settings:', e);
        return false;
    }
}

function createWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const win = new BrowserWindow({
        width: Math.round(width * 0.5), height: Math.round(height * 0.601), minWidth: 900, minHeight: 600,
        title: "GeekEZ Browser", backgroundColor: '#1e1e2d',
        icon: path.join(__dirname, 'icon.png'),
        titleBarOverlay: { color: '#1e1e2d', symbolColor: '#ffffff', height: 35 },
        titleBarStyle: 'hidden',
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false }
    });
    win.setMenuBarVisibility(false);
    win.loadFile('index.html');
    mainWindow = win; // Store global reference for API
    return win;
}

// Helper to notify UI to refresh profiles
function notifyUIRefresh() {
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('refresh-profiles');
    }
}

async function autoStartApiServerFromSettings() {
    // API Server is normally started via renderer setting toggle. Automation expects
    // it to be available whenever enableApiServer=true.
    if (apiServerRunning) return;
    try {
        const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : {};
        if (!settings.enableApiServer) return;

        const port = settings.apiPort || 12138;
        apiServer = createApiServer(port);
        await new Promise((resolve, reject) => {
            apiServer.listen(port, '127.0.0.1', () => resolve());
            apiServer.on('error', reject);
        });
        apiServerRunning = true;
        console.log(`[API] Server auto-started on http://localhost:${port}`);
    } catch (err) {
        try {
            console.warn('Failed to auto-start API Server:', err && err.message ? err.message : err);
        } catch (_) { }
    }
}

async function generateExtension(profilePath, fingerprint, profileName, watermarkStyle) {
    const extDir = path.join(profilePath, 'extension');
    await fs.ensureDir(extDir);
    const manifest = {
        manifest_version: 3,
        name: "GeekEZ Guard",
        version: "1.0.0",
        description: "Privacy Protection",
        content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"], run_at: "document_start", all_frames: true, world: "MAIN" }]
    };
    const style = watermarkStyle || 'enhanced'; // 默认使用增强水印
    const scriptContent = getInjectScript(fingerprint, profileName, style);
    await fs.writeJson(path.join(extDir, 'manifest.json'), manifest);
    await fs.writeFile(path.join(extDir, 'content.js'), scriptContent);
    return extDir;
}

app.whenReady().then(async () => {
    createWindow();
    await startControlServer();
    await autoStartApiServerFromSettings();
    setTimeout(() => { fs.emptyDir(TRASH_PATH).catch(() => { }); }, 10000);
});

// IPC Handles
ipcMain.handle('get-app-info', () => { return { name: app.getName(), version: app.getVersion() }; });
ipcMain.handle('fetch-url', async (e, url) => { try { const res = await fetch(url); if (!res.ok) throw new Error('HTTP ' + res.status); return await res.text(); } catch (e) { throw e.message; } });
ipcMain.handle('test-proxy-latency', async (e, proxyStr) => {
    const tempPort = await getPort(); const tempConfigPath = path.join(app.getPath('userData'), `test_config_${tempPort}.json`);
    try {
        let outbound; try { const { parseProxyLink } = require('./utils'); outbound = parseProxyLink(proxyStr, "proxy_test"); } catch (err) { return { success: false, msg: "Format Err" }; }
        const config = { log: { loglevel: "none" }, inbounds: [{ port: tempPort, listen: "127.0.0.1", protocol: "socks", settings: { udp: true } }], outbounds: [outbound, { protocol: "freedom", tag: "direct" }], routing: { rules: [{ type: "field", outboundTag: "proxy_test", port: "0-65535" }] } };
        await fs.writeJson(tempConfigPath, config);
        const xrayProcess = spawn(BIN_PATH, ['-c', tempConfigPath], { cwd: BIN_DIR, env: { ...process.env, 'XRAY_LOCATION_ASSET': RESOURCES_BIN }, stdio: 'ignore', windowsHide: true });
        await new Promise(r => setTimeout(r, 800));
        const start = Date.now(); const agent = new SocksProxyAgent(`socks5://127.0.0.1:${tempPort}`);
        const result = await new Promise((resolve) => {
            const req = http.get('http://cp.cloudflare.com/generate_204', { agent, timeout: 5000 }, (res) => {
                const latency = Date.now() - start; if (res.statusCode === 204) resolve({ success: true, latency }); else resolve({ success: false, msg: `HTTP ${res.statusCode}` });
            });
            req.on('error', () => resolve({ success: false, msg: "Err" })); req.on('timeout', () => { req.destroy(); resolve({ success: false, msg: "Timeout" }); });
        });
        await forceKill(xrayProcess.pid); try { fs.unlinkSync(tempConfigPath); } catch (e) { } return result;
    } catch (err) { return { success: false, msg: err.message }; }
});
ipcMain.handle('set-title-bar-color', (e, colors) => { const win = BrowserWindow.fromWebContents(e.sender); if (win) { if (process.platform === 'win32') try { win.setTitleBarOverlay({ color: colors.bg, symbolColor: colors.symbol }); } catch (e) { } win.setBackgroundColor(colors.bg); } });
ipcMain.handle('check-app-update', async () => { try { const data = await fetchJson('https://api.github.com/repos/EchoHS/GeekezBrowser/releases/latest'); if (!data || !data.tag_name) return { update: false }; const remote = data.tag_name.replace('v', ''); if (compareVersions(remote, app.getVersion()) > 0) { return { update: true, remote, url: 'https://browser.geekez.net/#downloads' }; } return { update: false }; } catch (e) { return { update: false, error: e.message }; } });
ipcMain.handle('check-xray-update', async () => { try { const data = await fetchJson('https://api.github.com/repos/XTLS/Xray-core/releases/latest'); if (!data || !data.tag_name) return { update: false }; const remoteVer = data.tag_name; const currentVer = await getLocalXrayVersion(); if (remoteVer !== currentVer) { let assetName = ''; const arch = os.arch(); const platform = os.platform(); if (platform === 'win32') assetName = `Xray-windows-${arch === 'x64' ? '64' : '32'}.zip`; else if (platform === 'darwin') assetName = `Xray-macos-${arch === 'arm64' ? 'arm64-v8a' : '64'}.zip`; else assetName = `Xray-linux-${arch === 'x64' ? '64' : '32'}.zip`; const downloadUrl = `https://gh-proxy.com/https://github.com/XTLS/Xray-core/releases/download/${remoteVer}/${assetName}`; return { update: true, remote: remoteVer.replace(/^v/, ''), downloadUrl }; } return { update: false }; } catch (e) { return { update: false }; } });
ipcMain.handle('download-xray-update', async (e, url) => {
    const exeName = process.platform === 'win32' ? 'xray.exe' : 'xray';
    const tempBase = os.tmpdir();
    const updateId = `xray_update_${Date.now()}`;
    const tempDir = path.join(tempBase, updateId);
    const zipPath = path.join(tempDir, 'xray.zip');
    try {
        fs.mkdirSync(tempDir, { recursive: true });
        await downloadFile(url, zipPath);
        if (process.platform === 'win32') await new Promise((resolve) => exec('taskkill /F /IM xray.exe', () => resolve()));
        activeProcesses = {};
        await new Promise(r => setTimeout(r, 3000));
        const extractDir = path.join(tempDir, 'extracted');
        fs.mkdirSync(extractDir, { recursive: true });
        await extractZip(zipPath, extractDir);
        function findXrayBinary(dir) {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    const found = findXrayBinary(fullPath);
                    if (found) return found;
                } else if (file === exeName) {
                    return fullPath;
                }
            }
            return null;
        }
        const xrayBinary = findXrayBinary(extractDir);
        console.log('[Update Debug] Searched in:', extractDir);
        console.log('[Update Debug] Found binary:', xrayBinary);
        if (!xrayBinary) {
            // 列出所有文件帮助调试
            const allFiles = [];
            function listAllFiles(dir, prefix = '') {
                const files = fs.readdirSync(dir);
                files.forEach(file => {
                    const fullPath = path.join(dir, file);
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory()) {
                        allFiles.push(prefix + file + '/');
                        listAllFiles(fullPath, prefix + file + '/');
                    } else {
                        allFiles.push(prefix + file);
                    }
                });
            }
            listAllFiles(extractDir);
            console.log('[Update Debug] All extracted files:', allFiles);
            throw new Error('Xray binary not found in package');
        }

        // Windows文件锁规避：先重命名旧文件，再复制新文件
        const oldPath = BIN_PATH + '.old';
        if (fs.existsSync(BIN_PATH)) {
            try {
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
            } catch (e) { }
            fs.renameSync(BIN_PATH, oldPath);
        }
        fs.copyFileSync(xrayBinary, BIN_PATH);
        // 删除旧文件
        try {
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        } catch (e) { }
        if (process.platform !== 'win32') fs.chmodSync(BIN_PATH, '755');
        // 清理临时目录（即使失败也不影响更新）
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (cleanupErr) {
            console.warn('[Cleanup Warning] Failed to remove temp dir:', cleanupErr.message);
        }
        return true;
    } catch (e) {
        console.error('Xray update failed:', e);
        try {
            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (err) { }
        return false;
    }
});
ipcMain.handle('get-running-ids', () => Object.keys(activeProcesses));
ipcMain.handle('get-profiles', async () => { if (!fs.existsSync(PROFILES_FILE)) return []; return fs.readJson(PROFILES_FILE); });
ipcMain.handle('update-profile', async (event, updatedProfile) => { let profiles = await fs.readJson(PROFILES_FILE); const index = profiles.findIndex(p => p.id === updatedProfile.id); if (index > -1) { profiles[index] = updatedProfile; await fs.writeJson(PROFILES_FILE, profiles); return true; } return false; });
ipcMain.handle('save-profile', async (event, data) => {
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const fingerprint = data.fingerprint || generateFingerprint();

    // 自动检测 IP 位置信息（如果用户未手动设置 timezone/city/language）
    const needsAutoDetect = data.proxyStr && 
        (!data.timezone || data.timezone === 'Auto') && 
        (!data.city || data.city === 'Auto') && 
        (!data.language || data.language === 'auto');
    
    if (needsAutoDetect) {
        const ipInfo = await detectIpInfo(data.proxyStr);
        if (ipInfo) {
            fingerprint.timezone = ipInfo.timezone;
            fingerprint.city = ipInfo.city;
            fingerprint.language = ipInfo.language;
            fingerprint.geolocation = { latitude: ipInfo.lat, longitude: ipInfo.lon, accuracy: 100 };
            console.log(`[Auto Fingerprint] ${ipInfo.city}, ${ipInfo.country} | TZ: ${ipInfo.timezone} | Lang: ${ipInfo.language}`);
        } else {
            fingerprint.timezone = "America/Los_Angeles";
            fingerprint.language = "en-US";
        }
    } else {
        if (data.timezone && data.timezone !== 'Auto') fingerprint.timezone = data.timezone;
        else fingerprint.timezone = "America/Los_Angeles";
        if (data.city) fingerprint.city = data.city;
        if (data.geolocation) fingerprint.geolocation = data.geolocation;
        if (data.language && data.language !== 'auto') fingerprint.language = data.language;
    }

    const newProfile = {
        id: uuidv4(),
        name: data.name,
        proxyStr: data.proxyStr,
        tags: data.tags || [],
        fingerprint: fingerprint,
        preProxyOverride: 'default',
        isSetup: false,
        createdAt: Date.now()
    };
    profiles.push(newProfile);
    await fs.writeJson(PROFILES_FILE, profiles);
    return newProfile;
});
ipcMain.handle('delete-profile', async (event, id) => {
    // 关闭正在运行的进程
    if (activeProcesses[id]) {
        await forceKill(activeProcesses[id].xrayPid);
        // Puppeteer 已断开，使用进程管理关闭浏览器
        try {
            if (activeProcesses[id].chromeProcess && !activeProcesses[id].chromeProcess.killed) {
                activeProcesses[id].chromeProcess.kill();
            } else if (activeProcesses[id].chromePid) {
                await forceKill(activeProcesses[id].chromePid);
            }
        } catch (e) { }

        // 关闭日志文件描述符（Windows 必须）
        if (activeProcesses[id].logFd !== undefined) {
            try {
                fs.closeSync(activeProcesses[id].logFd);
                console.log('Closed log file descriptor');
            } catch (e) {
                console.error('Failed to close log fd:', e.message);
            }
        }

        delete activeProcesses[id];
        // Windows 需要更长的等待时间让文件释放
        await new Promise(r => setTimeout(r, 1000));
    }

    // 从 profiles.json 中删除
    let profiles = await fs.readJson(PROFILES_FILE);
    profiles = profiles.filter(p => p.id !== id);
    await fs.writeJson(PROFILES_FILE, profiles);

    // 永久删除 profile 文件夹（带重试机制）
    const profileDir = path.join(DATA_PATH, id);
    let deleted = false;

    // 尝试删除 3 次
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            if (fs.existsSync(profileDir)) {
                // 使用 fs-extra 的 remove，它会递归删除
                await fs.remove(profileDir);
                console.log(`Deleted profile folder: ${profileDir}`);
                deleted = true;
                break;
            } else {
                deleted = true;
                break;
            }
        } catch (err) {
            console.error(`Delete attempt ${attempt} failed:`, err.message);
            if (attempt < 3) {
                // 等待后重试
                await new Promise(r => setTimeout(r, 500 * attempt));
            }
        }
    }

    // 如果删除失败，移到回收站作为后备方案
    if (!deleted && fs.existsSync(profileDir)) {
        console.warn(`Failed to delete, moving to trash: ${profileDir}`);
        const trashDest = path.join(TRASH_PATH, `${id}_${Date.now()}`);
        try {
            await fs.move(profileDir, trashDest);
            console.log(`Moved to trash: ${trashDest}`);
        } catch (err) {
            console.error(`Failed to move to trash:`, err);
        }
    }

    return true;
});
ipcMain.handle('get-settings', async () => { if (fs.existsSync(SETTINGS_FILE)) return fs.readJson(SETTINGS_FILE); return { preProxies: [], mode: 'single', enablePreProxy: false, enableRemoteDebugging: false }; });
ipcMain.handle('save-settings', async (e, settings) => { await fs.writeJson(SETTINGS_FILE, settings); return true; });
ipcMain.handle('select-extension-folder', async () => {
    const { filePaths } = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Extension Folder'
    });
    return filePaths && filePaths.length > 0 ? filePaths[0] : null;
});
ipcMain.handle('add-user-extension', async (e, extPath) => {
    const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : {};
    if (!settings.userExtensions) settings.userExtensions = [];
    if (!settings.userExtensions.includes(extPath)) {
        settings.userExtensions.push(extPath);
        await fs.writeJson(SETTINGS_FILE, settings);
    }
    return true;
});
ipcMain.handle('remove-user-extension', async (e, extPath) => {
    if (!fs.existsSync(SETTINGS_FILE)) return true;
    const settings = await fs.readJson(SETTINGS_FILE);
    if (settings.userExtensions) {
        settings.userExtensions = settings.userExtensions.filter(p => p !== extPath);
        await fs.writeJson(SETTINGS_FILE, settings);
    }
    return true;
});
ipcMain.handle('get-user-extensions', async () => {
    if (!fs.existsSync(SETTINGS_FILE)) return [];
    const settings = await fs.readJson(SETTINGS_FILE);
    return settings.userExtensions || [];
});
ipcMain.handle('open-url', async (e, url) => { await shell.openExternal(url); });

// --- 自定义数据目录 ---
ipcMain.handle('get-data-path-info', async () => {
    return {
        currentPath: DATA_PATH,
        defaultPath: DEFAULT_DATA_PATH,
        isCustom: DATA_PATH !== DEFAULT_DATA_PATH
    };
});

ipcMain.handle('select-data-directory', async () => {
    const { filePaths } = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select Data Directory'
    });
    return filePaths && filePaths.length > 0 ? filePaths[0] : null;
});

ipcMain.handle('set-data-directory', async (e, { newPath, migrate }) => {
    try {
        // 验证路径
        if (!newPath) {
            return { success: false, error: 'Invalid path' };
        }

        // 确保目录存在
        await fs.ensureDir(newPath);

        // 检查是否有写入权限
        const testFile = path.join(newPath, '.geekez-test');
        try {
            await fs.writeFile(testFile, 'test');
            await fs.remove(testFile);
        } catch (e) {
            return { success: false, error: 'No write permission to selected directory' };
        }

        // 如果需要迁移数据
        if (migrate && DATA_PATH !== newPath) {
            const oldProfiles = path.join(DATA_PATH, 'profiles.json');
            const oldSettings = path.join(DATA_PATH, 'settings.json');

            // 迁移 profiles.json
            if (fs.existsSync(oldProfiles)) {
                await fs.copy(oldProfiles, path.join(newPath, 'profiles.json'));
            }
            // 迁移 settings.json
            if (fs.existsSync(oldSettings)) {
                await fs.copy(oldSettings, path.join(newPath, 'settings.json'));
            }

            // 迁移所有环境数据目录
            const profiles = fs.existsSync(oldProfiles) ? await fs.readJson(oldProfiles) : [];
            for (const profile of profiles) {
                const oldDir = path.join(DATA_PATH, profile.id);
                const newDir = path.join(newPath, profile.id);
                if (fs.existsSync(oldDir)) {
                    console.log(`Migrating profile ${profile.id}...`);
                    await fs.copy(oldDir, newDir);
                }
            }
        }

        // 保存新路径到配置
        await fs.writeJson(APP_CONFIG_FILE, { customDataPath: newPath });

        return { success: true, requiresRestart: true };
    } catch (err) {
        console.error('Failed to set data directory:', err);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('reset-data-directory', async () => {
    try {
        // 删除自定义配置
        if (fs.existsSync(APP_CONFIG_FILE)) {
            const config = await fs.readJson(APP_CONFIG_FILE);
            delete config.customDataPath;
            await fs.writeJson(APP_CONFIG_FILE, config);
        }
        return { success: true, requiresRestart: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// --- 导出/导入功能 (重构版) ---

// 辅助函数：清理 fingerprint 中的无用字段
function cleanFingerprint(fp) {
    if (!fp) return fp;
    const cleaned = { ...fp };
    delete cleaned.userAgent;
    delete cleaned.userAgentMetadata;
    delete cleaned.webgl;
    return cleaned;
}

// 加密辅助函数
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MAGIC_HEADER = Buffer.from('GKEZ'); // GeekEZ magic bytes

function deriveKey(password, salt) {
    return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');
}

function encryptData(data, password) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = deriveKey(password, salt);

    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // 格式: MAGIC(4) + VERSION(4) + SALT(16) + IV(12) + AUTH_TAG(16) + ENCRYPTED_DATA
    const version = Buffer.alloc(4);
    version.writeUInt32LE(1, 0); // Version 1

    return Buffer.concat([MAGIC_HEADER, version, salt, iv, authTag, encrypted]);
}

function decryptData(encryptedBuffer, password) {
    // 验证 magic header
    const magic = encryptedBuffer.slice(0, 4);
    if (!magic.equals(MAGIC_HEADER)) {
        throw new Error('Invalid backup file format');
    }

    let offset = 4;
    const version = encryptedBuffer.readUInt32LE(offset);
    offset += 4;

    if (version !== 1) {
        throw new Error(`Unsupported backup version: ${version}`);
    }

    const salt = encryptedBuffer.slice(offset, offset + SALT_LENGTH);
    offset += SALT_LENGTH;

    const iv = encryptedBuffer.slice(offset, offset + IV_LENGTH);
    offset += IV_LENGTH;

    const authTag = encryptedBuffer.slice(offset, offset + AUTH_TAG_LENGTH);
    offset += AUTH_TAG_LENGTH;

    const encrypted = encryptedBuffer.slice(offset);

    const key = deriveKey(password, salt);
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

// 获取用于选择器的环境列表
ipcMain.handle('get-export-profiles', async () => {
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    return profiles.map(p => ({ id: p.id, name: p.name, tags: p.tags || [] }));
});

// 导出选定环境 (精简版，不含浏览器数据)
ipcMain.handle('export-selected-data', async (e, { type, profileIds }) => {
    const allProfiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [] };

    // 过滤选中的环境
    const selectedProfiles = allProfiles
        .filter(p => profileIds.includes(p.id))
        .map(p => ({
            ...p,
            fingerprint: cleanFingerprint(p.fingerprint)
        }));

    let exportObj = {};

    if (type === 'all' || type === 'profiles') {
        exportObj.profiles = selectedProfiles;
    }
    if (type === 'all' || type === 'proxies') {
        exportObj.preProxies = settings.preProxies || [];
        exportObj.subscriptions = settings.subscriptions || [];
    }

    if (Object.keys(exportObj).length === 0) return { success: false, error: 'No data to export' };

    const typeNames = { all: 'profiles', profiles: 'profiles', proxies: 'proxies' };
    const { filePath } = await dialog.showSaveDialog({
        title: 'Export Data',
        defaultPath: `GeekEZ_Backup_${typeNames[type] || type}_${Date.now()}.yaml`,
        filters: [{ name: 'YAML', extensions: ['yml', 'yaml'] }]
    });

    if (filePath) {
        await fs.writeFile(filePath, yaml.dump(exportObj));
        return { success: true, count: selectedProfiles.length };
    }
    return { success: false, cancelled: true };
});

// 完整备份 (含浏览器数据，加密)
ipcMain.handle('export-full-backup', async (e, { profileIds, password }) => {
    try {
        const allProfiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
        const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [] };

        // 过滤选中的环境
        const selectedProfiles = allProfiles
            .filter(p => profileIds.includes(p.id))
            .map(p => ({
                ...p,
                fingerprint: cleanFingerprint(p.fingerprint)
            }));

        // 准备备份数据
        const backupData = {
            version: 1,
            createdAt: Date.now(),
            profiles: selectedProfiles,
            preProxies: settings.preProxies || [],
            subscriptions: settings.subscriptions || [],
            browserData: {}
        };

        // 收集浏览器数据
        // 浏览器数据存储在 DATA_PATH/<profileId>/browser_data/Default/
        for (const profile of selectedProfiles) {
            const profileDataDir = path.join(DATA_PATH, profile.id, 'browser_data');
            if (fs.existsSync(profileDataDir)) {
                const defaultDir = path.join(profileDataDir, 'Default');
                if (fs.existsSync(defaultDir)) {
                    const browserFiles = {};

                    // 收集关键浏览器数据文件
                    const filesToBackup = ['Bookmarks', 'Cookies', 'Login Data', 'Web Data', 'Preferences'];
                    for (const fileName of filesToBackup) {
                        const filePath = path.join(defaultDir, fileName);
                        if (fs.existsSync(filePath)) {
                            try {
                                const content = await fs.readFile(filePath);
                                browserFiles[fileName] = content.toString('base64');
                            } catch (err) {
                                console.error(`Failed to read ${fileName} for ${profile.id}:`, err.message);
                            }
                        }
                    }

                    // 收集 Local Storage
                    const localStorageDir = path.join(defaultDir, 'Local Storage', 'leveldb');
                    if (fs.existsSync(localStorageDir)) {
                        try {
                            const lsFiles = await fs.readdir(localStorageDir);
                            const localStorageData = {};
                            for (const lsFile of lsFiles) {
                                if (lsFile.endsWith('.ldb') || lsFile.endsWith('.log')) {
                                    const lsFilePath = path.join(localStorageDir, lsFile);
                                    const content = await fs.readFile(lsFilePath);
                                    localStorageData[lsFile] = content.toString('base64');
                                }
                            }
                            if (Object.keys(localStorageData).length > 0) {
                                browserFiles['LocalStorage'] = localStorageData;
                            }
                        } catch (err) {
                            console.error(`Failed to read LocalStorage for ${profile.id}:`, err.message);
                        }
                    }

                    if (Object.keys(browserFiles).length > 0) {
                        backupData.browserData[profile.id] = browserFiles;
                    }
                }
            }
        }

        // 压缩并加密
        const jsonData = JSON.stringify(backupData);
        const compressed = await gzip(Buffer.from(jsonData, 'utf8'));
        const encrypted = encryptData(compressed, password);

        const { filePath } = await dialog.showSaveDialog({
            title: 'Export Full Backup',
            defaultPath: `GeekEZ_FullBackup_${Date.now()}.geekez`,
            filters: [{ name: 'GeekEZ Backup', extensions: ['geekez'] }]
        });

        if (filePath) {
            await fs.writeFile(filePath, encrypted);
            return { success: true, count: selectedProfiles.length };
        }
        return { success: false, cancelled: true };
    } catch (err) {
        console.error('Full backup failed:', err);
        return { success: false, error: err.message };
    }
});

// 导入完整备份
ipcMain.handle('import-full-backup', async (e, { password }) => {
    try {
        const { filePaths } = await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [{ name: 'GeekEZ Backup', extensions: ['geekez'] }]
        });

        if (!filePaths || filePaths.length === 0) {
            return { success: false, cancelled: true };
        }

        const encrypted = await fs.readFile(filePaths[0]);
        const decrypted = decryptData(encrypted, password);
        const decompressed = await gunzip(decrypted);
        const backupData = JSON.parse(decompressed.toString('utf8'));

        if (backupData.version !== 1) {
            throw new Error(`Unsupported backup version: ${backupData.version}`);
        }

        // 还原 profiles
        const currentProfiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
        let importedCount = 0;

        for (const profile of backupData.profiles) {
            const idx = currentProfiles.findIndex(cp => cp.id === profile.id);
            if (idx > -1) {
                currentProfiles[idx] = profile;
            } else {
                currentProfiles.push(profile);
            }
            importedCount++;
        }
        await fs.writeJson(PROFILES_FILE, currentProfiles);

        // 还原代理和订阅
        const currentSettings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [] };
        if (backupData.preProxies) {
            if (!currentSettings.preProxies) currentSettings.preProxies = [];
            for (const p of backupData.preProxies) {
                if (!currentSettings.preProxies.find(cp => cp.id === p.id)) {
                    currentSettings.preProxies.push(p);
                }
            }
        }
        if (backupData.subscriptions) {
            if (!currentSettings.subscriptions) currentSettings.subscriptions = [];
            for (const s of backupData.subscriptions) {
                if (!currentSettings.subscriptions.find(cs => cs.id === s.id)) {
                    currentSettings.subscriptions.push(s);
                }
            }
        }
        await fs.writeJson(SETTINGS_FILE, currentSettings);

        // 还原浏览器数据
        // 浏览器数据存储在 DATA_PATH/<profileId>/browser_data/Default/
        for (const [profileId, browserFiles] of Object.entries(backupData.browserData || {})) {
            const profileDataDir = path.join(DATA_PATH, profileId, 'browser_data');
            const defaultDir = path.join(profileDataDir, 'Default');
            await fs.ensureDir(defaultDir);

            for (const [fileName, content] of Object.entries(browserFiles)) {
                if (fileName === 'LocalStorage') {
                    // 还原 Local Storage
                    const localStorageDir = path.join(defaultDir, 'Local Storage', 'leveldb');
                    await fs.ensureDir(localStorageDir);
                    for (const [lsFileName, lsContent] of Object.entries(content)) {
                        const lsFilePath = path.join(localStorageDir, lsFileName);
                        await fs.writeFile(lsFilePath, Buffer.from(lsContent, 'base64'));
                    }
                } else {
                    // 还原普通文件
                    const filePath = path.join(defaultDir, fileName);
                    await fs.writeFile(filePath, Buffer.from(content, 'base64'));
                }
            }
        }

        return { success: true, count: importedCount };
    } catch (err) {
        console.error('Import full backup failed:', err);
        if (err.message.includes('Unsupported state') || err.message.includes('bad decrypt')) {
            return { success: false, error: '密码错误或文件已损坏' };
        }
        return { success: false, error: err.message };
    }
});

// 导入普通备份 (YAML)
ipcMain.handle('import-data', async () => {
    const { filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'YAML', extensions: ['yml', 'yaml'] }]
    });

    if (filePaths && filePaths.length > 0) {
        try {
            const content = await fs.readFile(filePaths[0], 'utf8');
            const data = yaml.load(content);
            let updated = false;

            if (data.profiles || data.preProxies || data.subscriptions) {
                if (Array.isArray(data.profiles)) {
                    const currentProfiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
                    data.profiles.forEach(p => {
                        const idx = currentProfiles.findIndex(cp => cp.id === p.id);
                        if (idx > -1) currentProfiles[idx] = p;
                        else {
                            if (!p.id) p.id = uuidv4();
                            currentProfiles.push(p);
                        }
                    });
                    await fs.writeJson(PROFILES_FILE, currentProfiles);
                    updated = true;
                }
                if (Array.isArray(data.preProxies) || Array.isArray(data.subscriptions)) {
                    const currentSettings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [] };
                    if (data.preProxies) {
                        if (!currentSettings.preProxies) currentSettings.preProxies = [];
                        data.preProxies.forEach(p => {
                            if (!currentSettings.preProxies.find(cp => cp.id === p.id)) currentSettings.preProxies.push(p);
                        });
                    }
                    if (data.subscriptions) {
                        if (!currentSettings.subscriptions) currentSettings.subscriptions = [];
                        data.subscriptions.forEach(s => {
                            if (!currentSettings.subscriptions.find(cs => cs.id === s.id)) currentSettings.subscriptions.push(s);
                        });
                    }
                    await fs.writeJson(SETTINGS_FILE, currentSettings);
                    updated = true;
                }
            } else if (data.name && data.proxyStr && data.fingerprint) {
                // 单个环境导入
                const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
                const newProfile = { ...data, id: uuidv4(), isSetup: false, createdAt: Date.now() };
                profiles.push(newProfile);
                await fs.writeJson(PROFILES_FILE, profiles);
                updated = true;
            }
            return updated;
        } catch (e) {
            console.error(e);
            throw e;
        }
    }
    return false;
});

// 保留旧的 export-data 用于向后兼容 (deprecated)
ipcMain.handle('export-data', async (e, type) => {
    const profiles = fs.existsSync(PROFILES_FILE) ? await fs.readJson(PROFILES_FILE) : [];
    const settings = fs.existsSync(SETTINGS_FILE) ? await fs.readJson(SETTINGS_FILE) : { preProxies: [], subscriptions: [] };

    // 清理 fingerprint
    const cleanedProfiles = profiles.map(p => ({
        ...p,
        fingerprint: cleanFingerprint(p.fingerprint)
    }));

    let exportObj = {};
    if (type === 'all' || type === 'profiles') exportObj.profiles = cleanedProfiles;
    if (type === 'all' || type === 'proxies') {
        exportObj.preProxies = settings.preProxies || [];
        exportObj.subscriptions = settings.subscriptions || [];
    }
    if (Object.keys(exportObj).length === 0) return false;

    const { filePath } = await dialog.showSaveDialog({
        title: 'Export Data',
        defaultPath: `GeekEZ_Backup_${type}_${Date.now()}.yaml`,
        filters: [{ name: 'YAML', extensions: ['yml', 'yaml'] }]
    });
    if (filePath) {
        await fs.writeFile(filePath, yaml.dump(exportObj));
        return true;
    }
    return false;
});

async function launchProfileCore(sender, profileId, watermarkStyle) {

    if (activeProcesses[profileId]) {
        const proc = activeProcesses[profileId];
        // 检查 Chrome 进程是否仍然存活（Puppeteer 已断开，不能用 browser.isConnected()）
        let isAlive = false;
        if (proc.chromeProcess && !proc.chromeProcess.killed) {
            try {
                // process.kill(pid, 0) 不发送信号，仅检查进程是否存在
                process.kill(proc.chromeProcess.pid, 0);
                isAlive = true;
            } catch (e) {
                isAlive = false;
            }
        }

        if (isAlive) {
            // 浏览器仍在运行，提示用户手动切换窗口
            // 注：由于 CDP 已断开，无法通过 CDP 命令聚焦窗口
            return "环境已在运行中";
        } else {
            // 进程已退出但未清理，做清理
            await forceKill(proc.xrayPid);
            if (proc.logFd !== undefined) {
                try { fs.closeSync(proc.logFd); } catch (e) { }
            }
            delete activeProcesses[profileId];
        }
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    // Load settings early for userExtensions and remote debugging
    const settings = await fs.readJson(SETTINGS_FILE).catch(() => ({
        enableRemoteDebugging: false,
        userExtensions: [],
        preProxies: [],
        mode: 'single',
        enablePreProxy: false
    }));

    const profiles = await fs.readJson(PROFILES_FILE);
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) throw new Error('Profile not found');

    if (!profile.fingerprint) profile.fingerprint = generateFingerprint();
    if (!profile.fingerprint.languages) profile.fingerprint.languages = ['en-US', 'en'];

    // Pre-proxy settings (settings already loaded above)
    const override = profile.preProxyOverride || 'default';
    const shouldUsePreProxy = override === 'on' || (override === 'default' && settings.enablePreProxy);
    let finalPreProxyConfig = null;
    let switchMsg = null;
    if (shouldUsePreProxy && settings.preProxies && settings.preProxies.length > 0) {
        const active = settings.preProxies.filter(p => p.enable !== false);
        if (active.length > 0) {
            if (settings.mode === 'single') { const target = active.find(p => p.id === settings.selectedId) || active[0]; finalPreProxyConfig = { preProxies: [target] }; }
            else if (settings.mode === 'balance') { const target = active[Math.floor(Math.random() * active.length)]; finalPreProxyConfig = { preProxies: [target] }; if (settings.notify) switchMsg = `Balance: [${target.remark}]`; }
            else if (settings.mode === 'failover') { const target = active[0]; finalPreProxyConfig = { preProxies: [target] }; if (settings.notify) switchMsg = `Failover: [${target.remark}]`; }
        }
    }

    try {
        const localPort = await getPort();
        const profileDir = path.join(DATA_PATH, profileId);
        const userDataDir = path.join(profileDir, 'browser_data');
        const xrayConfigPath = path.join(profileDir, 'config.json');
        const xrayLogPath = path.join(profileDir, 'xray_run.log');
        fs.ensureDirSync(userDataDir);

        try {
            const defaultProfileDir = path.join(userDataDir, 'Default');
            fs.ensureDirSync(defaultProfileDir);
            const preferencesPath = path.join(defaultProfileDir, 'Preferences');
            let preferences = {};
            if (fs.existsSync(preferencesPath)) preferences = await fs.readJson(preferencesPath);
            if (!preferences.bookmark_bar) preferences.bookmark_bar = {};
            preferences.bookmark_bar.show_on_all_tabs = true;
            if (preferences.protection) delete preferences.protection;
            if (!preferences.profile) preferences.profile = {};
            preferences.profile.name = profile.name;
            if (!preferences.webrtc) preferences.webrtc = {};
            preferences.webrtc.ip_handling_policy = 'disable_non_proxied_udp';
            await fs.writeJson(preferencesPath, preferences);
        } catch (e) { }

        const config = generateXrayConfig(profile.proxyStr, localPort, finalPreProxyConfig);
        fs.writeJsonSync(xrayConfigPath, config);
        const logFd = fs.openSync(xrayLogPath, 'a');
        const xrayProcess = spawn(BIN_PATH, ['-c', xrayConfigPath], { cwd: BIN_DIR, env: { ...process.env, 'XRAY_LOCATION_ASSET': RESOURCES_BIN }, stdio: ['ignore', logFd, logFd], windowsHide: true });

        // 优化：减少等待时间，Xray 通常 300ms 内就能启动
        await new Promise(resolve => setTimeout(resolve, 300));

        // 0. Resolve Language (Fix: Resolve 'auto' BEFORE generating extension so inject script gets explicit language)
        const targetLang = profile.fingerprint?.language && profile.fingerprint.language !== 'auto'
            ? profile.fingerprint.language
            : 'en-US';

        // Update in-memory profile to ensure generateExtension writes the correct language to inject script
        profile.fingerprint.language = targetLang;
        profile.fingerprint.languages = [targetLang, targetLang.split('-')[0]];

        // 1. 生成 GeekEZ Guard 扩展（使用传递的水印样式）
        const style = watermarkStyle || 'enhanced'; // 默认使用增强水印
        const extPath = await generateExtension(profileDir, profile.fingerprint, profile.name, style);
        // 注：getInjectScript 不再需要单独调用，扩展已包含完整注入脚本
        // 原来的 injectScript 变量用于 CDP evaluateOnNewDocument，现已移除

        // 2. 获取用户自定义扩展
        const userExts = settings.userExtensions || [];

        // 3. 合并所有扩展路径
        let extPaths = extPath; // GeekEZ Guard
        if (userExts.length > 0) {
            extPaths += ',' + userExts.join(',');
        }
        try {
            const manifestPath = path.join(extPath, 'manifest.json');
            if (!fs.existsSync(manifestPath)) {
                console.warn('[Extension] manifest missing:', manifestPath);
            } else {
                console.log('[Extension] Loaded:', extPaths);
            }
        } catch (e) {
            console.warn('[Extension] check failed:', e && e.message ? e.message : e);
        }

        // 4. 构建启动参数
        // ====================================================================
        // 原则：尽可能模拟真实用户的 Chrome 启动方式
        // 移除所有会被 Stripe/Cloudflare 检测为自动化的参数
        //
        // 已移除的自动化指标:
        //   --no-sandbox              → Windows 不需要，是 CI/Docker 才用的
        //   --disable-infobars        → 经典自动化标志，Stripe 重点检测
        //   --disable-dev-shm-usage   → Docker/CI 专用
        //   --disable-features=IsolateOrigins,site-per-process → 安全降级
        //   --disable-background-timer-throttling → 正常浏览器不会加
        //   --disable-backgrounding-occluded-windows → 同上
        //   --disable-renderer-backgrounding → 同上
        //   --disk-cache-size / --media-cache-size → 非标准配置
        //   --class=GeekezBrowser-xxx → 直接暴露身份
        // ====================================================================

        const launchArgs = [
            // === 核心功能（必需）===
            `--proxy-server=socks5://127.0.0.1:${localPort}`,
            `--user-data-dir=${userDataDir}`,
            `--window-size=${profile.fingerprint?.window?.width || 1280},${profile.fingerprint?.window?.height || 800}`,
            '--restore-last-session',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',  // 防止 WebRTC 泄漏真实 IP

            // === 反自动化检测（关键）===
            // webdriver 覆盖由注入脚本处理，避免使用不兼容的命令行参数。

            // === 语言 ===
            `--lang=${targetLang}`,
            `--accept-lang=${targetLang}`,

            // === 扩展加载 ===
            `--disable-extensions-except=${extPaths}`,
            `--load-extension=${extPaths}`,

            // === 普通用户也会有的参数 ===
            '--no-first-run',
            '--no-default-browser-check',
        ];

        // Linux 专用沙箱参数（Windows/macOS 不需要）
        if (process.platform === 'linux') {
            launchArgs.push('--no-sandbox');
            launchArgs.push('--disable-setuid-sandbox');
        }

        // 5. Remote Debugging Port (if enabled)
        if (settings.enableRemoteDebugging && profile.debugPort) {
            launchArgs.push(`--remote-debugging-port=${profile.debugPort}`);
            // 支持远程调试地址绑定（默认 127.0.0.1，设为 0.0.0.0 可让 Docker 容器访问）
            const debugAddr = profile.remoteDebuggingAddress || '127.0.0.1';
            if (debugAddr !== '127.0.0.1') {
                launchArgs.push(`--remote-debugging-address=${debugAddr}`);
            }
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('⚠️  REMOTE DEBUGGING ENABLED');
            console.log(`📡 Port: ${profile.debugPort}, Address: ${debugAddr}`);
            console.log(`🔗 Connect: chrome://inspect or ws://${debugAddr}:${profile.debugPort}`);
            console.log('⚠️  WARNING: May increase automation detection risk!');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        }

        // 6. Custom Launch Arguments (if enabled)
        if (settings.enableCustomArgs && profile.customArgs) {
            const customArgsList = profile.customArgs
                .split(/[\n\s]+/)
                .map(arg => arg.trim())
                .filter(arg => arg && arg.startsWith('--'));

            if (customArgsList.length > 0) {
                launchArgs.push(...customArgsList);
                console.log('⚡ Custom Args:', customArgsList.join(' '));
            }
        }

        // 5. 启动浏览器
        const chromePath = getChromiumPath();
        if (!chromePath) {
            await forceKill(xrayProcess.pid);
            throw new Error(`Chrome binary not found (platform: ${process.platform}). Set PUPPETEER_EXECUTABLE_PATH or put Chrome under resources/puppeteer.`);
        }

        // 时区设置
        const env = { ...process.env };
        if (profile.fingerprint?.timezone && profile.fingerprint.timezone !== 'Auto') {
            env.TZ = profile.fingerprint.timezone;
        }

        const browser = await puppeteer.launch({
            headless: false,
            executablePath: chromePath,
            userDataDir: userDataDir,
            args: launchArgs,
            defaultViewport: null,
            // 忽略 Puppeteer 所有默认参数 —— 这些参数是自动化特征，
            // 会被 Stripe/Cloudflare 等风控系统识别为非真实浏览器。
            // 所有需要的参数已在 launchArgs 中显式指定。
            ignoreDefaultArgs: true,
            // 使用 pipe 模式而非 WebSocket：
            // pipe=false → Puppeteer 添加 --remote-debugging-port=0 → 调试端口暴露
            // pipe=true  → 通过 stdin/stdout 管道通信 → 不开放任何网络端口
            pipe: true,
            dumpio: false,
            env: env  // 注入环境变量
        });

        // ====================================================================
        // 不再通过 CDP 注入脚本！
        // 原来的 evaluateOnNewDocument / setBypassCSP / targetcreated 监听
        // 全部移除。指纹注入完全由 Chrome Extension (content_scripts,
        // world: MAIN, all_frames: true, run_at: document_start) 负责。
        //
        // CDP 注入的问题：
        //  1. Page.addScriptToEvaluateOnNewDocument 会留下可检测的绑定
        //  2. Page.setBypassCSP 修改 CSP 状态，可被 Stripe/CF 检测
        //  3. 活跃的 CDP 会话本身就是自动化痕迹
        // ====================================================================

        // 获取 Chrome 进程句柄（在断开 Puppeteer 之前）
        const chromeProcess = browser.process();
        const chromePid = chromeProcess ? chromeProcess.pid : null;
        // pipe 模式下 wsEndpoint 不可用，但外部自动化可通过 Remote Debugging Port 连接
        let savedWsEndpoint = null;
        try { savedWsEndpoint = browser.wsEndpoint(); } catch (e) { /* pipe mode: no ws */ }

        activeProcesses[profileId] = {
            xrayPid: xrayProcess.pid,
            chromeProcess: chromeProcess,
            chromePid: chromePid,
            wsEndpoint: savedWsEndpoint,
            logFd: logFd  // 存储日志文件描述符，用于后续关闭
        };
        if (sender && !sender.isDestroyed()) sender.send('profile-status', { id: profileId, status: 'running' });

        // 监控 Chrome 进程退出 → 清理 xray + 日志资源
        // 替代原来的 browser.on('disconnected')，因为我们会主动断开 Puppeteer
        if (chromeProcess) {
            chromeProcess.on('exit', async () => {
                if (!activeProcesses[profileId]) return;
                const proc = activeProcesses[profileId];

                // 关闭日志文件描述符
                if (proc.logFd !== undefined) {
                    try { fs.closeSync(proc.logFd); } catch (e) { }
                }

                delete activeProcesses[profileId];
                await forceKill(proc.xrayPid);

                // 性能优化：清理缓存文件，节省磁盘空间
                try {
                    const cacheDir = path.join(userDataDir, 'Default', 'Cache');
                    const codeCacheDir = path.join(userDataDir, 'Default', 'Code Cache');
                    if (fs.existsSync(cacheDir)) await fs.emptyDir(cacheDir);
                    if (fs.existsSync(codeCacheDir)) await fs.emptyDir(codeCacheDir);
                } catch (e) {
                    // 忽略清理错误
                }

                if (sender && !sender.isDestroyed()) sender.send('profile-status', { id: profileId, status: 'stopped' });
            });
        }

        // ====================================================================
        // 关键：断开 Puppeteer 的 CDP 连接
        // disconnect() 只断开 WebSocket，Chrome 浏览器继续正常运行。
        // 这会消除所有 CDP 自动化痕迹（cdc_ 变量、Runtime bindings 等），
        // 使浏览器在 Stripe/Cloudflare 检测中表现得与普通浏览器一致。
        // ====================================================================
        console.log(`[Anti-Detect] Disconnecting Puppeteer CDP for profile ${profileId.slice(0, 8)}...`);
        browser.disconnect();
        console.log(`[Anti-Detect] CDP disconnected. Browser running as native Chrome.`);

        return switchMsg;
    } catch (err) {
        console.error(err);
        throw err;
    }
}

ipcMain.handle('launch-profile', async (event, profileId, watermarkStyle) => {
    return launchProfileCore(event.sender, profileId, watermarkStyle);
});

app.on('window-all-closed', () => {
    Object.values(activeProcesses).forEach(p => {
        forceKill(p.xrayPid);
        // 清理 Chrome 进程
        if (p.chromeProcess && !p.chromeProcess.killed) {
            try { p.chromeProcess.kill(); } catch (e) { }
        } else if (p.chromePid) {
            forceKill(p.chromePid);
        }
    });
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    if (controlServer) {
        try {
            controlServer.close();
        } catch (e) { }
        controlServer = null;
    }
});
// Helpers (Same)
function fetchJson(url) { return new Promise((resolve, reject) => { const req = https.get(url, { headers: { 'User-Agent': 'GeekEZ-Browser' } }, (res) => { let data = ''; res.on('data', c => data += c); res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } }); }); req.on('error', reject); }); }
function getLocalXrayVersion() { return new Promise((resolve) => { if (!fs.existsSync(BIN_PATH)) return resolve('v0.0.0'); try { const proc = spawn(BIN_PATH, ['-version']); let output = ''; proc.stdout.on('data', d => output += d.toString()); proc.on('close', () => { const match = output.match(/Xray\s+v?(\d+\.\d+\.\d+)/i); resolve(match ? (match[1].startsWith('v') ? match[1] : 'v' + match[1]) : 'v0.0.0'); }); proc.on('error', () => resolve('v0.0.0')); } catch (e) { resolve('v0.0.0'); } }); }
function compareVersions(v1, v2) { const p1 = v1.split('.').map(Number); const p2 = v2.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((p1[i] || 0) > (p2[i] || 0)) return 1; if ((p1[i] || 0) < (p2[i] || 0)) return -1; } return 0; }
function downloadFile(url, dest) { return new Promise((resolve, reject) => { const file = fs.createWriteStream(dest); https.get(url, (response) => { if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) { downloadFile(response.headers.location, dest).then(resolve).catch(reject); return; } response.pipe(file); file.on('finish', () => file.close(resolve)); }).on('error', (err) => { fs.unlink(dest, () => { }); reject(err); }); }); }
function extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        if (os.platform() === 'win32') {
            // Windows: 使用 adm-zip（可靠）
            try {
                const AdmZip = require('adm-zip');
                const zip = new AdmZip(zipPath);
                zip.extractAllTo(destDir, true);
                console.log('[Extract Success] Extracted to:', destDir);
                resolve();
            } catch (err) {
                console.error('[Extract Error]', err);
                reject(err);
            }
        } else {
            // macOS/Linux: 使用原生 unzip 命令
            exec(`unzip -o "${zipPath}" -d "${destDir}"`, (err, stdout, stderr) => {
                if (err) {
                    console.error('[Extract Error]', err);
                    console.error('[Extract stderr]', stderr);
                    reject(err);
                } else {
                    console.log('[Extract Success]', stdout);
                    resolve();
                }
            });
        }
    });
}
