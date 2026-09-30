/* ============================================================
 *  Li.Fe. Radio — Sorgente dati su GitHub (nessun PHP, nessun FTP)
 *  File: data-source.js
 * ============================================================
 *
 *  PERCHE' SERVE
 *  Il sito e' ospitato sul server della scuola (liferadio.liceofermiaversa.edu.it),
 *  che serve SOLO file statici e NON esegue PHP. Quindi non possiamo usare
 *  api/get-news.php ne' il vecchio pannello PHP.
 *
 *  SOLUZIONE
 *  I contenuti (content.json, news-archive.json, news-archive-light.json)
 *  vengono letti DIRETTAMENTE dal repository GitHub, che:
 *    - si aggiorna da solo ogni giorno (GitHub Actions → import notizie);
 *    - viene aggiornato dal pannello admin (admin.html → GitHub API).
 *
 *  COME FUNZIONA QUESTO FILE
 *   1. Intercetta le chiamate fetch() ai 3 file JSON e le reindirizza a GitHub.
 *   2. Se GitHub non e' raggiungibile, ripiega sui file locali (fallback).
 *   3. Per le immagini: prova prima il file locale (uploads/... sul server
 *      della scuola) e, se manca, ripiega automaticamente su GitHub.
 *
 *  CONFIGURAZIONE
 *  Per cambiare repository, modifica SOLO la riga GH_BASE qui sotto
 *  (oppure definisci window.LIFE_GH_BASE PRIMA di caricare questo script).
 * ============================================================ */

(function () {
    'use strict';

    /* ---- 1. Configurazione ------------------------------------------------ */
    var GH_BASE = window.LIFE_GH_BASE || 'https://raw.githubusercontent.com/Bart90997/admin-rep/main/';
    /* Assicura che finisca con "/" */
    if (GH_BASE.charAt(GH_BASE.length - 1) !== '/') GH_BASE += '/';

    /* I file che devono essere letti da GitHub */
    var DATA_FILES = { 'content.json': 1, 'news-archive.json': 1, 'news-archive-light.json': 1 };

    /* ---- 2. Utility ------------------------------------------------------- */
    function fileName(url) {
        try {
            var u = new URL(url, window.location.href);
            return u.pathname.split('/').pop();
        } catch (e) { return ''; }
    }

    function isAbsolute(p) { return /^https?:\/\//i.test(p) || /^data:/i.test(p) || /^blob:/i.test(p); }

    /* Trasforma un percorso "uploads/..." in URL assoluto GitHub */
    function toGhUrl(p) {
        if (!p) return p;
        if (isAbsolute(p)) return p;
        if (p.charAt(0) === '/') p = p.slice(1);
        return GH_BASE + p;
    }

    /* ---- 3. Intercettazione fetch ---------------------------------------- */
    var origFetch = window.fetch ? window.fetch.bind(window) : null;

    if (origFetch) {
        window.fetch = function (input, init) {
            var url = (typeof input === 'string') ? input : (input && input.url);
            var name = url ? fileName(url) : '';
            var isGhApi = url && url.indexOf('api.github.com') !== -1;

            /* Solo i 3 JSON locali vengono dirottati su GitHub.
               Le chiamate alla GitHub API (pannello admin) NON vengono toccate. */
            if (name && DATA_FILES[name] && !isGhApi) {
                var ghUrl = GH_BASE + name + '?v=' + Date.now();
                return origFetch(ghUrl, { cache: 'no-store' }).then(function (r) {
                    if (!r.ok) throw new Error('GitHub ' + r.status + ' per ' + name);
                    /* Restituiamo una Response "pulita" (stesso contenuto) */
                    return r.text().then(function (txt) {
                        return new Response(txt, {
                            status: 200,
                            statusText: 'OK',
                            headers: { 'Content-Type': 'application/json; charset=utf-8' }
                        });
                    });
                }).catch(function (err) {
                    /* GitHub non raggiungibile → usa il file locale */
                    if (window.console && console.warn) {
                        console.warn('[data-source] GitHub non raggiungibile per ' + name + ', uso il file locale.', err);
                    }
                    return origFetch(input, init);
                });
            }

            return origFetch(input, init);
        };
    }

    /* ---- 4. Fallback automatico per le immagini --------------------------- */
    /* Se un'immagine locale (uploads/...) non esiste sul server della scuola,
       la ricarichiamo da GitHub. Cosi' funzionano sia le immagini vecchie
       (sul server) sia quelle nuove caricate dal pannello admin (su GitHub). */
    document.addEventListener('error', function (e) {
        var el = e.target;
        if (!el || el.tagName !== 'IMG') return;
        if (el.dataset && el.dataset.ghTried) return;
        var src = el.getAttribute('src') || '';
        if (/^uploads\//i.test(src)) {
            if (el.dataset) el.dataset.ghTried = '1';
            el.src = toGhUrl(src);
        }
    }, true); /* capture: l'evento "error" non fa bubbling */

    /* ---- 5. Helper pubblici (opzionali) ----------------------------------- */
    window.LIFE_DATA_BASE = GH_BASE;
    /* lifeImg('uploads/x.jpg') → URL assoluto GitHub (per nuovi contenuti) */
    window.lifeImg = function (p) { return toGhUrl(p); };
    window.lifeGhBase = GH_BASE;
})();
