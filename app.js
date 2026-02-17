/* ============================================
   StreamVault — App Logic
   v2: CORS proxy, native HLS fallback, lazy loading
   ============================================ */

(function () {
    'use strict';

    // ===================== CONFIG =====================
    // Set this to your Cloudflare Worker URL after deploying.
    // Leave empty to connect directly (some streams will fail due to CORS).
    const PROXY_URL = 'https://streamvault-proxy.streamvault-proxy.workers.dev'; // Cloudflare CORS proxy

    // ===================== HELPERS =====================
    function countryFlag(code) {
        if (!code || code.length !== 2) return '🌍';
        const offset = 127397;
        return String.fromCodePoint(...[...code.toUpperCase()].map(c => c.charCodeAt(0) + offset));
    }
    function escapeHTML(str) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return str.replace(/[&<>"']/g, c => map[c]);
    }
    function escapeAttr(str) {
        return str.replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }
    function proxyUrl(url) {
        if (!PROXY_URL) return url;
        // Cloudflare Workers can't fetch raw IP addresses (error 1003)
        // Only proxy domain-based URLs
        try {
            var hostname = new URL(url).hostname;
            // Check if hostname is an IP address
            if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) || hostname.includes(':')) {
                return url; // Skip proxy for IPs
            }
        } catch (e) { return url; }
        return PROXY_URL + '/?url=' + encodeURIComponent(url);
    }

    // ===================== DOM REFS =====================
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

    let countryIndex = [];       // [{code, name, count}]
    let loadedChannels = {};     // country_code -> channel[]
    let displayChannels = [];    // currently displayed
    let currentCountry = 'all';
    let showingFavorites = false;
    let searchQuery = '';
    let hlsInstance = null;
    let renderTimeout = null;
    let currentPlayerUrl = '';
    let totalChannels = 0;

    // ===================== FAVORITES (localStorage) =====================
    const FAV_KEY = 'streamvault_favorites';

    function getFavorites() {
        try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; }
        catch { return []; }
    }
    function saveFavorites(favs) {
        localStorage.setItem(FAV_KEY, JSON.stringify(favs));
        updateFavUI();
    }
    function isFavorite(url) { return getFavorites().includes(url); }
    function toggleFavorite(url) {
        var favs = getFavorites();
        if (favs.includes(url)) { favs = favs.filter(function (f) { return f !== url; }); }
        else { favs.push(url); }
        saveFavorites(favs);
        return favs.includes(url);
    }
    function updateFavUI() {
        var count = getFavorites().length;
        favBadge.textContent = count;
        favSidebarCount.textContent = count;
        favHeaderBtn.classList.toggle('has-favs', count > 0);
        favHeaderBtn.classList.toggle('active', showingFavorites);
        btnFavorites.classList.toggle('active', showingFavorites);
    }

    // ===================== DATA LOADING (lazy) =====================
    async function init() {
        try {
            // Load lightweight country index first
            var res = await fetch('countries-index.json');
            if (!res.ok) throw new Error('No countries-index.json');
            countryIndex = await res.json();
            totalChannels = countryIndex.reduce(function (s, c) { return s + c.count; }, 0);

            stats.textContent = totalChannels.toLocaleString() + ' channels \u2022 ' + countryIndex.length + ' countries';
            searchInput.placeholder = 'Search ' + totalChannels.toLocaleString() + ' channels...';

            renderCountries();
            updateFavUI();

            // Load all channels for initial "All" view
            await loadAllChannels();
            applyFilters();
            loading.style.display = 'none';
        } catch (err) {
            // Fallback: try loading the single channels.json
            console.warn('Lazy load failed, falling back to channels.json:', err);
            await loadAllFromSingleFile();
        }
    }

    async function loadAllFromSingleFile() {
        try {
            var res = await fetch('channels.json');
            if (!res.ok) throw new Error('Failed to load');
            var all = await res.json();
            // Build index and cache
            var map = {};
            for (var i = 0; i < all.length; i++) {
                var ch = all[i];
                if (!map[ch.country]) map[ch.country] = [];
                map[ch.country].push(ch);
            }
            loadedChannels = map;
            if (!countryIndex.length) {
                countryIndex = Object.keys(map).map(function (code) {
                    return { code: code, name: map[code][0].countryName, count: map[code].length };
                }).sort(function (a, b) { return b.count - a.count; });
                totalChannels = all.length;
                stats.textContent = totalChannels.toLocaleString() + ' channels \u2022 ' + countryIndex.length + ' countries';
                searchInput.placeholder = 'Search ' + totalChannels.toLocaleString() + ' channels...';
                renderCountries();
                updateFavUI();
            }
            applyFilters();
            loading.style.display = 'none';
        } catch (err) {
            console.error(err);
            loading.innerHTML = '<p style="color:#ff6b6b;">Failed to load channels.</p>';
        }
    }

    async function loadAllChannels() {
        // Load all country files in parallel batches
        var batch = [];
        for (var i = 0; i < countryIndex.length; i++) {
            var c = countryIndex[i];
            if (!loadedChannels[c.code]) {
                batch.push(loadCountry(c.code));
            }
            // Load in batches of 10
            if (batch.length >= 10) {
                await Promise.all(batch);
                batch = [];
            }
        }
        if (batch.length) await Promise.all(batch);
    }

    async function loadCountry(code) {
        if (loadedChannels[code]) return loadedChannels[code];
        try {
            var res = await fetch('countries/' + code.toLowerCase() + '.json');
            if (!res.ok) throw new Error('Failed');
            loadedChannels[code] = await res.json();
            return loadedChannels[code];
        } catch (e) {
            console.warn('Failed to load ' + code, e);
            loadedChannels[code] = [];
            return [];
        }
    }

    function getAllLoadedChannels() {
        var all = [];
        for (var code in loadedChannels) {
            all = all.concat(loadedChannels[code]);
        }
        return all;
    }

    // ===================== SIDEBAR =====================
    function renderCountries() {
        var html = '';
        for (var i = 0; i < countryIndex.length; i++) {
            var c = countryIndex[i];
            html += '<div class="country-item" data-country="' + c.code + '" role="button" tabindex="0">'
                + '<div class="country-info">'
                + '<span class="country-flag">' + countryFlag(c.code) + '</span>'
                + '<span class="country-name">' + escapeHTML(c.name) + '</span>'
                + '</div>'
                + '<span class="country-count">' + c.count + '</span>'
                + '</div>';
        }
        countryList.innerHTML = html;

        countryList.addEventListener('click', function (e) {
            var item = e.target.closest('.country-item');
            if (!item) return;
            selectCountry(item.dataset.country, item);
        });
    }

    async function selectCountry(code, el) {
        showingFavorites = false;
        currentCountry = code;

        document.querySelectorAll('.country-item').forEach(function (i) { i.classList.remove('active'); });
        btnFavorites.classList.remove('active');
        if (el) el.classList.add('active');
        btnAll.classList.toggle('active', code === 'all');

        if (code === 'all') {
            currentView.textContent = 'All Channels';
        } else {
            var entry = countryIndex.find(function (c) { return c.code === code; });
            currentView.textContent = entry ? countryFlag(code) + ' ' + entry.name : code;
            // Lazy load this country if needed
            if (!loadedChannels[code]) {
                loading.style.display = 'flex';
                await loadCountry(code);
                loading.style.display = 'none';
            }
        }

        updateFavUI();
        applyFilters();
        closeSidebar();
    }

    function showFavoritesView() {
        showingFavorites = true;
        currentCountry = 'all';
        document.querySelectorAll('.country-item').forEach(function (i) { i.classList.remove('active'); });
        btnAll.classList.remove('active');
        btnFavorites.classList.add('active');
        currentView.textContent = '\u2764\ufe0f My Favorites';
        updateFavUI();
        applyFilters();
        closeSidebar();
    }

    // ===================== SEARCH & FILTER =====================
    function applyFilters() {
        var q = searchQuery.toLowerCase().trim();
        var source;

        if (showingFavorites) {
            var favUrls = new Set(getFavorites());
            source = getAllLoadedChannels().filter(function (ch) { return favUrls.has(ch.url); });
        } else if (currentCountry !== 'all') {
            source = loadedChannels[currentCountry] || [];
        } else {
            source = getAllLoadedChannels();
        }

        if (q) {
            displayChannels = source.filter(function (ch) { return ch.name.toLowerCase().indexOf(q) !== -1; });
        } else {
            displayChannels = source;
        }

        channelCount.textContent = displayChannels.length.toLocaleString() + ' channels';
        renderChannels(displayChannels);
    }

    searchInput.addEventListener('input', function () {
        searchQuery = searchInput.value;
        searchClear.classList.toggle('visible', searchQuery.length > 0);
        clearTimeout(renderTimeout);
        renderTimeout = setTimeout(applyFilters, 200);
    });

    searchClear.addEventListener('click', function () {
        searchInput.value = '';
        searchQuery = '';
        searchClear.classList.remove('visible');
        applyFilters();
        searchInput.focus();
    });

    btnAll.addEventListener('click', function () { selectCountry('all', null); });
    btnFavorites.addEventListener('click', showFavoritesView);
    favHeaderBtn.addEventListener('click', function () {
        if (showingFavorites) selectCountry('all', null);
        else showFavoritesView();
    });

    // ===================== CHANNEL GRID =====================
    var BATCH_SIZE = 60;
    var HEART_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';

    function renderChannels(channels) {
        noResults.style.display = channels.length === 0 ? 'block' : 'none';
        var firstBatch = channels.slice(0, BATCH_SIZE);
        channelGrid.innerHTML = firstBatch.map(channelCardHTML).join('');

        if (channels.length > BATCH_SIZE) {
            var offset = BATCH_SIZE;
            var renderMore = function () {
                if (offset >= channels.length) return;
                var chunk = channels.slice(offset, offset + BATCH_SIZE);
                var fragment = document.createDocumentFragment();
                var tmp = document.createElement('div');
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
        var flag = countryFlag(ch.country);
        var qualityTag = ch.quality ? '<span class="card-tag card-quality">' + ch.quality + '</span>' : '';
        var favClass = isFavorite(ch.url) ? ' is-fav' : '';
        return '<div class="channel-card" data-url="' + encodeURIComponent(ch.url) + '" data-name="' + escapeAttr(ch.name) + '" data-country="' + escapeAttr(ch.countryName) + '">'
            + '<button class="card-fav' + favClass + '" data-fav-url="' + encodeURIComponent(ch.url) + '" aria-label="Toggle favorite">' + HEART_SVG + '</button>'
            + '<div class="card-top">'
            + '<div class="card-icon">' + flag + '</div>'
            + '<div class="card-play"><svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>'
            + '</div>'
            + '<div class="card-name">' + escapeHTML(ch.name) + '</div>'
            + '<div class="card-meta">' + qualityTag
            + '<span class="card-tag card-country-tag">' + escapeHTML(ch.countryName) + '</span>'
            + '</div></div>';
    }

    channelGrid.addEventListener('click', function (e) {
        var favBtn = e.target.closest('.card-fav');
        if (favBtn) {
            e.stopPropagation();
            var url = decodeURIComponent(favBtn.dataset.favUrl);
            var nowFav = toggleFavorite(url);
            favBtn.classList.toggle('is-fav', nowFav);
            favBtn.classList.remove('pop');
            void favBtn.offsetWidth;
            favBtn.classList.add('pop');
            if (showingFavorites && !nowFav) applyFilters();
            return;
        }
        var card = e.target.closest('.channel-card');
        if (!card) return;
        openPlayer(decodeURIComponent(card.dataset.url), card.dataset.name, card.dataset.country);
    });

    // ===================== VIDEO PLAYER =====================
    // Detect native HLS support (Safari, Smart TVs, iOS)
    var testVideo = document.createElement('video');
    var hasNativeHLS = testVideo.canPlayType('application/vnd.apple.mpegurl') !== ''
        || testVideo.canPlayType('application/x-mpegURL') !== '';
    // Detect if HLS.js is available and supported
    var hasHlsJs = typeof Hls !== 'undefined' && Hls.isSupported();

    function openPlayer(url, name, country) {
        currentPlayerUrl = url;
        playerTitle.textContent = name;
        playerCountry.textContent = country;
        playerError.style.display = 'none';
        playerLoading.style.display = 'flex';
        playerModal.classList.add('open');
        document.body.style.overflow = 'hidden';
        updatePlayerFavBtn();
        destroyHls();

        var streamUrl = proxyUrl(url);

        // Strategy: Always try HLS first (many streams lack .m3u8 in URL but ARE HLS)
        // Falls back to direct video on failure
        if (hasNativeHLS) {
            // Smart TVs, Safari, iOS — native HLS handles everything
            videoPlayer.src = streamUrl;
            videoPlayer.addEventListener('loadedmetadata', onPlayerReady, { once: true });
            videoPlayer.addEventListener('error', function () {
                // Native player failed — try direct without proxy
                if (streamUrl !== url) {
                    videoPlayer.src = url;
                    videoPlayer.addEventListener('loadedmetadata', onPlayerReady, { once: true });
                    videoPlayer.addEventListener('error', onPlayerError, { once: true });
                } else {
                    onPlayerError();
                }
            }, { once: true });
            startPlaybackTimeout();
        } else if (hasHlsJs) {
            // Chrome, Firefox desktop — use HLS.js
            hlsInstance = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
            });
            hlsInstance.loadSource(streamUrl);
            hlsInstance.attachMedia(videoPlayer);
            hlsInstance.on(Hls.Events.MANIFEST_PARSED, function () {
                playerLoading.style.display = 'none';
                videoPlayer.play().catch(function () { });
            });
            hlsInstance.on(Hls.Events.ERROR, function (event, data) {
                if (data.fatal) {
                    destroyHls();
                    // HLS failed — try as direct video
                    videoPlayer.src = streamUrl;
                    videoPlayer.addEventListener('loadeddata', onPlayerReady, { once: true });
                    videoPlayer.addEventListener('error', onPlayerError, { once: true });
                }
            });
            startPlaybackTimeout();
        } else {
            // No HLS support — direct play
            videoPlayer.src = streamUrl;
            videoPlayer.addEventListener('loadeddata', onPlayerReady, { once: true });
            videoPlayer.addEventListener('error', onPlayerError, { once: true });
            startPlaybackTimeout();
        }
    }

    function onPlayerReady() {
        playerLoading.style.display = 'none';
        videoPlayer.play().catch(function () { });
    }
    function onPlayerError() {
        playerLoading.style.display = 'none';
        playerError.style.display = 'flex';
    }
    function startPlaybackTimeout() {
        setTimeout(function () {
            if (playerLoading.style.display !== 'none') {
                playerLoading.style.display = 'none';
                playerError.style.display = 'flex';
                destroyHls();
            }
        }, 15000);
    }

    function updatePlayerFavBtn() {
        playerFavBtn.classList.toggle('is-fav', isFavorite(currentPlayerUrl));
    }

    playerFavBtn.addEventListener('click', function () {
        toggleFavorite(currentPlayerUrl);
        updatePlayerFavBtn();
        var cardFav = channelGrid.querySelector('.card-fav[data-fav-url="' + encodeURIComponent(currentPlayerUrl) + '"]');
        if (cardFav) cardFav.classList.toggle('is-fav', isFavorite(currentPlayerUrl));
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
        if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    }

    playerClose.addEventListener('click', closePlayer);
    playerBackdrop.addEventListener('click', closePlayer);
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && playerModal.classList.contains('open')) closePlayer();
    });

    // ===================== SIDEBAR TOGGLE =====================
    function closeSidebar() {
        sidebar.classList.remove('open');
        sidebarOverlay.classList.remove('visible');
    }
    sidebarToggle.addEventListener('click', function () {
        sidebar.classList.toggle('open');
        sidebarOverlay.classList.toggle('visible');
    });
    sidebarOverlay.addEventListener('click', closeSidebar);

    // ===================== INIT =====================
    init();

})();
