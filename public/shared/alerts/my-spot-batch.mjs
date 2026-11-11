/**
 * 「我的 SPOT」批量窗口。
 *
 * 规则：同一个 windowMs（默认 30 秒）窗口内只告警一次；窗口内收到的条数
 * 作为 N 传给播报文案（N≥2 时播「你有 N 条新 SPOT」）。
 * 纯状态机，不依赖 DOM / 定时器，便于单独验证。
 */
export const MY_SPOT_WINDOW_MS = 30000;

export class MySpotBatcher {
    constructor(windowMs = MY_SPOT_WINDOW_MS) {
        this.windowMs = windowMs;
        this.window = null;
    }

    /** 记录一条新 SPOT，返回当前窗口条数与是否开启了新窗口。 */
    push(now = Date.now()) {
        if (this.window && now - this.window.startedAt >= this.windowMs) this.window = null;
        if (!this.window) {
            this.window = {startedAt: now, count: 1};
            return {count: 1, started: true};
        }
        this.window.count += 1;
        return {count: this.window.count, started: false};
    }

    /** 取出并结束当前窗口。 */
    take() {
        const window = this.window;
        this.window = null;
        return window;
    }

    get count() {
        return this.window ? this.window.count : 0;
    }
}
