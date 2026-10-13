/**
 * WhaleTracker - 模拟数据生成器 (多币对版)
 *
 * 支持:
 *   - 多币对并行模拟 (每个币对独立价格、趋势、波动率)
 *   - 每根 K 线自带副图数据 (大户净流入 / 拥挤度 / 清算热力)
 *   - 快达标信号筛选
 */

const DEFAULT_SYMBOLS = [
    { symbol: 'SUIUSDT',   base_price: 2.1456, volatility: 0.008, trend: 0.00015 },
    { symbol: 'SEIUSDT',   base_price: 0.4231, volatility: 0.012, trend: -0.00005 },
    { symbol: 'APTUSDT',   base_price: 7.8920, volatility: 0.009, trend: 0.00010 },
    { symbol: 'RNDRUSDT',  base_price: 12.560, volatility: 0.011, trend: 0.00020 },
    { symbol: 'SOLUSDT',   base_price: 189.50, volatility: 0.006, trend: 0.00008 },
    { symbol: 'BNBUSDT',   base_price: 612.30, volatility: 0.004, trend: -0.00003 },
];

class MockDataGenerator {
    constructor(config) {
        this.cfg = config;
        // 当前追踪的币对列表
        this.symbols = DEFAULT_SYMBOLS.slice();
        this.current_symbol = config.mock.symbol;
        // 每个币对的独立状态
        this.instances = {};
        this._init_all();
    }

    _init_all() {
        for (const s of this.symbols) this._ensure_instance(s.symbol, s);
    }

    _ensure_instance(symbol, s) {
        if (this.instances[symbol]) return;
        const now = Date.now();
        const ms_per_min = 60 * 1000;
        let price = s.base_price;
        const klines = [];
        const whaleHist = [];    // [{time, value}]
        const crowdHist = [];    // [{time, value}]
        const liqHist = [];      // [{time, below_amount, above_amount, high, low, open, close}]

        for (let i = 200; i >= 0; i--) {
            const ts = now - i * ms_per_min - ms_per_min;
            const k = this._make_kline(ts, price, s);
            klines.push(k);
            // 为每根 K 线生成对应的副图数据
            const whale = (Math.random() - 0.5) * 400000 * (Math.random() < 0.1 ? 3 : 1);
            whaleHist.push({ time: k.time, value: whale });
            crowdHist.push({ time: k.time, value: (Math.random() - 0.5) * 2.5 });
            const total = 1500000 + Math.random() * 3000000;
            const below_pct = 0.3 + Math.random() * 0.6;
            liqHist.push({
                time: k.time,
                below_amount: total * below_pct,
                above_amount: total * (1 - below_pct),
                high: k.high, low: k.low, open: k.open, close: k.close,
            });
            price = k.close;
        }

        this.instances[symbol] = {
            symbol,
            base_price: s.base_price,
            volatility: s.volatility,
            trend: s.trend * (Math.random() > 0.5 ? 1 : -1),
            price,
            klines,
            current_kline: null,
            minute_start: null,
            whaleHist,
            crowdHist,
            liqHist,
            score: 0,
            signal: 'HOLD',
        };
    }

    _make_kline(ts, prev_close, s) {
        const drift = s.trend;
        const shock = (Math.random() - 0.5) * 2 * s.volatility * prev_close;
        const wick = (Math.random() - 0.3) * s.volatility * prev_close * 0.5;
        const spike = Math.random() < 0.01 ? (Math.random() - 0.5) * 5 * s.volatility * prev_close : 0;
        const open  = prev_close;
        const close = prev_close + drift * prev_close + shock + spike;
        const high  = Math.max(open, close) + Math.abs(wick);
        const low   = Math.min(open, close) - Math.abs(wick);
        const volume = Math.max(1000, Math.random() * 80000);
        return { time: ts / 1000, open, high, low, close, volume };
    }

    /** 每秒推进所有币对 */
    tick() {
        const now = Date.now();
        const current_minute = Math.floor(now / 60000) * 60000;

        for (const inst of Object.values(this.instances)) {
            if (inst.minute_start !== current_minute) {
                if (inst.current_kline) {
                    inst.klines.push(inst.current_kline);
                    if (inst.klines.length > 500) inst.klines.shift();
                    inst.price = inst.current_kline.close;
                    // 生成这一分钟的副图数据
                    const w = (Math.random() - 0.5) * 400000 * (Math.random() < 0.12 ? 3 : 1);
                    inst.whaleHist.push({ time: inst.current_kline.time, value: w });
                    if (inst.whaleHist.length > 200) inst.whaleHist.shift();
                    const c = (Math.random() - 0.5) * 2.5;
                    inst.crowdHist.push({ time: inst.current_kline.time, value: c });
                    if (inst.crowdHist.length > 200) inst.crowdHist.shift();
                    const total = 1500000 + Math.random() * 3000000;
                    const bp = 0.3 + Math.random() * 0.6;
                    inst.liqHist.push({
                        time: inst.current_kline.time,
                        below_amount: total * bp,
                        above_amount: total * (1 - bp),
                        high: inst.current_kline.high,
                        low: inst.current_kline.low,
                        open: inst.current_kline.open,
                        close: inst.current_kline.close,
                    });
                    if (inst.liqHist.length > 200) inst.liqHist.shift();
                }
                inst.minute_start = current_minute;
                inst.current_kline = {
                    time: current_minute / 1000,
                    open: inst.price, high: inst.price, low: inst.price, close: inst.price, volume: 0,
                };
                if (Math.random() < 0.03) inst.trend *= -1;
            }
            // 更新当前 K 线
            const jitter = (Math.random() - 0.5) * inst.volatility * inst.price * 0.15;
            inst.current_kline.close = inst.price + jitter;
            inst.current_kline.high = Math.max(inst.current_kline.high, inst.current_kline.close);
            inst.current_kline.low  = Math.min(inst.current_kline.low, inst.current_kline.close);
            inst.current_kline.volume += Math.random() * 500;
        }
    }

