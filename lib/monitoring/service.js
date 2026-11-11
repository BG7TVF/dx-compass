'use strict';

/**
 * 采集/监听固定常开。
 * 前端已删除「开始监听」开关，这里不再根据客户端心跳汇总开关状态，
 * 仅保留接口兼容（旧页面/心跳仍然可以调用，但不会关闭采集）。
 */
function setClient(global) {
    global.set('monitoring', true);
    return {success: true, monitoring: true};
}

function getState() {
    return {monitoring: true};
}

module.exports = {setClient, getState};
