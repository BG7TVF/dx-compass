// DX-Compass 官方设备协议 · Schema 与语义校验用例
// 用法：node docs/schema/check-examples.mjs
// 依赖：仓库内 ajv（8.x，2020-12 模式）
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const require = createRequire(join(root, 'package.json'));
const Ajv2020 = require('ajv/dist/2020');

const dir = join(root, 'docs', 'schema');
const ajv = new Ajv2020({ allErrors: true, strict: false });
const common = JSON.parse(readFileSync(join(dir, 'common.schema.json'), 'utf8'));
ajv.addSchema(common, common.$id);

const compile = (name) => {
  const schema = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  return ajv.compile(schema);
};

const env = (data) => ({
  msg_id: 'dxc-m7k2p1-a1b2c3d4',
  cmd: 'remote_control',
  timestamp: 1794724810,
  ts: '2026-11-15T06:40:10.000Z',
  proto: '1.0',
  data
});

/* ---------- BPF 语义（规范 §11.5 / §11.2）---------- */

const BAND_RE = /^\d{1,3}m$/;
const PLATFORM_BANDS = new Set([
  '160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'
]);

// 波段标识分类：known / unrecognized / invalid
const classifyBand = (band) => {
  if (typeof band !== 'string' || !BAND_RE.test(band)) return 'invalid';
  return PLATFORM_BANDS.has(band) ? 'known' : 'unrecognized';
};

// 设备侧切换裁决：返回 { result, error?, alarm? }
const bpfSwitch = (state, data) => {
  if (data.action === 'ack_alarms') return { result: 'ok' };
  if (state.tx_active === true) return { result: 'error', error: 'tx-active' };
  if (state.rf_detected === true) return { result: 'error', error: 'rf-detected' };
  if (state.switching === true) return { result: 'error', error: 'busy' };
  if (state.state === 'fault') return { result: 'error', error: 'hardware-fault' };
  if (state.state !== 'idle') return { result: 'error', error: 'busy' };
  if ('band' in data) {
    if (!BAND_RE.test(data.band)) return { result: 'error', error: 'invalid-arg' };
    if (!state.supported_bands.includes(data.band)) {
      return { result: 'error', error: 'unknown-band', alarm: 'band-unsupported' };
    }
    return { result: 'ok' };
  }
  if ('bypass' in data) return { result: 'ok' };
  return { result: 'error', error: 'empty-command' };
};

// 快照一致性：bypass=true 时 current_band 必须为 null
const bpfSnapshotConsistent = (data) =>
  !(data.bypass === true && data.current_band !== null);

/* ---------- 用例 ---------- */

const cases = [];
// 结构校验用例：validate 为 ajv 编译函数，expect 为期望结果
const add = (name, validate, payload, expect) =>
  cases.push({ name, run: () => validate(payload) === expect });
// 自定义断言用例：fn() 返回布尔，expect 为期望值
const addCheck = (name, fn, expect = true) =>
  cases.push({ name, run: () => fn() === expect });

