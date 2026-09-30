'use strict';

/**
 * ============================================================
 *  Li.Fe. Radio — Pannello Admin INTUITIVO (senza PHP, senza FTP)
 *  File: admin.html
 * ============================================================
 *
 *  Salva i contenuti direttamente nel repository GitHub tramite la
 *  GitHub API. Pensato per chi NON conosce il codice: ogni campo ha
 *  un'etichetta in italiano chiaro e le sezioni seguono le aree del sito.
 *
 *  Sicurezza: il token resta SOLO nel tuo browser (localStorage).
 *  Usa un "fine-grained token" limitato a questo repository con permesso
 *  "Contents: Read and write".
 * ============================================================
 */

const CFG_KEY = 'liferadio_gh_cfg_v1';
const DEFAULT_OWNER = 'Bart90997';
const DEFAULT_REPO = 'admin-rep';
const DEFAULT_BRANCH = 'main';

let CFG = { owner: '', repo: '', branch: DEFAULT_BRANCH, token: '' };
let CONTENT = null;      // content.json
let CONTENT_SHA = null;
let ARCHIVE = null;      // news-archive.json
let ARCHIVE_SHA = null;
let LIGHT = null;        // news-archive-light.json
let LIGHT_SHA = null;
let DIRTY = false;

/* Registro per aggiornare al volo le liste (usato da "metti in evidenza"). */
const LIST_REFRESH = {};
/* Sezioni aperte/chiuse (mantiene lo stato tra i ridisegni). */
const OPEN_SECTIONS = {};

/* ------------------------- Utility ------------------------- */

function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
}

function b64encodeUtf8(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64decodeUtf8(b64) { return decodeURIComponent(escape(atob(String(b64).replace(/\n/g, '')))); }

function fileToBase64(file) {
    return new Promise(function (res, rej) {
        const r = new FileReader();
        r.onload = function () { res(String(r.result).split(',')[1]); };
        r.onerror = rej;
        r.readAsDataURL(file);
    });
}

function toast(msg, type) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast show ' + (type || '');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.className = 'toast'; }, 4000);
}

function setDirty(v) {
    DIRTY = v;
    const b = $('#dirtyBadge');
    if (b) b.style.display = v ? 'inline-block' : 'none';
}

function mkBtn(text, cls, handler) {
    const b = document.createElement('button');
    b.className = cls || 'btn';
    b.textContent = text;
    b.addEventListener('click', handler);
    return b;
}

/* ------------------------- Configurazione ------------------------- */

function loadCfg() {
    try { CFG = JSON.parse(localStorage.getItem(CFG_KEY)) || CFG; } catch (e) {}
    if (!CFG.owner) CFG.owner = DEFAULT_OWNER;
    if (!CFG.repo) CFG.repo = DEFAULT_REPO;
    if (!CFG.branch) CFG.branch = DEFAULT_BRANCH;
    $('#ghOwner').value = CFG.owner || '';
    $('#ghRepo').value = CFG.repo || '';
    $('#ghBranch').value = CFG.branch || DEFAULT_BRANCH;
    $('#ghToken').value = CFG.token || '';
}

function saveCfg() {
    CFG = {
        owner: $('#ghOwner').value.trim(),
        repo: $('#ghRepo').value.trim(),
        branch: ($('#ghBranch').value.trim() || DEFAULT_BRANCH),
        token: $('#ghToken').value.trim()
    };
    localStorage.setItem(CFG_KEY, JSON.stringify(CFG));
}

/* ------------------------- GitHub API ------------------------- */

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
    const sep = val.indexOf('?') === -1 ? '?' : '&';
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
    const body = { message: message || ('Aggiornamento ' + path), content: base64Content, branch: CFG.branch };
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

/* ------------------------- Connessione ------------------------- */

async function connect() {
    saveCfg();
    if (!CFG.owner || !CFG.repo || !CFG.token) {
        toast('Compila proprietario, repository e token GitHub.', 'err');
        return;
    }
    const btn = $('#btnConnect');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Carico…'; }
    try {
        const c = await ghGet('content.json');
        if (!c) { toast('content.json non trovato nel repository.', 'err'); return; }
        CONTENT = JSON.parse(c.text); CONTENT_SHA = c.sha;

        const a = await ghGet('news-archive.json');
        if (a) { ARCHIVE = JSON.parse(a.text); ARCHIVE_SHA = a.sha; }
        const l = await ghGet('news-archive-light.json');
        if (l) { LIGHT = JSON.parse(l.text); LIGHT_SHA = l.sha; }

        $('#connState').textContent = '✅ Connesso a ' + CFG.owner + '/' + CFG.repo;
        $('#connState').className = 'conn ok';
        renderAll();
        toast('Contenuti caricati da GitHub. Puoi iniziare a modificarli.', 'ok');
        setDirty(false);
    } catch (e) {
        console.error(e);
        toast('Errore di connessione: ' + e.message, 'err');
        $('#connState').textContent = '⚠️ Errore di connessione';
        $('#connState').className = 'conn err';
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔗 Connetti e carica i contenuti'; }
    }
}

