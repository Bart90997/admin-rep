'use strict';

/**
 * ============================================================
 *  Li.Fe. Radio — Pannello Admin SENZA PHP (basato su GitHub)
 *  File: admin.html
 * ============================================================
 *
 *  Funziona su un hosting SOLO statico (nessun PHP) perche' salva i
 *  contenuti direttamente nel repository GitHub tramite la GitHub API.
 *
 *  Come funziona:
 *   1. Inserisci i dati del tuo repository GitHub + un token (PAT).
 *   2. Il pannello legge content.json e news-archive.json dal repo.
 *   3. Modifichi testi/immagini/news e premi "Salva".
 *   4. Le modifiche vengono committate su GitHub; la GitHub Action
 *      le pubblica automaticamente sul sito della scuola (via FTP)
 *      oppure le rende subito disponibili se il sito legge da GitHub.
 *
 *  Sicurezza: il token viene salvato SOLO nel tuo browser (localStorage).
 *  Usa un "fine-grained token" limitato a questo repository con permesso
 *  "Contents: Read and write".
 * ============================================================
 */

const CFG_KEY = 'liferadio_gh_cfg_v1';
let CFG = { owner: '', repo: '', branch: 'main', token: '' };
let CONTENT = null;      // content.json
let CONTENT_SHA = null;
let ARCHIVE = null;      // news-archive.json
let ARCHIVE_SHA = null;
let LIGHT = null;        // news-archive-light.json
let LIGHT_SHA = null;
let DIRTY = false;

/* ------------------------- Utility ------------------------- */

function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function b64encodeUtf8(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64decodeUtf8(b64) { return decodeURIComponent(escape(atob(String(b64).replace(/\n/g, '')))); }

function toast(msg, type) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show ' + (type || '');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.className = 'toast'; }, 3500);
}

function setDirty(v) {
    DIRTY = v;
    const b = $('#dirtyBadge');
    if (b) b.style.display = v ? 'inline-block' : 'none';
}

function loadCfg() {
    try { CFG = JSON.parse(localStorage.getItem(CFG_KEY)) || CFG; } catch (e) {}
    if (!CFG.branch) CFG.branch = 'main';
    $('#ghOwner').value = CFG.owner || '';
    $('#ghRepo').value = CFG.repo || '';
    $('#ghBranch').value = CFG.branch || 'main';
    $('#ghToken').value = CFG.token || '';
}

function saveCfg() {
    CFG = {
        owner: $('#ghOwner').value.trim(),
        repo: $('#ghRepo').value.trim(),
        branch: ($('#ghBranch').value.trim() || 'main'),
        token: $('#ghToken').value.trim()
    };
    localStorage.setItem(CFG_KEY, JSON.stringify(CFG));
}

function apiUrl(path) {
    return 'https://api.github.com/repos/' + CFG.owner + '/' + CFG.repo + '/contents/' + path;
}

/* URL pubblico (raw) di un file del repository: serve per mostrare le immagini
   nuove caricate su GitHub anche quando il server della scuola non le ha. */
