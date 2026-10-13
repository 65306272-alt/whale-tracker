/**
 * WhaleTracker - K线图 (TradingView Lightweight Charts)
 *
 * 主图: K线 + EMA双均线 + 买卖标记
 * 副图叠加 (同一 canvas 内):
 *   - 成交量 Histogram
 *   - 大户净流入 Histogram (绿=净流入 红=净流出)
 *   - 多空拥挤度 Line (紫)
 *   - 清算热力图 Histogram (在主 price scale 上半透明叠加)
 */

class KLineChart {
    constructor(container_id) {
        this.container = document.getElementById(container_id);
        this.chart = null;
        this.candleSeries = null;
        this.emaShortSeries = null;
        this.emaLongSeries = null;
        this.volumeSeries = null;
        this.whaleFlowSeries = null;
        this.crowdingSeries = null;
        this.liqBelowSeries = null;   // 下方清算压力 = 多头危险
        this.liqAboveSeries = null;   // 上方清算压力 = 空头危险
        this.markers = [];

        this._whaleHist = [];   // {time, value} 大户净流入历史
        this._crowdHist = [];   // {time, value} 拥挤度历史
        this._liqHist = [];     // {time, below, above} 清算压力历史

        this.init();
    }

    init() {
        const root = this.container;
        root.innerHTML = '';

        // 创建图表 - 主 scale 占据上半 + 副图占据下半
        this.chart = LightweightCharts.createChart(root, {
            width:  root.clientWidth,
            height: root.clientHeight,
            layout: {
                background: { type: 'solid', color: '#0d1117' },
                textColor: '#8b949e',
                fontFamily: '"SF Pro Display", "PingFang SC", "Microsoft YaHei", sans-serif',
            },
            grid: {
                vertLines: { color: '#21262d' },
                horzLines: { color: '#21262d' },
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Magnet,
                vertLine: { color: '#4d8bf0', width: 1, style: 2 },
                horzLine: { color: '#4d8bf0', width: 1, style: 2 },
            },
            rightPriceScale: {
                borderColor: '#30363d',
                // 主 K 线区域占上半 (0.05 ~ 0.52)
                scaleMargins: { top: 0.05, bottom: 0.48 },
            },
            timeScale: {
                borderColor: '#30363d',
                timeVisible: true,
                secondsVisible: false,
            },
            handleScroll: true,
            handleScale: true,
        });

        // ====== 主图 K线 ======
        this.candleSeries = this.chart.addCandlestickSeries({
            upColor:     '#26a69a',
            downColor:   '#ef5350',
            borderColor: '#30363d',
            borderUpColor:   '#26a69a',
            borderDownColor: '#ef5350',
            wickUpColor:     '#26a69a',
            wickDownColor:   '#ef5350',
            priceScaleId: 'right',
        });

        // EMA 短期 (黄)
        this.emaShortSeries = this.chart.addLineSeries({
            color: '#f2b94a',
            lineWidth: 2,
            priceScaleId: 'right',
            priceLineVisible: false,
            lastValueVisible: false,
        });

        // EMA 长期 (蓝)
        this.emaLongSeries = this.chart.addLineSeries({
            color: '#4d8bf0',
            lineWidth: 2,
            priceScaleId: 'right',
            priceLineVisible: false,
            lastValueVisible: false,
        });

        // ====== 清算热力图 (叠加在主 price scale 上) ======
        // 用 Histogram 在主 scale 上画半透明柱, 显示每根 K 线对应的清算压力方向
        // below (多头危险) = 红柱向下延伸 (负 value)
        // above (空头危险) = 绿柱向上延伸 (正 value)
        this.liqHeatmapSeries = this.chart.addHistogramSeries({
            priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
            priceScaleId: 'right',
            priceLineVisible: false,
            lastValueVisible: false,
            color: 'rgba(239, 83, 80, 0.35)',   // 默认红, 动态覆盖
        });

        // ====== 成交量副图 (独立 scale '') ======
        this.volumeSeries = this.chart.addHistogramSeries({
            priceFormat: { type: 'volume' },
            priceScaleId: 'vol',
            color: '#30363d',
            priceLineVisible: false,
            lastValueVisible: false,
        });

        // 设置成交量 scale 位置: 副图区上方 (独立, 小区域)
        this.chart.priceScale('vol').applyOptions({
            scaleMargins: { top: 0.53, bottom: 0.35 },
        });

        // ====== 大户净流入 Histogram + 拥挤度 Line 共用独立 scale ======
        this.whaleFlowSeries = this.chart.addHistogramSeries({
            priceFormat: { type: 'volume' },
            priceScaleId: 'sub',
            priceLineVisible: false,
            lastValueVisible: false,
        });

        this.crowdingSeries = this.chart.addLineSeries({
            color: '#a371f7',
            lineWidth: 1.5,
            priceScaleId: 'sub',
            priceLineVisible: false,
            lastValueVisible: false,
        });

        // 副图 scale 位置: 大户净流入 + 拥挤度在底部大区域
        this.chart.priceScale('sub').applyOptions({
            scaleMargins: { top: 0.37, bottom: 0.02 },
        });

        // 自适应窗口
        this._resizeObserver = new ResizeObserver(entries => {
            for (const e of entries) {
                this.chart.applyOptions({
                    width:  e.contentRect.width,
                    height: e.contentRect.height,
                });
            }
        });
        this._resizeObserver.observe(this.container);
    }

