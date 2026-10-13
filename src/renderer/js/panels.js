/**
 * WhaleTracker - 面板渲染管理器 (全新重写)
 *
 * 负责:
 *   - 币种管理 (卡片列表 + 添加/删除)
 *   - 订单簿 + 评分分解 + 下单按钮 + 快达标信号
 *   - Score 历史曲线 (Chart.js)
 *   - 实时日志
 *   - 持仓列表 (当前 + 历史)
 */

class PanelManager {
    constructor() {
        this.charts = {};
        this.posHistory = [];  // 已平仓历史 [{symbol, side, entry, exit, pnl, time, reason}]
        this._init();
    }

    _init() {
        // Score 历史曲线
        Chart.defaults.color = '#8b949e';
        Chart.defaults.borderColor = '#30363d';
        Chart.defaults.font.family = '"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';
        Chart.defaults.font.size = 10;

        const score_ctx = document.getElementById('scoreHistoryChart')?.getContext('2d');
        if (score_ctx) {
            this.charts.score = new Chart(score_ctx, {
                type: 'line',
                data: { labels: [], datasets: [{
                    data: [],
                    borderColor: '#f2b94a',
                    backgroundColor: (ctx) => ctx.parsed?.y >= 0 ? 'rgba(38,166,154,0.22)' : 'rgba(239,83,80,0.22)',
                    fill: true,
                    tension: 0.25,
                    pointRadius: 0,
                    borderWidth: 1.5,
                }]},
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: { duration: 200 },
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { display: false },
                        y: { grid: { color: '#21262d' }, min: -100, max: 100, ticks: { stepSize: 50, font: { size: 9 } } },
                    },
                },
            });
        }
    }

    // ============================================================
    // 币种管理
    // ============================================================

    /** 渲染币种列表 */
    render_symbols(symbols, currentSymbol, results) {
        // symbols: [{symbol, base_price}]
        // results: { [symbol]: { signal, score } }
        const list = document.getElementById('symbolList');
        if (!list) return;

        document.getElementById('symbolCount').textContent = symbols.length;

        list.innerHTML = symbols.map(s => {
            const r = results[s.symbol] || { signal: 'HOLD', score: 0 };
            const isActive = s.symbol === currentSymbol;
            const sigColor = this._signal_color(r.signal);
            const scoreColor = r.score >= 25 ? '#26a69a' : (r.score <= -25 ? '#ef5350' : '#f2b94a');

            return `
                <div class="symbol-card group flex items-center justify-between px-2 py-1 rounded border cursor-pointer transition ${isActive ? 'bg-[#1c2333] border-blue-600' : 'bg-[#0d1117] border-gray-800 hover:border-gray-600'}"
                     data-symbol="${s.symbol}">
                    <div class="flex flex-col gap-0">
                        <span class="text-[11px] font-mono font-semibold ${isActive ? 'text-blue-400' : 'text-gray-300'}">${s.symbol}</span>
                        <span class="text-[10px] text-gray-500 font-mono">$${(s.base_price || 1).toFixed(4)}</span>
                    </div>
                    <div class="flex items-center gap-1.5">
                        <span class="text-[10px] font-bold font-mono" style="color:${sigColor}">${r.signal.slice(0,3)}</span>
                        <span class="text-[10px] font-mono" style="color:${scoreColor}">${r.score >= 0 ? '+' : ''}${r.score.toFixed(0)}</span>
                        <button class="btn-del-symbol opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 text-[10px] px-1 transition" data-symbol="${s.symbol}" ${symbols.length <= 1 ? 'disabled' : ''}>✕</button>
                    </div>
                </div>
            `;
        }).join('');

        // 绑定点击切换
        list.querySelectorAll('.symbol-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('.btn-del-symbol')) return;
                const sym = card.dataset.symbol;
                if (sym !== currentSymbol) {
                    document.dispatchEvent(new CustomEvent('wt:switch-symbol', { detail: sym }));
                }
            });
        });

        // 绑定删除
        list.querySelectorAll('.btn-del-symbol').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const sym = btn.dataset.symbol;
                document.dispatchEvent(new CustomEvent('wt:remove-symbol', { detail: sym }));
            });
        });
    }

    _signal_color(sig) {
        return {
            'STRONG_BUY':  '#26a69a',
            'BUY':         '#5dd4b5',
            'STRONG_SELL': '#ef5350',
            'SELL':        '#f28a8a',
            'HOLD':        '#8b949e',
        }[sig] || '#8b949e';
    }

    // ============================================================
    // 订单簿
    // ============================================================

    update_orderbook(snapshot, symbol) {
        const asks_div = document.getElementById('asksList');
        const bids_div = document.getElementById('bidsList');
        if (!asks_div || !bids_div) return;

        if (symbol) document.getElementById('obSymbolLabel').textContent = symbol.replace('USDT','/USDT');

        const max_qty = Math.max(
            ...snapshot.asks.slice(0, 6).map(r => r.qty),
            ...snapshot.bids.slice(0, 6).map(r => r.qty),
            1
        );

        // Spread
        const topAsk = snapshot.asks[0]?.price || 0;
        const topBid = snapshot.bids[0]?.price || 0;
        if (topAsk > 0 && topBid > 0) {
            const spread = ((topAsk - topBid) / topAsk * 100).toFixed(3);
            document.getElementById('spreadLabel').textContent = `Spread ${spread}%`;
        }

        asks_div.innerHTML = snapshot.asks.slice(0, 6).reverse().map(r => `
            <div class="ob-row ask ob-row-plain">
                <span class="ob-price font-mono">$${r.price.toFixed(2)}</span>
                <span class="ob-qty font-mono text-right">${r.qty.toFixed(0)}</span>
            </div>
        `).join('');

        bids_div.innerHTML = snapshot.bids.slice(0, 6).map(r => `
            <div class="ob-row bid ob-row-plain">
                <span class="ob-price font-mono">$${r.price.toFixed(2)}</span>
                <span class="ob-qty font-mono text-right">${r.qty.toFixed(0)}</span>
            </div>
        `).join('');
    }

    // ============================================================
    // 评分分解 + 顶部信号 / 副图图例
    // ============================================================

    update_scores(r) {
        if (!r) return;

        // 评分分解面板
        document.getElementById('detailWhale').textContent = r.whale.toFixed(0);
        document.getElementById('detailLiq').textContent   = r.liq.toFixed(0);
        document.getElementById('detailCrowd').textContent = r.crowd.toFixed(0);
        document.getElementById('detailOb').textContent    = r.ob.toFixed(0);
        const total = r.total.toFixed(1);
        const total_el = document.getElementById('detailTotal');
        total_el.textContent = (r.total >= 0 ? '+' : '') + total;
        total_el.className = 'text-base font-bold font-mono ' +
            (r.total >= 25 ? 'text-emerald-400' : (r.total <= -25 ? 'text-red-400' : 'text-yellow-400'));

        // 顶部信号 label
        const sig_el = document.getElementById('currentSignal');
        sig_el.textContent = r.signal;
        sig_el.style.color = this._signal_color(r.signal);

        const score_label = document.getElementById('totalScoreLabel');
        score_label.textContent = (r.total >= 0 ? '+' : '') + total;
        score_label.style.color = r.total >= 25 ? '#26a69a' : (r.total <= -25 ? '#ef5350' : '#f2b94a');

        // K线右上角浮层
        const overlay_score = document.getElementById('overlayScore');
        if (overlay_score) {
            overlay_score.textContent = (r.total >= 0 ? '+' : '') + total;
            overlay_score.style.color = score_label.style.color;
        }
    }

    /** 更新 K 线图底部副图图例 */
    update_overlay_indicators(whale_bucket, crowd_z) {
        const whale_el = document.getElementById('overlayWhale');
        if (whale_el) {
            const k = whale_bucket / 1000;
            const sign = k >= 0 ? '+' : '';
            whale_el.textContent = `${sign}${k.toFixed(0)}k`;
            whale_el.style.color = whale_bucket >= 0 ? '#26a69a' : '#ef5350';
        }
        const crowd_el = document.getElementById('overlayCrowd');
        if (crowd_el) {
            crowd_el.textContent = (crowd_z >= 0 ? '+' : '') + crowd_z.toFixed(2);
            crowd_el.style.color = Math.abs(crowd_z) > 1.5 ? '#ef5350' : '#a371f7';
        }
    }

    // ============================================================
    // 快达标信号列表 (监控中其它币对)
    // ============================================================

    update_near_signals(results, currentSymbol) {
        // results: { [symbol]: { signal, score } }
        const list = document.getElementById('nearSignalList');
        const count_el = document.getElementById('nearSignalCount');
        if (!list) return;

        // 筛选: HOLD 但接近 25 / -25 阈值 (abs score >= 15 且 < 25)
        const near = Object.entries(results)
            .filter(([sym, r]) => sym !== currentSymbol)
            .map(([sym, r]) => ({ sym, score: r.score, signal: r.signal }))
            .filter(x => x.signal === 'HOLD' && Math.abs(x.score) >= 12 && Math.abs(x.score) < 25)
            .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
            .slice(0, 5);

        if (count_el) count_el.textContent = near.length;

        if (near.length === 0) {
            list.innerHTML = '<div class="text-gray-600 text-center py-1">— 暂无接近信号阈值的币对 —</div>';
            return;
        }

        list.innerHTML = near.map(n => {
            const pct = Math.abs(n.score) / 25 * 100;
            const dir = n.score > 0 ? '偏多' : '偏空';
            const color = n.score > 0 ? '#26a69a' : '#ef5350';
            const bg = n.score > 0 ? 'rgba(38,166,154,' : 'rgba(239,83,80,';
            return `
                <div class="near-signal-row ob-row-plain flex items-center justify-between px-1 py-0.5 rounded border border-gray-800 hover:border-gray-600 cursor-pointer font-mono" data-symbol="${n.sym}">
                    <span class="text-gray-300">${n.sym}</span>
                    <span class="text-[9px]" style="color:${color}">${dir}</span>
                    <span class="text-[10px] w-8 text-right" style="color:${color}">${n.score >= 0 ? '+' : ''}${n.score.toFixed(0)}</span>
                </div>
            `;
        }).join('');

        // 点击切换当前图
        list.querySelectorAll('.near-signal-row').forEach(row => {
            row.addEventListener('click', () => {
                document.dispatchEvent(new CustomEvent('wt:switch-symbol', { detail: row.dataset.symbol }));
            });
        });
    }

    // ============================================================
    // Score 历史
    // ============================================================

    update_score_history(values) {
        if (!this.charts.score) return;
        // values: [{ t, score }]
        const data = values.slice(-90);
        this.charts.score.data.labels = data.map(v => {
            const d = new Date(v.t);
            return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        });
        this.charts.score.data.datasets[0].data = data.map(v => v.score);
        this.charts.score.update('none');
    }

    // ============================================================
    // 实时日志
    // ============================================================

    append_log(type, msg) {
        const log = document.getElementById('signalLog');
        if (!log) return;
        const now = new Date();
        const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

        const line = document.createElement('div');
        line.className = 'log-line';
        line.innerHTML = `
            <span class="log-time">${time}</span>
            <span class="log-type ${type}">${type}</span>
            <span class="log-msg">${msg}</span>
        `;
        log.appendChild(line);
        while (log.childElementCount > 300) log.removeChild(log.firstChild);
        log.scrollTop = log.scrollHeight;
    }

    // ============================================================
    // 持仓面板
    // ============================================================

    update_position_panel(engine, currentSymbol, currentPrice) {
        const openCard = document.getElementById('openPositionCard');
        const noMsg    = document.getElementById('noPositionMsg');

        if (engine.state.pos === 'FLAT') {
            openCard.classList.add('hidden');
            noMsg.classList.remove('hidden');
        } else {
            openCard.classList.remove('hidden');
            noMsg.classList.add('hidden');

            const side = engine.state.pos;
            const pct = side === 'LONG'
                ? ((currentPrice - engine.state.entry) / engine.state.entry * 100)
                : ((engine.state.entry - currentPrice) / engine.state.entry * 100);

            document.getElementById('posSymbol').textContent = currentSymbol;
            document.getElementById('posSide').textContent = side;
            document.getElementById('posSide').className = 'font-mono font-bold ' +
                (side === 'LONG' ? 'text-green-400' : 'text-red-400');
            document.getElementById('posEntry').textContent = '$' + engine.state.entry.toFixed(4);
            document.getElementById('posCurrent').textContent = '$' + currentPrice.toFixed(4);
            document.getElementById('posSize').textContent = `${engine.state.size}% · 3x`;

            const pnl_el = document.getElementById('posPnl');
            pnl_el.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
            pnl_el.className = 'font-bold font-mono ' + (pct >= 0 ? 'text-green-400' : 'text-red-400');
        }

        // 历史列表
        document.getElementById('historyCount').textContent = this.posHistory.length;
        const hist = document.getElementById('positionHistory');
        if (this.posHistory.length === 0) {
            hist.innerHTML = '<div class="text-center text-[10px] text-gray-600 py-2">— 暂无历史 —</div>';
        } else {
            hist.innerHTML = this.posHistory.slice(-15).reverse().map(p => {
                const sideColor = p.side === 'LONG' ? '#26a69a' : '#ef5350';
                const pnlColor = p.pnl >= 0 ? '#26a69a' : '#ef5350';
                return `
                    <div class="flex items-center justify-between px-2 py-1 rounded bg-[#0d1117] border border-gray-800 text-[10px]">
                        <div class="flex flex-col">
                            <div class="flex items-center gap-1">
                                <span class="font-mono font-semibold text-gray-300">${p.symbol}</span>
                                <span style="color:${sideColor}" class="font-bold">${p.side.slice(0,3)}</span>
                            </div>
                            <span class="text-gray-600">${p.reason}</span>
                        </div>
                        <span class="font-mono font-bold" style="color:${pnlColor}">${p.pnl >= 0 ? '+' : ''}${p.pnl.toFixed(2)}%</span>
                    </div>
                `;
            }).join('');
        }

        // 总 PnL
        const total = this.posHistory.reduce((s, p) => s + p.pnl, 0);
        const totalEl = document.getElementById('totalPnlLabel');
        totalEl.textContent = (total >= 0 ? '+' : '') + total.toFixed(2) + '%';
        totalEl.style.color = total >= 0 ? '#26a69a' : '#ef5350';
    }

    /** 记录平仓 */
    record_close(pos, symbol, entry, exitPrice, reason) {
        const side = pos;
        const pnl = side === 'LONG'
            ? ((exitPrice - entry) / entry * 100)
            : ((entry - exitPrice) / entry * 100);
        this.posHistory.push({
            symbol,
            side,
            entry,
            exit: exitPrice,
            pnl,
            time: Date.now(),
            reason,
        });
    }
}

window.PanelManager = PanelManager;
