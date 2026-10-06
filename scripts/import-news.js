#!/usr/bin/env node
'use strict';

/**
 * ============================================================
 *  Li.Fe. Radio — Import automatico notizie da All Music Italia
 *  File: scripts/import-news.js
 *  Esecuzione: GitHub Actions (Node.js) — NESSUN PHP richiesto.
 * ============================================================
 *
 *  Cosa fa:
 *   1. Scarica le ultime notizie da https://www.allmusicitalia.it/news
 *      usando l'API REST WordPress (piu' affidabile del parsing HTML).
 *   2. Aggiunge all'archivio (news-archive.json) SOLO le notizie nuove
 *      (dedup per id), con titolo, tag, data, autore, testo completo e
 *      immagine scaricata in uploads/.
 *   3. Rigenera news-archive-light.json (versione leggera per liste/home).
 *   4. Pulizia: elimina le notizie piu' vecchie di N giorni (default 30),
 *      le immagini orfane e ripulisce i collegamenti hero/news in content.json.
 *
 *  Variabili d'ambiente (opzionali):
 *   MAX_NEW        notizie nuove massime per run (default 8)
 *   CLEANUP_DAYS   retention in giorni (default 30; 0 = disattiva pulizia)
 *   DRY            "1" = solo report, nessuna scrittura su disco
 * ============================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const ARCHIVE_FILE = path.join(ROOT, 'news-archive.json');
const LIGHT_FILE = path.join(ROOT, 'news-archive-light.json');
const CONTENT_FILE = path.join(ROOT, 'content.json');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const LOG_FILE = path.join(ROOT, 'import-log.txt');

const API = 'https://www.allmusicitalia.it/wp-json/wp/v2';
const MAX_NEW = parseInt(process.env.MAX_NEW || '8', 10);
const CLEANUP_DAYS = process.env.CLEANUP_DAYS === undefined ? 30 : parseInt(process.env.CLEANUP_DAYS, 10);
const DRY = process.env.DRY === '1';
const HEAL_MAX = parseInt(process.env.HEAL_MAX || '200', 10); // max immagini mancanti da ripristinare per run
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const steps = [];
function log(line) { steps.push(line); console.log(line); }

/* ============================ JSON I/O ============================ */

function readJson(file, fallback) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const data = JSON.parse(raw);
        return data == null ? fallback : data;
    } catch (e) {
        return fallback;
    }
}

function writeJson(file, obj) {
    const json = JSON.stringify(obj, null, 2);
    fs.writeFileSync(file, json, 'utf8');
}

function loadArchive() {
    const data = readJson(ARCHIVE_FILE, null);
    if (!data || !Array.isArray(data.news)) return { news: [] };
    return data;
}

/* ============================ TESTUALI ============================ */

function decodeEntities(s) {
    const named = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '\u2026',
        mdash: '\u2014', ndash: '\u2013', rsquo: '\u2019', lsquo: '\u2018',
        rdquo: '\u201d', ldquo: '\u201c', eacute: '\u00e9', egrave: '\u00e8',
        agrave: '\u00e0', ograve: '\u00f2', ugrave: '\u00f9', igrave: '\u00ec',
        times: '\u00d7', laquo: '\u00ab', raquo: '\u00bb', deg: '\u00b0',
        euro: '\u20ac', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
        bull: '\u2022', middot: '\u00b7', '8217': '\u2019'
    };
    return String(s || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (full, ent) {
        if (ent[0] === '#') {
            let code;
            if (ent[1] === 'x' || ent[1] === 'X') code = parseInt(ent.slice(2), 16);
            else code = parseInt(ent.slice(1), 10);
            return isNaN(code) ? full : String.fromCodePoint(code);
        }
        return Object.prototype.hasOwnProperty.call(named, ent) ? named[ent] : full;
    });
}

