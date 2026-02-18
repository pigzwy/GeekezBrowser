const os = require('os');

const RESOLUTIONS = [{ w: 1920, h: 1080 }, { w: 2560, h: 1440 }, { w: 1366, h: 768 }, { w: 1536, h: 864 }, { w: 1440, h: 900 }];

function getRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateFingerprint() {
    // 1. 强制匹配宿主机系统和架构
    const platform = os.platform();
    const arch = os.arch(); // 'arm64' for Apple Silicon, 'x64' for Intel

    let osData = {};

    if (platform === 'win32') {
        osData = { platform: 'Win32' };
    } else if (platform === 'darwin') {
        // Apple Silicon (M1/M2/M3/M4) vs Intel Mac
        // Note: Chrome on ARM Mac still reports 'MacIntel' for compatibility
        // but we need to not fake other signals that would reveal ARM
        osData = { platform: 'MacIntel', isArm: arch === 'arm64' };
    } else {
        osData = { platform: 'Linux x86_64' };
    }

    const res = getRandom(RESOLUTIONS);
    const languages = ['en-US', 'en'];

    const canvasNoise = {
        r: Math.floor(Math.random() * 10) - 5,
        g: Math.floor(Math.random() * 10) - 5,
        b: Math.floor(Math.random() * 10) - 5,
        a: Math.floor(Math.random() * 10) - 5
    };

    return {
        platform: osData.platform,
        screen: { width: res.w, height: res.h },
        window: { width: res.w, height: res.h },
        languages: languages,
        hardwareConcurrency: [4, 8, 12, 16][Math.floor(Math.random() * 4)],
        deviceMemory: [2, 4, 8][Math.floor(Math.random() * 3)],
        canvasNoise: canvasNoise,
        audioNoise: Math.random() * 0.000001,
        noiseSeed: Math.floor(Math.random() * 9999999),
        timezone: "America/Los_Angeles" // 默认值
    };
}

