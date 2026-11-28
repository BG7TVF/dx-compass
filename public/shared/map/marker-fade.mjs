/**
 * 地图标记淡出/剪枝的增量绘制器（OP 视图与大屏地图共用）。
 *
 * marker-life.mjs 只回答「这条记录现在还活着吗、该多淡」；这里负责把答案写回
 * Leaflet 图层：按 fadeSec 改透明度、按 pruneSec 摘掉到期的那几条，避免为了
 * 淡出而重建整张地图。计算口径不在这里重复，一律转给 marker-life。
 *
 * 本模块不 import Leaflet，只用到图层对象的 setStyle / getElement 和图层组的
 * removeLayer，因此 SVG 层、circleMarker、divIcon 标记都能一视同仁地淡出。
 */
import {fadeOpacity, fadeScale, isExpired} from './marker-life.mjs';

function createEntry(group, bornAt, dieAt) {
    const entry = {
        group,
        bornAt,
        dieAt,
        tracks: [],
        dots: [],
        icons: [],
        layers: [],
        /* 一组大圆线：base 是它们本来的透明度，淡出时按比例压暗。 */
        addTrack(layers, base) {
            (Array.isArray(layers) ? layers : [layers]).forEach(layer => {
                entry.tracks.push({layer, base});
                entry.layers.push(layer);
            });
        },
        /* 圆点标记：stroke / fill 分别是描边与填充的基准透明度。 */
        addDot(layer, stroke = 1, fill = 1) {
            entry.dots.push({layer, stroke, fill});
            entry.layers.push(layer);
        },
        /* divIcon 之类的图标标记：没有 setStyle，只能调元素的 opacity。 */
        addIcon(layer) {
            entry.icons.push(layer);
            entry.layers.push(layer);
        }
    };
    return entry;
}

export function createMarkerFade() {
    const entries = [];

    function paint(entry, now) {
        const opacity = fadeOpacity(entry.bornAt, entry.dieAt, now);
        entry.tracks.forEach(track =>
            track.layer.setStyle({opacity: fadeScale(opacity, track.base)}));
        entry.dots.forEach(dot => dot.layer.setStyle({
            opacity: fadeScale(opacity, dot.stroke),
            fillOpacity: fadeScale(opacity, dot.fill)
        }));
        entry.icons.forEach(icon => {
            const element = icon.getElement && icon.getElement();
            if (element) element.style.opacity = opacity;
        });
    }

    function remove(entry) {
        /* 只摘这一条记录自己的图层：同一层里还有别的记录没到期，
         * 整组 clearLayers 会把它们一起擦掉。 */
        entry.layers.forEach(layer => entry.group.removeLayer(layer));
    }

    return {
        /** 登记一条记录的绘制结果；调用方往里塞 tracks / dots / icons。 */
        add({group, bornAt, dieAt}) {
            const entry = createEntry(group, bornAt, dieAt);
            entries.push(entry);
            return entry;
        },
        /** 全量重绘之后调用：图层已经由地图自己清空，这里只丢记账。 */
        reset() {
            entries.length = 0;
        },
        /** 画到最后发现这条记录一个图层都没落下（比如位置重复），从账本里撤回。 */
        drop(entry) {
            const index = entries.indexOf(entry);
            if (index >= 0) entries.splice(index, 1);
        },
        /** 淡出重算（fadeSec 的节奏）；已过期的留给 prune 处理。 */
        tick(now = Date.now()) {
            entries.forEach(entry => {
                if (isExpired(entry.dieAt, now)) return;
                paint(entry, now);
            });
        },
        /** 剪掉到期记录的图层（pruneSec 的节奏）。 */
        prune(now = Date.now()) {
            for (let index = entries.length - 1; index >= 0; index -= 1) {
                const entry = entries[index];
                if (!isExpired(entry.dieAt, now)) continue;
                remove(entry);
                entries.splice(index, 1);
            }
        },
        get size() {
            return entries.length;
        }
    };
}