// ---- 切换器 ----
const hbSwitch = compile('heartbeat-switch.schema.json');
add('switch heartbeat ok', hbSwitch, {
  msg_id: 'sw-a-0101', cmd: 'remote_control', timestamp: 1794724800,
  ts: '2026-11-15T06:40:00.000Z', proto: '1.0',
  data: {
    device_id: 'SW-A', device_class: 'switch', model: 'DXC-SW-6', serial: 'SWA2026001',
    firmware_version: '1.0.3', boot_id: 'b7f3c1', uptime_ms: 128400, seq: 42,
    state: 'idle', out_count: 6, position: 3, ports: { in: 'ant3' }, target: 'ant3',
    switching: false, relay_state: [false, false, true, false, false, false],
    rf_detected: false, tx_active: false, temperature_c: 31.5, fault_word: 0,
    error: '', result: 'ok'
  }
}, true);
add('switch heartbeat position null ok', hbSwitch, {
  msg_id: 'sw-a-0001', cmd: 'remote_control', timestamp: 1794724800,
  ts: '2026-11-15T06:40:00.000Z',
  data: {
    device_id: 'SW-A', device_class: 'switch', model: 'DXC-SW-6',
    firmware_version: '1.0.3', boot_id: 'b7f3c1', uptime_ms: 820, seq: 1,
    state: 'init', out_count: 6, position: null, ports: { in: null },
    target: null, switching: false, rf_detected: false, tx_active: false
  }
}, true);
add('switch heartbeat bad class rejected', hbSwitch, {
  msg_id: 'x', cmd: 'remote_control', timestamp: 1794724800,
  ts: '2026-11-15T06:40:00.000Z',
  data: {
    device_id: 'SW-A', device_class: 'matrix', model: 'm', firmware_version: '1',
    boot_id: 'b', uptime_ms: 1, seq: 1, state: 'idle', out_count: 6,
    position: 1, ports: { in: 'ant1' }, switching: false,
    rf_detected: false, tx_active: false
  }
}, false);

const cmdSwitch = compile('command-switch.schema.json');
add('switch cmd ok', cmdSwitch, env({ device_id: 'SW-A', ports: { in: 'ant3' } }), true);
add('switch cmd null rejected', cmdSwitch, env({ device_id: 'SW-A', ports: { in: null } }), false);
add('switch cmd extra key rejected', cmdSwitch, env({ device_id: 'SW-A', ports: { in: 'ant3', out: 'ant1' } }), false);

// ---- 矩阵 ----
const hbMatrix = compile('heartbeat-matrix.schema.json');
add('matrix heartbeat partial ports ok', hbMatrix, {
  msg_id: 'mx-a-0202', cmd: 'remote_control', timestamp: 1794725001,
  ts: '2026-11-15T06:43:21.000Z',
  data: {
    device_id: 'MX-A', device_class: 'matrix', model: 'DXC-MX-2X4',
    firmware_version: '1.0.0', boot_id: 'c19a2e', uptime_ms: 56300, seq: 20,
    state: 'idle', in_count: 2, out_count: 4, ports: { in2: 'out1' },
    switching: false, rf_detected: false, tx_active: false
  }
}, true);
const cmdMatrix = compile('command-matrix.schema.json');
add('matrix cmd ok', cmdMatrix, env({ device_id: 'MX-A', ports: { in2: 'out1' } }), true);
add('matrix cmd two keys rejected', cmdMatrix, env({ device_id: 'MX-A', ports: { in1: 'out1', in2: 'out2' } }), false);
add('matrix cmd null rejected', cmdMatrix, env({ device_id: 'MX-A', ports: { in2: null } }), false);

// ---- 铁塔 ----
const hbTower = compile('heartbeat-tower.schema.json');
add('tower heartbeat ok', hbTower, {
  msg_id: 'tw-a-0001', cmd: 'remote_control', timestamp: 1794725100,
  ts: '2026-11-15T06:45:00.000Z',
  data: {
    device_id: 'TW-A', device_class: 'tower', model: 'DXC-TW-1',
    firmware_version: '1.0.2', boot_id: 'd00d42', uptime_ms: 204500, seq: 306,
    state: 'idle', limit_top: false, limit_bottom: true, limit_wiring: 'NO',
    moving: false, direction: null, motor_on: false, hold_active: false,
    hardware_interlock: true, travel_ms: 0, motor_current_a: 0.0,
    temperature_c: 18.5, fault: '', fault_word: 0
  }
}, true);
const cmdTower = compile('command-tower.schema.json');
add('tower hold ok', cmdTower, env({ device_id: 'TW-A', action: 'hold', direction: 'up', hold_ms: 1500 }), true);
add('tower hold without direction rejected', cmdTower, env({ device_id: 'TW-A', action: 'hold' }), false);
add('tower release without direction ok', cmdTower, env({ device_id: 'TW-A', action: 'release' }), true);
add('tower hold_ms too long rejected', cmdTower, env({ device_id: 'TW-A', action: 'hold', direction: 'up', hold_ms: 5000 }), false);