    // ============================================================
    // 核心 set / update
    // ============================================================

    /**
     * 填入历史 K 线
     * @param klines [{ time, open, high, low, close, volume }]
     */
    set_klines(klines) {
        if (!klines || klines.length === 0) return;

        const candles = klines.map(k => ({
            time: k.time,
            open: k.open, high: k.high, low: k.low, close: k.close,
        }));
        this.candleSeries.setData(candles);

        const vol = klines.map(k => ({
            time:  k.time,
            value: k.volume,
            color: k.close >= k.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
        }));
        this.volumeSeries.setData(vol);

        this._update_emas(klines);

        // 清空副图叠加 (等外部喂数据)
        this.whaleFlowSeries.setData([]);
        this.crowdingSeries.setData([]);
        this.liqHeatmapSeries.setData([]);
    }

    /** 逐帧更新当前 K 线 */
    update_kline(kline) {
        if (!kline) return;
        this.candleSeries.update({
            time: kline.time,
            open: kline.open, high: kline.high, low: kline.low, close: kline.close,
        });
        this.volumeSeries.update({
            time: kline.time,
            value: kline.volume,
            color: kline.close >= kline.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
        });
    }

    // ============================================================
    // 副图指标: 大户净流入
    // ============================================================
    set_whale_flow(whalePoints) {
        // whalePoints: [{ time, value }]
        const data = whalePoints.map(p => ({
            time: p.time,
            value: Math.abs(p.value),
            color: p.value >= 0 ? 'rgba(38,166,154,0.75)' : 'rgba(239,83,80,0.75)',
        }));
        this.whaleFlowSeries.setData(data);
        this._whaleHist = whalePoints;
    }

    update_whale_flow(time, value) {
        this.whaleFlowSeries.update({
            time,
            value: Math.abs(value),
            color: value >= 0 ? 'rgba(38,166,154,0.75)' : 'rgba(239,83,80,0.75)',
        });
    }

    // ============================================================
    // 副图指标: 多空拥挤度
    // ============================================================
    set_crowding(crowdPoints) {
        const data = crowdPoints.map(p => ({ time: p.time, value: p.value * 300 }));
        this.crowdingSeries.setData(data);
        this._crowdHist = crowdPoints;
    }

    update_crowding(time, zscore) {
        this.crowdingSeries.update({ time, value: zscore * 300 });
    }

