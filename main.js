/**
 * WhaleTracker - Electron 主进程
 *
 * 负责：窗口管理、原生菜单、系统托盘、DPI 缩放、持久化
 */

const { app, BrowserWindow, Menu, Tray, nativeImage, shell, ipcMain, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

// ============================================================
// 全局变量
// ============================================================
let mainWindow = null;
let tray = null;
let isQuitting = false;

// 窗口状态持久化文件
const windowStateFile = path.join(app.getPath('userData'), 'window-state.json');

// ============================================================
// DPI 适配 (Redmi A27U: 3840x2160 @ 27" ≈ 163 PPI, 150% 缩放)
// ============================================================
app.commandLine.appendSwitch('enable-hardware-acceleration');
app.commandLine.appendSwitch('disable-features', 'UseSkiaRenderer');

// ============================================================
// 窗口状态持久化
// ============================================================
function loadWindowState() {
    try {
        if (fs.existsSync(windowStateFile)) {
            return JSON.parse(fs.readFileSync(windowStateFile, 'utf-8'));
        }
    } catch (e) {
        console.warn('加载窗口状态失败:', e);
    }
    return null;
}

function saveWindowState() {
    if (!mainWindow || isQuitting) return;
    const bounds = mainWindow.getBounds();
    const state = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized: mainWindow.isMaximized(),
        displayScaleFactor: mainWindow.webContents.getZoomFactor()
    };
    try {
        fs.writeFileSync(windowStateFile, JSON.stringify(state), 'utf-8');
    } catch (e) {
        // 忽略写入错误
    }
}