/* ============================================================
 *  SCHEMA — descrive ogni sezione del pannello in italiano
 * ============================================================ */

const SCHEMA = [
    {
        id: 'home', icon: '🏠', title: 'Home — Notizie in evidenza', open: true,
        hint: 'Queste sono le notizie che si vedono nella <b>pagina iniziale</b>: il grande riquadro che scorre in alto (<b>Hero</b>) e le tre schede sotto (<b>Griglia news</b>). Se vuoi prendere una notizia dall\'archivio, usa i pulsanti “⭐ Hero” / “📰 News” nella sezione <b>Archivio notizie</b>.',
        lists: [
            {
                prefix: 'hero', label: 'Notizia in evidenza (riquadro grande)', min: 3, max: 5,
                fields: [
                    { key: 'title', label: 'Titolo della notizia', type: 'text', ph: 'Es. Max Pezzali: in arrivo il nuovo album' },
                    { key: 'tag', label: 'Etichetta / categoria', type: 'text', ph: 'Es. MUSICA' },
                    { key: 'desc', label: 'Breve descrizione (riassunto)', type: 'textarea', ph: 'Due righe di riassunto che invogliano a leggere…' },
                    { key: 'link', label: 'Link del pulsante “Scopri di più”', type: 'text', ph: 'articolo.html?id=...' }
                ],
                image: { key: 'img', label: 'Immagine di sfondo' }
            },
            {
                prefix: 'news', label: 'Notizia nella griglia (scheda piccola)', min: 3, max: 3,
                fields: [
                    { key: 'title', label: 'Titolo della notizia', type: 'text' },
                    { key: 'tag', label: 'Etichetta / categoria', type: 'text', ph: 'Es. NUOVO SINGOLO' },
                    { key: 'desc', label: 'Breve descrizione (riassunto)', type: 'textarea' },
                    { key: 'date', label: 'Data (testo libero)', type: 'text', ph: 'Es. 23 Settembre 2026' },
                    { key: 'link', label: 'Link del pulsante “Scopri di più”', type: 'text', ph: 'articolo.html?id=...' }
                ],
                image: { key: 'img', label: 'Immagine di sfondo' }
            }
        ]
    },
    {
        id: 'speaker', icon: '🎙️', title: 'Speaker in onda',
        hint: 'Qui indichi <b>chi sta conducendo la diretta adesso</b>. Attivando l\'interruttore, sul sito compare il nome dello speaker e il programma nella barra del player. Se lo disattivi, passano solo le canzoni.',
        speaker: {
            image: { keys: ['speaker1-img', 'speaker-img'], label: 'Foto dello speaker' },
            fields: [
                { keys: ['speaker1-name', 'speaker-name'], label: 'Nome dello speaker', type: 'text', ph: 'Es. Bartolo Oliva' },
                { keys: ['speaker1-program', 'speaker-program'], label: 'Nome del programma', type: 'text', ph: 'Es. Li.Fe. Radio' },
                { keys: ['speaker1-start'], label: 'Ora di inizio (formato HH:MM)', type: 'text', ph: 'Es. 06:00' },
                { keys: ['speaker1-end'], label: 'Ora di fine (formato HH:MM)', type: 'text', ph: 'Es. 10:00' }
            ],
            toggle: {
                keys: ['speaker1-active', 'speaker-active'],
                label: 'Speaker in onda adesso',
                on: 'Sì — lo speaker è in diretta (compare ON AIR)',
                off: 'No — solo musica (lo speaker è nascosto)'
            }
        }
    },
    {
        id: 'programs', icon: '🎧', title: 'Programmi & Puntate (Repliche)',
        hint: 'Qui definisci i <b>programmi</b> (nome + grafica) e carichi le <b>puntate in MP3</b>. Nella pagina <b>Palinsesto</b> si potranno ascoltare tutte le puntate. Consiglio: usa file MP3 non troppo pesanti (meglio sotto i 30&nbsp;MB).',
        programs: {
            prefix: 'program', min: 1, max: 20,
            fields: [
                { key: 'name', label: 'Nome del programma', type: 'text', ph: 'Es. Li.Fe. Radio Remix' },
                { key: 'desc', label: 'Descrizione (opzionale)', type: 'textarea', ph: 'Di cosa parla il programma…' }
            ],
            image: { key: 'img', label: 'Grafica / copertina del programma' }
        }
    },
    {
        id: 'palinsesto', icon: '📅', title: 'Palinsesto (calendario settimanale)',
        hint: 'I programmi che vanno in onda ogni giorno, con <b>giorno</b> e <b>orario</b>.',
        lists: [
            {
                prefix: 'pal', label: 'Programma del palinsesto', min: 5, max: 12,
                fields: [
                    { key: 'day', label: 'Giorno', type: 'text', ph: 'Es. LUNEDÌ' },
                    { key: 'time', label: 'Orario', type: 'text', ph: 'Es. 15:00' },
                    { key: 'title', label: 'Nome del programma', type: 'text' },
                    { key: 'sub', label: 'Sottotitolo / Speaker', type: 'text' }
                ]
            }
        ]
    },
    {
        id: 'instagram', icon: '📸', title: 'Post Instagram',
        hint: 'I post di Instagram mostrati sul sito. Incolla il <b>link del post</b> e, se vuoi, carica un\'<b>immagine di anteprima</b>.',
        lists: [
            {
                prefix: 'ig', label: 'Post Instagram', min: 3, max: 6,
                fields: [
                    { key: 'link', label: 'Link del post Instagram', type: 'text', ph: 'https://www.instagram.com/p/...' }
                ],
                image: { key: 'img', label: 'Immagine di anteprima' }
            }
        ]
    },
    {
        id: 'rivedi', icon: '🎬', title: 'Rivedi',
        hint: 'Le card della sezione <b>Rivedi</b> (video e foto degli eventi).',
        lists: [
            {
                prefix: 'rv', label: 'Card Rivedi', min: 3, max: 6,
                fields: [
                    { key: 'label', label: 'Etichetta', type: 'text', ph: 'Es. IL CONCERTO' },
                    { key: 'subtitle', label: 'Sottotitolo', type: 'text', ph: 'Es. RILIVE PALERMO 2026' },
                    { key: 'type', label: 'Tipo di contenuto', type: 'select', options: ['VIDEO', 'FOTO'] },
                    { key: 'count', label: 'Numero di foto (solo se tipo FOTO)', type: 'text', ph: 'Es. 33' },
                    { key: 'link', label: 'Link esterno (YouTube…)', type: 'text' }
                ],
                image: { key: 'img', label: 'Copertina' }
            }
        ]
    },
    {
        id: 'teamop', icon: '👥', title: 'Team Operativo',
        hint: 'I membri del <b>team operativo</b>: chi lavora attualmente alla radio.',
        lists: [
            {
                prefix: 'teamop', label: 'Membro del team operativo', min: 1, max: 25,
                fields: [
                    { key: 'name', label: 'Nome e cognome', type: 'text', ph: 'Nome Cognome' },
                    { key: 'role', label: 'Ruolo', type: 'text', ph: 'Es. Speaker, Responsabile Generale' },
                    { key: 'desc', label: 'Descrizione', type: 'textarea' }
                ],
                image: { key: 'img', label: 'Foto' }
            }
        ]
    },
    {
        id: 'teamfam', icon: '💜', title: 'Famiglia Li.Fe. Radio',
        hint: 'I membri <b>storici</b> della famiglia Li.Fe. Radio.',
        lists: [
            {
                prefix: 'teamfam', label: 'Membro della famiglia', min: 1, max: 12,
                fields: [
                    { key: 'name', label: 'Nome e cognome', type: 'text' },
                    { key: 'role', label: 'Ruolo', type: 'text' },
                    { key: 'desc', label: 'Descrizione', type: 'textarea' }
                ],
                image: { key: 'img', label: 'Foto' }
            }
        ]
    },
    {
        id: 'nlh', icon: '🎵', title: 'New Life Hit',
        hint: 'Le <b>nuove hit musicali</b> in evidenza.',
        lists: [
            {
                prefix: 'nlh', label: 'New Life Hit', min: 1, max: 5,
                fields: [
                    { key: 'title', label: 'Titolo della canzone', type: 'text' },
                    { key: 'desc', label: 'Artista / descrizione', type: 'text', ph: 'Es. TALK TO YOU di ANOTR' }
                ],
                image: { key: 'img', label: 'Copertina' }
            }
        ]
    },
    {
        id: 'rank', icon: '🏆', title: 'Classifica Top 3',
        hint: 'La <b>classifica</b> delle 3 canzoni più ascoltate.',
        lists: [
            {
                prefix: 'rank', label: 'Posizione in classifica', min: 3, max: 3,
                fields: [
                    { key: 'title', label: 'Titolo della canzone', type: 'text' },
                    { key: 'artist', label: 'Artista', type: 'text' }
                ]
            }
        ]
    },
    {
        id: 'archive', icon: '📰', title: 'Archivio notizie',
        hint: 'Tutte le notizie importate da <b>All Music Italia</b>. Usa <b>⭐ Hero</b> o <b>📰 News</b> per metterle in evidenza nella Home, <b>↗ Apri</b> per leggerle o <b>🗑</b> per eliminarle.',
        archive: true
    }
];

