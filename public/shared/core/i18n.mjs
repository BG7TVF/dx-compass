/**
 * Read-only adapter for the legacy I18N/LANGS/LANG_NAMES globals.
 * Input: a language and translation keys. Output: translated text/function values.
 * The source dictionaries and globals are never modified.
 */
export function createI18n({
    lang = 'zh',
    fallback = 'en',
    dictionaries,
    languages,
    languageNames,
    root = globalThis
} = {}) {
    let current = lang;
    const dicts = () => dictionaries || root.I18N || {};
    const t = (key, params) => {
        const all = dicts();
        const table = all[current] || {};
        const fallbackTable = all[fallback] || {};
        let value = table[key];
        if (value === undefined) value = fallbackTable[key];
        if (value === undefined) return key;
        if (typeof value === 'function') return params === undefined ? value : value(params);
        if (params && typeof params === 'object') {
            return String(value).replace(/\{([^}]+)\}/g, (match, name) =>
                Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
        }
        return value;
    };
    return {
        t,
        translate: t,
        has(language) { return Object.prototype.hasOwnProperty.call(dicts(), language); },
        setLanguage(language) { current = language; },
        get language() { return current; },
        get languages() { return [...(languages || root.LANGS || Object.keys(dicts()))]; },
        get languageNames() { return {...(languageNames || root.LANG_NAMES || {})}; },
        dictionary(language = current) { return dicts()[language]; }
    };
}
