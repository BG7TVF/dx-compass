#!/usr/bin/env node
/**
 * CQ WPX 前缀乘数数据抓取 / 校验脚本。
 *
 * 用法：
 *   node scripts/fetch-wpx-prefixes.mjs           下载规则页并重建数据文件
 *   node scripts/fetch-wpx-prefixes.mjs --check   只校验仓库里的数据文件
 *
 * 说明：
 *   - 官方规则页没有“全部前缀清单”这种静态表；WPX 乘数按规则 V.C.1 由呼号
 *     算法推导（前缀 = 呼号首部的字母/数字组合）。因此本文件保存两样东西：
 *       1) definition —— 规则原文（事实性引用，注明来源与抓取时间）；
 *       2) authorizedPrefixes —— 从 ARRL DXCC 前缀表派生的“已授权字头”集合，
 *          仅用于校验推导出的前缀基底是否合法，不参与乘数计数。
 *   - 绝不能与 public/shared/dxcc/ 混用：DXCC 是实体，WPX 是前缀。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PREFIX_ENTRIES} from '../public/shared/dxcc/prefixes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_FILE = path.join(ROOT, 'public', 'shared', 'wpx', 'prefixes.json');

const RULES_URL = 'https://cqwpx.com/rules.htm';
const RULES_PDF = 'https://cqwpx.com/rules/2024_cqwpx_rules.pdf';
const UA = 'DX-Compass/2.1 (+https://github.com/) WPX prefix data builder';

const MIN_PREFIXES = 200;
const MAX_PREFIXES = 1200;

function decodeEntities(text) {
    return text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function htmlToText(html) {
    return decodeEntities(
        String(html || '')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
    ).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** 规则 V.C 段落：从 “Prefix Multipliers” 到下一节 “VI. ENTRY CATEGORIES”。 */
function extractPrefixSection(text) {
    const start = text.search(/Prefix Multipliers/i);
    if (start < 0) throw new Error('rules page: "Prefix Multipliers" section not found');
    const tail = text.slice(start);
    const end = tail.search(/ENTRY CATEGORIES/i);
    return (end > 0 ? tail.slice(0, end) : tail).trim();
}

/** 规则原文里的前缀定义句（用于数据文件可读性，不改写）。 */
function extractDefinition(section) {
    const flat = section.replace(/\s+/g, ' ');
    const m = /A PREFIX is the letter\/numeral combination[\s\S]*?examples:\s*([^.]*)\./i.exec(flat);
    if (!m) throw new Error('rules page: prefix definition sentence not found');
    return {
        sentence: 'A PREFIX is the letter/numeral combination which forms the first part of the amateur call.',
        examples: m[1].replace(/\s+/g, ' ').trim(),
        counting: 'Each PREFIX is counted only once regardless of the band or number of times the same prefix is worked.',
        portableRule: 'Portable designators without numbers are assigned a zero after the second letter; calls without numbers are assigned a zero after the first two letters.',
        ignoredSuffixes: 'Maritime mobile, mobile, /A, /E, /J, /P and other license class identifiers do not count as prefixes.'
    };
}

function normalizePrefix(value) {
    return String(value == null ? '' : value).trim().toUpperCase();
}

/** 从 DXCC 前缀表派生已授权字头集合（字母/数字组合，不含数字尾）。 */
function deriveAuthorizedPrefixes(entries) {
    const set = new Set();
    for (const entry of entries || []) {
        if (!entry || entry.deleted) continue;
        const list = Array.isArray(entry.prefixes) && entry.prefixes.length
            ? entry.prefixes : [entry.prefix];
        for (const raw of list) {
            const value = normalizePrefix(raw);
            if (/^[0-9A-Z]{1,4}$/.test(value)) set.add(value);
        }
        const main = normalizePrefix(entry.prefix);
        if (/^[0-9A-Z]{1,4}$/.test(main)) set.add(main);
    }
    return [...set].sort();
}

function validatePayload(payload) {
    const errors = [];
    const list = payload && payload.authorizedPrefixes;
    if (!Array.isArray(list)) errors.push('authorizedPrefixes must be an array');
    else {
        if (list.length < MIN_PREFIXES || list.length > MAX_PREFIXES) {
            errors.push(`authorizedPrefixes count ${list.length} outside ${MIN_PREFIXES}..${MAX_PREFIXES}`);
        }
        const seen = new Set();
        for (const item of list) {
            if (typeof item !== 'string' || item !== item.toUpperCase() || !/^[0-9A-Z]{1,4}$/.test(item)) {
                errors.push(`invalid prefix entry: ${JSON.stringify(item)}`);
                break;
            }
            if (seen.has(item)) {
                errors.push(`duplicate prefix: ${item}`);
                break;
            }
            seen.add(item);
        }
    }
    if (!payload || !payload.meta || !payload.meta.sourceUrl) errors.push('meta.sourceUrl is required');
    if (!payload || !payload.definition || !payload.definition.sentence) {
        errors.push('definition.sentence is required');
    }
    return errors;
}

async function fetchRules() {
    const res = await fetch(RULES_URL, {
        headers: {'User-Agent': UA, Accept: 'text/html,*/*;q=0.8'},
        redirect: 'follow'
    });
    if (!res.ok) throw new Error(`rules fetch failed: HTTP ${res.status}`);
    return res.text();
}

async function writePayload(payload) {
    await fs.mkdir(path.dirname(OUT_FILE), {recursive: true});
    await fs.writeFile(OUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

async function main() {
    const checkOnly = process.argv.includes('--check');
    const authorizedPrefixes = deriveAuthorizedPrefixes(PREFIX_ENTRIES);

    let payload;
    if (checkOnly) {
        payload = JSON.parse(await fs.readFile(OUT_FILE, 'utf8'));
        payload.authorizedPrefixes = authorizedPrefixes;
    } else {
        const html = await fetchRules();
        const section = extractPrefixSection(htmlToText(html));
        payload = {
            meta: {
                name: 'CQ WPX prefix multiplier data',
                sourceUrl: RULES_URL,
                rulesPdf: RULES_PDF,
                fetchedAt: new Date().toISOString(),
                license: 'Facts and short excerpts from the CQ WPX Contest rules, reproduced for interoperability. CQ WPX rules © CQ Communications, Inc.',
                note: 'WPX multipliers are PREFIXES, not DXCC entities. Never merge this file with public/shared/dxcc/. Prefixes are derived from callsigns by rule V.C.1; authorizedPrefixes only validates the base letters.',
                scope: '2024 CQ World-Wide WPX Contest, rule V.C (Prefix Multipliers)',
                entryCount: authorizedPrefixes.length
            },
            definition: extractDefinition(section),
            authorizedPrefixes
        };
    }

    const errors = validatePayload(payload);
    if (errors.length) {
        console.error('[wpx] validation failed:\n - ' + errors.join('\n - '));
        process.exitCode = 1;
        return;
    }
    if (checkOnly) {
        console.log(`[wpx] OK: ${payload.authorizedPrefixes.length} authorized prefixes`);
        return;
    }
    await writePayload(payload);
    console.log(`[wpx] wrote ${path.relative(ROOT, OUT_FILE)} (${payload.authorizedPrefixes.length} prefixes, fetched ${payload.meta.fetchedAt})`);
}

main().catch(error => {
    console.error('[wpx] ' + (error && error.message ? error.message : error));
    process.exitCode = 1;
});
