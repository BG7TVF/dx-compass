import {getJson, postJson} from '../core/transport.mjs';

/** Local contest calendar snapshot served by the Node-RED backend. */
export function fetchContests() {
    return getJson('/api/contests');
}

/** Manual refresh of the WA7BNM ICS snapshot. */
export function refreshContests() {
    return postJson('/api/contest-calendar/refresh', {});
}
