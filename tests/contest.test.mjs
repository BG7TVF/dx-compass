import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {contestCountdown} from '../public/shared/contest/countdown.mjs';

const require = createRequire(import.meta.url);
const ics = require('../lib/contest/ics.js');
const contest = require('../lib/contest/service.js');

const FEED = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:417610958',
    'SUMMARY:CQ Worldwide DX Contest\\, CW',
    'DTSTART:20261128T000000Z',
    'DTEND:20261129T235959Z',
    'URL:https://www.contestcalendar.com/contestdetails.php?ref=177',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:417610959@contestcalendar.com',
    'SUMMARY:ARRL 160-Meter Contest',
    'DTSTART:20261204T220000Z',
    'DTEND:20261206T160000Z',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:cancelled-1',
    'SUMMARY:Cancelled Test',
    'DTSTART:20261210T000000Z',
    'DTEND:20261210T120000Z',
    'STATUS:CANCELLED',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:no-end',
    'SUMMARY:Missing End',
    'DTSTART:20261211T000000Z',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:zero-length',
    'SUMMARY:Zero Length',
    'DTSTART:20261212T000000Z',
    'DTEND:20261212T000000Z',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:folded',
    'SUMMARY:Folded',
    ' Contest Name',
    'DTSTART:20261213T000000Z',
    'DTEND:20261213T235959Z',
    'END:VEVENT',
    'END:VCALENDAR'
].join('\r\n');

test('parseIcs keeps only complete, non-cancelled events', () => {
    const rows = ics.parseIcs(FEED);
    assert.deepEqual(rows.map(row => row.name), [
        'CQ Worldwide DX Contest, CW',
        'ARRL 160-Meter Contest',
        'FoldedContest Name'
    ]);
    const first = rows[0];
    assert.equal(first.id, 'wa7bnm-417610958');
    assert.equal(first.startUtc, '2026-11-28T00:00:00Z');
    assert.equal(first.endUtc, '2026-11-29T23:59:59Z');
    assert.equal(first.sourceUrl, 'https://www.contestcalendar.com/contestdetails.php?ref=177');
    assert.equal(first.rulesStatus, 'not-collected');
    assert.deepEqual(first.modes, []);
    assert.deepEqual(first.bands, []);
    assert.equal(first.multPerBand, null);
});

test('parseIcs escapes the detail URL with the feed URL and strips UID suffix', () => {
    const rows = ics.parseIcs(FEED);
    assert.equal(rows[1].id, 'wa7bnm-417610959');
    assert.equal(rows[1].sourceUrl, ics.FEED_URL);
});

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

test('expire clears a finished contest server-side and is idempotent', () => {
    const store = {};
    const global = {
        get: key => store[key],
        set: (key, value) => { store[key] = value; }
    };
    store.uiSettings = {
        contestId: 'wa7bnm-1', contestName: 'CQWW CW',
        contestStart: '2026-11-28T00:00', contestEnd: '2026-11-29T23:59',
        wallTimerStart: '2026-11-28T00:00', wallTimerEnd: '2026-11-29T23:59'
    };

    const early = contest.expire(global, Date.parse('2026-11-29T23:58:00Z'));
    assert.equal(early.changed, false);

    const done = contest.expire(global, Date.parse('2026-11-30T00:00:00Z'));
    assert.equal(done.changed, true);
    assert.equal(done.settings.contestEnd, '');
    assert.equal(done.settings.contestStart, '');
    assert.equal(done.settings.contestId, '');
    assert.equal(done.settings.wallTimerStart, '');
    assert.equal(done.broadcast.type, 'settings');
    assert.equal(done.broadcast.settings.contestName, '');

    assert.equal(contest.expire(global, Date.parse('2026-12-01T00:00:00Z')).changed, false);
});

test('refresh interval falls back to a week and is clamped', () => {
    assert.equal(contest.refreshHours({}), 168);
    assert.equal(contest.refreshHours({contestRefreshHours: 0}), 1);
    assert.equal(contest.refreshHours({contestRefreshHours: 99999}), 720);
    assert.equal(contest.refreshHours({contestRefreshHours: '24'}), 24);
});