function ghRaw(path) {
    if (!path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    return 'https://raw.githubusercontent.com/' + CFG.owner + '/' + CFG.repo + '/' + CFG.branch + '/' + path;
}

/* src per l'anteprima: gestisce URL assoluti e relativi + cache-busting */
function previewSrc(val) {
    if (!val) return '';
    var sep = val.indexOf('?') === -1 ? '?' : '&';
    return val + sep + 't=' + Date.now();
}

async function ghGet(path) {
    const url = apiUrl(path) + '?ref=' + encodeURIComponent(CFG.branch) + '&t=' + Date.now();
    const res = await fetch(url, {
        headers: { 'Authorization': 'token ' + CFG.token, 'Accept': 'application/vnd.github+json' }
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('GitHub GET ' + path + ' -> ' + res.status);
    const j = await res.json();
    return { text: b64decodeUtf8(j.content), sha: j.sha };
}

async function ghPut(path, base64Content, message, sha) {
    const body = {
        message: message || ('Aggiornamento ' + path),
        content: base64Content,
        branch: CFG.branch
    };
    if (sha) body.sha = sha;
    const res = await fetch(apiUrl(path), {
        method: 'PUT',
        headers: {
            'Authorization': 'token ' + CFG.token,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const t = await res.text();
        throw new Error('GitHub PUT ' + path + ' -> ' + res.status + ' ' + t.slice(0, 200));
    }
    return await res.json();
}

/* ------------------------- Caricamento dati ------------------------- */

async function connect() {
    saveCfg();
    if (!CFG.owner || !CFG.repo || !CFG.token) {
        toast('Compila owner, repo e token GitHub.', 'err');
        return;
    }
    try {
        const c = await ghGet('content.json');
        if (!c) { toast('content.json non trovato nel repository.', 'err'); return; }
        CONTENT = JSON.parse(c.text); CONTENT_SHA = c.sha;

        const a = await ghGet('news-archive.json');
        if (a) { ARCHIVE = JSON.parse(a.text); ARCHIVE_SHA = a.sha; }
        const l = await ghGet('news-archive-light.json');
        if (l) { LIGHT = JSON.parse(l.text); LIGHT_SHA = l.sha; }

        $('#connState').textContent = 'Connesso a ' + CFG.owner + '/' + CFG.repo;
        $('#connState').className = 'conn ok';
        renderAll();
        toast('Contenuti caricati da GitHub.', 'ok');
        setDirty(false);
    } catch (e) {
        console.error(e);
        toast('Errore: ' + e.message, 'err');
        $('#connState').textContent = 'Errore di connessione';
        $('#connState').className = 'conn err';
    }
}

/* ------------------------- Rendering ------------------------- */

const GROUP_LABELS = {
    speaker: 'Speaker / Conduttori', program: 'Programmi', pal: 'Palinsesto',
    ig: 'Instagram / Gallery', rv: 'Rivedi (RI-LIVE)', teamop: 'Team — Operatori',
    teamfam: 'Team — Famiglia', nlh: 'Newsletter', rank: 'Classifiche',
    hero: 'Home — Slider (hero)', news: 'Home — Griglia news'
};

function groupOf(key) {
    const m = key.match(/^([a-zA-Z]+)/);
    return m ? m[1] : 'altro';
}

function humanLabel(key) {
    return key.replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function renderAll() {
    renderFields();
    renderImages();
    renderFeatured();
    renderArchive();
}

function renderFields() {
    const wrap = $('#fieldsWrap');
    wrap.innerHTML = '';
    if (!CONTENT || !CONTENT.fields) return;
    const groups = {};
    Object.keys(CONTENT.fields).forEach(function (k) {
        const g = groupOf(k);
        (groups[g] = groups[g] || []).push(k);
    });
    Object.keys(groups).forEach(function (g) {
        const sec = document.createElement('div');
        sec.className = 'group';
        const h = document.createElement('h3');
        h.textContent = GROUP_LABELS[g] || ('Gruppo: ' + g);
        sec.appendChild(h);
        groups[g].sort().forEach(function (k) {
            const val = CONTENT.fields[k] || '';
            const row = document.createElement('div');
            row.className = 'row';
            const lab = document.createElement('label');
            lab.textContent = humanLabel(k);
            const isLong = /(full|desc|text|testo|note|bio)/i.test(k) || String(val).length > 80;
            const inp = document.createElement(isLong ? 'textarea' : 'input');
            if (isLong) inp.rows = 3; else inp.type = 'text';
            inp.value = val;
            inp.dataset.key = k;
            inp.addEventListener('input', function () {
                CONTENT.fields[k] = inp.value; setDirty(true);
            });
            row.appendChild(lab);
            row.appendChild(inp);
            sec.appendChild(row);
        });
        wrap.appendChild(sec);
    });
}

function renderImages() {
    const wrap = $('#imagesWrap');
    wrap.innerHTML = '';
    if (!CONTENT || !CONTENT.images) return;
    Object.keys(CONTENT.images).sort().forEach(function (k) {
        const val = CONTENT.images[k] || '';
        const card = document.createElement('div');
        card.className = 'imgcard';
        /* Anteprima: se il file e' relativo (uploads/...) e non esiste sul
           server, ripieghiamo sull'URL GitHub del repository. */
        const isRel = val && !/^https?:\/\//i.test(val);
        const preview = val
            ? '<img src="' + previewSrc(val) + '" alt=""' +
              (isRel ? ' data-raw="' + ghRaw(val) + '"' : '') +
              ' onerror="if(this.dataset.raw&&this.getAttribute(\'src\')!==this.dataset.raw){this.src=this.dataset.raw;}">'
            : '<div class="noimg">nessuna</div>';
        card.innerHTML = preview +
            '<div class="imginfo"><b>' + humanLabel(k) + '</b><span>' + (val || '—') + '</span></div>' +
            '<input type="file" accept="image/*" data-imgkey="' + k + '">';
        wrap.appendChild(card);
    });
    $$('input[type=file][data-imgkey]', wrap).forEach(function (f) {
        f.addEventListener('change', function () { uploadImage(f); });
    });
}

async function uploadImage(fileInput) {
    const key = fileInput.dataset.imgkey;
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (!CFG.token) { toast('Serve il token GitHub.', 'err'); return; }
    try {
        const b64 = await new Promise(function (res, rej) {
            const r = new FileReader();
            r.onload = function () { res(String(r.result).split(',')[1]); };
            r.onerror = rej; r.readAsDataURL(file);
        });
        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
        const name = 'uploads/' + key + '-' + Math.floor(Date.now() / 1000) + '.' + ext;
        await ghPut(name, b64, 'Admin: carica immagine ' + name, null);
        /* Salviamo l'URL ASSOLUTO su GitHub: cosi' l'immagine si vede
           anche se il server della scuola non ha il file in uploads/. */
        CONTENT.images[key] = ghRaw(name);
        setDirty(true);
        renderImages();
        toast('Immagine caricata su GitHub. Ricordati di salvare.', 'ok');
    } catch (e) {
        console.error(e);
        toast('Errore upload: ' + e.message, 'err');
    }
}

function renderFeatured() {
    const wrap = $('#featuredWrap');
    wrap.innerHTML = '';
    if (!CONTENT) return;
    ['hero', 'news'].forEach(function (type) {
        const box = document.createElement('div');
        box.className = 'group';
        const h = document.createElement('h3');
        h.textContent = type === 'hero' ? 'Home — Slider (hero1-3)' : 'Home — Griglia (news1-3)';
        box.appendChild(h);
        for (let i = 1; i <= 3; i++) {
            const title = (CONTENT.fields[type + i + '-title'] || '');
            const link = (CONTENT.fields[type + i + '-link'] || '');
            const row = document.createElement('div');
            row.className = 'slot';
            row.innerHTML = '<b>' + type + i + '</b> ' +
                (title ? '<span class="slot-title">' + title + '</span>' : '<span class="slot-empty">(vuoto)</span>') +
                '<button class="btn small danger" data-unfeature="' + type + ':' + i + '">Svuota</button>';
            box.appendChild(row);
        }
        wrap.appendChild(box);
    });
    $$('button[data-unfeature]', wrap).forEach(function (b) {
        b.addEventListener('click', function () {
            const parts = b.dataset.unfeature.split(':');
            unfeature(parts[0], parseInt(parts[1], 10));
        });
    });
}

function unfeature(type, i) {
    ['title', 'tag', 'desc', 'date', 'link', 'full'].forEach(function (f) {
        delete CONTENT.fields[type + i + '-' + f];
    });
    delete CONTENT.images[type + i + '-img'];
    setDirty(true);
    renderFeatured();
    toast('Slot ' + type + i + ' liberato. Salva per applicare.', 'ok');
}

function renderArchive() {
    const wrap = $('#archiveWrap');
    wrap.innerHTML = '';
    if (!ARCHIVE || !ARCHIVE.news) { wrap.innerHTML = '<p>Archivio non caricato.</p>'; return; }
    const search = ($('#archiveSearch') && $('#archiveSearch').value || '').toLowerCase();
    const list = ARCHIVE.news.filter(function (n) {
        return !search || (n.title || '').toLowerCase().indexOf(search) !== -1;
    });
    const info = document.createElement('div');
    info.className = 'archive-info';
    info.textContent = list.length + ' notizie' + (search ? ' (filtrate)' : '') + ' su ' + ARCHIVE.news.length;
    wrap.appendChild(info);
    list.slice(0, 200).forEach(function (n) {
        const row = document.createElement('div');
        row.className = 'newsrow';
        row.innerHTML =
            '<div class="nt"><b>' + (n.tag || '') + '</b> ' + (n.title || '') + '</div>' +
            '<div class="na">' +
                '<button class="btn small" data-feat="hero:' + n.id + '">Hero</button>' +
                '<button class="btn small" data-feat="news:' + n.id + '">News</button>' +
                '<a class="btn small ghost" href="articolo.html?id=' + encodeURIComponent(n.id) + '" target="_blank">Apri</a>' +
                '<button class="btn small danger" data-del="' + n.id + '">Elimina</button>' +
            '</div>';
        wrap.appendChild(row);
    });
    $$('button[data-feat]', wrap).forEach(function (b) {
        b.addEventListener('click', function () {
            const p = b.dataset.feat.split(':');
            feature(p[0], p[1]);
        });
    });
    $$('button[data-del]', wrap).forEach(function (b) {
        b.addEventListener('click', function () { deleteNews(b.dataset.del); });
    });
}

function feature(type, id) {
    const n = (ARCHIVE.news || []).find(function (x) { return x.id === id; });
    if (!n) { toast('Notizia non trovata.', 'err'); return; }
    // gia' presente?
    for (let i = 1; i <= 3; i++) {
        if ((CONTENT.fields[type + i + '-link'] || '').indexOf('id=' + id) !== -1) {
            toast('Gia presente in ' + type + i + '.', 'ok'); return;
        }
    }
    let slot = 0;
    for (let i = 1; i <= 3; i++) { if (!CONTENT.fields[type + i + '-title']) { slot = i; break; } }
    if (!slot) slot = 3;
    CONTENT.fields[type + slot + '-title'] = (n.title || '').slice(0, 120);
    CONTENT.fields[type + slot + '-tag'] = n.tag || (type === 'hero' ? 'IN EVIDENZA' : 'NEWS');
    CONTENT.fields[type + slot + '-desc'] = (n.desc || '').slice(0, type === 'hero' ? 200 : 300);
    if (type === 'news') CONTENT.fields[type + slot + '-date'] = n.dateFull || n.date || '';
    CONTENT.fields[type + slot + '-link'] = 'articolo.html?id=' + id;
    if (n.img) CONTENT.images[type + slot + '-img'] = n.img;
    setDirty(true);
    renderFeatured();
    toast('Notizia messa in ' + type + slot + '. Salva per applicare.', 'ok');
}

function deleteNews(id) {
    if (!confirm('Eliminare questa notizia dall\'archivio?')) return;
    ARCHIVE.news = ARCHIVE.news.filter(function (n) { return n.id !== id; });
    // rimuovi riferimenti hero/news
    ['hero', 'news'].forEach(function (type) {
        for (let i = 1; i <= 3; i++) {
            if ((CONTENT.fields[type + i + '-link'] || '').indexOf('id=' + id) !== -1) {
                ['title', 'tag', 'desc', 'date', 'link', 'full'].forEach(function (f) { delete CONTENT.fields[type + i + '-' + f]; });
                delete CONTENT.images[type + i + '-img'];
            }
        }
    });
    // rigenera la versione leggera
    LIGHT = buildLight(ARCHIVE);
    setDirty(true);
    renderFeatured();
    renderArchive();
    toast('Notizia rimossa. Salva per applicare.', 'ok');
}

function buildLight(archive) {
    return {
        updatedAt: new Date().toISOString(),
        count: archive.news.length,
        news: archive.news.map(function (n) {
            return {
                id: n.id || '', source: n.source || 'allmusicitalia', title: n.title || '',
                tag: n.tag || 'MUSICA', date: n.date || '', dateFull: n.dateFull || '',
                iso: n.iso || '', desc: n.desc || '', img: n.img || ''
            };
        })
    };
}

/* ------------------------- Salvataggio ------------------------- */

async function saveAll() {
    if (!CONTENT) { toast('Nessun contenuto caricato.', 'err'); return; }
    if (!CFG.token) { toast('Serve il token GitHub.', 'err'); return; }
    try {
        CONTENT.updatedAt = new Date().toISOString();
        const r1 = await ghPut('content.json', b64encodeUtf8(JSON.stringify(CONTENT, null, 2)),
            'Admin: aggiorna contenuti del sito', CONTENT_SHA);
        CONTENT_SHA = r1.content.sha;

        if (ARCHIVE) {
            ARCHIVE.updatedAt = new Date().toISOString();
            const r2 = await ghPut('news-archive.json', b64encodeUtf8(JSON.stringify(ARCHIVE, null, 2)),
                'Admin: aggiorna archivio notizie', ARCHIVE_SHA);
            ARCHIVE_SHA = r2.content.sha;
            if (!LIGHT) LIGHT = buildLight(ARCHIVE);
            LIGHT.updatedAt = ARCHIVE.updatedAt; LIGHT.count = ARCHIVE.news.length;
            const r3 = await ghPut('news-archive-light.json', b64encodeUtf8(JSON.stringify(LIGHT, null, 2)),
                'Admin: aggiorna elenco notizie (light)', LIGHT_SHA);
            LIGHT_SHA = r3.content.sha;
        }
        setDirty(false);
        toast('Salvato su GitHub! Il sito si aggiornera automaticamente.', 'ok');
    } catch (e) {
        console.error(e);
        toast('Errore salvataggio: ' + e.message, 'err');
    }
}

/* ------------------------- Tabs & init ------------------------- */

function initTabs() {
    $$('.tab').forEach(function (t) {
        t.addEventListener('click', function () {
            $$('.tab').forEach(function (x) { x.classList.remove('active'); });
            $$('.tabpane').forEach(function (x) { x.classList.remove('active'); });
            t.classList.add('active');
            const pane = $('#pane-' + t.dataset.pane);
            if (pane) pane.classList.add('active');
        });
    });
}

window.addEventListener('beforeunload', function (e) {
    if (DIRTY) { e.preventDefault(); e.returnValue = ''; }
});

document.addEventListener('DOMContentLoaded', function () {
    loadCfg();
    initTabs();
    $('#btnConnect').addEventListener('click', connect);
    $('#btnSave').addEventListener('click', saveAll);
    $('#btnReload').addEventListener('click', connect);
    const s = $('#archiveSearch');
    if (s) s.addEventListener('input', renderArchive);
});
