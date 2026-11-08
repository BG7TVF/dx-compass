export const $ = selector => document.querySelector(selector);
export const $$ = selector => document.querySelectorAll(selector);

export function showToast(message, ms = 2500) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(element._timer);
    element._timer = setTimeout(() => element.classList.remove('show'), ms);
}

export function showConfirm(ctx, message, options = {}) {
    return new Promise(resolve => {
        const overlay = $('#modalOverlay');
        const okButton = $('#modalOk');
        const cancelButton = $('#modalCancel');
        $('#modalTitle').textContent = options.title || ctx.t('confirmTitle');
        $('#modalMsg').textContent = message;
        okButton.textContent = options.okText || ctx.t('ok');
        cancelButton.textContent = options.cancelText || ctx.t('cancel');
        okButton.classList.toggle('danger', Boolean(options.danger));
        overlay.classList.remove('hidden');
        const done = value => {
            overlay.classList.add('hidden');
            okButton.onclick = cancelButton.onclick = overlay.onclick = null;
            document.removeEventListener('keydown', onKey);
            resolve(value);
        };
        const onKey = event => {
            if (event.key === 'Escape') done(false);
            else if (event.key === 'Enter') done(true);
        };
        okButton.onclick = () => done(true);
        cancelButton.onclick = () => done(false);
        overlay.onclick = event => { if (event.target === overlay) done(false); };
        document.addEventListener('keydown', onKey);
        okButton.focus();
    });
}

export function timeAgo(ctx, value) {
    const date = value instanceof Date ? value : new Date(value);
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 30) return ctx.t('now');
    if (seconds < 90) return ctx.t('mAgo')(1);
    if (seconds < 180) return ctx.t('mAgo')(2);
    if (seconds < 300) return ctx.t('mAgo')(5);
    if (seconds < 600) return ctx.t('mAgo')(10);
    if (seconds < 1800) return ctx.t('mAgo')(30);
    if (seconds < 3600) return ctx.t('h1');
    return ctx.t('hAgo')(Math.floor(seconds / 3600));
}

export function modeBadge(mode) {
    if (!mode) return '';
    const className = mode === 'CW' ? 'mode-cw' : mode === 'DIGI' ? 'mode-digi' : 'mode-phone';
    return `<span class="${className}">${escapeHtml(mode)}</span>`;
}

export function formatTime(timestamp) {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? String(timestamp || '') :
        `${date.toISOString().replace('T', ' ').substring(0, 19)}Z`;
}

export function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function signalClass(row) {
    if (!row.signal) return '';
    const value = parseInt(row.signal.charAt(1), 10);
    if (value >= 9) return 'signal-strong';
    if (value >= 7) return 'signal-mid';
    return 'signal-weak';
}

export function snrClass(row) {
    if (row.snr === null || row.snr === undefined) return '';
    if (row.snr >= 0) return 'signal-strong';
    if (row.snr >= -10) return 'signal-mid';
    return 'signal-weak';
}
