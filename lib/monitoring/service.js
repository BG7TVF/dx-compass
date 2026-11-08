'use strict';

function setClient(global, body, now = Date.now()) {
    body = body && typeof body === 'object' ? body : {};
    const on = !!body.on;
    const id = String(body.client || '__legacy');
    const clients = global.get('monitorClients') || {};
    Object.keys(clients).forEach(k => {
        if (k !== '__legacy' && now - (clients[k].ts || 0) > 120000) delete clients[k];
    });
    clients[id] = {on, ts: now};
    global.set('monitorClients', clients);
    const monitoring = Object.keys(clients).some(k => clients[k].on === true);
    global.set('monitoring', monitoring);
    return {success: true, monitoring, clients: Object.keys(clients).length};
}

function getState(global) {
    const clients = global.get('monitorClients') || {};
    return {
        monitoring: global.get('monitoring') === true,
        clients: Object.keys(clients).length
    };
}

module.exports = {setClient, getState};
