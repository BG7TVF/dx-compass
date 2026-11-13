'use strict';

/**
 * 启动门闩（HTTP 层）。
 *
 * Node-RED 的启动顺序是“先监听端口，再异步启动 flows”：端口刚打开时
 * http-in 路由还没注册，请求会直接拿到 Express 的 404；而路由注册完成前
 * 数据库初始化也可能没结束。两者都不是靠延时能猜准的。
 *
 * 这个模块在节点加载阶段（早于 listen 与 flows 启动）把第一个全局中间件
 * 挂到 RED.httpNode 上，让所有 HTTP 请求等到两个真实条件同时成立：
 *   1. lib/ready.js 的 schema 探针确认表/列/索引/触发器齐全；
 *   2. Node-RED 触发 flows:started，说明 http-in 路由已经注册。
 *
 * 只有初始化真的失败时才返回 500 schema-init-failed，不做“稍后再试”的
 * 5xx 兜底；正常冷启动下请求只是被推迟，不会被拒绝。
 */

const ROUTES_TIMEOUT_MS = 30000;

module.exports = function(RED) {
    const ready = require('../lib/ready.js');

    let resolveRoutes;
    let rejectRoutes;
    const routes = new Promise(function(resolve, reject) {
        resolveRoutes = resolve;
        rejectRoutes = reject;
    });
    const routeTimer = setTimeout(function() {
        rejectRoutes(new Error('flows not started within ' + ROUTES_TIMEOUT_MS + 'ms'));
    }, ROUTES_TIMEOUT_MS);
    routeTimer.unref();

    RED.events.on('flows:started', function() {
        clearTimeout(routeTimer);
        resolveRoutes();
    });

    function fail(res, error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
            ok: false,
            error: /flows not started/.test(String(error && error.message)) ?
                'flows-start-timeout' : 'schema-init-failed',
            detail: String(error && error.message ? error.message : error)
        }));
    }

    RED.httpNode.use(function(req, res, next) {
        Promise.all([ready.whenReady(), routes]).then(function() {
            next();
        }).catch(function(error) {
            fail(res, error);
        });
    });

    function ReadyGateNode(config) {
        RED.nodes.createNode(this, config);
    }

    RED.nodes.registerType('ready-gate', ReadyGateNode);
};
