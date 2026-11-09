import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const schema = require('../public/shared/settings/schema.js');

const I18N_FILE = new URL('../public/js/i18n.js', import.meta.url);
const source = fs.readFileSync(I18N_FILE, 'utf8');

const LANGS = ['zh', 'en', 'de', 'fr', 'es', 'pt', 'ru', 'it', 'ar', 'ko', 'ja'];

function loadDictionary() {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(
        `${source}
         globalThis.__dict = {I18N, LANGS, I18N_EXTRA, I18N_MERGE_DUPLICATES, PROP_I18N, PROP_CARD_I18N};`,
        sandbox
    );
    return sandbox.__dict;
}

const dict = loadDictionary();

/* Legacy lowercase English values that legitimately mirror their key. */
const KEY_ECHO_ALLOWED = new Set(['en:connected', 'en:disconnected', 'en:since', 'en:now']);

function textOf(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.join(' \u0001 ');
    if (typeof value === 'function') return value.toString();
    return String(value);
}

function placeholdersOf(value) {
    const found = textOf(value).match(/\{[A-Za-z][\w]*\}/g) || [];
    return [...new Set(found)].sort().join(',');
}

/* Depth-0 key scan of one language object in the raw source. */
function keysOfLangObject(text) {
    const keys = [];
    let depth = 0;
    let quote = null;
    for (let i = 0; i < text.length;) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\') { i += 2; continue; }
            if (ch === quote) quote = null;
            i += 1;
            continue;
        }
        if (ch === '{') { depth += 1; i += 1; continue; }
        if (ch === '}') { depth -= 1; i += 1; continue; }
        if (depth === 1) {
            const m = /^(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*))\s*:/.exec(text.slice(i));
            if (m) {
                keys.push(m[1] ?? m[2] ?? m[3]);
                i += m[0].length;
                continue;
            }
        }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; i += 1; continue; }
        i += 1;
    }
    return keys;
}

function sourceBlocks() {
    const mainEnd = source.indexOf('/* ---------- Propagation page');
    const propStart = source.indexOf('const PROP_I18N = {');
    const cardStart = source.indexOf('const PROP_CARD_I18N = {');
    const tailStart = source.indexOf('for (const l of LANGS) Object.assign');
    const extraStart = source.indexOf('const I18N_EXTRA = {');
    return {
        I18N: source.slice(source.indexOf('const I18N = {'), mainEnd),
        PROP_I18N: source.slice(propStart, cardStart),
        PROP_CARD_I18N: source.slice(cardStart, tailStart),
        I18N_EXTRA: source.slice(extraStart, source.indexOf('\n};', extraStart))
    };
}

function langSlices(blockText) {
    const hits = [...blockText.matchAll(/^ {4}([a-z]{2}):\s*\{/gm)];
    const out = {};
    for (let i = 0; i < hits.length; i += 1) {
        const code = hits[i][1];
        if (code in out) continue;
        const start = hits[i].index;
        const end = i + 1 < hits.length ? hits[i + 1].index : blockText.length;
        out[code] = blockText.slice(start, end);
    }
    return out;
}

test('all eleven locales expose the same key set', () => {
    assert.equal(dict.LANGS.length, 11);
    assert.deepEqual([...dict.LANGS], LANGS);
    const reference = [...Object.keys(dict.I18N.en)].sort();
    for (const lang of LANGS) {
        assert.deepEqual([...Object.keys(dict.I18N[lang])].sort(), reference, `key set drift: ${lang}`);
    }
});

test('no locale contains empty values or untranslated key echoes', () => {
    for (const lang of LANGS) {
        for (const [key, value] of Object.entries(dict.I18N[lang])) {
            const text = textOf(value);
            assert.ok(text.trim().length > 0, `${lang}.${key} is empty`);
            if (KEY_ECHO_ALLOWED.has(`${lang}:${key}`)) continue;
            assert.notEqual(text, key, `${lang}.${key} echoes its own key`);
        }
    }
});

test('placeholders are identical across locales', () => {
    for (const key of Object.keys(dict.I18N.en)) {
        const reference = placeholdersOf(dict.I18N.en[key]);
        if (!reference) continue;
        for (const lang of LANGS) {
            assert.equal(placeholdersOf(dict.I18N[lang][key]), reference,
                `placeholder drift: ${lang}.${key}`);
        }
    }
});

test('no duplicate keys inside any source dictionary block', () => {
    const blocks = sourceBlocks();
    for (const [name, text] of Object.entries(blocks)) {
        for (const [lang, slice] of Object.entries(langSlices(text))) {
            const keys = keysOfLangObject(slice);
            const seen = new Set();
            const dupes = [];
            for (const key of keys) {
                if (seen.has(key)) dupes.push(key);
                seen.add(key);
            }
            assert.deepEqual(dupes, [], `duplicate keys in ${name}.${lang}: ${dupes.join(', ')}`);
            assert.ok(keys.length > 0, `no keys parsed in ${name}.${lang}`);
        }
    }
});

test('the settings/wall merge never overwrites a legacy key', () => {
    assert.deepEqual([...dict.I18N_MERGE_DUPLICATES], []);
    assert.ok(Object.keys(dict.I18N_EXTRA.zh).length >= 300);
    assert.deepEqual(
        [...Object.keys(dict.I18N_EXTRA.zh)].sort(),
        [...Object.keys(dict.I18N_EXTRA.en)].sort()
    );
});

test('forbidden machine-translation terms never appear', () => {
    const forbidden = [
        '蚂蚁', '钻机', '乐队', '斑点', '终结者', '夏令时',
        '噪声地板', '噪音地板', '登录簿', '个人资料', '梅登海德', '最大可用频率'
    ];
    for (const lang of LANGS) {
        for (const [key, value] of Object.entries(dict.I18N[lang])) {
            const text = textOf(value);
            for (const word of forbidden) {
                assert.ok(!text.includes(word), `${lang}.${key} contains forbidden term "${word}"`);
            }
        }
    }
    /* DST stays an abbreviation; only the timezone expansion is banned. */
    assert.ok(!Object.values(dict.I18N.zh).some(v => textOf(v).includes('夏令时')));
});

test('every schema field and enum has dictionary entries', () => {
    for (const field of schema.FIELDS) {
        const base = `settings.field.${field.key}`;
        for (const key of [`${base}.label`, `${base}.desc`]) {
            for (const lang of LANGS) {
                assert.ok(key in dict.I18N[lang], `missing ${lang}.${key}`);
            }
        }
        if (field.type === 'enum' || field.type === 'enumArray') {
            for (const value of field.values || []) {
                const key = `${base}.option.${value}`;
                for (const lang of LANGS) {
                    assert.ok(key in dict.I18N[lang], `missing ${lang}.${key}`);
                }
            }
        }
    }
});

test('every literal t() key used by the UI still resolves', () => {
    const files = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(m?js|html)$/.test(entry.name)) files.push(full);
        }
    };
    walk(fileURLToPath(new URL('../public', import.meta.url)));

    const keys = new Set();
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        for (const m of text.matchAll(/\bt\(\s*'([A-Za-z][\w]*)'\s*\)/g)) keys.add(m[1]);
    }
    assert.ok(keys.size >= 80, `unexpectedly few literal t() keys: ${keys.size}`);
    for (const key of keys) {
        assert.ok(key in dict.I18N.en, `t('${key}') has no dictionary entry`);
        for (const lang of LANGS) {
            assert.ok(key in dict.I18N[lang], `t('${key}') missing from ${lang}`);
        }
    }
});
