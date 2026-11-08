/** Preserve the classic t(key) contract, including dictionary entries that are functions. */
export function createLegacyTranslator(i18n, language = () => i18n.language) {
    return (key, params) => {
        const current = i18n.dictionary(language()) || {};
        const fallback = i18n.dictionary('en') || {};
        const value = current[key] !== undefined ? current[key] : fallback[key];
        if (value === undefined) return key;
        if (typeof value === 'function') return value;
        if (params !== undefined) return i18n.t(key, params);
        return value;
    };
}
