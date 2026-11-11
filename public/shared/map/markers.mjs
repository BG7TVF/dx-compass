/**
 * Shared marker factory for map overlays. Input: Leaflet namespace plus an
 * opponent style or a radio number. Output: divIcon descriptors; no DOM writes.
 *
 * Colour and shape live here so the big screen, the OP map and the opponent
 * cards draw one identity from one source instead of three copies.
 */

/* Rival identity palette, shared by the opponent list and the map markers.
 *
 * The semantic palette already owns most of the wheel: alert red 14 deg, DX
 * red 0 deg, my-station cyan 193 deg, QSO green 161 deg, and the 12 band hues
 * (285/27/336/48/168/184/204/283/327/14/200/164 deg). The only wide free arcs
 * are 49-160, 205-282 and 286-326, so a mathematically even split is not
 * possible; the six hues below sit in the middle of those arcs and are pulled
 * apart further by lightness.
 *
 *   #f3ed3f  58 deg  15.2:1   lemon
 *   #26e109 112 deg  10.6:1   grass green
 *   #6ff69c 140 deg  13.7:1   spring green
 *   #3377ff 220 deg   4.7:1   royal blue
 *   #c6a8fa 262 deg   9.3:1   lavender
 *   #f859e8 306 deg   6.8:1   magenta
 *
 * Six hues are fewer than ten rivals, so every rival also gets a fixed marker
 * shape; no two rivals on screen share colour + shape. */
export const OPPONENT_COLORS = [
    '#f3ed3f', /* lemon        hue  58 */
    '#26e109', /* grass         hue 112 */
    '#6ff69c', /* spring green  hue 140 */
    '#3377ff', /* royal blue    hue 220 */
    '#c6a8fa', /* lavender      hue 262 */
    '#f859e8' /* magenta       hue 306 */
];

/* Second encoding: a fixed glyph per rival, drawn identically in the list and
 * on the map. Colour alone cannot carry six-plus identities on a dense map,
 * so shape survives colour-vision differences and small marker sizes. */
export const OPPONENT_SHAPES = [
    'disc', 'ring', 'square', 'diamond', 'triangle', 'hexagon', 'cross', 'bullseye'
];

const SHAPE_DRAW = {
    disc: color => '<circle cx="8" cy="8" r="5.6" fill="' + color +
        '" stroke="#04101c" stroke-width="1.6"/>',
    ring: color => '<circle cx="8" cy="8" r="5" fill="none" stroke="' + color +
        '" stroke-width="2.8"/>',
    square: color => '<rect x="3" y="3" width="10" height="10" rx="1" fill="' + color +
        '" stroke="#04101c" stroke-width="1.6"/>',
    diamond: color => '<path d="M8 2.2 13.8 8 8 13.8 2.2 8Z" fill="' + color +
        '" stroke="#04101c" stroke-width="1.4"/>',
    triangle: color => '<path d="M8 2.4 13.6 13.2 2.4 13.2Z" fill="' + color +
        '" stroke="#04101c" stroke-width="1.4"/>',
    hexagon: color => '<path d="M8 2.4 13 5.2v5.6L8 13.6 3 10.8V5.2Z" fill="none" stroke="' +
        color + '" stroke-width="2.4"/>',
    cross: color => '<path d="M8 2.4v11.2M2.4 8h11.2" stroke="' + color +
        '" stroke-width="2.8" stroke-linecap="round"/>',
    bullseye: color => '<circle cx="8" cy="8" r="5.8" fill="none" stroke="' + color +
        '" stroke-width="1.7"/><circle cx="8" cy="8" r="2.2" fill="' + color + '"/>'
};

/** Inline SVG glyph, used verbatim by the card swatch and the map marker so
 *  the two views cannot drift apart. */
export function shapeSvg(shape, color, size = 16) {
    const draw = SHAPE_DRAW[shape] || SHAPE_DRAW.disc;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 16 16" ' +
        'aria-hidden="true">' + draw(color || OPPONENT_COLORS[0]) + '</svg>';
}

/** Rival marker: colour + shape from the shared identity assignment. */
export function opponentIcon(L, style, size = 16) {
    return L.divIcon({
        className: 'dx-glyph',
        html: shapeSvg(style.shape, style.color, size),
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2]
    });
}

/** QSO endpoint dot used by the OP map (one class per radio lane). */
export function qsoDotIcon(L, radio, {className = 'op-map-dot', size = 9} = {}) {
    return L.divIcon({
        className: className + ' r' + radio,
        html: '<i></i>',
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2]
    });
}
