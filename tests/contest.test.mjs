import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {contestCountdown} from '../public/shared/contest/countdown.mjs';

const require = createRequire(import.meta.url);
const contest = require('../lib/contest/service.js');

test('contestCountdown reports hidden, before, running and ended phases', () => {
    assert.equal(contestCountdown({}).phase, 'none');
    assert.equal(contestCountdown({contestStart: '2026-11-28T00:00', contestEnd: ''}).phase, 'none');

    const settings = {
        contestName: 'CQWW CW',
        contestStart: '2026-11-28T00:00',
        contestEnd: '2026-11-29T23:59'
    };
    const before = contestCountdown(settings, Date.parse('2026-11-28T00:00:00Z') - 86400000 - 3600000 - 60000);
    assert.equal(before.phase, 'before');
    assert.deepEqual([before.days, before.hours, before.minutes], [1, 1, 1]);
    assert.equal(before.window.name, 'CQWW CW');

    const running = contestCountdown(settings, Date.parse('2026-11-29T20:58:30Z'));
    assert.equal(running.phase, 'running');
    assert.deepEqual([running.hours, running.minutes, running.seconds], [3, 0, 30]);

    assert.equal(contestCountdown(settings, Date.parse('2026-11-29T23:59:00Z')).phase, 'ended');
});

test('windowFor reads the manual contest window in UTC', () => {
    assert.deepEqual(contest.windowFor({
        contestStart: '2026-11-28T00:00', contestEnd: '2026-11-29T23:59'
    }), {
        from: Date.parse('2026-11-28T00:00:00Z'),
        to: Date.parse('2026-11-29T23:59:00Z')
    });
    assert.deepEqual(contest.windowFor({}), {from: null, to: null});
});

test('expire clears a finished contest server-side and is idempotent', () => {
    const store = {};
    const global = {
        get: key => store[key],
        set: (key, value) => { store[key] = value; }
    };
    store.uiSettings = {
        contestName: 'CQWW CW', contestStart: '2026-11-28T00:00', contestEnd: '2026-11-29T23:59',
        contestModes: 'CW', contestBands: '20m', contestRulesUrl: 'https://example.com/rules',
        wallTimerStart: '2026-11-28T00:00', wallTimerEnd: '2026-11-29T23:59'
    };

    const early = contest.expire(global, Date.parse('2026-11-29T23:58:00Z'));
    assert.equal(early.changed, false);

    const done = contest.expire(global, Date.parse('2026-11-30T00:00:00Z'));
    assert.equal(done.changed, true);
    assert.equal(done.settings.contestEnd, '');
    assert.equal(done.settings.contestStart, '');
    assert.equal(done.settings.contestName, '');
    assert.equal(done.settings.contestModes, '');
    assert.equal(done.settings.wallTimerStart, '');
    assert.equal(done.broadcast.type, 'settings');
    assert.equal(done.broadcast.settings.contestName, '');

    assert.equal(contest.expire(global, Date.parse('2026-12-01T00:00:00Z')).changed, false);
});
