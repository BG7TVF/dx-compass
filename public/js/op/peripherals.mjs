/**
 * Peripheral adapter layer for the OP view.
 *
 * There is deliberately no built-in device protocol. A real driver registers
 * itself here and implements the small contract below; until then the UI must
 * say "未配置驱动" and never pretend a command succeeded.
 *
 * Driver contract (all optional except the matching command):
 *   {status(): 'ready'|'unconfigured'|'error', setBearing(deg),
 *    setDirection('up'|'down'|'stop'), selectAntenna(port)}
 */
export const DEVICE_TYPES = ['antenna', 'tower', 'rotator'];

const DEFAULT_NAMES = {antenna: 'Antenna switch', tower: 'Tower', rotator: 'Rotator'};

export function deviceDefinitions(settings = {}) {
    const list = [];
    if (settings.opAntennaSwitchConfigured) {
        list.push({type: 'antenna', name: settings.opAntennaSwitchName || DEFAULT_NAMES.antenna});
    }
    if (settings.opTowerConfigured) {
        list.push({type: 'tower', name: settings.opTowerName || DEFAULT_NAMES.tower});
    }
    if (settings.opRotatorConfigured) {
        list.push({type: 'rotator', name: settings.opRotatorName || DEFAULT_NAMES.rotator});
    }
    return list;
}

export function createPeripheralHub() {
    const drivers = new Map();

    function register(type, driver) {
        if (!DEVICE_TYPES.includes(type) || !driver) return false;
        drivers.set(type, driver);
        return true;
    }

    function driverFor(type) {
        return drivers.get(type) || null;
    }

    function status(type) {
        const driver = driverFor(type);
        if (!driver) return 'unconfigured';
        try {
            return typeof driver.status === 'function' ? driver.status() : 'ready';
        } catch {
            return 'error';
        }
    }

    function command(type, action, value) {
        const driver = driverFor(type);
        if (!driver) return {ok: false, reason: 'no-driver'};
        const fn = action === 'bearing' ? driver.setBearing
            : action === 'direction' ? driver.setDirection
                : action === 'antenna' ? driver.selectAntenna : null;
        if (typeof fn !== 'function') return {ok: false, reason: 'unsupported'};
        try {
            const result = fn.call(driver, value);
            return {ok: true, result};
        } catch (error) {
            return {ok: false, reason: 'error', error: String(error && error.message || error)};
        }
    }

    return {register, driverFor, status, command, types: DEVICE_TYPES.slice()};
}
