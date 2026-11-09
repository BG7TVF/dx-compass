/**
 * Projection-independent selectors for the server forecast DTO. This module
 * performs interpolation and colour/row selection only; all ionospheric and
 * path prediction is computed by lib/propagation on the server.
 */
import {clamp} from '../geo/coordinates.mjs';

export const MUF_STOPS = [
    [20, 60, 180], [40, 150, 220], [60, 190, 140],
    [220, 200, 60], [240, 120, 40], [220, 40, 60]
];

/* Shared overlay styling so the main panel and the read-only wall paint the
 * same forecast field with the same numbers. Values mirror the original
 * propagation canvas: MUF at 77/255, night 0.18, twilight band 0.26. */
export const MUF_LAYER_ALPHA = 77 / 255;
export const NIGHT_ALPHA = 0.18;
export const TWILIGHT_ALPHA = 0.26;
export const NIGHT_ALPHA_NO_TWILIGHT = 0.42;
export const TWILIGHT_ELEVATION_DEG = -6;
export const MUF_LEGEND_VALUES = [3, 9, 15, 21, 27, 30];

/** Composite night alpha for a sun-elevation sine, matching the canvas fill order. */
export function nightShadeAlpha(sinElevation, hasTwilight = true) {
    const sine = Number(sinElevation);
    if (!Number.isFinite(sine) || sine >= 0) return 0;
    if (!hasTwilight) return NIGHT_ALPHA_NO_TWILIGHT;
    const twilightSine = Math.sin(TWILIGHT_ELEVATION_DEG * Math.PI / 180);
    if (sine >= twilightSine) return NIGHT_ALPHA;
    return 1 - (1 - NIGHT_ALPHA) * (1 - TWILIGHT_ALPHA);
}

function gridDimensions(grid) {
    if (!grid || typeof grid !== 'object') return null;
    const values = grid.values;
    if (!Array.isArray(values) || !values.length) return null;
    const nested = Array.isArray(values[0]) || ArrayBuffer.isView(values[0]);
    const nLat = Number(grid.nLat) || (nested ? values.length : 0);
    const nLon = Number(grid.nLon) || (nested ? values[0].length : 0);
    if (!nLat || !nLon || (nested && values.length < nLat)) return null;
    return {values, nested, nLat, nLon};
}

function valueAt(grid, shape, row, column) {
    if (shape.nested) {
        const values = shape.values[row];
        return values && Number(values[column]);
    }
    return Number(shape.values[row * shape.nLon + column]);
}

/**
 * Bilinearly sample forecast.mufGrid. Latitude is clamped to the grid range;
 * longitude wraps from the last column back to the first, as specified by DTO.
 * Returns null for an absent/malformed grid or a non-numeric sampled value.
 */
export function sampleMufGrid(grid, lat, lon) {
    const shape = gridDimensions(grid);
    if (!shape || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
    const {nLat, nLon} = shape;
    const lats = Array.isArray(grid.lats) && grid.lats.length >= nLat
        ? grid.lats
        : Array.from({length: nLat}, (_, i) => Number(grid.latMin ?? -90) + i * Number(grid.latStep ?? 0));
    const firstLat = Number(lats[0]), lastLat = Number(lats[nLat - 1]);
    if (!Number.isFinite(firstLat) || !Number.isFinite(lastLat)) return null;
    const targetLat = clamp(Number(lat), Math.min(firstLat, lastLat), Math.max(firstLat, lastLat));
    let i = 0, ty = 0;
    if (nLat > 1) {
        if ((lastLat >= firstLat && targetLat >= lastLat) ||
            (lastLat < firstLat && targetLat <= lastLat)) {
            i = nLat - 2;
            ty = 1;
        } else {
            while (i < nLat - 2 && Number(lats[i + 1]) < targetLat) i++;
            const a = Number(lats[i]), b = Number(lats[i + 1]);
            ty = b === a ? 0 : clamp((targetLat - a) / (b - a), 0, 1);
        }
    }
    const i2 = Math.min(i + 1, nLat - 1);

    const lons = Array.isArray(grid.lons) && grid.lons.length >= nLon ? grid.lons : null;
    const lon0 = Number(lons ? lons[0] : (grid.lonMin ?? -180));
    const defaultStep = nLon > 1 ? 360 / nLon : 1;
    const lonStep = Number(lons && nLon > 1 ? lons[1] - lons[0] : (grid.lonStep ?? defaultStep)) || defaultStep;
    if (!Number.isFinite(lon0) || !Number.isFinite(lonStep)) return null;
    let x = nLon === 1 ? 0 : (((Number(lon) - lon0) / lonStep) % nLon + nLon) % nLon;
    const j = Math.floor(x), tx = x - j;
    const j2 = nLon === 1 ? 0 : (j + 1) % nLon;
    const v00 = valueAt(grid, shape, i, j), v01 = valueAt(grid, shape, i, j2);
    const v10 = valueAt(grid, shape, i2, j), v11 = valueAt(grid, shape, i2, j2);
    if (![v00, v01, v10, v11].every(Number.isFinite)) return null;
    return (v00 * (1 - tx) + v01 * tx) * (1 - ty) +
        (v10 * (1 - tx) + v11 * tx) * ty;
}

/** Existing 3..30 MHz propagation colour ramp as numeric RGB channels. */
export function mufRgb(muf) {
    const value = Number.isFinite(Number(muf)) ? Number(muf) : 0;
    const t = clamp((value - 3) / 27, 0, 1);
    const i = clamp(Math.floor(t * (MUF_STOPS.length - 1)), 0, MUF_STOPS.length - 2);
    const fraction = t * (MUF_STOPS.length - 1) - i;
    const a = MUF_STOPS[i], b = MUF_STOPS[i + 1];
    return [
        Math.round(a[0] + (b[0] - a[0]) * fraction),
        Math.round(a[1] + (b[1] - a[1]) * fraction),
        Math.round(a[2] + (b[2] - a[2]) * fraction)
    ];
}

/** Canvas/CSS-compatible colour (fillStyle, strokeStyle or addColorStop). */
export function mufColor(muf) {
    return `rgb(${mufRgb(muf).join(',')})`;
}

/** Read the classic offline geography scripts after index.html has bridged them. */
export function getForecastMapData(root = globalThis) {
    return {land: root.LAND || [], borders: root.BORDERS || []};
}

export function selectPathMatrix(forecast) {
    return forecast && forecast.pathMatrix && Array.isArray(forecast.pathMatrix.rows)
        ? forecast.pathMatrix
        : null;
}

export function selectBandConditions(forecast) {
    return forecast && forecast.bandConditions && forecast.bandConditions.bands
        ? forecast.bandConditions
        : null;
}

export function selectContinents(forecast) {
    return forecast && forecast.continents && Array.isArray(forecast.continents.rows)
        ? forecast.continents
        : null;
}

/** Select the highest-scoring row in the requested UTC hour without altering DTO values. */
export function bestMatrixRow(matrix, hour = matrix && matrix.hourNow) {
    if (!matrix || !Array.isArray(matrix.rows) || !matrix.rows.length) return null;
    const column = Number.isInteger(hour) ? clamp(hour, 0, 23) : 0;
    return matrix.rows.reduce((best, row) => {
        if (!best) return row;
        return Number(row.cells[column]) > Number(best.cells[column]) ? row : best;
    }, null);
}
