import {getPropSnapshot, selectForecast} from '../../shared/data/propagation.mjs';
import {createPoller} from '../../shared/monitoring/poller.mjs';
import {gridToLatLon} from '../../shared/geo/maidenhead.mjs';
import {bearing, clamp, distanceKm, toDegrees, toRadians} from '../../shared/geo/coordinates.mjs';
import {greatCirclePoints} from '../../shared/geo/great-circle.mjs';
import {makeProjection, propLonRel, propRingCopies} from '../../shared/map/projection.mjs';
import {propTerminator} from '../../shared/map/terminator.mjs';
import {
    bestMatrixRow, getForecastMapData, mufColor, mufRgb, sampleMufGrid,
    MUF_LAYER_ALPHA, MUF_LEGEND_VALUES, NIGHT_ALPHA, NIGHT_ALPHA_NO_TWILIGHT,
    TWILIGHT_ALPHA, TWILIGHT_ELEVATION_DEG,
    selectBandConditions, selectContinents, selectPathMatrix
} from '../../shared/propagation/forecast-view.mjs';
import {$, escapeHtml} from '../ui.mjs';

const PROJECTIONS = ['mercator', 'azimuthal', 'robinson'];
const LAYERS = ['muf', 'weather', 'aurora'];
const SOURCES = [
    {name: 'NOAA SWPC', url: 'https://www.swpc.noaa.gov/', lic: 'pd'},
    {name: 'HamQSL', url: 'https://www.hamqsl.com/solar.html', lic: 'courtesy'},
    {name: 'prop.kc2g.com', url: 'https://prop.kc2g.com/', lic: 'MIT'},
    {name: 'GIRO / DIDBase', url: 'https://lgdc.uml.edu/', lic: 'ccbyncsa'},
    {name: 'LGDC GAMBIT', url: 'https://lgdc.uml.edu/rix/', lic: 'ccbyncsa'},
    {name: 'Open-Meteo', url: 'https://open-meteo.com/', lic: 'ccby'},
    {name: 'NASA SDO', url: 'https://sdo.gsfc.nasa.gov/', lic: 'pd'}
];
const MAP_COLORS = {
    bg: '#050b11', land: '#1b2932', line: '#7fb0c4', border: '#23404e',
    accent: '#00e5ff', orange: '#ff9f43', yellow: '#ffd166'
};
const CARDS = [
    {key: 'sfi', label: 'SFI', i18n: 'pcSfi', unit: ''},
    {key: 'ssn', label: 'SSN', i18n: 'pcSsn', unit: ''},
    {key: 'kp', label: 'Kp', i18n: 'pcKp', unit: ''},
    {key: 'a', label: 'A', i18n: 'pcA', unit: ''},
    {key: 'bz', label: 'Bz', i18n: 'pcBz', unit: 'nT'},
    {key: 'bt', label: 'Bt', i18n: 'pcBt', unit: 'nT'},
    {key: 'wind', label: 'Wind', i18n: 'pcWind', unit: 'km/s'},
    {key: 'dens', label: 'Dens', i18n: 'pcDens', unit: 'p/cm³'},
    {key: 'xray', label: 'X-ray', i18n: 'pcXray', unit: ''},
    {key: 'dst', label: 'Dst', i18n: 'pcDst', unit: 'nT'},
    {key: 'aur', label: 'Aurora', i18n: 'pcAur', unit: '%'},
    {key: 'drap', label: 'DRAP', i18n: 'pcDrap', unit: 'MHz'}
];

