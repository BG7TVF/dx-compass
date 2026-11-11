/**
 * Shared map surface: one factory for every page's Leaflet view.
 *
 * Input: a container element and a configuration object. Output: the map plus
 * layer handles, view fitting, resize observation, theme refresh and lifecycle.
 * Pages declare *what* they need (offline/osm/amap/none, fixed or world view,
 * land/borders on or off, interaction flags); they never build panes, resize
 * observers or border renderers themselves.
 */
import {getLeaflet} from './leaflet.mjs';
import {
    addOfflineLand,
    createBaseMap,
    fitPoints,
    fitWorld,
    fitWorldRange,
    LAND_BOUNDS,
    WORLD_BOUNDS
} from './base-map.mjs';
import {addOfflineBorders, BORDER_STYLE, clearOfflineBorders} from './borders.mjs';
import {createLayerGroup, createRasterPane, setLayerVisible} from './layers.mjs';

/** Pane / z-index contract shared by every map view. */
export const MAP_PANES = {
    'map-land': 200,
    'map-borders': 210,
    'map-grid': 220,
    'map-path': 420,
    'map-spot': 430,
    'map-opponent': 440,
    'map-qso': 450,
    'map-home': 460,
    'map-rotator': 470,
    'map-label': 480
};

/** Layer name -> pane used when a page opts in to the pane contract. */
export const LAYER_PANES = {
    aurora: 'map-grid',
    weather: 'map-grid',
    qso: 'map-qso',
    spot: 'map-spot',
    myspot: 'map-spot',
    dxspot: 'map-opponent',
    opponent: 'map-opponent',
    home: 'map-home',
    rotator: 'map-rotator'
};

/** CSS custom properties read by refreshTheme(). */
export const THEME_VARS = {
    landFill: '--map-land-fill',
    landLine: '--map-land-line',
    border: '--map-borders-color',
    grid: '--map-grid',
    spot: '--map-spot',
    qso: '--map-qso',
    open: '--map-open',
    blocked: '--map-blocked'
};

const DEFAULT_LAND = {
    show: true,
    bounds: LAND_BOUNDS,
    fill: '#0d1a29',
    line: '#1b3550',
    weight: 1,
    pane: 'map-land',
    zIndex: MAP_PANES['map-land']
};

const DEFAULT_BORDERS = {
    show: false,
    color: BORDER_STYLE.color,
    weight: BORDER_STYLE.weight,
    opacity: BORDER_STYLE.opacity,
    dashArray: null,
    pane: 'map-borders',
    zIndex: MAP_PANES['map-borders']
};

const DEFAULT_INTERACTION = {zoom: true, pan: true, click: false, cursor: null};

function normalizedLand(land, theme) {
    if (land === false) return {...DEFAULT_LAND, show: false};
    const config = {...DEFAULT_LAND, ...(land || {})};
    if (!land || land.fill === undefined) config.fill = theme.landFill || DEFAULT_LAND.fill;
    if (!land || land.line === undefined) config.line = theme.landLine || DEFAULT_LAND.line;
    return config;
}

function normalizedBorders(borders, theme) {
    if (borders === false) return {...DEFAULT_BORDERS, show: false};
    const config = {...DEFAULT_BORDERS, ...(borders || {})};
    if (!borders || borders.color === undefined) config.color = theme.border || DEFAULT_BORDERS.color;
    return config;
}

/** Read the current theme colours; missing document (tests) yields fallbacks. */
export function readTheme(root = globalThis) {
    const doc = root && root.document;
    if (!doc || typeof root.getComputedStyle !== 'function') return {};
    /* Theme overrides live on body[data-theme], so read from body first. */
    const style = root.getComputedStyle(doc.body || doc.documentElement);
    const colors = {};
    for (const [key, name] of Object.entries(THEME_VARS)) {
        const value = style && style.getPropertyValue ? style.getPropertyValue(name).trim() : '';
        if (value) colors[key] = value;
    }
    return colors;
}

function debounce(callback, wait) {
    let timer = null;
    return (...args) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            callback(...args);
        }, wait);
    };
}

