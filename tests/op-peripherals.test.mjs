import test from 'node:test';
import assert from 'node:assert/strict';
import {createPeripheralHub, deviceDefinitions} from '../public/js/op/peripherals.mjs';

test('peripherals only appear when configured', () => {
    assert.deepEqual(deviceDefinitions({}), []);
    const list = deviceDefinitions({
        opAntennaSwitchConfigured: true,
        opAntennaSwitchName: 'A/B',
        opTowerConfigured: true,
        opTowerName: 'Tower 1',
        opRotatorConfigured: true,
        opRotatorName: 'Rotor'
    });
    assert.deepEqual(list.map(item => item.type), ['antenna', 'tower', 'rotator']);
    assert.equal(list[0].name, 'A/B');
});

test('no driver means unconfigured and never a fake success', () => {
    const hub = createPeripheralHub();
    assert.equal(hub.status('rotator'), 'unconfigured');
    assert.deepEqual(hub.command('rotator', 'bearing', 120), {ok: false, reason: 'no-driver'});
});

test('a registered driver receives commands and failures surface as errors', () => {
    const hub = createPeripheralHub();
    const seen = [];
    assert.equal(hub.register('rotator', {
        status: () => 'ready',
        setBearing: value => { seen.push(value); return 'ok'; }
    }), true);
    assert.equal(hub.status('rotator'), 'ready');
    assert.deepEqual(hub.command('rotator', 'bearing', 90), {ok: true, result: 'ok'});
    assert.deepEqual(seen, [90]);
    assert.equal(hub.register('unknown', {}), false);
    assert.deepEqual(hub.command('tower', 'direction', 'up'), {ok: false, reason: 'no-driver'});
});
