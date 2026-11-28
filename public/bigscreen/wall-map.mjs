import {clamp} from '../shared/geo/coordinates.mjs';
import {computeTerminator, solarCosAt} from '../shared/map/terminator.mjs';
import {trackPaths} from '../shared/geo/great-circle.mjs';
import {gridToLatLon} from '../shared/geo/maidenhead.mjs';
import {LAND_BOUNDS, mercLat, mercY, WORLD_BOUNDS} from '../shared/map/base-map.mjs';
import {createMapSurface} from '../shared/map/surface.mjs';
import {getLeaflet} from '../shared/map/leaflet.mjs';
import {opponentStyleMap, trackStyle} from '../shared/opponents/opponents.mjs';
import {opponentIcon} from '../shared/map/markers.mjs';
import {
    addTrackPaths,
    removeLayers,
    setLayerVisible
} from '../shared/map/layers.mjs';
import {
    bornAtOf, dieAtOf, isExpired, qsoTtlMs, ttlForMode
} from '../shared/map/marker-life.mjs';
import {createMarkerFade} from '../shared/map/marker-fade.mjs';
import {
    MUF_LAYER_ALPHA, MUF_LEGEND_VALUES, NIGHT_ALPHA, TWILIGHT_ELEVATION_DEG,
    mufColor, mufRgb, nightShadeAlpha, sampleMufGrid
} from '../shared/propagation/forecast-view.mjs';

import {seatColor} from './wall-cards.mjs';

const COLORS = {qso: '#35d6a4', myspot: '#4cc9f0', dxspot: '#ff6b6b'};
/* 大圆线只画最近的这些条：观众要的是"刚才是从哪里打进来的"，全量画线在
 * 一场上千条的竞赛里会把地图糊成一团，反而看不出覆盖。落点圆点仍然全画。 */
const QSO_TRACK_LIMIT = 90;
const DEFAULT_TOP_LAT = 85;
const DEFAULT_BOTTOM_LAT = -85;
let viewTopLat = DEFAULT_TOP_LAT;
let viewBottomLat = DEFAULT_BOTTOM_LAT;
/* Overlay strength; the defaults reproduce the original appearance. */
let mufOpacity = MUF_LAYER_ALPHA;
let nightScale = 1;

/* Rows follow the Leaflet Mercator projection so the MUF field lines up with
 * the Mercator-rendered land instead of stretching towards the poles. */
function rowLat(row, rows) {
    const top = mercY(viewTopLat), bottom = mercY(viewBottomLat);
    return mercLat(top + (row + 0.5) / rows * (bottom - top));
}

/* The overlay bounds mirror the configured latitude window; the default
 * window reproduces LAND_BOUNDS exactly. */
function rangeBounds() {
    if (viewTopLat === DEFAULT_TOP_LAT && viewBottomLat === DEFAULT_BOTTOM_LAT) return LAND_BOUNDS;
    return [[viewBottomLat, -180], [viewTopLat, 180]];
}

function fieldSize(map) {
    const size = map.getSize();
    return {
        width: Math.max(200, Math.min(720, Math.round(size.x / 2))),
        height: Math.max(100, Math.min(360, Math.round(size.y / 2)))
    };
}

function mufImage(mufGrid, {width, height}) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    const image = context.createImageData(width, height);
    const pixels = image.data;
    for (let y = 0; y < height; y++) {
        const lat = rowLat(y, height);
        for (let x = 0; x < width; x++) {
            const lon = -180 + (x + 0.5) * 360 / width;
            const value = sampleMufGrid(mufGrid, lat, lon);
            if (value === null || value === undefined || !isFinite(value)) continue;
            const rgb = mufRgb(value);
            const offset = (y * width + x) * 4;
            pixels[offset] = rgb[0];
            pixels[offset + 1] = rgb[1];
            pixels[offset + 2] = rgb[2];
            pixels[offset + 3] = 255;
        }
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
}

function nightImage(when, {width, height}, scale = 1) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    const image = context.createImageData(width, height);
    const pixels = image.data;
    const geometry = computeTerminator(when);
    const hasTwilight = Math.abs(Math.sin(geometry.dec * Math.PI / 180)) >=
        Math.abs(Math.sin(TWILIGHT_ELEVATION_DEG * Math.PI / 180));
    for (let y = 0; y < height; y++) {
        const lat = rowLat(y, height);
        for (let x = 0; x < width; x++) {
            const lon = -180 + (x + 0.5) * 360 / width;
            const alpha = nightShadeAlpha(solarCosAt(geometry, lat, lon), hasTwilight);
            if (alpha <= 0) continue;
            const offset = (y * width + x) * 4;
            pixels[offset + 3] = Math.min(255, Math.round(alpha * 255 * scale));
        }
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
}