function fitTo(map, view) {
    const kind = view.kind || 'world';
    if (kind === 'points') {
        fitPoints(map, view.points || [], {L: view.L, maxZoom: view.maxZoom || 7, pad: view.padding || 0.08});
        return map.getZoom();
    }
    if (kind === 'fixed') {
        if (view.bounds) map.setMaxBounds(view.bounds);
        if (view.minZoom !== undefined) map.setMinZoom(view.minZoom);
        if (view.maxZoom !== undefined) map.setMaxZoom(view.maxZoom);
        if (view.center) map.setView(view.center, view.zoom, {animate: false});
        return map.getZoom();
    }
    let zoom;
    if (Array.isArray(view.range) && view.range.length === 2) {
        zoom = fitWorldRange(map, view.range[0], view.range[1]);
    } else {
        zoom = fitWorld(map);
    }
    if (view.lockZoom) map.setMaxZoom(zoom);
    return zoom;
}

export function createMapSurface(target, config = {}) {
    const L = getLeaflet(config.L);
    const element = typeof target === 'string'
        ? (globalThis.document && globalThis.document.getElementById(target))
        : target;
    const theme = config.theme === 'auto' || config.theme === undefined ? readTheme() : {};
    const land = normalizedLand(config.land, theme);
    const borders = normalizedBorders(config.borders, theme);
    const interaction = {...DEFAULT_INTERACTION, ...(config.interaction || {})};
    const view = {kind: 'world', ...(config.view || {}), L};
    const resizeConfig = {observe: true, debounce: 120, ...(config.resize || {})};
    const handlers = config.on || {};
    const provider = config.provider === undefined ? 'offline' : config.provider;

    const base = createBaseMap(target, {
        L,
        provider: provider === 'offline' || provider === 'none' ? null : provider,
        mapOptions: {
            zoomControl: false,
            attributionControl: false,
            scrollWheelZoom: Boolean(interaction.zoom),
            dragging: Boolean(interaction.pan),
            doubleClickZoom: Boolean(interaction.zoom),
            touchZoom: Boolean(interaction.zoom),
            boxZoom: Boolean(interaction.zoom),
            keyboard: Boolean(interaction.zoom),
            zoomSnap: 0,
            maxBounds: view.bounds || WORLD_BOUNDS,
            maxBoundsViscosity: 1,
            ...(config.mapOptions || {})
        }
    });
    const map = base.map;
    if (interaction.cursor && element && element.style) element.style.cursor = interaction.cursor;

    Object.entries(MAP_PANES).forEach(([name, zIndex]) => createRasterPane(map, name, zIndex));

    let landOverlay = land.show ? addOfflineLand(map, {L, ...land}) : null;
    let borderLayer = borders.show
        ? addOfflineBorders(map, {L, root: config.root, ...borders})
        : null;

    const layers = new Map();

    function layer(name, options = {}) {
        let entry = layers.get(name);
        if (!entry) {
            entry = {
                group: createLayerGroup(map, {L}),
                pane: options.pane || LAYER_PANES[name] || null,
                visible: true,
                items: new Map(),
                selected: null
            };
            layers.set(name, entry);
        }
        const handle = {
            name,
            group: entry.group,
            get pane() { return entry.pane; },
            get visible() { return entry.visible; },
            show() {
                entry.visible = true;
                return setLayerVisible(map, entry.group, true);
            },
            hide() {
                entry.visible = false;
                return setLayerVisible(map, entry.group, false);
            },
            clear() {
                entry.group.clearLayers();
                entry.items.clear();
            },
            /** Incremental by id: keeps existing layers, adds new, drops missing. */
            setData(items = [], {id = item => item.id, create, update} = {}) {
                const next = new Map();
                for (const item of items) {
                    const key = String(id(item));
                    const existing = entry.items.get(key);
                    if (existing) {
                        if (update) update(existing.layer, item, {selected: entry.selected === key});
                        next.set(key, {item, layer: existing.layer});
                        continue;
                    }
                    if (!create) continue;
                    const created = create(item);
                    if (!created) continue;
                    next.set(key, {item, layer: created});
                    if (typeof created.addTo === 'function') created.addTo(entry.group);
                }
                for (const [key, record] of entry.items) {
                    if (next.has(key)) continue;
                    if (record.layer && typeof entry.group.hasLayer === 'function' &&
                        entry.group.hasLayer(record.layer)) entry.group.removeLayer(record.layer);
                }
                entry.items = next;
                return next.size;
            },
            setSelected(key) {
                entry.selected = key === undefined ? null : String(key);
                if (!update) return;
                for (const [id, record] of entry.items) {
                    update(record.layer, record.item, {selected: id === entry.selected});
                }
            }
        };
        return handle;
    }

    (config.layers || []).forEach(name => layer(name));

    function fit() {
        map.invalidateSize();
        /* A pane can still be 0x0 during the first layout pass; fitting then
         * would compute an invalid zoom and leave the map blank. The
         * ResizeObserver calls fit() again once the pane has real dimensions. */
        const size = map.getSize();
        if (!size.x || !size.y) return map.getZoom();
        return fitTo(map, view);
    }

    function setView(next = {}) {
        Object.assign(view, next);
        return fit();
    }

    function setInteraction(patch = {}) {
        Object.assign(interaction, patch);
        if (patch.zoom !== undefined) {
            ['scrollWheelZoom', 'doubleClickZoom', 'touchZoom', 'boxZoom', 'keyboard']
                .forEach(name => {
                    if (map[name] && typeof map[name].enable === 'function') {
                        map[name][patch.zoom ? 'enable' : 'disable']();
                    }
                });
        }
        if (patch.pan !== undefined && map.dragging) {
            map.dragging[patch.pan ? 'enable' : 'disable']();
        }
        if (patch.cursor !== undefined && element && element.style) {
            element.style.cursor = patch.cursor || '';
        }
        return interaction;
    }

    function refreshTheme(root = globalThis) {
        const colors = readTheme(root);
        let changed = false;
        if (landOverlay && (colors.landFill || colors.landLine)) {
            const fill = colors.landFill || land.fill;
            const line = colors.landLine || land.line;
            if (fill !== land.fill || line !== land.line) {
                land.fill = fill;
                land.line = line;
                map.removeLayer(landOverlay);
                landOverlay = addOfflineLand(map, {L, ...land});
                changed = true;
            }
        }
        if (borderLayer && colors.border && colors.border !== borders.color) {
            borders.color = colors.border;
            borderLayer.eachLayer(item => item.setStyle && item.setStyle({color: borders.color}));
            changed = true;
        }
        return changed;
    }

    if (typeof handlers.click === 'function') {
        map.on('click', event => handlers.click(event.latlng, event));
    }
    if (typeof handlers.select === 'function') {
        map.on('click', event => handlers.select(event.latlng, event));
    }

    /* Theme switches only change body[data-theme]; rebuild land/borders then. */
    let themeObserver = null;
    if (config.theme !== false && typeof MutationObserver === 'function' &&
        globalThis.document && globalThis.document.body) {
        themeObserver = new MutationObserver(() => refreshTheme());
        themeObserver.observe(globalThis.document.body, {
            attributes: true,
            attributeFilter: ['data-theme', 'class']
        });
    }

    let observer = null;
    let lastSize = null;
    if (resizeConfig.observe && typeof ResizeObserver === 'function' && element) {
        const onResize = debounce(() => {
            map.invalidateSize();
            const size = map.getSize();
            if (!size.x || !size.y) return;
            if (lastSize && size.x === lastSize.x && size.y === lastSize.y) return;
            lastSize = size;
            fit();
            if (typeof resizeConfig.onResize === 'function') resizeConfig.onResize(map);
        }, resizeConfig.debounce);
        observer = new ResizeObserver(onResize);
        observer.observe(element);
    }

    fit();

    return {
        map,
        panes: MAP_PANES,
        layer,
        fit,
        setView,
        setInteraction,
        get interaction() { return {...interaction}; },
        get view() { return {...view}; },
        setData(name, items, options) {
            return layer(name).setData(items, options);
        },
        setSelected(name, key) {
            return layer(name).setSelected(key);
        },
        clear() {
            layers.forEach(entry => {
                entry.group.clearLayers();
                entry.items.clear();
            });
        },
        refreshTheme,
        destroy() {
            if (observer) observer.disconnect();
            observer = null;
            if (themeObserver) themeObserver.disconnect();
            themeObserver = null;
            if (borderLayer) clearOfflineBorders(map, borderLayer);
            borderLayer = null;
            landOverlay = null;
            base.destroy();
        }
    };
}