function cleanText(s) {
    if (!s) return '';
    s = String(s).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    s = s.replace(/<[^>]+>/g, '');
    s = decodeEntities(s);
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

/**
 * Converte l'HTML dell'articolo nel formato "full" usato dal sito:
 *   <h2>/<h3>   -> "## Titolo"
 *   <blockquote>-> "> citazione"
 *   <li>        -> "• voce"
 *   <p>         -> paragrafo normale
 */
function htmlToFull(html) {
    if (!html) return '';
    html = String(html)
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '');

    // Range dei blockquote (per non duplicare i <p> interni)
    const bqRanges = [];
    const bqRe = /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi;
    let bm;
    while ((bm = bqRe.exec(html)) !== null) {
        bqRanges.push([bm.index, bm.index + bm[0].length]);
    }

    const lines = [];
    const re = /<(p|h2|h3|blockquote|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const tag = m[1].toLowerCase();
        const offset = m.index;
        const text = cleanText(m[2]);
        if (!text || text.length < 4) continue;
        if (/^(Share|Condividi|Tags?|Leggi anche)/i.test(text)) continue;

        const insideBq = bqRanges.some(function (r) { return offset > r[0] && offset < r[1]; });
        if (insideBq && tag !== 'blockquote') continue;

        if (tag === 'h2' || tag === 'h3') lines.push('## ' + text);
        else if (tag === 'blockquote') lines.push('> ' + text);
        else if (tag === 'li') lines.push('\u2022 ' + text);
        else lines.push(text);
    }
    return lines.join('\n\n');
}

/** Tag editoriale in stile Li.Fe. Radio, derivato dal titolo/categoria. */
function deriveTag(title, category) {
    const t = String(title || '').toLowerCase();
    const c = String(category || '').trim().toLowerCase();
    if (c && c !== 'news' && c !== 'ultime notizie') return String(category).toUpperCase().slice(0, 24);

    if (t.indexOf('sanremo') !== -1) return 'SANREMO';
    if (t.indexOf('eurovision') !== -1) return 'EUROVISION';
    if (t.indexOf('x factor') !== -1) return 'X FACTOR';
    if (t.indexOf('amici') !== -1 && t.indexOf('amici di') === -1) return 'AMICI';
    if (t.indexOf('classifica') !== -1 || t.indexOf('top 10') !== -1 || t.indexOf('fimi') !== -1) return 'CLASSIFICHE';
    if (t.indexOf('vinile') !== -1 || t.indexOf('ristampa') !== -1) return 'RISTAMPE';
    if (t.indexOf('album') !== -1 || t.indexOf('disco nuovo') !== -1) return 'NUOVO ALBUM';
    if (t.indexOf('singolo') !== -1 || t.indexOf('brano') !== -1 || t.indexOf('canzone') !== -1) return 'NUOVO SINGOLO';
    if (t.indexOf('tour') !== -1 || t.indexOf('concerto') !== -1 || t.indexOf('live') !== -1 ||
        t.indexOf('festival') !== -1 || t.indexOf('palco') !== -1) return 'LIVE & TOUR';
    if (t.indexOf('intervista') !== -1) return 'INTERVISTA';
    if (t.indexOf('video') !== -1) return 'VIDEO';
    return 'MUSICA';
}

const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

/** "2026-09-27T05:03:50" -> "27 set" (senza dipendere dal fuso del runner). */
function dateShort(localIso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(localIso || ''));
    if (!m) return '';
    const d = parseInt(m[3], 10);
    const mo = parseInt(m[2], 10);
    if (mo < 1 || mo > 12) return '';
    return String(d).padStart(2, '0') + ' ' + MESI[mo - 1];
}

/** Offset di Europe/Rome per un dato istante UTC, es. "+02:00" o "+01:00". */
function romeOffset(utcDate) {
    try {
        const dtf = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', timeZoneName: 'longOffset' });
        const parts = dtf.formatToParts(utcDate);
        const tz = parts.find(function (p) { return p.type === 'timeZoneName'; });
        if (tz) return tz.value.replace('GMT', '') || '+00:00';
    } catch (e) { /* fallback sotto */ }
    return '+01:00';
}

/* ============================ HTTP / IMMAGINI ============================ */