export function createWallMap() {
    const L = getLeaflet();
    /* Border layer stays off for the wall: it neither loads the data file nor
     * draws the lines. The wall only needs the offline land silhouette. */
    const surface = createMapSurface('map', {
        provider: 'offline',
        view: {kind: 'range', range: [viewTopLat, viewBottomLat]},
        /* Cover the same latitude window the map may pan to (WORLD_BOUNDS), not
         * just the LAND_BOUNDS the rings are drawn in: on very tall panes the
         * view reaches the pole and a LAND_BOUNDS overlay would leave a strip of
         * bare container background above 85 deg. */
        land: {show: true, bounds: WORLD_BOUNDS, pane: 'raster', zIndex: 250},
        borders: {show: false},
        interaction: {zoom: false, pan: false},
        mapOptions: {maxZoom: 6},
        resize: {observe: true, debounce: 120},
        layers: ['aurora', 'weather', 'qso', 'myspot', 'dxspot']
    });
    const map = surface.map;
    const viewLayers = {};
    const views = {};
    ['aurora', 'weather', 'qso', 'myspot', 'dxspot'].forEach(key => {
        viewLayers[key] = surface.layer(key);
        views[key] = viewLayers[key].group;
        viewLayers[key].hide();
    });
    const visible = {};
    let mufOverlay = null;
    let nightOverlay = null;
    let lastMufGrid = null;

    /* ---------- 标记生命周期（TTL / 淡出 / 剪枝） ----------
     * 大屏以前只按 opponentWindowMin 一次性重画，设置里的「标记存活」对这张图
     * 完全没有作用。现在 QSO 走 qsoTtl、SPOT 走 settings.ttl[模式]（与 SPOT 页
     * 同一口径），淡出与剪枝的节奏复用 fadeSec / pruneSec，由 wall-page 的 1 秒
     * 心跳按拍调用 tick()/prune()。
     * 淡出的具体做法（改哪个属性、摘哪些图层）与 OP 视图完全一样，因此用
     * shared/map/marker-fade 的登记器；两个图层组各自一份账本：drawQso 只清
     * qso，drawSpots 只清 myspot/dxspot。 */
    const fadeQso = createMarkerFade();
    const fadeSpot = createMarkerFade();

    function setVisible(key, on) {
        visible[key] = Boolean(on);
        if (key === 'prop') {
            setLayerVisible(map, mufOverlay, visible[key]);
            setLayerVisible(map, nightOverlay, visible[key]);
            return;
        }
        viewLayers[key][visible[key] ? 'show' : 'hide']();
    }

    function renderProp(mufGrid) {
        if (!mufGrid || !Array.isArray(mufGrid.values)) return;
        lastMufGrid = mufGrid;
        const when = new Date();
        const size = fieldSize(map);
        const bounds = rangeBounds();
        const nextMuf = L.imageOverlay(mufImage(mufGrid, size), bounds, {
            opacity: mufOpacity,
            interactive: false,
            pane: 'raster'
        });
        const nextNight = L.imageOverlay(nightImage(when, size, nightScale), bounds, {
            opacity: 1,
            interactive: false,
            pane: 'raster'
        });
        removeLayers(map, [mufOverlay, nightOverlay]);
        mufOverlay = nextMuf;
        nightOverlay = nextNight;
        setLayerVisible(map, mufOverlay, visible.prop);
        setLayerVisible(map, nightOverlay, visible.prop);
    }

    function drawSpots(rows, myCall, {windowMin = 30, watched = [], settings = null, now = Date.now()} = {}) {
        const my = String(myCall || '').toUpperCase();
        const windowMs = Math.min(180, Math.max(5, Number(windowMin) || 30)) * 60000;
        /* Same allowlist as the opponent panel: PSKR regional rows carry the
         * receiving station in monitored_call, so only monitored calls are
         * rivals; my own rows stay in the "my spots" layer. */
        const allowed = new Set((Array.isArray(watched) ? watched : [])
            .map(call => String(call || '').trim().toUpperCase())
            .filter(Boolean));
        /* Same call -> colour + glyph assignment as the opponent panel, so a
         * rival's markers and its card always match. Calls the panel cannot
         * aggregate (no band) keep the neutral DX red dot.
         * 面板聚合口径不变（仍然只看 windowMs），变的是地图上留不留这颗点。 */
        const styles = opponentStyleMap(rows, my, {windowMs, watched});
        const painted = new Map();
        views.myspot.clearLayers();
        views.dxspot.clearLayers();
        fadeSpot.reset();
        rows.forEach(row => {
            /* 存活时长按这条 SPOT 自己的模式取 settings.ttl，缺键回退 SSB；
             * 时间戳非法就当不过期（宁可多留，别把历史数据算成过期）。 */
            const bornAt = bornAtOf(row, now);
            const dieAt = dieAtOf(bornAt, ttlForMode(settings, row.mode));
            if (isExpired(dieAt, now)) return;
            /* 回退字段是 spot_call（/api/spots 的行里只有它，没有 dx_call；
             * 写错字段名会让回退恒为假）。PSKR 区域邻台行两端都不在名单时
             * monitored_call 被有意置空，spot_call 才是真正被听到的那一端。 */
            const call = String(row.monitored_call || row.spot_call || '').toUpperCase();
            const mine = String(row.monitored_call || '').toUpperCase() === my;
            if (!mine && !allowed.has(call)) return;
            const style = mine ? null : styles.get(call);
            const color = mine ? COLORS.myspot : (style ? style.color : COLORS.dxspot);
            const group = mine ? views.myspot : views.dxspot;
            const hasDe = row.lat !== null && row.lat !== undefined &&
                row.lon !== null && row.lon !== undefined;
            const hasDx = row.dx_lat !== null && row.dx_lat !== undefined &&
                row.dx_lon !== null && row.dx_lon !== undefined;
            const entry = fadeSpot.add({group, bornAt, dieAt});
            if (hasDx) {
                /* One marker per rival position: repeat spots from the same
                 * op keep a single glyph instead of stacking dozens of icons. */
                const key = call + '|' + row.dx_lat + '|' + row.dx_lon;
                const keeper = painted.get(key);
                if (keeper) {
                    /* 同一个位置被反复点到：glyph 只由第一条画，这里把那条的寿命
                     * 延长到最后一次被听到，否则先画的到期时会把还在响的位置一起带走。 */
                    if (entry.dieAt > keeper.dieAt) {
                        keeper.dieAt = entry.dieAt;
                        keeper.bornAt = entry.bornAt;
                    }
                } else {
                    if (style) {
                        const icon = L.marker([row.dx_lat, row.dx_lon], {
                            icon: opponentIcon(L, style, 16),
                            interactive: false,
                            keyboard: false
                        }).addTo(group);
                        entry.addIcon(icon);
                    } else {
                        const dot = L.circleMarker([row.dx_lat, row.dx_lon], {
                            radius: 3, color, weight: 1, fillColor: color, fillOpacity: 0.85,
                            interactive: false
                        }).addTo(group);
                        entry.addDot(dot, 1, 0.85);
                    }
                    painted.set(key, entry);
                }
            }
            if (hasDe) {
                /* Spotter points keep their existing neutral colour; only the
                 * rival's own marker and path carry the identity colour. */
                const spotter = mine ? COLORS.myspot : COLORS.dxspot;
                const dot = L.circleMarker([row.lat, row.lon], {
                    radius: 2.4, color: spotter, weight: 1, fillColor: spotter, fillOpacity: 0.55,
                    interactive: false
                }).addTo(group);
                entry.addDot(dot, 1, 0.55);
            }
            if (hasDe && hasDx) {
                const track = style ? trackStyle(style.shapeIndex) : {weight: 1.1, opacity: 0.45};
                const base = Number(track.opacity);
                entry.addTrack(addTrackPaths(map, trackPaths(row.dx_lat, row.dx_lon, row.lat, row.lon, 64), {
                    L, group, color, ...track
                }), base);
            }
            if (!entry.layers.length) fadeSpot.drop(entry);
        });
    }

    /* 地图是"覆盖证明"，不是主视图：每个落点用打出这条 QSO 的席位色，
     * 观众把地图和右侧明细表一对，就知道是哪个席位打到哪儿。 */
    function drawQso(rows, grid, model, {settings = null, now = Date.now()} = {}) {
        const group = views.qso;
        group.clearLayers();
        fadeQso.reset();
        const home = gridToLatLon(grid);
        const ttl = qsoTtlMs(settings);
        const reached = [];
        (rows || []).forEach(qso => {
            if (qso.lat === null || qso.lat === undefined ||
                qso.lon === null || qso.lon === undefined) return;
            /* qsoTtl 从这条 QSO 自己的时间算起；0 = 不限（只受数量约束）。 */
            const bornAt = bornAtOf(qso, now);
            const dieAt = dieAtOf(bornAt, ttl);
            if (isExpired(dieAt, now)) return;
            const seat = model ? model.seatOfRow(qso) : null;
            const hue = seat ? seat.color : COLORS.qso;
            const dot = L.circleMarker([qso.lat, qso.lon], {
                radius: 2.8, color: hue, weight: 1,
                fillColor: hue, fillOpacity: 0.85, interactive: false
            }).addTo(group);
            const entry = fadeQso.add({group, bornAt, dieAt});
            entry.addDot(dot, 1, 0.85);
            reached.push([qso, Number.isFinite(bornAt) ? bornAt : 0, hue, entry]);
        });
        if (!home) return;
        reached.sort((a, b) => b[1] - a[1]);
        reached.slice(0, QSO_TRACK_LIMIT).forEach(([qso, , hue, entry]) => {
            entry.addTrack(addTrackPaths(map, trackPaths(home[0], home[1], qso.lat, qso.lon, 64), {
                L, group, color: hue, weight: 1, opacity: 0.4
            }), 0.4);
        });
        L.circleMarker(home, {
            radius: 6, color: '#ffffff', weight: 2,
            fillColor: COLORS.qso, fillOpacity: 1, interactive: false
        }).addTo(group);
    }

    function drawAurora(data) {
        const group = views.aurora;
        group.clearLayers();
        const points = data && data.aurora && data.aurora.grid || [];
        points.forEach(point => {
            const probability = point[2];
            L.circleMarker([point[1], point[0]], {
                radius: 2 + probability / 22,
                color: 'hsla(' + (140 + probability * 1.5) + ',85%,62%,0.9)',
                weight: 0,
                fillColor: 'hsla(' + (140 + probability * 1.5) + ',85%,62%,0.55)',
                fillOpacity: 0.55,
                interactive: false
            }).addTo(group);
        });
    }

    function drawWeather(data) {
        const group = views.weather;
        group.clearLayers();
        const points = data && data.wx && data.wx.pts || [];
        points.forEach(point => {
            const temperature = point[2];
            if (temperature === null || !isFinite(temperature)) return;
            const hue = clamp(210 - temperature * 6, 0, 210);
            L.circleMarker([point[0], point[1]], {
                radius: 5,
                color: 'transparent',
                weight: 0,
                fillColor: 'hsl(' + hue + ',80%,60%)',
                fillOpacity: 0.7,
                interactive: false
            }).addTo(group);
        });
    }

    function fit() {
        return surface.fit();
    }

    function setRange(topLat, bottomLat) {
        let top = Number(topLat);
        let bottom = Number(bottomLat);
        if (!Number.isFinite(top)) top = DEFAULT_TOP_LAT;
        if (!Number.isFinite(bottom)) bottom = DEFAULT_BOTTOM_LAT;
        top = Math.min(DEFAULT_TOP_LAT, Math.max(0, top));
        bottom = Math.min(0, Math.max(DEFAULT_BOTTOM_LAT, bottom));
        if (top === viewTopLat && bottom === viewBottomLat) return;
        viewTopLat = top;
        viewBottomLat = bottom;
        surface.setView({kind: 'range', range: [viewTopLat, viewBottomLat]});
        if (lastMufGrid) renderProp(lastMufGrid);
    }

    function setOverlays(muf, night) {
        const nextMuf = Number.isFinite(Number(muf)) && muf !== ''
            ? clamp(Number(muf), 0, 255) / 255 : MUF_LAYER_ALPHA;
        const nextNight = Number.isFinite(Number(night)) && night !== ''
            ? clamp(Number(night), 0, 1) / NIGHT_ALPHA : 1;
        if (Math.abs(nextMuf - mufOpacity) < 1e-4 && Math.abs(nextNight - nightScale) < 1e-4) return;
        mufOpacity = nextMuf;
        nightScale = nextNight;
        if (lastMufGrid) renderProp(lastMufGrid);
    }

    return {
        setVisible,
        setRange,
        setOverlays,
        renderProp,
        drawSpots,
        drawQso,
        /* 淡出与剪枝：由 wall-page 的 1 秒心跳按 fadeSec / pruneSec 的节奏调用，
         * 只改透明度、只摘到期的图层，不重建整张地图。 */
        tick(now = Date.now()) {
            fadeQso.tick(now);
            fadeSpot.tick(now);
        },
        prune(now = Date.now()) {
            fadeQso.prune(now);
            fadeSpot.prune(now);
        },
        drawAurora,
        drawWeather,
        fit,
        invalidate() {
            map.invalidateSize();
        },
        mufLegendGradient() {
            return MUF_LEGEND_VALUES.map((value, index) => mufColor(value) + ' ' +
                Math.round(index * 100 / (MUF_LEGEND_VALUES.length - 1)) + '%').join(',');
        }
    };
}
