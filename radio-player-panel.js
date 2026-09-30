/* ================================================================
   Li.Fe. Radio — Player Expandable Panel (stile RDS)
   File: radio-player-panel.js
   Usato da: index, articolo, notizie, palinsesto, team
   
   Funzionalità:
   - Pulsante freccia nel player bar per aprire/chiudere il menu
   - Sezione ON AIR: speaker attualmente in onda
     (calcolato in base all'orario corrente e al palinsesto)
   - Sezione IN ONDA: brano attualmente in onda con cover art
   - Sezione ULTIMI BRANI: 3 brani passati con cover art
     (dati dall'API inMyStream: trackhistory + covers)
   ================================================================ */

(function() {
    'use strict';

    // ============ CONFIG ============
    const STREAM_API = 'https://sr14.inmystream.it:2020/json/stream/scuola?nocache=';
    const CONTENT_URL = 'content.json?v=' + Date.now();
    const MAX_RECENT_TRACKS = 3;
    const SPEAKER_SLOTS = 1; // solo speaker1 (1 slot)

    // ============ STATE ============
    let panelOpen = false;
    let speakerSlots = []; // [{name, program, start, end, img, active}]
    // Opzione speaker UNIFICATA: la casella ON AIR (finestra) e il ciclo dei
    // metadata (barra player) compaiono SOLO se lo speaker e' davvero in onda
    // (slot.active = true). Se la fascia e' "musica / no speaker", non mostriamo
    // nulla: passano solo le canzoni (nessun testo "MUSICA").
    let nowPlaying = { title: '', cover: '' };
    let trackHistory = []; // [{title, cover}]
    let panelEl = null;
    let expandBtn = null;

    // ============ UTILS ============
    function timeToMinutes(t) {
        if (!t || typeof t !== 'string') return -1;
        const parts = t.split(':');
        if (parts.length < 2) return -1;
        const h = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        if (isNaN(h) || isNaN(m)) return -1;
        return h * 60 + m;
    }

    // Check if current time falls within a slot (handles overnight wrap e.g. 22:00-06:00)
    function isCurrentSlot(slot, nowMin) {
        const start = timeToMinutes(slot.start);
        const end = timeToMinutes(slot.end);
        if (start < 0 || end < 0) return false;
        if (start <= end) {
            // Normal range (e.g. 10:00-14:00)
            return nowMin >= start && nowMin < end;
        } else {
            // Overnight wrap (e.g. 22:00-06:00)
            return nowMin >= start || nowMin < end;
        }
    }

    // Find which speaker slot is ON AIR (current)
    // Lo scheduling si basa SOLO sull'orario: se uno slot ha active=false
    // (nessuno speaker in quella fascia), la fascia oraria esiste ancora ma
    // NON viene mostrata alcuna casella: passano solo le canzoni.
    function computeSchedule() {
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();

        // Considera tutti gli slot con un orario valido come candidati scheduling
        const scheduledSlots = speakerSlots.filter(s => timeToMinutes(s.start) >= 0 && timeToMinutes(s.end) >= 0);

        let onAirIdx = -1;
        for (let i = 0; i < scheduledSlots.length; i++) {
            if (isCurrentSlot(scheduledSlots[i], nowMin)) {
                onAirIdx = i;
                break;
            }
        }

        // If no slot matches (gap in schedule), use the closest past slot
        if (onAirIdx === -1) {
            let bestIdx = -1;
            let bestDist = Infinity;
            for (let i = 0; i < scheduledSlots.length; i++) {
                const start = timeToMinutes(scheduledSlots[i].start);
                if (start >= 0) {
                    let dist = nowMin - start;
                    if (dist < 0) dist += 1440; // wrap around
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestIdx = i;
                    }
                }
            }
            onAirIdx = bestIdx;
        }

        if (onAirIdx === -1) {
            // Nessuno slot con orario: fallback sui soli slot attivi (legacy)
            const activeOnly = speakerSlots.filter(s => s.active);
            if (activeOnly.length === 0) return { prima: null, onAir: null, dopo: null };
            return { prima: null, onAir: activeOnly[0], dopo: null };
        }

        const onAir = scheduledSlots[onAirIdx];
        const primaIdx = (onAirIdx - 1 + scheduledSlots.length) % scheduledSlots.length;
        const dopoIdx = (onAirIdx + 1) % scheduledSlots.length;

        return {
            prima: scheduledSlots[primaIdx] || null,
            onAir: onAir,
            dopo: scheduledSlots[dopoIdx] || null
        };
    }

    function escapeHtml(text) {
        return String(text || '').replace(/[&<>'"]/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        }[c]));
    }

    function parseTrackArtist(title) {
        // "ARTIST - SONG" format, split into artist and song
        if (!title) return { artist: '', song: '' };
        const dashIdx = title.indexOf(' - ');
        if (dashIdx > 0) {
            return {
                artist: title.substring(0, dashIdx).trim(),
                song: title.substring(dashIdx + 3).trim()
            };
        }
        return { artist: '', song: title.trim() };
    }

    // ============ BUILD PANEL HTML ============
    function buildPanelHTML() {
        const sched = computeSchedule();

        // ---- Speaker ON AIR (solo casella corrente) ----
        // La casella speaker compare SOLO se c'e' davvero uno speaker in onda
        // (slot attivo con nome). Se la fascia e' "musica / no speaker" non
        // mostriamo nulla: passano solo le canzoni (nessun testo "MUSICA").
        let speakersRowHTML = '';
        const onAirSlot = sched.onAir;
        const hasOnAirSpeaker = onAirSlot && onAirSlot.active && onAirSlot.name && onAirSlot.name.trim();
        if (hasOnAirSpeaker) {
            speakersRowHTML = `
            <div class="rpp-speakers-row">
                ${speakerCardHTML(onAirSlot, 'ON AIR', true)}
            </div>`;
        }

        // ---- Now playing ----
        const np = nowPlaying;
        const npCover = np.cover
            ? `<img src="${escapeHtml(np.cover)}" alt="Cover">`
            : '<i class="fas fa-music"></i>';
        const npTitle = np.title || 'Li.Fe. Radio - In Diretta';
        const parsed = parseTrackArtist(np.title);
        const npDisplay = parsed.artist && parsed.song
            ? `${escapeHtml(parsed.artist)} &mdash; ${escapeHtml(parsed.song)}`
            : escapeHtml(npTitle);

        // ---- Recent tracks ----
        let recentHTML = '';
        if (trackHistory.length === 0) {
            recentHTML = '<div class="rpp-empty-text">Nessun brano recente disponibile</div>';
        } else {
            trackHistory.forEach((track, idx) => {
                const cover = track.cover
                    ? `<img src="${escapeHtml(track.cover)}" alt="Cover">`
                    : '<i class="fas fa-compact-disc"></i>';
                const tp = parseTrackArtist(track.title);
                const titleDisplay = tp.artist && tp.song
                    ? `${escapeHtml(tp.artist)} &mdash; ${escapeHtml(tp.song)}`
                    : escapeHtml(track.title);
                recentHTML += `
                    <div class="rpp-recent-item">
                        <div class="rpp-recent-index">${idx + 1}</div>
                        <div class="rpp-recent-cover">${cover}</div>
                        <div class="rpp-recent-info">
                            <div class="rpp-recent-title">${titleDisplay}</div>
                            <div class="rpp-recent-time"><i class="fas fa-clock-rotate-left"></i> Brano trasmesso</div>
                        </div>
                    </div>`;
            });
        }

        return `
        <div class="rpp-header">
            <div class="rpp-header-title">
                <span class="live-pulse"></span> NOW PLAYING
            </div>
            <button class="rpp-close-btn" id="rppCloseBtn" aria-label="Chiudi">
                <i class="fas fa-chevron-down"></i>
            </button>
        </div>
        <div class="rpp-body">
            ${speakersRowHTML}
            <div class="rpp-section-title">
                <i class="fas fa-circle-play"></i> IN ONDA ORA
            </div>
            <div class="rpp-now-playing">
                <div class="rpp-now-playing-cover">${npCover}</div>
                <div class="rpp-now-playing-info">
                    <div class="rpp-now-playing-label">
                        <span class="live-pulse"></span> LIVE
                    </div>
                    <div class="rpp-now-playing-title">${npDisplay}</div>
                </div>
            </div>
            <div class="rpp-section-title">
                <i class="fas fa-clock-rotate-left"></i> ULTIMI BRANI
            </div>
            <div class="rpp-recent-list">
                ${recentHTML}
            </div>
        </div>`;
    }

    function speakerCardHTML(slot, label, isOnAir) {
        const onAirClass = isOnAir ? ' on-air' : '';
        const timeRange = slot.start && slot.end ? `${slot.start} - ${slot.end}` : '';
        // Questa funzione viene chiamata SOLO per uno speaker realmente in onda
        // (slot attivo): niente fallback "MUSICA".
        const avatar = slot.img
            ? `<img src="${escapeHtml(slot.img)}?v=${Math.floor(Date.now() / 3600000)}" alt="${escapeHtml(slot.name)}">`
            : '<i class="fas fa-microphone-lines"></i>';
        return `
        <div class="rpp-speaker-card${onAirClass}">
            <div class="rpp-speaker-avatar">${avatar}</div>
            <div class="rpp-speaker-info">
                <span class="rpp-speaker-label">${label}</span>
                <div class="rpp-speaker-name">${escapeHtml(slot.name)}</div>
                <div class="rpp-speaker-program">${escapeHtml(slot.program)}${timeRange ? ' · ' + escapeHtml(timeRange) : ''}</div>
            </div>
        </div>`;
    }

    // ============ RENDER ============
    function renderPanel() {
        if (!panelEl) return;
        panelEl.innerHTML = buildPanelHTML();
        const closeBtn = document.getElementById('rppCloseBtn');
        if (closeBtn) {
            closeBtn.addEventListener('click', closePanel);
        }
    }

    // ============ OPEN / CLOSE ============
    function openPanel() {
        if (!panelEl) return;
        renderPanel(); // Refresh content on open
        panelEl.classList.add('open');
        panelOpen = true;
        if (expandBtn) {
            expandBtn.classList.add('open');
            const icon = expandBtn.querySelector('i');
            if (icon) icon.className = 'fas fa-chevron-down';
        }
        if (mobileExpandBtn) {
            mobileExpandBtn.classList.add('open');
            const icon = mobileExpandBtn.querySelector('i');
            if (icon) icon.className = 'fas fa-chevron-down';
        }
    }

    function closePanel() {
        if (!panelEl) return;
        panelEl.classList.remove('open');
        panelOpen = false;
        if (expandBtn) {
            expandBtn.classList.remove('open');
            const icon = expandBtn.querySelector('i');
            if (icon) icon.className = 'fas fa-chevron-up';
        }
        if (mobileExpandBtn) {
            mobileExpandBtn.classList.remove('open');
            const icon = mobileExpandBtn.querySelector('i');
            if (icon) icon.className = 'fas fa-chevron-up';
        }
    }

    function togglePanel() {
        if (panelOpen) closePanel();
        else openPanel();
    }

    // ============ DATA FETCHING ============
    function loadSpeakerSlots() {
        fetch(CONTENT_URL, { cache: 'no-store' })
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (!data) return;
                const fields = data.fields || {};
                const imgs = data.images || {};
                speakerSlots = [];
                for (let i = 1; i <= SPEAKER_SLOTS; i++) {
                    const name = fields['speaker' + i + '-name'] || '';
                    // Includi lo slot se ha un nome OPPURE un orario (fascia senza speaker)
                    const start = fields['speaker' + i + '-start'] || '';
                    const end = fields['speaker' + i + '-end'] || '';
                    if (!name.trim() && !start.trim() && !end.trim()) continue;
                    speakerSlots.push({
                        name: name,
                        program: fields['speaker' + i + '-program'] || '',
                        start: start,
                        end: end,
                        img: imgs['speaker' + i + '-img'] || '',
                        active: fields['speaker' + i + '-active'] === '1'
                    });
                }
                // If no schedule slots found, fall back to legacy single speaker
                if (speakerSlots.length === 0) {
                    const name = fields['speaker-name'] || '';
                    if (name.trim()) {
                        speakerSlots.push({
                            name: name,
                            program: fields['speaker-program'] || '',
                            start: '',
                            end: '',
                            img: imgs['speaker-img'] || '',
                            active: fields['speaker-active'] === '1'
                        });
                    }
                }
                // Re-render if panel is open
                if (panelOpen) renderPanel();
            })
            .catch(() => {});
    }

    function loadStreamData() {
        fetch(STREAM_API + Date.now(), { cache: 'no-store' })
            .then(r => r.text())
            .then(text => {
                const jsonStart = text.indexOf('{');
                if (jsonStart < 0) return;
                let data;
                try {
                    data = JSON.parse(text.slice(jsonStart));
                } catch (e) { return; }

                nowPlaying.title = (data.nowplaying || data.title || data.song || '').trim();
                nowPlaying.cover = data.coverart || data.cover || data.artwork || '';

                // Build track history from API
                const history = data.trackhistory || [];
                const covers = data.covers || [];
                trackHistory = [];
                // Skip index 0 (it's the current song), take next MAX_RECENT_TRACKS
                for (let i = 1; i < history.length && trackHistory.length < MAX_RECENT_TRACKS; i++) {
                    trackHistory.push({
                        title: history[i],
                        cover: covers[i] || ''
                    });
                }

                // Re-render if panel is open
                if (panelOpen) renderPanel();
            })
            .catch(() => {});
    }

    // ============ INIT ============
    let mobileExpandBtn = null;

    function initPanel() {
        // Find the player bar
        const playerBar = document.querySelector('.radio-player-bar');
        if (!playerBar) return;

        // Find the right group (where LIVE RADIO button and volume are)
        const rightGroup = playerBar.querySelector('.player-right-group');
        const leftGroup = playerBar.querySelector('.player-left-group');

        // Create expand button (desktop)
        expandBtn = document.createElement('button');
        expandBtn.className = 'player-expand-btn';
        expandBtn.id = 'playerExpandBtn';
        expandBtn.setAttribute('aria-label', 'Apri info on air');
        expandBtn.innerHTML = '<i class="fas fa-chevron-up"></i>';
        expandBtn.addEventListener('click', togglePanel);

        // Insert button into the right group (before the LIVE RADIO link on desktop)
        if (rightGroup) {
            rightGroup.insertBefore(expandBtn, rightGroup.firstChild);
        } else if (leftGroup) {
            leftGroup.appendChild(expandBtn);
        }

        // Create a dedicated mobile expand button (visible only <=768px)
        // Solves: on mobile the .player-right-group is display:none, so the
        // desktop expand button is unreachable. This floating button sits
        // just above the player bar and opens the same dropdown panel.
        mobileExpandBtn = document.createElement('button');
        mobileExpandBtn.className = 'player-expand-btn-mobile';
        mobileExpandBtn.id = 'playerExpandBtnMobile';
        mobileExpandBtn.setAttribute('aria-label', 'Apri info on air - brani e speaker');
        mobileExpandBtn.innerHTML = '<i class="fas fa-chevron-up"></i><span class="meb-label">ON AIR</span>';
        mobileExpandBtn.addEventListener('click', togglePanel);
        document.body.appendChild(mobileExpandBtn);

        // Create panel element
        panelEl = document.createElement('div');
        panelEl.className = 'radio-player-panel';
        panelEl.id = 'radioPlayerPanel';
        panelEl.innerHTML = `
        <div class="rpp-body">
            <div class="rpp-loading">
                <i class="fas fa-spinner"></i>
                Caricamento informazioni...
            </div>
        </div>`;
        document.body.appendChild(panelEl);

        // Close panel when clicking outside
        document.addEventListener('click', (e) => {
            if (!panelOpen) return;
            if (panelEl.contains(e.target) || expandBtn.contains(e.target) ||
                (mobileExpandBtn && mobileExpandBtn.contains(e.target)) || playerBar.contains(e.target)) return;
            closePanel();
        });

        // Close panel on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && panelOpen) closePanel();
        });

        // Load initial data
        loadSpeakerSlots();
        loadStreamData();

        // Refresh stream data every 15 seconds (only if panel open)
        setInterval(() => {
            loadStreamData();
        }, 15000);

        // Refresh speaker data every 1 hour
        setInterval(loadSpeakerSlots, 3600000);

        // Re-render every 30 seconds to update schedule if panel is open
        setInterval(() => {
            if (panelOpen) renderPanel();
        }, 30000);
    }

    // ============ PLAYER BAR SPEAKER CYCLING ============
    // Every 2 minutes, alternates the player bar display between
    // the current song (metadata from stream API) and the current
    // speaker (name + photo from content.json scheduling).
    // Works independently of the dropdown panel — always active.

    let playerCycleState = {
        showSpeaker: false,
        lastSongTitle: '',
        lastCoverArt: '',
        speakerLoaded: false
    };

    // Fetch stream metadata for the player bar (song title + cover)
    function playerFetchMetadata() {
        fetch(STREAM_API + Date.now(), { cache: 'no-store' })
            .then(r => r.text())
            .then(text => {
                const jsonStart = text.indexOf('{');
                if (jsonStart < 0) return;
                let data;
                try { data = JSON.parse(text.slice(jsonStart)); } catch (e) { return; }
                const nowPlaying = (data.nowplaying || data.title || data.song || '').trim();
                const coverArt = data.coverart || data.cover || data.artwork || '';
                playerCycleState.lastSongTitle = nowPlaying || 'Li.Fe. Radio - In Diretta';
                playerCycleState.lastCoverArt = coverArt;
                // Only update display if we're in song phase
                if (!playerCycleState.showSpeaker) {
                    playerDisplaySong();
                }
            })
            .catch(() => {
                if (!playerCycleState.lastSongTitle) {
                    playerCycleState.lastSongTitle = 'Li.Fe. Radio - In Diretta';
                }
                if (!playerCycleState.showSpeaker) playerDisplaySong();
            });
    }

    function playerDisplaySong() {
        const trackEl = document.getElementById('currentTrack');
        const labelEl = document.getElementById('trackStatusLabel');
        const progEl = document.getElementById('currentProgram');
        const boxEl = document.getElementById('speakerBox');
        if (!trackEl || !boxEl) return;
        trackEl.textContent = playerCycleState.lastSongTitle || 'Li.Fe. Radio - In Diretta';
        if (labelEl) labelEl.textContent = 'LIVE ON AIR';
        if (progEl) progEl.style.display = 'none';
        if (playerCycleState.lastCoverArt) {
            boxEl.innerHTML = '<img src="' + playerCycleState.lastCoverArt + '" alt="Cover">';
        } else {
            boxEl.innerHTML = '<i class="fas fa-music"></i>';
        }
    }

    function playerDisplaySpeaker() {
        const sched = computeSchedule();
        const slot = sched.onAir;
        const trackEl = document.getElementById('currentTrack');
        const labelEl = document.getElementById('trackStatusLabel');
        const progEl = document.getElementById('currentProgram');
        const boxEl = document.getElementById('speakerBox');
        if (!trackEl || !boxEl) return;
        // Se non c'e' uno speaker attivo, mostra la canzone (nessun "MUSICA"):
        // quando la fascia e' "musica / no speaker" passano solo le canzoni.
        if (!slot || !slot.active || !slot.name || !slot.name.trim()) {
            playerDisplaySong();
            return;
        }
        trackEl.textContent = slot.name;
        if (labelEl) labelEl.textContent = 'IN ONDA';
        if (progEl) {
            progEl.textContent = slot.program;
            progEl.style.display = slot.program ? 'inline' : 'none';
        }
        if (slot.img) {
            const v = Math.floor(Date.now() / 3600000); // hourly cache-buster
            boxEl.innerHTML = '<img src="' + slot.img + '?v=' + v + '" alt="' + escapeHtml(slot.name) + '">';
        } else {
            boxEl.innerHTML = '<i class="fas fa-microphone-lines"></i>';
        }
    }

    function startPlayerCycle() {
        const PLAYER_CYCLE_MS = 120000; // 2 minutes
        // Initial song display
        playerFetchMetadata();
        // Fetch stream metadata every 10 seconds
        setInterval(playerFetchMetadata, 10000);
        // Toggle speaker/song every 2 minutes
        setInterval(() => {
            // Se non c'e' uno speaker in onda, resta sempre sulla canzone
            const sched = computeSchedule();
            const s = sched.onAir;
            const hasSpeaker = s && s.active && s.name && s.name.trim();
            if (!hasSpeaker) {
                playerCycleState.showSpeaker = false;
                playerDisplaySong();
                return;
            }
            playerCycleState.showSpeaker = !playerCycleState.showSpeaker;
            if (playerCycleState.showSpeaker) {
                playerDisplaySpeaker();
            } else {
                playerDisplaySong();
            }
        }, PLAYER_CYCLE_MS);
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPanel);
    } else {
        initPanel();
    }

    // Start player cycling (independent of panel)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startPlayerCycle);
    } else {
        startPlayerCycle();
    }

})();
