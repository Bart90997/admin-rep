/**
 * News Ticker - Italpress RSS Feed
 * Recupera le ultime notizie da italpress.com e le mostra in un ticker scorrevole
 * Posizionato sopra l'header su tutte le pagine del sito Questp (Li.Fe. Radio)
 */
(function() {
    'use strict';

    // Endpoint proxy RSS-to-JSON per superare il CORS del browser
    var RSS_PROXY_URL = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent('https://www.italpress.com/feed/');
    
    // Fallback: notizie statiche in caso di errore di rete o proxy non disponibile
    var FALLBACK_NEWS = [
        { title: 'Le azzurre del fioretto conquistano l\'oro ai Mondiali di Hong Kong, l\'Italscherma chiude con otto medaglie', link: 'https://www.italpress.com/mondiali-scherma-hong-kong-italia-fioretto-femminile-finale-medaglia/' },
        { title: 'Mattarella alla cerimonia del Ventaglio: "Tensioni elettorali intempestive, non tolgano attenzione ai problemi degli italiani"', link: 'https://www.italpress.com/mattarella-cerimonia-consegna-ventaglio-quirinale-dichiarazioni/' },
        { title: 'Incendio in un binario della stazione Garibaldi di Milano, fiamme partite da un locale tecnico', link: 'https://www.italpress.com/incendio-in-un-binario-della-stazione-garibaldi-di-milano-fiamme-partite-da-un-locale-tecnico/' },
        { title: 'No Tav, il prefetto di Torino vieta il campeggio a Susa e Bussoleno', link: 'https://www.italpress.com/no-tav-il-prefetto-di-torino-vieta-il-campeggio-a-susa-e-bussoleno/' },
        { title: 'Report mismatch lavorativo, il 44,8% delle assunzioni è difficile da coprire', link: 'https://www.italpress.com/report-mismatch-lavorativo-il-448-delle-assunzioni-e-difficile-da-coprire/' },
        { title: 'Istat, a giugno i prezzi alla produzione dell\'industria crescono del 5,8% su base annua', link: 'https://www.italpress.com/istat-a-giugno-i-prezzi-alla-produzione-dellindustria-crescono-del-58-su-base-annua/' },
        { title: 'Situazione critica a Creta a causa di un vasto incendio, evacuate 8.000 persone', link: 'https://www.italpress.com/incendi-grecia-situazione-critica-a-creta-aggiornamenti/' },
        { title: 'Al via le partenze degli italiani, attesi 16 milioni di veicoli sulla rete Aspi', link: 'https://www.italpress.com/al-via-le-partenze-degli-italiani-attesi-16-milioni-di-veicoli-sulla-rete-aspi-nei-due-fine-settimana-di-esodo/' }
    ];

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function buildTickerItems(newsItems) {
        return newsItems.map(function(item) {
            var title = escapeHtml(item.title);
            var link = item.link || '#';
            return '<a href="' + escapeHtml(link) + '" target="_blank" rel="noopener noreferrer" class="news-ticker-item">' + title + '</a>';
        }).join('<span class="news-ticker-sep">&bull;</span>');
    }

    function initNewsTicker() {
        var tickerTrack = document.getElementById('newsTickerTrack');
        if (!tickerTrack) return;
        if (tickerTrack.dataset.tickerReady === 'true') return;
        tickerTrack.dataset.tickerReady = 'true';

        // Mostra subito le notizie di fallback per non lasciare il ticker vuoto
        tickerTrack.innerHTML = buildTickerItems(FALLBACK_NEWS);
        startScrollAnimation(tickerTrack);

        // Tenta di recuperare le notizie in tempo reale da italpress.com
        fetch(RSS_PROXY_URL)
            .then(function(response) { return response.json(); })
            .then(function(data) {
                if (data && data.status === 'ok' && data.items && data.items.length > 0) {
                    var liveNews = data.items.slice(0, 10).map(function(item) {
                        return { title: item.title, link: item.link };
                    });
                    tickerTrack.innerHTML = buildTickerItems(liveNews);
                    // Riavvia l'animazione con i nuovi contenuti
                    restartScrollAnimation(tickerTrack);
                }
            })
            .catch(function(err) {
                // Silenzioso: le notizie di fallback sono già visibili
                console.log('News ticker: uso notizie di fallback (feed non raggiungibile)');
            });
    }

    // === Animazione scroll orizzontale personalizzata ===
    var tickerAnimationId = null;

    function startScrollAnimation(track) {
        var trackWidth = track.scrollWidth;
        var containerWidth = track.parentElement.offsetWidth;
        var duration = Math.max(20000, (trackWidth / 80) * 1000); // ~80px/s, min 20s
        var startTime = null;

        // Duplica il contenuto per un loop continuo senza soluzione
        if (track.dataset.duplicated !== 'true') {
            track.innerHTML = track.innerHTML + track.innerHTML;
            track.dataset.duplicated = 'true';
        }

        function animate(timestamp) {
            if (!startTime) startTime = timestamp;
            var elapsed = timestamp - startTime;
            var progress = (elapsed / duration) % 1;
            track.style.transform = 'translateX(' + (-progress * trackWidth) + 'px)';
            tickerAnimationId = requestAnimationFrame(animate);
        }

        if (tickerAnimationId) cancelAnimationFrame(tickerAnimationId);
        tickerAnimationId = requestAnimationFrame(animate);
    }

    function restartScrollAnimation(track) {
        track.dataset.duplicated = 'false';
        if (tickerAnimationId) cancelAnimationFrame(tickerAnimationId);
        startScrollAnimation(track);
    }

    // Pausa al hover (desktop) e riprendi
    function setupHoverPause() {
        var tickerBar = document.getElementById('newsTickerBar');
        if (!tickerBar) return;
        tickerBar.addEventListener('mouseenter', function() {
            if (tickerAnimationId) {
                cancelAnimationFrame(tickerAnimationId);
                tickerAnimationId = null;
            }
        });
        tickerBar.addEventListener('mouseleave', function() {
            var track = document.getElementById('newsTickerTrack');
            if (track) startScrollAnimation(track);
        });
    }

    // Inizializza quando il DOM è pronto
    function ready(fn) {
        if (document.readyState !== 'loading') {
            fn();
        } else {
            document.addEventListener('DOMContentLoaded', fn);
        }
    }

    ready(function() {
        initNewsTicker();
        setupHoverPause();
    });

    // Espone la funzione per ri-inizializzazione se necessario
    window.initNewsTicker = initNewsTicker;
})();