/* ============================================================
 *  Helper valori (gestiscono sia chiavi singole sia multiple)
 * ============================================================ */

function fullKeys(field, prefix, n) {
    if (field.keys) return field.keys.slice();
    return [prefix + n + '-' + field.key];
}
function fullImgKeys(img, prefix, n) {
    if (img.keys) return img.keys.slice();
    return [prefix + n + '-' + img.key];
}
function firstVal(keys) {
    for (let i = 0; i < keys.length; i++) {
        if (CONTENT.fields[keys[i]] !== undefined && CONTENT.fields[keys[i]] !== '') return CONTENT.fields[keys[i]];
    }
    for (let j = 0; j < keys.length; j++) {
        if (CONTENT.fields[keys[j]] !== undefined) return CONTENT.fields[keys[j]];
    }
    return '';
}
function setVals(keys, val) {
    keys.forEach(function (k) { CONTENT.fields[k] = val; });
    setDirty(true);
}
function firstImg(keys) {
    for (let i = 0; i < keys.length; i++) { if (CONTENT.images[keys[i]]) return CONTENT.images[keys[i]]; }
    return '';
}
function setImgs(keys, val) {
    keys.forEach(function (k) { CONTENT.images[k] = val; });
    setDirty(true);
}

function collectIndices(prefix, min, max) {
    const nums = new Set();
    const re = new RegExp('^' + prefix + '(\\d+)-');
    Object.keys(CONTENT.fields).forEach(function (k) { const m = k.match(re); if (m) nums.add(Number(m[1])); });
    Object.keys(CONTENT.images).forEach(function (k) { const m = k.match(re); if (m) nums.add(Number(m[1])); });
    for (let i = 1; i <= min; i++) nums.add(i);
    return Array.from(nums).filter(function (n) { return n >= 1 && n <= max; }).sort(function (a, b) { return a - b; });
}

