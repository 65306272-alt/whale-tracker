/**
 * WhaleTracker - Electron Preload
 *
 * 在渲染进程里安全地暴露主进程 API
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // 平台信息
    platform: process.platform,
    isMac: process.platform === 'darwin',
    isWin: process.platform === 'win32',
    appVersion: '1.0.0',

    // 系统通知
    showNotification: (title, body) => {
        ipcRenderer.send('show-notification', { title, body });
    },

    // 菜单事件
    onMenu: (channel, callback) => {
        const validChannels = [
            'menu:export-log',
            'menu:connect-binance',
            'menu:connect-coinglass',
            'menu:connect-hyperliquid',
            'menu:disconnect-all'
        ];
        if (validChannels.includes(channel)) {
            ipcRenderer.on(channel, (_event, ...args) => callback(...args));
        }
    },

    // 本地存储 (读写配置)
    saveConfig: (key, value) => {
        try {
            localStorage.setItem(`wt_${key}`, JSON.stringify(value));
            return true;
        } catch (e) {
            return false;
        }
    },
    loadConfig: (key, defaultValue) => {
        try {
            const raw = localStorage.getItem(`wt_${key}`);
            return raw ? JSON.parse(raw) : defaultValue;
        } catch (e) {
            return defaultValue;
        }
    }
});