// ---- BPF（新形态）----
const hbBpf = compile('heartbeat-bpf.schema.json');
const bpfSnapshot = {
  msg_id: 'bpf-a-0001', cmd: 'remote_control', timestamp: 1794725300,
  ts: '2026-11-15T06:48:20.000Z', proto: '1.0',
  data: {
    device_id: 'BPF-A', device_class: 'bpf', model: 'DXC-BPF-6',
    serial: 'BPFA2026001', firmware_version: '1.1.0', boot_id: 'e5c210',
    uptime_ms: 98200, seq: 64, state: 'idle',
    supported_bands: ['160m', '80m', '40m', '20m', '15m', '10m'],
    capability_rev: 1, current_band: null, bypass: true, switching: false,
    filter_health: 'ok', filter_fault_bands: [], rf_detected: false,
    tx_active: false, insertion_loss_db: null, alarms: [], fault: '',
    error: '', result: 'ok'
  }
};
add('bpf heartbeat ok（直通 + 能力列表）', hbBpf, bpfSnapshot, true);
add('bpf heartbeat with alarms ok', hbBpf, {
  ...bpfSnapshot,
  data: {
    ...bpfSnapshot.data,
    state: 'idle', current_band: '20m', bypass: false,
    filter_health: 'degraded',
    alarms: [{
      code: 'switch-failed', severity: 'major', latched: true,
      acknowledged: false, since: '2026-11-15T06:49:00.000Z',
      detail: 'target 15m not reached in 1s, restored 20m'
    }],
    fault: 'switch-failed'
  }
}, true);
add('bpf heartbeat empty supported_bands rejected', hbBpf, {
  ...bpfSnapshot, data: { ...bpfSnapshot.data, supported_bands: [] }
}, false);
add('bpf heartbeat bad band id rejected', hbBpf, {
  ...bpfSnapshot, data: { ...bpfSnapshot.data, supported_bands: ['20M'] }
}, false);
add('bpf heartbeat missing alarms rejected', hbBpf, {
  ...bpfSnapshot,
  data: Object.fromEntries(Object.entries(bpfSnapshot.data).filter(([k]) => k !== 'alarms'))
}, false);
addCheck('bpf heartbeat bypass with band rejected by consistency rule',
  () => bpfSnapshotConsistent({ ...bpfSnapshot.data, bypass: true, current_band: '20m' }),
  false);
addCheck('bpf heartbeat bypass + null band is consistent',
  () => bpfSnapshotConsistent(bpfSnapshot.data), true);

const cmdBpf = compile('command-bpf.schema.json');
add('bpf cmd band ok', cmdBpf, env({ device_id: 'BPF-A', band: '15m' }), true);
add('bpf cmd bypass ok', cmdBpf, env({ device_id: 'BPF-A', bypass: true }), true);
add('bpf cmd ack_alarms ok', cmdBpf, env({ device_id: 'BPF-A', action: 'ack_alarms', codes: ['switch-failed'] }), true);
add('bpf cmd band+bypass rejected', cmdBpf, env({ device_id: 'BPF-A', band: '15m', bypass: true }), false);
add('bpf cmd empty rejected', cmdBpf, env({ device_id: 'BPF-A' }), false);
add('bpf cmd codes without action rejected', cmdBpf, env({ device_id: 'BPF-A', codes: ['switch-failed'] }), false);
add('bpf cmd malformed band rejected by schema', cmdBpf, env({ device_id: 'BPF-A', band: '20M' }), false);