async function httpGet(url, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(function () { ctrl.abort(); }, timeoutMs || 25000);
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': UA,
                'Accept': 'text/html,application/json,*/*;q=0.8',
                'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8'
            },
            signal: ctrl.signal,
            redirect: 'follow'
        });
        if (!res.ok) return null;
        return res;
    } catch (e) {
        return null;
    } finally {
        clearTimeout(t);
    }
}

async function downloadImage(url, nameBase) {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const res = await httpGet(url, 30000);
    if (!res) return null;
    let buf;
    try { buf = Buffer.from(await res.arrayBuffer()); } catch (e) { return null; }
    if (!buf || buf.length < 800) return null;

    let ext = 'jpg';
    if (/\.png$/i.test(url)) ext = 'png';
    else if (/\.webp$/i.test(url)) ext = 'webp';
    else if (/\.gif$/i.test(url)) ext = 'gif';

    const filename = String(nameBase).replace(/[^a-z0-9._-]/gi, '') + '.' + ext;
    if (DRY) return 'uploads/' + filename;
    try { fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf); } catch (e) { return null; }
    return 'uploads/' + filename;
}

/* ==================== RIPRISTINO IMMAGINI MANCANTI ==================== */
/* Alcune notizie (importate prima dell'attivazione di GitHub Actions, o con
   download fallito) puntano a uploads/... ma il file non e' mai stato
   committato: sul sito l'immagine non si carica. Ad ogni run ricontrolliamo
   tutte le notizie e riscarichiamo le immagini mancanti dall'articolo
   originale (immagine in evidenza via API, oppure meta og:image). */

