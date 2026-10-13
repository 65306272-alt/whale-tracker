/**
 * WhaleTracker - 全局配置
 */

const CONFIG = {

    // === 自动交易 ===
    auto_trade: {
        enabled: false,        // 手动开/关 (参数面板里的 toggle)
        min_score: 50,         // 只有 ≥ 50 的 STRONG_BUY/SELL 才自动下单
        leverage: 3,
    },

    // === 信号权重 (总和 = 1.0, 不要随便改) ===
    weights: {
        whale_flow: 0.40,
        liquidation: 0.25,
        crowding: 0.20,
        orderbook:  0.15,
    },

    // === 阈值 ===
    thresholds: {
        whale_usdt_threshold: 50000,
        strong_buy_score: 50,
        buy_score:        25,
        sell_score:      -25,
        strong_sell_score: -50,
        cooldown_minutes: 20,
        stop_loss_pct: 1.0,
        take_profit_pct: 6.0,
        position_pct: 15,
        leverage: 3,
        timeout_minutes: 30,
        crowding_z_extreme: 2.0,
        orderbook_wall_min: 500000,
    },

    // === K线图 ===
    chart: {
        ema_short: 9,
        ema_long:  55,
    },

    // === 数据源 ===
    data_sources: {
        binance:   { ws_base: "wss://fstream.binance.com", enabled: true },
        coinglass: { rest_base: "https://open-api-v4.coinglass.com", ws_url: "wss://open-api-v4.coinglass.com/ws", api_key: "", enabled: true },
        hyperliquid: { rest_url: "https://api.hyperliquid.xyz/info", ws_url: "wss://api.hyperliquid.xyz/ws", enabled: true },
    },

    // === 模拟数据 ===
    mock: {
        enabled: true,
        symbol:  "SUIUSDT",
    },
};

window.CONFIG = CONFIG;