// ---- BPF 语义 ----
const bpfState = {
  supported_bands: ['160m', '80m', '40m', '20m', '15m', '10m'],
  current_band: '20m', bypass: false, switching: false,
  rf_detected: false, tx_active: false, state: 'idle'
};
const sem = (name, payload, expect, state = {}) =>
  cases.push({
    name,
    run: () => JSON.stringify(bpfSwitch({ ...bpfState, ...state }, payload)) === JSON.stringify(expect)
  });

sem('bpf 支持的波段被接受', { band: '15m' }, { result: 'ok' });
sem('bpf 不支持的波段被拒 + 告警', { band: '30m' },
  { result: 'error', error: 'unknown-band', alarm: 'band-unsupported' });
sem('bpf 发射中切换被拒', { band: '15m' },
  { result: 'error', error: 'tx-active' }, { tx_active: true });
sem('bpf 检测到 RF 时切换被拒', { band: '15m' },
  { result: 'error', error: 'rf-detected' }, { rf_detected: true });
sem('bpf 发射中旁路往返被拒', { bypass: true },
  { result: 'error', error: 'tx-active' }, { tx_active: true });
sem('bpf 切换中再来指令被拒', { band: '15m' },
  { result: 'error', error: 'busy' }, { switching: true });
sem('bpf 标识语法非法被拒', { band: '20M' },
  { result: 'error', error: 'invalid-arg' });

addCheck('bpf 发射中 ack_alarms 仍可执行',
  () => bpfSwitch({ ...bpfState, tx_active: true }, { action: 'ack_alarms' }).result === 'ok');
addCheck('bpf fault 状态下换波段被拒',
  () => bpfSwitch({ ...bpfState, state: 'fault' }, { band: '15m' }).error === 'hardware-fault');
addCheck('bpf 未知波段标识：200m 归类为 unrecognized，20M 为 invalid',
  () => classifyBand('200m') === 'unrecognized' && classifyBand('20M') === 'invalid'
    && classifyBand('20m') === 'known');

// ---- 驻波表 / TX ----
const hbSwr = compile('heartbeat-swr.schema.json');
add('swr heartbeat ok', hbSwr, {
  msg_id: 'swr-a-0001', cmd: 'remote_control', timestamp: 1794725420,
  ts: '2026-11-15T06:50:20.000Z',
  data: {
    device_id: 'SWR-A', device_class: 'swr', model: 'DXC-SWR-1',
    firmware_version: '1.0.4', boot_id: 'f0a1b2', uptime_ms: 604000, seq: 1200,
    state: 'idle', fwd_power_w: 0.0, rev_power_w: 0.0, swr: null, pep: false,
    peak_fwd_w: 820.0, freq_hz: null, band: '', tx_active: false,
    tx_threshold_w: 5.0, sample_ms: 20, max_power_w: 2000,
    cal_valid: true, cal_locked: true, temperature_c: 34.0
  }
}, true);
const cmdSwr = compile('command-swr.schema.json');
add('swr clear_peak ok', cmdSwr, env({ device_id: 'SWR-A', action: 'clear_peak' }), true);
add('swr calibrate rejected', cmdSwr, env({ device_id: 'SWR-A', action: 'calibrate' }), false);
const tx = compile('http-tx.schema.json');
add('tx ok', tx, { source_id: 'swr-a', tx_active: true, ts: 1794725400123, seq: 1041 }, true);
add('tx non-boolean rejected', tx, { source_id: 'swr-a', tx_active: 1, seq: 1041 }, false);

/* ---------- 执行 ---------- */

let failed = 0;
for (const c of cases) {
  let ok = false;
  try {
    ok = c.run() === true;
  } catch (err) {
    ok = false;
    c.error = err.message;
  }
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}${c.error ? `  ← ${c.error}` : ''}`);
}
console.log(failed ? `\n${failed} / ${cases.length} 个用例失败` : `\n全部 ${cases.length} 个用例通过`);
process.exit(failed ? 1 : 0);