function slugFromArticleUrl(u) {
    const m = String(u || '').match(/\/news\/([^\/?#]+)\.html/);
    return m ? m[1] : null;
}

async function featuredFromApi(slug) {
    const res = await httpGet(API + '/posts?slug=' + encodeURIComponent(slug) + '&_embed', 25000);
    if (!res) return null;
    try {
        const d = await res.json();
        const fm = d && d[0] && d[0]._embedded && d[0]._embedded['wp:featuredmedia'] && d[0]._embedded['wp:featuredmedia'][0];
        return (fm && fm.source_url) ? fm.source_url : null;
    } catch (e) { return null; }
}

async function ogFromHtml(url) {
    if (!url) return null;
    const res = await httpGet(url, 25000);
    if (!res) return null;
    try {
        const html = await res.text();
        const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
               || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
        return m ? m[1] : null;
    } catch (e) { return null; }
}

async function downloadToExact(url, relPath) {
    const res = await httpGet(url, 40000);
    if (!res) return false;
    let buf;
    try { buf = Buffer.from(await res.arrayBuffer()); } catch (e) { return false; }
    if (!buf || buf.length < 800) return false;
    const abs = path.join(ROOT, relPath);
    const dir = path.dirname(abs);
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    try { fs.writeFileSync(abs, buf); return true; } catch (e) { return false; }
}

async function healMissingImages(archive, maxPerRun) {
    if (!archive || !Array.isArray(archive.news) || !archive.news.length) return 0;
    const missing = [];
    for (const n of archive.news) {
        const img = n.img || '';
        if (img.indexOf('uploads/') !== 0) continue;
        if (fs.existsSync(path.join(ROOT, img))) continue;
        missing.push(n);
    }
    if (!missing.length) { log('Immagini: tutte presenti, nulla da ripristinare.'); return 0; }
    const limit = Math.min(missing.length, maxPerRun > 0 ? maxPerRun : missing.length);
    log('Immagini: ' + missing.length + ' mancanti in uploads/ \u2014 ne ripristino fino a ' + limit + ' adesso...');
    let healed = 0;
    for (let i = 0; i < limit; i++) {
        const n = missing[i];
        const img = n.img;
        let src = null;
        const slug = slugFromArticleUrl(n.url);
        if (slug) src = await featuredFromApi(slug);
        if (!src) src = await ogFromHtml(n.url);
        if (!src) { log('  [' + (i + 1) + '/' + limit + '] NON TROVATA: ' + img); continue; }
        const ok = await downloadToExact(src, img);
        if (ok) { healed++; log('  [' + (i + 1) + '/' + limit + '] ripristinata ' + img); }
        else { log('  [' + (i + 1) + '/' + limit + '] download fallito: ' + img); }
        await new Promise(function (r) { setTimeout(r, 200); });
    }
    log('Immagini: ripristinate ' + healed + ' su ' + limit + ' (mancavano ' + missing.length + ').');
    return healed;
}

/* ============================ API WORDPRESS ============================ */

async function fetchLatestPosts(perPage) {
    const url = API + '/posts?per_page=' + (perPage || 20) + '&_embed=wp:featuredmedia,wp:term,author';
    const res = await httpGet(url, 30000);
    if (!res) return null;
    try { return await res.json(); } catch (e) { return null; }
}

function postToCandidate(post) {
    const slug = post.slug || '';
    if (!slug) return null;
    const title = cleanText(post.title && post.title.rendered);
    if (!title || title.length < 6) return null;

    const full = htmlToFull(post.content && post.content.rendered);
    const excerpt = cleanText(post.excerpt && post.excerpt.rendered);

    // Categoria + autore + immagine in evidenza dai dati "_embedded"
    let category = '';
    let author = '';
    let img = '';
    const emb = post._embedded || {};
    if (Array.isArray(emb['wp:term'])) {
        for (const group of emb['wp:term']) {
            for (const term of group) {
                if (term && term.taxonomy === 'category' && !category) category = term.name || '';
            }
        }
    }
    if (Array.isArray(emb.author) && emb.author[0]) author = emb.author[0].name || '';
    if (Array.isArray(emb['wp:featuredmedia']) && emb['wp:featuredmedia'][0]) {
        const fm = emb['wp:featuredmedia'][0];
        img = fm.source_url || '';
    }

    // Data: post.date e' gia' in ora italiana; date_gmt e' UTC
    const localIso = post.date || '';
    let iso = localIso;
    if (post.date_gmt) {
        const instant = new Date(post.date_gmt + 'Z');
        if (!isNaN(instant.getTime())) iso = localIso + romeOffset(instant);
    }
    const dateFull = cleanText(post.title && post.title.rendered) && formatDateFull(localIso);

    // Anteprima = primo paragrafo del testo (come sul sito attuale)
    let desc = '';
    if (full) {
        let first = full.split(/\n\s*\n/)[0] || full;
        first = first.replace(/^(##\s+|>\s+|\u2022\s+)/, '').trim();
        if (first.length > 200) {
            let cut = first.slice(0, 200);
            const sp = cut.lastIndexOf(' ');
            if (sp > 120) cut = cut.slice(0, sp);
            first = cut.replace(/\s+$/, '') + '\u2026';
        }
        desc = first;
    } else if (excerpt) {
        desc = excerpt.slice(0, 300);
    }

    return {
        id: 'ami-' + slug,
        slug: slug,
        url: post.link || ('https://www.allmusicitalia.it/news/' + slug + '.html'),
        img: img,
        title: title,
        desc: desc,
        category: category,
        date: dateShort(localIso),
        dateFull: dateFull,
        iso: iso,
        author: author || 'All Music Italia',
        full: full
    };
}

function formatDateFull(localIso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(localIso || ''));
    if (!m) return '';
    const mesi = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
    const d = parseInt(m[3], 10);
    const mo = parseInt(m[2], 10);
    if (mo < 1 || mo > 12) return '';
    return d + ' ' + mesi[mo - 1] + ' ' + m[1];
}

/* ============================ ARCHIVIO ============================ */

function sortArchive(archive) {
    archive.news.sort(function (a, b) {
        const ta = Date.parse(a.iso || a.importedAt || 0) || 0;
        const tb = Date.parse(b.iso || b.importedAt || 0) || 0;
        return tb - ta; // piu' recenti prima
    });
}

function saveArchive(archive) {
    sortArchive(archive);
    archive.updatedAt = new Date().toISOString();
    if (DRY) return true;
    writeJson(ARCHIVE_FILE, archive);
    return saveLightArchive(archive);
}

function saveLightArchive(archive) {
    const light = {
        updatedAt: archive.updatedAt || new Date().toISOString(),
        count: archive.news.length,
        news: archive.news.map(function (n) {
            return {
                id: n.id || '',
                source: n.source || 'allmusicitalia',
                title: n.title || '',
                tag: n.tag || 'MUSICA',
                date: n.date || '',
                dateFull: n.dateFull || '',
                iso: n.iso || '',
                desc: n.desc || '',
                img: n.img || ''
            };
        })
    };
    if (DRY) return true;
    writeJson(LIGHT_FILE, light);
    return true;
}

/* ============================ IMPORT ============================ */

async function runImport() {
    const archive = loadArchive();
    archive.migratedRadioItalia = 1;

    const posts = await fetchLatestPosts(20);
    if (!posts || !Array.isArray(posts)) {
        log('ERRORE: impossibile leggere le notizie da All Music Italia (API non raggiungibile). Archivio lasciato invariato.');
        return { imported: 0, total: archive.news.length };
    }
    log('Lette ' + posts.length + ' notizie recenti dall\'API di All Music Italia.');

    const existing = {};
    archive.news.forEach(function (n) { existing[n.id] = true; });

    const candidates = [];
    for (const post of posts) {
        const c = postToCandidate(post);
        if (!c) continue;
        if (existing[c.id]) continue;
        candidates.push(c);
        if (candidates.length >= MAX_NEW) break;
    }

    let imported = 0;
    if (candidates.length === 0) {
        log('Nessuna notizia nuova: l\'archivio e\' gia\' aggiornato.');
    } else {
        log(candidates.length + ' notizie nuove da importare, recupero immagini...');
        let i = 0;
        for (const c of candidates) {
            i++;
            const hash = crypto.createHash('md5').update(c.slug).digest('hex').slice(0, 10);
            const nameBase = 'allmusicitalia-' + hash + '-' + Math.floor(Date.now() / 1000) + '-' + i;
            let local = null;
            if (c.img) local = await downloadImage(c.img, nameBase);
            const finalImg = local || c.img;
            archive.news.push({
                id: c.id,
                source: 'allmusicitalia',
                title: c.title,
                tag: deriveTag(c.title, c.category),
                date: c.date || dateShort(new Date().toISOString().slice(0, 10)),
                dateFull: c.dateFull || '',
                iso: c.iso || new Date().toISOString(),
                author: c.author || '',
                desc: (c.desc || '').slice(0, 300),
                full: c.full || c.desc || '',
                url: c.url,
                img: finalImg,
                importedAt: new Date().toISOString()
            });
            imported++;
            log('  [' + i + '] ' + (local ? 'immagine salvata in locale' : 'AVVISO: immagine non scaricata, uso quella esterna') + ' \u2014 ' + c.title.slice(0, 60));
            await new Promise(function (r) { setTimeout(r, 300); });
        }
        log('Aggiunte ' + imported + ' notizie nuove all\'archivio cumulativo.');
    }

    if (saveArchive(archive)) {
        log('Archivio salvato: ' + archive.news.length + ' notizie totali (news-archive.json + news-archive-light.json).');
    } else {
        log('ERRORE: impossibile salvare news-archive.json.');
    }

    // Ripristina eventuali immagini mancanti in uploads/ (self-healing)
    await healMissingImages(archive, HEAL_MAX);

    if (CLEANUP_DAYS > 0) {
        runCleanup(archive, CLEANUP_DAYS);
    }

    return { imported: imported, total: archive.news.length };
}

/* ============================ PULIZIA ============================ */

function runCleanup(archive, days) {
    if (!archive.news.length) {
        log('Pulizia: archivio vuoto, nulla da fare.');
        return;
    }
    const cutoff = Date.now() - days * 86400000;
    const keep = [];
    const removed = [];
    for (const n of archive.news) {
        const ts = Date.parse(n.iso || n.importedAt || 0) || 0;
        if (ts && ts < cutoff) removed.push(n);
        else keep.push(n);
    }
    if (!removed.length) {
        log('Pulizia: nessuna notizia piu\' vecchia di ' + days + ' giorni. Archivio: ' + keep.length + ' notizie.');
        return;
    }
    log('Pulizia: ' + removed.length + ' notizie piu\' vecchie di ' + days + ' giorni.');
    archive.news = keep;
    saveArchive(archive);

    const deadIds = removed.map(function (r) { return r.id; });
    const refs = removeDeadReferences(deadIds);
    if (refs > 0) log('Rimossi ' + refs + ' collegamenti hero/news che puntavano a notizie eliminate.');

    let imgDeleted = 0;
    const seen = {};
    for (const r of removed) {
        if (!r.img || seen[r.img]) continue;
        seen[r.img] = true;
        if (removeOrphanImage(r.img, archive)) imgDeleted++;
    }
    if (imgDeleted > 0) log('Cancellate ' + imgDeleted + ' immagini obsolete da uploads/.');
}

function removeDeadReferences(deadIds) {
    if (!deadIds.length) return 0;
    const content = readJson(CONTENT_FILE, null);
    if (!content || !content.fields) return 0;
    const fields = content.fields;
    const images = (content.images && typeof content.images === 'object') ? content.images : {};
    let removed = 0;
    const orphanCandidates = [];

    ['hero', 'news'].forEach(function (type) {
        for (let i = 1; i <= 3; i++) {
            const lk = type + i + '-link';
            if (!fields[lk]) continue;
            const link = fields[lk];
            const hit = deadIds.some(function (id) { return link.indexOf('id=' + id) !== -1; });
            if (!hit) continue;
            ['title', 'tag', 'desc', 'date', 'link', 'full'].forEach(function (f) { delete fields[type + i + '-' + f]; });
            const ik = type + i + '-img';
            if (images[ik]) { orphanCandidates.push(images[ik]); delete images[ik]; }
            removed++;
        }
    });

    if (removed > 0 && !DRY) {
        content.images = images;
        content.updatedAt = new Date().toISOString();
        writeJson(CONTENT_FILE, content);
        orphanCandidates.forEach(function (img) { removeOrphanImage(img, loadArchive()); });
    }
    return removed;
}

function removeOrphanImage(relPath, archiveAfter) {
    if (!relPath || relPath.indexOf('uploads/') !== 0) return false;
    const file = path.join(ROOT, relPath);
    if (!fs.existsSync(file)) return false;
    const arch = archiveAfter || loadArchive();
    if (arch.news.some(function (n) { return n.img === relPath; })) return false;
    const content = readJson(CONTENT_FILE, null);
    if (content) {
        for (const section of ['fields', 'images']) {
            const obj = content[section];
            if (!obj || typeof obj !== 'object') continue;
            for (const k of Object.keys(obj)) {
                if (typeof obj[k] === 'string' && obj[k] === relPath) return false;
            }
        }
    }
    if (DRY) return true;
    try { fs.unlinkSync(file); return true; } catch (e) { return false; }
}

/* ============================ LOG ============================ */

function appendLog(line) {
    if (DRY) return;
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    try { fs.appendFileSync(LOG_FILE, '[' + stamp + '] ' + line + '\n', 'utf8'); } catch (e) { /* ignore */ }
    try {
        const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
        if (lines.length > 60) fs.writeFileSync(LOG_FILE, lines.slice(-60).join('\n') + '\n', 'utf8');
    } catch (e) { /* ignore */ }
}

/* ============================ MAIN ============================ */

(async function main() {
    log('=== Li.Fe. Radio \u2014 Import notizie da All Music Italia ===');
    log('Data esecuzione: ' + new Date().toISOString() + (DRY ? '  [DRY-RUN]' : ''));
    const report = await runImport();
    log('=== RIEPILOGO ===');
    log('Notizie nuove importate : ' + report.imported);
    log('Notizie totali in archivio: ' + report.total);
    log('Stato: OK');
    appendLog('IMPORT ok \u2014 nuove: ' + report.imported + ', totali: ' + report.total);
})().catch(function (e) {
    console.error('ERRORE IMPREVISTO:', e);
    process.exit(1);
});
