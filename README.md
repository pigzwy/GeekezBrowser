# GeekEZ Browser

<div align="center">

<img src="icon.png" width="100" height="100" alt="GeekEZ Logo">

[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

**A Stealthy Anti-Detect Browser for E-Commerce & Multi-Account Management.**

[🇨🇳 中文说明 (Chinese)](docs/README_zh.md) | [📥 Download](https://github.com/EchoHS/GeekezBrowser/releases)

</div>

---

## 📖 Introduction

**GeekEZ Browser** is a professional anti-detect browser built on **Electron** and **Puppeteer**, integrated with the powerful **Xray-core**. 

It is designed to help e-commerce operators (Amazon, TikTok, Facebook, Shopee, etc.) manage multiple accounts safely by strictly isolating browser fingerprints, network environments, and local storage. It bypasses advanced detectors like Cloudflare, Pixelscan and BrowserScan.

## 📸 Screenshots

<div align="center">

<img src="docs/Main Interface1.png" alt="Main Interface1" width="800">

<img src="docs/Main Interface2.png" alt="Main Interface2" width="800">

*Main Interface - Profile Management*

</div>

## ✨ Key Features

### 🛡️ Advanced Fingerprint Isolation
*   **Hardware Randomization**: Randomizes **CPU Cores** (4/8/12/16) and **Device Memory** (4/8/16 GB) for each profile, significantly increasing fingerprint uniqueness.
*   **Timezone & Geo Spoofing**: 
    - **Auto (No Change)** mode: Automatically matches the time zone and latitude and longitude of the proxy IP location.
    - Geolocation spoofing with 50+ cities worldwide
*   **Language Spoofing**: 
    - 60+ languages covering all regions
    - Full browser language, HTTP headers, and internationalization API modification
*   **WebRTC Protection**: Forces `disable_non_proxied_udp` policy to prevent real IP leaks.

### 🔗 Powerful Network Engine (Xray-core)
*   **Full Protocol Support**: VMess, VLESS, Trojan, Shadowsocks (including **2022**), Socks5, HTTP.
*   **Advanced Transports**: Support for **REALITY**, **XHTTP**, **gRPC**, **mKCP**, WebSocket, H2.
*   **Proxy Chain (Pre-Proxy)**: `[Local] -> [Pre-Proxy] -> [Target Node] -> [Web]`. Hides your real IP from the proxy provider.
*   **Smart Routing**: Automatic IPv4/IPv6 dual-stack handling.

### 🧩 Workflow & Management
*   **Extension Support**: Import unpacked Chrome extensions (e.g., MetaMask, AdBlock) into isolated environments.
*   **Tag System**: Organize profiles with custom color tags (e.g., "TikTok", "USA", "Main Account").
*   **Safe Identification**: Uses **Dynamic Watermark** to display profile names (e.g., `Profile-1`) at the top of the page. 
*   **Multi-Opening**: Running multiple profiles simultaneously with independent ports and processes.
*   **Remote Debugging Port** (Advanced): Optional external Puppeteer/DevTools connection for automation.

## 🚀 Quick Start

### Option 1: Download Release (Recommended)
Go to the [**Releases**](https://github.com/EchoHS/GeekezBrowser/releases) page and download the installer for your platform:
*   **Windows**: `GeekEZ Browser-{version}-win-x64.exe`
*   **macOS (ARM64)**: `GeekEZ Browser-{version}-mac-arm64.dmg`
*   **macOS (Intel)**: `GeekEZ Browser-{version}-mac-x64.dmg`
*   **Linux**: `GeekEZ Browser-{version}-linux-x64.AppImage`

### Option 2: Run from Source

**Prerequisites**: Node.js (v16+) and Git.

1.  **Clone the repository**
    ```bash
    git clone https://github.com/EchoHS/GeekezBrowser.git
    cd GeekezBrowser
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```

3.  **Run the App**
    ```bash
    npm start
    ```

## 🛠 Compatibility Guide

| Platform | Rating | Notes |
| :--- | :--- | :--- |
| **TikTok** | ✅ Safe | Canvas noise effectively prevents device association. Requires **Dedicated IP**. |
| **Facebook** | ✅ Safe | Automation flags (WebDriver) stripped. Avoid high-frequency automation. |
| **Shopee** | ✅ Safe | Stable fingerprint for seller center. Use fixed environment per account. |
| **Amazon (Buyer)** | ✅ Safe | Sufficient isolation for buyer/reviewer accounts. |
| **Amazon (Seller)** | ✅ Safe | **TLS Safe**. Usable for main accounts with **Dedicated IP** and fixed environment. |

## 📦 Build

To create an executable for your platform:

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

## 🔍 Detection Status

- ✅ **Browserscan**: All tests passed
- ✅ **Pixelscan**: All tests passed
- ✅ **Cloudflare**: Bot test passed

## ❓ FAQ

### macOS: "App is damaged" or "Cannot be opened"

**Solution**:
1. Drag `GeekEZ Browser` into your **Applications** folder.
2. Open Terminal and run the following command (enter password if prompted):
   ```bash
   sudo xattr -rd com.apple.quarantine /Applications/GeekEZ\ Browser.app
   ```
3. Re-open the app.

## ⚠️ Important Notes

1. **Timezone Settings**: Use "Auto (No Change)" when logging into AWS, Oracle, or other sensitive websites to avoid white screen issues.
2. **Geolocation**: Always select a city that matches your proxy IP location to avoid account bans.
3. **Remote Debugging**: Only enable when you need external control via Puppeteer/DevTools. Keep it disabled for daily use.

## 📝 License

This project is licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).

## ⚠️ Disclaimer

This tool is provided for educational and research purposes only. The developers are not responsible for any account bans or legal issues resulting from the use of this software. Please comply with the terms of service of the platforms you use.
