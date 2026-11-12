/**
 * Single voice outlet for the alert module.
 *
 * Every spoken alert (QSO page, OP view, "my spot" batches) goes through
 * createVoiceAlert().speak(); pages no longer hold their own speechSynthesis
 * implementation. The browser API is optional: when it is unavailable the call
 * is a no-op, matching the previous behaviour.
 */

export const VOICE_LANGS = {
    zh: 'zh-CN', en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES',
    pt: 'pt-PT', ru: 'ru-RU', it: 'it-IT', ar: 'ar-SA', ko: 'ko-KR', ja: 'ja-JP'
};

function number(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

export function createVoiceAlert({getSettings, getLanguage, root = globalThis} = {}) {
    const settingsOf = () => (typeof getSettings === 'function' ? getSettings() : getSettings) || {};
    const languageOf = () => (typeof getLanguage === 'function' ? getLanguage() : getLanguage) || 'en';

    function speak(text, {cancel = true} = {}) {
        if (!text) return false;
        const view = root && root.window ? root.window : root;
        if (!view || !('speechSynthesis' in view) || typeof view.SpeechSynthesisUtterance !== 'function') {
            return false;
        }
        try {
            if (cancel) view.speechSynthesis.cancel();
            const utterance = new view.SpeechSynthesisUtterance(String(text));
            utterance.lang = VOICE_LANGS[languageOf()] || 'en-US';
            utterance.rate = number(settingsOf().voiceRate, 1.05, 0.6, 1.6);
            utterance.volume = number(settingsOf().voiceVolume, 1, 0, 1);
            view.speechSynthesis.speak(utterance);
            return true;
        } catch {
            return false;
        }
    }

    return {speak};
}
