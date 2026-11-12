/**
 * DX-Compass settings schema — the single source of truth for defaults,
 * types, ranges, scopes and migration. Consumed by both the browser
 * (side-effect import -> globalThis.DXSettingsSchema) and Node (require()).
 *
 * Field contract:
 *   key        persisted key (flat, identical to the legacy wire format)
 *   domain     ui | map | qso | wall | data | prop
 *   type       enum | bool | int | number | string | color | datetime | time
 *              | intMap | colorMap | enumArray
 *   default    default value used on every fallback
 *   values     allowed values (enum / enumArray)
 *   min/max    inclusive numeric range (int / number)
 *   pattern    RegExp for string / datetime / time
 *   maxLen     maximum string length
 *   upper      uppercase strings before validation
 *   allowEmpty empty string is valid
 *   scope      client | server | both | local
 *   storage    shared (localStorage + uiSettings) | local (localStorage only)
 *   restart    true when a change needs a Node-RED restart
 *   wired      true when business code already reads the key; false = placeholder
 *   readonly   true when the value is informational (UI renders it disabled)
 *   exportable / importable  backup behaviour
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root === 'object') root.DXSettingsSchema = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const SCHEMA_VERSION = 4;

    const UI_LANGUAGES = ['zh', 'en', 'de', 'fr', 'es', 'pt', 'ru', 'it', 'ar', 'ko', 'ja'];
    const THEMES = ['dark', 'light', 'ocean', 'amber'];
    const TILE_PROVIDERS = ['osm', 'amap'];
    const CONTEST_CATEGORIES = ['SO1R', 'SO2R', 'MS', 'M2', 'MM'];
    const CONTEST_TYPES = ['AUTO', 'CQWW', 'CQWPX', 'CQWW_RTTY', 'ARRL_DX', 'CQ160', 'WAE', 'IARU', 'OTHER'];
    const POWER_CLASSES = ['UNKNOWN', 'HP', 'LP', 'QRP'];
    const MULT_MODES = ['dxcc-per-band', 'dxcc-total', 'wpx'];
    const BAND_CHANGE_RULES = ['none', 'time-lock', 'hourly-quota'];
    const MS_ROLES = ['none', 'run', 'mult'];
    const SINGLE_BANDS = ['', '160m', '80m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'];
    const ADVICE_LEVELS = ['low', 'medium', 'high'];
    const WALL_LAYERS = ['prop', 'aurora', 'weather', 'qso', 'myspot', 'dxspot'];
    const WALL_MODES = ['all', 'cycle'];
    const PROP_PROJECTIONS = ['mercator', 'azimuthal', 'robinson'];
    const PROP_LAYERS = ['muf', 'weather', 'aurora'];
    const LAYOUTS = ['1x1', '2x2', '3x3'];
    const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];
    const RECORDING_REPEATS = ['once', 'daily', 'weekly'];
    const TIME_ZONES = ['utc', 'local'];

    const DEFAULT_TTL_MIN = {CW: 30, SSB: 30, DIGI: 30};
    const DEFAULT_BAND_COLORS = {
        '160m': '#b565d8', '80m': '#e67e22', '60m': '#fd79a8', '40m': '#f1c40f',
        '30m': '#1abc9c', '20m': '#00e5ff', '17m': '#3498db', '15m': '#9b59b6',
        '12m': '#e84393', '10m': '#e17055', '6m': '#dfe6e9', '2m': '#55efc4'
    };
    const BAND_METERS = [160, 80, 60, 40, 30, 20, 17, 15, 12, 10, 6, 4, 2];
    const BAND_COLOR_KEYS = Object.keys(DEFAULT_BAND_COLORS);

    const DOMAINS = [
        {key: 'ui', pane: 'global', title: 'Global', titleZh: '全局', desc: 'Language, theme, identity and clock display.'},
        {key: 'map', pane: 'spot', title: 'Spot Map', titleZh: 'SPOT 地图', desc: 'Spot map lifetime, layers and marker density.'},
        {key: 'qso', pane: 'qso', title: 'QSO Map', titleZh: 'QSO 地图', desc: 'QSO map display and alert thresholds.'},
        {key: 'wall', pane: 'wall', title: 'Wall', titleZh: '大屏', desc: 'Read-only wall overlay and rotation.'},
        {key: 'data', pane: 'data', title: 'Data & Alerts', titleZh: '数据与告警', desc: 'Upstream polling, retention and diagnostics.'},
        {key: 'contest', pane: 'contest', title: 'Contest', titleZh: '比赛', desc: 'Hand-entered contest name, UTC window, modes, bands and rules link.'},
        {key: 'prop', pane: 'prop', title: 'Propagation', titleZh: '传播', desc: 'Propagation collection and condition thresholds.'}
    ];

    function field(key, domain, type, def, opts) {
        return Object.assign({
            key, domain, type, default: def,
            scope: 'client', storage: 'shared', wired: true, restart: false,
            exportable: true, importable: true, allowEmpty: false,
            label: key, zh: key, desc: ''
        }, opts || {});
    }

    // ---------------------------------------------------------------- fields
    const FIELDS = [
        // ---- ui / Global
        field('lang', 'ui', 'enum', 'zh', {
            values: UI_LANGUAGES, label: 'Language', zh: '界面语言',
            desc: 'UI language; the i18n dictionary is the only consumer.'
        }),
        field('theme', 'ui', 'enum', 'dark', {
            values: THEMES, label: 'Theme', zh: '主题', desc: 'Colour theme applied to body[data-theme].'
        }),
        field('tiles', 'ui', 'enum', 'amap', {
            values: TILE_PROVIDERS, label: 'Base map', zh: '底图',
            desc: 'Raster tile provider; amap is reachable from mainland China and uses GCJ-02 (large-scale offsets in China).'
        }),
        field('myCall', 'ui', 'string', '', {
            pattern: /^[A-Z0-9/]{3,12}$/, upper: true, allowEmpty: true, maxLen: 12,
            scope: 'both', label: 'My callsign', zh: '我的呼号',
            desc: 'Used by the server to tag "my" spots and to auto-adjust monitored calls.'
        }),
        field('grid', 'ui', 'string', '', {
            pattern: /^[A-R]{2}[0-9]{2}([A-X]{2})?$/i, upper: true, allowEmpty: true, maxLen: 6,
            scope: 'both', label: 'My grid', zh: '我的网格',
            desc: 'Maidenhead locator (4 or 6 chars); home position on QSO map and propagation DE.'
        }),
        field('txPowerW', 'ui', 'int', 0, {
            min: 0, max: 1500, scope: 'both', label: 'TX power (W)', zh: '发射功率（W）',
            desc: 'Optional override; empty/0 = assume 50 W (typical 10–70 W) for path analysis.'
        }),
        field('pskWindowMin', 'ui', 'enum', '15', {
            values: ['5', '10', '15', '30'], scope: 'both',
            label: 'PSKReporter window (min)', zh: 'PSKReporter 聚合窗口（分钟）',
            desc: 'Aggregation window for FT8 path analysis; 15 by default, 5/10 for real-time, 30 for stability.'
        }),
        field('layout', 'ui', 'enum', '1x1', {
            values: LAYOUTS, storage: 'local', label: 'Layout', zh: '布局',
            desc: 'Map grid layout; deliberately browser-local so phones and wall keep their own.'
        }),
        field('timeZone', 'ui', 'enum', 'utc', {
            values: TIME_ZONES, label: 'Time zone', zh: '时区',
            desc: 'UTC vs local rendering for clocks and tables.'
        }),
        field('hour12', 'ui', 'bool', false, {
            label: '12-hour clock', zh: '12 小时制',
            desc: '12/24-hour display.'
        }),
        field('showSeconds', 'ui', 'bool', true, {
            label: 'Show seconds', zh: '显示秒',
            desc: 'Seconds in clocks and record timestamps.'
        }),
        field('clockSec', 'ui', 'int', 1, {
            min: 1, max: 60, label: 'Clock refresh (s)', zh: '时钟刷新（秒）',
            desc: 'Clock tick interval.'
        }),

        // ---- map / Spot Map
        field('ttl', 'map', 'intMap', DEFAULT_TTL_MIN, {
            keys: ['CW', 'SSB', 'DIGI'], min: 1, max: 180,
            label: 'Marker lifetime (min)', zh: '标记存活（分钟）',
            desc: 'Per-mode lifetime for markers, link lines and band chips.'
        }),
        field('bandColors', 'map', 'colorMap', DEFAULT_BAND_COLORS, {
            keys: BAND_COLOR_KEYS, label: 'Band colours', zh: '频段配色',
            desc: 'Per-band colour used by markers, links and band chips.'
        }),
        field('rotationSec', 'map', 'int', 15, {
            min: 3, max: 600, storage: 'external', label: 'Rotation interval (s)', zh: '轮播间隔（秒）',
            desc: 'DVR-style page rotation interval; stored in dxcompass-rot-sec, not in uiSettings.'
        }),
        field('autoFitMaxZoom', 'map', 'int', 7, {
            min: 3, max: 10, label: 'Auto-fit max zoom', zh: '自动适配最大层级',
            desc: 'Cap for per-cell marker auto-fit.'
        }),
        field('fitPad', 'map', 'number', 0.08, {
            min: 0, max: 0.3, label: 'Fit padding', zh: '适配内边距',
            desc: 'Bounds padding ratio for auto-fit.'
        }),
        field('terminatorShow', 'map', 'bool', true, {
            label: 'Day/night overlay', zh: '晨昏线',
            desc: 'Draw the gray line and night shading.'
        }),
        field('terminatorSec', 'map', 'int', 60, {
            min: 30, max: 600, label: 'Terminator refresh (s)', zh: '晨昏线刷新（秒）',
            desc: 'Terminator recompute interval.'
        }),
        field('heatShow', 'map', 'bool', true, {
            label: 'Heatmap', zh: '热力图',
            desc: 'CW/DIGI heatmaps per band.'
        }),
        field('heatRadius', 'map', 'int', 38, {
            min: 10, max: 80, label: 'Heat radius', zh: '热力半径',
            desc: 'Heat blob radius in pixels.'
        }),
        field('heatBlur', 'map', 'int', 28, {
            min: 5, max: 60, label: 'Heat blur', zh: '热力模糊',
            desc: 'Heat blob blur in pixels.'
        }),
        field('heatOpacity', 'map', 'number', 0.3, {
            min: 0.05, max: 1, label: 'Heat intensity', zh: '热力强度',
            desc: 'Minimum heat opacity (minOpacity).'
        }),
        field('gcShow', 'map', 'bool', true, {
            label: 'Great-circle links', zh: '大圆连线',
            desc: 'Draw monitored -> spotter great-circle paths.'
        }),
        field('gcSamples', 'map', 'int', 64, {
            min: 16, max: 128, label: 'Great-circle samples', zh: '大圆采样点',
            desc: 'Interpolation samples per path.'
        }),
        field('spotterSize', 'map', 'int', 12, {
            min: 4, max: 24, label: 'Spotter dot size', zh: '监听站大小',
            desc: 'Red spotter marker diameter in pixels.'
        }),
        field('monitoredSize', 'map', 'int', 14, {
            min: 4, max: 24, label: 'Monitored dot size', zh: '被监听站大小',
            desc: 'Green monitored marker diameter in pixels.'
        }),
        field('historyLimit', 'map', 'int', 500, {
            min: 100, max: 2000, label: 'History replay limit', zh: '历史回放条数',
            desc: 'Spots replayed after a browser refresh.'
        }),
        field('markerMax', 'map', 'int', 500, {
            min: 100, max: 2000, label: 'Markers per cell', zh: '每格标记上限',
            desc: 'Oldest marker in a cell is dropped beyond this count.'
        }),
        field('fadeSec', 'map', 'int', 10, {
            min: 5, max: 60, label: 'Fade tick (s)', zh: '淡出刷新（秒）',
            desc: 'Marker opacity recompute interval.'
        }),
        field('pruneSec', 'map', 'int', 30, {
            min: 10, max: 300, label: 'Prune tick (s)', zh: '剪枝刷新（秒）',
            desc: 'Expired marker cleanup interval.'
        }),

        // ---- qso / QSO Map
        field('qsoMax', 'qso', 'int', 1500, {
            min: 200, max: 4000, label: 'QSO markers limit', zh: 'QSO 标记上限',
            desc: 'Oldest QSO markers are dropped beyond this count.'
        }),
        field('n1mmToken', 'qso', 'string', '', {
            allowEmpty: true, maxLen: 200,
            label: 'N1MM HTTP ingest token', zh: 'N1MM HTTP 接入令牌',
            desc: 'Required by POST /api/n1mm/ingest (X-DX-Token header). Empty disables HTTP ingest; UDP is unaffected.'
        }),
        field('qsoLines', 'qso', 'bool', true, {
            label: 'Home -> QSO lines', zh: '本台→QSO 连线', desc: 'Draw great-circle lines from home to each QSO.'
        }),
        field('qsoAutoFit', 'qso', 'bool', true, {
            label: 'Auto zoom to fit QSOs', zh: 'QSO 自动缩放', desc: 'Auto-fit the QSO map after updates.'
        }),
        field('qsoVoiceAlert', 'qso', 'bool', true, {
            label: 'Voice alert', zh: '语音告警', desc: 'Speak new spots with SpeechSynthesis.'
        }),
        field('mySpotTtl', 'qso', 'int', 30, {
            min: 1, max: 180, label: 'My spot lifetime (min)', zh: '我的 SPOT 存活（分钟）',
            desc: 'Lifetime of markers derived from my own callsign.'
        }),
        field('mySpotMax', 'qso', 'int', 300, {
            min: 10, max: 2000, label: 'My spot max markers', zh: '我的 SPOT 上限',
            desc: 'Upper bound for my-own-spot markers.'
        }),
        field('mySpotPopup', 'qso', 'bool', true, {
            label: 'My spot popup', zh: '我的 SPOT 弹窗', desc: 'Popup for spots heard at my station.'
        }),
        field('mySpotVoice', 'qso', 'bool', true, {
            label: 'My spot voice', zh: '我的 SPOT 语音', desc: 'Voice alert for spots heard at my station.'
        }),
        field('rateBucketMin', 'qso', 'int', 5, {
            min: 1, max: 30, label: 'Rate bucket (min)', zh: '速率分桶（分钟）',
            desc: 'Bucket width for the QSO rate chart.'
        }),
        field('minBuckets', 'qso', 'int', 30, {
            min: 6, max: 120, label: 'Rate buckets', zh: '速率柱数量',
            desc: 'Number of wall-clock aligned buckets.'
        }),
        field('qsoHistoryLimit', 'qso', 'int', 500, {
            min: 100, max: 2000, label: 'QSO history limit', zh: 'QSO 历史条数',
            desc: 'QSO rows fetched on load.'
        }),
        field('freqDeltaKhz', 'qso', 'number', 1, {
            min: 0, max: 50, label: 'Frequency alert delta (kHz)', zh: '换频播报阈值（kHz）',
            desc: 'Minimum frequency change before announcing.'
        }),
        field('alertPopupMs', 'qso', 'int', 8000, {
            min: 2000, max: 30000, label: 'Alert popup duration (ms)', zh: '弹窗时长（毫秒）',
            desc: 'Visible time of the spot alert card.'
        }),
        field('alertSnrMin', 'qso', 'int', -30, {
            min: -30, max: 30, label: 'Alert min SNR (-30 = off)', zh: '告警 SNR 门槛（-30 关）',
            desc: 'Only alert when spot SNR is at least this value.'
        }),
        field('alertDistanceKmMin', 'qso', 'int', 0, {
            min: 0, max: 20000, label: 'Alert min distance (km, 0 = off)', zh: '告警距离门槛（km，0 关）',
            desc: 'Only alert when the path is longer than this.'
        }),
        field('voiceRate', 'qso', 'number', 1.05, {
            min: 0.6, max: 1.6, label: 'Voice rate', zh: '语速',
            desc: 'SpeechSynthesisUtterance.rate.'
        }),
        field('voiceVolume', 'qso', 'number', 1, {
            min: 0, max: 1, label: 'Voice volume', zh: '音量',
            desc: 'SpeechSynthesisUtterance.volume.'
        }),
        field('quietFrom', 'qso', 'time', '', {
            pattern: /^([01]\d|2[0-3]):[0-5]\d$/, allowEmpty: true,
            label: 'Quiet hours from', zh: '静音开始',
            desc: 'Local time when spot popups and voice alerts stop (empty = disabled).'
        }),
        field('quietTo', 'qso', 'time', '', {
            pattern: /^([01]\d|2[0-3]):[0-5]\d$/, allowEmpty: true,
            label: 'Quiet hours to', zh: '静音结束',
            desc: 'Local time when alerts resume; a window crossing midnight is supported.'
        }),
        field('alertSound', 'qso', 'bool', false, {
            label: 'Alert tone', zh: '提示音',
            desc: 'Short beep with each spot alert; off by default, independent of voice.'
        }),
        field('alertSoundVolume', 'qso', 'number', 0.5, {
            min: 0, max: 1, label: 'Alert tone volume', zh: '提示音音量',
            desc: 'Beep volume (0 = silent); separate from the speech volume.'
        }),
        field('opSuspiciousCheck', 'qso', 'bool', true, {
            label: 'OP view: call review', zh: 'OP 视图：呼号复核',
            desc: 'Check each radio latest QSO: SCP first, then QRZ.'
        }),
        field('opScpCheck', 'qso', 'bool', true, {
            label: 'OP view: Super Check Partial', zh: 'OP 视图：使用 SCP 复核',
            desc: 'Use SCP before QRZ; the list is downloaded at runtime and cached under var/scp.'
        }),
        field('opSuspiciousQrz', 'qso', 'bool', true, {
            label: 'OP view: allow QRZ review', zh: 'OP 视图：允许 QRZ 复核',
            desc: 'Only called when SCP misses; off = the call stays unconfirmed.'
        }),
        field('opRotatorConfigured', 'qso', 'bool', false, {
            label: 'OP view: rotator configured', zh: 'OP 视图：已配置旋转器',
            desc: 'Map clicks send a target bearing to the rotator adapter.'
        }),
        field('opRotatorName', 'qso', 'string', 'Rotator', {
            maxLen: 40, allowEmpty: true, label: 'OP view: rotator name', zh: 'OP 视图：旋转器名称',
            desc: 'Shown in the bottom device bay.'
        }),
        field('opAntennaSwitchConfigured', 'qso', 'bool', false, {
            label: 'OP view: antenna switch configured', zh: 'OP 视图：已配置天线切换器',
            desc: 'Shows the antenna switch card in the bottom bay.'
        }),
        field('opAntennaSwitchName', 'qso', 'string', 'Antenna switch', {
            maxLen: 40, allowEmpty: true, label: 'OP view: antenna switch name', zh: 'OP 视图：天线切换器名称',
            desc: 'Shown in the bottom device bay.'
        }),
        field('opTowerConfigured', 'qso', 'bool', false, {
            label: 'OP view: tower configured', zh: 'OP 视图：已配置天线塔',
            desc: 'Shows the tower lift card in the bottom bay.'
        }),
        field('opTowerName', 'qso', 'string', 'Tower', {
            maxLen: 40, allowEmpty: true, label: 'OP view: tower name', zh: 'OP 视图：天线塔名称',
            desc: 'Shown in the bottom device bay.'
        }),
        field('towerLimitType', 'qso', 'enum', 'NO', {
            values: ['NO', 'NC'], scope: 'both',
            label: 'Tower limit switch type', zh: '天线塔限位开关类型',
            desc: '按实际接线选择，选错会显示相反状态。'
        }),
        field('towerPulseWidthMs', 'qso', 'int', 400, {
            min: 50, max: 5000, scope: 'both',
            label: 'Tower start pulse (ms)', zh: '天线塔启动脉冲宽度（ms）',
            desc: '脉冲过短接触器可能不吸合，过长会增加误动作窗口；随时可改。'
        }),
        field('opRunIdleMin', 'qso', 'int', 10, {
            min: 2, max: 60, label: 'OP view: RUN idle reminder (min)', zh: 'OP 视图：RUN 空闲提醒（分钟）',
            desc: 'Suggest S&P when a RUN radio has no QSO for this many minutes.'
        }),

        // ---- wall / Wall
        field('wallTitle', 'wall', 'string', 'DX-COMPASS', {
            maxLen: 24, truncate: true, label: 'Wall title', zh: '大屏标题', desc: 'Brand text on the wall header.'
        }),
        field('wallMode', 'wall', 'enum', 'all', {
            values: WALL_MODES, label: 'Overlay mode', zh: '叠加模式',
            desc: 'all = every layer at once, cycle = rotate layers.'
        }),
        field('wallLayers', 'wall', 'enumArray', ['prop', 'qso', 'myspot', 'dxspot'], {
            values: WALL_LAYERS, label: 'Wall layers', zh: '大屏图层',
            desc: 'Which overlays are rendered on the wall page.'
        }),
        field('wallTimerOn', 'wall', 'bool', false, {
            label: 'Countdown', zh: '倒计时', desc: 'Show the UTC contest countdown.'
        }),
        field('wallTimerStart', 'wall', 'datetime', '', {
            pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, allowEmpty: true, maxLen: 19,
            label: 'Countdown start (UTC)', zh: '倒计时开始（UTC）', desc: 'UTC start of the contest window.'
        }),
        field('wallTimerEnd', 'wall', 'datetime', '', {
            pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, allowEmpty: true, maxLen: 19,
            label: 'Countdown end (UTC)', zh: '倒计时结束（UTC）', desc: 'UTC end of the contest window.'
        }),
        field('multPerBand', 'contest', 'bool', true, {
            label: 'DXCC multiplier per band', zh: 'DXCC 倍率按波段计算',
            desc: 'On = one DXCC slot per band; off = one DXCC slot across all bands.'
        }),
        field('cycleSec', 'wall', 'int', 10, {
            min: 3, max: 60, label: 'Layer dwell (s)', zh: '图层停留（秒）',
            desc: 'Per-layer dwell in cycle mode.'
        }),
        field('spaceDwellSec', 'wall', 'int', 8, {
            min: 3, max: 30, label: 'Space weather dwell (s)', zh: '空间天气停留（秒）',
            desc: 'Dwell of the space-weather card rotation.'
        }),
        field('syncSec', 'wall', 'int', 60, {
            min: 10, max: 300, label: 'Wall config sync (s)', zh: '大屏配置同步（秒）',
            desc: 'How often the wall pulls /api/settings.'
        }),
        field('wallSpotSec', 'wall', 'int', 30, {
            min: 5, max: 300, label: 'Wall spot poll (s)', zh: '大屏 SPOT 轮询（秒）',
            desc: 'How often the wall reloads the spot feed.'
        }),
        field('wallQsoSec', 'wall', 'int', 30, {
            min: 5, max: 300, label: 'Wall QSO poll (s)', zh: '大屏 QSO 轮询（秒）',
            desc: 'How often the wall reloads QSO rows.'
        }),
        field('wallStationSec', 'wall', 'int', 15, {
            min: 5, max: 120, label: 'Wall station poll (s)', zh: '大屏电台轮询（秒）',
            desc: 'How often the wall reloads the station snapshot.'
        }),
        field('topLat', 'wall', 'int', 85, {
            min: 0, max: 90, label: 'Map north latitude', zh: '地图北纬',
            desc: 'Northern clip of the wall world fit.'
        }),
        field('bottomLat', 'wall', 'int', -85, {
            min: -90, max: 0, label: 'Map south latitude', zh: '地图南纬',
            desc: 'Southern clip of the wall world fit.'
        }),
        field('opponentWindowMin', 'wall', 'int', 30, {
            min: 5, max: 180, label: 'Opponent window (min)', zh: '对手窗口（分钟）',
            desc: 'Spot window used by the opponent card.'
        }),
        field('opponentCompactMin', 'wall', 'int', 5, {
            min: 2, max: 12, label: 'Compact threshold', zh: '紧凑模式阈值（对手数）',
            desc: 'Switch opponent cards to the compact grid at this count.'
        }),
        field('opponentBandsMax', 'wall', 'int', 12, {
            min: 3, max: 12, label: 'Bands per card', zh: '每卡频段上限',
            desc: 'Maximum band cells rendered inside one opponent card.'
        }),
        field('concentrationMin', 'wall', 'number', 0.4, {
            min: 0, max: 1, label: 'Direction concentration', zh: '方向集中度',
            desc: 'Minimum share for the dominant direction label.'
        }),

        // ---- data / Data & Alerts
        field('pollDxwatchSec', 'data', 'int', 30, {
            min: 5, max: 300, scope: 'server', wired: true,
            label: 'dxwatch poll (s)', zh: 'dxwatch 轮询（秒）',
            desc: 'dxwatch ingest interval; the 5s flow tick is gated by this value.'
        }),
        field('pollRbnSec', 'data', 'int', 10, {
            min: 5, max: 300, scope: 'server', wired: true,
            label: 'RBN poll (s)', zh: 'RBN 轮询（秒）',
            desc: 'reversebeacon ingest interval; keep >= 5s to avoid bans.'
        }),
        field('pollPskrSyncSec', 'data', 'int', 120, {
            min: 30, max: 900, scope: 'server', wired: true,
            label: 'PSKR sync (s)', zh: 'PSKR 订阅同步（秒）',
            desc: 'MQTT subscription resync interval.'
        }),
        field('sourceDxwatch', 'data', 'bool', true, {
            scope: 'server', wired: true, label: 'Enable dxwatch', zh: '启用 dxwatch',
            desc: 'Master switch for the dxwatch source.'
        }),
        field('sourceRbn', 'data', 'bool', true, {
            scope: 'server', wired: true, label: 'Enable RBN', zh: '启用 RBN',
            desc: 'Master switch for reversebeacon.net.'
        }),
        field('sourcePskr', 'data', 'bool', true, {
            scope: 'server', wired: true, label: 'Enable PSKReporter', zh: '启用 PSKReporter',
            desc: 'Master switch for the PSKReporter MQTT stream.'
        }),
        field('freshSec', 'data', 'int', 3600, {
            min: 300, max: 7200, scope: 'both', wired: true,
            label: 'Active spot window (s)', zh: '活跃窗口（秒）',
            desc: 'Server replay window; spots stay persisted beyond it.'
        }),
        field('retentionSpotsDays', 'data', 'int', 0, {
            min: 0, max: 3650, scope: 'server', wired: true,
            label: 'Spot retention (days, 0 = keep)', zh: 'SPOT 保留（天，0 永久）',
            desc: 'Hourly purge of the spots table; 0 keeps everything.'
        }),
        field('retentionRecordingMonths', 'data', 'int', 2, {
            min: 1, max: 120, scope: 'server', wired: true,
            label: 'Recording retention (months)', zh: '录音保留（月）',
            desc: 'Hourly purge of recording_spots older than this many months.'
        }),
        field('retentionQsoDays', 'data', 'int', 0, {
            min: 0, max: 3650, scope: 'server', wired: true,
            label: 'QSO retention (days, 0 = keep)', zh: 'QSO 保留（天，0 永久）',
            desc: 'Hourly purge of the qsos table; 0 keeps everything.'
        }),
        field('retentionActivityDays', 'data', 'int', 7, {
            min: 0, max: 3650, scope: 'server', wired: true,
            label: 'Band activity retention (days, 0 = keep)', zh: '波段活跃度保留（天，0 永久）',
            desc: 'Hourly purge of the 5-minute band_activity buckets; 0 keeps everything.'
        }),
        field('autoPurge', 'data', 'bool', true, {
            scope: 'server', wired: true, label: 'Automatic purge', zh: '自动清理',
            desc: 'Enable the hourly retention job.'
        }),
        field('recordsRefreshSec', 'data', 'int', 15, {
            min: 5, max: 300, label: 'Records refresh (s)', zh: '记录刷新（秒）',
            desc: 'Records panel refresh interval.'
        }),
        field('propPollSec', 'data', 'int', 60, {
            min: 30, max: 600, label: 'Propagation refresh (s)', zh: '传播页刷新（秒）',
            desc: 'Propagation page polling interval.'
        }),
        field('maxCallsigns', 'data', 'int', 9, {
            min: 1, max: 27, scope: 'server', wired: true,
            label: 'Max monitored callsigns', zh: '被监控呼号上限',
            desc: 'Caps /api/callsigns and the PSKR subscription list.'
        }),
        field('logLevel', 'data', 'enum', 'info', {
            values: LOG_LEVELS, scope: 'server', wired: true,
            label: 'Log level', zh: '日志级别',
            desc: 'DX-Compass module log threshold (error/warn/info/debug); Node-RED core logging stays in settings.js.'
        }),
        field('httpProxy', 'data', 'string', '', {
            maxLen: 300, allowEmpty: true, scope: 'server', wired: true,
            label: 'HTTP proxy', zh: 'HTTP 代理',
            desc: 'Outbound proxy for the propagation collector; empty = direct.'
        }),
        field('fetchTimeoutMs', 'data', 'int', 25000, {
            min: 5000, max: 60000, scope: 'server', wired: true,
            label: 'Upstream timeout (ms)', zh: '上游超时（毫秒）',
            desc: 'Per-request timeout for the propagation collector.'
        }),
        field('upstreamBase', 'data', 'string', '', {
            maxLen: 200, allowEmpty: true, scope: 'server', wired: true,
            label: 'SWPC base URL', zh: 'SWPC 上游地址',
            desc: 'Override for services.swpc.noaa.gov; empty = official endpoint.'
        }),
        field('n1mmPorts', 'data', 'string', '12060,12061,12062', {
            pattern: /^\d{2,5}(,\d{2,5}){0,5}$/, maxLen: 40, scope: 'server', restart: true,
            wired: false, readonly: true,
            label: 'N1MM UDP ports', zh: 'N1MM UDP 端口',
            desc: 'Read-only: the UDP listen ports are node properties in flow.json, so changing them needs a flow edit and redeploy.'
        }),
        field('recordingRepeat', 'data', 'enum', 'once', {
            values: RECORDING_REPEATS, scope: 'server', wired: true,
            label: 'Recording repeat', zh: '录音重复',
            desc: 'once / daily / weekly scheduled recording.'
        }),
        field('diskWarnPct', 'data', 'int', 90, {
            min: 50, max: 100, scope: 'server', wired: true,
            label: 'Disk warn (%)', zh: '磁盘告警阈值（%）',
            desc: 'Warn when the Node-RED working directory filesystem exceeds this usage percentage.'
        }),
        field('diskCheckSec', 'data', 'int', 300, {
            min: 30, max: 3600, scope: 'server', wired: true,
            label: 'Disk check (s)', zh: '磁盘检查间隔（秒）',
            desc: 'Minimum interval between disk usage checks.'
        }),
        field('diskAlert', 'data', 'bool', true, {
            scope: 'server', wired: true, label: 'Disk alert', zh: '磁盘告警',
            desc: 'Emit a Node-RED warning when free space crosses the threshold.'
        }),
        field('alertsEnabled', 'data', 'bool', false, {
            scope: 'server', wired: true,
            label: 'Conditional alerts', zh: '条件告警',
            desc: 'Master switch for rule-based spot alerts; off by default so a new install never beeps.'
        }),
        field('alertMinIntervalSec', 'data', 'int', 60, {
            min: 0, max: 3600, scope: 'server', wired: true,
            label: 'Alert min interval (s)', zh: '告警最短间隔（秒）',
            desc: 'Global floor between two rule alerts; 0 disables the throttle.'
        }),
        field('alertDedupeMin', 'data', 'int', 10, {
            min: 1, max: 1440, scope: 'server', wired: true,
            label: 'Alert dedupe window (min)', zh: '告警去重窗口（分钟）',
            desc: 'The same call + band is announced at most once inside this window (frequency inside freqDeltaKhz counts as the same spot).'
        }),
        field('alertPopup', 'data', 'bool', true, {
            scope: 'both', wired: true,
            label: 'Rule alert popup', zh: '规则告警弹窗',
            desc: 'Allow the in-page alert card for rule hits; still muted by quiet hours.'
        }),

        // ---- contest / Contest
        field('category', 'contest', 'enum', 'SO1R', {
            values: CONTEST_CATEGORIES, scope: 'both', label: 'Contest category', zh: '比赛类别',
            desc: 'Entry category; decides which tactical rules and station lanes apply.'
        }),
        field('operators', 'contest', 'string', '', {
            maxLen: 200, allowEmpty: true, scope: 'both',
            label: 'Operator list', zh: '操作员名单',
            desc: 'Comma-separated operator callsigns, in seat order when no live N1MM operator is reported.'
        }),
        field('seatCount', 'contest', 'int', 1, {
            min: 1, max: 12, scope: 'both',
            label: 'Seat count', zh: '席位数',
            desc: 'Number of operating seats; each seat is one operator on one radio.'
        }),
        field('seatRadios', 'contest', 'string', '', {
            maxLen: 80, allowEmpty: true, scope: 'both',
            label: 'Seat-radio binding', zh: '席位-电台绑定',
            desc: 'RadioNr per seat in order, comma separated (e.g. 1,2). Empty = follow the live radios.'
        }),
        field('contestName', 'contest', 'string', '', {
            maxLen: 120, allowEmpty: true, scope: 'both',
            label: 'Contest name', zh: '比赛名称',
            desc: 'Shown in the header countdown and used as the contest label.'
        }),
        field('contestStart', 'contest', 'datetime', '', {
            pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, allowEmpty: true, maxLen: 19,
            scope: 'both', label: 'Contest start (UTC)', zh: '比赛开始（UTC）',
            desc: 'UTC start; takes priority over the wall countdown for the multiplier window.'
        }),
        field('contestEnd', 'contest', 'datetime', '', {
            pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, allowEmpty: true, maxLen: 19,
            scope: 'both', label: 'Contest end (UTC)', zh: '比赛结束（UTC）',
            desc: 'UTC end; the server clears the contest automatically once this time passes.'
        }),
        field('contestModes', 'contest', 'string', '', {
            maxLen: 80, allowEmpty: true, scope: 'both',
            label: 'Allowed modes', zh: '允许模式',
            desc: 'Free text entered by the operator, e.g. CW or CW, SSB.'
        }),
        field('contestBands', 'contest', 'string', '', {
            maxLen: 120, allowEmpty: true, scope: 'both',
            label: 'Allowed bands', zh: '允许波段',
            desc: 'Free text entered by the operator, e.g. 20m or 20m, 40m.'
        }),
        field('contestRulesUrl', 'contest', 'string', '', {
            maxLen: 300, allowEmpty: true, scope: 'both',
            label: 'Rules link', zh: '规则链接',
            desc: 'Official rules page entered by the operator.'
        }),
        field('contestType', 'contest', 'enum', 'AUTO', {
            values: CONTEST_TYPES, scope: 'both',
            label: 'Contest rules family', zh: '赛事规则族',
            desc: 'Decides which tactical rules apply. AUTO derives it from the contest name; explicit wins when set.'
        }),
        field('powerClass', 'contest', 'enum', 'UNKNOWN', {
            values: POWER_CLASSES, scope: 'both',
            label: 'Power class', zh: '功率组别',
            desc: 'HP <= 1500 W, LP <= 100 W, QRP <= 5 W. UNKNOWN never gates advice.'
        }),
        field('contestSingleBand', 'contest', 'enum', '', {
            values: SINGLE_BANDS, scope: 'both',
            label: 'Single-band entry', zh: '单波段参赛',
            desc: 'Empty = all-band entry; otherwise the only band allowed by the entry category.'
        }),
        field('multMode', 'contest', 'enum', 'dxcc-per-band', {
            values: MULT_MODES, scope: 'both',
            label: 'Multiplier counting', zh: '乘数计法',
            desc: 'dxcc-per-band / dxcc-total / wpx. Legacy multPerBand is kept in sync by migration.'
        }),
        field('bandChangeRule', 'contest', 'enum', 'none', {
            values: BAND_CHANGE_RULES, scope: 'both',
            label: 'Band-change rule', zh: '换波段约束',
            desc: 'none = follow the contest rules file; time-lock = 10 minutes; hourly-quota = N changes per clock hour.'
        }),
        field('bandChangeLimit', 'contest', 'int', 0, {
            min: 0, max: 60, scope: 'both',
            label: 'Band-change quota (per hour)', zh: '每小时换波段上限',
            desc: 'Used when bandChangeRule=hourly-quota; 0 falls back to the contest default (MS 10, M2 8).'
        }),
        field('msRole', 'contest', 'enum', 'none', {
            values: MS_ROLES, scope: 'both',
            label: 'Multi-op role', zh: '多人台角色',
            desc: 'run / mult / none; affects whether RUN-idle and multiplier-gap advice applies.'
        }),
        field('adviceEnabled', 'contest', 'bool', true, {
            scope: 'both', label: 'Real-time advice', zh: '实时决策辅助',
            desc: 'Master switch for the /api/advice rule engine and the OP advice card.'
        }),
        field('adviceRefreshSec', 'contest', 'int', 60, {
            min: 15, max: 600, scope: 'both',
            label: 'Advice refresh (s)', zh: '建议刷新（秒）',
            desc: 'OP view polling interval for /api/advice.'
        }),
        field('adviceMinConfidence', 'contest', 'enum', 'low', {
            values: ADVICE_LEVELS, scope: 'both',
            label: 'Minimum advice confidence', zh: '建议最低置信度',
            desc: 'low/medium/high; higher hides weak-evidence rules.'
        }),
        field('adviceConfig', 'contest', 'string', '', {
            maxLen: 2000, allowEmpty: true, scope: 'server',
            label: 'Advice thresholds (JSON)', zh: '建议阈值（JSON）',
            desc: 'D-level threshold overrides, e.g. {"stayRateRatio":0.75,"idleMin":10}. Invalid JSON falls back to defaults.'
        }),

        // ---- prop / Propagation
        field('propProj', 'prop', 'enum', 'robinson', {
            values: PROP_PROJECTIONS, label: 'Projection', zh: '投影',
            desc: 'Propagation map projection.'
        }),
        field('propLayer', 'prop', 'enum', 'muf', {
            values: PROP_LAYERS, label: 'Layer', zh: '图层', desc: 'Propagation raster overlay.'
        }),
        field('propDxLat', 'prop', 'number', 40, {
            min: -85, max: 85, scope: 'both', label: 'DX latitude', zh: 'DX 纬度',
            desc: 'Point-to-point DX target latitude.'
        }),
        field('propDxLon', 'prop', 'number', -100, {
            min: -180, max: 180, scope: 'both', label: 'DX longitude', zh: 'DX 经度',
            desc: 'Point-to-point DX target longitude.'
        }),
        field('collectSec', 'prop', 'int', 300, {
            min: 60, max: 3600, scope: 'server', wired: true,
            label: 'Collector interval (s)', zh: '采集间隔（秒）',
            desc: 'SWPC/GAMBIT collection interval; the 30s flow tick is gated by this value.'
        }),
        field('condClosed', 'prop', 'number', 0.97, {
            min: 0.5, max: 1, scope: 'server', wired: true, label: 'Closed threshold', zh: '关闭阈值',
            desc: 'Frequency above this ratio of MUF is Closed.'
        }),
        field('condGood', 'prop', 'number', 0.55, {
            min: 0, max: 1, scope: 'server', wired: true, label: 'Good threshold', zh: '良好阈值',
            desc: 'Headroom ratio above this is Good.'
        }),
        field('condFair', 'prop', 'number', 0.25, {
            min: 0, max: 1, scope: 'server', wired: true, label: 'Fair threshold', zh: '一般阈值',
            desc: 'Headroom ratio above this is Fair.'
        }),
        field('mufOpacity', 'prop', 'int', 77, {
            min: 0, max: 255, label: 'MUF opacity', zh: 'MUF 透明度',
            desc: 'Alpha of the MUF raster overlay (0-255) on the propagation page and the wall.'
        }),
        field('nightOpacity', 'prop', 'number', 0.18, {
            min: 0, max: 1, label: 'Night shading opacity', zh: '夜罩透明度',
            desc: 'Night-side shading alpha; the twilight band scales with it.'
        })
    ];

    const FIELD_MAP = {};
    const DOMAIN_FIELDS = {};
    const KNOWN_KEYS = new Set();
    for (const f of FIELDS) {
        FIELD_MAP[f.key] = f;
        (DOMAIN_FIELDS[f.domain] = DOMAIN_FIELDS[f.domain] || []).push(f);
        KNOWN_KEYS.add(f.key);
    }
    KNOWN_KEYS.add('_ext');
    KNOWN_KEYS.add('_rev');
    KNOWN_KEYS.add('cfgV');

    function isPlain(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    function clone(value) {
        if (Array.isArray(value)) return value.slice();
        if (isPlain(value)) {
            const out = {};
            for (const key of Object.keys(value)) out[key] = clone(value[key]);
            return out;
        }
        return value;
    }

    function defaultsForDomain(domain) {
        const out = {};
        const list = (domain === 'all' ? FIELDS : (DOMAIN_FIELDS[domain] || []))
            .filter(f => f.storage !== 'external');
        for (const f of list) out[f.key] = clone(f.default);
        return out;
    }

    function defaultSettings() {
        const out = defaultsForDomain('all');
        out.cfgV = SCHEMA_VERSION;
        return out;
    }

    function asInt(value) {
        if (typeof value === 'number') return Number.isInteger(value) ? value : NaN;
        if (typeof value === 'string' && value.trim() !== '') {
            const n = Number(value);
            return Number.isInteger(n) ? n : NaN;
        }
        return NaN;
    }

    function asNumber(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
        if (typeof value === 'string' && value.trim() !== '') {
            const n = Number(value);
            return Number.isFinite(n) ? n : NaN;
        }
        return NaN;
    }

    function validateValue(f, value) {
        switch (f.type) {
            case 'enum': {
                const allowed = f.values || [];
                if (typeof value === 'string' && allowed.includes(value)) return {ok: true, value};
                return {ok: false, reason: `expected one of ${allowed.join('/')}`};
            }
            case 'bool':
                return typeof value === 'boolean' ? {ok: true, value} : {ok: false, reason: 'expected boolean'};
            case 'int': {
                const n = asInt(value);
                if (!Number.isFinite(n)) return {ok: false, reason: 'expected integer'};
                if (f.min !== undefined && n < f.min) return {ok: false, reason: `below minimum ${f.min}`};
                if (f.max !== undefined && n > f.max) return {ok: false, reason: `above maximum ${f.max}`};
                return {ok: true, value: n};
            }
            case 'number': {
                const n = asNumber(value);
                if (!Number.isFinite(n)) return {ok: false, reason: 'expected number'};
                if (f.min !== undefined && n < f.min) return {ok: false, reason: `below minimum ${f.min}`};
                if (f.max !== undefined && n > f.max) return {ok: false, reason: `above maximum ${f.max}`};
                return {ok: true, value: n};
            }
            case 'string': {
                if (typeof value !== 'string') return {ok: false, reason: 'expected string'};
                const str0 = (f.upper ? value.toUpperCase() : value).trim();
                if (str0 === '') {
                    return f.allowEmpty ? {ok: true, value: ''} : {ok: false, reason: 'required'};
                }
                let str = str0;
                if (f.maxLen !== undefined && str.length > f.maxLen) {
                    if (!f.truncate) return {ok: false, reason: `longer than ${f.maxLen}`};
                    str = str.slice(0, f.maxLen);
                }
                if (f.pattern && !f.pattern.test(str)) return {ok: false, reason: 'format mismatch'};
                return {ok: true, value: str};
            }
            case 'color':
                return /^#[0-9a-fA-F]{6}$/.test(String(value || ''))
                    ? {ok: true, value: String(value)}
                    : {ok: false, reason: 'expected #RRGGBB'};
            case 'datetime':
            case 'time': {
                if (value === '' && f.allowEmpty) return {ok: true, value: ''};
                const str = String(value || '');
                return f.pattern && f.pattern.test(str)
                    ? {ok: true, value: str}
                    : {ok: false, reason: 'expected date/time string'};
            }
            case 'intMap': {
                if (!isPlain(value)) return {ok: false, reason: 'expected object'};
                const out = {};
                for (const key of f.keys) {
                    const n = asInt(value[key]);
                    out[key] = Number.isFinite(n) && n >= f.min && n <= f.max ? n : f.default[key];
                }
                return {ok: true, value: out};
            }
            case 'colorMap': {
                if (!isPlain(value)) return {ok: false, reason: 'expected object'};
                const out = {};
                for (const key of f.keys) {
                    const color = value[key];
                    out[key] = /^#[0-9a-fA-F]{6}$/.test(String(color || '')) ? String(color) : f.default[key];
                }
                return {ok: true, value: out};
            }
            case 'enumArray': {
                if (!Array.isArray(value)) return {ok: false, reason: 'expected array'};
                const allowed = f.values || [];
                const out = [];
                for (const item of value) if (allowed.includes(item) && !out.includes(item)) out.push(item);
                return {ok: true, value: out};
            }
            default:
                return {ok: false, reason: `unknown type ${f.type}`};
        }
    }

    function getPath(object, path) {
        return stringPath(path).reduce((acc, key) => (acc == null ? undefined : acc[key]), object);
    }

    function setPath(object, path, value) {
        const parts = stringPath(path);
        let cursor = object;
        for (let i = 0; i < parts.length - 1; i++) {
            if (!isPlain(cursor[parts[i]])) cursor[parts[i]] = {};
            cursor = cursor[parts[i]];
        }
        cursor[parts[parts.length - 1]] = value;
    }

    function stringPath(path) {
        return String(path).split('.');
    }

    function mergeDeep(target, patch) {
        const out = isPlain(target) ? clone(target) : {};
        if (!isPlain(patch)) return out;
        for (const key of Object.keys(patch)) {
            const value = patch[key];
            if (isPlain(value) && isPlain(out[key])) out[key] = mergeDeep(out[key], value);
            else out[key] = Array.isArray(value) ? value.slice() : clone(value);
        }
        return out;
    }

    /** Legacy data fix-ups; runs before validation and always stamps cfgV. */
    function migrate(input) {
        const raw = isPlain(input) ? clone(input) : {};
        const from = parseInt(raw.cfgV, 10);
        const version = Number.isFinite(from) ? from : 0;
        // v2 introduced Mercator as a valid projection. Older data still used
        // Mercator as the implicit default and must be moved to Robinson.
        if (version < 2 && raw.propProj === 'mercator') raw.propProj = 'robinson';
        // v4 引入 multMode；旧配置只有布尔 multPerBand，false 等价于“总计”。
        if (version < 4 && raw.multMode === undefined && raw.multPerBand === false) {
            raw.multMode = 'dxcc-total';
        }
        raw.cfgV = SCHEMA_VERSION;
        return raw;
    }

    function collectExt(raw) {
        const ext = {};
        let bytes = 0, count = 0;
        const candidates = {};
        if (isPlain(raw._ext)) Object.assign(candidates, raw._ext);
        for (const key of Object.keys(raw)) {
            if (KNOWN_KEYS.has(key)) continue;
            candidates[key] = raw[key];
        }
        for (const key of Object.keys(candidates)) {
            if (count >= 48) break;
            let size = 0;
            try { size = JSON.stringify(candidates[key]).length; }
            catch (e) { continue; }
            if (size > 2048 || bytes + size > 16384) continue;
            ext[key] = candidates[key];
            bytes += size;
            count += 1;
        }
        return Object.keys(ext).length ? ext : null;
    }

    /**
     * Validate a full settings object. Missing keys keep defaults, invalid
     * values fall back to defaults and are reported, unknown keys are kept
     * in the bounded _ext area so newer clients survive older servers.
     */
    function sanitize(input, options) {
        const opts = options || {};
        const raw = isPlain(input) ? migrate(input) : migrate({});
        const out = defaultSettings();
        const warnings = [];
        const rejected = [];
        for (const f of FIELDS) {
            if (f.storage === 'external') continue;
            if (!Object.prototype.hasOwnProperty.call(raw, f.key)) continue;
            const field = opts.enums && opts.enums[f.key]
                ? Object.assign({}, f, {values: opts.enums[f.key]})
                : f;
            const result = validateValue(field, raw[f.key]);
            if (result.ok) out[f.key] = result.value;
            else if (raw[f.key] !== undefined && raw[f.key] !== null) {
                rejected.push(f.key);
                warnings.push(`${f.key}: ${result.reason}; using default`);
            }
        }
        const ext = collectExt(raw);
        if (ext) out._ext = ext;
        if (Number.isInteger(raw._rev) && raw._rev >= 0) out._rev = raw._rev;
        // 兼容层：multPerBand 仍是 /api/multipliers 的入参，跟随 multMode 同步。
        if (out.multMode === 'dxcc-total') out.multPerBand = false;
        else if (out.multMode === 'dxcc-per-band') out.multPerBand = true;
        out.cfgV = SCHEMA_VERSION;
        return {settings: out, warnings, rejected};
    }

    /**
     * Validate only the keys present in a patch. Used by partial updates,
     * import and domain resets so absent keys are never overwritten.
     */
    function validatePatch(patch, options) {
        const opts = options || {};
        const raw = isPlain(patch) ? patch : {};
        const values = {};
        const warnings = [];
        const rejected = [];
        const unknown = [];
        for (const key of Object.keys(raw)) {
            if (!KNOWN_KEYS.has(key)) {
                unknown.push(key);
                continue;
            }
            const f = FIELD_MAP[key];
            if (!f) continue;
            if (f.storage === 'external') continue;
            const field = opts.enums && opts.enums[key]
                ? Object.assign({}, f, {values: opts.enums[key]})
                : f;
            const result = validateValue(field, raw[key]);
            if (result.ok) values[key] = result.value;
            else if (raw[key] !== undefined && raw[key] !== null) {
                rejected.push(key);
                warnings.push(`${key}: ${result.reason}; ignored`);
            }
        }
        const ext = collectExt(raw);
        if (ext) values._ext = mergeDeep(values._ext || {}, ext);
        if (Number.isInteger(raw._rev)) values._rev = raw._rev;
        if (values.multMode !== undefined) values.multPerBand = values.multMode !== 'dxcc-total';
        return {values, warnings, rejected, unknown};
    }

    return {
        SCHEMA_VERSION,
        DOMAINS,
        FIELDS,
        FIELD_MAP,
        DOMAIN_FIELDS,
        UI_LANGUAGES,
        THEMES,
        TILE_PROVIDERS,
        CONTEST_CATEGORIES,
        CONTEST_TYPES,
        POWER_CLASSES,
        MULT_MODES,
        BAND_CHANGE_RULES,
        MS_ROLES,
        SINGLE_BANDS,
        ADVICE_LEVELS,
        WALL_LAYERS,
        WALL_MODES,
        PROP_PROJECTIONS,
        PROP_LAYERS,
        LAYOUTS,
        LOG_LEVELS,
        RECORDING_REPEATS,
        DEFAULT_TTL_MIN,
        DEFAULT_BAND_COLORS,
        BAND_METERS,
        defaultsForDomain,
        defaultSettings,
        sanitize,
        validatePatch,
        validateValue,
        migrate,
        mergeDeep,
        getPath,
        setPath,
        clone
    };
});
