import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceAlert, VOICE_LANGS} from '../public/shared/alerts/voice.mjs';

function fakeRoot() {
    const calls = [];
    class Utterance {
        constructor(text) {
            this.text = text;
        }
    }
    const root = {
        SpeechSynthesisUtterance: Utterance,
        speechSynthesis: {
            cancelled: 0,
            cancel() { this.cancelled += 1; },
            speak(utterance) { calls.push(utterance); }
        }
    };
    return {root, calls};
}

test('语音出口按当前语言与设置生成 utterance，并在播报前取消上一条', () => {
    const {root, calls} = fakeRoot();
    const voice = createVoiceAlert({
        getSettings: () => ({voiceRate: 1.2, voiceVolume: 0.5}),
        getLanguage: () => 'ja',
        root
    });
    assert.equal(voice.speak('新しい DXCC JA1ABC'), true);
    assert.equal(root.speechSynthesis.cancelled, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].lang, VOICE_LANGS.ja);
    assert.equal(calls[0].rate, 1.2);
    assert.equal(calls[0].volume, 0.5);
});

test('语音速率与音量超出范围时收敛，未知语言回退 en-US', () => {
    const {root, calls} = fakeRoot();
    const voice = createVoiceAlert({
        getSettings: () => ({voiceRate: 9, voiceVolume: -1}),
        getLanguage: () => 'xx',
        root
    });
    voice.speak('test');
    assert.equal(calls[0].rate, 1.6);
    assert.equal(calls[0].volume, 0);
    assert.equal(calls[0].lang, 'en-US');
});

test('浏览器没有语音能力时安全降级为无操作', () => {
    const voice = createVoiceAlert({getSettings: () => ({}), getLanguage: () => 'de', root: {}});
    assert.equal(voice.speak('Gerät bereit'), false);
    assert.equal(voice.speak(''), false);
});