    // ============================================================
    // 公共访问接口 (按币对)
    // ============================================================

    get_instance(symbol = this.current_symbol) {
        return this.instances[symbol];
    }

    get_current_kline(symbol = this.current_symbol) {
        return this.instances[symbol]?.current_kline;
    }

    get_history_klines(symbol = this.current_symbol) {
        return this.instances[symbol]?.klines.slice(-200) || [];
    }

    get_price(symbol = this.current_symbol) {
        return this.instances[symbol]?.price || 1;
    }

    /** 大户净流入历史 (副图用) */
    get_whale_history(symbol = this.current_symbol) {
        return this.instances[symbol]?.whaleHist.slice(-120) || [];
    }

    /** 拥挤度历史 (副图用) */
    get_crowd_history(symbol = this.current_symbol) {
        return this.instances[symbol]?.crowdHist.slice(-120) || [];
    }

    /** 清算热力图历史 (主图叠加用) */
    get_liq_history(symbol = this.current_symbol) {
        return this.instances[symbol]?.liqHist.slice(-120) || [];
    }

    /** 当前币对这一分钟的大户净流入 bucket (信号计算用) */
    get_whale_flow_bucket(symbol = this.current_symbol) {
        const inst = this.instances[symbol];
        if (!inst) return 0;
        const recent = inst.whaleHist.slice(-10);
        return recent.reduce((a, b) => a + b.value, 0);
    }

    get_liquidation_data(symbol = this.current_symbol) {
        const inst = this.instances[symbol];
        if (!inst || inst.liqHist.length === 0) return { below: 0, above: 0 };
        const last = inst.liqHist[inst.liqHist.length - 1];
        return { below: last.below_amount, above: last.above_amount };
    }

    get_crowding(symbol = this.current_symbol) {
        const inst = this.instances[symbol];
        if (!inst || inst.crowdHist.length === 0) return 0;
        return inst.crowdHist[inst.crowdHist.length - 1].value;
    }

    get_orderbook_snapshot(symbol = this.current_symbol) {
        const current = this.get_price(symbol);
        const spread = current * 0.0003;
        const asks = [], bids = [];
        for (let i = 0; i < 8; i++) {
            asks.push({
                price: current + spread + i * spread * 0.6,
                qty: 100 + Math.random() * 300 + (i === 3 && Math.random() < 0.15 ? 5000 : 0),
            });
            bids.push({
                price: current - spread - i * spread * 0.6,
                qty: 100 + Math.random() * 300 + (i === 4 && Math.random() < 0.15 ? 5000 : 0),
            });
        }
        return { bids, asks };
    }

    /** 获取所有币对的当前 score / signal (供币种管理和快达标列表) */
    get_all_results() {
        const out = {};
        for (const inst of Object.values(this.instances)) {
            out[inst.symbol] = { signal: inst.signal, score: inst.score };
        }
        return out;
    }

    set_symbol_result(symbol, score, signal) {
        if (this.instances[symbol]) {
            this.instances[symbol].score = score;
            this.instances[symbol].signal = signal;
        }
    }

    // ============================================================
    // 币种管理
    // ============================================================

    set_current(symbol) {
        if (this.instances[symbol]) this.current_symbol = symbol;
    }

    add_symbol(symbol, base_price = null) {
        symbol = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!symbol.endsWith('USDT')) symbol = symbol + 'USDT';
        if (this.instances[symbol]) return false;
        const price = base_price || (0.2 + Math.random() * 200);
        const vol = 0.005 + Math.random() * 0.01;
        this.symbols.push({ symbol, base_price: price, volatility: vol, trend: (Math.random() - 0.5) * 0.0002 });
        this._ensure_instance(symbol, this.symbols[this.symbols.length - 1]);
        return true;
    }

    remove_symbol(symbol) {
        if (this.symbols.length <= 1) return false;
        delete this.instances[symbol];
        this.symbols = this.symbols.filter(s => s.symbol !== symbol);
        if (this.current_symbol === symbol) {
            this.current_symbol = this.symbols[0].symbol;
        }
        return true;
    }

    get_symbols_list() {
        return this.symbols.map(s => ({ symbol: s.symbol, base_price: this.instances[s.symbol]?.base_price || s.base_price }));
    }
}

window.MockDataGenerator = MockDataGenerator;
