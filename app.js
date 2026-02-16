/* ============================================
   StreamVault — App Logic
   ============================================ */

(function () {
    'use strict';

    // Country code → flag emoji
    function countryFlag(code) {
        if (!code || code.length !== 2) return '🌍';
        const offset = 127397;
        return String.fromCodePoint(...[...code.toUpperCase()].map(c => c.charCodeAt(0) + offset));
    }

    // DOM refs
    const $ = (s) => document.getElementById(s);
    const channelGrid = $('channelGrid');
    const countryList = $('countryList');
    const searchInput = $('searchInput');
    const searchClear = $('searchClear');
    const currentView = $('currentView');
    const channelCount = $('channelCount');
    const noResults = $('noResults');
    const loading = $('loading');
    const stats = $('stats');
    const btnAll = $('btnAll');
    const playerModal = $('playerModal');
    const playerTitle = $('playerTitle');
    const playerCountry = $('playerCountry');
    const playerClose = $('playerClose');
    const playerBackdrop = $('playerBackdrop');
    const playerError = $('playerError');
    const playerLoading = $('playerLoading');
    const videoPlayer = $('videoPlayer');
    const sidebar = $('sidebar');
    const sidebarToggle = $('sidebarToggle');
    const sidebarOverlay = $('sidebarOverlay');
    const favHeaderBtn = $('favHeaderBtn');
    const favBadge = $('favBadge');
    const btnFavorites = $('btnFavorites');
    const favSidebarCount = $('favSidebarCount');
    const playerFavBtn = $('playerFavBtn');

    let allChannels = [];
    let filteredChannels = [];
    let currentCountry = 'all';
    let showingFavorites = false;
    let searchQuery = '';
    let hlsInstance = null;
    let renderTimeout = null;
    let currentPlayerUrl = '';

    // ===================== FAVORITES (localStorage) =====================
    const FAV_KEY = 'streamvault_favorites';

    function getFavorites() {
        try {
            return JSON.parse(localStorage.getItem(FAV_KEY)) || [];
        } catch { return []; }
    }

    function saveFavorites(favs) {
        localStorage.setItem(FAV_KEY, JSON.stringify(favs));
        updateFavUI();
    }

    function isFavorite(url) {
        return getFavorites().includes(url);
    }

    function toggleFavorite(url) {
        let favs = getFavorites();
        if (favs.includes(url)) {
            favs = favs.filter(f => f !== url);
        } else {
            favs.push(url);
        }
        saveFavorites(favs);
        return favs.includes(url);
    }

    function updateFavUI() {
        const count = getFavorites().length;
        favBadge.textContent = count;
        favSidebarCount.textContent = count;
        favHeaderBtn.classList.toggle('has-favs', count > 0);
        favHeaderBtn.classList.toggle('active', showingFavorites);
        btnFavorites.classList.toggle('active', showingFavorites);
    }

    // ===================== DATA =====================
    async function loadChannels() {
        try {
            const res = await fetch('channels.json');
            if (!res.ok) throw new Error('Failed to load channel data');
            allChannels = await res.json();
            stats.textContent = `${allChannels.length.toLocaleString()} channels • ${getCountries().length} countries`;
            searchInput.placeholder = `Search ${allChannels.length.toLocaleString()} channels...`;
            renderCountries();
            updateFavUI();
            applyFilters();
            loading.style.display = 'none';
        } catch (err) {
            console.error(err);
            loading.innerHTML = '<p style="color:#ff6b6b;">Failed to load channels. Make sure channels.json is available.</p>';
        }
    }

    function getCountries() {
        const map = {};
        for (const ch of allChannels) {
            if (!map[ch.country]) map[ch.country] = { code: ch.country, name: ch.countryName, count: 0 };
            map[ch.country].count++;
        }
        return Object.values(map).sort((a, b) => b.count - a.count);
    }

    // ===================== SIDEBAR =====================
    function renderCountries() {
        const countries = getCountries();
        countryList.innerHTML = countries.map(c => `
      <div class="country-item" data-country="${c.code}" role="button" tabindex="0">
        <div class="country-info">
          <span class="country-flag">${countryFlag(c.code)}</span>
          <span class="country-name">${c.name}</span>
        </div>
        <span class="country-count">${c.count}</span>
      </div>
    `).join('');

        // Event delegation
        countryList.addEventListener('click', (e) => {
            const item = e.target.closest('.country-item');
            if (!item) return;
            selectCountry(item.dataset.country, item);
        });
    }

    function selectCountry(code, el) {
        showingFavorites = false;
        currentCountry = code;

        // Update active states
        document.querySelectorAll('.country-item').forEach(i => i.classList.remove('active'));
        btnFavorites.classList.remove('active');
        if (el) el.classList.add('active');
        btnAll.classList.toggle('active', code === 'all');

        // Update header
        if (code === 'all') {
            currentView.textContent = 'All Channels';
        } else {
            const country = getCountries().find(c => c.code === code);
            currentView.textContent = country ? `${countryFlag(code)} ${country.name}` : code;
        }

        updateFavUI();
        applyFilters();
        closeSidebar();
    }

    function showFavoritesView() {
        showingFavorites = true;
        currentCountry = 'all';

        document.querySelectorAll('.country-item').forEach(i => i.classList.remove('active'));
        btnAll.classList.remove('active');
        btnFavorites.classList.add('active');

        currentView.textContent = '❤️ My Favorites';
        updateFavUI();
        applyFilters();
        closeSidebar();
    }

    // ===================== SEARCH & FILTER =====================
    function applyFilters() {
        const q = searchQuery.toLowerCase().trim();
        const favUrls = showingFavorites ? new Set(getFavorites()) : null;

        filteredChannels = allChannels.filter(ch => {
            if (showingFavorites && !favUrls.has(ch.url)) return false;
            if (!showingFavorites && currentCountry !== 'all' && ch.country !== currentCountry) return false;
            if (q && !ch.name.toLowerCase().includes(q)) return false;
            return true;
        });

        channelCount.textContent = `${filteredChannels.length.toLocaleString()} channels`;
        renderChannels(filteredChannels);
    }

    // Debounced search
    searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value;
        searchClear.classList.toggle('visible', searchQuery.length > 0);

        clearTimeout(renderTimeout);
        renderTimeout = setTimeout(applyFilters, 200);
    });

    searchClear.addEventListener('click', () => {
        searchInput.value = '';
        searchQuery = '';
        searchClear.classList.remove('visible');
        applyFilters();
        searchInput.focus();
    });

    btnAll.addEventListener('click', () => selectCountry('all', null));
    btnFavorites.addEventListener('click', showFavoritesView);
    favHeaderBtn.addEventListener('click', () => {
        if (showingFavorites) {
            selectCountry('all', null);
        } else {
            showFavoritesView();
        }
    });

    // ===================== CHANNEL GRID =====================
    const BATCH_SIZE = 80;
    const HEART_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';

    function renderChannels(channels) {
        noResults.style.display = channels.length === 0 ? 'block' : 'none';

        // Render first batch immediately
        const firstBatch = channels.slice(0, BATCH_SIZE);
        channelGrid.innerHTML = firstBatch.map(channelCardHTML).join('');

        // Render remaining in chunks via rAF
        if (channels.length > BATCH_SIZE) {
            let offset = BATCH_SIZE;
            const renderMore = () => {
                if (offset >= channels.length) return;
                const chunk = channels.slice(offset, offset + BATCH_SIZE);
                const fragment = document.createDocumentFragment();
                const tmp = document.createElement('div');
                tmp.innerHTML = chunk.map(channelCardHTML).join('');
                while (tmp.firstChild) fragment.appendChild(tmp.firstChild);
                channelGrid.appendChild(fragment);
                offset += BATCH_SIZE;
                if (offset < channels.length) requestAnimationFrame(renderMore);
            };
            requestAnimationFrame(renderMore);
        }
    }

    function channelCardHTML(ch) {
        const flag = countryFlag(ch.country);
        const qualityTag = ch.quality
            ? `<span class="card-tag card-quality">${ch.quality}</span>`
            : '';
        const favClass = isFavorite(ch.url) ? ' is-fav' : '';
        return `
      <div class="channel-card" data-url="${encodeURIComponent(ch.url)}" data-name="${escapeAttr(ch.name)}" data-country="${escapeAttr(ch.countryName)}">
        <button class="card-fav${favClass}" data-fav-url="${encodeURIComponent(ch.url)}" aria-label="Toggle favorite">${HEART_SVG}</button>
        <div class="card-top">
          <div class="card-icon">${flag}</div>
          <div class="card-play">
            <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </div>
        </div>
        <div class="card-name">${escapeHTML(ch.name)}</div>
        <div class="card-meta">
          ${qualityTag}
          <span class="card-tag card-country-tag">${escapeHTML(ch.countryName)}</span>
        </div>
      </div>
    `;
    }

    // Event delegation for card clicks AND favorite toggle
    channelGrid.addEventListener('click', (e) => {
        // Favorite button click
        const favBtn = e.target.closest('.card-fav');
        if (favBtn) {
            e.stopPropagation();
            const url = decodeURIComponent(favBtn.dataset.favUrl);
            const nowFav = toggleFavorite(url);
            favBtn.classList.toggle('is-fav', nowFav);
            // Pop animation
            favBtn.classList.remove('pop');
            void favBtn.offsetWidth; // reflow
            favBtn.classList.add('pop');
            // If viewing favorites and we unfavorited, re-render
            if (showingFavorites && !nowFav) {
                applyFilters();
            }
            return;
        }

        // Channel card click → play
        const card = e.target.closest('.channel-card');
        if (!card) return;
        const url = decodeURIComponent(card.dataset.url);
        const name = card.dataset.name;
        const country = card.dataset.country;
        openPlayer(url, name, country);
    });

    // ===================== VIDEO PLAYER =====================
    function openPlayer(url, name, country) {
        currentPlayerUrl = url;
        playerTitle.textContent = name;
        playerCountry.textContent = country;
        playerError.style.display = 'none';
        playerLoading.style.display = 'flex';
        playerModal.classList.add('open');
        document.body.style.overflow = 'hidden';

        // Update player fav button state
        updatePlayerFavBtn();

        destroyHls();

        if (url.includes('.m3u8')) {
            if (Hls.isSupported()) {
                hlsInstance = new Hls({
                    enableWorker: true,
                    lowLatencyMode: true,
                    maxBufferLength: 30,
                    maxMaxBufferLength: 60,
                });
                hlsInstance.loadSource(url);
                hlsInstance.attachMedia(videoPlayer);

                hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
                    playerLoading.style.display = 'none';
                    videoPlayer.play().catch(() => { });
                });

                hlsInstance.on(Hls.Events.ERROR, (event, data) => {
                    if (data.fatal) {
                        playerLoading.style.display = 'none';
                        playerError.style.display = 'flex';
                        destroyHls();
                    }
                });

                // Timeout for slow/dead streams
                setTimeout(() => {
                    if (playerLoading.style.display !== 'none') {
                        playerLoading.style.display = 'none';
                        playerError.style.display = 'flex';
                        destroyHls();
                    }
                }, 15000);

            } else if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
                // Safari native HLS
                videoPlayer.src = url;
                videoPlayer.addEventListener('loadedmetadata', () => {
                    playerLoading.style.display = 'none';
                    videoPlayer.play().catch(() => { });
                }, { once: true });
                videoPlayer.addEventListener('error', () => {
                    playerLoading.style.display = 'none';
                    playerError.style.display = 'flex';
                }, { once: true });
            }
        } else {
            // Direct URL (mp4, etc.)
            videoPlayer.src = url;
            videoPlayer.addEventListener('loadeddata', () => {
                playerLoading.style.display = 'none';
                videoPlayer.play().catch(() => { });
            }, { once: true });
            videoPlayer.addEventListener('error', () => {
                playerLoading.style.display = 'none';
                playerError.style.display = 'flex';
            }, { once: true });
        }
    }

    function updatePlayerFavBtn() {
        const fav = isFavorite(currentPlayerUrl);
        playerFavBtn.classList.toggle('is-fav', fav);
    }

    playerFavBtn.addEventListener('click', () => {
        toggleFavorite(currentPlayerUrl);
        updatePlayerFavBtn();
        // Also update the card in the grid if visible
        const cardFav = channelGrid.querySelector(`.card-fav[data-fav-url="${encodeURIComponent(currentPlayerUrl)}"]`);
        if (cardFav) {
            cardFav.classList.toggle('is-fav', isFavorite(currentPlayerUrl));
        }
    });

    function closePlayer() {
        playerModal.classList.remove('open');
        document.body.style.overflow = '';
        currentPlayerUrl = '';
        destroyHls();
        videoPlayer.pause();
        videoPlayer.removeAttribute('src');
        videoPlayer.load();
    }

    function destroyHls() {
        if (hlsInstance) {
            hlsInstance.destroy();
            hlsInstance = null;
        }
    }

    playerClose.addEventListener('click', closePlayer);
    playerBackdrop.addEventListener('click', closePlayer);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && playerModal.classList.contains('open')) closePlayer();
    });

    // ===================== SIDEBAR TOGGLE =====================
    function closeSidebar() {
        sidebar.classList.remove('open');
        sidebarOverlay.classList.remove('visible');
    }

    sidebarToggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        sidebarOverlay.classList.toggle('visible');
    });
    sidebarOverlay.addEventListener('click', closeSidebar);

    // ===================== HELPERS =====================
    function escapeHTML(str) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return str.replace(/[&<>"']/g, c => map[c]);
    }
    function escapeAttr(str) {
        return str.replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    // ===================== INIT =====================
    loadChannels();

})();