function nextFreeIndex(indices, max) {
    for (let i = 1; i <= max; i++) { if (indices.indexOf(i) === -1) return i; }
    return -1;
}

/* ============================================================
 *  Rendering
 * ============================================================ */

function renderAll() {
    const wrap = $('#sectionsWrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    Object.keys(LIST_REFRESH).forEach(function (k) { delete LIST_REFRESH[k]; });
    SCHEMA.forEach(function (sec) { wrap.appendChild(buildSection(sec)); });
}

function buildSection(sec) {
    const el = document.createElement('div');
    el.className = 'section';
    el.id = 'section-' + sec.id;
    const isOpen = OPEN_SECTIONS[sec.id] !== undefined ? OPEN_SECTIONS[sec.id] : !!sec.open;
    if (!isOpen) el.classList.add('collapsed');

    const head = document.createElement('div');
    head.className = 'section-header';
    head.innerHTML = '<span class="ico">' + sec.icon + '</span><h2>' + esc(sec.title) + '</h2><span class="chev">▼</span>';
    head.addEventListener('click', function () {
        el.classList.toggle('collapsed');
        OPEN_SECTIONS[sec.id] = !el.classList.contains('collapsed');
    });
    el.appendChild(head);

    const body = document.createElement('div');
    body.className = 'section-body';
    if (sec.hint) {
        const h = document.createElement('div');
        h.className = 'section-hint';
        h.innerHTML = sec.hint;
        body.appendChild(h);
    }

    if (sec.speaker) renderSpeaker(body, sec.speaker);
    else if (sec.programs) renderPrograms(body, sec.programs);
    else if (sec.archive) renderArchive(body);
    else if (sec.lists) sec.lists.forEach(function (list) { renderList(body, list); });

    el.appendChild(body);
    return el;
}

/* ---------- Liste ripetute (hero, news, pal, ig, rv, team…) ---------- */

function renderList(body, list) {
    const container = document.createElement('div');
    body.appendChild(container);
    LIST_REFRESH[list.prefix] = function () { drawList(container, list); };
    drawList(container, list);
}

function drawList(container, list) {
    container.innerHTML = '';
    const indices = collectIndices(list.prefix, list.min, list.max);
    indices.forEach(function (n) { container.appendChild(buildCard(list, n)); });

    if (indices.length < list.max) {
        const add = mkBtn('＋ Aggiungi ' + list.label.toLowerCase(), 'btn small', function () {
            const idx = nextFreeIndex(indices, list.max);
            if (idx === -1) { toast('Massimo raggiunto (' + list.max + ').', 'err'); return; }
            container.insertBefore(buildCard(list, idx), add);
            indices.push(idx); indices.sort(function (a, b) { return a - b; });
            if (indices.length >= list.max) add.remove();
            setDirty(true);
            toast('Scheda aggiunta. Compila i campi e premi “Salva su GitHub”.', 'ok');
        });
        container.appendChild(add);
    }
}

function buildCard(list, n) {
    const card = document.createElement('div');
    card.className = 'acard';

    const title = document.createElement('div');
    title.className = 'acard-title';
    title.innerHTML = '<span class="num">' + n + '</span><span class="grow">' + esc(list.label) + ' #' + n + '</span>';
    title.appendChild(mkBtn('🗑 Rimuovi', 'btn small danger', function () {
        if (!confirm('Rimuovere “' + list.label + ' #' + n + '”? I dati di questa scheda verranno cancellati.')) return;
        list.fields.forEach(function (f) { fullKeys(f, list.prefix, n).forEach(function (k) { delete CONTENT.fields[k]; }); });
        if (list.image) fullImgKeys(list.image, list.prefix, n).forEach(function (k) { delete CONTENT.images[k]; });
        card.remove();
        setDirty(true);
        toast('Scheda rimossa. Ricordati di salvare.', 'ok');
    }));
    card.appendChild(title);

    if (list.image) card.appendChild(buildImageUpload(list.image, list.prefix, n));
    list.fields.forEach(function (f) { card.appendChild(buildField(f, list.prefix, n)); });

    return card;
}

function buildField(f, prefix, n) {
    const keys = fullKeys(f, prefix, n);
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const lab = document.createElement('label');
    lab.textContent = f.label;
    wrap.appendChild(lab);

    let inp;
    if (f.type === 'textarea') {
        inp = document.createElement('textarea');
        inp.rows = f.rows || 3;
    } else if (f.type === 'select') {
        inp = document.createElement('select');
        (f.options || []).forEach(function (o) {
            const op = document.createElement('option');
            op.value = o; op.textContent = o;
            inp.appendChild(op);
        });
    } else {
        inp = document.createElement('input');
        inp.type = 'text';
    }
    if (f.ph) inp.placeholder = f.ph;
    inp.value = firstVal(keys);
    inp.addEventListener('input', function () { setVals(keys, inp.value); });
    inp.addEventListener('change', function () { setVals(keys, inp.value); });
    wrap.appendChild(inp);
    return wrap;
}

/* ---------- Upload immagine ---------- */

function buildImageUpload(img, prefix, n) {
    const keys = fullImgKeys(img, prefix, n);
    const val = firstImg(keys);

    const wrap = document.createElement('div');
    wrap.className = 'imgup';

    const prev = document.createElement('div');
    prev.className = 'prev';
    renderPreview(prev, val);

    const side = document.createElement('div');
    side.className = 'side';
    const lab = document.createElement('label');
    lab.textContent = img.label;
    side.appendChild(lab);

    const fileLabel = document.createElement('label');
    fileLabel.className = 'filebtn';
    fileLabel.innerHTML = '📁 Scegli immagine…<input type="file" accept="image/*">';
    const fileInput = fileLabel.querySelector('input');
    side.appendChild(fileLabel);

    const pathEl = document.createElement('div');
    pathEl.className = 'path';
    pathEl.textContent = val || 'Nessuna immagine caricata';
    side.appendChild(pathEl);

    fileInput.addEventListener('change', function () { uploadImage(fileInput, keys, prev, pathEl); });

    wrap.appendChild(prev);
    wrap.appendChild(side);
    return wrap;
}

function renderPreview(container, val) {
    if (!val) { container.innerHTML = '<span class="noimg">nessuna<br>immagine</span>'; return; }
    const src = previewSrc(val);
    const raw = /^https?:\/\//i.test(val) ? '' : ghRaw(val);
    container.innerHTML = '<img src="' + esc(src) + '"' + (raw ? ' data-raw="' + esc(raw) + '"' : '') +
        ' onerror="if(this.dataset.raw&&this.getAttribute(\'src\')!==this.dataset.raw){this.src=this.dataset.raw;}">';
}

async function uploadImage(fileInput, keys, prevEl, pathEl) {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (!CFG.token) { toast('Prima connettiti a GitHub (serve il token).', 'err'); return; }
    try {
        const b64 = await fileToBase64(file);
        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
        const safeKey = keys[0].replace(/[^a-z0-9-]/gi, '');
        const name = 'uploads/' + safeKey + '-' + Math.floor(Date.now() / 1000) + '.' + ext;
        toast('Carico l\'immagine su GitHub…');
        await ghPut(name, b64, 'Admin: carica immagine ' + name, null);
        const url = ghRaw(name);
        setImgs(keys, url);
        renderPreview(prevEl, url);
        if (pathEl) pathEl.textContent = url;
        toast('Immagine caricata! Ricordati di premere “Salva su GitHub”.', 'ok');
    } catch (e) {
        console.error(e);
        toast('Errore caricamento immagine: ' + e.message, 'err');
    }
}

/* ---------- Speaker (singolo, con interruttore ON AIR) ---------- */

function renderSpeaker(body, sp) {
    const card = document.createElement('div');
    card.className = 'acard';

    const t = document.createElement('div');
    t.className = 'acard-title';
    t.innerHTML = '<span class="num">🎙️</span><span class="grow">Chi è in onda adesso</span>';
    card.appendChild(t);

    if (sp.image) card.appendChild(buildImageUpload(sp.image, '', 0));
    sp.fields.forEach(function (f) { card.appendChild(buildField(f, '', 0)); });

    const tk = sp.toggle.keys;
    const on = firstVal(tk) === '1';
    const tog = document.createElement('div');
    tog.className = 'toggle';
    tog.innerHTML =
        '<label class="switch"><input type="checkbox"' + (on ? ' checked' : '') + '><span class="slider"></span></label>' +
        '<div><div class="tlabel">' + esc(sp.toggle.label) + '</div><div class="tstate"></div></div>';
    const cb = tog.querySelector('input');
    const st = tog.querySelector('.tstate');
    function upd() { st.textContent = cb.checked ? sp.toggle.on : sp.toggle.off; }
    upd();
    cb.addEventListener('change', function () {
        setVals(tk, cb.checked ? '1' : '');
        upd();
        toast(cb.checked ? 'Speaker impostato IN ONDA. Salva per applicare.' : 'Speaker impostato su “solo musica”. Salva per applicare.', 'ok');
    });
    card.appendChild(tog);

    body.appendChild(card);
}

/* ---------- Programmi & Puntate ---------- */

function renderPrograms(body, pr) {
    const container = document.createElement('div');
    body.appendChild(container);
    drawPrograms(container, pr);
}

function drawPrograms(container, pr) {
    container.innerHTML = '';
    const indices = collectIndices(pr.prefix, pr.min, pr.max);
    indices.forEach(function (n) { container.appendChild(buildProgramCard(pr, n)); });

    if (indices.length < pr.max) {
        const add = mkBtn('＋ Aggiungi programma', 'btn small', function () {
            const idx = nextFreeIndex(indices, pr.max);
            if (idx === -1) { toast('Massimo raggiunto (' + pr.max + ').', 'err'); return; }
            container.insertBefore(buildProgramCard(pr, idx), add);
            indices.push(idx); indices.sort(function (a, b) { return a - b; });
            if (indices.length >= pr.max) add.remove();
            setDirty(true);
            toast('Programma aggiunto. Compila i campi e salva.', 'ok');
        });
        container.appendChild(add);
    }
}

function buildProgramCard(pr, n) {
    const card = document.createElement('div');
    card.className = 'acard';

    const title = document.createElement('div');
    title.className = 'acard-title';
    title.innerHTML = '<span class="num">' + n + '</span><span class="grow">Programma #' + n + '</span>';
    title.appendChild(mkBtn('🗑 Rimuovi', 'btn small danger', function () {
        if (!confirm('Rimuovere il programma #' + n + ' e tutte le sue puntate?')) return;
        pr.fields.forEach(function (f) { fullKeys(f, pr.prefix, n).forEach(function (k) { delete CONTENT.fields[k]; }); });
        delete CONTENT.fields['program' + n + '-episodes'];
        if (pr.image) fullImgKeys(pr.image, pr.prefix, n).forEach(function (k) { delete CONTENT.images[k]; });
        card.remove();
        setDirty(true);
        toast('Programma rimosso. Ricordati di salvare.', 'ok');
    }));
    card.appendChild(title);

    if (pr.image) card.appendChild(buildImageUpload(pr.image, pr.prefix, n));
    pr.fields.forEach(function (f) { card.appendChild(buildField(f, pr.prefix, n)); });
    card.appendChild(buildEpisodesBlock(n));

    return card;
}

function getEpisodes(n) {
    try {
        const v = JSON.parse(CONTENT.fields['program' + n + '-episodes'] || '[]');
        return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
}
function setEpisodes(n, eps) {
    if (eps && eps.length) CONTENT.fields['program' + n + '-episodes'] = JSON.stringify(eps);
    else delete CONTENT.fields['program' + n + '-episodes'];
    setDirty(true);
}

function buildEpisodesBlock(n) {
    const block = document.createElement('div');
    block.className = 'ep-block';
    const lab = document.createElement('label');
    lab.textContent = '🎵 Puntate (file MP3)';
    block.appendChild(lab);

    const list = document.createElement('div');
    block.appendChild(list);

    block.appendChild(mkBtn('＋ Aggiungi puntata', 'btn small', function () {
        const eps = getEpisodes(n);
        eps.push({ title: '', file: '', uploadedAt: Date.now() });
        setEpisodes(n, eps);
        renderEpisodeList(list, n);
    }));

    renderEpisodeList(list, n);
    return block;
}

function renderEpisodeList(list, n) {
    list.innerHTML = '';
    const eps = getEpisodes(n);
    if (!eps.length) {
        list.innerHTML = '<div class="ep-empty">Nessuna puntata caricata.</div>';
        return;
    }
    eps.forEach(function (ep, idx) {
        const row = document.createElement('div');
        row.className = 'ep-row';

        const ti = document.createElement('input');
        ti.type = 'text'; ti.className = 'ep-title';
        ti.placeholder = 'Titolo puntata (es. Ep. 1)';
        ti.value = ep.title || '';
        ti.addEventListener('input', function () {
            const e2 = getEpisodes(n); e2[idx].title = ti.value; setEpisodes(n, e2);
        });
        row.appendChild(ti);

        const fileLabel = document.createElement('label');
        fileLabel.className = 'filebtn';
        fileLabel.innerHTML = '📁 Carica MP3<input type="file" accept="audio/mpeg,audio/mp3,.mp3,audio/*">';
        const fi = fileLabel.querySelector('input');
        row.appendChild(fileLabel);

        const status = document.createElement('span');
        status.className = 'ep-status';
        status.textContent = ep.file ? ('File: ' + ep.file) : 'Nessun file caricato';
        row.appendChild(status);

        if (ep.file) {
            row.appendChild(mkBtn('▶ Ascolta', 'ep-play', function () { window.open(ep.file, '_blank'); }));
        }
        row.appendChild(mkBtn('🗑', 'btn small danger', function () {
            if (!confirm('Rimuovere questa puntata?')) return;
            const e2 = getEpisodes(n); e2.splice(idx, 1); setEpisodes(n, e2); renderEpisodeList(list, n);
        }));

        fi.addEventListener('change', function () { uploadEpisode(fi, n, idx, list, status); });

        list.appendChild(row);
    });
}

async function uploadEpisode(fileInput, n, idx, list, statusEl) {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (!CFG.token) { toast('Prima connettiti a GitHub.', 'err'); return; }
    if (file.size > 95 * 1024 * 1024) { toast('File troppo grande (max ~95 MB su GitHub).', 'err'); return; }
    try {
        statusEl.textContent = '⏳ Caricamento audio… (può richiedere qualche minuto)';
        const b64 = await fileToBase64(file);
        const ext = (file.name.split('.').pop() || 'mp3').toLowerCase();
        const base = file.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 60).replace(/^-+|-+$/g, '') || 'puntata';
        const name = 'uploads/audio/program' + n + '-ep-' + base + '-' + Math.floor(Date.now() / 1000) + '.' + ext;
        await ghPut(name, b64, 'Admin: carica puntata ' + name, null);
        const url = ghRaw(name);
        const eps = getEpisodes(n);
        eps[idx].file = url;
        eps[idx].uploadedAt = Date.now();
        setEpisodes(n, eps);
        renderEpisodeList(list, n);
        toast('Puntata caricata! Ricordati di premere “Salva su GitHub”.', 'ok');
    } catch (e) {
        console.error(e);
        statusEl.textContent = 'Errore: ' + e.message;
        toast('Errore caricamento audio: ' + e.message, 'err');
    }
}

/* ---------- Archivio notizie ---------- */

function renderArchive(body) {
    const card = document.createElement('div');
    card.className = 'acard';

    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = '🔎 Cerca una notizia per titolo…';
    card.appendChild(search);

    const info = document.createElement('div');
    info.className = 'archive-info';
    card.appendChild(info);

    const list = document.createElement('div');
    card.appendChild(list);
    body.appendChild(card);

    function draw() {
        if (!ARCHIVE || !ARCHIVE.news) { info.textContent = 'Archivio non caricato.'; return; }
        const q = (search.value || '').toLowerCase();
        const arr = ARCHIVE.news.filter(function (n) { return !q || (n.title || '').toLowerCase().indexOf(q) !== -1; });
        info.textContent = arr.length + ' notizie' + (q ? ' (filtrate)' : '') + ' su ' + ARCHIVE.news.length;
        list.innerHTML = '';
        arr.slice(0, 200).forEach(function (n) {
            const row = document.createElement('div');
            row.className = 'newsrow';

            const nt = document.createElement('div');
            nt.className = 'nt';
            nt.innerHTML = '<b>' + esc(n.tag || '') + '</b> ' + esc(n.title || '');
            row.appendChild(nt);

            const na = document.createElement('div');
            na.className = 'na';
            na.appendChild(mkBtn('⭐ Hero', 'btn small', function () { feature('hero', n.id); }));
            na.appendChild(mkBtn('📰 News', 'btn small', function () { feature('news', n.id); }));
            const open = document.createElement('a');
            open.className = 'btn small ghost';
            open.textContent = '↗ Apri';
            open.href = 'articolo.html?id=' + encodeURIComponent(n.id);
            open.target = '_blank';
            na.appendChild(open);
            na.appendChild(mkBtn('🗑', 'btn small danger', function () { deleteNews(n.id); }));
            row.appendChild(na);

            list.appendChild(row);
        });
    }
    search.addEventListener('input', draw);
    draw();
}

function feature(type, id) {
    if (!ARCHIVE) return;
    const n = (ARCHIVE.news || []).find(function (x) { return x.id === id; });
    if (!n) { toast('Notizia non trovata.', 'err'); return; }
    const max = type === 'hero' ? 5 : 3;
    for (let i = 1; i <= max; i++) {
        if ((CONTENT.fields[type + i + '-link'] || '').indexOf('id=' + id) !== -1) {
            toast('Questa notizia è già presente in ' + type + '.', 'ok'); return;
        }
    }
    let slot = 0;
    for (let i = 1; i <= max; i++) { if (!CONTENT.fields[type + i + '-title']) { slot = i; break; } }
    if (!slot) slot = type === 'hero' ? 3 : 3;
    CONTENT.fields[type + slot + '-title'] = (n.title || '').slice(0, 120);
    CONTENT.fields[type + slot + '-tag'] = n.tag || (type === 'hero' ? 'IN EVIDENZA' : 'NEWS');
    CONTENT.fields[type + slot + '-desc'] = (n.desc || '').slice(0, type === 'hero' ? 200 : 300);
    if (type === 'news') CONTENT.fields[type + slot + '-date'] = n.dateFull || n.date || '';
    CONTENT.fields[type + slot + '-link'] = 'articolo.html?id=' + id;
    if (n.img) CONTENT.images[type + slot + '-img'] = n.img;
    setDirty(true);
    if (LIST_REFRESH[type]) LIST_REFRESH[type]();
    toast('Notizia messa in ' + type + ' #' + slot + '. Salva per applicare.', 'ok');
}

function deleteNews(id) {
    if (!confirm('Eliminare questa notizia dall\'archivio?')) return;
    ARCHIVE.news = ARCHIVE.news.filter(function (n) { return n.id !== id; });
    ['hero', 'news'].forEach(function (type) {
        const max = type === 'hero' ? 5 : 3;
        for (let i = 1; i <= max; i++) {
            if ((CONTENT.fields[type + i + '-link'] || '').indexOf('id=' + id) !== -1) {
                ['title', 'tag', 'desc', 'date', 'link', 'full'].forEach(function (f) { delete CONTENT.fields[type + i + '-' + f]; });
                delete CONTENT.images[type + i + '-img'];
            }
        }
    });
    LIGHT = buildLight(ARCHIVE);
    setDirty(true);
    if (LIST_REFRESH['hero']) LIST_REFRESH['hero']();
    if (LIST_REFRESH['news']) LIST_REFRESH['news']();
    renderAllArchiveRefresh();
    toast('Notizia rimossa. Salva per applicare.', 'ok');
}

function renderAllArchiveRefresh() {
    /* ridisegna l'elenco dell'archivio se presente */
    const sec = $('#section-archive');
    if (!sec) return;
    const body = sec.querySelector('.section-body');
    if (!body) return;
    body.innerHTML = '';
    const h = document.createElement('div');
    h.className = 'section-hint';
    h.innerHTML = SCHEMA.find(function (s) { return s.id === 'archive'; }).hint;
    body.appendChild(h);
    renderArchive(body);
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
    if (!CONTENT) { toast('Nessun contenuto caricato. Prima connettiti a GitHub.', 'err'); return; }
    if (!CFG.token) { toast('Serve il token GitHub.', 'err'); return; }
    const btn = $('#btnSave');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Salvo…'; }
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
        toast('Salvato su GitHub! Il sito si aggiorna automaticamente entro pochi istanti.', 'ok');
    } catch (e) {
        console.error(e);
        toast('Errore nel salvataggio: ' + e.message, 'err');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '💾 Salva su GitHub'; }
    }
}

/* ------------------------- Toolbar & init ------------------------- */

function expandAll() { $$('.section').forEach(function (s) { s.classList.remove('collapsed'); }); SCHEMA.forEach(function (sec) { OPEN_SECTIONS[sec.id] = true; }); }
function collapseAll() { $$('.section').forEach(function (s) { s.classList.add('collapsed'); }); SCHEMA.forEach(function (sec) { OPEN_SECTIONS[sec.id] = false; }); }

window.addEventListener('beforeunload', function (e) {
    if (DIRTY) { e.preventDefault(); e.returnValue = ''; }
});

document.addEventListener('DOMContentLoaded', function () {
    loadCfg();
    $('#btnConnect').addEventListener('click', connect);
    $('#btnSave').addEventListener('click', saveAll);
    $('#btnReload').addEventListener('click', connect);
    const ex = $('#btnExpandAll'); if (ex) ex.addEventListener('click', expandAll);
    const co = $('#btnCollapseAll'); if (co) co.addEventListener('click', collapseAll);
    const sh = $('#saveHint');
    if (sh) sh.textContent = 'Modifica i campi e poi premi “💾 Salva su GitHub”.';
});
