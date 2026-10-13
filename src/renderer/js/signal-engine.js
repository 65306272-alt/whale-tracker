/**
 * WhaleTracker - 信号计算引擎
 *
 * 输入: MockDataGenerator / 真实数据源
 * 输出: 4 个 Score + 加权总分 + 信号 + 日志
 */

class SignalEngine {
    constructor(config) {
        this.cfg = config;
        this.last_signal_time = 0;
        this.state = {
            pos: "FLAT",      // FLAT / LONG / SHORT
            entry: 0,
            size: 0,
            entry_time: 0,
        };
        this.score_history = [];   // 最近 90 个 Score (供底部曲线)
    }

    /**
     * 计算大户净流入 Score
     * -100 到 +100
     */
    calc_whale_score(bucket) {
        const net = bucket || 0;         // 这一分钟大户净流入 USDT
        const baseline = 300000;         // 归一化基准 (30万 USDT 大户单)

        if (Math.abs(net) < 50000) return 0;  // 无信号

        const raw = Math.max(-1, Math.min(1, net / baseline));
        return Math.round(raw * 100);
    }

    /**
     * 计算清算压力 Score
     * +100 = 下方爆仓 >> 上方 (多头危险)
     * -100 = 上方爆仓 >> 下方 (空头危险)
     */
    calc_liquidation_score(liq_data) {
        if (!liq_data) return 0;
        const below = liq_data.below || 0;
        const above = liq_data.above || 0;
        const total = below + above;
        if (total === 0) return 0;

        // 权重分交易所
        // (简化: mock 里直接给 below/above, 真实数据要分交易所拉)
        const ratio = (below - above) / total;
        return Math.round(ratio * 100);
    }

    /**
     * 多空拥挤度 Score
     * +100 = 多头极度拥挤 (回调在即)
     * -100 = 空头极度拥挤 (反弹在即)
     */
    calc_crowding_score(z_score) {
        // Z-Score 典型范围 -3 ~ +3
        // 映射到 -100 ~ +100, 用 soft-clipping
        const raw = Math.max(-3, Math.min(3, z_score || 0));
        return Math.round(raw / 3 * 100);
    }

    /**
     * 订单簿诡计 Score
     * +100 = 卖墙崩塌 (要涨)
     * -100 = 买墙崩塌 (要跌)
     */
    calc_orderbook_score(ob_snapshot, prev_ob_snapshot) {
        if (!ob_snapshot || !prev_ob_snapshot) return 0;

        // 对比 ask/bid top 5 总量的衰减
        const sum_qty = (arr) => arr.slice(0, 5).reduce((s, r) => s + (r.qty || 0), 0);
        const cur_asks = sum_qty(ob_snapshot.asks);
        const prev_asks = sum_qty(prev_ob_snapshot.asks);
        const cur_bids = sum_qty(ob_snapshot.bids);
        const prev_bids = sum_qty(prev_ob_snapshot.bids);

        const ask_decay = prev_asks > 0 ? (prev_asks - cur_asks) / prev_asks : 0;
        const bid_decay = prev_bids > 0 ? (prev_bids - cur_bids) / prev_bids : 0;

        // 卖墙消失多 → 买压 → Score 正
        const diff = ask_decay - bid_decay;
        return Math.round(Math.max(-1, Math.min(1, diff * 3)) * 100);
    }

    /**
     * 加权合成总分
     */
    compute_total_score(whale, liq, crowd, ob) {
        const w = this.cfg.weights;
        return whale * w.whale_flow +
               liq   * w.liquidation +
               crowd * w.crowding +
               ob    * w.orderbook;
    }

    /**
     * 根据总分 + 冷却期 + 状态机, 生成信号
     */
    generate_signal(total_score, now_ms) {
        // 冷却期
        const cd_ms = this.cfg.thresholds.cooldown_minutes * 60 * 1000;
        if ((now_ms - this.last_signal_time) < cd_ms && this.state.pos === "FLAT") {
            return { signal: "HOLD", total_score, reason: "冷却中" };
        }

        const t = this.cfg.thresholds;

        if (total_score >= t.strong_buy_score && this.state.pos === "FLAT") {
            return { signal: "STRONG_BUY", total_score, reason: "总分 ≥ 50, 强烈看多" };
        } else if (total_score >= t.buy_score && this.state.pos === "FLAT") {
            return { signal: "BUY", total_score, reason: "总分 ≥ 25, 温和看多" };
        } else if (total_score <= t.strong_sell_score && this.state.pos === "FLAT") {
            return { signal: "STRONG_SELL", total_score, reason: "总分 ≤ -50, 强烈看空" };
        } else if (total_score <= t.sell_score && this.state.pos === "FLAT") {
            return { signal: "SELL", total_score, reason: "总分 ≤ -25, 温和看空" };
        }

        return { signal: "HOLD", total_score };
    }

    /**
     * 持仓中的平仓逻辑
     */
    check_exit(current_price, now_ms) {
        if (this.state.pos === "FLAT") return null;

        // 硬止损
        if (this.state.pos === "LONG" && current_price < this.state.entry * (1 - this.cfg.thresholds.stop_loss_pct / 100)) {
            return { action: "CLOSE", reason: "硬止损" };
        }
        if (this.state.pos === "SHORT" && current_price > this.state.entry * (1 + this.cfg.thresholds.stop_loss_pct / 100)) {
            return { action: "CLOSE", reason: "硬止损" };
        }

        // 超时平仓
        const timeout_ms = this.cfg.thresholds.timeout_minutes * 60 * 1000;
        if ((now_ms - this.state.entry_time) > timeout_ms) {
            return { action: "CLOSE", reason: "持仓超时" };
        }

        return null;
    }

    open_position(side, price, size, now_ms) {
        this.state = { pos: side, entry: price, size, entry_time: now_ms };
        this.last_signal_time = now_ms;
    }

    close_position() {
        this.state = { pos: "FLAT", entry: 0, size: 0, entry_time: 0 };
    }

    /**
     * 主方法: 每根 K 线收盘调用一次, 得到完整的评分和信号
     */
    full_cycle(bucket, liq_data, crowd_z, ob_cur, ob_prev, now_ms, current_price) {
        const whale = this.calc_whale_score(bucket);
        const liq   = this.calc_liquidation_score(liq_data);
        const crowd = this.calc_crowding_score(crowd_z);
        const ob    = this.calc_orderbook_score(ob_cur, ob_prev);
        const total = this.compute_total_score(whale, liq, crowd, ob);
        const { signal, reason } = this.generate_signal(total, now_ms);

        // 平仓检查
        const exit = this.check_exit(current_price, now_ms);

        return {
            whale, liq, crowd, ob,
            total,
            signal,
            reason,
            exit,
        };
    }
}

window.SignalEngine = SignalEngine;