    // ============================================================
    // 主图叠加: 清算热力图
    // 每根 K 线对应一个半透明 Histogram bar:
    //   value > 0 (上方清算=空头危险) → 绿/偏多
    //   value < 0 (下方清算=多头危险) → 红/偏空
    // ============================================================
    set_liq_heatmap(liqPoints) {
        // liqPoints: [{ time, below_amount, above_amount, high, low, open, close }]
        // 把清算压力映射成价格偏移量 (K线 body 的 30%)
        const data = liqPoints.map(p => {
            const body = Math.max(p.high - p.low, p.close * 0.002);
            const max_pressure = Math.max(p.below_amount, p.above_amount, 1000000);
            const max_bar = body * 0.45;

            let value = 0, color = 'transparent';
            if (p.below_amount > p.above_amount) {
                // 下方清算压力更大 → 偏空 → 红柱向下 (负 value)
                const ratio = p.below_amount / max_pressure;
                value = -(p.close - (p.low - max_bar * ratio));
                color = `rgba(239, 83, 80, ${Math.min(0.65, 0.25 + ratio * 0.45)})`;
            } else {
                // 上方清算压力更大 → 偏多 → 绿柱向上 (正 value)
                const ratio = p.above_amount / max_pressure;
                value = (p.high + max_bar * ratio) - p.close;
                color = `rgba(38, 166, 154, ${Math.min(0.65, 0.25 + ratio * 0.45)})`;
            }
            return { time: p.time, value, color };
        });
        this.liqHeatmapSeries.setData(data);
        this._liqHist = liqPoints;
    }

    update_liq_heatmap(point) {
        // point: { time, below_amount, above_amount, high, low, open, close }
        const body = Math.max(point.high - point.low, point.close * 0.002);
        const max_pressure = Math.max(point.below_amount, point.above_amount, 1000000);
        const max_bar = body * 0.45;

        let value = 0, color = 'transparent';
        if (point.below_amount > point.above_amount) {
            const ratio = point.below_amount / max_pressure;
            value = -(point.close - (point.low - max_bar * ratio));
            color = `rgba(239, 83, 80, ${Math.min(0.65, 0.25 + ratio * 0.45)})`;
        } else {
            const ratio = point.above_amount / max_pressure;
            value = (point.high + max_bar * ratio) - point.close;
            color = `rgba(38, 166, 154, ${Math.min(0.65, 0.25 + ratio * 0.45)})`;
        }
        this.liqHeatmapSeries.update({ time: point.time, value, color });
    }

    // ============================================================
    // EMA 工具
    // ============================================================
    set_ema(short_period, long_period) {
        this._ema_short = short_period;
        this._ema_long  = long_period;
    }

    _update_emas(klines) {
        const closes = klines.map(k => k.close);
        const times  = klines.map(k => k.time);

        const ema_s = this._ema(closes, this._ema_short || 9);
        const ema_l = this._ema(closes, this._ema_long  || 55);

        this.emaShortSeries.setData(ema_s.map((v, i) => ({ time: times[i], value: v })));
        this.emaLongSeries.setData( ema_l.map((v, i) => ({ time: times[i], value: v })));

        const last_s = ema_s[ema_s.length - 1];
        const last_l = ema_l[ema_l.length - 1];
        document.getElementById('emaShortValue').textContent = last_s.toFixed(3);
        document.getElementById('emaLongValue').textContent  = last_l.toFixed(3);
        document.getElementById('legendShort').textContent  = this._ema_short || 9;
        document.getElementById('legendLong').textContent   = this._ema_long  || 55;
    }

    _ema(arr, period) {
        const k = 2 / (period + 1);
        const result = new Array(arr.length);
        result[0] = arr[0];
        for (let i = 1; i < arr.length; i++) {
            result[i] = arr[i] * k + result[i - 1] * (1 - k);
        }
        return result;
    }

    // ============================================================
    // 标记 + 销毁
    // ============================================================
    add_marker(time, price, direction, text) {
        const marker = {
            time,
            position: direction === 'buy' ? 'belowBar' : 'aboveBar',
            color: direction === 'buy' ? '#26a69a' : '#ef5350',
            shape: direction === 'buy' ? 'arrowUp' : 'arrowDown',
            text: text || (direction === 'buy' ? 'B' : 'S'),
            size: 1,
        };
        this.markers.push(marker);
        this.candleSeries.setMarkers(this.markers);
    }

    clear_markers() {
        this.markers = [];
        this.candleSeries.setMarkers([]);
    }

    dispose() {
        if (this._resizeObserver) this._resizeObserver.disconnect();
        this.chart.remove();
    }
}

window.KLineChart = KLineChart;