export function createPropagationPage(ctx) {
    const state = {
        data: null, err: null, proj: 'robinson', layer: 'muf',
        dx: {lat: 40, lon: -100}, de: null, canvas: null, wrap: null, ctx: null,
        w: 0, h: 0, view: false, timer: null, observer: null
    };
    const number = (value, digits) => value === null || value === undefined || !Number.isFinite(Number(value))
        ? '—' : digits === undefined ? String(value) : Number(value).toFixed(digits);
    const forecast = () => selectForecast(state.data);
    const readouts = () => forecast() && forecast().readouts || {};

    function shortTime(value) {
        if (!value) return '—';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value).slice(11, 16) : `${date.toISOString().slice(11, 16)}Z`;
    }

    function syncHome() {
        const point = gridToLatLon(ctx.settings.grid);
        state.de = point ? {lat: point[0], lon: point[1]} : null;
        if (state.view) {
            draw();
            renderPanel();
        }
    }

    function applySettings() {
        state.proj = PROJECTIONS.includes(ctx.settings.propProj) ? ctx.settings.propProj : 'robinson';
        state.layer = LAYERS.includes(ctx.settings.propLayer) ? ctx.settings.propLayer : 'muf';
        state.dx = {
            lat: Number.isFinite(ctx.settings.propDxLat) ? ctx.settings.propDxLat : state.dx.lat,
            lon: Number.isFinite(ctx.settings.propDxLon) ? ctx.settings.propDxLon : state.dx.lon
        };
        $('#propProj').value = state.proj;
        $('#propLayer').value = state.layer;
        if (state.view) {
            draw();
            renderPanel();
        }
    }

    function paintField(context, projection, canvasKey, colorAt) {
        const width = state.w, height = state.h;
        if (!width || !height) return;
        const step = Math.max(2, Math.ceil(Math.sqrt(width * height / 80000)));
        const w = Math.max(2, Math.round(width / step)), h = Math.max(2, Math.round(height / step));
        const canvas = state[canvasKey] || (state[canvasKey] = document.createElement('canvas'));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        const off = canvas.getContext('2d'), image = off.createImageData(w, h), pixels = image.data;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const point = projection.inv(x * step + step / 2, y * step + step / 2);
                if (!point) continue;
                const color = colorAt(point[0], point[1]);
                if (!color) continue;
                const offset = (y * w + x) * 4;
                pixels[offset] = color[0];
                pixels[offset + 1] = color[1];
                pixels[offset + 2] = color[2];
                pixels[offset + 3] = color[3];
            }
        }
        off.putImageData(image, 0, 0);
        context.save();
        context.imageSmoothingEnabled = true;
        context.drawImage(canvas, 0, 0, width, height);
        context.restore();
    }

    function drawMufLayer(context, projection) {
        const grid = forecast() && forecast().mufGrid;
        if (!grid) return;
        paintField(context, projection, 'mufCanvas', (lat, lon) => {
            const value = sampleMufGrid(grid, lat, lon);
            if (value === null) return null;
            const rgb = mufRgb(value);
            return [rgb[0], rgb[1], rgb[2], Math.round(MUF_LAYER_ALPHA * 255)];
        });
    }

    function weatherColor(temperature) {
        const x = clamp((temperature + 30) / 70, 0, 1);
        const stops = [[40, 70, 160], [70, 150, 210], [90, 200, 150],
            [240, 210, 90], [235, 120, 50], [200, 40, 40]];
        const index = clamp(Math.floor(x * (stops.length - 1)), 0, stops.length - 2);
        const fraction = x * (stops.length - 1) - index;
        const a = stops[index], b = stops[index + 1];
        return [0, 1, 2].map(channel => Math.round(a[channel] + (b[channel] - a[channel]) * fraction));
    }

    function drawWeatherLayer(context, projection) {
        const weather = state.data && state.data.wx;
        if (!weather || !weather.pts) return;
        const size = Math.max(20, Math.min(44, state.w / 22));
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.font = '600 11px "Segoe UI", sans-serif';
        for (const point of weather.pts) {
            const screen = projection.fwd(point[1], point[0]);
            if (!screen) continue;
            const color = weatherColor(point[2]), radius = size * 1.4;
            const gradient = context.createRadialGradient(screen[0], screen[1], 0, screen[0], screen[1], radius);
            gradient.addColorStop(0, `rgba(${color.join(',')},.30)`);
            gradient.addColorStop(1, `rgba(${color.join(',')},0)`);
            context.fillStyle = gradient;
            context.beginPath();
            context.arc(screen[0], screen[1], radius, 0, Math.PI * 2);
            context.fill();
        }
        for (const point of weather.pts) {
            const screen = projection.fwd(point[1], point[0]);
            if (!screen) continue;
            const color = weatherColor(point[2]), label = `${Math.round(point[2])}°`;
            const width = context.measureText(label).width + 10, height = 16;
            context.fillStyle = 'rgba(5,11,17,.78)';
            context.strokeStyle = `rgba(${color.join(',')},.55)`;
            context.lineWidth = 1;
            context.beginPath();
            if (context.roundRect) context.roundRect(screen[0] - width / 2, screen[1] - height / 2, width, height, 4);
            else context.rect(screen[0] - width / 2, screen[1] - height / 2, width, height);
            context.fill();
            context.stroke();
            context.fillStyle = `rgb(${color.join(',')})`;
            context.fillText(label, screen[0], screen[1] + 0.5);
        }
        context.textAlign = 'start';
    }

    function auroraField(grid) {
        const step = 4, nLat = 180 / step + 1, nLon = 360 / step;
        const values = new Float32Array(nLat * nLon);
        for (const point of grid) {
            const i = Math.round((point[1] + 90) / step);
            let j = Math.round((point[0] + 180) / step) % nLon;
            if (j < 0) j += nLon;
            if (i >= 0 && i < nLat) values[i * nLon + j] = point[2];
        }
        return {values, nLat, nLon, step};
    }

    function sampleAurora(field, lat, lon) {
        const y = clamp((lat + 90) / field.step, 0, field.nLat - 1 - 1e-6);
        const i = Math.floor(y), ty = y - i;
        const x = (((lon + 180) / field.step) % field.nLon + field.nLon) % field.nLon;
        const j = Math.floor(x), tx = x - j, j2 = (j + 1) % field.nLon;
        const row0 = i * field.nLon, row1 = Math.min(i + 1, field.nLat - 1) * field.nLon;
        const a = field.values[row0 + j] * (1 - tx) + field.values[row0 + j2] * tx;
        const b = field.values[row1 + j] * (1 - tx) + field.values[row1 + j2] * tx;
        return a * (1 - ty) + b * ty;
    }

    function auroraColor(probability) {
        const stops = [[8, [24, 120, 70]], [25, [46, 204, 113]], [50, [241, 196, 15]],
            [75, [230, 110, 50]], [100, [255, 77, 109]]];
        const value = clamp(probability, 8, 100);
        let index = 0;
        while (index < stops.length - 2 && stops[index + 1][0] < value) index++;
        const a = stops[index], b = stops[index + 1], fraction = (value - a[0]) / (b[0] - a[0]);
        return [0, 1, 2].map(channel => Math.round(a[1][channel] + (b[1][channel] - a[1][channel]) * fraction));
    }

    function drawAuroraLayer(context, projection) {
        const aurora = state.data && state.data.aurora;
        if (!aurora || !aurora.grid || !aurora.grid.length) return;
        const field = auroraField(aurora.grid);
        paintField(context, projection, 'auroraCanvas', (lat, lon) => {
            const probability = sampleAurora(field, lat, lon);
            if (probability < 6) return null;
            const rgb = auroraColor(probability);
            return [rgb[0], rgb[1], rgb[2], Math.round(clamp((probability - 6) / 60, 0, 1) * 150)];
        });
    }

    function discBoundary(projection, width, height, terminator, sinH) {
        const lat0 = toRadians(projection.lat0 || 0), lon0 = toRadians(projection.lon0 || 0);
        const dec = toRadians(terminator.dec), sun = toRadians(terminator.lonSun);
        const a = Math.sin(dec) * Math.sin(lat0) + Math.cos(dec) * Math.cos(lat0) * Math.cos(sun - lon0);
        if (sinH && Math.abs(a) < Math.abs(sinH)) return null;
        const north = Math.sin(dec) * Math.cos(lat0) - Math.sin(lat0) * Math.cos(dec) * Math.cos(sun - lon0);
        const east = Math.cos(dec) * Math.sin(sun - lon0);
        const cx = width / 2, cy = height / 2, scale = Math.min(width, height) / 2 / Math.PI, points = [];
        for (let degrees = 0; degrees < 360; degrees += 2) {
            const theta = toRadians(degrees), b = north * Math.cos(theta) + east * Math.sin(theta);
            let distance;
            if (!sinH) {
                distance = Math.atan2(-a, b);
                distance = ((distance % Math.PI) + Math.PI) % Math.PI;
            } else {
                distance = Math.atan2(b, a) + (a >= 0 ? 1 : -1) * Math.acos(clamp(sinH / Math.hypot(a, b), -1, 1));
                distance = ((distance % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
                distance = clamp(distance, 0, Math.PI);
            }
            points.push([cx + scale * distance * Math.sin(theta), cy - scale * distance * Math.cos(theta)]);
        }
        return {points, day: a > sinH};
    }

    function discShade(context, width, height, boundary, alpha) {
        context.fillStyle = `rgba(0,0,0,${alpha})`;
        context.beginPath();
        if (boundary.day) context.rect(0, 0, width, height);
        context.moveTo(width / 2, height / 2);
        for (const point of boundary.points) context.lineTo(point[0], point[1]);
        context.closePath();
        context.fill(boundary.day ? 'evenodd' : 'nonzero');
    }

    function discStroke(context, boundary, alpha, width) {
        context.strokeStyle = '#aaa';
        context.globalAlpha = alpha;
        context.lineWidth = width;
        context.beginPath();
        context.moveTo(boundary.points[0][0], boundary.points[0][1]);
        for (let i = 1; i < boundary.points.length; i++) context.lineTo(boundary.points[i][0], boundary.points[i][1]);
        context.closePath();
        context.stroke();
        context.globalAlpha = 1;
    }

    function terminatorLatitude(elevation, hourAngle, dec) {
        const sinH = Math.sin(toRadians(elevation)), a = Math.sin(dec), b = Math.cos(dec) * Math.cos(hourAngle);
        const radius = Math.hypot(a, b);
        if (radius < Math.abs(sinH)) return null;
        const phi = Math.atan2(b, a), alpha = Math.asin(clamp(sinH / radius, -1, 1));
        const base = Math.atan(-Math.cos(hourAngle) / (Math.tan(dec) || 1e-12));
        const fold = value => Math.atan2(Math.sin(value), Math.cos(value));
        const first = fold(alpha - phi), second = fold(Math.PI - alpha - phi);
        return toDegrees(Math.abs(fold(first - base)) <= Math.abs(fold(second - base)) ? first : second);
    }

    function drawGrayline(context, projection, width, height, now) {
        const lonC = projection.lon0 || 0;
        const terminator = propTerminator(now, projection.kind === 'azimuthal' ? 0 : lonC);
        const sinTwilight = Math.sin(toRadians(TWILIGHT_ELEVATION_DEG));
        context.globalAlpha = 1;
        if (projection.kind === 'azimuthal') {
            const base = discBoundary(projection, width, height, terminator, 0);
            const twilight = discBoundary(projection, width, height, terminator, sinTwilight);
            discShade(context, width, height, base, twilight ? 0.18 : 0.42);
            if (twilight) {
                discShade(context, width, height, twilight, 0.26);
                discStroke(context, twilight, 0.3, 1);
            }
            discStroke(context, base, 0.85, 1.5);
            return;
        }
        if (terminator.equinox) {
            const east = propLonRel(terminator.lonSun + 90, lonC), west = propLonRel(terminator.lonSun - 90, lonC);
            context.fillStyle = 'rgba(0,0,0,0.42)';
            context.beginPath();
            context.rect(0, 0, width, height);
            for (let lat = -90; lat <= 90; lat += 2) {
                const point = projection.fwdRaw(east, lat);
                if (lat === -90) context.moveTo(point[0], point[1]);
                else context.lineTo(point[0], point[1]);
            }
            for (let lat = 90; lat >= -90; lat -= 2) {
                const point = projection.fwdRaw(west, lat);
                context.lineTo(point[0], point[1]);
            }
            context.closePath();
            context.fill('evenodd');
            context.strokeStyle = '#aaa';
            context.globalAlpha = 0.85;
            context.lineWidth = 1.5;
            for (const offset of [east, west]) {
                context.beginPath();
                for (let lat = -90; lat <= 90; lat += 2) {
                    const point = projection.fwdRaw(offset, lat);
                    if (lat === -90) context.moveTo(point[0], point[1]);
                    else context.lineTo(point[0], point[1]);
                }
                context.stroke();
            }
            context.globalAlpha = 1;
            return;
        }
        const fillNight = (curve, alpha) => {
            const night = curve.slice();
            const edgeTo = (from, to, offset) => {
                const steps = Math.max(1, Math.ceil(Math.abs(to - from) / 2));
                for (let i = 1; i <= steps; i++) night.push([from + (to - from) * i / steps, offset]);
            };
            const end = curve[curve.length - 1][0], start = curve[0][0];
            edgeTo(end, terminator.nightPole, 180);
            night.push([terminator.nightPole, -180]);
            edgeTo(terminator.nightPole, start, -180);
            context.fillStyle = `rgba(0,0,0,${alpha})`;
            context.beginPath();
            let started = false;
            for (const point of night) {
                const screen = projection.fwdRaw(point[1], point[0]);
                if (!started) {
                    context.moveTo(screen[0], screen[1]);
                    started = true;
                } else context.lineTo(screen[0], screen[1]);
            }
            context.closePath();
            context.fill();
        };
        const strokeCurve = (curve, alpha, widthValue) => {
            context.strokeStyle = '#aaa';
            context.globalAlpha = alpha;
            context.lineWidth = widthValue;
            context.beginPath();
            let started = false;
            for (const point of curve) {
                const screen = projection.fwdRaw(point[1], point[0]);
                if (!started) {
                    context.moveTo(screen[0], screen[1]);
                    started = true;
                } else context.lineTo(screen[0], screen[1]);
            }
            context.stroke();
            context.globalAlpha = 1;
        };
        const dec = toRadians(terminator.dec);
        let twilight = null;
        if (Math.abs(Math.sin(dec)) >= Math.abs(sinTwilight)) {
            twilight = [];
            for (let offset = -180; offset <= 180; offset += 2) {
                const lat = terminatorLatitude(TWILIGHT_ELEVATION_DEG, toRadians(offset + lonC - terminator.lonSun), dec);
                if (lat === null) {
                    twilight = null;
                    break;
                }
                twilight.push([clamp(lat, -89.99, 89.99), offset]);
            }
        }
        fillNight(terminator.base, twilight ? NIGHT_ALPHA : NIGHT_ALPHA_NO_TWILIGHT);
        if (twilight) {
            fillNight(twilight, TWILIGHT_ALPHA);
            strokeCurve(twilight, 0.3, 1);
        }
        strokeCurve(terminator.base, 0.85, 1.5);
    }

    function pathSegments(lat1, lon1, lat2, lon2, samples, lonC) {
        const points = greatCirclePoints(lat1, lon1, lat2, lon2, samples), center = lonC || 0;
        const worldOf = lon => Math.floor((lon - center + 180) / 360), segments = [];
        let copy = worldOf(points[0][1]);
        let segment = [[points[0][0], points[0][1] - 360 * copy]];
        for (let i = 1; i < points.length; i++) {
            const next = worldOf(points[i][1]);
            if (next === copy) {
                segment.push([points[i][0], points[i][1] - 360 * copy]);
                continue;
            }
            const [latA, lonA] = points[i - 1], [latB, lonB] = points[i];
            const boundary = next > copy ? center + 180 + 360 * copy : center - 180 + 360 * copy;
            const crossLat = latA + (latB - latA) * ((boundary - lonA) / (lonB - lonA));
            segment.push([crossLat, boundary - 360 * copy]);
            segments.push(segment);
            segment = [[crossLat, boundary - 360 * next], [points[i][0], points[i][1] - 360 * next]];
            copy = next;
        }
        segments.push(segment);
        return segments;
    }

    function drawPath(context, projection) {
        if (state.de && state.dx) {
            const segments = pathSegments(state.de.lat, state.de.lon, state.dx.lat, state.dx.lon, 64, projection.lon0 || 0);
            context.save();
            context.strokeStyle = MAP_COLORS.yellow;
            context.lineWidth = 1.8;
            context.globalAlpha = 0.92;
            context.shadowColor = 'rgba(255,209,102,.6)';
            context.shadowBlur = 5;
            context.beginPath();
            for (const segment of segments) {
                let started = false;
                for (const point of segment) {
                    const screen = projection.fwd(point[1], point[0]);
                    if (!screen) {
                        started = false;
                        continue;
                    }
                    if (!started) {
                        context.moveTo(screen[0], screen[1]);
                        started = true;
                    } else context.lineTo(screen[0], screen[1]);
                }
            }
            context.stroke();
            context.restore();
            const longest = segments.reduce((a, b) => b.length > a.length ? b : a, segments[0]);
            if (longest && longest.length > 2) {
                const index = longest.length >> 1;
                const a = projection.fwd(longest[index - 1][1], longest[index - 1][0]);
                const b = projection.fwd(longest[index + 1][1], longest[index + 1][0]);
                if (a && b) {
                    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
                    const x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2;
                    context.fillStyle = MAP_COLORS.yellow;
                    context.beginPath();
                    context.moveTo(x + 7 * Math.cos(angle), y + 7 * Math.sin(angle));
                    context.lineTo(x + 5 * Math.cos(angle + 2.5), y + 5 * Math.sin(angle + 2.5));
                    context.lineTo(x + 5 * Math.cos(angle - 2.5), y + 5 * Math.sin(angle - 2.5));
                    context.closePath();
                    context.fill();
                }
            }
        }
        const dot = (lat, lon, fill, label) => {
            const point = projection.fwd(lon, lat);
            if (!point) return;
            context.fillStyle = fill;
            context.beginPath();
            context.arc(point[0], point[1], 5, 0, Math.PI * 2);
            context.fill();
            context.strokeStyle = 'rgba(255,255,255,.45)';
            context.lineWidth = 1;
            context.beginPath();
            context.arc(point[0], point[1], 6.5, 0, Math.PI * 2);
            context.stroke();
            context.fillStyle = fill;
            context.font = '600 11px "Segoe UI", sans-serif';
            context.fillText(label, point[0] + 9, point[1] + 4);
        };
        if (state.de) dot(state.de.lat, state.de.lon, MAP_COLORS.accent, 'DE');
        if (state.dx) dot(state.dx.lat, state.dx.lon, MAP_COLORS.orange, 'DX');
    }

    function drawLegend(context, width, height) {
        if (!state.data) return;
        let stops = null, low = '', high = '';
        if (state.layer === 'muf') {
            if (!forecast() || !forecast().mufGrid) return;
            stops = MUF_LEGEND_VALUES.map(mufColor);
            low = '3';
            high = '30 MHz';
        } else if (state.layer === 'weather') {
            if (!state.data.wx || !state.data.wx.pts || !state.data.wx.pts.length) return;
            stops = [-30, -16, -2, 12, 26, 40].map(value => `rgb(${weatherColor(value).join(',')})`);
            low = '-30°';
            high = '+40°C';
        } else {
            if (!state.data.aurora || !state.data.aurora.grid) return;
            stops = ['rgb(46,204,113)', 'rgb(241,196,15)', 'rgb(255,77,109)'];
            low = '0';
            high = '100%';
        }
        const barWidth = 120, barHeight = 7, x = 12, y = height - 22;
        context.save();
        context.fillStyle = 'rgba(5,11,17,.72)';
        context.strokeStyle = 'rgba(127,176,196,.35)';
        context.lineWidth = 1;
        context.beginPath();
        if (context.roundRect) context.roundRect(x - 7, y - 12, barWidth + 14, barHeight + 22, 4);
        else context.rect(x - 7, y - 12, barWidth + 14, barHeight + 22);
        context.fill();
        context.stroke();
        const gradient = context.createLinearGradient(x, 0, x + barWidth, 0);
        stops.forEach((color, index) => gradient.addColorStop(index / (stops.length - 1), color));
        context.fillStyle = gradient;
        context.fillRect(x, y, barWidth, barHeight);
        context.strokeStyle = 'rgba(255,255,255,.25)';
        context.strokeRect(x + 0.5, y + 0.5, barWidth - 1, barHeight - 1);
        context.fillStyle = '#c8d6de';
        context.font = '9px "Segoe UI", sans-serif';
        context.textBaseline = 'bottom';
        context.textAlign = 'left';
        context.fillText(low, x, y - 2);
        context.textAlign = 'right';
        context.fillText(high, x + barWidth, y - 2);
        context.restore();
    }

    function draw() {
        if (!state.ctx || !state.w || !state.h) return;
        const context = state.ctx, width = state.w, height = state.h;
        const projection = makeProjection(state.proj, width, height, state.de), lonC = projection.lon0 || 0;
        const disc = state.proj === 'azimuthal', radius = Math.min(width, height) / 2;
        context.clearRect(0, 0, width, height);
        context.fillStyle = MAP_COLORS.bg;
        context.save();
        if (disc) {
            context.beginPath();
            context.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
            context.fill();
            context.clip();
        } else {
            context.beginPath();
            for (let lat = -90; lat <= 90; lat += 2) {
                const point = projection.fwdRaw(180, lat);
                if (lat === -90) context.moveTo(point[0], point[1]);
                else context.lineTo(point[0], point[1]);
            }
            for (let lat = 90; lat >= -90; lat -= 2) {
                const point = projection.fwdRaw(-180, lat);
                context.lineTo(point[0], point[1]);
            }
            context.closePath();
            context.fill();
            context.clip();
        }
        const {land, borders} = getForecastMapData();
        const trace = ring => {
            context.beginPath();
            let started = false;
            const flat = typeof ring[0] === 'number', count = flat ? ring.length / 2 : ring.length;
            for (let i = 0; i < count; i++) {
                const lon = flat ? ring[i * 2] : ring[i][0], lat = flat ? ring[i * 2 + 1] : ring[i][1];
                const point = projection.fwd(lon, lat);
                if (!point) {
                    started = false;
                    continue;
                }
                if (!started) {
                    context.moveTo(point[0], point[1]);
                    started = true;
                } else context.lineTo(point[0], point[1]);
            }
        };
        const paintRing = (ring, mode) => {
            if (disc) {
                trace(ring);
                if (mode === 'fill') context.fill();
                else context.stroke();
                return;
            }
            for (const copy of propRingCopies(ring, lonC, projection)) {
                const points = copy.pts;
                const end = points.length - (mode === 'stroke' && copy.pole ? copy.tail * 2 : 0);
                if (end < 4) continue;
                context.beginPath();
                context.moveTo(points[0], points[1]);
                for (let i = 2; i < end; i += 2) context.lineTo(points[i], points[i + 1]);
                if (mode === 'fill') {
                    if (copy.pole) {
                        const a = projection.fwdRaw(copy.dLast, copy.pole), b = projection.fwdRaw(copy.dFirst, copy.pole);
                        context.lineTo(a[0], a[1]);
                        context.lineTo(b[0], b[1]);
                    }
                    context.closePath();
                    context.fill();
                } else context.stroke();
            }
        };
        context.fillStyle = MAP_COLORS.land;
        for (const ring of land) paintRing(ring, 'fill');
        if (state.layer === 'muf') drawMufLayer(context, projection);
        else if (state.layer === 'weather') drawWeatherLayer(context, projection);
        else drawAuroraLayer(context, projection);
        context.strokeStyle = MAP_COLORS.border;
        for (let lon = -180; lon < 180; lon += 30) {
            context.globalAlpha = 0.55;
            context.lineWidth = 1;
            context.beginPath();
            let started = false;
            for (let lat = -90; lat <= 90; lat += 3) {
                const point = projection.fwd(lon, lat);
                if (!point) {
                    started = false;
                    continue;
                }
                if (!started) {
                    context.moveTo(point[0], point[1]);
                    started = true;
                } else context.lineTo(point[0], point[1]);
            }
            context.stroke();
        }
        for (let lat = -60; lat <= 60; lat += 30) {
            context.globalAlpha = lat === 0 ? 0.8 : 0.55;
            context.lineWidth = lat === 0 ? 1.3 : 1;
            context.beginPath();
            let started = false;
            for (let lon = -180; lon <= 180; lon += 3) {
                const point = disc ? projection.fwd(lon + lonC, lat) : projection.fwdRaw(lon, lat);
                if (!point) {
                    started = false;
                    continue;
                }
                if (!started) {
                    context.moveTo(point[0], point[1]);
                    started = true;
                } else context.lineTo(point[0], point[1]);
            }
            context.stroke();
        }
        context.globalAlpha = 1;
        context.lineWidth = 1;
        if (!disc) {
            context.strokeStyle = MAP_COLORS.line;
            context.globalAlpha = 0.4;
            context.lineWidth = 0.7;
            for (const segment of borders) paintRing(segment, 'stroke');
        }
        context.strokeStyle = MAP_COLORS.line;
        context.globalAlpha = 1;
        context.lineWidth = 1;
        for (const ring of land) paintRing(ring, 'stroke');
        drawGrayline(context, projection, width, height, new Date());
        drawPath(context, projection);
        context.restore();
        context.strokeStyle = MAP_COLORS.border;
        context.lineWidth = 1;
        if (disc) {
            context.beginPath();
            context.arc(width / 2, height / 2, radius - 0.5, 0, Math.PI * 2);
            context.stroke();
        } else context.strokeRect(0.5, 0.5, width - 1, height - 1);
        drawLegend(context, width, height);
    }

    function sparkValues(key) {
        const data = state.data || {};
        const column = (list, index) => (list || []).map(row => row[index]).filter(value => value !== null && Number.isFinite(value));
        switch (key) {
            case 'sfi': return column(data.sfi && data.sfi.list, 1);
            case 'ssn': return column(data.ssn && data.ssn.list, 1);
            case 'kp': return column(data.kp && data.kp.list, 1);
            case 'a': return column(data.a && data.a.list, 1);
            case 'bz': return column(data.mag && data.mag.list, 2);
            case 'bt': return column(data.mag && data.mag.list, 1);
            case 'wind': return column(data.wind && data.wind.list, 1);
            case 'dens': return column(data.wind && data.wind.list, 2);
            case 'xray': return column(data.xray && data.xray.list, 1);
            case 'dst': return column(data.dst && data.dst.list, 1);
            default: return [];
        }
    }

    function drawSpark(canvas, values, color, logScale) {
        const ratio = window.devicePixelRatio || 1, width = canvas.clientWidth || 120, height = canvas.clientHeight || 26;
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        const context = canvas.getContext('2d');
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, width, height);
        if (!values.length) return;
        let samples = values.slice();
        if (logScale) samples = samples.map(value => Math.log10(Math.max(value, 1e-9)));
        let min = Math.min(...samples), max = Math.max(...samples);
        if (max === min) max = min + 1;
        const pad = 2, x = index => samples.length === 1 ? width / 2 : index / (samples.length - 1) * (width - pad * 2) + pad;
        const y = value => height - pad - (value - min) / (max - min) * (height - pad * 2);
        context.strokeStyle = color;
        context.lineWidth = 1.4;
        context.beginPath();
        samples.forEach((value, index) => index ? context.lineTo(x(index), y(value)) : context.moveTo(x(index), y(value)));
        context.stroke();
        context.globalAlpha = 0.18;
        context.fillStyle = color;
        context.beginPath();
        samples.forEach((value, index) => index ? context.lineTo(x(index), y(value)) : context.moveTo(x(index), y(value)));
        context.lineTo(x(samples.length - 1), height - pad);
        context.lineTo(x(0), height - pad);
        context.closePath();
        context.fill();
        context.globalAlpha = 1;
        context.fillStyle = color;
        context.beginPath();
        context.arc(x(samples.length - 1), y(samples[samples.length - 1]), 2.4, 0, Math.PI * 2);
        context.fill();
    }

    function scaleS() {
        const list = state.data && state.data.proton && state.data.proton.list || [];
        for (let i = list.length - 1; i >= 0; i--) {
            const flux = list[i][1];
            if (typeof flux !== 'number' || !Number.isFinite(flux)) continue;
            if (flux >= 1e5) return 5;
            if (flux >= 1e4) return 4;
            if (flux >= 1e3) return 3;
            if (flux >= 100) return 2;
            if (flux >= 10) return 1;
            return 0;
        }
        return null;
    }

    function scaleR() {
        const list = state.data && state.data.xray && state.data.xray.list || [];
        for (let i = list.length - 1; i >= 0; i--) {
            const flux = list[i][1];
            if (typeof flux !== 'number' || !Number.isFinite(flux) || flux <= 0) continue;
            if (flux >= 5e-3) return 5;
            if (flux >= 1e-3) return 4;
            if (flux >= 1e-4) return 3;
            if (flux >= 5e-5) return 2;
            if (flux >= 1e-5) return 1;
            return 0;
        }
        return null;
    }

    function scaleG() {
        const list = state.data && state.data.kp && state.data.kp.list || [];
        for (let i = list.length - 1; i >= 0; i--) {
            const kp = list[i][1];
            if (typeof kp !== 'number' || !Number.isFinite(kp)) continue;
            if (kp >= 9) return 5;
            if (kp >= 8) return 4;
            if (kp >= 7) return 3;
            if (kp >= 6) return 2;
            if (kp >= 5) return 1;
            return 0;
        }
        return null;
    }

    function xrayClass(flux) {
        if (typeof flux !== 'number' || !Number.isFinite(flux) || flux <= 0) return null;
        const decimal = Math.floor(Math.log10(flux));
        const letter = decimal <= -8 ? 'A' : decimal === -7 ? 'B' : decimal === -6 ? 'C' : decimal === -5 ? 'M' : 'X';
        const value = flux / Math.pow(10, decimal);
        return letter + (value >= 10 ? Math.round(value) : value.toFixed(1));
    }

    function cardValue(key) {
        const data = state.data || {}, ham = data.ham || {};
        const last = (list, index) => {
            const rows = list || [];
            for (let i = rows.length - 1; i >= 0; i--) if (rows[i][index] !== null && rows[i][index] !== undefined) return rows[i][index];
            return null;
        };
        switch (key) {
            case 'sfi': return last(data.sfi && data.sfi.list, 1) ?? ham.sfi ?? null;
            case 'ssn': return last(data.ssn && data.ssn.list, 1) ?? ham.ssn ?? null;
            case 'kp': return last(data.kp && data.kp.list, 1) ?? ham.kp ?? null;
            case 'a': return last(data.a && data.a.list, 1) ?? ham.aindex ?? null;
            case 'bz': return last(data.mag && data.mag.list, 2);
            case 'bt': return last(data.mag && data.mag.list, 1);
            case 'wind': return last(data.wind && data.wind.list, 1);
            case 'dens': return last(data.wind && data.wind.list, 2);
            case 'xray': return xrayClass(last(data.xray && data.xray.list, 1)) || ham.xray || '';
            case 'dst': return last(data.dst && data.dst.list, 1);
            case 'aur': {
                const grid = data.aurora && data.aurora.grid;
                if (!grid || !grid.length) return null;
                return grid.reduce((max, point) => Math.max(max, point[2]), 0);
            }
            case 'drap': return readouts().drapDe ?? null;
            default: return null;
        }
    }

    function cardClass(key, value) {
        if (typeof value !== 'number') return '';
        if (key === 'kp') return value >= 5 ? 'alert' : value >= 4 ? 'warn' : '';
        if (key === 'bz') return value <= -10 ? 'alert' : value <= -5 ? 'warn' : '';
        if (key === 'dst') return value <= -100 ? 'alert' : value <= -50 ? 'warn' : '';
        return '';
    }

    function conditionClass(condition) {
        const value = String(condition || '').toLowerCase();
        if (value.includes('good')) return 'good';
        if (value.includes('fair')) return 'fair';
        if (value.includes('poor')) return 'poor';
        return 'closed';
    }

    function conditionText(condition) {
        const key = {Good: 'condGood', Fair: 'condFair', Poor: 'condPoor', Closed: 'condClosed'}[condition];
        return key ? ctx.t(key) : condition || '—';
    }

    function renderCredits() {
        const licenses = {
            pd: ctx.t('propLicPd'), courtesy: ctx.t('propLicCourtesy'), MIT: 'MIT',
            ccbyncsa: 'CC BY-NC-SA 4.0', ccby: 'CC BY 4.0'
        };
        $('#propCredit').innerHTML = `<div class="prop-sec-title">${escapeHtml(ctx.t('propCredits'))}</div><div class="prop-credit-list">${SOURCES.map(source => `<a class="prop-credit-item" href="${source.url}" target="_blank" rel="noopener"><b>${escapeHtml(source.name)}</b><i>${escapeHtml(licenses[source.lic] || source.lic)}</i></a>`).join('')}</div><div class="prop-credit-note">${escapeHtml(ctx.t('propCreditsNote'))}</div>`;
    }

    function sizeSdo() {
        const foot = $('#propFoot'), section = foot && foot.querySelector('.sec-sdo');
        const box = section && section.querySelector('.prop-sdo');
        if (!section || !box) return;
        const reference = foot.querySelector('.sec-path') || section, last = reference.lastElementChild || reference;
        const side = Math.floor(last.getBoundingClientRect().bottom - box.getBoundingClientRect().top);
        if (side > 40) {
            box.style.width = `${side}px`;
            box.style.height = `${side}px`;
        }
    }

    function redrawSparks() {
        $('#propSide').querySelectorAll('[data-card]').forEach(element => {
            const key = element.dataset.card, values = sparkValues(key);
            if (!values.length) return;
            const color = key === 'bz' ? '#e74c3c' : key === 'kp' ? '#f1c40f' : '#00e5ff';
            drawSpark(element.querySelector('.pc-spark'), values, color, key === 'xray');
        });
    }

    function renderPanel() {
        const side = $('#propSide'), foot = $('#propFoot'), leftArm = $('#propArmL');
        renderCredits();
        const data = state.data;
        if (!data) {
            side.innerHTML = `<div class="prop-empty">${ctx.t('propNoData')}${state.err ? `<br><span class="prop-dim">${escapeHtml(state.err)}</span>` : ''}</div>`;
            foot.innerHTML = '';
            leftArm.innerHTML = '';
            return;
        }
        const html = [], left = [], low = [], ham = data.ham || {}, scales = data.scales || {};
        const scaleNames = {R: 'propScR', S: 'propScS', G: 'propScG'};
        const scaleStates = ['propScNone', 'propScMinor', 'propScModerate', 'propScStrong', 'propScSevere', 'propScExtreme'];
        const scaleBox = (key, value) => {
            const initial = value && value.scale !== null ? clamp(value.scale, 0, 5) : 0;
            const measured = key === 'R' ? scaleR() : key === 'S' ? scaleS() : scaleG();
            const level = measured !== null ? measured : initial;
            let note;
            if (level > 0) note = ctx.t(scaleStates[level]);
            else if (value && value.prob !== null && value.prob !== undefined) note = `${value.prob}%`;
            else note = ctx.t('propScNone');
            return `<div class="prop-scale s${level}" title="${ctx.t(scaleNames[key])} · ${note}"><b>${ctx.t(scaleNames[key])}</b><span>${note}</span><i>${key}${level}</i></div>`;
        };
        html.push(`<div class="prop-sec sec-wx"><div class="prop-sec-title">${ctx.t('propSpaceWx')}<span class="prop-upd">${ctx.t('propUpdated')} ${shortTime(data.ts)}</span></div>`);
        html.push(`<div class="prop-scales">${scaleBox('R', scales.r)}${scaleBox('S', scales.s)}${scaleBox('G', scales.g)}</div>`);
        const advisories = data.icao && data.icao.list || [];
        if (advisories.length) {
            html.push('<div class="prop-icao">');
            for (const advisory of advisories.slice(0, 3)) {
                const heading = ['ICAO', advisory.phenomenon, advisory.severity].filter(Boolean).join(' · ');
                html.push(`<div class="prop-note"><b>${escapeHtml(heading)}</b>${advisory.issued ? ` · ${escapeHtml(shortTime(advisory.issued))}` : ''}<br>${escapeHtml(advisory.text)}</div>`);
            }
            html.push('</div>');
        }
        html.push('<div class="prop-cards">');
        for (const card of CARDS) {
            const value = cardValue(card.key), noSpark = sparkValues(card.key).length ? '' : ' no-spark';
            html.push(`<div class="prop-card ${cardClass(card.key, value)}${noSpark}" data-card="${card.key}"><div class="pc-head"><span class="pc-label">${ctx.t(card.i18n) || card.label}</span><span class="pc-val">${typeof value === 'number' ? number(value, 1) : value || '—'}</span></div><div class="pc-unit">${card.unit}</div><canvas class="pc-spark"></canvas></div>`);
        }
        html.push('</div></div>');

        const conditions = selectBandConditions(forecast());
        if (conditions) {
            left.push(`<div class="prop-sec sec-bands"><div class="prop-sec-title">${ctx.t('propBands')}<span class="prop-upd">${ctx.t('propApprox')}</span></div><div class="prop-bandgrid">`);
            for (const [band, entry] of Object.entries(conditions.bands)) {
                left.push(`<div class="band-card"><div class="bc-name">${escapeHtml(band)}</div><div class="bc-row"><span class="bc-time">${ctx.t('propDay')}</span><b class="bc-cond ${conditionClass(entry.day)}">${conditionText(entry.day)}</b></div><div class="bc-row"><span class="bc-time">${ctx.t('propNight')}</span><b class="bc-cond ${conditionClass(entry.night)}">${conditionText(entry.night)}</b></div></div>`);
            }
            left.push('</div>');
            const now = new Date();
            const noon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + conditions.noon * 3600000).toISOString().slice(11, 16);
            left.push(`<div class="prop-note">MUF3000 ${number(conditions.day.muf, 1)} / ${number(conditions.night.muf, 1)} MHz · LUF ${number(conditions.day.luf, 1)} / ${number(conditions.night.luf, 1)} MHz · local noon ${noon}Z</div>`);
            if (ham.geomag) left.push(`<div class="prop-note">Geomag: ${escapeHtml(ham.geomag)} · Noise: ${escapeHtml(ham.noise || '—')}</div>`);
            left.push('</div>');
        } else if (!state.de) {
            const bands = ham.bands || [];
            if (bands.length) {
                const day = bands.filter(band => band.time === 'day'), night = bands.filter(band => band.time === 'night');
                left.push(`<div class="prop-sec sec-bands"><div class="prop-sec-title">${ctx.t('propBands')}</div><div class="prop-bandgrid">`);
                for (const band of day) {
                    const nightBand = night.find(item => item.name === band.name);
                    const row = (label, entry) => entry ? `<div class="bc-row"><span class="bc-time">${label}</span><b class="bc-cond ${conditionClass(entry.cond)}">${conditionText(entry.cond)}</b></div>` : '';
                    left.push(`<div class="band-card"><div class="bc-name">${escapeHtml(band.name)}</div>${row(ctx.t('propDay'), band)}${row(ctx.t('propNight'), nightBand)}</div>`);
                }
                left.push('</div>');
                if (ham.geomag) left.push(`<div class="prop-note">Geomag: ${escapeHtml(ham.geomag)} · Noise: ${escapeHtml(ham.noise || '—')}</div>`);
                left.push('</div>');
            }
        }

        const matrix = selectPathMatrix(forecast());
        if (matrix) {
            low.push(`<div class="prop-sec sec-path"><div class="prop-sec-title">${ctx.t('propPath')}<span class="prop-upd">${ctx.t('propApprox')}</span></div>`);
            low.push(`<div class="prop-path-head"><b>DE</b> ${matrix.de.lat.toFixed(1)}°, ${matrix.de.lon.toFixed(1)}° <span class="prop-arrow">→</span> <b>DX</b> ${matrix.dx.lat.toFixed(1)}°, ${matrix.dx.lon.toFixed(1)}°</div>`);
            low.push(`<div class="prop-path-meta">${Math.round(matrix.dist)} km · ${Math.round(matrix.bearing)}° · MUF ${number(matrix.baseMuf, 1)} MHz</div>`);
            low.push(`<div class="prop-matrix"><table><thead><tr><th></th>${Array.from({length: 24}, (_, hour) => `<th class="${hour === matrix.hourNow ? 'now' : ''}">${hour}</th>`).join('')}</tr></thead><tbody>`);
            for (const row of matrix.rows) {
                const best = Math.max(...row.cells);
                low.push(`<tr><th>${escapeHtml(row.name)}</th>${row.cells.map((score, hour) => {
                    const hue = Math.round(score * 1.2), lightness = (32 + score * 0.14).toFixed(1);
                    const className = `${hour === matrix.hourNow ? 'now' : ''}${score === best ? ' best' : ''}`;
                    return `<td class="${className}" style="background:hsl(${hue},66%,${lightness}%)" title="${score}%">${score >= 55 ? '•' : ''}</td>`;
                }).join('')}</tr>`);
            }
            low.push('</tbody></table></div>');
            const best = bestMatrixRow(matrix);
            if (best) low.push(`<div class="prop-note">${ctx.t('propBestBand')}: <b>${escapeHtml(best.name)}</b> (${best.cells[matrix.hourNow]}%)</div>`);
            low.push('</div>');
        } else if (!state.de) {
            low.push(`<div class="prop-sec"><div class="prop-note">${ctx.t('propSetGrid')}</div></div>`);
        }

        const sdoCaption = `${new Date().toISOString().slice(11, 16)}Z`;
        low.push(`<div class="prop-sec sec-sdo"><div class="prop-sec-title">${ctx.t('propSdo')}</div><div class="prop-sdo"><img src="https://sdo.gsfc.nasa.gov/assets/img/latest/latest_512_0193.jpg?t=${Date.now()}" alt="SDO AIA 193" onerror="this.parentElement.classList.add('sdo-fail')"><div class="prop-sdo-cap">AIA 193 Å · ${sdoCaption}</div></div></div>`);

        const continents = selectContinents(forecast());
        if (continents) {
            low.push(`<div class="prop-sec sec-cty"><div class="prop-sec-title">${ctx.t('propCtyTitle')}</div><div class="prop-cty">${continents.rows.map(row => {
                const hue = Math.round(row.score * 1.2), key = `propCty${row.key.charAt(0).toUpperCase()}${row.key.slice(1)}`;
                return `<div class="prop-scale" style="--sev:hsl(${hue},70%,52%);background:linear-gradient(90deg,hsla(${hue},70%,48%,.5) 0,hsla(${hue},70%,48%,.5) ${row.score}%,transparent ${row.score}%),var(--panel-2)"><span>${ctx.t(key)}</span><b>${escapeHtml(row.band)}</b><i>${row.score}%</i></div>`;
            }).join('')}</div></div>`);
        }

        const stations = data.muf && data.muf.stations || [];
        let maxStation = null;
        for (const station of stations) if (station[2] !== null && (!maxStation || station[2] > maxStation[2])) maxStation = station;
        const aurora = data.aurora && data.aurora.grid;
        const auroraMax = aurora ? aurora.reduce((max, point) => Math.max(max, point[2]), 0) : 0;
        const values = readouts();
        const read = (label, value) => `<div class="pr-card"><div class="pr-label">${label}</div><div class="pr-val">${value}</div></div>`;
        low.push(`<div class="prop-sec sec-read"><div class="prop-sec-title">${ctx.t('propReadouts')}</div><div class="prop-read">`);
        low.push(read(ctx.t('rdMufDe'), `${number(values.mufDe, 1)} MHz`));
        low.push(read(ctx.t('rdMufMax'), maxStation ? `${number(maxStation[2], 1)} MHz · ${escapeHtml(maxStation[4])}` : '—'));
        low.push(read(ctx.t('rdMufDx'), `${number(values.mufDx, 1)} MHz`));
        low.push(read(ctx.t('rdAurora'), auroraMax ? `${auroraMax}%` : '—'));
        low.push(read(ctx.t('rdDrapDe'), `${number(values.drapDe, 1)} MHz`));
        low.push(read(ctx.t('rdDrapDx'), `${number(values.drapDx, 1)} MHz`));
        low.push(read(ctx.t('rdToa'), values.toaDeg === null || values.toaDeg === undefined ? '—' : `${number(values.toaDeg, 0)}°`));
        const weather = data.wx && data.wx.pts && state.dx ? nearestWeather(data.wx.pts, state.dx) : null;
        low.push(read(ctx.t('propWeatherDx'), weather ? `${number(weather[2], 1)}°C · WMO ${weather[3] === null ? '—' : weather[3]}` : '—'));
        low.push('</div></div>');
        leftArm.innerHTML = left.join('');
        side.innerHTML = html.join('');
        foot.innerHTML = low.join('');
        sizeSdo();
        redrawSparks();
    }

    function nearestWeather(points, location) {
        let best = null, bestDistance = Infinity;
        for (const point of points) {
            const distance = distanceKm(location, {lat: point[0], lon: point[1]});
            if (distance < bestDistance) {
                bestDistance = distance;
                best = point;
            }
        }
        return best;
    }

    function eventToLatLon(event) {
        const bounds = state.canvas.getBoundingClientRect();
        const projection = makeProjection(state.proj, state.w, state.h, state.de);
        return projection.inv(event.clientX - bounds.left, event.clientY - bounds.top);
    }

    function bindMap() {
        const hover = $('#propHover');
        state.canvas.addEventListener('mousemove', event => {
            const point = eventToLatLon(event);
            if (!point) {
                hover.classList.add('hidden');
                return;
            }
            hover.classList.remove('hidden');
            const location = {lat: point[0], lon: point[1]};
            const parts = [`${Math.abs(point[0]).toFixed(1)}°${point[0] >= 0 ? 'N' : 'S'} ${Math.abs(point[1]).toFixed(1)}°${point[1] >= 0 ? 'E' : 'W'}`];
            if (state.de) {
                parts.push(`Az ${Math.round(bearing(state.de, location)) % 360}°`);
                parts.push(`${Math.round(distanceKm(state.de, location)).toLocaleString('en-US')} km`);
            }
            if (state.layer === 'muf' && forecast() && forecast().mufGrid) {
                const value = sampleMufGrid(forecast().mufGrid, point[0], point[1]);
                if (value !== null) parts.push(`MUF ${value.toFixed(1)}`);
            }
            hover.textContent = parts.join(' · ');
            const bounds = state.wrap.getBoundingClientRect();
            hover.style.left = `${event.clientX - bounds.left + 14}px`;
            hover.style.top = `${event.clientY - bounds.top + 14}px`;
        });
        state.canvas.addEventListener('mouseleave', () => hover.classList.add('hidden'));
        state.canvas.addEventListener('click', async event => {
            const point = eventToLatLon(event);
            if (!point) return;
            state.dx = {lat: Math.round(point[0] * 10) / 10, lon: Math.round(point[1] * 10) / 10};
            ctx.settings.propDxLat = state.dx.lat;
            ctx.settings.propDxLon = state.dx.lon;
            ctx.saveSettings();
            draw();
            await ctx.settingsPage.flush();
            await refresh();
            if (state.view) renderPanel();
        });
    }

    function resize() {
        if (!state.canvas || !state.wrap) return;
        const bounds = state.wrap.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        const ratio = window.devicePixelRatio || 1;
        state.w = bounds.width;
        state.h = bounds.height;
        state.canvas.width = Math.round(bounds.width * ratio);
        state.canvas.height = Math.round(bounds.height * ratio);
        state.ctx = state.canvas.getContext('2d');
        state.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        draw();
        redrawSparks();
        sizeSdo();
    }

    async function loadSnapshot() {
        try {
            const data = await getPropSnapshot();
            if (!data || data.error) throw new Error(data && data.error || 'no data');
            state.data = data;
            state.err = null;
            if (state.view) {
                renderPanel();
                draw();
            }
        } catch (error) {
            state.err = error.message;
            if (state.view && !state.data) renderPanel();
        }
    }

    const poller = createPoller(loadSnapshot, {intervalMs: 60000, immediate: false});

    function refresh() {
        return poller.run();
    }

    function optionHtml(values, prefix) {
        return values.map(value => `<option value="${value}">${ctx.t(`${prefix}${value.charAt(0).toUpperCase()}${value.slice(1)}`)}</option>`).join('');
    }

    function applyLang() {
        const projection = $('#propProj'), layer = $('#propLayer');
        if (projection) {
            const keep = projection.value;
            projection.innerHTML = optionHtml(PROJECTIONS, 'prop');
            projection.value = keep;
        }
        if (layer) {
            const keep = layer.value;
            layer.innerHTML = optionHtml(LAYERS, 'propLayer');
            layer.value = keep;
        }
        $('#propHint').textContent = ctx.t('propClickDx');
        renderPanel();
    }

    function init() {
        state.wrap = $('#propMapWrap');
        state.canvas = $('#propCanvas');
        const projection = $('#propProj'), layer = $('#propLayer');
        projection.innerHTML = optionHtml(PROJECTIONS, 'prop');
        projection.value = PROJECTIONS.includes(ctx.settings.propProj) ? ctx.settings.propProj : 'robinson';
        state.proj = projection.value;
        projection.addEventListener('change', () => {
            state.proj = projection.value;
            ctx.settings.propProj = state.proj;
            ctx.saveSettings();
            draw();
        });
        layer.innerHTML = optionHtml(LAYERS, 'propLayer');
        layer.value = LAYERS.includes(ctx.settings.propLayer) ? ctx.settings.propLayer : 'muf';
        state.layer = layer.value;
        layer.addEventListener('change', () => {
            state.layer = layer.value;
            ctx.settings.propLayer = state.layer;
            ctx.saveSettings();
            draw();
        });
        state.dx = {
            lat: Number.isFinite(ctx.settings.propDxLat) ? ctx.settings.propDxLat : 40,
            lon: Number.isFinite(ctx.settings.propDxLon) ? ctx.settings.propDxLon : -100
        };
        syncHome();
        bindMap();
        resize();
        if (window.ResizeObserver) {
            state.observer = new ResizeObserver(() => { if (state.view) resize(); });
            state.observer.observe(state.wrap);
        }
        state.timer = setInterval(() => { if (state.view) draw(); }, 60000);
        poller.start();
        void refresh();
    }

    function show() {
        state.view = true;
        syncHome();
        applySettings();
        resize();
        renderPanel();
        void refresh();
    }

    function hide() {
        state.view = false;
    }

    return {state, init, show, hide, resize, refresh, syncHome, applySettings, applyLang, renderPanel, draw};
}
