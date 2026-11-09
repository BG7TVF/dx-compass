import {test} from 'node:test';
import assert from 'node:assert/strict';
import {quietHoursActive, quietMinutes} from '../public/shared/monitoring/quiet-hours.mjs';

const at = (hour, minute) => new Date(2026, 0, 15, hour, minute, 0);

test('quiet-hours parsing accepts only zero-padded HH:MM', () => {
    assert.equal(quietMinutes('06:30'), 390);
    assert.equal(quietMinutes('23:59'), 1439);
    assert.equal(quietMinutes('6:30'), null);
    assert.equal(quietMinutes('24:00'), null);
    assert.equal(quietMinutes(''), null);
    assert.equal(quietMinutes(undefined), null);
});

test('quiet-hours window inside one day is half-open', () => {
    assert.equal(quietHoursActive('09:00', '17:00', at(8, 59)), false);
    assert.equal(quietHoursActive('09:00', '17:00', at(9, 0)), true);
    assert.equal(quietHoursActive('09:00', '17:00', at(16, 59)), true);
    assert.equal(quietHoursActive('09:00', '17:00', at(17, 0)), false);
});

test('quiet-hours window crossing midnight wraps around', () => {
    assert.equal(quietHoursActive('22:00', '06:00', at(21, 59)), false);
    assert.equal(quietHoursActive('22:00', '06:00', at(22, 0)), true);
    assert.equal(quietHoursActive('22:00', '06:00', at(23, 59)), true);
    assert.equal(quietHoursActive('22:00', '06:00', at(5, 59)), true);
    assert.equal(quietHoursActive('22:00', '06:00', at(6, 0)), false);
    assert.equal(quietHoursActive('22:00', '06:00', at(12, 0)), false);
});

test('quiet-hours stays disabled for missing, invalid or equal ends', () => {
    assert.equal(quietHoursActive('', '', at(12, 0)), false);
    assert.equal(quietHoursActive('22:00', '', at(23, 0)), false);
    assert.equal(quietHoursActive('bad', '06:00', at(23, 0)), false);
    assert.equal(quietHoursActive('08:00', '08:00', at(8, 0)), false);
});
