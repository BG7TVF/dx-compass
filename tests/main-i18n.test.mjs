import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createI18n} from '../public/shared/core/i18n.mjs';
import {createLegacyTranslator} from '../public/js/legacy-i18n.mjs';

test('classic translations are explicitly bridged and render real localized text', () => {
    const source = fs.readFileSync(new URL('../public/js/i18n.js', import.meta.url), 'utf8');
    const sandbox = {window: {}};
    vm.createContext(sandbox);
    vm.runInContext(`${source}\nwindow.I18N = I18N; window.LANGS = LANGS; window.LANG_NAMES = LANG_NAMES;`, sandbox);
    const i18n = createI18n({root: sandbox.window, lang: 'zh'});
    assert.equal(i18n.languages.length, 11);
    assert.equal(i18n.t('settings'), '设置');
    assert.equal(i18n.t('startMon'), '▶ 开始监控');
    const translate = createLegacyTranslator(i18n, () => i18n.language);
    assert.equal(translate('mAgo')(2), '2分钟前');
    assert.equal(translate('spotsN')(3), '3 spots');
    i18n.setLanguage('en');
    assert.equal(i18n.t('settings'), 'Settings');
    assert.notEqual(i18n.t('settings'), 'settings');

    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.match(html, /window\.I18N\s*=\s*I18N/);
    assert.match(html, /window\.LANGS\s*=\s*LANGS/);
    assert.match(html, /window\.LANG_NAMES\s*=\s*LANG_NAMES/);
    assert.equal((html.match(/<script\s+type="module"/g) || []).length, 1);
    assert.match(html, /<script\s+type="module"\s+src="js\/main\.mjs/);
});