// ============================================================
// 创建主窗口
// ============================================================
function createMainWindow() {
    const savedState = loadWindowState();

    const defaultBounds = {
        // 4K 屏幕推荐 2560x1440 (2K 大小), 留出一些边距给其他窗口
        width: 2560,
        height: 1440,
        minWidth: 1600,
        minHeight: 900,
        maxWidth: 3840,
        maxHeight: 2160,
        center: true,
        ...(savedState && !savedState.isMaximized ? savedState : {})
    };

    mainWindow = new BrowserWindow({
        width: defaultBounds.width,
        height: defaultBounds.height,
        minWidth: defaultBounds.minWidth,
        minHeight: defaultBounds.minHeight,
        maxWidth: defaultBounds.maxWidth,
        maxHeight: defaultBounds.maxHeight,
        x: defaultBounds.x,
        y: defaultBounds.y,
        center: !savedState,
        frame: true,           // 原生窗口边框 (Mac 上会是 traffic light)
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        backgroundColor: '#0d1117',
        show: true,
        
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            enableRemoteModule: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            backgroundThrottling: false   // 后台不节流 (即使最小化也继续接收 WS)
        }
    });

    // DPI 缩放：4K 屏自动调整
    // 27寸 4K 推荐 1.25-1.5 倍, 让字不会太小
    mainWindow.webContents.on('did-finish-load', () => {
        const zoom = savedState?.displayScaleFactor || 1.2;
        mainWindow.webContents.setZoomFactor(zoom);
    });

    // 加载渲染进程页面
    console.log('[WT] Loading index.html...');
    mainWindow.loadFile(path.join(__dirname, 'src/renderer/index.html'));
    mainWindow.webContents.on('did-finish-load', () => {
        console.log('[WT] did-finish-load, DOM ready');
    });
    mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
        console.error('[WT] did-fail-load:', code, desc);
    });

    // 窗口准备好之后再显示（避免白屏闪烁）
    mainWindow.once('ready-to-show', () => {
        console.log('[WT] ready-to-show fired, showing window...');
        mainWindow.show();
        mainWindow.focus();
        if (savedState?.isMaximized) {
            mainWindow.maximize();
        }
    });
    // 兜底: 如果 ready-to-show 不触发 (Mac 偶发), 3 秒后强制显示
    setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (!mainWindow.isVisible()) {
            console.log('[WT] ready-to-show did not fire, forcing show after 3s');
            mainWindow.show();
            mainWindow.focus();
        }
    }, 3000);

    // 关闭时保存窗口状态
    mainWindow.on('close', (e) => {
        if (!isQuitting) {
            saveWindowState();
            // 隐藏到托盘, 不退出
            e.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // 自动保存窗口状态 (10秒一次)
    setInterval(saveWindowState, 10000);

    // 链接在外部浏览器打开
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

// ============================================================
// 原生菜单
// ============================================================
function createMenu() {
    const isMac = process.platform === 'darwin';

    const template = [
        ...(isMac ? [{
            label: 'WhaleTracker',
            submenu: [
                { role: 'about', label: '关于 WhaleTracker' },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide', label: '隐藏 WhaleTracker' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit', label: '退出 WhaleTracker' }
            ]
        }] : []),
        {
            label: '文件',
            submenu: [
                {
                    label: '重新加载',
                    accelerator: 'CmdOrCtrl+R',
                    click: () => mainWindow?.reload()
                },
                {
                    label: '导出信号日志...',
                    click: () => mainWindow?.webContents.send('menu:export-log')
                },
                { type: 'separator' },
                isMac ? { role: 'close' } : { role: 'quit', label: '退出' }
            ]
        },
        {
            label: '视图',
            submenu: [
                { role: 'reload', label: '刷新' },
                { role: 'toggleDevTools', label: '开发者工具', accelerator: 'F12' },
                { type: 'separator' },
                { role: 'resetZoom', label: '重置缩放', accelerator: 'CmdOrCtrl+0' },
                { role: 'zoomIn', label: '放大', accelerator: 'CmdOrCtrl+=' },
                { role: 'zoomOut', label: '缩小', accelerator: 'CmdOrCtrl+-' },
                { type: 'separator' },
                { role: 'togglefullscreen', label: '全屏', accelerator: 'F11' }
            ]
        },
        {
            label: '交易',
            submenu: [
                {
                    label: '连接 Binance WS',
                    click: () => mainWindow?.webContents.send('menu:connect-binance')
                },
                {
                    label: '连接 CoinGlass WS',
                    click: () => mainWindow?.webContents.send('menu:connect-coinglass')
                },
                {
                    label: '连接 Hyperliquid API',
                    click: () => mainWindow?.webContents.send('menu:connect-hyperliquid')
                },
                { type: 'separator' },
                {
                    label: '断开所有连接',
                    click: () => mainWindow?.webContents.send('menu:disconnect-all')
                }
            ]
        },
        {
            label: '窗口',
            submenu: [
                { role: 'minimize', label: '最小化' },
                { role: 'zoom', label: '放大/还原' },
                { type: 'separator' },
                {
                    label: '还原默认窗口大小',
                    click: () => {
                        mainWindow?.setBounds({ width: 2560, height: 1440, ...(isMac ? {} : { x: 100, y: 100 }) });
                        mainWindow?.center();
                    }
                }
            ]
        },
        ...(isMac ? [] : [{
            label: '帮助',
            submenu: [
                {
                    label: '关于 WhaleTracker',
                    click: () => {
                        new Notification({
                            title: 'WhaleTracker',
                            body: '山寨币大户资金流向追踪系统 v1.0.0\n\nCoinGlass Pro + Binance WS + Hyperliquid API'
                        }).show();
                    }
                }
            ]
        }])
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

// ============================================================
// 系统托盘
// ============================================================
function createTray() {
    // 创建一个简单的 16x16 图标 (绿色鲸鱼占位)
    const icon = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABhklEQVR42mNgGAWjYBSMglEwCkbBKBgFo2AUhYMwLgA3Y8KqAJE4wM/2+P//zM+Q7f5H/hOYx/A92P5H/jGYT4B3Y8+4BLYBvA/3P1gHgNtAPaB1YF8BLYGvAP2P1AFgPbgHagPnAbwA3gTtAP6BvYC+AaA04AvYCOh9wBZ0A+4HdgKngG8AXYH7gJngHsCpwF9gI9Qz4B34O9Aw7AM4Cv4FbAA+DvQMOwDOArcBZwXPA14E7YDXgOvAP+APwCvAN2AOyAn4EPwXnANOAa+Aj4BvQV/Ax4A/AM8Bh4IvgH3QBuAu4FvAO6As4E/Ak8BHwFngW/BW4AfwBfgG4Av4IvgDnANOAbeAH4CvgX/A64AvwBfgG4AvwHPAY8E/gE3QBuBu4AHAF6A7YBfAN8CbwHnBc4EvgT/A54FvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DtwHOwDOAncBZwX/A74E7YDXwHPAz4A7wHvgG4Av4EvgT3AS8BZwXPgT8AvQIPwFbgFvwHPAf4AvwCvgHvgFbAA+DwBdF/8UQ3lQAAAAASUVORK5CYII='
    );

    tray = new Tray(icon);
    tray.setToolTip('WhaleTracker - 山寨币大户资金流向追踪系统');

    const menu = Menu.buildFromTemplate([
        {
            label: '显示主窗口',
            click: () => {
                if (!mainWindow) createMainWindow();
                mainWindow.show();
                mainWindow.focus();
            }
        },
        {
            label: '最小化到托盘',
            click: () => mainWindow?.hide()
        },
        { type: 'separator' },
        {
            label: '当前信号: HOLD',
            enabled: false,
            click: () => {}
        },
        { type: 'separator' },
        {
            label: '退出 WhaleTracker',
            click: () => {
                isQuitting = true;
                saveWindowState();
                app.quit();
            }
        }
    ]);
    tray.setContextMenu(menu);

    tray.on('click', () => {
        if (!mainWindow) createMainWindow();
        mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    });

    // 托盘上更新当前信号
    setInterval(() => {
        const state = mainWindow?.webContents?.getTitle() || '';
        const label = menu.items[3];
        label.label = `当前信号: ${state || 'HOLD'}`;
        tray.setContextMenu(menu);
    }, 3000);
}

// ============================================================
// 系统通知
// ============================================================
ipcMain.on('show-notification', (event, data) => {
    if (Notification.isSupported()) {
        const n = new Notification({
            title: data.title || 'WhaleTracker',
            body: data.body || ''
        });
        n.on('click', () => {
            if (!mainWindow) createMainWindow();
            mainWindow.show();
            mainWindow.focus();
        });
        n.show();
    }
});

// ============================================================
// 应用生命周期
// ============================================================
app.whenReady().then(() => {
    createMainWindow();
    createMenu();
    createTray();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createMainWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        // 非 Mac 上点击关闭后不退出, 保留在托盘
    }
});

app.on('before-quit', () => {
    isQuitting = true;
    saveWindowState();
});
