/**
 * WhaleTracker - 主应用入口 (全新重写)
 *
 * 负责:
 *   - 布局 (65% K线+副图 / 35% 4面板+日志)
 *   - 多币对模拟数据驱动 + 信号计算
 *   - 当前币对的 K 线 + 副图指标渲染循环
 *   - 币种管理 (添加/删除/切换)
 *   - 参数热更新 + 自动交易开关
 *   - 快捷下单按钮 + 手动平仓
 */

document.addEventListener('DOMContentLoaded', () => {

    // ============================================================
    // 1. 布局 (JS 硬算, 避免 flex-grow 问题)
    // ============================================================
    function relayout() {
        const header = document.querySelector('header');
        const totalH = window.innerHeight - header.offsetHeight;
        const top    = document.getElementById('topSection');
        const mid    = document.getElementById('bottomSection');
        top.style.height = (totalH * 0.62) + 'px';
        mid.style.height = (totalH * 0.38) + 'px';
        if (window.__chartInstance) {
            const c = window.__chartInstance;
            c.chart.applyOptions({
                width:  top.offsetWidth,
                height: top.offsetHeight,
            });
        }
    }
    window.addEventListener('load',   relayout);
    window.addEventListener('resize', relayout);
    requestAnimationFrame(relayout);

    // ============================================================
    // 2. 组件初始化
    // ============================================================
    const chart  = new KLineChart('chart');
    const panels = new PanelManager();
    const mock   = new MockDataGenerator(CONFIG);
    const engines = {};   // 每个币对独立 engine
    const score_history = [];

    // 为每个币对创建 engine
    for (const s of mock.get_symbols_list()) {
        engines[s.symbol] = new SignalEngine(CONFIG);
    }

    // 暴露到 window (给 relayout 用)
    window.__chartInstance = chart;

    let currentSymbol = mock.current_symbol;
    let prev_ob_snapshot = null;
    let prev_minute = null;

    // ============================================================
    // 3. 主币对切换 + 初始化
    // ============================================================
    function load_symbol(symbol) {
        currentSymbol = symbol;
        mock.set_current(symbol);

        // 清 K 线标记
        chart.clear_markers();

        // 载入 K 线 + EMA
        chart.set_ema(CONFIG.chart.ema_short, CONFIG.chart.ema_long);
        chart.set_klines(mock.get_history_klines(symbol));

        // 载入副图历史
        chart.set_whale_flow(mock.get_whale_history(symbol));
        chart.set_crowding(mock.get_crowd_history(symbol));
        chart.set_liq_heatmap(mock.get_liq_history(symbol));

        // 刷新订单簿
        panels.update_orderbook(mock.get_orderbook_snapshot(symbol), symbol);

        // 刷新顶栏 select
        const sel = document.getElementById('symbolSelect');
        if (sel) sel.value = symbol;

        // 日志
        panels.append_log('info', `切换币对 → ${symbol}`);
    }

    // 初始填充所有 K 线数据
    load_symbol(currentSymbol);
    requestAnimationFrame(() => chart.chart.timeScale().fitContent());

    // 初始日志
    panels.append_log('system',  'WhaleTracker v1.1 启动成功');
    panels.append_log('info',    `数据源: Mock (多币对模拟) · 初始 ${mock.get_symbols_list().length} 个币对`);
    panels.append_log('info',    `自动交易: ${CONFIG.auto_trade.enabled ? '✅ 已开启 (≥ '+CONFIG.auto_trade.min_score+' 分自动下单)' : '⏸ 默认关闭, 可在参数面板开启'}`);

    // 初始渲染币种列表
    const initialResults = {};
    for (const sym of Object.keys(engines)) initialResults[sym] = { signal: 'HOLD', score: 0 };
    panels.render_symbols(mock.get_symbols_list(), currentSymbol, initialResults);

    // 顶栏 select 填充
    const symbolSelect = document.getElementById('symbolSelect');
    symbolSelect.innerHTML = mock.get_symbols_list()
        .map(s => `<option value="${s.symbol}">${s.symbol.replace('USDT',' / USDT')}</option>`)
        .join('');
    symbolSelect.value = currentSymbol;

    // ============================================================
    // 4. 主循环
    // ============================================================
    function main_loop() {
        const now = Date.now();
        const now_minute = Math.floor(now / 60000) * 60000;

        // 每秒推进所有币对
        mock.tick();

        // ===== 当前币对的实时渲染 =====
        const cur = mock.get_current_kline(currentSymbol);
        if (cur) chart.update_kline(cur);

        // 副图实时刷新 (每秒)
        const w_hist = mock.get_whale_history(currentSymbol);
        const c_hist = mock.get_crowd_history(currentSymbol);
        const l_hist = mock.get_liq_history(currentSymbol);
        const last_w = w_hist[w_hist.length - 1];
        const last_c = c_hist[c_hist.length - 1];
        const last_l = l_hist[l_hist.length - 1];
        if (last_w) chart.update_whale_flow(last_w.time, last_w.value);
        if (last_c) chart.update_crowding(last_c.time, last_c.value);
        if (last_l && cur) chart.update_liq_heatmap(last_l);

        // 当前价浮层
        const inst = mock.get_instance(currentSymbol);
        if (inst) {
            const price_el = document.getElementById('currentPrice');
            const price = inst.price;
            price_el.textContent = price.toFixed(price > 100 ? 2 : 4);
            // 模拟涨跌幅 (相对 200 根 K 线前)
            const klines = mock.get_history_klines(currentSymbol);
            if (klines.length > 10) {
                const ref = klines[klines.length - 10].close;
                const pct = (price - ref) / ref * 100;
                const pc_el = document.getElementById('priceChange');
                pc_el.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
                pc_el.style.color = pct >= 0 ? '#26a69a' : '#ef5350';
            }
        }

        // 每秒刷订单簿 (随机高频)
        if (Math.random() < 0.2) panels.update_orderbook(mock.get_orderbook_snapshot(currentSymbol), currentSymbol);

        // K 线副图图例
        panels.update_overlay_indicators(
            mock.get_whale_flow_bucket(currentSymbol),
            mock.get_crowding(currentSymbol)
        );

        // ===== 每分钟整点: 所有币对信号计算 =====
        if (prev_minute !== now_minute && prev_minute !== null) {
            run_signal_cycle(now);
        }
        prev_minute = now_minute;

        requestAnimationFrame(main_loop);
    }

    function run_signal_cycle(now_ms) {
        const current_price = mock.get_price(currentSymbol);
        const all_results = mock.get_all_results();

        // 对每个币对算一次
        for (const sym of Object.keys(engines)) {
            const engine = engines[sym];
            const whale_bucket = mock.get_whale_flow_bucket(sym);
            const liq_data = mock.get_liquidation_data(sym);
            const crowd_z = mock.get_crowding(sym);
            const ob_cur = mock.get_orderbook_snapshot(sym);
            const prev_ob = prev_ob_snapshot;
            const price = mock.get_price(sym);

            const result = engine.full_cycle(
                whale_bucket, liq_data, crowd_z,
                ob_cur, prev_ob, now_ms, price,
            );

            mock.set_symbol_result(sym, result.total, result.signal);
            all_results[sym] = { signal: result.signal, score: result.total };

            // 自动交易 (只对当前币对生效, 且状态机允许)
            if (sym === currentSymbol) {
                check_auto_trade(result, price, engine);
            }

            // 手动/自动平仓检查
            const exit = engine.check_exit(price, now_ms);
            if (exit) {
                panels.record_close(engine.state.pos, sym, engine.state.entry, price, exit.reason);
                engine.close_position();
                if (sym === currentSymbol) {
                    panels.append_log('warn', `${sym} · ${exit.reason}, 平${engine.state.pos === 'LONG' ? '多' : '空'} @ $${price.toFixed(2)}`);
                }
            }
        }
        prev_ob_snapshot = mock.get_orderbook_snapshot(currentSymbol);

        // ===== 刷新当前币对的 UI =====
        const cur_engine = engines[currentSymbol];
        const cur_whale = mock.get_whale_flow_bucket(currentSymbol);
        const cur_crowd = mock.get_crowding(currentSymbol);
        const cur_liq = mock.get_liquidation_data(currentSymbol);
        const cur_ob = mock.get_orderbook_snapshot(currentSymbol);
        const cur_result = cur_engine.full_cycle(
            cur_whale, cur_liq, cur_crowd,
            cur_ob, prev_ob_snapshot, now_ms, current_price,
        );

        panels.update_scores(cur_result);

        // Score 历史 (只记当前币对)
        score_history.push({ t: now_ms, score: cur_result.total });
        if (score_history.length > 90) score_history.shift();
        panels.update_score_history(score_history);

        // 日志
        panels.append_log('system', `新一分钟 | ${currentSymbol} · Score ${cur_result.total.toFixed(1)} | 大户$${cur_whale.toLocaleString()}`);

        if (cur_result.signal !== 'HOLD') {
            panels.append_log('buy', `${cur_result.signal} · ${cur_result.reason} | Score ${cur_result.total.toFixed(1)}`);
            // K 线标记
            const last_kline = mock.get_history_klines(currentSymbol).slice(-1)[0];
            if (last_kline) {
                const dir = cur_result.signal.includes('BUY') ? 'buy' : 'sell';
                chart.add_marker(last_kline.time, current_price, dir, dir === 'buy' ? 'B' : 'S');
            }
            // 系统通知
            if (window.electronAPI) {
                window.electronAPI.showNotification('WhaleTracker 交易信号',
                    `${cur_result.signal} · ${cur_result.reason}`);
            }
        }

        // ===== 刷新所有面板 =====
        panels.render_symbols(mock.get_symbols_list(), currentSymbol, all_results);
        panels.update_near_signals(all_results, currentSymbol);
        panels.update_position_panel(cur_engine, currentSymbol, current_price);
    }

    function check_auto_trade(result, price, engine) {
        if (!CONFIG.auto_trade.enabled) return;
        if (engine.state.pos !== 'FLAT') return;
        if ((result.signal === 'STRONG_BUY' || result.signal === 'STRONG_SELL') &&
            Math.abs(result.total) >= CONFIG.auto_trade.min_score) {
            const side = result.signal.includes('BUY') ? 'LONG' : 'SHORT';
            engine.open_position(side, price, CONFIG.thresholds.position_pct, Date.now());
            panels.append_log('buy', `🔔 自动下单 · 开${side === 'LONG' ? '多' : '空'} @ $${price.toFixed(2)} | Score ${result.total.toFixed(1)}`);
            if (window.electronAPI) {
                window.electronAPI.showNotification('WhaleTracker 自动下单',
                    `${side === 'LONG' ? '🟢 开多' : '🔴 开空'} · $${price.toFixed(2)}`);
            }
        }
    }

    // ============================================================
    // 5. 事件绑定
    // ============================================================

    // 切换币对 (自定义事件, 从 panels.render_symbols 里派发)
    document.addEventListener('wt:switch-symbol', (e) => {
        if (e.detail && e.detail !== currentSymbol) load_symbol(e.detail);
    });

    // 顶栏 select 切换
    symbolSelect.addEventListener('change', (e) => {
        if (e.target.value !== currentSymbol) load_symbol(e.target.value);
    });

    // 删除币对
    document.addEventListener('wt:remove-symbol', (e) => {
        const sym = e.detail;
        if (mock.remove_symbol(sym)) {
            // 同步顶栏 select
            symbolSelect.innerHTML = mock.get_symbols_list()
                .map(s => `<option value="${s.symbol}">${s.symbol.replace('USDT',' / USDT')}</option>`)
                .join('');
            symbolSelect.value = currentSymbol;
            panels.append_log('info', `已移除币对 ${sym}`);
            // 删完如果当前显示的币对变了
            if (!engines[sym]) {
                // mock 内部已切换, 重新 load
                load_symbol(mock.current_symbol);
            }
            panels.render_symbols(mock.get_symbols_list(), currentSymbol, mock.get_all_results());
            panels.update_near_signals(mock.get_all_results(), currentSymbol);
        }
    });

    // 添加新币对
    document.getElementById('btnAddSymbol').addEventListener('click', add_new_symbol);
    document.getElementById('newSymbolInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') add_new_symbol();
    });

    function add_new_symbol() {
        const input = document.getElementById('newSymbolInput');
        const raw = input.value.trim().toUpperCase();
        if (!raw) return;
        const ok = mock.add_symbol(raw);
        if (ok) {
            const sym = raw.endsWith('USDT') ? raw : raw + 'USDT';
            engines[sym] = new SignalEngine(CONFIG);
            symbolSelect.innerHTML = mock.get_symbols_list()
                .map(s => `<option value="${s.symbol}">${s.symbol.replace('USDT',' / USDT')}</option>`)
                .join('');
            panels.render_symbols(mock.get_symbols_list(), currentSymbol, mock.get_all_results());
            panels.append_log('info', `已添加币对 ${sym}`);
        } else {
            panels.append_log('warn', `币对已存在或无效: ${raw}`);
        }
        input.value = '';
    }

    // ===== 参数热更新 =====
    const param_inputs = ['emaShort', 'emaLong', 'whaleThreshold', 'cooldown', 'stopLoss', 'takeProfit', 'positionPct'];

    function read_params() {
        const d = {};
        for (const id of param_inputs) {
            const el = document.getElementById(id);
            if (el) d[id] = parseFloat(el.value);
        }
        return d;
    }

    function apply_params() {
        const d = read_params();
        // EMA
        CONFIG.chart.ema_short = d.emaShort;
        CONFIG.chart.ema_long  = d.emaLong;
        chart.set_ema(d.emaShort, d.emaLong);
        chart._update_emas(mock.get_history_klines(currentSymbol));
        // 阈值
        CONFIG.thresholds.whale_usdt_threshold = d.whaleThreshold;
        CONFIG.thresholds.cooldown_minutes     = d.cooldown;
        CONFIG.thresholds.stop_loss_pct        = d.stopLoss;
        CONFIG.thresholds.take_profit_pct      = d.takeProfit;
        CONFIG.thresholds.position_pct         = d.positionPct;
        // 持久化
        if (window.electronAPI) {
            window.electronAPI.saveConfig('params', d);
        }
        panels.append_log('info', `参数已应用: EMA(${d.emaShort}/${d.emaLong}) · 大户≥$${d.whaleThreshold} · 冷却${d.cooldown}m · 止损${d.stopLoss}% · 目标${d.takeProfit}% · 仓位${d.positionPct}%`);
    }

    function reset_params() {
        const defaults = { emaShort: 9, emaLong: 55, whaleThreshold: 50000, cooldown: 20, stopLoss: 1.0, takeProfit: 6.0, positionPct: 15 };
        for (const [id, val] of Object.entries(defaults)) {
            const el = document.getElementById(id);
            if (el) el.value = val;
        }
        apply_params();
        panels.append_log('info', '参数已重置为默认值');
    }

    document.getElementById('applyParams').addEventListener('click', apply_params);
    document.getElementById('resetParams').addEventListener('click', reset_params);
    for (const id of param_inputs) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply_params(); });
    }

    // ===== 自动交易开关 =====
    document.getElementById('autoTradeEnabled').addEventListener('change', (e) => {
        CONFIG.auto_trade.enabled = e.target.checked;
        panels.append_log('info', `自动交易 ${e.target.checked ? '✅ 已开启 (≥ '+CONFIG.auto_trade.min_score+' 自动下单)' : '⏸ 已关闭'}`);
        if (window.electronAPI) {
            window.electronAPI.saveConfig('autoTrade', e.target.checked);
        }
    });

    // ===== 快捷下单 =====
    document.getElementById('btnQuickBuy').addEventListener('click', () => quick_trade('LONG'));
    document.getElementById('btnQuickSell').addEventListener('click', () => quick_trade('SHORT'));

    function quick_trade(side) {
        const engine = engines[currentSymbol];
        if (engine.state.pos !== 'FLAT') {
            panels.append_log('warn', `已有持仓 (${engine.state.pos}), 手动平仓后再开新仓`);
            return;
        }
        const price = mock.get_price(currentSymbol);
        engine.open_position(side, price, CONFIG.thresholds.position_pct, Date.now());
        panels.append_log('buy', `👤 手动开${side === 'LONG' ? '多' : '空'} · ${currentSymbol} @ $${price.toFixed(2)} · 仓位 ${CONFIG.thresholds.position_pct}%`);
        panels.update_position_panel(engine, currentSymbol, price);
    }

    // ===== 手动平仓 =====
    document.getElementById('btnClosePos').addEventListener('click', () => {
        const engine = engines[currentSymbol];
        if (engine.state.pos === 'FLAT') return;
        const price = mock.get_price(currentSymbol);
        panels.record_close(engine.state.pos, currentSymbol, engine.state.entry, price, '手动平仓');
        panels.append_log('warn', `👤 手动平仓 ${engine.state.pos} · ${currentSymbol} @ $${price.toFixed(2)}`);
        engine.close_position();
        panels.update_position_panel(engine, currentSymbol, price);
    });

    // ===== 清空日志 =====
    document.getElementById('btnClearLog').addEventListener('click', () => {
        document.getElementById('signalLog').innerHTML = '';
    });

    // ===== 信号列表 header 里的 Score / 日志 toggle 按钮 =====
    (function initFooterToggle() {
        const footer = document.getElementById('bottomFooter');
        const btnS   = document.getElementById('btnToggleScore');
        const btnL   = document.getElementById('btnToggleLog');
        if (!footer || !btnS || !btnL) return;

        const EXPANDED_H = 120;
        let visible = false;

        function setBtnActive(btn, active) {
            if (active) {
                btn.classList.remove('bg-gray-800', 'text-gray-300');
                btn.classList.add('bg-blue-600', 'text-white', 'border-blue-500');
            } else {
                btn.classList.add('bg-gray-800', 'text-gray-300');
                btn.classList.remove('bg-blue-600', 'text-white', 'border-blue-500');
            }
        }

        function toggleFooter() {
            visible = !visible;
            footer.style.height = visible ? EXPANDED_H + 'px' : '0px';
            footer.style.borderTop = visible ? '1px solid #30363d' : 'none';
            footer.dataset.expanded = visible;
            setBtnActive(btnS, visible);
            setBtnActive(btnL, visible);
        }

        btnS.addEventListener('click', toggleFooter);
        btnL.addEventListener('click', toggleFooter);
        setBtnActive(btnS, false);
        setBtnActive(btnL, false);
    })();

    // ===== 持久化恢复 =====
    if (window.electronAPI) {
        const saved = window.electronAPI.loadConfig('params', null);
        if (saved) {
            for (const [id, val] of Object.entries(saved)) {
                const el = document.getElementById(id);
                if (el) el.value = val;
            }
        }
        const auto = window.electronAPI.loadConfig('autoTrade', null);
        if (auto === true) {
            CONFIG.auto_trade.enabled = true;
            const cb = document.getElementById('autoTradeEnabled');
            if (cb) cb.checked = true;
        }
    }

    // ============================================================
    // 6. Electron 菜单事件
    // ============================================================
    if (window.electronAPI) {
        window.electronAPI.onMenu('menu:export-log', () => {
            const lines = document.querySelectorAll('#signalLog .log-line');
            const text = Array.from(lines).map(l => l.textContent).join('\n');
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `whaletracker-log-${new Date().toISOString().slice(0,10)}.txt`;
            a.click();
            URL.revokeObjectURL(url);
            panels.append_log('info', '日志已导出');
        });
    }

    // ============================================================
    // 7. 启动
    // ============================================================
    panels.append_log('system', '主循环已启动 (每秒 tick, 每分钟全币对计算)');
    main_loop();
});
