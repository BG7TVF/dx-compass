/* Minimal translator for the wall bundles.
 *
 * The wall is served by its own read-only static server, so it cannot use the
 * browser i18n adapter: index.html loads public/js/i18n.js as a classic script
 * and exposes it as window.I18N. The dictionary is read lazily so tests (and
 * the first paint) can run before that script has executed.
 */
const FALLBACK = 'en';
let lang = 'zh';

const dictionary = () => (typeof globalThis !== 'undefined' && globalThis.I18N) || {};

export function setLanguage(next) {
    const dict = dictionary();
    lang = dict[next] ? next : FALLBACK;
    return lang;
}

export function getLanguage() {
    return lang;
}

export function hasDictionary() {
    return !!dictionary()[FALLBACK];
}

export function t(key, params) {
    const dict = dictionary();
    const table = dict[lang] || {};
    const fallback = dict[FALLBACK] || {};
    const raw = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : fallback[key];
    if (raw == null) return key;
    const text = typeof raw === 'function' ? raw(params) : raw;
    if (text == null) return key;
    return String(text).replace(/\{(\w+)\}/g, (match, name) => params && name in params ? params[name] : match);
}

/** Rewrite every static [data-i18n] node and sync <html lang>. */
export function applyStatic(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(element => {
        const key = element.dataset.i18n;
        const text = t(key);
        if (text !== key) element.textContent = text;
    });
    /* English sub-labels next to the translated title would duplicate it in
     * Chinese, where both would be Chinese; they only make sense for the
     * bilingual Chinese wall, mirroring the original design. */
    root.querySelectorAll('[data-lang-sub]').forEach(element => {
        element.hidden = lang !== 'zh';
    });
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
}
