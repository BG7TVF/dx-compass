'use strict';

/**
 * 摄像头模块门面。
 *
 * 调用方：
 *   - nodes/camera-hub.js：HTTP 端点（/stream、/frame、/discover）经此访问
 *     has/latest/subscribe/publish 与 discover/probeDevice；
 *   - lib/devices/service.js：设备快照变化时调 sync(devices) 同步登记。
 *
 * hub 是纯内存 fan-out；onvif 负责发现与取 profile。二者在这里接起来，
 * 上层不需要分别 require 子模块。
 */

const hub = require('./hub.js');
const onvif = require('./onvif.js');

module.exports = {
    sync: hub.sync,
    subscribe: hub.subscribe,
    latest: hub.latest,
    has: hub.has,
    stats: hub.stats,
    stopAll: hub.stopAll,
    publish: hub.publish,
    discover: onvif.discover,
    probeDevice: onvif.probeDevice
};