// 注入脚本：包含复杂的时区伪装逻辑
function getInjectScript(fp, profileName, watermarkStyle) {
    const fpJson = JSON.stringify(fp);
    const safeProfileName = (profileName || 'Profile').replace(/[<>"'&]/g, ''); // 防止 XSS
    const style = watermarkStyle || 'enhanced'; // 默认使用增强水印
    return `
    (function() {
        // 使用 Symbol 作为注入标记，避免在 window 上暴露可检测的命名属性
        const _injKey = Symbol.for('__fp_guard__');
        if (window[_injKey]) return;
        Object.defineProperty(window, _injKey, { value: true, enumerable: false, configurable: false });
        try {
            const fp = ${fpJson};
            const targetTimezone = fp.timezone || "America/Los_Angeles";

            // --- Global Helper: makeNative ---
            // Makes hooked functions appear as native code to avoid detection
            const makeNative = (func, name) => {
                const nativeStr = 'function ' + name + '() { [native code] }';
                Object.defineProperty(func, 'toString', {
                    value: function() { return nativeStr; },
                    configurable: true,
                    writable: true
                });
                Object.defineProperty(func.toString, 'toString', {
                    value: function() { return 'function toString() { [native code] }'; },
                    configurable: true,
                    writable: true
                });
                if (func.prototype) {
                    Object.defineProperty(func.prototype.constructor, 'toString', {
                        value: function() { return nativeStr; },
                        configurable: true,
                        writable: true
                    });
                }
                return func;
            };

            // --- 0. Stealth Timezone Hook (Windows Only) ---
            // On Windows, TZ env var doesn't work, so we use JS hooks
            // On macOS/Linux, TZ env var works natively, no JS hook needed (avoids detection)
            const isWindows = navigator.platform && navigator.platform.toLowerCase().includes('win');
            if (isWindows && fp.timezone && fp.timezone !== 'Auto') {
                // Helper to make functions appear native
                const tzMakeNative = (func, name) => {
                    const nativeStr = 'function ' + name + '() { [native code] }';
                    func.toString = function() { return nativeStr; };
                    func.toString.toString = function() { return 'function toString() { [native code] }'; };
                    return func;
                };

                // Calculate timezone offset from timezone name
                // This creates a date in the target timezone and compares to UTC
                const getTimezoneOffsetForZone = (tz) => {
                    try {
                        const now = new Date();
                        const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
                        const tzDate = new Date(now.toLocaleString('en-US', { timeZone: tz }));
                        return Math.round((utcDate - tzDate) / 60000);
                    } catch (e) {
                        return new Date().getTimezoneOffset(); // Fallback to system
                    }
                };

                const targetOffset = getTimezoneOffsetForZone(targetTimezone);

                // Hook 1: Date.prototype.getTimezoneOffset
                const origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
                Date.prototype.getTimezoneOffset = tzMakeNative(function getTimezoneOffset() {
                    return targetOffset;
                }, 'getTimezoneOffset');

                // Hook 2: Intl.DateTimeFormat.prototype.resolvedOptions
                const OrigDTFProto = Intl.DateTimeFormat.prototype;
                const origResolvedOptions = OrigDTFProto.resolvedOptions;
                OrigDTFProto.resolvedOptions = tzMakeNative(function resolvedOptions() {
                    const result = origResolvedOptions.call(this);
                    result.timeZone = targetTimezone;
                    return result;
                }, 'resolvedOptions');

                // Hook 3: Date.prototype.toLocaleString family (with timeZone support)
                const dateMethodsToHook = ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'];
                dateMethodsToHook.forEach(methodName => {
                    const origMethod = Date.prototype[methodName];
                    Date.prototype[methodName] = tzMakeNative(function(...args) {
                        // If options provided without timeZone, inject target timeZone
                        if (args.length === 0) {
                            return origMethod.call(this, undefined, { timeZone: targetTimezone });
                        } else if (args.length === 1) {
                            return origMethod.call(this, args[0], { timeZone: targetTimezone });
                        } else {
                            const opts = args[1] || {};
                            if (!opts.timeZone) {
                                opts.timeZone = targetTimezone;
                            }
                            return origMethod.call(this, args[0], opts);
                        }
                    }, methodName);
                });

                // Hook 4: new Intl.DateTimeFormat() constructor - inject default timeZone
                const OrigDateTimeFormat = Intl.DateTimeFormat;
                Intl.DateTimeFormat = function(locales, options) {
                    const opts = options ? { ...options } : {};
                    if (!opts.timeZone) {
                        opts.timeZone = targetTimezone;
                    }
                    return new OrigDateTimeFormat(locales, opts);
                };
                Intl.DateTimeFormat.prototype = OrigDateTimeFormat.prototype;
                Intl.DateTimeFormat.supportedLocalesOf = OrigDateTimeFormat.supportedLocalesOf.bind(OrigDateTimeFormat);
                tzMakeNative(Intl.DateTimeFormat, 'DateTimeFormat');
            }

            // --- 1. 移除 WebDriver 及 Puppeteer 特征 ---
            // 多层策略确保 navigator.webdriver = false:
            // 主防线: --disable-blink-features=AutomationControlled (Chrome 启动参数)
            // 后备: JavaScript 层面覆盖 (处理极端情况)
            const applyWebdriverOverride = () => {
                const wdGetter = function webdriver() { return false; };
                Object.defineProperty(wdGetter, 'toString', {
                    value: function() { return 'function get webdriver() { [native code] }'; },
                    configurable: true, writable: true
                });
                Object.defineProperty(wdGetter.toString, 'toString', {
                    value: function() { return 'function toString() { [native code] }'; },
                    configurable: true, writable: true
                });

                // 策略 1: 先删除再在原型链上重新定义
                try {
                    delete Navigator.prototype.webdriver;
                    Object.defineProperty(Navigator.prototype, 'webdriver', {
                        get: wdGetter,
                        set: function() {},
                        configurable: true
                    });
                } catch(e) {}

                // 策略 2: 在实例上也覆盖（处理 Chrome 在实例上设置 own property 的情况）
                try {
                    delete navigator.webdriver;
                    Object.defineProperty(navigator, 'webdriver', {
                        get: wdGetter,
                        set: function() {},
                        configurable: true
                    });
                } catch(e) {}
            };

            // 立即执行
            applyWebdriverOverride();
            // 延迟执行（处理 Chrome 在 document_start 之后才设置 webdriver 的情况）
            Promise.resolve().then(applyWebdriverOverride);
            setTimeout(applyWebdriverOverride, 0);

            // 移除 cdc_ 变量 (Puppeteer/ChromeDriver 特征)
            const cdcRegex = /cdc_[a-zA-Z0-9]+/;
            for (const key in window) {
                if (cdcRegex.test(key)) {
                    try { delete window[key]; } catch(e) {}
                }
            }
            // 防御性移除常见自动化变量
            ['$cdc_asdjflasutopfhvcZLmcfl_', '$chrome_asyncScriptInfo', 'callPhantom', 'webdriver',
             '__webdriver_evaluate', '__selenium_evaluate', '__fxdriver_evaluate', '__driver_evaluate',
             '__webdriver_unwrap', '__selenium_unwrap', '__fxdriver_unwrap', '__driver_unwrap',
             '_Selenium_IDE_Recorder', '_selenium', 'calledSelenium', '_WEBDRIVER_ELEM_CACHE',
             'ChromeDriverw', '__$webdriverAsyncExecutor'].forEach(k => {
                 try { if (window[k]) delete window[k]; } catch(e) {}
            });

            // 移除 document 上的自动化标记
            try {
                if (document.documentElement) {
                    document.documentElement.removeAttribute('webdriver');
                    document.documentElement.removeAttribute('selenium');
                    document.documentElement.removeAttribute('driver');
                }
            } catch(e) {}

            // 确保 window.chrome 对象存在且完整
            // 注意：不要覆盖已有的 chrome 对象（扩展加载后 Chrome 会提供原生 chrome.runtime）
            // 只在缺失时补充必要的属性
            if (!window.chrome) {
                window.chrome = {};
            }
            if (!window.chrome.app) {
                window.chrome.app = {
                    isInstalled: false,
                    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
                    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
                };
            }
            if (!window.chrome.runtime) {
                window.chrome.runtime = {
                    OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
                    OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
                    PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
                    PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', X86_32: 'x86-32', X86_64: 'x86-64' },
                    PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
                    RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' }
                };
            }
            // 补充 chrome.csi 和 chrome.loadTimes（正常 Chrome 都有）
            if (!window.chrome.csi) {
                window.chrome.csi = function() { return { startE: Date.now(), onloadT: Date.now(), pageT: Date.now() - performance.timing.navigationStart, tran: 15 }; };
            }
            if (!window.chrome.loadTimes) {
                window.chrome.loadTimes = function() {
                    return {
                        commitLoadTime: performance.timing.responseStart / 1000,
                        connectionInfo: 'h2',
                        finishDocumentLoadTime: performance.timing.domContentLoadedEventEnd / 1000,
                        finishLoadTime: performance.timing.loadEventEnd / 1000,
                        firstPaintAfterLoadTime: 0,
                        firstPaintTime: performance.timing.domContentLoadedEventEnd / 1000,
                        navigationType: 'Other',
                        npnNegotiatedProtocol: 'h2',
                        requestTime: performance.timing.navigationStart / 1000,
                        startLoadTime: performance.timing.navigationStart / 1000,
                        wasAlternateProtocolAvailable: false,
                        wasFetchedViaSpdy: true,
                        wasNpnNegotiated: true
                    };
                };
            }

            // --- 1.5 Screen Resolution Hook ---
            // Override screen properties to match fingerprint values
            if (fp.screen && fp.screen.width && fp.screen.height) {
                const screenWidth = fp.screen.width;
                const screenHeight = fp.screen.height;
                
                Object.defineProperty(screen, 'width', {
                    get: makeNative(function width() { return screenWidth; }, 'width'),
                    configurable: true
                });
                Object.defineProperty(screen, 'height', {
                    get: makeNative(function height() { return screenHeight; }, 'height'),
                    configurable: true
                });
                Object.defineProperty(screen, 'availWidth', {
                    get: makeNative(function availWidth() { return screenWidth; }, 'availWidth'),
                    configurable: true
                });
                Object.defineProperty(screen, 'availHeight', {
                    get: makeNative(function availHeight() { return screenHeight - 40; }, 'availHeight'),
                    configurable: true
                });
                // Also override window.outerWidth/outerHeight for consistency
                Object.defineProperty(window, 'outerWidth', {
                    get: makeNative(function outerWidth() { return screenWidth; }, 'outerWidth'),
                    configurable: true
                });
                Object.defineProperty(window, 'outerHeight', {
                    get: makeNative(function outerHeight() { return screenHeight; }, 'outerHeight'),
                    configurable: true
                });
            }

            // --- 1.6 Stealthy Hardware Fingerprint Hook (CPU Cores & Memory) ---
            // Override navigator.hardwareConcurrency and navigator.deviceMemory on Navigator.prototype
            // Using the same stealth pattern as timezone hooks to avoid Pixelscan detection
            if (fp.hardwareConcurrency) {
                const targetCores = fp.hardwareConcurrency;
                // Create a getter that returns our value
                const coresGetter = function() { return targetCores; };
                // Apply makeNative to hide the hook
                Object.defineProperty(coresGetter, 'toString', {
                    value: function() { return 'function get hardwareConcurrency() { [native code] }'; },
                    configurable: true, writable: true
                });
                Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
                    get: coresGetter,
                    configurable: true
                });
            }
            
            if (fp.deviceMemory) {
                const targetMemory = fp.deviceMemory;
                const memoryGetter = function() { return targetMemory; };
                Object.defineProperty(memoryGetter, 'toString', {
                    value: function() { return 'function get deviceMemory() { [native code] }'; },
                    configurable: true, writable: true
                });
                Object.defineProperty(Navigator.prototype, 'deviceMemory', {
                    get: memoryGetter,
                    configurable: true
                });
            }

            // --- 2. Stealth Geolocation Hook (Native Mock Pattern) ---
            // 避免使用 Proxy (会被 Pixelscan 识别为 Masking detected)
            // 直接修改 Geolocation.prototype 并确保存根函数通过 native code 检查
            if (fp.geolocation) {
                const { latitude, longitude } = fp.geolocation;
                // 精度提升到 500m - 1500m
                const accuracy = 500 + Math.floor(Math.random() * 1000);

                const makeNative = (func, name) => {
                    Object.defineProperty(func, 'toString', {
                        value: function() { return "function " + name + "() { [native code] }"; },
                        configurable: true,
                        writable: true
                    });
                    // 隐藏 toString 自身的 toString
                    Object.defineProperty(func.toString, 'toString', {
                        value: function() { return "function toString() { [native code] }"; },
                        configurable: true,
                        writable: true
                    });
                    return func;
                };

                // 保存原始引用 (虽然我们不打算用它，但为了保险)
                const originalGetCurrentPosition = Geolocation.prototype.getCurrentPosition;

                // 创建伪造函数
                const fakeGetCurrentPosition = function getCurrentPosition(success, error, options) {
                    const position = {
                        coords: {
                            latitude: latitude + (Math.random() - 0.5) * 0.005,
                            longitude: longitude + (Math.random() - 0.5) * 0.005,
                            accuracy: accuracy,
                            altitude: null,
                            altitudeAccuracy: null,
                            heading: null,
                            speed: null
                        },
                        timestamp: Date.now()
                    };
                    // 异步回调
                    setTimeout(() => success(position), 10);
                };

                const fakeWatchPosition = function watchPosition(success, error, options) {
                    fakeGetCurrentPosition(success, error, options);
                    return Math.floor(Math.random() * 10000) + 1;
                };

                // 应用 Native Mock
                Object.defineProperty(Geolocation.prototype, 'getCurrentPosition', {
                    value: makeNative(fakeGetCurrentPosition, 'getCurrentPosition'),
                    configurable: true,
                    writable: true
                });

                Object.defineProperty(Geolocation.prototype, 'watchPosition', {
                    value: makeNative(fakeWatchPosition, 'watchPosition'),
                    configurable: true,
                    writable: true
                });
            }

            // --- 2. Intl API Language Override (Minimal Hook) ---
            // Only hook Intl API to match --lang parameter, don't touch navigator
            if (fp.language && fp.language !== 'auto') {
                const targetLang = fp.language;
                
                // Save originals
                const OrigDTF = Intl.DateTimeFormat;
                const OrigNF = Intl.NumberFormat;
                const OrigColl = Intl.Collator;
                
                // Minimal hook - only inject default locale when not specified
                const hookedDTF = function DateTimeFormat(locales, options) {
                    return new OrigDTF(locales || targetLang, options);
                };
                hookedDTF.prototype = OrigDTF.prototype;
                hookedDTF.supportedLocalesOf = OrigDTF.supportedLocalesOf.bind(OrigDTF);
                Intl.DateTimeFormat = makeNative(hookedDTF, 'DateTimeFormat');
                
                const hookedNF = function NumberFormat(locales, options) {
                    return new OrigNF(locales || targetLang, options);
                };
                hookedNF.prototype = OrigNF.prototype;
                hookedNF.supportedLocalesOf = OrigNF.supportedLocalesOf.bind(OrigNF);
                Intl.NumberFormat = makeNative(hookedNF, 'NumberFormat');
                
                const hookedColl = function Collator(locales, options) {
                    return new OrigColl(locales || targetLang, options);
                };
                hookedColl.prototype = OrigColl.prototype;
                hookedColl.supportedLocalesOf = OrigColl.supportedLocalesOf.bind(OrigColl);
                Intl.Collator = makeNative(hookedColl, 'Collator');
            }

            // --- 3. Canvas Noise ---
            const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
            const hookedGetImageData = function getImageData(x, y, w, h) {
                const imageData = originalGetImageData.apply(this, arguments);
                if (fp.noiseSeed) {
                    for (let i = 0; i < imageData.data.length; i += 4) {
                        if ((i + fp.noiseSeed) % 53 === 0) {
                            const noise = fp.canvasNoise ? (fp.canvasNoise.a || 0) : 0;
                            imageData.data[i+3] = Math.max(0, Math.min(255, imageData.data[i+3] + noise));
                        }
                    }
                }
                return imageData;
            };
            CanvasRenderingContext2D.prototype.getImageData = makeNative(hookedGetImageData, 'getImageData');

            // --- 4. Audio Noise ---
            const originalGetChannelData = AudioBuffer.prototype.getChannelData;
            const hookedGetChannelData = function getChannelData(channel) {
                const results = originalGetChannelData.apply(this, arguments);
                const noise = fp.audioNoise || 0.0000001;
                for (let i = 0; i < 100 && i < results.length; i++) {
                    results[i] = results[i] + noise;
                }
                return results;
            };
            AudioBuffer.prototype.getChannelData = makeNative(hookedGetChannelData, 'getChannelData');

            // --- 5. WebRTC Protection ---
            const originalPC = window.RTCPeerConnection;
            const hookedPC = function RTCPeerConnection(config) {
                if(!config) config = {};
                config.iceTransportPolicy = 'relay'; 
                return new originalPC(config);
            };
            hookedPC.prototype = originalPC.prototype;
            window.RTCPeerConnection = makeNative(hookedPC, 'RTCPeerConnection');

        } catch(e) { console.error("FP Error", e); }

        try {
            // --- 6. 浮动水印（显示环境名称）---
            // 根据用户设置选择水印样式
            const watermarkStyle = '${style}';

            function createWatermark() {
                try {
                    // 检查是否已存在水印（避免重复创建）
                    if (document.getElementById('geekez-watermark')) return;

                    // 确保 body 存在
                    if (!document.body) {
                        setTimeout(createWatermark, 50);
                        return;
                    }

                    if (watermarkStyle === 'banner') {
                        // 方案1: 顶部横幅
                        const banner = document.createElement('div');
                        banner.id = 'geekez-watermark';
                        banner.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; background: linear-gradient(135deg, rgba(102, 126, 234, 0.5), rgba(118, 75, 162, 0.5)); backdrop-filter: blur(10px); color: white; padding: 5px 20px; text-align: center; font-size: 12px; font-weight: 500; z-index: 2147483647; box-shadow: 0 2px 10px rgba(0,0,0,0.1); display: flex; align-items: center; justify-content: center; gap: 8px; font-family: monospace;';

                        const icon = document.createElement('span');
                        icon.textContent = '🔹';
                        icon.style.cssText = 'font-size: 14px;';

                        const text = document.createElement('span');
                        text.textContent = '环境：${safeProfileName}';

                        const closeBtn = document.createElement('button');
                        closeBtn.textContent = '×';
                        closeBtn.style.cssText = 'position: absolute; right: 10px; background: rgba(255,255,255,0.2); border: none; color: white; width: 20px; height: 20px; border-radius: 50%; cursor: pointer; font-size: 16px; line-height: 1; transition: background 0.2s; font-family: monospace;';
                        closeBtn.onmouseover = function() { this.style.background = 'rgba(255,255,255,0.3)'; };
                        closeBtn.onmouseout = function() { this.style.background = 'rgba(255,255,255,0.2)'; };
                        closeBtn.onclick = function() { banner.style.display = 'none'; };

                        banner.appendChild(icon);
                        banner.appendChild(text);
                        banner.appendChild(closeBtn);
                        document.body.appendChild(banner);

                    } else {
                        // 方案5: 增强水印 (默认)
                        const watermark = document.createElement('div');
                        watermark.id = 'geekez-watermark';
                        watermark.style.cssText = 'position: fixed; bottom: 16px; right: 16px; background: linear-gradient(135deg, rgba(102, 126, 234, 0.5), rgba(118, 75, 162, 0.5)); backdrop-filter: blur(10px); color: white; padding: 10px 16px; border-radius: 8px; font-size: 15px; font-weight: 600; z-index: 2147483647; pointer-events: none; user-select: none; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); display: flex; align-items: center; gap: 8px; font-family: monospace; animation: geekez-pulse 2s ease-in-out infinite;';

                        const icon = document.createElement('span');
                        icon.textContent = '🎯';
                        icon.style.cssText = 'font-size: 18px; animation: geekez-rotate 3s linear infinite;';

                        const text = document.createElement('span');
                        text.textContent = '${safeProfileName}';

                        watermark.appendChild(icon);
                        watermark.appendChild(text);
                        document.body.appendChild(watermark);

                        // 添加动画样式
                        if (!document.getElementById('geekez-watermark-styles')) {
                            const style = document.createElement('style');
                            style.id = 'geekez-watermark-styles';
                            style.textContent = '@keyframes geekez-pulse { 0%, 100% { box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); } 50% { box-shadow: 0 4px 25px rgba(102, 126, 234, 0.6); } } @keyframes geekez-rotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
                            document.head.appendChild(style);
                        }

                        // 自适应颜色函数（保留之前的功能）
                        function updateWatermarkColor() {
                            try {
                                const rect = watermark.getBoundingClientRect();
                                const x = rect.left + rect.width / 2;
                                const y = rect.top + rect.height / 2;

                                watermark.style.display = 'none';
                                const elementBelow = document.elementFromPoint(x, y) || document.body;
                                watermark.style.display = '';

                                const bgColor = window.getComputedStyle(elementBelow).backgroundColor;
                                const rgb = bgColor.match(/\\d+/g);

                                if (rgb && rgb.length >= 3) {
                                    const r = parseInt(rgb[0]);
                                    const g = parseInt(rgb[1]);
                                    const b = parseInt(rgb[2]);
                                    const brightness = (r * 0.299 + g * 0.587 + b * 0.114);

                                    // 保持渐变背景，统一使用50%透明度
                                    watermark.style.background = 'linear-gradient(135deg, rgba(102, 126, 234, 0.3), rgba(118, 75, 162, 0.3)';
                                }
                            } catch(e) {
                                console.warn('Watermark color update failed:', e && e.message ? e.message : e);
                            }
                        }

                        setTimeout(updateWatermarkColor, 100);

                        let colorUpdateTimer;
                        function scheduleColorUpdate() {
                            clearTimeout(colorUpdateTimer);
                            colorUpdateTimer = setTimeout(updateWatermarkColor, 200);
                        }

                        window.addEventListener('scroll', scheduleColorUpdate, { passive: true });
                        window.addEventListener('resize', scheduleColorUpdate, { passive: true });

                        const observer = new MutationObserver(scheduleColorUpdate);
                        observer.observe(document.body, {
                            attributes: true,
                            attributeFilter: ['style', 'class'],
                            subtree: true
                        });
                    }

                } catch(e) {
                    console.warn('Watermark init failed:', e && e.message ? e.message : e);
                }
            }

            // 立即尝试创建（针对已加载的页面）
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', createWatermark);
            } else {
                createWatermark();
            }
        } catch(e) {
            console.error('Watermark Error', e);
        }
    })();
    `;
}

module.exports = { generateFingerprint, getInjectScript };
