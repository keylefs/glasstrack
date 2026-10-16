// ==========================================
// 1. BASE DE DATOS INDEXEDDB Y ESTADO GLOBAL
// ==========================================
let db;
const dbRequest = indexedDB.open("MusicPlayerDB", 5);
const GLASSTRACK_INITIALIZED_KEY = 'glasstrack_initialized';
const GLASSTRACK_LIBRARY_COUNT_PREFIX = 'glasstrack_library_count_v1_';
let libraryLoadGeneration = 0;
let libraryPersistenceRetryAttempted = false;

function libraryCountStorageKey(profileId) {
  return GLASSTRACK_LIBRARY_COUNT_PREFIX + encodeURIComponent(String(profileId || 'guest'));
}
function saveLibraryCountHint(profileId, count) {
  try {
    const safeCount = Math.max(0, Number(count) || 0);
    localStorage.setItem(libraryCountStorageKey(profileId), String(safeCount));
    if (safeCount > 0) localStorage.setItem('glasstrack_library_had_songs_v1', 'true');
  } catch (_) {}
}
function refreshLibraryCountHint(profileId = activeProfileId) {
  return new Promise(resolve => {
    if (!db || !db.objectStoreNames.contains('songs')) { resolve(null); return; }
    let tx;
    let count = 0;
    try {
      tx = db.transaction(['songs'], 'readonly');
      const request = tx.objectStore('songs').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          saveLibraryCountHint(profileId, count);
          resolve(count);
          return;
        }
        const song = cursor.value;
        if ((song.accountId || GLASSTRACK_GUEST_ID) === profileId) count++;
        cursor.continue();
      };
      request.onerror = () => resolve(null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch (_) { resolve(null); }
  });
}

function retryPersistentStorageAfterUserAction() {
  if (libraryPersistenceRetryAttempted) return;
  libraryPersistenceRetryAttempted = true;
  try {
    if (localStorage.getItem('glasstrack_storage_persisted') === 'true') return;
  } catch (_) {}
  requestPersistentStorage().then(granted => {
    if (!granted) console.info('El navegador no concedió almacenamiento persistente tras añadir música. La biblioteca seguirá usando IndexedDB, pero Chrome aún podría limpiar datos del sitio en condiciones excepcionales.');
  }).catch(() => {});
}

async function requestPersistentStorage() {
  try {
    if (!navigator.storage || typeof navigator.storage.persist !== 'function') {
      return false;
    }

    if (typeof navigator.storage.persisted === 'function') {
      const alreadyPersistent = await navigator.storage.persisted();
      if (alreadyPersistent) {
        localStorage.setItem('glasstrack_storage_persisted', 'true');
        return true;
      }
    }

    const granted = await navigator.storage.persist();
    localStorage.setItem(
      'glasstrack_storage_persisted',
      granted ? 'true' : 'false'
    );
    return granted;
  } catch (error) {
    console.warn('No se pudo solicitar almacenamiento persistente:', error);
    return false;
  }
}

// La inicialización se marca una sola vez. Este build no inyecta canciones de prueba;
// la marca impide que futuras rutinas de seed vuelvan a poblar la biblioteca después
// de un refresco o una recarga.
function ensureGlasstrackInitialized() {
  if (localStorage.getItem(GLASSTRACK_INITIALIZED_KEY) !== 'true') {
    localStorage.setItem(GLASSTRACK_INITIALIZED_KEY, 'true');
  }
}

// El auto-scroll de letras se "peleaba" con el scroll manual del usuario (lo forzaba
// de vuelta arriba). Ahora, si el usuario desplaza a mano, dejamos de auto-scrollear
// durante 4 segundos para que pueda leer el resto de la letra con libertad.
let lyricsUserScrollUntil = 0;
let lyricsProgrammaticScrollUntil = 0;
let lastLyricsLineIndex = -1;
let lastCinemaLyricsLineIndex = -1;
function autoScrollLyricsLine(el) {
  if (!el || Date.now() < lyricsUserScrollUntil) return;
  lyricsProgrammaticScrollUntil = Date.now() + 700;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function watchManualLyricsScroll(container) {
  if (!container) return;
  container.addEventListener('scroll', () => {
    if (Date.now() < lyricsProgrammaticScrollUntil) return; // fue nuestro propio auto-scroll
    lyricsUserScrollUntil = Date.now() + 4000;
  }, { passive: true });
}

// Formato de tiempo centralizado (MM:SS) — con protección para que nunca salga
// un número raro (NaN, infinito, etc.) en ningún contador de la app.
function formatTime(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds) || !isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m + ':' + ('0' + s).slice(-2);
}

dbRequest.onupgradeneeded = (e) => {
  db = e.target.result;
  if (!db.objectStoreNames.contains("songs")) {
    db.createObjectStore("songs", { keyPath: "id", autoIncrement: true });
  }
  // Nuevo en la versión 2: guarda el fondo de pantalla (imagen/video) para que
  // sobreviva a recargar la página, en vez de perderse siempre.
  if (!db.objectStoreNames.contains("settings")) {
    db.createObjectStore("settings", { keyPath: "key" });
  }
  // Versión 3: blobs de videos/GIF locales del Modo Estudio Y2K Stream.
  if (!db.objectStoreNames.contains("streamMedia")) {
    db.createObjectStore("streamMedia", { keyPath: "slot" });
  }
  // Versión 4: charts del Modo Ritmo, uno por canción.
  if (!db.objectStoreNames.contains("charts")) {
    db.createObjectStore("charts", { keyPath: "songId" });
  }
};

dbRequest.onsuccess = (e) => {
  db = e.target.result;
  // Mantener la base existente: no se borra ni se recrea la biblioteca entre versiones.
  db.onversionchange = () => {
    try { db.close(); } catch (_) {}
    showToast('Glasstrack detectó otra versión de la base de datos. Recarga la aplicación para continuar.', 'warning', 5000);
  };
  requestPersistentStorage().then(granted => {
    if (!granted) console.info('El navegador no confirmó almacenamiento persistente; conserva una copia de seguridad de la biblioteca.');
  }).catch(() => {});
  loadStoredSongs();
  loadStoredBackground();
};

dbRequest.onerror = (e) => {
  console.error('Error al abrir IndexedDB:', e);
  showToast('No se pudo abrir la biblioteca local. No borres los datos del navegador; revisa permisos y espacio de almacenamiento.', 'error', 6000);
};
dbRequest.onblocked = () => {
  showToast('La biblioteca está abierta en otra pestaña o versión. Cierra las otras pestañas de Glasstrack y vuelve a intentarlo.', 'warning', 5000);
};

// ==========================================
// SISTEMA DE CUENTAS V2 — PERFILES LOCALES
// ==========================================
const GLASSTRACK_ACCOUNTS_KEY = 'glasstrackAccountsV2';
const GLASSTRACK_ACTIVE_PROFILE_KEY = 'glasstrackActiveProfileId';
const GLASSTRACK_SESSION_KEY = 'glasstrackSessionActive';
const GLASSTRACK_GUEST_ID = 'guest';
const GLASSTRACK_MAX_ACCOUNTS = 6; // 1 principal + 5 cuentas adicionales
const GLASSTRACK_PROFILE_PREFIX = 'glasstrack.profile.';
const PROFILE_SCOPED_KEYS = [
  'playlistsDB', 'listeningStats', 'totalPlayedSeconds', 'concludorChain'
];

function profileStorageKey(key, profileId = activeProfileId) {
  return `${GLASSTRACK_PROFILE_PREFIX}${profileId}.${key}`;
}

function readProfileValue(key, profileId = activeProfileId, fallback = null) {
  const scoped = localStorage.getItem(profileStorageKey(key, profileId));
  if (scoped !== null) return scoped;
  return fallback !== null ? fallback : localStorage.getItem(key);
}

function writeProfileValue(key, value, profileId = activeProfileId) {
  if (value === undefined || value === null) localStorage.removeItem(profileStorageKey(key, profileId));
  else localStorage.setItem(profileStorageKey(key, profileId), String(value));
}

function parseStoredAccounts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(GLASSTRACK_ACCOUNTS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

function makeLocalAccountId() {
  return `acct_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Migra una cuenta única de la beta anterior al nuevo sistema sin borrar nada.
(function migrateLegacyAccountStore() {
  if (localStorage.getItem(GLASSTRACK_ACCOUNTS_KEY)) return;
  const legacyEmail = localStorage.getItem('glasstrackAccountEmail') || '';
  const legacyName = localStorage.getItem('glasstrackAccountName') || '';
  const legacyHash = localStorage.getItem('glasstrackAccountPasswordHash') || '';
  const legacySalt = localStorage.getItem('glasstrackAccountPasswordSalt') || '';
  const legacyAvatar = localStorage.getItem('glasstrackAccountAvatar') || '🎧';
  const legacyAvatarImage = localStorage.getItem('glasstrackAccountAvatarImage') || '';
  const legacyProtection = localStorage.getItem('glasstrackAccountProtection') !== '0';

  if (!legacyEmail && !legacyName && !legacyHash && !legacyAvatarImage) {
    localStorage.setItem(GLASSTRACK_ACCOUNTS_KEY, '[]');
    return;
  }

  const id = makeLocalAccountId();
  const account = {
    id,
    name: legacyName || legacyEmail.split('@')[0] || 'Usuario',
    email: legacyEmail,
    avatar: legacyAvatar,
    avatarImage: legacyAvatarImage,
    salt: legacySalt,
    hash: legacyHash,
    protection: legacyProtection,
    createdAt: Date.now()
  };
  localStorage.setItem(GLASSTRACK_ACCOUNTS_KEY, JSON.stringify([account]));
  localStorage.setItem(GLASSTRACK_ACTIVE_PROFILE_KEY, id);
  localStorage.setItem(GLASSTRACK_SESSION_KEY, '1');

  // La primera cuenta hereda el estado local que ya existía antes de la beta multi-cuenta.
  ['playlistsDB', 'listeningStats', 'totalPlayedSeconds', 'concludorChain'].forEach(key => {
    const value = localStorage.getItem(key);
    if (value !== null) writeProfileValue(key, value, id);
  });
})();

function getAccountStore() { return parseStoredAccounts(); }
function saveAccountStore(accounts) {
  localStorage.setItem(GLASSTRACK_ACCOUNTS_KEY, JSON.stringify(accounts.slice(0, GLASSTRACK_MAX_ACCOUNTS)));
}
function findAccountById(id) { return getAccountStore().find(a => a.id === id) || null; }
function getInitialProfileId() {
  const stored = localStorage.getItem(GLASSTRACK_ACTIVE_PROFILE_KEY);
  const session = localStorage.getItem(GLASSTRACK_SESSION_KEY) === '1';
  return session && stored && findAccountById(stored) ? stored : GLASSTRACK_GUEST_ID;
}
let activeProfileId = getInitialProfileId();
let accountSessionActive = activeProfileId !== GLASSTRACK_GUEST_ID;

function isGuestProfile() { return activeProfileId === GLASSTRACK_GUEST_ID; }
function currentAccount() { return isGuestProfile() ? null : findAccountById(activeProfileId); }

function saveProfileScopedState(profileId = activeProfileId) {
  try {
    writeProfileValue('playlistsDB', JSON.stringify(playlists || {}), profileId);
    writeProfileValue('listeningStats', JSON.stringify(listeningStats || { daily: {}, bySong: {}, byArtist: {} }), profileId);
    writeProfileValue('totalPlayedSeconds', String(totalPlayedSeconds || 0), profileId);
    writeProfileValue('concludorChain', localStorage.getItem('concludorChain') || '', profileId);
  } catch (err) {
    console.warn('No se pudo guardar el estado de la cuenta:', err);
  }
}

function loadProfileScopedState(profileId = activeProfileId) {
  try {
    const p = readProfileValue('playlistsDB', profileId, '{}');
    playlists = JSON.parse(p || '{}');
  } catch (_) { playlists = {}; }

  totalPlayedSeconds = parseInt(readProfileValue('totalPlayedSeconds', profileId, '0') || '0', 10) || 0;

  try {
    const stats = JSON.parse(readProfileValue('listeningStats', profileId, '{}') || '{}');
    listeningStats = {
      daily: stats.daily || {},
      bySong: stats.bySong || {},
      byArtist: stats.byArtist || {}
    };
  } catch (_) {
    listeningStats = { daily: {}, bySong: {}, byArtist: {} };
  }
  updateTimeStatDisplay?.();
  updateListeningStatsDisplay?.();
}

// Estado general del reproductor
let songList = [];
let playlists = (() => {
  try { return JSON.parse(readProfileValue('playlistsDB', activeProfileId, '{}') || '{}'); }
  catch (_) { return {}; }
})();
let currentIndex = 0;
let selectedSongForMenu = null;
let currentPlaylistView = null;
// Cola de reproducción activa. Navegar por otras pestañas no cambia la cola actual;
// elegir una canción fuera de la playlist sí devuelve la reproducción a la biblioteca.
let activePlaybackPlaylist = null;
let isShuffle = (localStorage.getItem('glasstrack_shuffle') ?? 'true') === 'true';
let loopMode = 0; // 0 = desactivado, 1 = repetir lista, 2 = repetir canción
let isLoop = false;
let currentTab = 'all-songs';
let totalPlayedSeconds = parseInt(readProfileValue('totalPlayedSeconds', activeProfileId, '0') || '0', 10) || 0;
let sleepTimerInterval = null;
let sleepTimeRemaining = 0;
let editingPlaylistName = null;
let sfxEnabled = localStorage.getItem('glasstrack_sfx_enabled') === 'true';
let pendingEditCover = null;
let pendingCalibration = { scale: 100, speed: 1, offset: 0 };
let pendingBpm = null;
let recordingAction = null;

let hotkeys = {
  playPause: 'Space',
  nextTrack: 'ArrowRight',
  prevTrack: 'ArrowLeft',
  toggleFocus: 'KeyF',
  toggleMute: 'KeyM',
  toggleCinema: 'KeyQ',
  toggleLyrics: 'KeyE',
  toggleKaraoke: 'KeyK',
  toggleEQ: 'KeyG',
  toggleVM: 'KeyV',
  toggleShuffle: 'KeyR'
};
try {
  const saved = JSON.parse(localStorage.getItem('glasstrackHotkeys_b52') || '{}');
  Object.keys(hotkeys).forEach(action => { if (typeof saved[action] === 'string' && saved[action]) hotkeys[action] = saved[action]; });
} catch (_) {}

// ==========================================
// 2. REFERENCIAS DOM
// ==========================================
const audio1 = document.getElementById('audio-player-1');
const audio2 = document.getElementById('audio-player-2');
let activeAudio = audio1;

const appLayout = document.getElementById('app-layout');
const playerCard = document.getElementById('player-card');
const playerBgFluid = document.getElementById('player-bg-fluid');
const playBtn = document.getElementById('play');
const playIcon = document.getElementById('play-icon');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const shuffleBtn = document.getElementById('shuffle');
const loopBtn = document.getElementById('loop');
const title = document.getElementById('title');
const artist = document.getElementById('artist');
const cover = document.getElementById('cover');
const btnFav = document.getElementById('btn-fav');

const progressContainer = document.getElementById('progress-container');
const progress = document.getElementById('progress');
const currentTimeEl = document.getElementById('current-time');
const durationEl = document.getElementById('duration');
const volumeSlider = document.getElementById('volume');

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const playlistEl = document.getElementById('playlist');
const btnCreatePlaylist = document.getElementById('btn-create-playlist');
const btnBackPlaylist = document.getElementById('btn-back-playlist');

const playlistViewHeader = document.getElementById('playlist-view-header');
const playlistViewCover = document.getElementById('playlist-view-cover');
const playlistViewTitle = document.getElementById('playlist-view-title');
const btnPlayPlaylist = document.getElementById('btn-play-playlist');
const btnRenamePlaylist = document.getElementById('btn-rename-playlist');
const btnDeletePlaylist = document.getElementById('btn-delete-playlist');

const eqPanel = document.getElementById('eq-panel');
const btnEqToggle = document.getElementById('btn-eq-toggle');
const btnCloseEq = document.getElementById('btn-close-eq');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnFocusMode = document.getElementById('btn-focus-mode');
const btnMiniPlayer = document.getElementById('btn-mini-player');
let miniWin = null;

const modalSettings = document.getElementById('modal-settings');
const btnMainMenu = document.getElementById('btn-main-menu');
const btnCloseSettings = document.getElementById('btn-close-settings');
const settingsMainView = document.getElementById('settings-main-view');

const modalHidden = document.getElementById('modal-hidden');
const hiddenPlaylistEl = document.getElementById('hidden-playlist');
const btnOpenHidden = document.getElementById('btn-open-hidden');
const btnCloseHidden = document.getElementById('btn-close-hidden');

const modalCreatePlaylist = document.getElementById('modal-create-playlist');
const modalPlaylistTitle = document.getElementById('modal-playlist-title');
const btnCloseCreatePlaylist = document.getElementById('btn-close-create-playlist');
const btnSavePlaylist = document.getElementById('btn-save-playlist');
const inputPlaylistName = document.getElementById('input-playlist-name');

const modalSongMenu = document.getElementById('modal-song-menu');
const btnCloseSongMenu = document.getElementById('btn-close-song-menu');
const modalSongTitle = document.getElementById('modal-song-title');
const optEditSong = document.getElementById('opt-edit-song');
const modalEditSong = document.getElementById('modal-edit-song');
const btnCloseEditSong = document.getElementById('btn-close-edit-song');
const editCoverWrapper = document.getElementById('edit-cover-wrapper');
const editCoverPreview = document.getElementById('edit-cover-preview');
const inputEditCover = document.getElementById('input-edit-cover');
const inputEditTitle = document.getElementById('input-edit-title');
const btnSaveSongEdit = document.getElementById('btn-save-song-edit');
const optAddToPlaylist = document.getElementById('opt-add-to-playlist');
const optHideSong = document.getElementById('opt-hide-song');
const txtHideOpt = document.getElementById('txt-hide-opt');
const optDeleteSong = document.getElementById('opt-delete-song');
const optEditMetadata = document.getElementById('opt-edit-metadata');
const optSongMetadata = document.getElementById('opt-song-metadata');
const modalSongMetadata = document.getElementById('modal-song-metadata');
const btnCloseSongMetadata = document.getElementById('btn-close-song-metadata');
const modalSongMetadataEdit = document.getElementById('modal-edit-song-metadata');
const btnCloseSongMetadataEdit = document.getElementById('btn-close-edit-song-metadata');
const songMetadataEditSubtitle = document.getElementById('song-metadata-edit-subtitle');
const songMetadataEditSummary = document.getElementById('song-metadata-edit-summary');
const songMetadataTitle = document.getElementById('song-metadata-title');
const songMetadataSubtitle = document.getElementById('song-metadata-subtitle');
const songMetadataSummary = document.getElementById('song-metadata-summary');
const songMetadataEditor = document.getElementById('song-metadata-editor');
const songMetadataInfo = document.getElementById('song-metadata-info');
const songMetadataFound = document.getElementById('song-metadata-found');
const songMetadataMissing = document.getElementById('song-metadata-missing');
const songMetadataRaw = document.getElementById('song-metadata-raw');
const btnSaveSongMetadata = document.getElementById('btn-save-song-metadata');
const btnDownloadSongFile = document.getElementById('btn-download-song-file');
const btnDownloadSongFileInfo = document.getElementById('btn-download-song-file-info');
const btnExportSongMetadata = document.getElementById('btn-export-song-metadata');
const btnExportSongMetadataInfo = document.getElementById('btn-export-song-metadata-info');

const modalSelectPlaylist = document.getElementById('modal-select-playlist');
const btnCloseSelectPlaylist = document.getElementById('btn-close-select-playlist');
const targetPlaylistsList = document.getElementById('target-playlists-list');

const timerStatusDesc = document.getElementById('timer-status-desc');
const sleepTimerBadge = document.getElementById('sleep-timer-badge');

const lyricsPanel = document.getElementById('lyrics-panel');
const lyricsBg = document.getElementById('lyrics-bg');
const lyricsBody = document.getElementById('lyrics-body');
const btnLyricsToggle = document.getElementById('btn-lyrics-toggle');
const btnCloseLyrics = document.getElementById('btn-close-lyrics');
const btnEditLyrics = document.getElementById('btn-edit-lyrics');
const lyricsEditor = document.getElementById('lyrics-editor');
const lyricsTextarea = document.getElementById('lyrics-textarea');
const btnCinemaMode = document.getElementById('btn-cinema-mode');
const cinemaMode = document.getElementById('cinema-mode');
const cinemaBg = document.getElementById('cinema-bg');
const btnCloseCinema = document.getElementById('btn-close-cinema');
const cinemaCover = document.getElementById('cinema-cover');
const cinemaTitle = document.getElementById('cinema-title');
const cinemaArtist = document.getElementById('cinema-artist');
const cinemaLyricsBody = document.getElementById('cinema-lyrics-body');
const cinemaDecoratedToggle = document.getElementById('cinema-decorated-toggle');
const cinemaLyricsStyleBtn = document.getElementById('btn-cinema-lyrics-style');
const cinemaSongMenuBtn = document.getElementById('btn-cinema-song-menu');
const cinemaFavBtn = document.getElementById('cinema-fav');
const cinemaSpeedBtn = document.getElementById('cinema-speed');
const cinemaSpeedLabel = document.getElementById('cinema-speed-label');
const cinemaVolumeSlider = document.getElementById('cinema-volume');
const cinemaShuffleBtn = document.getElementById('cinema-shuffle');
const cinemaLoopBtn = document.getElementById('cinema-loop');
watchManualLyricsScroll(lyricsBody);
watchManualLyricsScroll(cinemaLyricsBody);
const cinemaPrev = document.getElementById('cinema-prev');
const cinemaPlay = document.getElementById('cinema-play');
const cinemaNext = document.getElementById('cinema-next');
const cinemaPlayIcon = document.getElementById('cinema-play-icon');

const btnVehicleMode = document.getElementById('btn-vehicle-mode');
const vehicleMode = document.getElementById('vehicle-mode');
const btnExitVehicle = document.getElementById('btn-exit-vehicle');
const vehicleCover = document.getElementById('vehicle-cover');
const vehicleTitle = document.getElementById('vehicle-title');
const vehicleArtist = document.getElementById('vehicle-artist');
const vehicleBg = document.getElementById('vehicle-bg');
const vehiclePlayIcon = document.getElementById('vehicle-play-icon');

const btnOpenKaraoke = document.getElementById('btn-open-karaoke');
const btnOpenKaraokeMain = document.getElementById('btn-open-karaoke-main');
const btnConfigureKaraoke = document.getElementById('btn-configure-karaoke');
const karaokeModeEl = document.getElementById('karaoke-mode');
const karaokeTitleEl = document.getElementById('karaoke-title');
const karaokeArtistEl = document.getElementById('karaoke-artist');
const karaokeCoverEl = document.getElementById('karaoke-cover');
const karaokeCoverTitleEl = document.getElementById('karaoke-cover-title');
const karaokeCoverArtistEl = document.getElementById('karaoke-cover-artist');
const karaokeLyricsSimpleBody = document.getElementById('karaoke-lyrics-simple');
const karaokeLyricsCoverBody = document.getElementById('karaoke-lyrics-cover');
const karaokeProgressEl = document.getElementById('karaoke-progress');
const karaokeCurrentTimeEl = document.getElementById('karaoke-current-time');
const karaokeDurationEl = document.getElementById('karaoke-duration');
const karaokeVolumeEl = document.getElementById('karaoke-volume');
const karaokePlayIconEl = document.getElementById('karaoke-play-icon');
const karaokeSettingsModal = document.getElementById('karaoke-settings-modal');

const toggleAnimMaster = document.getElementById('toggle-anim-master');
const toggleAnimGlide = document.getElementById('toggle-anim-glide');
const toggleAnimAddSong = document.getElementById('toggle-anim-add-song');
const toggleAnimModals = document.getElementById('toggle-anim-modals');
const cinemaSeekbarWrapper = document.getElementById('cinema-seekbar-wrapper');
const cinemaCurrentTimeEl = document.getElementById('cinema-current-time');
const cinemaDurationEl = document.getElementById('cinema-duration');
const cinemaProgress = document.getElementById('cinema-progress');
const cinemaProgressContainer = document.getElementById('cinema-progress-container');
const toggleCinemaSeekbar = document.getElementById('toggle-cinema-seekbar');
const toggleShowBar = document.getElementById('toggle-show-bar');
const controlNotificationBar = document.getElementById('control-notification-bar');
const toggleShowIcon = document.getElementById('toggle-show-icon');
const toggleShowName = document.getElementById('toggle-show-name');
const toggleMediaKeys = document.getElementById('toggle-media-keys');
const toggleDecoratedLyrics = document.getElementById('toggle-decorated-lyrics');
const toggleStreamStudio = document.getElementById('toggle-stream-studio');
const btnOpenStreamStudio = document.getElementById('btn-open-stream-studio');
const streamStudioMode = document.getElementById('stream-studio-mode');
const btnStreamStudioClose = document.getElementById('btn-stream-studio-close');
const btnStreamStudioPlay = document.getElementById('btn-stream-play');
const btnStreamStudioPause = document.getElementById('btn-stream-pause');
const btnStreamStudioRestart = document.getElementById('btn-stream-restart');
const btnStreamStudioReset = document.getElementById('btn-stream-reset');
const streamSlotList = document.getElementById('stream-slot-list');
const streamLivePreview = document.getElementById('stream-live-preview');
const streamPreviewClock = document.getElementById('stream-preview-clock');
const streamCurrentSlot = document.getElementById('stream-current-slot');
const streamCurrentMedia = document.getElementById('stream-current-media');
const streamStatus = document.getElementById('stream-studio-status');
const streamPreviewNick = document.getElementById('stream-preview-nick');
const streamPreviewBadge = document.getElementById('stream-preview-badge');
const streamProfilePreview = document.getElementById('stream-profile-preview');
const streamPreviewTitle = document.getElementById('stream-preview-title');
const streamPreviewArtist = document.getElementById('stream-preview-artist');
const streamLyricPreview = document.getElementById('stream-lyric-preview');
const streamMarkerFill = document.getElementById('stream-marker-fill');
const streamMediaA = document.getElementById('stream-media-a');
const streamMediaB = document.getElementById('stream-media-b');
const streamGifA = document.getElementById('stream-gif-a');
const streamGifB = document.getElementById('stream-gif-b');

const inputAudioSpeed = document.getElementById('input-audio-speed');
const liveRunnerIndicator = document.getElementById('audio-speed-runner-live');
const liveRunnerVideo = liveRunnerIndicator ? liveRunnerIndicator.querySelector('.runner-live-video') : null;
const liveRunnerFallback = liveRunnerIndicator ? liveRunnerIndicator.querySelector('.runner-live-fallback') : null;
let runnerPreviewVideo = null;
const audioSpeedVal = document.getElementById('audio-speed-val');
const karaokeSpeedBtn = document.getElementById('karaoke-speed');
const karaokeSpeedLabel = document.getElementById('karaoke-speed-label');
const toggleMonoAudio = document.getElementById('toggle-mono-audio');
const toggleNormalizeVolume = document.getElementById('toggle-normalize-volume');
const toggleFadePlayback = document.getElementById('toggle-fade-playback');
const toggleAutopauseTab = document.getElementById('toggle-autopause-tab');
const toggleResumePosition = document.getElementById('toggle-resume-position');
const toggleBassBoost = document.getElementById('toggle-bass-boost');
const toggle8dAudio = document.getElementById('toggle-8d-audio');
const inputAudioBalance = document.getElementById('input-audio-balance');
const toggleVolumeLimiter = document.getElementById('toggle-volume-limiter');
const btnVmToggle = document.getElementById('btn-vm-toggle');
const vmPanel = document.getElementById('vm-panel');
const inputVoiceLevel = document.getElementById('input-voice-level');
const inputMusicLevel = document.getElementById('input-music-level');
const toggleVmEnabled = document.getElementById('toggle-vm-enabled');
const inputVoiceLevelValue = document.getElementById('input-voice-level-value');
const inputMusicLevelValue = document.getElementById('input-music-level-value');
const btnToggleExternalMixer = document.getElementById('btn-toggle-external-mixer');
const btnCollapseExternalMixer = document.getElementById('btn-collapse-external-mixer');
const externalTrackMixerPanel = document.getElementById('external-track-mixer-panel');
const toggleExternalMix = document.getElementById('toggle-external-mix');
const externalMixerStatus = document.getElementById('external-mixer-status');
const externalVoiceFileInput = document.getElementById('file-external-voice');
const externalMusicFileInput = document.getElementById('file-external-music');
const externalVoiceName = document.getElementById('external-voice-name');
const externalMusicName = document.getElementById('external-music-name');
const externalVoiceDuration = document.getElementById('external-voice-duration');
const externalMusicDuration = document.getElementById('external-music-duration');
const btnReplaceExternalVoice = document.getElementById('btn-replace-external-voice');
const btnClearExternalVoice = document.getElementById('btn-clear-external-voice');
const btnReplaceExternalMusic = document.getElementById('btn-replace-external-music');
const btnClearExternalMusic = document.getElementById('btn-clear-external-music');
const externalVoiceVolume = document.getElementById('external-voice-volume');
const externalMusicVolume = document.getElementById('external-music-volume');
const externalVoiceVolumeValue = document.getElementById('external-voice-volume-value');
const externalMusicVolumeValue = document.getElementById('external-music-volume-value');
const btnCalibrateLyrics = document.getElementById('btn-calibrate-lyrics');
const modalCalibrateLyrics = document.getElementById('modal-calibrate-lyrics');
const btnCloseCalibrate = document.getElementById('btn-close-calibrate');
const calibrateScale = document.getElementById('calibrate-scale');
const calibrateScaleValue = document.getElementById('calibrate-scale-value');
const calibrateSpeed = document.getElementById('calibrate-speed');
const calibrateSpeedValue = document.getElementById('calibrate-speed-value');
const calibrateOffsetBack = document.getElementById('calibrate-offset-back');
const calibrateOffsetForward = document.getElementById('calibrate-offset-forward');
const calibrateOffsetValue = document.getElementById('calibrate-offset-value');
const inputBpm = document.getElementById('input-bpm');
const btnResetBpm = document.getElementById('btn-reset-bpm');
const btnSaveCalibration = document.getElementById('btn-save-calibration');
const btnSaveLyrics = document.getElementById('btn-save-lyrics');
const btnClearLyrics = document.getElementById('btn-clear-lyrics');

const statPlayTimePreview = document.getElementById('stat-play-time-preview');
const statPlayTimeDetail = document.getElementById('stat-play-time-detail');
const statRankBadge = document.getElementById('stat-rank-badge');
const statRankText = document.getElementById('stat-rank-text');
const bgVideo = document.getElementById('bg-video');

// Algunos navegadores pausan solos los videos de fondo para ahorrar batería,
// aunque los estés viendo. Este "vigilante" lo vuelve a poner en marcha si eso pasa.
function ensureBgVideoPlaying() {
  if (bgVideo && bgVideo.src && !bgVideo.classList.contains('bg-video-hidden') && bgVideo.paused) {
    bgVideo.play().catch(() => {});
  }
}
setInterval(ensureBgVideoPlaying, 1500);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) ensureBgVideoPlaying();
});
// Además de revisar cada rato, reaccionamos al instante si el navegador lo pausa o lo "atasca"
['pause', 'stalled', 'suspend', 'waiting'].forEach(evt => {
  bgVideo.addEventListener(evt, () => setTimeout(ensureBgVideoPlaying, 200));
});
const bgCustomImage = document.getElementById('bg-custom-image');
const inputBgImage = document.getElementById('input-bg-image');
const inputBgVideo = document.getElementById('input-bg-video');
const btnRemoveBg = document.getElementById('btn-remove-bg');
const selectFont = document.getElementById('select-font');
const inputCustomColor = document.getElementById('input-custom-color');
const toggleDynamicColor = document.getElementById('toggle-dynamic-color');

// B31 — Tanda 1: referencias de personalización avanzada.
const inputGlassBlur = document.getElementById('input-glass-blur');
const glassBlurVal = document.getElementById('glass-blur-val');
const inputGlassBorder = document.getElementById('input-glass-border');
const glassBorderVal = document.getElementById('glass-border-val');
const inputGlassShadow = document.getElementById('input-glass-shadow');
const glassShadowVal = document.getElementById('glass-shadow-val');
const inputGlassRadius = document.getElementById('input-glass-radius');
const glassRadiusVal = document.getElementById('glass-radius-val');
const selectBgMode = document.getElementById('select-bg-mode');
const inputBgSolidColor = document.getElementById('input-bg-solid-color');
const inputBgGradientA = document.getElementById('input-bg-gradient-a');
const inputBgGradientB = document.getElementById('input-bg-gradient-b');
const selectBgGradientDirection = document.getElementById('select-bg-gradient-direction');
const inputBgDarken = document.getElementById('input-bg-darken');
const bgDarkenVal = document.getElementById('bg-darken-val');
const inputBgBlur = document.getElementById('input-bg-blur');
const bgBlurVal = document.getElementById('bg-blur-val');
const inputBgSaturation = document.getElementById('input-bg-saturation');
const bgSaturationVal = document.getElementById('bg-saturation-val');
const playerCustomControls = {
  topTools: document.getElementById('toggle-player-top-tools'),
  cover: document.getElementById('toggle-player-cover'),
  visualizer: document.getElementById('toggle-player-visualizer'),
  title: document.getElementById('toggle-player-title'),
  artist: document.getElementById('toggle-player-artist'),
  progress: document.getElementById('toggle-player-progress'),
  times: document.getElementById('toggle-player-times'),
  controls: document.getElementById('toggle-player-controls'),
  volume: document.getElementById('toggle-player-volume')
};
const inputPlayerCoverRadius = document.getElementById('input-player-cover-radius');
const playerCoverRadiusVal = document.getElementById('player-cover-radius-val');
const selectPlayerCoverAnimation = document.getElementById('select-player-cover-animation');
const inputPlayerCoverIntensity = document.getElementById('input-player-cover-intensity');
const playerCoverIntensityVal = document.getElementById('player-cover-intensity-val');
const toggleAudioVisualizerForB31 = document.getElementById('toggle-player-visualizer');
const btnFactoryReset = document.getElementById('btn-factory-reset');
const btnAppInfo = document.getElementById('btn-app-info');
const modalAppInfo = document.getElementById('modal-app-info');
const btnCloseAppInfo = document.getElementById('btn-close-app-info');
if (btnAppInfo) btnAppInfo.addEventListener('click', () => { playSFX('open'); openModal(modalAppInfo); });
if (btnCloseAppInfo) btnCloseAppInfo.addEventListener('click', () => { playSFX('close'); closeModal(modalAppInfo); });
if (modalAppInfo) {
  modalAppInfo.addEventListener('click', (e) => {
    if (e.target === modalAppInfo) { playSFX('close'); closeModal(modalAppInfo); }
  });
}

// ==========================================
// MENÚ DEL BOTÓN "+" (Añadir música local / URL / YouTube)
// ==========================================
const btnAddMenuToggle = document.getElementById('btn-add-menu-toggle');
const addMenuPopup = document.getElementById('add-menu-popup');
const optAddLocal = document.getElementById('opt-add-local');
const optAddYoutube = document.getElementById('opt-add-youtube');

function closeAddMenuPopup() {
  if (addMenuPopup) addMenuPopup.classList.remove('open');
  if (btnAddMenuToggle) btnAddMenuToggle.setAttribute('aria-expanded', 'false');
}
function toggleAddMenuPopup() {
  if (!addMenuPopup) return;
  const willOpen = !addMenuPopup.classList.contains('open');
  addMenuPopup.classList.toggle('open', willOpen);
  if (btnAddMenuToggle) btnAddMenuToggle.setAttribute('aria-expanded', String(willOpen));
}
if (btnAddMenuToggle) {
  btnAddMenuToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    playSFX('click');
    toggleAddMenuPopup();
  });
}
if (optAddLocal) optAddLocal.addEventListener('click', () => closeAddMenuPopup());
document.addEventListener('click', (e) => {
  if (addMenuPopup && addMenuPopup.classList.contains('open') && !addMenuPopup.contains(e.target) && e.target !== btnAddMenuToggle) {
    closeAddMenuPopup();
  }
});

// ==========================================
// AÑADIR POR URL / YOUTUBE
// ==========================================
const modalAddUrl = document.getElementById('modal-add-url');
const btnCloseUrlModal = document.getElementById('btn-close-url-modal');
const inputSongUrl = document.getElementById('input-song-url');
const inputSongUrlTitle = document.getElementById('input-song-url-title');
const inputSongUrlArtist = document.getElementById('input-song-url-artist');
const btnAddSongUrl = document.getElementById('btn-add-song-url');
const inputYoutubeSearch = document.getElementById('input-youtube-search');
const btnYoutubeSearchOpen = document.getElementById('btn-youtube-search-open');
const inputYoutubeSearchUrl = document.getElementById('input-youtube-search-url');
const btnAddSongUrlSearch = document.getElementById('btn-add-song-url-search');

function extractYoutubeId(url) {
  const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function saveSongFromUrl(rawUrl, titleOverride, artistOverride) {
  const url = String(rawUrl || '').trim();
  if (!url) { showToast('Pega un enlace primero.', 'error'); return false; }
  const ytId = extractYoutubeId(url);

  const songObj = {
    title: (titleOverride && titleOverride.trim()) || (ytId ? 'Video de YouTube' : 'Canción sin título'),
    artist: (artistOverride && artistOverride.trim()) || 'Artista desconocido',
    cover: ytId ? `https://img.youtube.com/vi/${ytId}/hqdefault.jpg` : 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=500&q=80',
    lyrics: 'No hay letra cargada.',
    isFav: false,
    isHidden: false,
    accountId: activeProfileId
  };

  if (ytId) {
    songObj.sourceType = 'youtube';
    songObj.youtubeId = ytId;
  } else {
    songObj.sourceType = 'url';
    songObj.directUrl = url;
  }

  try {
    await saveSongToDB(songObj);
    songObj.url = ytId ? '' : url;
    songList.push(songObj);
    renderPlaylist();
    if (songList.length === 1 && !ytId) loadSong(songList.length - 1, false);
    return true;
  } catch (error) {
    console.error('No se pudo persistir la canción:', error);
    showToast(error && error.message ? error.message : 'No se pudo guardar la canción en el almacenamiento local.', 'error', 4500);
    return false;
  }
}

if (optAddYoutube) {
  optAddYoutube.disabled = true;
  optAddYoutube.setAttribute('aria-disabled', 'true');
  optAddYoutube.title = 'YouTube está bloqueado temporalmente';
  optAddYoutube.addEventListener('click', (e) => {
    e.preventDefault();
    closeAddMenuPopup();
    showToast('YouTube está bloqueado temporalmente.', 'info', 2200);
  });
}
// La ventana de URL/YouTube queda cerrada en esta base estable.
if (modalAddUrl) closeModal(modalAddUrl);
if (btnCloseUrlModal) btnCloseUrlModal.addEventListener('click', () => { playSFX('close'); closeModal(modalAddUrl); });
if (modalAddUrl) {
  modalAddUrl.addEventListener('click', (e) => { if (e.target === modalAddUrl) { playSFX('close'); closeModal(modalAddUrl); } });
}

document.querySelectorAll('.url-mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    playSFX('click');
    document.querySelectorAll('.url-mode-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const mode = tab.dataset.mode;
    document.querySelectorAll('.url-mode-panel').forEach(p => p.classList.toggle('hidden', p.dataset.modePanel !== mode));
  });
});

if (btnAddSongUrl) {
  btnAddSongUrl.addEventListener('click', async () => {
    const ok = await saveSongFromUrl(inputSongUrl ? inputSongUrl.value : '', inputSongUrlTitle ? inputSongUrlTitle.value : '', inputSongUrlArtist ? inputSongUrlArtist.value : '');
    if (ok) {
      playSFX('click');
      showToast('Canción añadida a tu biblioteca.', 'success');
      if (inputSongUrl) inputSongUrl.value = '';
      if (inputSongUrlTitle) inputSongUrlTitle.value = '';
      if (inputSongUrlArtist) inputSongUrlArtist.value = '';
      closeModal(modalAddUrl);
    }
  });
}

if (btnYoutubeSearchOpen) {
  btnYoutubeSearchOpen.addEventListener('click', () => {
    const q = inputYoutubeSearch ? inputYoutubeSearch.value.trim() : '';
    if (!q) { showToast('Escribe algo para buscar.', 'error'); return; }
    playSFX('click');
    window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, '_blank', 'noopener');
  });
}

if (btnAddSongUrlSearch) {
  btnAddSongUrlSearch.addEventListener('click', async () => {
    const ok = await saveSongFromUrl(inputYoutubeSearchUrl ? inputYoutubeSearchUrl.value : '', null, null);
    if (ok) {
      playSFX('click');
      showToast('Canción añadida a tu biblioteca.', 'success');
      if (inputYoutubeSearchUrl) inputYoutubeSearchUrl.value = '';
      closeModal(modalAddUrl);
    }
  });
}

// ==========================================
// REPRODUCTOR DE YOUTUBE (reproductor oficial embebido)
// ==========================================
const modalYoutubePlayer = document.getElementById('modal-youtube-player');
const youtubeEmbedWrap = document.getElementById('youtube-embed-wrap');
const btnCloseYoutubePlayer = document.getElementById('btn-close-youtube-player');
const youtubePlayerTitle = document.getElementById('youtube-player-title');
const youtubePlayerArtist = document.getElementById('youtube-player-artist');

function openYoutubePlayerModal(song) {
  if (!modalYoutubePlayer || !youtubeEmbedWrap || !song || !song.youtubeId) return;
  // Pausamos el motor de audio local: el video de YouTube trae su propio audio
  // y no puede pasar por el ecualizador/crossfade por restricciones del navegador.
  audio1.pause();
  audio2.pause();
  youtubeEmbedWrap.innerHTML = `<iframe src="https://www.youtube.com/embed/${song.youtubeId}?autoplay=1" title="${(song.title || 'YouTube').replace(/"/g, '')}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
  if (youtubePlayerTitle) youtubePlayerTitle.textContent = song.title || 'YouTube';
  if (youtubePlayerArtist) youtubePlayerArtist.textContent = song.artist || '';
  playSFX('open');
  openModal(modalYoutubePlayer);
}
function closeYoutubePlayerModal() {
  if (youtubeEmbedWrap) youtubeEmbedWrap.innerHTML = '';
  closeModal(modalYoutubePlayer);
}
if (btnCloseYoutubePlayer) btnCloseYoutubePlayer.addEventListener('click', () => { playSFX('close'); closeYoutubePlayerModal(); });
if (modalYoutubePlayer) {
  modalYoutubePlayer.addEventListener('click', (e) => { if (e.target === modalYoutubePlayer) { playSFX('close'); closeYoutubePlayerModal(); } });
}

// ==========================================
// CUENTA / PERFIL LOCAL V2 — SESIÓN + CUENTAS MÚLTIPLES
// ==========================================
const btnAccount = document.getElementById('btn-account');
const btnAccountMobile = document.getElementById('btn-account-mobile');
const modalAccount = document.getElementById('modal-account');
const btnCloseAccount = document.getElementById('btn-close-account');
const accountStatusMsg = document.getElementById('account-status-msg');
const accountWizard = document.getElementById('account-wizard');
const accountWizardNav = document.getElementById('account-wizard-nav');
const accountStepIndicator = document.getElementById('account-step-indicator');
const btnAccountSave = document.getElementById('btn-account-save');
const btnAccountNext = document.getElementById('btn-account-next');
const btnAccountBack = document.getElementById('btn-account-back');
const inputAccountName = document.getElementById('input-account-name');
const inputAccountEmail = document.getElementById('input-account-email');
const inputAccountPassword = document.getElementById('input-account-password');
const inputAccountPasswordConfirm = document.getElementById('input-account-password-confirm');
const accountWelcomeName = document.getElementById('account-welcome-name');
const accountWelcomeMessage = document.getElementById('account-welcome-message');
const accountDisplayName = document.getElementById('account-display-name');
const accountDisplayEmail = document.getElementById('account-display-email');
const accountAvatarPreview = document.getElementById('account-avatar-preview');
const accountFinalAvatar = document.getElementById('account-final-avatar');
const accountFinalName = document.getElementById('account-final-name');
const accountFinalEmail = document.getElementById('account-final-email');
const accountPasswordStrength = document.getElementById('account-password-strength');
const accountPasswordStrengthFill = document.getElementById('account-password-strength-fill');
const toggleAccountProtection = document.getElementById('toggle-account-protection');
const avatarPicker = document.getElementById('avatar-picker');
const avatarUploadBtn = document.getElementById('avatar-upload-btn');
const avatarUploadInput = document.getElementById('avatar-upload-input');
const accountUnlockPanel = document.getElementById('account-unlock-panel');
const accountUnlockInput = document.getElementById('input-account-unlock');
const btnAccountUnlock = document.getElementById('btn-account-unlock');
const accountUnlockMsg = document.getElementById('account-unlock-msg');
const accountDashboard = document.getElementById('account-dashboard');
const accountDashboardName = document.getElementById('account-dashboard-name');
const accountDashboardEmail = document.getElementById('account-dashboard-email');
const accountDashboardAvatar = document.getElementById('account-dashboard-avatar');
const accountDashboardMusic = document.getElementById('account-dashboard-music');
const accountEditPanel = document.getElementById('account-edit-panel');
const accountEditName = document.getElementById('account-edit-name');
const accountEditEmail = document.getElementById('account-edit-email');
const accountNewPassword = document.getElementById('account-new-password');
const accountNewPasswordConfirm = document.getElementById('account-new-password-confirm');
const btnAccountEditSave = document.getElementById('btn-account-edit-save');
const btnAccountEditCancel = document.getElementById('btn-account-edit-cancel');
const btnAccountEdit = document.getElementById('btn-account-edit');
const btnAccountSwitch = document.getElementById('btn-account-switch');
const btnAccountLogout = document.getElementById('btn-account-logout');
const accountSwitchPanel = document.getElementById('account-switch-panel');
const accountSwitchList = document.getElementById('account-switch-list');
const btnAccountSwitchGuest = document.getElementById('btn-account-switch-guest');
const btnAccountAdd = document.getElementById('btn-account-add');
const accountUnlockTitle = document.getElementById('account-unlock-title');
const accountUnlockText = document.getElementById('account-unlock-text');
const accountWelcomeToastKeyPrefix = 'glasstrackWelcomeShown.';

let accountWizardStep = 1;
let accountDraft = { name: '', email: '', avatar: '🎧', avatarImage: '', protection: true };
let accountUnlockPurpose = '';
let accountUnlockTargetId = '';
let accountEditingId = '';

function bytesToHex(bytes) { return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''); }
function createAccountSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}
async function hashAccountPassword(password, salt) {
  if (!window.crypto?.subtle || !window.TextEncoder) throw new Error('Este navegador no dispone de Web Crypto.');
  const source = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', source);
  return bytesToHex(new Uint8Array(digest));
}
async function verifyAccountPassword(account, password) {
  if (!account?.hash || !account?.salt || !password) return false;
  return (await hashAccountPassword(password, account.salt)) === account.hash;
}
function passwordStrength(password) {
  const p = String(password || '');
  if (!p) return { score: 0, label: 'Mínimo 8 caracteres' };
  let score = 0;
  if (p.length >= 8) score++;
  if (p.length >= 12) score++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++;
  if (/\d/.test(p)) score++;
  if (/[^A-Za-z0-9]/.test(p)) score++;
  const labels = ['Muy débil', 'Débil', 'Aceptable', 'Fuerte', 'Muy fuerte'];
  return { score: Math.min(score, 5), label: labels[Math.min(score, 4)] };
}
function updatePasswordStrength() {
  const data = passwordStrength(accountNewPassword?.value || inputAccountPassword?.value || '');
  if (accountPasswordStrength) accountPasswordStrength.textContent = data.label;
  if (accountPasswordStrengthFill) accountPasswordStrengthFill.style.width = `${data.score * 20}%`;
}
function escapeAccountText(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function setAvatarElement(el, value) {
  if (!el) return;
  el.textContent = '';
  if (value && /^data:image\//i.test(value)) {
    const img = document.createElement('img'); img.src = value; img.alt = 'Foto de perfil'; el.appendChild(img);
  } else el.textContent = value || '🎧';
}
function getDraftAvatar() { return accountDraft.avatarImage || accountDraft.avatar || '🎧'; }
function refreshAccountStatus() {
  const acc = currentAccount();
  if (accountDashboard) accountDashboard.classList.toggle('hidden', !acc || !accountSessionActive);
  if (accountWizard) accountWizard.classList.toggle('hidden', true);
  if (accountWizardNav) accountWizardNav.classList.add('hidden');
  if (accountUnlockPanel) accountUnlockPanel.classList.add('hidden');
  if (accountEditPanel) accountEditPanel.classList.add('hidden');
  if (accountSwitchPanel) accountSwitchPanel.classList.add('hidden');
  if (!acc) return;
  const name = acc.name || (acc.email || '').split('@')[0] || 'Usuario';
  if (accountDashboardName) accountDashboardName.textContent = name;
  if (accountDashboardEmail) accountDashboardEmail.textContent = acc.email || 'Sin correo';
  setAvatarElement(accountDashboardAvatar, acc.avatarImage || acc.avatar);
  if (accountDashboardMusic) accountDashboardMusic.textContent = `${songList.length} ${songList.length === 1 ? 'canción' : 'canciones'} en esta cuenta`;
  if (accountStatusMsg) accountStatusMsg.textContent = `Sesión guardada en este dispositivo como ${name}.`;
  if (btnAccountAdd) btnAccountAdd.disabled = getAccountStore().length >= GLASSTRACK_MAX_ACCOUNTS;
}
function showOneTimeWelcome(acc, force = false) {
  if (!acc) return;
  const key = accountWelcomeToastKeyPrefix + acc.id;
  if (!force && localStorage.getItem(key) === '1') return;
  localStorage.setItem(key, '1');
  showToast(`Hola, ${acc.name}. Tu cuenta está lista.`, 'success', 3000);
}
function renderAccountDashboard() { refreshAccountStatus(); }
function hideAccountPanels() {
  [accountDashboard, accountUnlockPanel, accountEditPanel, accountSwitchPanel, accountWizard, accountWizardNav].forEach(el => { if (el) el.classList.add('hidden'); });
}
function openUnlock(purpose, targetId = activeProfileId) {
  accountUnlockPurpose = purpose;
  accountUnlockTargetId = targetId;
  accountUnlockPanel?.classList.remove('hidden');
  accountDashboard?.classList.add('hidden');
  accountEditPanel?.classList.add('hidden');
  accountSwitchPanel?.classList.add('hidden');
  if (accountUnlockInput) accountUnlockInput.value = '';
  if (accountUnlockTitle) accountUnlockTitle.textContent = purpose === 'switch' ? 'Cambiar de cuenta' : 'Editar cuenta';
  if (accountUnlockText) accountUnlockText.textContent = purpose === 'switch'
    ? 'Escribe la contraseña de la cuenta que quieres abrir.'
    : 'Primero confirma tu contraseña actual para modificar nombre, correo o contraseña.';
  if (accountUnlockMsg) accountUnlockMsg.textContent = '';
  accountUnlockInput?.focus();
}
function openAccountEdit() {
  const acc = currentAccount();
  if (!acc) return;
  accountEditingId = acc.id;
  openUnlock('edit', acc.id);
}
function openAccountSwitch() {
  accountUnlockPanel?.classList.add('hidden');
  accountDashboard?.classList.add('hidden');
  accountEditPanel?.classList.add('hidden');
  accountSwitchPanel?.classList.remove('hidden');
  renderAccountSwitchList();
}
function renderAccountSwitchList() {
  if (!accountSwitchList) return;
  accountSwitchList.innerHTML = '';
  const accounts = getAccountStore();
  accounts.forEach(acc => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'account-switch-row';
    row.dataset.accountId = acc.id;
    row.innerHTML = `<span class="account-switch-avatar"></span><span class="account-switch-copy"><strong>${escapeAccountText(acc.name || 'Usuario')}</strong><small>${escapeAccountText(acc.email || '')}</small></span><span class="account-switch-lock">🔒</span>`;
    setAvatarElement(row.querySelector('.account-switch-avatar'), acc.avatarImage || acc.avatar);
    row.addEventListener('click', () => openUnlock('switch', acc.id));
    accountSwitchList.appendChild(row);
  });
  if (accounts.length >= GLASSTRACK_MAX_ACCOUNTS && btnAccountAdd) btnAccountAdd.textContent = 'Límite alcanzado (6 cuentas)';
  else if (btnAccountAdd) btnAccountAdd.textContent = '+ Agregar cuenta';
}
function openNewAccountWizard() {
  const count = getAccountStore().length;
  if (count >= GLASSTRACK_MAX_ACCOUNTS) { showToast('Ya tienes 6 cuentas locales. El límite beta es 6.', 'info'); return; }
  accountDraft = { name: '', email: '', avatar: '🎧', avatarImage: '', protection: true };
  accountWizardStep = 1;
  hideAccountPanels();
  accountWizard?.classList.remove('hidden');
  accountWizardNav?.classList.remove('hidden');
  renderAccountStep();
}
function loadAccountDraftFromAccount(acc) {
  accountDraft = { name: acc.name || '', email: acc.email || '', avatar: acc.avatar || '🎧', avatarImage: acc.avatarImage || '', protection: acc.protection !== false };
  if (inputAccountName) inputAccountName.value = accountDraft.name;
  if (inputAccountEmail) inputAccountEmail.value = accountDraft.email;
  if (inputAccountPassword) inputAccountPassword.value = '';
  if (inputAccountPasswordConfirm) inputAccountPasswordConfirm.value = '';
  toggleAccountProtection && (toggleAccountProtection.checked = accountDraft.protection);
}
function renderAccountStep() {
  accountWizard?.querySelectorAll('.account-step[data-account-step]').forEach(step => step.classList.toggle('active', Number(step.dataset.accountStep) === accountWizardStep));
  accountWizard?.querySelectorAll('.account-progress-dot[data-progress-step]').forEach(dot => dot.classList.toggle('active', Number(dot.dataset.progressStep) <= accountWizardStep));
  if (accountStepIndicator) accountStepIndicator.textContent = `Paso ${accountWizardStep} de 4`;
  if (btnAccountBack) btnAccountBack.textContent = accountWizardStep === 1 ? 'Cerrar' : 'Atrás';
  btnAccountNext?.classList.toggle('hidden', accountWizardStep === 4);
  btnAccountSave?.classList.toggle('hidden', accountWizardStep !== 4);
}
async function validateAccountStep(step) {
  if (step === 1) {
    if ((inputAccountName?.value.trim() || '').length < 2) { showToast('Escribe un nombre de al menos 2 caracteres.', 'error'); return false; }
  }
  if (step === 3) {
    const email = inputAccountEmail?.value.trim() || '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showToast('Escribe un correo válido.', 'error'); return false; }
    const password = inputAccountPassword?.value || '';
    const confirm = inputAccountPasswordConfirm?.value || '';
    if (password.length < 8) { showToast('Crea una contraseña de al menos 8 caracteres.', 'error'); return false; }
    if (password !== confirm) { showToast('Las contraseñas no coinciden.', 'error'); return false; }
  }
  return true;
}
async function commitNewAccount() {
  if (!(await validateAccountStep(3))) { accountWizardStep = 3; renderAccountStep(); return; }
  const name = inputAccountName?.value.trim().slice(0, 24) || '';
  const email = inputAccountEmail?.value.trim() || '';
  const password = inputAccountPassword?.value || '';
  const confirm = inputAccountPasswordConfirm?.value || '';
  if (!name || !email || password !== confirm) return;
  const accounts = getAccountStore();
  if (accounts.some(a => String(a.email || '').toLowerCase() === email.toLowerCase())) { showToast('Ese correo ya está asociado a otra cuenta local.', 'error'); return; }
  try {
    const salt = createAccountSalt();
    const hash = await hashAccountPassword(password, salt);
    const account = {
      id: makeLocalAccountId(), name, email,
      avatar: accountDraft.avatar || '🎧', avatarImage: accountDraft.avatarImage || '',
      salt, hash, protection: accountDraft.protection !== false, createdAt: Date.now()
    };
    accounts.push(account);
    saveAccountStore(accounts);
    // La cuenta recién creada se convierte en la sesión activa.
    await switchActiveProfile(account.id, { silent: true });
    loadAccountDraftFromAccount(account);
    if (inputAccountPassword) inputAccountPassword.value = '';
    if (inputAccountPasswordConfirm) inputAccountPasswordConfirm.value = '';
    hideAccountPanels();
    renderAccountDashboard();
    showOneTimeWelcome(account, true);
  } catch (err) {
    console.error(err);
    showToast(err.message || 'No se pudo crear la cuenta.', 'error');
  }
}
async function saveEditedAccount() {
  const acc = currentAccount();
  if (!acc || accountEditingId !== acc.id) return;
  const name = accountEditName?.value.trim().slice(0, 24) || '';
  const email = accountEditEmail?.value.trim() || '';
  const newPassword = accountNewPassword?.value || '';
  const confirm = accountNewPasswordConfirm?.value || '';
  if (name.length < 2) { showToast('El nombre debe tener al menos 2 caracteres.', 'error'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showToast('Escribe un correo válido.', 'error'); return; }
  const accounts = getAccountStore();
  if (accounts.some(a => a.id !== acc.id && String(a.email || '').toLowerCase() === email.toLowerCase())) { showToast('Ese correo ya está en uso por otra cuenta.', 'error'); return; }
  if (newPassword && (newPassword.length < 8 || newPassword !== confirm)) { showToast('La nueva contraseña debe tener 8 caracteres y coincidir.', 'error'); return; }
  acc.name = name; acc.email = email;
  if (toggleAccountProtection) acc.protection = toggleAccountProtection.checked;
  if (newPassword) { acc.salt = createAccountSalt(); acc.hash = await hashAccountPassword(newPassword, acc.salt); }
  saveAccountStore(accounts);
  hideAccountPanels();
  renderAccountDashboard();
  showToast('Cuenta actualizada correctamente.', 'success', 2200);
  if (accountDashboardName) accountDashboardName.textContent = acc.name;
  if (accountDashboardEmail) accountDashboardEmail.textContent = acc.email;
}
async function handleAccountUnlock() {
  const target = findAccountById(accountUnlockTargetId);
  if (!target) return;
  const password = accountUnlockInput?.value || '';
  try {
    if (!(await verifyAccountPassword(target, password))) {
      if (accountUnlockMsg) accountUnlockMsg.textContent = 'Contraseña incorrecta.';
      showToast('Contraseña incorrecta.', 'error');
      return;
    }
    if (accountUnlockPurpose === 'switch') {
      hideAccountPanels();
      await switchActiveProfile(target.id, { silent: true });
      renderAccountDashboard();
      showOneTimeWelcome(target);
    } else {
      accountEditingId = target.id;
      accountEditName && (accountEditName.value = target.name || '');
      accountEditEmail && (accountEditEmail.value = target.email || '');
      accountNewPassword && (accountNewPassword.value = '');
      accountNewPasswordConfirm && (accountNewPasswordConfirm.value = '');
      toggleAccountProtection && (toggleAccountProtection.checked = target.protection !== false);
      hideAccountPanels();
      accountEditPanel?.classList.remove('hidden');
      updatePasswordStrength();
    }
  } catch (err) {
    console.error(err);
    showToast(err.message || 'No se pudo verificar la contraseña.', 'error');
  }
}
function logoutAccount() {
  const acc = currentAccount();
  saveProfileScopedState(activeProfileId);
  clearCurrentTrackUI();
  songList = [];
  currentPlaylistView = null;
  activeProfileId = GLASSTRACK_GUEST_ID;
  accountSessionActive = false;
  localStorage.setItem(GLASSTRACK_ACTIVE_PROFILE_KEY, GLASSTRACK_GUEST_ID);
  localStorage.setItem(GLASSTRACK_SESSION_KEY, '0');
  loadProfileScopedState(GLASSTRACK_GUEST_ID);
  loadStoredSongs();
  renderPlaylist();
  openAccountSwitch();
  showToast(acc ? `Sesión cerrada. Ahora estás como Invitado.` : 'Modo invitado activo.', 'info', 2200);
}
function normalizeAccountModalStyles() {
  if (!modalAccount) return;
  ['z-index', 'visibility', 'opacity', 'pointer-events', 'display', 'position', 'inset', 'align-items', 'justify-content'].forEach((property) => {
    modalAccount.style.removeProperty(property);
  });
}

function closeAccountDialog() {
  if (!modalAccount) return;
  hideAccountPanels();
  modalAccount.classList.remove('active', 'opening');
  modalAccount.classList.add('closed');
  modalAccount.setAttribute('aria-hidden', 'true');
  modalAccount.inert = true;
  if (btnAccountMobile) btnAccountMobile.setAttribute('aria-expanded', 'false');
  if (btnAccount) btnAccount.setAttribute('aria-expanded', 'false');
  // No conservar estilos inline forzados al abrir desde móvil: podrían dejar
  // el overlay visualmente presente o interceptando eventos tras quitar .active.
  normalizeAccountModalStyles();
  modalAccount.style.removeProperty('display');
}

function openAccount() {
  if (!modalAccount) return;
  // Normaliza posibles residuos de aperturas/cierres anteriores.
  normalizeAccountModalStyles();
  modalAccount.classList.remove('hidden', 'closed');
  modalAccount.removeAttribute('hidden');
  modalAccount.removeAttribute('inert');
  modalAccount.inert = false;
  modalAccount.setAttribute('aria-hidden', 'false');

  hideAccountPanels();
  const acc = currentAccount();
  if (acc && accountSessionActive) {
    renderAccountDashboard();
  } else if (getAccountStore().length > 0) {
    openAccountSwitch();
    // La navegación del asistente solo se muestra cuando el asistente está visible.
    accountWizardNav?.classList.add('hidden');
  } else {
    openNewAccountWizard();
    if (accountWizard) {
      accountWizard.classList.remove('hidden');
      if (accountWizardStep < 1 || accountWizardStep > 4) accountWizardStep = 1;
      renderAccountStep();
    }
    accountWizardNav?.classList.remove('hidden');
  }

  // Guardia contra el estado que producía el panel vacío con solo Atrás/Continuar.
  if (accountWizard?.classList.contains('hidden')) accountWizardNav?.classList.add('hidden');
  modalAccount.classList.add('active');
  modalAccount.setAttribute('aria-hidden', 'false');
  if (btnAccountMobile) btnAccountMobile.setAttribute('aria-expanded', 'true');
  if (btnAccount) btnAccount.setAttribute('aria-expanded', 'true');
}

if (btnAccount) btnAccount.addEventListener('click', (event) => {
  event.preventDefault();
  openAccount();
});
// Móvil reutiliza el flujo de cuenta existente; no fuerza estilos inline persistentes.
if (btnAccountMobile) {
  btnAccountMobile.type = 'button';
  btnAccountMobile.setAttribute('aria-haspopup', 'dialog');
  btnAccountMobile.setAttribute('aria-controls', 'modal-account');
  btnAccountMobile.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      openAccount();
    } catch (error) {
      console.error('No se pudo abrir la ventana de cuenta móvil:', error);
      if (typeof showToast === 'function') showToast('No se pudo abrir Cuenta. Vuelve a intentarlo.', 'error', 2600);
    }
  });
}
if (btnCloseAccount) btnCloseAccount.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  playSFX('close');
  closeAccountDialog();
});
if (modalAccount) modalAccount.addEventListener('click', e => {
  if (e.target === modalAccount) {
    playSFX('close');
    closeAccountDialog();
  }
});

if (btnAccountNext) btnAccountNext.addEventListener('click', async () => {
  if (!(await validateAccountStep(accountWizardStep))) return;
  if (accountWizardStep < 4) accountWizardStep++;
  renderAccountStep(); playSFX('click');
});
if (btnAccountBack) btnAccountBack.addEventListener('click', () => {
  if (accountWizardStep <= 1) { closeAccountDialog(); return; }
  accountWizardStep--; renderAccountStep(); playSFX('click');
});
if (btnAccountSave) btnAccountSave.addEventListener('click', commitNewAccount);
if (btnAccountUnlock) btnAccountUnlock.addEventListener('click', handleAccountUnlock);
if (accountUnlockInput) accountUnlockInput.addEventListener('keydown', e => { if (e.key === 'Enter') btnAccountUnlock?.click(); });
if (btnAccountEdit) btnAccountEdit.addEventListener('click', openAccountEdit);
if (btnAccountSwitch) btnAccountSwitch.addEventListener('click', openAccountSwitch);
if (btnAccountLogout) btnAccountLogout.addEventListener('click', logoutAccount);
if (btnAccountAdd) btnAccountAdd.addEventListener('click', openNewAccountWizard);
if (btnAccountSwitchGuest) btnAccountSwitchGuest.addEventListener('click', () => { hideAccountPanels(); switchActiveProfile(GLASSTRACK_GUEST_ID, { silent: true }); renderAccountDashboard(); showToast('Modo invitado activo.', 'info', 1800); });
if (btnAccountEditCancel) btnAccountEditCancel.addEventListener('click', () => { hideAccountPanels(); renderAccountDashboard(); });
if (btnAccountEditSave) btnAccountEditSave.addEventListener('click', saveEditedAccount);

if (inputAccountName) inputAccountName.addEventListener('input', () => {
  const name = inputAccountName.value.trim() || 'Invitado';
  if (accountWelcomeName) accountWelcomeName.textContent = `Hola, ${name}`;
  if (accountWelcomeMessage) accountWelcomeMessage.textContent = inputAccountName.value.trim() ? `Qué bueno tenerte, ${name}. Vamos a dejar tu perfil listo.` : 'Vamos a preparar tu perfil para que Glasstrack Pro te reconozca en este dispositivo.';
});
if (inputAccountPassword) inputAccountPassword.addEventListener('input', updatePasswordStrength);
if (accountNewPassword) accountNewPassword.addEventListener('input', updatePasswordStrength);
if (inputAccountEmail) inputAccountEmail.addEventListener('input', e => { if (accountFinalEmail) accountFinalEmail.textContent = e.target.value.trim() || 'Sin correo'; });

if (avatarPicker) avatarPicker.addEventListener('click', e => {
  const btn = e.target.closest('.avatar-option[data-avatar]');
  if (!btn) return;
  accountDraft.avatar = btn.dataset.avatar || '🎧'; accountDraft.avatarImage = '';
  setAvatarElement(accountAvatarPreview, getDraftAvatar()); setAvatarElement(accountFinalAvatar, getDraftAvatar());
  syncAvatarPicker(); playSFX('click');
});
function syncAvatarPicker() {
  avatarPicker?.querySelectorAll('.avatar-option[data-avatar]').forEach(btn => btn.classList.toggle('selected', !accountDraft.avatarImage && btn.dataset.avatar === accountDraft.avatar));
  const upload = document.getElementById('avatar-upload-btn');
  if (upload) upload.classList.toggle('selected', !!accountDraft.avatarImage);
}
if (avatarUploadBtn && avatarUploadInput) avatarUploadBtn.addEventListener('click', () => avatarUploadInput.click());
if (avatarUploadInput) avatarUploadInput.addEventListener('change', () => {
  const file = avatarUploadInput.files?.[0]; avatarUploadInput.value = '';
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const size = 160, canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d'), side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side)/2, (img.height - side)/2, side, side, 0, 0, size, size);
      accountDraft.avatarImage = canvas.toDataURL('image/jpeg', 0.82); accountDraft.avatar = '';
      setAvatarElement(accountAvatarPreview, accountDraft.avatarImage); setAvatarElement(accountFinalAvatar, accountDraft.avatarImage); syncAvatarPicker();
      showToast('Foto lista.', 'info', 1800);
    };
    img.src = String(reader.result || '');
  };
  reader.readAsDataURL(file);
});
if (toggleAccountProtection) toggleAccountProtection.addEventListener('change', () => playSFX('click'));

// Se inicia automáticamente con la última cuenta guardada; la bienvenida solo aparece una vez.
if (accountSessionActive && currentAccount()) {
  const initial = currentAccount();
  showOneTimeWelcome(initial);
}
refreshAccountStatus();

// ==========================================
// COLOR DE INTERFAZ UNIVERSAL + ICONOS EN NEGRO
// ==========================================
const toggleForceBlackIcons = document.getElementById('toggle-force-black-icons');
function applyAccentColor(color) {
  if (!color) return;
  document.documentElement.style.setProperty('--primary-color', color);
  document.documentElement.style.setProperty('--accent-color', color);
  localStorage.setItem('glasstrackAccentColor', color);
  // Elegir un color manual deja el color dinámico en pausa hasta que el usuario
  // lo vuelva a activar explícitamente.
  if (toggleDynamicColor) toggleDynamicColor.checked = false;
  localStorage.setItem('glasstrackDynamicColor', 'false');
  localStorage.setItem('glasstrackDynamicColorExplicit', 'false');
}
// Restaura el color elegido en la sesión anterior (antes no se guardaba).
(function restoreAccentColor() {
  const saved = localStorage.getItem('glasstrackAccentColor');
  if (!saved) return;
  document.documentElement.style.setProperty('--primary-color', saved);
  document.documentElement.style.setProperty('--accent-color', saved);
  document.querySelectorAll('.color-dot[data-color]').forEach(d => {
    d.classList.toggle('active', d.dataset.color.toLowerCase() === saved.toLowerCase());
  });
})();
if (toggleForceBlackIcons) {
  const savedForceBlack = localStorage.getItem('glasstrackForceBlackIcons') === '1';
  toggleForceBlackIcons.checked = savedForceBlack;
  document.body.classList.toggle('force-black-icons', savedForceBlack);
  toggleForceBlackIcons.addEventListener('change', (e) => {
    playSFX('click');
    document.body.classList.toggle('force-black-icons', e.target.checked);
    localStorage.setItem('glasstrackForceBlackIcons', e.target.checked ? '1' : '0');
  });
}

const toggleSFX = document.getElementById('toggle-sfx');
const toggleCrossfade = document.getElementById('toggle-crossfade');

// ==========================================
// 3. AUDIO CONTEXT, EQ Y SINTETIZADOR DE SFX
// ==========================================
let audioCtx, track1, track2, mainAudioGain1, mainAudioGain2;
let eqFilters = [];
let bassBoostFilter, pannerNode, lfo8d, lfoGain8d, limiterNode;
let midGain, sideGain;
let concludorAnalyser;
let stereoBypassGain, monoSplitter, monoSumGain, monoMerger, monoOutGain;

const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

function initAudioContext() {
  if (audioCtx) { initExternalTrackNodes(); return; }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    track1 = audioCtx.createMediaElementSource(audio1);
    track2 = audioCtx.createMediaElementSource(audio2);

    // --- Ecualizador de 10 bandas ---
    eqFilters = EQ_FREQS.map((freq, i) => {
      const f = audioCtx.createBiquadFilter();
      f.type = "peaking";
      f.frequency.value = freq;
      f.Q.value = 1.0;
      const sliders = document.querySelectorAll('.eq-band-range');
      f.gain.value = sliders[i] ? parseFloat(sliders[i].value) || 0 : 0;
      return f;
    });
    // Ganancias maestras permiten silenciar el audio original dentro del grafo WebAudio
    // mientras se escucha la mezcla externa, sin tocar ni reemplazar sus fuentes.
    mainAudioGain1 = audioCtx.createGain(); mainAudioGain1.gain.value = 1;
    mainAudioGain2 = audioCtx.createGain(); mainAudioGain2.gain.value = 1;
    track1.connect(mainAudioGain1); mainAudioGain1.connect(eqFilters[0]);
    track2.connect(mainAudioGain2); mainAudioGain2.connect(eqFilters[0]);
    for (let i = 0; i < eqFilters.length - 1; i++) eqFilters[i].connect(eqFilters[i + 1]);
    const eqOut = eqFilters[eqFilters.length - 1];

    // --- Bass Boost (refuerzo extra de graves, aparte del EQ manual) ---
    bassBoostFilter = audioCtx.createBiquadFilter();
    bassBoostFilter.type = "lowshelf";
    bassBoostFilter.frequency.value = 90;
    bassBoostFilter.gain.value = 0;
    eqOut.connect(bassBoostFilter);

    // --- Balance L/R y Audio 8D (el mismo nodo sirve para los dos) ---
    pannerNode = audioCtx.createStereoPanner();
    bassBoostFilter.connect(pannerNode);
    lfo8d = audioCtx.createOscillator();
    lfo8d.type = "sine";
    lfo8d.frequency.value = 0.15;
    lfoGain8d = audioCtx.createGain();
    lfoGain8d.gain.value = 1;
    lfo8d.connect(lfoGain8d);
    lfo8d.start();

    // --- Separador de Voz / Música (Mid/Side, pero solo en el rango de frecuencia de la voz:
    // así el bajo y la batería, que suelen estar también centrados, casi no se ven afectados) ---
    const vmLowBand = audioCtx.createBiquadFilter();
    vmLowBand.type = "lowpass"; vmLowBand.frequency.value = 200;
    const vmHighBand = audioCtx.createBiquadFilter();
    vmHighBand.type = "highpass"; vmHighBand.frequency.value = 5000;
    const vmVocalHP = audioCtx.createBiquadFilter();
    vmVocalHP.type = "highpass"; vmVocalHP.frequency.value = 200;
    const vmVocalLP = audioCtx.createBiquadFilter();
    vmVocalLP.type = "lowpass"; vmVocalLP.frequency.value = 5000;
    pannerNode.connect(vmLowBand);
    pannerNode.connect(vmHighBand);
    pannerNode.connect(vmVocalHP);
    vmVocalHP.connect(vmVocalLP);

    const vmSplitter = audioCtx.createChannelSplitter(2);
    vmVocalLP.connect(vmSplitter);
    const halfL1 = audioCtx.createGain(); halfL1.gain.value = 0.5;
    const halfR1 = audioCtx.createGain(); halfR1.gain.value = 0.5;
    vmSplitter.connect(halfL1, 0);
    vmSplitter.connect(halfR1, 1);
    midGain = audioCtx.createGain(); midGain.gain.value = 1; // "Voz"
    halfL1.connect(midGain); halfR1.connect(midGain);

    const halfL2 = audioCtx.createGain(); halfL2.gain.value = 0.5;
    const halfR2neg = audioCtx.createGain(); halfR2neg.gain.value = -0.5;
    vmSplitter.connect(halfL2, 0);
    vmSplitter.connect(halfR2neg, 1);
    sideGain = audioCtx.createGain(); sideGain.gain.value = 1; // "Música" (dentro del rango de voz)
    halfL2.connect(sideGain); halfR2neg.connect(sideGain);

    const negSideForR = audioCtx.createGain(); negSideForR.gain.value = -1;
    sideGain.connect(negSideForR);
    const vmMerger = audioCtx.createChannelMerger(2);
    midGain.connect(vmMerger, 0, 0);
    sideGain.connect(vmMerger, 0, 0);
    midGain.connect(vmMerger, 0, 1);
    negSideForR.connect(vmMerger, 0, 1);

    // --- Limitador de volumen (Salud Auditiva) ---
    limiterNode = audioCtx.createDynamicsCompressor();
    limiterNode.threshold.value = 0; // 0dB = transparente hasta que se active
    limiterNode.knee.value = 0;
    limiterNode.ratio.value = 1;
    limiterNode.attack.value = 0.002;
    limiterNode.release.value = 0.15;
    vmMerger.connect(limiterNode);
    vmLowBand.connect(limiterNode);
    vmHighBand.connect(limiterNode);

    // --- Salida normal en estéreo (se apaga sola si se activa el Modo Mono) ---
    stereoBypassGain = audioCtx.createGain();
    stereoBypassGain.gain.value = 1;
    limiterNode.connect(stereoBypassGain);
    stereoBypassGain.connect(audioCtx.destination);

    // --- Salida real en mono: suma los canales L y R y manda lo mismo a ambos lados ---
    monoSplitter = audioCtx.createChannelSplitter(2);
    monoSumGain = audioCtx.createGain();
    monoSumGain.gain.value = 0.5;
    monoMerger = audioCtx.createChannelMerger(2);
    monoOutGain = audioCtx.createGain();
    monoOutGain.gain.value = 0;

    limiterNode.connect(monoSplitter);
    monoSplitter.connect(monoSumGain, 0);
    monoSplitter.connect(monoSumGain, 1);
    monoSumGain.connect(monoMerger, 0, 0);
    monoSumGain.connect(monoMerger, 0, 1);
    monoMerger.connect(monoOutGain);
    monoOutGain.connect(audioCtx.destination);

    // Analizador para el visualizador de frecuencias del Modo Concluidor (dato de audio real, no decorativo)
    concludorAnalyser = audioCtx.createAnalyser();
    concludorAnalyser.fftSize = 64;
    limiterNode.connect(concludorAnalyser);

    applyAudioEngineSettings();
    // Conectar cualquier pista externa cargada al mismo flujo EQ/efectos.
    initExternalTrackNodes();
  } catch (err) {
    console.warn("AudioContext no iniciado:", err);
  }
}

function setMonoMode(enabled) {
  if (!stereoBypassGain || !monoOutGain) return;
  stereoBypassGain.gain.value = enabled ? 0 : 1;
  monoOutGain.gain.value = enabled ? 1 : 0;
}

function set8dAudio(enabled) {
  if (!lfoGain8d || !pannerNode) return;
  try { lfoGain8d.disconnect(); } catch (e) {}
  if (enabled) {
    lfoGain8d.connect(pannerNode.pan);
  } else {
    const balance = inputAudioBalance ? parseFloat(inputAudioBalance.value) : 0;
    pannerNode.pan.value = balance || 0;
  }
}

function setVolumeLimiter(enabled) {
  if (!limiterNode) return;
  limiterNode.threshold.value = enabled ? -18 : 0;
  limiterNode.ratio.value = enabled ? 12 : 1;
}

// Mantiene el comportamiento simple del reproductor: la afinación acompaña a la velocidad.
// No se expone un control de Pitch separado en la interfaz.
function applyLinkedPlaybackRate(audio) {
  if (!audio) return;
  try { audio.preservesPitch = false; } catch (_) {}
  try { audio.mozPreservesPitch = false; } catch (_) {}
  try { audio.webkitPreservesPitch = false; } catch (_) {}
}

function applyAudioEngineSettings() {
  const speed = inputAudioSpeed ? parseFloat(inputAudioSpeed.value) : 1;
  [audio1, audio2].filter(Boolean).forEach(a => {
    a.playbackRate = speed || 1;
    applyLinkedPlaybackRate(a);
  });
  allExternalTrackRecords().forEach(rec => {
    const a = rec.audio;
    if (!a) return;
    a.playbackRate = speed || 1;
    applyLinkedPlaybackRate(a);
  });
  if (toggleMonoAudio) setMonoMode(toggleMonoAudio.checked);
  if (bassBoostFilter && toggleBassBoost) bassBoostFilter.gain.value = toggleBassBoost.checked ? 6 : 0;
  if (toggle8dAudio) set8dAudio(toggle8dAudio.checked);
  if (toggleVolumeLimiter) setVolumeLimiter(toggleVolumeLimiter.checked);
  saveAudioSettings();
  syncPlaybackSpeedIndicators();
}

// Guarda y restaura EQ, Mono/8D/Bass Boost/Normalización/Limitador, balance, velocidad y
// preset de modo.
function saveAudioSettings() {
  const preset = document.body.classList.contains('preset-game') ? 'game'
    : document.body.classList.contains('preset-night') ? 'night'
    : document.body.classList.contains('preset-study') ? 'study' : 'normal';
  const settings = {
    mono: toggleMonoAudio ? toggleMonoAudio.checked : false,
    bassBoost: toggleBassBoost ? toggleBassBoost.checked : false,
    eightD: toggle8dAudio ? toggle8dAudio.checked : false,
    limiter: toggleVolumeLimiter ? toggleVolumeLimiter.checked : false,
    normalize: toggleNormalizeVolume ? toggleNormalizeVolume.checked : false,
    balance: inputAudioBalance ? inputAudioBalance.value : 0,
    speed: inputAudioSpeed ? inputAudioSpeed.value : 1,
    eqBands: externalMixerActive && externalMixerPreviousState && Array.isArray(externalMixerPreviousState.eqBands)
      ? externalMixerPreviousState.eqBands
      : Array.from(document.querySelectorAll('.eq-band-range')).map(s => s.value),
    preset
  };
  localStorage.setItem('audioSettings', JSON.stringify(settings));
}

function loadAudioSettings() {
  let s;
  try { s = JSON.parse(localStorage.getItem('audioSettings') || 'null'); } catch (err) { s = null; }
  if (!s) return;
  if (toggleMonoAudio) toggleMonoAudio.checked = !!s.mono;
  if (toggleBassBoost) toggleBassBoost.checked = !!s.bassBoost;
  if (toggle8dAudio) toggle8dAudio.checked = !!s.eightD;
  if (toggleVolumeLimiter) toggleVolumeLimiter.checked = !!s.limiter;
  if (toggleNormalizeVolume) toggleNormalizeVolume.checked = !!s.normalize;
  if (inputAudioBalance && s.balance !== undefined) inputAudioBalance.value = s.balance;
  if (inputAudioSpeed && s.speed !== undefined) {
    inputAudioSpeed.value = s.speed;
    const val = parseFloat(s.speed);
    if (audioSpeedVal) audioSpeedVal.textContent = val.toFixed(2) + 'x';
    const quickLabel = document.getElementById('quick-speed-label');
    if (quickLabel) quickLabel.textContent = val.toFixed(2).replace(/\.?0+$/, '') + 'x';
  }
  if (s.eqBands) {
    document.querySelectorAll('.eq-band-range').forEach((slider, i) => {
      if (s.eqBands[i] !== undefined) slider.value = s.eqBands[i];
    });
  }
  if (s.preset && s.preset !== 'normal') {
    document.body.classList.add('preset-' + s.preset);
    if (s.preset === 'night') {
      const nightOverlay = document.getElementById('night-mode-overlay');
      if (nightOverlay) nightOverlay.classList.add('active');
    }
  }
}
loadAudioSettings();

function formatPlaybackSpeed(value) {
  const val = Number(value) || 1;
  return `${Number.isInteger(val) ? val : String(Number(val.toFixed(2))).replace(/0+$/, '').replace(/\.$/, '')}x`;
}
function getActualPlaybackRate() {
  const actual = Number(activeAudio?.playbackRate);
  if (Number.isFinite(actual) && actual > 0) return actual;
  const configured = Number(inputAudioSpeed?.value);
  return Number.isFinite(configured) && configured > 0 ? configured : 1;
}
function syncPlaybackSpeedIndicators() {
  const speed = getActualPlaybackRate();
  const label = formatPlaybackSpeed(speed);
  document.documentElement.style.setProperty('--playback-speed', String(speed));
  document.documentElement.style.setProperty('--runner-cycle-duration', `${Math.max(.14, Math.min(.72, .36 / speed)).toFixed(3)}s`);
  [document.getElementById('quick-speed-label'), cinemaSpeedLabel, karaokeSpeedLabel].filter(Boolean).forEach(el => {
    el.textContent = label;
  });
  // El indicador fijo de Ajustes sigue el valor configurado, incluso si el Estudio usa una velocidad temporal.
  const configuredRate = Math.max(.5, Math.min(2, Number(inputAudioSpeed?.value) || 1));
  if (liveRunnerVideo && Math.abs((Number(liveRunnerVideo.playbackRate) || 1) - configuredRate) > 0.001) {
    try { liveRunnerVideo.playbackRate = configuredRate; } catch (_) {}
  }
  // La ventana emergente sigue el valor propio del control sobre el que está abierta.
  if (runnerPreviewVideo && runnerPreviewActiveTarget && runnerPreviewPopover?.classList.contains('is-visible')) {
    const previewRate = getRunnerPreviewRate(runnerPreviewActiveTarget);
    if (Math.abs((Number(runnerPreviewVideo.playbackRate) || 1) - previewRate) > 0.001) {
      try { runnerPreviewVideo.playbackRate = previewRate; } catch (_) {}
    }
    runnerPreviewPopover.style.setProperty('--runner-cycle-duration', `${Math.max(.14, Math.min(.72, .36 / previewRate)).toFixed(3)}s`);
  }
  if (btnQuickSpeed) {
    btnQuickSpeed.title = `Velocidad real ${label}. Pulsar para cambiar`;
    btnQuickSpeed.setAttribute('aria-label', `Velocidad de reproducción ${label}`);
  }
  if (cinemaSpeedBtn) {
    cinemaSpeedBtn.title = `Velocidad real ${label}. Pulsar para cambiar`;
    cinemaSpeedBtn.setAttribute('aria-label', `Velocidad ${label}`);
  }
  if (karaokeSpeedBtn) {
    karaokeSpeedBtn.title = `Velocidad real ${label}. Pulsar para cambiar`;
    karaokeSpeedBtn.setAttribute('aria-label', `Velocidad ${label}`);
  }
}
function syncCinemaSpeedLabel() { syncPlaybackSpeedIndicators(); }

[audio1, audio2].filter(Boolean).forEach(audioEl => {
  ['ratechange', 'play', 'playing', 'pause', 'loadedmetadata'].forEach(eventName => {
    audioEl.addEventListener(eventName, () => {
      if (audioEl === activeAudio) syncPlaybackSpeedIndicators();
    });
  });
});


if (inputAudioSpeed) {
  inputAudioSpeed.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    if (audioSpeedVal) audioSpeedVal.textContent = val.toFixed(2) + 'x';
    const quickLabel = document.getElementById('quick-speed-label');
    if (quickLabel) quickLabel.textContent = formatPlaybackSpeed(val);
    syncCinemaSpeedLabel();
    applyAudioEngineSettings();
  });
}

// Botón rápido de velocidad en el propio reproductor: alterna 1x -> 1.25x -> 1.5x -> 2x -> 1x
const btnQuickSpeed = document.getElementById('btn-quick-speed');
const QUICK_SPEEDS = [1, 1.25, 1.5, 2];
if (btnQuickSpeed) {
  btnQuickSpeed.addEventListener('click', () => {
    playSFX('click');
    const current = inputAudioSpeed ? parseFloat(inputAudioSpeed.value) : 1;
    let idx = QUICK_SPEEDS.findIndex(s => Math.abs(s - current) < 0.01);
    idx = (idx + 1) % QUICK_SPEEDS.length;
    const next = QUICK_SPEEDS[idx];
    if (inputAudioSpeed) inputAudioSpeed.value = next;
    if (audioSpeedVal) audioSpeedVal.textContent = next.toFixed(2) + 'x';
    const quickLabel = document.getElementById('quick-speed-label');
    if (quickLabel) quickLabel.textContent = formatPlaybackSpeed(next);
    syncCinemaSpeedLabel();
    applyAudioEngineSettings();
    showToast('Velocidad: ' + next + 'x', 'info', 1500);
  });
}

if (cinemaSpeedBtn) {
  cinemaSpeedBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (btnQuickSpeed) btnQuickSpeed.click();
  });
}
if (karaokeSpeedBtn) {
  karaokeSpeedBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (btnQuickSpeed) btnQuickSpeed.click();
  });
}
syncCinemaSpeedLabel();

// Ventanita de video para velocidad: se crea una sola vez y se carga solo tras 3 s de intención.
// Coloca el archivo en assets/corriendo.mp4; no se recrean nodos ni se inicia video si falta.
const RUNNER_VIDEO_SRC = 'assets/corriendo.mp4';
const RUNNER_PREVIEW_DWELL_MS = 3000;
const runnerPreviewPopover = document.createElement('div');
runnerPreviewPopover.id = 'runner-video-popover';
runnerPreviewPopover.className = 'runner-video-popover';
runnerPreviewPopover.setAttribute('role', 'tooltip');
runnerPreviewPopover.setAttribute('aria-hidden', 'true');
runnerPreviewPopover.innerHTML = '<div class="runner-video-frame"><video class="runner-video-content" muted loop playsinline preload="none" aria-label="Persona corriendo según la velocidad de reproducción"></video><div class="runner-video-tint" aria-hidden="true"></div><svg class="runner-svg-fallback runner-silhouette" viewBox="0 0 100 100" aria-hidden="true"><circle cx="57" cy="14" r="7" fill="currentColor"/><path d="M53 25 L44 48 L61 51" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><g class="runner-arm-a"><path d="M51 30 L34 36 L26 27" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></g><g class="runner-arm-b"><path d="M53 30 L69 22 L78 30" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></g><g class="runner-leg-a"><path d="M45 48 L27 64 L15 62" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></g><g class="runner-leg-b"><path d="M60 51 L77 61 L88 52" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></g></svg></div>';
document.body.appendChild(runnerPreviewPopover);
runnerPreviewVideo = runnerPreviewPopover.querySelector('video');
let runnerPreviewTimer = null;
let runnerPreviewHideTimer = null;
let runnerPreviewPendingTarget = null;
let runnerPreviewActiveTarget = null;
let runnerPreviewDwellComplete = false;
let runnerPreviewLoadStarted = false;
let runnerPreviewLoadFailed = false;
let runnerPreviewPointerType = 'mouse';
let runnerPreviewPointerDownAt = 0;
let runnerPreviewPointerInPopover = false;

function runnerPreviewIsVisible() {
  return runnerPreviewPopover.classList.contains('is-visible');
}
function getRunnerPreviewAnchor(target) {
  const rect = target.getBoundingClientRect();
  if (target instanceof HTMLInputElement && target.type === 'range') {
    const min = Number(target.min || 0);
    const max = Number(target.max || 1);
    const value = Number(target.value || min);
    const ratio = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0.5;
    return { x: rect.left + ratio * rect.width, top: rect.top, bottom: rect.bottom };
  }
  return { x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom };
}
function getRunnerPreviewRate(target) {
  if (!target) return getActualPlaybackRate();
  if (target === inputAudioSpeed) return Math.max(.5, Math.min(2, Number(target.value) || 1));
  if (target.id === 'calibrate-speed') return Math.max(.5, Math.min(2, Number(target.value) || 1));
  if (target.matches?.('.studio-speed-btn')) return Math.max(.5, Math.min(2, Number(target.dataset.speed) || 1));
  if (target.matches?.('.playback-speed-control')) return getActualPlaybackRate();
  if (target instanceof HTMLInputElement && target.type === 'range') {
    const rate = Number(target.value);
    if (Number.isFinite(rate) && rate > 0) return Math.max(.1, Math.min(3, rate));
  }
  return getActualPlaybackRate();
}
function getRunnerSilhouetteTint() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim()
    || getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim()
    || '#8a99ad';
  let rgb = null;
  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let code = hex[1];
    if (code.length === 3) code = code.split('').map(ch => ch + ch).join('');
    rgb = [0, 2, 4].map(i => parseInt(code.slice(i, i + 2), 16));
  } else {
    const match = raw.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (match) rgb = [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  if (!rgb || rgb.some(v => !Number.isFinite(v))) return '#697789';
  const luminance = .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
  // Un acento casi blanco desaparecería sobre el fondo blanco del video: oscurecer conservando el matiz.
  if (luminance > 188) {
    const factor = 188 / luminance;
    rgb = rgb.map(v => Math.round(v * factor));
  }
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}
function positionRunnerPreview(target) {
  if (!target || !target.isConnected) return;
  const anchor = getRunnerPreviewAnchor(target);
  const size = window.innerWidth <= 780 ? Math.min(60, Math.max(54, window.innerWidth - 16)) : 70;
  const left = Math.max(8, Math.min(window.innerWidth - size - 8, anchor.x - size / 2));
  let top = anchor.top - size - 8;
  if (top < 8) top = Math.min(window.innerHeight - size - 8, anchor.bottom + 8);
  runnerPreviewPopover.style.width = `${size}px`;
  runnerPreviewPopover.style.height = `${size}px`;
  runnerPreviewPopover.style.left = `${left}px`;
  runnerPreviewPopover.style.top = `${Math.max(8, top)}px`;
}
function stopRunnerPreviewVideo() {
  try { runnerPreviewVideo.pause(); } catch (_) {}
  // Reproducir desde el inicio cuando se vuelva a abrir la ventana.
  try { if (Number.isFinite(runnerPreviewVideo.duration) && runnerPreviewVideo.duration > 0) runnerPreviewVideo.currentTime = 0; } catch (_) {}
}
function hideRunnerPreview(immediate = false) {
  if (runnerPreviewHideTimer) clearTimeout(runnerPreviewHideTimer);
  runnerPreviewHideTimer = null;
  const close = () => {
    runnerPreviewPopover.classList.remove('is-visible');
    runnerPreviewPopover.setAttribute('aria-hidden', 'true');
    stopRunnerPreviewVideo();
    runnerPreviewActiveTarget = null;
    runnerPreviewDwellComplete = false;
  };
  if (immediate) close();
  else runnerPreviewHideTimer = setTimeout(close, runnerPreviewPointerType === 'touch' ? 1700 : 220);
}
function showRunnerPreview(target) {
  if (!target || !target.isConnected || !runnerPreviewDwellComplete) return;
  runnerPreviewActiveTarget = target;
  positionRunnerPreview(target);
  runnerPreviewPopover.style.setProperty('--runner-tint-color', getRunnerSilhouetteTint());
  const speed = getRunnerPreviewRate(target);
  try { runnerPreviewVideo.playbackRate = speed; } catch (_) {}
  runnerPreviewPopover.style.setProperty('--runner-cycle-duration', `${Math.max(.14, Math.min(.72, .36 / speed)).toFixed(3)}s`);
  runnerPreviewPopover.classList.add('is-visible');
  runnerPreviewPopover.classList.toggle('video-ready', !runnerPreviewLoadFailed && runnerPreviewVideo.readyState >= 2);
  runnerPreviewPopover.setAttribute('aria-hidden', 'false');
  if (!runnerPreviewLoadFailed && runnerPreviewVideo.readyState >= 2) {
    const playPromise = runnerPreviewVideo.play();
    if (playPromise && typeof playPromise.catch === 'function') playPromise.catch(() => {});
  } else {
    try { runnerPreviewVideo.pause(); } catch (_) {}
  }
}
function loadRunnerPreviewVideo() {
  if (runnerPreviewLoadFailed) {
    if (runnerPreviewDwellComplete && runnerPreviewPendingTarget) showRunnerPreview(runnerPreviewPendingTarget);
    return;
  }
  if (runnerPreviewVideo.readyState >= 2) {
    if (runnerPreviewDwellComplete && runnerPreviewPendingTarget) showRunnerPreview(runnerPreviewPendingTarget);
    return;
  }
  if (runnerPreviewLoadStarted) return;
  runnerPreviewLoadStarted = true;
  runnerPreviewVideo.addEventListener('loadeddata', () => {
    runnerPreviewLoadFailed = false;
    if (runnerPreviewDwellComplete && runnerPreviewPendingTarget) showRunnerPreview(runnerPreviewPendingTarget);
  }, { once: true });
  runnerPreviewVideo.addEventListener('error', () => {
    // El clip del usuario todavía puede faltar; se muestra el monigote animado de respaldo.
    runnerPreviewLoadFailed = true;
    runnerPreviewPopover.classList.remove('video-ready');
    if (runnerPreviewDwellComplete && runnerPreviewPendingTarget) showRunnerPreview(runnerPreviewPendingTarget);
  }, { once: true });
  runnerPreviewVideo.src = RUNNER_VIDEO_SRC;
  try { runnerPreviewVideo.load(); } catch (_) { runnerPreviewLoadFailed = true; }
}
function cancelRunnerPreviewDwell(target) {
  if (target && runnerPreviewPendingTarget !== target) return;
  if (runnerPreviewTimer) clearTimeout(runnerPreviewTimer);
  runnerPreviewTimer = null;
  if (!runnerPreviewDwellComplete) runnerPreviewPendingTarget = null;
  runnerPreviewDwellComplete = false;
}
function startRunnerPreviewDwell(target) {
  if (!target || !target.isConnected) return;
  if (runnerPreviewHideTimer) clearTimeout(runnerPreviewHideTimer);
  runnerPreviewHideTimer = null;
  if (runnerPreviewPendingTarget === target && (runnerPreviewTimer || runnerPreviewDwellComplete)) return;
  cancelRunnerPreviewDwell();
  hideRunnerPreview(true);
  runnerPreviewPendingTarget = target;
  runnerPreviewDwellComplete = false;
  runnerPreviewTimer = setTimeout(() => {
    runnerPreviewTimer = null;
    if (!runnerPreviewPendingTarget || !runnerPreviewPendingTarget.isConnected) return;
    runnerPreviewDwellComplete = true;
    runnerPreviewActiveTarget = runnerPreviewPendingTarget;
    positionRunnerPreview(runnerPreviewPendingTarget);
    // Mostrar ya el cuadro pequeño con la silueta de respaldo; el video real sustituye el dibujo si está disponible.
    showRunnerPreview(runnerPreviewPendingTarget);
    loadRunnerPreviewVideo();
  }, RUNNER_PREVIEW_DWELL_MS);
}
function onRunnerPreviewLeave(target) {
  if (runnerPreviewPendingTarget === target && runnerPreviewTimer) cancelRunnerPreviewDwell(target);
  if (runnerPreviewActiveTarget === target || runnerPreviewPendingTarget === target) {
    if (runnerPreviewPointerType === 'touch') {
      // Da tiempo a ver el recuadro tras levantar el dedo después de la pulsación larga.
      hideRunnerPreview(false);
    } else if (!runnerPreviewPointerInPopover) {
      hideRunnerPreview(false);
    }
  }
}
const runnerPreviewTargets = [
  ...document.querySelectorAll('.playback-speed-control'),
  inputAudioSpeed,
  document.getElementById('calibrate-speed'),
  ...document.querySelectorAll('.studio-speed-btn')
].filter((el, index, arr) => el && arr.indexOf(el) === index);
runnerPreviewTargets.forEach(target => {
  target.addEventListener('pointerenter', event => {
    runnerPreviewPointerType = event.pointerType || 'mouse';
    startRunnerPreviewDwell(target);
  });
  target.addEventListener('pointerleave', event => {
    runnerPreviewPointerType = event.pointerType || runnerPreviewPointerType;
    onRunnerPreviewLeave(target);
  });
  target.addEventListener('pointerdown', event => {
    runnerPreviewPointerType = event.pointerType || 'mouse';
    runnerPreviewPointerDownAt = performance.now();
    if (!runnerPreviewTimer && !runnerPreviewDwellComplete) startRunnerPreviewDwell(target);
  });
  target.addEventListener('pointerup', event => {
    runnerPreviewPointerType = event.pointerType || runnerPreviewPointerType;
    const heldMs = performance.now() - runnerPreviewPointerDownAt;
    if (runnerPreviewPointerType === 'touch' && heldMs < RUNNER_PREVIEW_DWELL_MS && runnerPreviewTimer) {
      cancelRunnerPreviewDwell(target);
    } else if (runnerPreviewPointerType === 'touch' && runnerPreviewDwellComplete && runnerPreviewActiveTarget === target) {
      hideRunnerPreview(false);
    }
  });
  target.addEventListener('pointercancel', () => cancelRunnerPreviewDwell(target));
  target.addEventListener('focus', () => startRunnerPreviewDwell(target));
  target.addEventListener('blur', () => onRunnerPreviewLeave(target));
  if (target instanceof HTMLInputElement && target.type === 'range') {
    target.addEventListener('input', () => {
      if (runnerPreviewActiveTarget !== target || !runnerPreviewIsVisible()) return;
      positionRunnerPreview(target);
      const rate = getRunnerPreviewRate(target);
      if (!runnerPreviewLoadFailed && runnerPreviewVideo.readyState >= 2) {
        try { runnerPreviewVideo.playbackRate = rate; } catch (_) {}
      }
      runnerPreviewPopover.style.setProperty('--runner-cycle-duration', `${Math.max(.14, Math.min(.72, .36 / rate)).toFixed(3)}s`);
    });
  }
});
runnerPreviewPopover.addEventListener('pointerenter', () => {
  runnerPreviewPointerInPopover = true;
  if (runnerPreviewHideTimer) clearTimeout(runnerPreviewHideTimer);
  runnerPreviewHideTimer = null;
});
runnerPreviewPopover.addEventListener('pointerleave', () => {
  runnerPreviewPointerInPopover = false;
  hideRunnerPreview(false);
});
window.addEventListener('resize', () => {
  if (runnerPreviewIsVisible() && runnerPreviewActiveTarget) positionRunnerPreview(runnerPreviewActiveTarget);
}, { passive: true });
// Actualiza el tinte si cambia el color de interfaz mientras la ventanita está abierta.
const runnerPreviewThemeObserver = new MutationObserver(() => {
  if (runnerPreviewIsVisible()) runnerPreviewPopover.style.setProperty('--runner-tint-color', getRunnerSilhouetteTint());
});
runnerPreviewThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

// Indicador permanente junto a «Velocidad de reproducción» en Audio avanzado.
// El video solo se solicita al abrir/interactuar con Ajustes; si el archivo falta, se conserva la silueta animada CSS.
let liveRunnerLoadStarted = false;
function loadLiveRunnerVideo() {
  if (!liveRunnerVideo || liveRunnerLoadStarted) return;
  liveRunnerLoadStarted = true;
  liveRunnerVideo.addEventListener('loadeddata', () => {
    liveRunnerIndicator?.classList.add('video-ready');
    try { liveRunnerVideo.playbackRate = Math.max(.5, Math.min(2, Number(inputAudioSpeed?.value) || 1)); } catch (_) {}
    const play = liveRunnerVideo.play();
    if (play && typeof play.catch === 'function') play.catch(() => {});
  }, { once: true });
  liveRunnerVideo.addEventListener('error', () => {
    liveRunnerIndicator?.classList.remove('video-ready');
    try { liveRunnerVideo.pause(); } catch (_) {}
  }, { once: true });
  liveRunnerVideo.src = RUNNER_VIDEO_SRC;
  try { liveRunnerVideo.load(); } catch (_) { liveRunnerIndicator?.classList.remove('video-ready'); }
}
function syncLiveRunnerVisibility() {
  if (!liveRunnerVideo || !liveRunnerIndicator) return;
  const subPanel = document.getElementById('sub-audio');
  const settingsVisible = !!subPanel && getComputedStyle(subPanel).display !== 'none' && subPanel.getClientRects().length > 0;
  if (settingsVisible) {
    loadLiveRunnerVideo();
    if (liveRunnerIndicator.classList.contains('video-ready')) {
      const play = liveRunnerVideo.play();
      if (play && typeof play.catch === 'function') play.catch(() => {});
    }
  } else {
    try { liveRunnerVideo.pause(); } catch (_) {}
  }
  liveRunnerIndicator.style.setProperty('--runner-tint-color', getRunnerSilhouetteTint());
}
inputAudioSpeed?.addEventListener('pointerenter', loadLiveRunnerVideo, { passive: true });
inputAudioSpeed?.addEventListener('focus', loadLiveRunnerVideo);
const audioSubPanel = document.getElementById('sub-audio');
const settingsModalForRunner = document.getElementById('modal-settings');
if (audioSubPanel && typeof MutationObserver !== 'undefined') {
  const liveRunnerObserver = new MutationObserver(syncLiveRunnerVisibility);
  liveRunnerObserver.observe(audioSubPanel, { attributes: true, attributeFilter: ['class', 'style'] });
  if (settingsModalForRunner) liveRunnerObserver.observe(settingsModalForRunner, { attributes: true, attributeFilter: ['class', 'style'] });
}
window.addEventListener('resize', syncLiveRunnerVisibility, { passive: true });
syncLiveRunnerVisibility();

if (toggleMonoAudio) {
  toggleMonoAudio.addEventListener('change', () => {
    playSFX('click');
    initAudioContext();
    applyAudioEngineSettings();
  });
}

// --- Ecualizador de 10 bandas (Gemini lo dejó sin ninguna lógica) ---
document.querySelectorAll('.eq-band-range').forEach(slider => {
  slider.addEventListener('input', (e) => {
    initAudioContext();
    const idx = parseInt(e.target.dataset.index, 10);
    if (eqFilters[idx]) eqFilters[idx].gain.value = parseFloat(e.target.value);
    saveAudioSettings();
  });
});

const EQ_PRESETS = {
  bass:   [8, 6, 4, 2, 0, 0, 0, 0, 0, 0],
  treble: [0, 0, 0, 0, 0, 2, 4, 6, 7, 8],
  vocal:  [-2, -2, -1, 0, 3, 4, 3, 1, 0, -1],
  reset:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
};
document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    playSFX('click');
    initAudioContext();
    const preset = EQ_PRESETS[e.currentTarget.dataset.preset];
    if (!preset) return;
    document.querySelectorAll('.eq-band-range').forEach((slider, i) => {
      slider.value = preset[i];
      if (eqFilters[i]) eqFilters[i].gain.value = preset[i];
    });
  });
});

if (toggleBassBoost) toggleBassBoost.addEventListener('change', () => { initAudioContext(); applyAudioEngineSettings(); });
if (toggle8dAudio) toggle8dAudio.addEventListener('change', () => { initAudioContext(); applyAudioEngineSettings(); });
if (toggleVolumeLimiter) toggleVolumeLimiter.addEventListener('change', () => { initAudioContext(); applyAudioEngineSettings(); });
if (inputAudioBalance) {
  inputAudioBalance.addEventListener('input', () => {
    initAudioContext();
    if (!toggle8dAudio || !toggle8dAudio.checked) set8dAudio(false);
    saveAudioSettings();
  });
}

// --- Separador de Voz / Música ---
function updateLegacyVmPercentages() {
  if (inputVoiceLevelValue && inputVoiceLevel) inputVoiceLevelValue.textContent = `${Math.round((Number(inputVoiceLevel.value) || 0) * 100)}%`;
  if (inputMusicLevelValue && inputMusicLevel) inputMusicLevelValue.textContent = `${Math.round((Number(inputMusicLevel.value) || 0) * 100)}%`;
}
updateLegacyVmPercentages();
if (inputVoiceLevel) {
  inputVoiceLevel.addEventListener('input', (e) => {
    if (externalMixerActive) {
      externalSongVoiceLevel = Math.max(0, Math.min(2, Number(e.target.value) || 0));
      applyExternalMixGains();
      updateLegacyVmPercentages();
      queueExternalMixSave();
      return;
    }
    initAudioContext();
    if (midGain) midGain.gain.value = parseFloat(e.target.value);
    updateLegacyVmPercentages();
  });
}
if (inputMusicLevel) {
  inputMusicLevel.addEventListener('input', (e) => {
    if (externalMixerActive) {
      externalSongMusicLevel = Math.max(0, Math.min(2, Number(e.target.value) || 0));
      applyExternalMixGains();
      updateLegacyVmPercentages();
      queueExternalMixSave();
      return;
    }
    initAudioContext();
    if (sideGain) sideGain.gain.value = parseFloat(e.target.value);
    updateLegacyVmPercentages();
  });
}
if (toggleVmEnabled) {
  toggleVmEnabled.addEventListener('change', (e) => {
    initAudioContext();
    if (!e.target.checked) {
      if (midGain) midGain.gain.value = 1;
      if (sideGain) sideGain.gain.value = 1;
      if (inputVoiceLevel) inputVoiceLevel.value = 1;
      if (inputMusicLevel) inputMusicLevel.value = 1;
      updateLegacyVmPercentages();
    }
  });
}

// --- Mezclador externo B41: hasta cinco pistas, EQ compartido y guardado por canción/perfil ---
function createExternalTrackRecord(kind, index, label, visible = false) {
  return { kind, index, label, audio: null, sourceNode: null, gainNode: null, objectUrl: null, file: null, volume: 100, offset: 0, muted: false, visible };
}
const externalTrackMix = {
  voice: createExternalTrackRecord('voice', 0, 'Voz', true),
  music: createExternalTrackRecord('music', 1, 'Instrumental', true),
  extras: [
    createExternalTrackRecord('extra1', 2, 'Pista extra 1'),
    createExternalTrackRecord('extra2', 3, 'Pista extra 2'),
    createExternalTrackRecord('extra3', 4, 'Pista extra 3')
  ]
};
const EXTERNAL_MIX_DB_NAME = 'glasstrack-external-mixes-v1';
const EXTERNAL_MIX_DB_VERSION = 1;
const EXTERNAL_MIX_STORE = 'songMixes';
let externalMixDbPromise = null;
let externalCurrentMixKey = '';
let externalMixLoadToken = 0;
let externalMixSaveTimer = null;
let externalMixPendingSave = null;
let externalMixSaveChain = Promise.resolve();
let externalMixLastSaveErrorShown = false;
let externalExtraVisibleCount = 0;
let externalSongVoiceLevel = 1;
let externalSongMusicLevel = 1;
let externalMixerActive = false;
let externalMixerMuted = false;
let externalEndMismatchHandled = false;
let externalMixerPreviousState = null;
let externalPlaybackStartPromise = null;
let externalMixerManualStop = false;
const externalExtraContainer = document.getElementById('external-extra-tracks');
const btnAddExternalTrack = document.getElementById('btn-add-external-track');
const externalEqProfile = document.getElementById('external-eq-profile');
const externalMixSaveState = document.getElementById('external-mix-save-state');
let externalMixSavingMessage = '';

function allExternalTrackRecords() { return [externalTrackMix.voice, externalTrackMix.music, ...externalTrackMix.extras]; }
function externalTrackRecord(kind) {
  if (kind === 'voice') return externalTrackMix.voice;
  if (kind === 'music') return externalTrackMix.music;
  const extra = externalTrackMix.extras.find(rec => rec.kind === kind);
  return extra || externalTrackMix.voice;
}
function isSupportedExternalAudio(file) {
  if (!file) return false;
  const type = String(file.type || '').toLowerCase();
  const name = String(file.name || '').toLowerCase();
  return type.startsWith('audio/') || /\.(mp3|wav|flac|ogg|m4a|aac|opus|webm|oga|aiff|aif)$/i.test(name);
}
function getExternalSongKey(song = songList[currentIndex], profileId = activeProfileId) {
  if (!song) return '';
  const coverRef = String(song.cover || '');
  const stableCover = coverRef.startsWith('blob:') ? '' : coverRef;
  const stableSource = String(song.sourceUrl || song.directUrl || song.fileName || song.filename || song.name || '');
  const identity = song.id !== undefined && song.id !== null
    ? `id:${String(song.id)}`
    : `meta:${String(song.title || '')}|${String(song.artist || '')}|${String(song.album || '')}|${String(song.duration || '')}|${stableCover}|${stableSource}`;
  return `${String(profileId || GLASSTRACK_GUEST_ID)}::${identity}`;
}
function openExternalMixDb() {
  if (externalMixDbPromise) return externalMixDbPromise;
  externalMixDbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB no está disponible')); return; }
    const request = indexedDB.open(EXTERNAL_MIX_DB_NAME, EXTERNAL_MIX_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EXTERNAL_MIX_STORE)) db.createObjectStore(EXTERNAL_MIX_STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { try { db.close(); } catch (_) {} externalMixDbPromise = null; };
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('No se pudo abrir el almacenamiento de mezclas'));
    request.onblocked = () => reject(new Error('El almacenamiento de mezclas está bloqueado por otra pestaña'));
  }).catch(error => { externalMixDbPromise = null; throw error; });
  return externalMixDbPromise;
}
function externalMixRequest(mode, operation) {
  return openExternalMixDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(EXTERNAL_MIX_STORE, mode);
    const store = tx.objectStore(EXTERNAL_MIX_STORE);
    let result;
    try { result = operation(store); } catch (error) { reject(error); return; }
    tx.oncomplete = () => {
      const isRequest = result && typeof result === 'object' && ('onsuccess' in result) && ('result' in result);
      resolve(isRequest ? result.result : result);
    };
    tx.onerror = () => reject(tx.error || new Error('Error en la base de datos de mezclas'));
    tx.onabort = () => reject(tx.error || new Error('Guardado de mezcla cancelado'));
  }));
}
function buildExternalMixSnapshot(key, song, profileId) {
  const tracks = allExternalTrackRecords().map(rec => ({
    kind: rec.kind,
    name: rec.file ? String(rec.file.name || `${rec.kind}.audio`) : '',
    type: rec.file ? String(rec.file.type || 'application/octet-stream') : '',
    lastModified: rec.file && Number(rec.file.lastModified) || 0,
    blob: rec.file || null,
    volume: Math.max(0, Math.min(100, Number(rec.volume) || 0)),
    offset: Math.max(-30, Math.min(30, Number(rec.offset) || 0)),
    muted: !!rec.muted,
    visible: !!rec.visible
  }));
  return {
    key,
    profileId: String(profileId || GLASSTRACK_GUEST_ID),
    songId: song && song.id != null ? String(song.id) : '',
    songTitle: String(song && song.title || ''),
    songArtist: String(song && song.artist || ''),
    tracks,
    eqProfile: externalEqProfile ? externalEqProfile.value || 'current' : 'current',
    voiceControlLevel: Math.max(0, Math.min(2, Number(externalSongVoiceLevel) || 0)),
    musicControlLevel: Math.max(0, Math.min(2, Number(externalSongMusicLevel) || 0)),
    extraVisibleCount: externalExtraVisibleCount,
    updatedAt: Date.now()
  };
}
function writeExternalMixSnapshot(snapshot) {
  if (!snapshot || !snapshot.key) return Promise.resolve();
  const hasFiles = Array.isArray(snapshot.tracks) && snapshot.tracks.some(track => !!track.blob);
  return externalMixRequest('readwrite', store => {
    if (!hasFiles) return store.delete(snapshot.key);
    return store.put(snapshot);
  }).then(() => {
    externalMixLastSaveErrorShown = false;
    if (snapshot.key === externalCurrentMixKey) setExternalMixSaveState('saved', hasFiles ? 'Mezcla guardada para esta canción.' : 'No hay pistas asignadas a esta canción.');
  }).catch(error => {
    console.warn('No se pudo guardar la mezcla externa:', error);
    if (snapshot.key === externalCurrentMixKey) setExternalMixSaveState('error', 'No se pudo guardar. Comprueba el espacio disponible en el navegador.');
    if (!externalMixLastSaveErrorShown) {
      externalMixLastSaveErrorShown = true;
      showToast('No se pudo guardar la mezcla en este dispositivo. Revisa el espacio disponible del navegador.', 'error', 4000);
    }
  });
}
function queueExternalMixSave(delay = 420) {
  const song = songList[currentIndex];
  const profileId = activeProfileId || GLASSTRACK_GUEST_ID;
  const key = getExternalSongKey(song, profileId);
  if (!key) return;
  externalMixPendingSave = buildExternalMixSnapshot(key, song, profileId);
  setExternalMixSaveState('saving', 'Guardando mezcla…');
  if (externalMixSaveTimer) clearTimeout(externalMixSaveTimer);
  externalMixSaveTimer = setTimeout(() => { flushExternalMixSave(); }, delay);
}
function flushExternalMixSave() {
  if (externalMixSaveTimer) { clearTimeout(externalMixSaveTimer); externalMixSaveTimer = null; }
  const snapshot = externalMixPendingSave;
  externalMixPendingSave = null;
  if (!snapshot) return externalMixSaveChain;
  externalMixSaveChain = externalMixSaveChain.then(() => writeExternalMixSnapshot(snapshot));
  return externalMixSaveChain;
}
window.addEventListener('pagehide', () => { flushExternalMixSave(); });
function setExternalMixSaveState(state, message) {
  if (!externalMixSaveState) return;
  externalMixSaveState.dataset.state = state || '';
  externalMixSaveState.textContent = message || '';
}
function ensureExternalAudioNode(rec) {
  if (!audioCtx || !eqFilters[0] || !rec || !rec.audio) return false;
  if (rec.sourceNode && rec.gainNode) return true;
  try {
    if (!rec.sourceNode) rec.sourceNode = audioCtx.createMediaElementSource(rec.audio);
    if (!rec.gainNode) {
      rec.gainNode = audioCtx.createGain();
      rec.gainNode.gain.value = 0;
      rec.sourceNode.connect(rec.gainNode);
      rec.gainNode.connect(eqFilters[0]);
    }
    return true;
  } catch (error) {
    console.warn('No se pudo conectar una pista externa al motor de audio:', error);
    updateExternalMixerStatus(`No se pudo conectar ${rec.file ? rec.file.name : 'una pista'} al motor de audio.`, false, true);
    return false;
  }
}
function updateExternalMixerStatus(message, ready = false, error = false) {
  if (!externalMixerStatus) return;
  externalMixerStatus.textContent = message;
  externalMixerStatus.classList.toggle('is-ready', !!ready);
  externalMixerStatus.classList.toggle('is-error', !!error);
}
function updateExternalTrackControls(rec) {
  const kind = rec.kind;
  const nameTarget = document.querySelector(`[data-external-track-drop="${kind}"] span`) || document.querySelector(`[data-external-track-drop="${kind}"]`);
  const durationTarget = document.getElementById(`external-${kind}-duration`);
  const volumeTarget = document.querySelector(`[data-external-volume="${kind}"]`);
  const volumeOutput = document.getElementById(`external-${kind}-volume-value`);
  const offsetTarget = document.querySelector(`[data-external-offset="${kind}"]`);
  const offsetOutput = document.getElementById(`external-${kind}-offset-value`);
  const clearButton = kind === 'voice' ? btnClearExternalVoice : kind === 'music' ? btnClearExternalMusic : document.querySelector(`[data-external-clear="${kind}"]`);
  if (nameTarget) nameTarget.textContent = rec.file ? rec.file.name : (kind === 'voice' ? 'Seleccionar o arrastrar archivo de voz' : kind === 'music' ? 'Seleccionar o arrastrar archivo instrumental' : 'Seleccionar o arrastrar archivo');
  if (durationTarget) durationTarget.textContent = rec.audio && Number.isFinite(rec.audio.duration) && rec.audio.duration > 0 ? formatTime(rec.audio.duration) : '--:--';
  if (volumeTarget && Number(volumeTarget.value) !== rec.volume) volumeTarget.value = String(rec.volume);
  if (volumeOutput) volumeOutput.textContent = `${Math.round(rec.volume)}%`;
  if (offsetTarget && Number(offsetTarget.value) !== rec.offset) offsetTarget.value = String(rec.offset);
  if (offsetOutput) offsetOutput.textContent = `${rec.offset > 0 ? '+' : ''}${Number(rec.offset).toFixed(2)} s`;
  if (clearButton) clearButton.disabled = !rec.file;
  const muteButton = document.querySelector(`[data-external-mute="${kind}"]`);
  if (muteButton) { muteButton.textContent = rec.muted ? 'Activar sonido' : 'Silenciar'; muteButton.setAttribute('aria-pressed', rec.muted ? 'true' : 'false'); muteButton.classList.toggle('active', rec.muted); muteButton.disabled = !rec.file; }
  const slot = document.querySelector(`[data-external-track-slot="${kind}"]`);
  if (slot && kind.startsWith('extra')) slot.classList.toggle('hidden', !rec.visible && !rec.file);
  if (slot) slot.dataset.loaded = rec.file ? 'true' : 'false';
}
function refreshExternalMixerUI() {
  const records = allExternalTrackRecords();
  const isReady = rec => !!(rec.file && rec.audio && rec.audio.readyState >= 1 && Number.isFinite(rec.audio.duration) && rec.audio.duration > 0 && (!audioCtx || ensureExternalAudioNode(rec)));
  const requiredReady = isReady(externalTrackMix.voice) && isReady(externalTrackMix.music);
  const anyAssignedNotReady = records.some(rec => rec.file && !isReady(rec));
  const allReady = requiredReady && !anyAssignedNotReady;
  if (toggleExternalMix) toggleExternalMix.disabled = !allReady && !externalMixerActive;
  records.forEach(updateExternalTrackControls);
  const visibleExtras = externalTrackMix.extras.filter(rec => rec.visible || rec.file).length;
  if (btnAddExternalTrack) {
    btnAddExternalTrack.textContent = `+ Agregar pista extra (${visibleExtras}/3)`;
    btnAddExternalTrack.disabled = visibleExtras >= 3;
  }
  if (externalMixerActive) updateExternalMixerStatus(activeAudio && !activeAudio.paused ? 'Reproduciendo mezcla sincronizada.' : 'Mezcla preparada. Pulsa Reproducir.', true);
  else if (allReady) updateExternalMixerStatus('Voz e instrumental listos. La mezcla se guarda para esta canción.', true);
  else if (records.some(rec => rec.file)) updateExternalMixerStatus('Leyendo los archivos. Espera a que aparezca la duración de todas las pistas cargadas.');
  else updateExternalMixerStatus('Carga voz e instrumental para activar la mezcla.');
}
function ensureExternalAudio(kind) {
  const rec = externalTrackRecord(kind);
  if (!rec.audio) {
    rec.audio = new Audio();
    rec.audio.preload = 'auto';
    rec.audio.playsInline = true;
    rec.audio.loop = false;
    rec.audio.volume = 1;
    rec.audio.addEventListener('loadedmetadata', () => { ensureExternalAudioNode(rec); refreshExternalMixerUI(); });
    rec.audio.addEventListener('durationchange', () => refreshExternalMixerUI());
    rec.audio.addEventListener('error', () => {
      if (externalMixerActive && rec.file) handleExternalTrackEndMismatch(`No se pudo leer la pista ${rec.label}. Se pausó toda la mezcla para evitar reproducir solo algunas pistas.`);
      refreshExternalMixerUI();
      if (rec.file) updateExternalMixerStatus(`No se pudo leer ${rec.file.name}. Prueba con un archivo de audio compatible.`, false, true);
    });
    rec.audio.addEventListener('ended', () => {
      if (externalMixerActive && rec.file) handleExternalTrackEndMismatch(`${rec.label} terminó antes de que acabara la mezcla.`);
    });
  }
  if (audioCtx) ensureExternalAudioNode(rec);
  return rec.audio;
}
function initExternalTrackNodes() {
  if (!audioCtx || !eqFilters[0]) return false;
  let ok = true;
  allExternalTrackRecords().forEach(rec => { if (rec.audio && !ensureExternalAudioNode(rec)) ok = false; });
  return ok;
}
function applyExternalMixGains() {
  const master = Math.max(0, Math.min(1, Number(volumeSlider ? volumeSlider.value : 1)));
  allExternalTrackRecords().forEach(rec => {
    const voiceMusicFactor = rec.kind === 'voice' ? externalSongVoiceLevel : rec.kind === 'music' ? externalSongMusicLevel : 1;
    if (rec.gainNode) rec.gainNode.gain.value = externalMixerActive && !externalMixerMuted && !rec.muted && rec.file
      ? master * (Math.max(0, Math.min(100, Number(rec.volume) || 0)) / 100) * Math.max(0, Math.min(2, Number(voiceMusicFactor) || 0))
      : 0;
  });
  if (externalMixerActive) {
    if (mainAudioGain1) mainAudioGain1.gain.value = 0;
    if (mainAudioGain2) mainAudioGain2.gain.value = 0;
  }
  updateLegacyVmPercentages();
}
function snapshotMainAudio(audio) {
  return { src: audio.getAttribute('src') || '', currentTime: Number(audio.currentTime) || 0, volume: Number.isFinite(audio.volume) ? audio.volume : 1, muted: !!audio.muted, playbackRate: Number(audio.playbackRate) || 1, paused: !!audio.paused, loop: !!audio.loop };
}
function setEqBandValues(values) {
  const sliders = Array.from(document.querySelectorAll('.eq-band-range'));
  sliders.forEach((slider, index) => {
    if (values && values[index] !== undefined) slider.value = String(values[index]);
    const value = Number(slider.value) || 0;
    if (eqFilters[index]) eqFilters[index].gain.value = value;
  });
}
function applyExternalEqProfile(profile, restoreCurrent = false) {
  if (profile === 'current') {
    if (restoreCurrent && externalMixerPreviousState && Array.isArray(externalMixerPreviousState.eqBands)) setEqBandValues(externalMixerPreviousState.eqBands);
    return;
  }
  const preset = typeof EQ_PRESETS !== 'undefined' ? EQ_PRESETS[profile] : null;
  if (preset) setEqBandValues(preset);
}
function setExternalTrackFile(kind, file, options = {}) {
  const rec = externalTrackRecord(kind);
  if (!options.loading && !songList[currentIndex]) {
    showToast('Selecciona primero una canción de tu biblioteca para asociarle las pistas externas.', 'info', 2800);
    return false;
  }
  if (!isSupportedExternalAudio(file)) { showToast('Selecciona un archivo de audio compatible.', 'error'); return false; }
  if (!options.loading) externalMixLoadToken++;
  if (externalMixerActive) deactivateExternalMix(true, { resumeOriginal: false });
  const audio = ensureExternalAudio(kind);
  try { audio.pause(); } catch (_) {}
  if (rec.objectUrl) { try { URL.revokeObjectURL(rec.objectUrl); } catch (_) {} }
  rec.file = file;
  rec.objectUrl = URL.createObjectURL(file);
  if (kind.startsWith('extra')) rec.visible = true;
  try { audio.src = rec.objectUrl; audio.currentTime = 0; audio.load(); }
  catch (error) { console.warn('No se pudo cargar la pista externa:', error); showToast('No se pudo cargar ese archivo de audio.', 'error'); return false; }
  if (audioCtx && !ensureExternalAudioNode(rec)) return false;
  refreshExternalMixerUI();
  updateExternalMixerStatus(`Leyendo duración de ${file.name}…`);
  if (options.persist !== false && !options.loading) queueExternalMixSave();
  return true;
}
function clearExternalTrack(kind, silent = false, options = {}) {
  const rec = externalTrackRecord(kind);
  if (externalMixerActive) deactivateExternalMix(true, { resumeOriginal: false });
  if (!options.loading) externalMixLoadToken++;
  if (rec.audio) { try { rec.audio.pause(); rec.audio.removeAttribute('src'); rec.audio.load(); } catch (_) {} }
  if (rec.objectUrl) { try { URL.revokeObjectURL(rec.objectUrl); } catch (_) {} }
  rec.objectUrl = null; rec.file = null; rec.muted = false;
  if (kind.startsWith('extra') && options.keepSlot !== true) rec.visible = false;
  if (kind === 'voice' && externalVoiceFileInput) externalVoiceFileInput.value = '';
  if (kind === 'music' && externalMusicFileInput) externalMusicFileInput.value = '';
  const input = document.getElementById(`file-external-${kind}`);
  if (input) input.value = '';
  if (rec.gainNode) rec.gainNode.gain.value = 0;
  refreshExternalMixerUI();
  if (options.persist !== false && !options.loading) queueExternalMixSave();
  if (!silent) showToast(kind === 'voice' ? 'Pista de voz quitada.' : kind === 'music' ? 'Pista instrumental quitada.' : 'Pista extra quitada.', 'info', 1800);
}
function handleExternalTrackEndMismatch(message) {
  if (!externalMixerActive || externalEndMismatchHandled) return;
  externalEndMismatchHandled = true;
  pauseExternalTracks();
  if (activeAudio && !activeAudio.paused) activeAudio.pause();
  updateExternalTransportUi(false);
  updateExternalMixerStatus(message || 'Una pista terminó antes que las demás. Se pausó la mezcla para mantenerla sincronizada.', false, true);
  showToast(message || 'Una pista terminó antes que las demás; se pausó la mezcla.', 'info', 2600);
}
function syncExternalTrackTimes(force = false) {
  if (!externalMixerActive || !activeAudio) return;
  const masterTime = Number(activeAudio.currentTime) || 0;
  const masterPlaying = !activeAudio.paused;
  const records = allExternalTrackRecords().filter(rec => rec.file && rec.audio);
  if (!records.length) return;
  for (const rec of records) {
    const audio = rec.audio;
    if (audio.readyState < 1 || !Number.isFinite(audio.duration) || audio.duration <= 0) continue;
    const target = masterTime - (Number(rec.offset) || 0);
    if (target < 0) { if (!audio.paused) audio.pause(); continue; }
    if (target >= audio.duration - 0.03) { handleExternalTrackEndMismatch(`${rec.label} se quedó sin duración antes de que acabara la canción.`); return; }
    const drift = Math.abs((Number(audio.currentTime) || 0) - target);
    if (force || drift > 0.30) { try { audio.currentTime = Math.max(0, Math.min(audio.duration - 0.03, target)); } catch (_) {} }
    const speed = inputAudioSpeed ? Number(inputAudioSpeed.value) || 1 : 1;
    if (Math.abs(audio.playbackRate - speed) > 0.001) audio.playbackRate = speed;
    if (masterPlaying && audio.paused) audio.play().catch(error => {
      console.warn('No se pudo iniciar una pista externa:', error);
      updateExternalMixerStatus(`No se pudo iniciar ${rec.label}. Revisa el formato del archivo.`, false, true);
    });
    if (!masterPlaying && !audio.paused) audio.pause();
  }
}
function syncCinemaPlayControl(forcePlaying) {
  if (!cinemaPlayIcon || !cinemaPlay) return;
  const isPlaying = typeof forcePlaying === 'boolean'
    ? forcePlaying
    : !!(activeAudio && !activeAudio.paused);
  cinemaPlayIcon.innerHTML = isPlaying
    ? '<path d="M5.5 4h5.2v16H5.5zM13.3 4h5.2v16h-5.2z"/>'
    : '<path d="M8 5.1c0-.8.9-1.3 1.6-.9l10 6.8c.6.4.6 1.3 0 1.7l-10 6.8c-.7.5-1.6 0-1.6-.9z"/>';
  cinemaPlay.title = isPlaying ? 'Pausar' : 'Reproducir';
  cinemaPlay.setAttribute('aria-label', cinemaPlay.title);
}

function updateExternalTransportUi(isPlaying) {
  if (playerCard) playerCard.classList.toggle('playing', !!isPlaying);
  if (playIcon) playIcon.innerHTML = isPlaying ? '<path d="M5 4h6v16H5zM13 4h6v16h-6z"/>' : '<path d="M8 5v14l11-7z"/>';
  syncCinemaPlayControl(!!isPlaying);
  syncKaraokePlayControl(!!isPlaying);
  syncMiniPlayer(); syncVehicleMode(); syncMobileNowPlaying();
}
function startExternalTracksAt(time = 0) {
  if (!externalMixerActive) return false;
  if (externalPlaybackStartPromise) return externalPlaybackStartPromise;
  const required = [externalTrackMix.voice, externalTrackMix.music];
  const assigned = allExternalTrackRecords().filter(rec => rec.file);
  if (required.some(rec => !rec.audio || rec.audio.readyState < 1 || !Number.isFinite(rec.audio.duration)) || assigned.some(rec => !rec.audio || rec.audio.readyState < 1 || !Number.isFinite(rec.audio.duration))) {
    updateExternalMixerStatus('Preparando las pistas. Espera a que aparezcan todas las duraciones y vuelve a pulsar Reproducir.');
    return false;
  }
  const masterTime = Math.max(0, Number(time) || 0);
  externalEndMismatchHandled = false;
  const playTasks = [];
  for (const rec of assigned) {
    const audio = rec.audio;
    const target = masterTime - (Number(rec.offset) || 0);
    if (target < 0) { audio.pause(); try { audio.currentTime = 0; } catch (_) {} continue; }
    if (target >= audio.duration - 0.03) { handleExternalTrackEndMismatch(`${rec.label} terminó antes del punto de reproducción actual.`); return false; }
    try { audio.currentTime = Math.min(Math.max(0, audio.duration - 0.03), target); } catch (_) {}
    audio.loop = false;
    audio.playbackRate = inputAudioSpeed ? Number(inputAudioSpeed.value) || 1 : 1;
    if (audio.paused) playTasks.push(audio.play());
  }
  applyExternalMixGains();
  externalPlaybackStartPromise = Promise.all(playTasks).then(() => {
    if (externalMixerActive) { updateExternalTransportUi(!!(activeAudio && !activeAudio.paused)); updateExternalMixerStatus('Reproduciendo mezcla sincronizada.', true); }
    return true;
  }).catch(error => {
    console.warn('No se pudieron iniciar las pistas fusionadas:', error);
    pauseExternalTracks(); updateExternalTransportUi(false);
    updateExternalMixerStatus('No se pudieron iniciar todas las pistas. Prueba MP3 o WAV y vuelve a intentarlo.', false, true);
    showToast('No se pudieron reproducir todas las pistas. Prueba archivos compatibles.', 'error', 3500);
    return false;
  }).finally(() => { externalPlaybackStartPromise = null; });
  return externalPlaybackStartPromise;
}
function pauseExternalTracks() { allExternalTrackRecords().forEach(rec => { if (rec.audio) { try { rec.audio.pause(); } catch (_) {} } }); }
function getCurrentEqValues() { return Array.from(document.querySelectorAll('.eq-band-range')).map(slider => Number(slider.value) || 0); }
function activateExternalMix() {
  const voice = externalTrackMix.voice, music = externalTrackMix.music;
  const ready = rec => !!(rec.file && rec.objectUrl && rec.audio && rec.audio.readyState >= 1 && Number.isFinite(rec.audio.duration) && rec.audio.duration > 0);
  const assigned = allExternalTrackRecords().filter(rec => rec.file);
  if (!ready(voice) || !ready(music) || assigned.some(rec => !ready(rec))) {
    if (toggleExternalMix) toggleExternalMix.checked = false;
    showToast('Carga voz e instrumental y espera a que todas las pistas asignadas estén listas.', 'error'); refreshExternalMixerUI(); return false;
  }
  initAudioContext();
  if (!audioCtx || !Array.isArray(eqFilters) || !eqFilters.length || !initExternalTrackNodes()) {
    if (toggleExternalMix) toggleExternalMix.checked = false;
    showToast('No se pudo conectar el mezclador al motor de audio. La reproducción normal se conserva.', 'error'); return false;
  }
  const eqBands = getCurrentEqValues();
  externalMixerPreviousState = {
    activeAudio, audio1: snapshotMainAudio(audio1), audio2: snapshotMainAudio(audio2),
    wasPlaying: !!(activeAudio && !activeAudio.paused),
    mainGain1: mainAudioGain1 ? mainAudioGain1.gain.value : 1,
    mainGain2: mainAudioGain2 ? mainAudioGain2.gain.value : 1,
    eqBands,
    vmChecked: !!(toggleVmEnabled && toggleVmEnabled.checked),
    voiceValue: inputVoiceLevel ? inputVoiceLevel.value : '1',
    musicValue: inputMusicLevel ? inputMusicLevel.value : '1',
    voiceDisabled: !!(inputVoiceLevel && inputVoiceLevel.disabled), musicDisabled: !!(inputMusicLevel && inputMusicLevel.disabled),
    vmDisabled: !!(toggleVmEnabled && toggleVmEnabled.disabled),
    midGain: midGain ? midGain.gain.value : 1, sideGain: sideGain ? sideGain.gain.value : 1
  };
  externalMixerActive = true;
  externalMixerMuted = false;
  externalEndMismatchHandled = false;
  if (toggleVmEnabled) { toggleVmEnabled.checked = false; toggleVmEnabled.disabled = true; }
  // Evita que el separador Mid/Side clásico modifique además las pistas externas.
  if (midGain) midGain.gain.value = 1;
  if (sideGain) sideGain.gain.value = 1;
  if (inputVoiceLevel) { inputVoiceLevel.disabled = false; inputVoiceLevel.value = String(externalSongVoiceLevel); }
  if (inputMusicLevel) { inputMusicLevel.disabled = false; inputMusicLevel.value = String(externalSongMusicLevel); }
  updateLegacyVmPercentages();
  if (mainAudioGain1) mainAudioGain1.gain.value = 0;
  if (mainAudioGain2) mainAudioGain2.gain.value = 0;
  allExternalTrackRecords().forEach(rec => { if (rec.audio) { rec.audio.loop = false; ensureExternalAudioNode(rec); } });
  applyExternalEqProfile(externalEqProfile ? externalEqProfile.value : 'current');
  applyExternalMixGains();
  if (toggleExternalMix) toggleExternalMix.checked = true;
  const wasPlaying = !!(activeAudio && !activeAudio.paused);
  if (wasPlaying) startExternalTracksAt(activeAudio.currentTime || 0);
  else updateExternalMixerStatus('Pistas fusionadas activadas. Pulsa Reproducir para escuchar la mezcla.', true);
  refreshExternalMixerUI();
  queueExternalMixSave(0);
  showToast('Pistas fusionadas activadas para esta canción.', 'success', 2200);
  return true;
}
function deactivateExternalMix(silent = false, options = {}) {
  const wasActive = externalMixerActive;
  const previous = externalMixerPreviousState;
  externalMixerActive = false;
  externalMixerMuted = false;
  externalEndMismatchHandled = false;
  pauseExternalTracks();
  if (mainAudioGain1) mainAudioGain1.gain.value = previous && Number.isFinite(previous.mainGain1) ? previous.mainGain1 : 1;
  if (mainAudioGain2) mainAudioGain2.gain.value = previous && Number.isFinite(previous.mainGain2) ? previous.mainGain2 : 1;
  if (previous) {
    if (toggleVmEnabled) { toggleVmEnabled.disabled = !!previous.vmDisabled; toggleVmEnabled.checked = previous.vmChecked; }
    if (inputVoiceLevel) { inputVoiceLevel.disabled = !!previous.voiceDisabled; inputVoiceLevel.value = previous.voiceValue; }
    if (inputMusicLevel) { inputMusicLevel.disabled = !!previous.musicDisabled; inputMusicLevel.value = previous.musicValue; }
    if (midGain) midGain.gain.value = previous.midGain;
    if (sideGain) sideGain.gain.value = previous.sideGain;
    if (previous.eqBands) setEqBandValues(previous.eqBands);
    activeAudio = previous.activeAudio === audio2 ? audio2 : audio1;
    saveAudioSettings();
  }
  externalMixerPreviousState = null;
  if (toggleExternalMix) toggleExternalMix.checked = false;
  updateLegacyVmPercentages();
  applyExternalMixGains();
  updateExternalTransportUi(!!(activeAudio && !activeAudio.paused));
  refreshExternalMixerUI();
  if (wasActive && !silent) showToast('Pistas fusionadas desactivadas. Audio normal restaurado.', 'info', 2100);
}
function toggleExternalMixerPanel(force) {
  if (!externalTrackMixerPanel || !btnToggleExternalMixer) return;
  const open = typeof force === 'boolean' ? force : externalTrackMixerPanel.classList.contains('hidden');
  externalTrackMixerPanel.classList.toggle('hidden', !open);
  externalTrackMixerPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
  btnToggleExternalMixer.setAttribute('aria-expanded', open ? 'true' : 'false');
  btnToggleExternalMixer.classList.toggle('active', open);
}
function externalInputForKind(kind) { return document.getElementById(`file-external-${kind}`); }
function handleExternalSelectedFile(kind, file) { if (file && setExternalTrackFile(kind, file)) showToast(`${externalTrackRecord(kind).label} cargada.`, 'success', 1700); }
function renderExternalExtras() {
  externalExtraVisibleCount = externalTrackMix.extras.filter(rec => rec.visible || rec.file).length;
  refreshExternalMixerUI();
}
function addExternalExtraTrack() {
  const next = externalTrackMix.extras.find(rec => !rec.visible && !rec.file);
  if (!next) { showToast('Ya alcanzaste el máximo de tres pistas adicionales.', 'info'); return; }
  next.visible = true;
  renderExternalExtras();
  queueExternalMixSave();
}
if (btnAddExternalTrack) btnAddExternalTrack.addEventListener('click', addExternalExtraTrack);
if (btnToggleExternalMixer) btnToggleExternalMixer.addEventListener('click', () => toggleExternalMixerPanel());
if (btnCollapseExternalMixer) btnCollapseExternalMixer.addEventListener('click', () => toggleExternalMixerPanel(false));
allExternalTrackRecords().forEach(rec => {
  const input = externalInputForKind(rec.kind);
  if (input) input.addEventListener('change', event => { const file = event.target.files && event.target.files[0]; handleExternalSelectedFile(rec.kind, file); event.target.value = ''; });
});
document.querySelectorAll('[data-external-track-drop]').forEach(zone => {
  const kind = zone.getAttribute('data-external-track-drop');
  const input = externalInputForKind(kind);
  zone.addEventListener('click', () => input && input.click());
  zone.addEventListener('dragenter', event => { event.preventDefault(); event.stopPropagation(); zone.classList.add('is-drag-over'); resetDragdropOverlay(); });
  zone.addEventListener('dragover', event => { event.preventDefault(); event.stopPropagation(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; zone.classList.add('is-drag-over'); });
  zone.addEventListener('dragleave', event => { event.preventDefault(); event.stopPropagation(); if (!zone.contains(event.relatedTarget)) zone.classList.remove('is-drag-over'); });
  zone.addEventListener('drop', event => {
    event.preventDefault(); event.stopPropagation(); zone.classList.remove('is-drag-over'); resetDragdropOverlay();
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    handleExternalSelectedFile(kind, file);
  });
});
if (btnReplaceExternalVoice) btnReplaceExternalVoice.addEventListener('click', () => externalVoiceFileInput && externalVoiceFileInput.click());
if (btnReplaceExternalMusic) btnReplaceExternalMusic.addEventListener('click', () => externalMusicFileInput && externalMusicFileInput.click());
if (btnClearExternalVoice) btnClearExternalVoice.addEventListener('click', () => clearExternalTrack('voice'));
if (btnClearExternalMusic) btnClearExternalMusic.addEventListener('click', () => clearExternalTrack('music'));
document.querySelectorAll('[data-external-replace]').forEach(button => button.addEventListener('click', () => { const input = externalInputForKind(button.dataset.externalReplace); if (input) input.click(); }));
document.querySelectorAll('[data-external-clear]').forEach(button => button.addEventListener('click', () => clearExternalTrack(button.dataset.externalClear)));
document.querySelectorAll('[data-external-mute]').forEach(button => button.addEventListener('click', () => {
  const rec = externalTrackRecord(button.dataset.externalMute);
  if (!rec.file) return;
  rec.muted = !rec.muted;
  updateExternalTrackControls(rec);
  applyExternalMixGains();
  queueExternalMixSave();
}));
if (externalTrackMixerPanel) {
  externalTrackMixerPanel.addEventListener('input', event => {
    const volumeControl = event.target.closest && event.target.closest('[data-external-volume]');
    const offsetControl = event.target.closest && event.target.closest('[data-external-offset]');
    if (volumeControl) {
      const rec = externalTrackRecord(volumeControl.dataset.externalVolume);
      rec.volume = Math.max(0, Math.min(100, Number(volumeControl.value) || 0));
      applyExternalMixGains();
      const out = document.getElementById(`external-${rec.kind}-volume-value`);
      if (out) out.textContent = `${Math.round(rec.volume)}%`;
      queueExternalMixSave();
    }
    if (offsetControl) {
      const rec = externalTrackRecord(offsetControl.dataset.externalOffset);
      rec.offset = Math.max(-5, Math.min(5, Number(offsetControl.value) || 0));
      const out = document.getElementById(`external-${rec.kind}-offset-value`);
      if (out) out.textContent = `${rec.offset > 0 ? '+' : ''}${rec.offset.toFixed(2)} s`;
      if (externalMixerActive) syncExternalTrackTimes(true);
      queueExternalMixSave();
    }
  });
}
if (externalEqProfile) externalEqProfile.addEventListener('change', () => {
  if (externalMixerActive) applyExternalEqProfile(externalEqProfile.value, true);
  queueExternalMixSave();
});
if (toggleExternalMix) toggleExternalMix.addEventListener('change', event => { if (event.target.checked) activateExternalMix(); else deactivateExternalMix(); });
[audio1, audio2].forEach(mainAudio => {
  mainAudio.addEventListener('loadedmetadata', () => {
    if (externalMixerActive && activeAudio === mainAudio) updateExternalMixerStatus('Mezcla preparada. Usa Reproducir para iniciar las pistas sincronizadas.', true);
    else if (mainAudio === activeAudio && Number.isFinite(mainAudio.duration)) {
      const duration = mainAudio.duration, current = Number(mainAudio.currentTime) || 0;
      if (currentTimeEl) currentTimeEl.textContent = formatTime(current);
      if (durationEl) durationEl.textContent = formatTime(duration);
      if (cinemaCurrentTimeEl) cinemaCurrentTimeEl.textContent = formatTime(current);
      if (cinemaDurationEl) cinemaDurationEl.textContent = formatTime(duration);
      if (progress && duration > 0) progress.style.width = `${(current / duration) * 100}%`;
      if (cinemaProgress && duration > 0) cinemaProgress.style.width = `${(current / duration) * 100}%`;
    }
  });
  mainAudio.addEventListener('error', () => { if (externalMixerActive && mainAudio === activeAudio) handleExternalTrackEndMismatch('La canción principal no puede servir de reloj para esta mezcla.'); });
  mainAudio.addEventListener('play', () => { if (externalMixerActive && mainAudio === activeAudio) startExternalTracksAt(mainAudio.currentTime || 0); });
  mainAudio.addEventListener('pause', () => { if (externalMixerActive && mainAudio === activeAudio) pauseExternalTracks(); });
  mainAudio.addEventListener('seeked', () => { if (externalMixerActive && mainAudio === activeAudio) syncExternalTrackTimes(true); });
  mainAudio.addEventListener('timeupdate', () => { if (externalMixerActive && mainAudio === activeAudio) syncExternalTrackTimes(false); });
});
function resetExternalTrackRuntime(rec) {
  if (rec.audio) { try { rec.audio.pause(); rec.audio.removeAttribute('src'); rec.audio.load(); } catch (_) {} }
  if (rec.objectUrl) { try { URL.revokeObjectURL(rec.objectUrl); } catch (_) {} }
  rec.objectUrl = null; rec.file = null; rec.muted = false;
  rec.volume = 100; rec.offset = 0;
  rec.visible = !rec.kind.startsWith('extra');
  if (rec.gainNode) rec.gainNode.gain.value = 0;
}
async function loadExternalMixForSong(song, profileId, token) {
  const key = getExternalSongKey(song, profileId);
  if (!key) return;
  try {
    await flushExternalMixSave();
    await externalMixSaveChain;
    const record = await externalMixRequest('readonly', store => store.get(key));
    if (token !== externalMixLoadToken || key !== externalCurrentMixKey || String(profileId) !== String(activeProfileId || GLASSTRACK_GUEST_ID)) return;
    if (!record || !Array.isArray(record.tracks)) { refreshExternalMixerUI(); return; }
    for (const saved of record.tracks) {
      const rec = externalTrackRecord(saved.kind);
      if (!rec) continue;
      rec.volume = Math.max(0, Math.min(100, Number(saved.volume ?? 100)));
      rec.offset = Math.max(-5, Math.min(5, Number(saved.offset) || 0));
      rec.muted = !!saved.muted;
      rec.visible = !!saved.visible || !!saved.blob;
      if (saved.blob) {
        let file;
        try { file = new File([saved.blob], saved.name || `${rec.kind}.audio`, { type: saved.type || saved.blob.type || 'application/octet-stream', lastModified: Number(saved.lastModified) || Date.now() }); }
        catch (_) { file = saved.blob; try { Object.defineProperty(file, 'name', { value: saved.name || `${rec.kind}.audio` }); } catch (_) {} }
        setExternalTrackFile(rec.kind, file, { loading: true, persist: false });
      }
    }
    if (externalEqProfile) externalEqProfile.value = ['current','bass','treble','vocal','reset'].includes(record.eqProfile) ? record.eqProfile : 'current';
    externalSongVoiceLevel = Math.max(0, Math.min(2, Number(record.voiceControlLevel ?? 1)));
    externalSongMusicLevel = Math.max(0, Math.min(2, Number(record.musicControlLevel ?? 1)));
    externalExtraVisibleCount = externalTrackMix.extras.filter(rec => rec.visible || rec.file).length;
    refreshExternalMixerUI();
    updateExternalMixerStatus(record.tracks.some(item => item.blob) ? 'Mezcla de esta canción cargada.' : 'Esta canción no tiene pistas externas guardadas.', !!(externalTrackMix.voice.file && externalTrackMix.music.file));
  } catch (error) {
    console.warn('No se pudo recuperar la mezcla de esta canción:', error);
    updateExternalMixerStatus('No se pudo recuperar la mezcla guardada. Puedes volver a seleccionar los archivos.', false, true);
  }
}
function prepareExternalMixForSongChange(song) {
  const key = getExternalSongKey(song, activeProfileId);
  if (key && key === externalCurrentMixKey) return;
  flushExternalMixSave();
  if (externalMixerActive) deactivateExternalMix(true, { resumeOriginal: false, restoreUI: false });
  const token = ++externalMixLoadToken;
  allExternalTrackRecords().forEach(resetExternalTrackRuntime);
  externalCurrentMixKey = key;
  externalExtraVisibleCount = 0;
  if (externalEqProfile) externalEqProfile.value = 'current';
  externalSongVoiceLevel = 1; externalSongMusicLevel = 1;
  setExternalMixSaveState('', '');
  refreshExternalMixerUI();
  if (song && key) loadExternalMixForSong(song, activeProfileId, token);
}
document.addEventListener('glasstrack:profile-switched', () => {
  flushExternalMixSave();
  if (externalMixerActive) deactivateExternalMix(true, { resumeOriginal: false, restoreUI: false });
  ++externalMixLoadToken;
  allExternalTrackRecords().forEach(resetExternalTrackRuntime);
  externalCurrentMixKey = '';
  externalExtraVisibleCount = 0;
  if (toggleExternalMix) toggleExternalMix.checked = false;
  toggleExternalMixerPanel(false);
  refreshExternalMixerUI();
});


// Mensajes tipo "toast" abajo a la izquierda, en vez del alert() feo del navegador.
const toastContainer = document.getElementById('toast-container');
function showToast(message, type = 'info', duration = 4000) {
  if (!toastContainer) { console.warn(message); return; }
  const toast = document.createElement('div');
  toast.className = 'app-toast' + (type === 'error' ? ' toast-error' : '');
  toast.textContent = message;
  toastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('active'));
  setTimeout(() => {
    toast.classList.remove('active');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Un solo AudioContext reutilizado para los SFX (antes se creaba uno nuevo cada vez,
// lo cual desperdicia recursos y puede sonar entrecortado).
let sfxAudioCtx = null;
function getSfxContext() {
  if (!sfxAudioCtx) {
    try { sfxAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { return null; }
  }
  if (sfxAudioCtx.state === 'suspended') sfxAudioCtx.resume();
  return sfxAudioCtx;
}

// Sonido de interfaz estilo teclado mecánico: un golpe muy corto, con
// transitorio agudo + pequeño "thock" filtrado. No usa archivos externos.
function playMechanicalKey(ctx, startTime, intensity = 1) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const clickOsc = ctx.createOscillator();
  const clickGain = ctx.createGain();
  const clickFilter = ctx.createBiquadFilter();

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(1850, startTime);
  filter.Q.value = 0.7;
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(125, startTime);
  osc.frequency.exponentialRampToValueAtTime(82, startTime + 0.045);
  osc.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.linearRampToValueAtTime(0.026 * intensity, startTime + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.055);

  clickFilter.type = 'bandpass';
  clickFilter.frequency.setValueAtTime(4300, startTime);
  clickFilter.Q.value = 1.15;
  clickOsc.type = 'square';
  clickOsc.frequency.setValueAtTime(4100, startTime);
  clickOsc.frequency.exponentialRampToValueAtTime(2350, startTime + 0.018);
  clickOsc.connect(clickFilter);
  clickFilter.connect(clickGain);
  clickGain.connect(ctx.destination);
  clickGain.gain.setValueAtTime(0.0001, startTime);
  clickGain.gain.linearRampToValueAtTime(0.012 * intensity, startTime + 0.001);
  clickGain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.024);

  osc.start(startTime);
  osc.stop(startTime + 0.065);
  clickOsc.start(startTime);
  clickOsc.stop(startTime + 0.03);
}

function playSFX(type = 'click') {
  if (!sfxEnabled) return;
  const ctx = getSfxContext();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    if (type === 'open') {
      playMechanicalKey(ctx, now, 0.92);
      playMechanicalKey(ctx, now + 0.045, 0.72);
    } else if (type === 'close') {
      playMechanicalKey(ctx, now, 0.86);
      playMechanicalKey(ctx, now + 0.032, 0.62);
    } else {
      playMechanicalKey(ctx, now, 0.78);
    }
  } catch (e) {}
}

// ==========================================
// 4. MEDIA SESSION Y ESTADÍSTICAS
// ==========================================
function updateMediaSession(song) {
  if (!('mediaSession' in navigator) || !song) return;
  const showBar = toggleShowBar ? toggleShowBar.checked : true;
  const showIcon = toggleShowIcon ? toggleShowIcon.checked : true;
  const showName = toggleShowName ? toggleShowName.checked : true;
  const mediaKeys = toggleMediaKeys ? toggleMediaKeys.checked : true;

  if (!showBar) {
    try { navigator.mediaSession.metadata = null; } catch (e) {}
    clearMediaSessionHandlers();
    return;
  }

  const artwork = showIcon && song.cover ? [{ src: song.cover, sizes: '512x512', type: 'image/jpeg' }] : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: showName ? (song.title || 'Sin canción cargada') : '',
    artist: showName ? (song.artist || 'GLASSTRACK') : '',
    album: 'Mi Música',
    artwork
  });

  if (!mediaKeys) {
    clearMediaSessionHandlers();
    return;
  }

  try { navigator.mediaSession.setActionHandler('play', () => playSong()); } catch (e) {}
  try { navigator.mediaSession.setActionHandler('pause', () => pauseSong()); } catch (e) {}
  try { navigator.mediaSession.setActionHandler('previoustrack', () => prevBtn && prevBtn.click()); } catch (e) {}
  try { navigator.mediaSession.setActionHandler('nexttrack', () => nextBtn && nextBtn.click()); } catch (e) {}
}


setInterval(() => {
  if (playerCard && playerCard.classList.contains('playing')) {
    totalPlayedSeconds++;
    writeProfileValue('totalPlayedSeconds', totalPlayedSeconds.toString());
    updateTimeStatDisplay();

    const todayKey = getDateKey();
    listeningStats.daily[todayKey] = (listeningStats.daily[todayKey] || 0) + 1;
    const song = songList[currentIndex];
    if (song) {
      const songKey = song.id !== undefined ? ('id:' + song.id) : (song.title + '||' + song.artist);
      listeningStats.bySong[songKey] = (listeningStats.bySong[songKey] || 0) + 1;
      if (song.artist) listeningStats.byArtist[song.artist] = (listeningStats.byArtist[song.artist] || 0) + 1;
    }
    saveListeningStats();
    updateListeningStatsDisplay();
  }
}, 1000);

function updateTimeStatDisplay() {
  const hours = Math.floor(totalPlayedSeconds / 3600);
  const minutes = Math.floor((totalPlayedSeconds % 3600) / 60);
  const seconds = Math.floor(totalPlayedSeconds % 60);

  if (statPlayTimePreview) statPlayTimePreview.textContent = `${hours}h ${minutes}m`;
  if (statPlayTimeDetail) statPlayTimeDetail.textContent = `${hours}h ${minutes}m ${seconds}s`;

  let rank = "Principiante";
  if (hours >= 1000) rank = "Infinito Hacker";
  else if (hours >= 500) rank = "Pro Maestro";
  else if (hours >= 100) rank = "Avanzado";
  else if (hours >= 10) rank = "Aficionado";

  if (statRankBadge) statRankBadge.textContent = rank;
  if (statRankText) statRankText.textContent = rank;
}
updateTimeStatDisplay();

// --- Estadísticas de escucha: hoy, artista más escuchado, top canciones ---
function getDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = ('0' + (d.getMonth() + 1)).slice(-2);
  const day = ('0' + d.getDate()).slice(-2);
  return `${y}-${m}-${day}`;
}

let listeningStats = { daily: {}, bySong: {}, byArtist: {} };
try {
  const stored = JSON.parse(readProfileValue('listeningStats', activeProfileId, '{}') || '{}');
  listeningStats.daily = stored.daily || {};
  listeningStats.bySong = stored.bySong || {};
  listeningStats.byArtist = stored.byArtist || {};
} catch (err) { /* datos corruptos o inexistentes: seguimos con listas vacías */ }

function saveListeningStats() {
  // Solo nos quedamos con los últimos 30 días para que esto no crezca sin límite
  const keys = Object.keys(listeningStats.daily).sort();
  if (keys.length > 30) keys.slice(0, keys.length - 30).forEach(k => delete listeningStats.daily[k]);
  writeProfileValue('listeningStats', JSON.stringify(listeningStats));
}

function updateListeningStatsDisplay() {
  const todaySeconds = listeningStats.daily[getDateKey()] || 0;
  const statTodayTime = document.getElementById('stat-today-time');
  if (statTodayTime) statTodayTime.textContent = `${Math.floor(todaySeconds / 60)}m ${Math.floor(todaySeconds % 60)}s`;

  const artistEntries = Object.entries(listeningStats.byArtist).sort((a, b) => b[1] - a[1]);
  const statTopArtist = document.getElementById('stat-top-artist');
  if (statTopArtist) statTopArtist.textContent = artistEntries.length > 0 ? artistEntries[0][0] : '-';

  const statTopSongsList = document.getElementById('stat-top-songs');
  if (statTopSongsList) {
    const songEntries = Object.entries(listeningStats.bySong).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (songEntries.length === 0) {
      statTopSongsList.innerHTML = '<li class="empty-msg">Todavía no hay datos suficientes</li>';
    } else {
      statTopSongsList.innerHTML = songEntries.map(([key, seconds], i) => {
        let song = null;
        if (key.startsWith('id:')) {
          const idVal = key.slice(3);
          song = songList.find(s => String(s.id) === idVal);
        } else {
          const [t, a] = key.split('||');
          song = songList.find(s => s.title === t && s.artist === a);
        }
        const name = song ? song.title : 'Canción no disponible';
        const art = song ? song.artist : '';
        return `<li><span>${i + 1}. ${name}${art ? ' — ' + art : ''}</span><span class="stat-count">${Math.floor(seconds / 60)}m</span></li>`;
      }).join('');
    }
  }
}
updateListeningStatsDisplay();

// Temporizador
document.querySelectorAll('.timer-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    playSFX('click');
    startSleepTimer(parseInt(e.target.dataset.minutes, 10));
  });
});

function startSleepTimer(minutes) {
  clearInterval(sleepTimerInterval);
  if (minutes <= 0) {
    sleepTimeRemaining = 0;
    if (timerStatusDesc) timerStatusDesc.textContent = "Desactivado";
    if (sleepTimerBadge) sleepTimerBadge.classList.add('hidden');
    return;
  }
  sleepTimeRemaining = minutes * 60;
  updateTimerUI();

  sleepTimerInterval = setInterval(() => {
    sleepTimeRemaining--;
    if (sleepTimeRemaining <= 0) {
      clearInterval(sleepTimerInterval);
      pauseSong();
      if (timerStatusDesc) timerStatusDesc.textContent = "Desactivado";
      if (sleepTimerBadge) sleepTimerBadge.classList.add('hidden');
    } else {
      updateTimerUI();
    }
  }, 1000);
}

function updateTimerUI() {
  const m = Math.floor(sleepTimeRemaining / 60);
  const s = sleepTimeRemaining % 60;
  const str = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  if (timerStatusDesc) timerStatusDesc.textContent = `Apagado en ${str}`;
  if (sleepTimerBadge) {
    sleepTimerBadge.textContent = str;
    sleepTimerBadge.classList.remove('hidden');
  }
}


// ==========================================
// COPIA DE SEGURIDAD JSON / ZIP / JAR
// ==========================================
function downloadFileBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function serializeSongForBackup(song) {
  const copy = { ...song };
  delete copy.fileBlob;
  delete copy.url;
  return copy;
}

async function collectBackupPayload(includeFiles = false) {
  const songs = Array.isArray(songList) ? songList : [];
  const payload = {
    format: 'glasstrack-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    songs: songs.map(serializeSongForBackup),
    playlists,
    audioSettings: localStorage.getItem('audioSettings'),
    listeningStats: readProfileValue('listeningStats', activeProfileId, '{}'),
    totalPlayedSeconds: readProfileValue('totalPlayedSeconds', activeProfileId, '0'),
    concludorChain: localStorage.getItem('concludorChain'),
    customCardStyles: localStorage.getItem('customCardStyles'),
    glasstrackGlassAlpha: localStorage.getItem('glasstrackGlassAlpha'),
    glasstrackShowBar: localStorage.getItem('glasstrackShowBar'),
    glasstrackShowIcon: localStorage.getItem('glasstrackShowIcon'),
    glasstrackShowName: localStorage.getItem('glasstrackShowName'),
    glasstrackMediaKeys: localStorage.getItem('glasstrackMediaKeys')
  };
  if (includeFiles) {
    payload.files = songs.map((song, index) => ({
      index,
      name: song.fileBlob?.name || `${String(song.title || 'song').replace(/[^a-z0-9._-]+/gi, '_')}.bin`,
      type: song.fileBlob?.type || 'application/octet-stream'
    }));
  }
  return payload;
}

async function exportLibraryJson() {
  const payload = await collectBackupPayload(false);
  downloadFileBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }), 'glasstrack-backup.json');
  showToast('Copia JSON exportada.', 'info', 1800);
}

async function exportLibraryArchive(extension) {
  if (!window.JSZip) {
    showToast('No se pudo cargar el motor ZIP. Recarga la página e inténtalo de nuevo.', 'error');
    return;
  }
  const zip = new JSZip();
  const payload = await collectBackupPayload(true);
  zip.file('glasstrack-backup.json', JSON.stringify(payload, null, 2));
  const songsFolder = zip.folder('songs');
  for (let i = 0; i < songList.length; i++) {
    const blob = songList[i]?.fileBlob;
    if (blob && songsFolder) songsFolder.file(payload.files[i].name, blob);
  }
  const out = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const filename = `glasstrack-backup.${extension}`;
  downloadFileBlob(out, filename);
  showToast(`Copia ${extension.toUpperCase()} exportada.`, 'info', 1800);
}

function remapPlaylistEntries(importedPlaylists, idMap) {
  const result = {};
  Object.entries(importedPlaylists || {}).forEach(([name, entries]) => {
    result[name] = Array.isArray(entries) ? entries.map(entry => {
      const copy = { ...entry };
      if (copy.id !== undefined && idMap.has(String(copy.id))) copy.id = idMap.get(String(copy.id));
      return copy;
    }) : [];
  });
  return result;
}

async function importLibraryJsonPayload(payload, zip = null) {
  if (!payload || payload.format !== 'glasstrack-backup') throw new Error('El archivo no es una copia de Glasstrack Pro válida.');
  const importedSongs = Array.isArray(payload.songs) ? payload.songs : [];
  const idMap = new Map();
  let importedCount = 0;

  for (let i = 0; i < importedSongs.length; i++) {
    const source = importedSongs[i];
    let fileBlob = null;
    const fileInfo = Array.isArray(payload.files) ? payload.files.find(f => f.index === i) : null;
    if (zip && fileInfo) {
      const archiveFile = zip.file(`songs/${fileInfo.name}`);
      if (archiveFile) {
        const bytes = await archiveFile.async('uint8array');
        fileBlob = new Blob([bytes], { type: fileInfo.type || 'application/octet-stream' });
        try { fileBlob.name = fileInfo.name; } catch (e) {}
      }
    }
    if (!fileBlob && source.fileBlob) fileBlob = source.fileBlob;

    const song = {
      ...source,
      accountId: activeProfileId,
      fileBlob,
      url: fileBlob ? URL.createObjectURL(fileBlob) : ''
    };
    delete song.id;

    if (!db) throw new Error('La base de datos aún no está lista.');
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['songs'], 'readwrite');
      const req = tx.objectStore('songs').add(song);
      req.onsuccess = e => {
        if (source.id !== undefined) idMap.set(String(source.id), e.target.result);
        song.id = e.target.result;
        resolve();
      };
      req.onerror = () => reject(req.error || new Error('No se pudo importar una canción.'));
    });
    importedCount++;
  }

  if (payload.playlists) {
    const importedPlaylists = remapPlaylistEntries(payload.playlists, idMap);
    playlists = { ...playlists, ...importedPlaylists };
    savePlaylistsToStorage();
  }
  const localKeys = ['audioSettings','listeningStats','totalPlayedSeconds','concludorChain','customCardStyles','glasstrackGlassAlpha','glasstrackShowBar','glasstrackShowIcon','glasstrackShowName','glasstrackMediaKeys'];
  localKeys.forEach(key => {
    if (payload[key] === undefined || payload[key] === null) return;
    if (['listeningStats','totalPlayedSeconds','concludorChain'].includes(key)) writeProfileValue(key, payload[key]);
    else localStorage.setItem(key, payload[key]);
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  loadStoredSongs();
  showToast(`Importación completada: ${importedCount} canción(es).`, 'info', 2200);
}

if (document.getElementById('btn-export-json')) document.getElementById('btn-export-json').addEventListener('click', exportLibraryJson);
if (document.getElementById('btn-export-zip')) document.getElementById('btn-export-zip').addEventListener('click', () => exportLibraryArchive('zip'));
if (document.getElementById('btn-export-jar')) document.getElementById('btn-export-jar').addEventListener('click', () => exportLibraryArchive('jar'));
if (document.getElementById('input-import-json')) {
  document.getElementById('input-import-json').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const ext = file.name.toLowerCase().split('.').pop();
      if (ext === 'json') {
        const payload = JSON.parse(await file.text());
        await importLibraryJsonPayload(payload);
      } else if (ext === 'zip' || ext === 'jar') {
        if (!window.JSZip) throw new Error('Motor ZIP no disponible.');
        const zip = await JSZip.loadAsync(file);
        const manifest = zip.file('glasstrack-backup.json');
        if (!manifest) throw new Error('El ZIP/JAR no contiene glasstrack-backup.json.');
        const payload = JSON.parse(await manifest.async('string'));
        await importLibraryJsonPayload(payload, zip);
      } else {
        throw new Error('Formato no soportado.');
      }
    } catch (err) {
      console.error(err);
      showToast(`No se pudo importar el archivo: ${err.message || 'formato inválido'}`, 'error', 3500);
    }
  });
}

// ==========================================
// 5. INDEXEDDB Y GESTIÓN DE ARCHIVOS
// ==========================================
function saveSongToDB(songObj) {
  return new Promise((resolve, reject) => {
    if (!db || !songObj) { reject(new Error('El almacenamiento de Glasstrack todavía no está listo.')); return; }
    if (!songObj.accountId) songObj.accountId = activeProfileId;

    let generatedId = null;
    let settled = false;
    let tx;
    try {
      tx = db.transaction(['songs'], 'readwrite');
      const req = tx.objectStore('songs').add(songObj);
      req.onsuccess = event => { generatedId = event.target.result; };
      req.onerror = () => { /* El rechazo de la transacción incluye, por ejemplo, cuota agotada. */ };
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        if (generatedId !== null && generatedId !== undefined) songObj.id = generatedId;
        try { localStorage.setItem('glasstrack_library_had_songs_v1', 'true'); } catch (_) {}
        resolve(songObj.id);
      };
      tx.onerror = () => {
        if (settled) return;
        settled = true;
        const error = tx.error || new Error('No se pudo guardar la canción.');
        reject(error);
      };
      tx.onabort = () => {
        if (settled) return;
        settled = true;
        const error = tx.error || new Error('El guardado fue cancelado. Comprueba el espacio disponible.');
        reject(error);
      };
    } catch (error) {
      if (!settled) { settled = true; reject(error); }
    }
  });
}

function updateSongInDB(songObj) {
  if (!db || !songObj || songObj.id === undefined) return;
  if (!songObj.accountId) songObj.accountId = activeProfileId;
  try {
    const tx = db.transaction(['songs'], 'readwrite');
    tx.objectStore('songs').put(songObj);
    tx.onerror = () => console.warn('No se pudieron guardar los cambios de la canción:', tx.error);
    tx.onabort = () => console.warn('Se canceló la actualización de la canción:', tx.error);
  } catch (error) { console.warn('No se pudo iniciar la actualización de la canción:', error); }
}

function clearCurrentTrackUI() {
  try { audio1.pause(); audio2.pause(); } catch (_) {}
  currentIndex = 0;
  if (title) title.textContent = 'Sin canción';
  if (artist) artist.textContent = 'Selecciona una canción';
  if (cover) cover.src = 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=500&q=80';
  if (progress) progress.style.width = '0%';
  if (currentTimeEl) currentTimeEl.textContent = '0:00';
  if (durationEl) durationEl.textContent = '0:00';
}

function loadStoredSongs() {
  if (!db || !db.objectStoreNames.contains('songs')) {
    // No convertimos una apertura pendiente o fallida en una biblioteca vacía.
    return Promise.resolve(false);
  }

  const generation = ++libraryLoadGeneration;
  const requestedProfileId = activeProfileId;

  return new Promise(resolve => {
    let tx;
    let request;
    let settled = false;
    const settle = value => { if (!settled) { settled = true; resolve(value); } };

    const showReadError = error => {
      if (settled) return;
      if (generation !== libraryLoadGeneration || requestedProfileId !== activeProfileId) {
        settle(false);
        return;
      }
      console.error('No se pudo leer la biblioteca de IndexedDB; no se ejecutó ningún borrado:', error || tx?.error || request?.error);
      // Si había una biblioteca ya mostrada, la conservamos. No vaciamos songList ni la UI por un error de lectura.
      if (songList.length) renderPlaylist();
      showToast('No se pudo leer la biblioteca local. Tus canciones no se han borrado desde esta operación; no restablezcas los datos. Cierra otras pestañas de Glasstrack y vuelve a cargar.', 'error', 7000);
      settle(false);
    };

    try {
      tx = db.transaction(['songs'], 'readonly');
      request = tx.objectStore('songs').getAll();
    } catch (error) {
      showReadError(error);
      return;
    }

    request.onerror = () => showReadError(request.error);
    tx.onerror = () => showReadError(tx.error);
    tx.onabort = () => showReadError(tx.error || new Error('Lectura de biblioteca abortada'));

    request.onsuccess = () => {
      if (settled) return;
      if (generation !== libraryLoadGeneration || requestedProfileId !== activeProfileId) {
        settle(false);
        return;
      }

      const storedSongs = Array.isArray(request.result) ? request.result : [];
      const targetProfile = requestedProfileId;
      const rawAccounts = localStorage.getItem(GLASSTRACK_ACCOUNTS_KEY);
      const accounts = parseStoredAccounts();
      const knownAccountIds = new Set(accounts.map(account => String(account.id)));
      const mutations = [];
      const claimedIds = new Set();
      const recoveredIds = new Set();

      // Si el índice local de cuentas se perdió pero IndexedDB conserva canciones
      // asociadas a perfiles que ya no existen, las reasignamos al Invitado en vez
      // de ocultarlas indefinidamente. Solo se hace para perfiles huérfanos.
      if (targetProfile === GLASSTRACK_GUEST_ID) {
        const accountIndexIsEmpty = rawAccounts === null || rawAccounts.trim() === '[]';
        if (accountIndexIsEmpty) {
          storedSongs.forEach(song => {
            const owner = song.accountId ? String(song.accountId) : '';
            if (owner && owner !== GLASSTRACK_GUEST_ID && !knownAccountIds.has(owner)) {
              song.accountId = GLASSTRACK_GUEST_ID;
              mutations.push(song);
              recoveredIds.add(String(song.id));
            }
          });
        } else if (accounts.length > 0) {
          // También recuperamos registros cuyo perfil ya no existe, sin mezclar canciones
          // de perfiles que siguen registrados.
          storedSongs.forEach(song => {
            const owner = song.accountId ? String(song.accountId) : '';
            if (owner && owner !== GLASSTRACK_GUEST_ID && !knownAccountIds.has(owner)) {
              song.accountId = GLASSTRACK_GUEST_ID;
              mutations.push(song);
              recoveredIds.add(String(song.id));
            }
          });
        }
      }

      // La primera cuenta activa hereda registros antiguos sin perfil. Se muestran
      // en esta misma lectura y no desaparecen hasta un segundo reinicio.
      if (targetProfile !== GLASSTRACK_GUEST_ID) {
        storedSongs.forEach(song => {
          if (!song.accountId) {
            song.accountId = targetProfile;
            mutations.push(song);
            claimedIds.add(String(song.id));
          }
        });
      }

      const finalize = writeError => {
        if (settled) return;
        if (generation !== libraryLoadGeneration || requestedProfileId !== activeProfileId) {
          settle(false);
          return;
        }

        if (writeError) {
          console.warn('La biblioteca se mostrará, pero no se pudo guardar una reasignación de perfil:', writeError);
          showToast('Se encontraron canciones conservadas, pero no se pudo guardar por completo su perfil. No se han eliminado; comprueba el espacio y vuelve a cargar.', 'warning', 6000);
        } else if (recoveredIds.size > 0) {
          showToast(`Se recuperaron ${recoveredIds.size} canción(es) que estaban asociadas a perfiles que ya no existen.`, 'success', 4500);
        }

        const visible = storedSongs.filter(song => {
          const owner = song.accountId || GLASSTRACK_GUEST_ID;
          return owner === targetProfile || claimedIds.has(String(song.id)) || recoveredIds.has(String(song.id));
        });

        songList = visible.map(song => {
          let safeUrl = song.directUrl || '';
          if (song.fileBlob) {
            try { safeUrl = URL.createObjectURL(song.fileBlob); }
            catch (error) { console.warn('No se pudo reconstruir el archivo local:', song.title, error); }
          }
          return { ...song, url: safeUrl };
        });

        if (storedSongs.length > 0) {
          try { localStorage.setItem('glasstrack_library_had_songs_v1', 'true'); } catch (_) {}
        }
        ensureGlasstrackInitialized();
        renderPlaylist();

        const countKey = libraryCountStorageKey(targetProfile);
        const previousCountRaw = localStorage.getItem(countKey);
        const previousCount = previousCountRaw === null ? null : Math.max(0, Number(previousCountRaw) || 0);
        if (songList.length > 0) {
          if (previousCount !== null && songList.length < previousCount) {
            // No reducimos automáticamente el último inventario conocido: podría tratarse
            // de una carga incompleta o de un perfil/origen cambiado entre actualizaciones.
            showToast(`Aviso de biblioteca: ahora se encontraron ${songList.length} canción(es), pero el último recuento registrado era ${previousCount}. No hemos sobrescrito el recuento anterior; revisa el perfil y la carpeta antes de seguir modificando datos.`, 'warning', 8500);
          } else {
            saveLibraryCountHint(targetProfile, songList.length);
          }
          const firstVisibleIndex = songList.findIndex(song => song && !song.isHidden);
          if (firstVisibleIndex >= 0) loadSong(firstVisibleIndex, false);
          else clearCurrentTrackUI();
        } else {
          clearCurrentTrackUI();
          const otherProfileCount = storedSongs.filter(song => (song.accountId || GLASSTRACK_GUEST_ID) !== targetProfile).length;
          if (otherProfileCount > 0) {
            showToast(`Hay ${otherProfileCount} canción(es) guardada(s) en otro perfil. No se han borrado: cambia a la cuenta donde se guardaron.`, 'info', 6500);
          }

          const previouslyHadSongs = previousCount !== null
            ? previousCount > 0
            : localStorage.getItem('glasstrack_library_had_songs_v1') === 'true';
          if (storedSongs.length === 0 && previouslyHadSongs) {
            // No sobrescribir el último recuento conocido: podría ser un origen distinto,
            // una base temporalmente vacía o una pérdida real. En ningún caso borrar más datos.
            showToast('La biblioteca aparece vacía, aunque antes tenía canciones. Glasstrack no ha borrado registros en esta lectura. Mantén abierta esta misma carpeta/origen, cierra otras pestañas y vuelve a cargar antes de restablecer nada.', 'warning', 8500);
          }
        }
        settle(true);
      };

      if (!mutations.length) {
        finalize(null);
        return;
      }

      let writeTx;
      try {
        writeTx = db.transaction(['songs'], 'readwrite');
        const store = writeTx.objectStore('songs');
        mutations.forEach(song => store.put(song));
        writeTx.oncomplete = () => finalize(null);
        writeTx.onerror = () => finalize(writeTx.error || new Error('No se pudieron guardar los propietarios de las canciones'));
        writeTx.onabort = () => finalize(writeTx.error || new Error('Se abortó la actualización de la biblioteca'));
      } catch (error) {
        finalize(error);
      }
    };
  });
}

async function switchActiveProfile(profileId, options = {}) {
  if (!profileId || profileId === activeProfileId) return;
  saveProfileScopedState(activeProfileId);
  clearCurrentTrackUI();
  songList = [];
  currentPlaylistView = null;
  activePlaybackPlaylist = null;
  if (typeof syncLoopButtons === 'function') syncLoopButtons();
  activeProfileId = profileId;
  accountSessionActive = profileId !== GLASSTRACK_GUEST_ID;
  localStorage.setItem(GLASSTRACK_ACTIVE_PROFILE_KEY, profileId);
  localStorage.setItem(GLASSTRACK_SESSION_KEY, accountSessionActive ? '1' : '0');
  loadProfileScopedState(activeProfileId);
  loadStoredSongs();
  renderPlaylist();
  refreshAccountStatus?.();
  document.dispatchEvent(new CustomEvent('glasstrack:profile-switched', { detail: { profileId: activeProfileId } }));
  if (!options.silent) {
    const acc = currentAccount();
    showToast(acc ? `Cuenta activa: ${acc.name}` : 'Modo invitado activo.', 'info', 2000);
  }
}

function handleFiles(files) {
  Array.from(files || []).forEach((file) => {
    if (!file) return;

    const mime = String(file.type || '').toLowerCase();
    const name = String(file.name || '').toLowerCase();
    const isImage = mime.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(name);
    const isAudio = mime.startsWith('audio/') || /\.(mp3|wav|flac|ogg|m4a|aac|opus)$/i.test(name);

    // Las imágenes nunca pasan por el pipeline de audio.
    if (isImage) {
      if (bgCustomImage && bgVideo) {
        localStorage.removeItem(BG_REMOVED_FLAG);
        localStorage.setItem('glasstrackB31BackgroundMode', 'stored');
        if (selectBgMode) selectBgMode.value = 'stored';
        const objectUrl = URL.createObjectURL(file);
        bgCustomImage.style.backgroundImage = `url("${objectUrl}")`;
        bgCustomImage.style.display = 'block';
        bgVideo.classList.add('bg-video-hidden');

        saveBackgroundToDB('image', file);

        // No tocar audio, currentTime ni songList.
        showToast('Imagen aplicada como fondo sin detener la música.', 'info');
      }
      return;
    }

    // Solo archivos de audio soportados llegan a la biblioteca.
    if (!isAudio) {
      return;
    }

    const songObj = {
      title: file.name.replace(/\.[^/.]+$/, ''),
      artist: 'Artista Desconocido',
      cover: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=500&q=80',
      lyrics: 'No hay letra cargada.',
      isFav: false,
      isHidden: false,
      fileBlob: file,
      accountId: activeProfileId
    };

    if (window.jsmediatags) {
      window.jsmediatags.read(file, {
        onSuccess: function(tag) {
          const tags = tag.tags;
          if (tags.title) songObj.title = tags.title;
          if (tags.artist) songObj.artist = tags.artist;
          if (tags.picture) {
            const { data, format } = tags.picture;
            let base64String = '';
            for (let i = 0; i < data.length; i++) base64String += String.fromCharCode(data[i]);
            songObj.cover = `data:${format};base64,${window.btoa(base64String)}`;
          }
          processAndSave(songObj);
        },
        onError: function() { processAndSave(songObj); }
      });
    } else {
      processAndSave(songObj);
    }
  });
}

async function processAndSave(songObj) {
  try {
    // Reintentar el permiso persistente tras una acción explícita del usuario.
    // No es una copia adicional: ayuda a evitar que el navegador evicte el almacenamiento local.
    retryPersistentStorageAfterUserAction();
    // La canción no se anuncia en la biblioteca hasta que IndexedDB confirme el commit.
    const destinationProfileId = songObj.accountId || activeProfileId;
    await saveSongToDB(songObj);
    songObj.url = URL.createObjectURL(songObj.fileBlob);
    if (destinationProfileId !== activeProfileId) {
      // La selección de perfil cambió mientras se leían los metadatos del archivo.
      // El registro se conserva en su perfil de origen y no contamina la lista actual.
      loadStoredSongs();
      showToast('La canción se guardó en el perfil que estaba activo al seleccionarla. No se ha perdido; vuelve a ese perfil para verla.', 'info', 5500);
      return;
    }
    songList.push(songObj);
    saveLibraryCountHint(activeProfileId, songList.length);
    refreshLibraryCountHint(activeProfileId).catch(() => {});
    renderPlaylist();
    document.dispatchEvent(new CustomEvent('glasstrack:track-added', { detail: { song: songObj } }));
    if (songList.length === 1) loadSong(0, false);
  } catch (error) {
    console.error('Error guardando el archivo de audio:', error);
    const quotaError = error && (error.name === 'QuotaExceededError' || /quota|cuota|space|espacio/i.test(error.message || ''));
    showToast(
      quotaError
        ? 'No hay espacio suficiente para guardar esta canción. Libera almacenamiento y vuelve a intentarlo; la canción no se añadió.'
        : `No se pudo guardar la canción: ${(error && error.message) || 'error de almacenamiento'}. La canción no se añadió.`,
      'error', 5500
    );
  }
}

// Overlay de Arrastrar y Soltar. Inactivo = no participa en la capa de clics.
const dragdropOverlay = document.getElementById('dragdrop-overlay');
let dragCounter = 0;
let glasstrackFileDragActive = false;
function resetDragdropOverlay() {
  dragCounter = 0;
  glasstrackFileDragActive = false;
  if (dragdropOverlay) {
    dragdropOverlay.classList.remove('active');
    dragdropOverlay.style.pointerEvents = 'none';
    dragdropOverlay.setAttribute('aria-hidden', 'true');
  }
}
// Limpia cualquier estado visual dejado por una sesión anterior/drag interrumpido.
resetDragdropOverlay();
window.addEventListener('dragenter', e => {
  if (e.target && e.target.closest && e.target.closest('[data-external-track-drop]')) {
    e.preventDefault();
    return;
  }
  const types = e.dataTransfer && e.dataTransfer.types ? Array.from(e.dataTransfer.types) : [];
  if (!types.includes('Files')) return;
  const studioOpen = lyricsStudioEl && lyricsStudioEl.classList.contains('active');
  if (studioOpen) return;
  e.preventDefault();
  glasstrackFileDragActive = true;
  dragCounter++;
  if (dragdropOverlay) {
    dragdropOverlay.classList.add('active');
    dragdropOverlay.style.pointerEvents = 'none';
    dragdropOverlay.setAttribute('aria-hidden', 'false');
  }
});
window.addEventListener('dragover', e => {
  if (e.target && e.target.closest && e.target.closest('[data-external-track-drop]')) {
    e.preventDefault();
    return;
  }
  if (glasstrackFileDragActive && e.dataTransfer) e.preventDefault();
});
window.addEventListener('dragleave', e => {
  if (!glasstrackFileDragActive) return;
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0 && !e.relatedTarget) resetDragdropOverlay();
});
window.addEventListener('dragend', resetDragdropOverlay);
window.addEventListener('blur', resetDragdropOverlay);
document.addEventListener('visibilitychange', () => { if (document.hidden) resetDragdropOverlay(); });
window.addEventListener('drop', e => {
  const files = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files : null;
  if (glasstrackFileDragActive || (files && files.length)) e.preventDefault();
  resetDragdropOverlay();
  // Los drops dentro de las zonas del mezclador los procesa su propio manejador;
  // nunca deben pasar también a la biblioteca musical general.
  if (e.target && e.target.closest && e.target.closest('[data-external-track-drop]')) return;
  if (files && files.length > 0) handleFiles(files);
});
if (fileInput) fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

// ==========================================
// 6. MOTOR DE REPRODUCCIÓN
// ==========================================
// Cada selección invalida las cargas/fundidos anteriores. Evita que un evento
// loadedmetadata o una promesa play() atrasada reactive una canción vieja.
let mainPlaybackRequestToken = 0;
let mainCrossfadeTimer = null;
let mainPendingMetadataLoad = null;
let latestMainPlaybackUrl = '';

function invalidateMainPlaybackRequests(options = {}) {
  mainPlaybackRequestToken += 1;
  const hadMainCrossfade = mainCrossfadeTimer !== null;
  if (mainCrossfadeTimer !== null) { clearInterval(mainCrossfadeTimer); mainCrossfadeTimer = null; }
  if (mainPendingMetadataLoad) {
    const { audio, handler } = mainPendingMetadataLoad;
    try { audio.removeEventListener('loadedmetadata', handler); } catch (_) {}
    mainPendingMetadataLoad = null;
  }
  [audio1, audio2].forEach(audio => {
    if (!audio) return;
    if (audio._fadeInterval) { clearInterval(audio._fadeInterval); audio._fadeInterval = null; }
  });
  if (options.stabilizeCurrent && activeAudio) {
    const targetVol = Math.max(0, Math.min(1, volumeSlider ? parseFloat(volumeSlider.value) : 1));
    activeAudio.volume = targetVol;
    if (hadMainCrossfade) {
      const inactiveAudio = activeAudio === audio1 ? audio2 : audio1;
      try { inactiveAudio.pause(); } catch (_) {}
      inactiveAudio.volume = 0;
    }
  }
  return mainPlaybackRequestToken;
}

function sourceMatches(audio, url) {
  if (!audio || !url) return false;
  try { return new URL(audio.currentSrc || audio.src, document.baseURI).href === new URL(url, document.baseURI).href; }
  catch (_) { return (audio.currentSrc || audio.src) === url; }
}

// Devuelve únicamente índices reproducibles. Cuando hay una playlist activa, su orden
// es el orden de esa playlist, no el orden accidental de la biblioteca global.
function getPlayableTrackIndices() {
  if (activePlaybackPlaylist) {
    const entries = playlists && Array.isArray(playlists[activePlaybackPlaylist])
      ? playlists[activePlaybackPlaylist]
      : null;
    if (entries) {
      const indices = [];
      const seen = new Set();
      entries.forEach(storedSong => {
        const realSong = findSongInLibrary(storedSong);
        if (!realSong || realSong.isHidden) return;
        const realIndex = songList.indexOf(realSong);
        if (realIndex < 0 || seen.has(realIndex)) return;
        seen.add(realIndex);
        indices.push(realIndex);
      });
      return indices;
    }
    // La playlist activa fue eliminada o dejó de existir: la biblioteca vuelve a ser la cola.
    activePlaybackPlaylist = null;
    if (typeof syncLoopButtons === 'function') syncLoopButtons();
  }
  return songList.reduce((indices, song, index) => {
    if (song && !song.isHidden) indices.push(index);
    return indices;
  }, []);
}

function chooseAdjacentPlayableIndex(direction = 1, options = {}) {
  const { useShuffle = isShuffle, allowWrap = true } = options;
  const indices = getPlayableTrackIndices();
  if (!indices.length) return -1;

  if (useShuffle && indices.length > 1) {
    const candidates = indices.filter(index => index !== currentIndex);
    const pool = candidates.length ? candidates : indices;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const position = indices.indexOf(currentIndex);
  if (position < 0) return direction >= 0 ? indices[0] : indices[indices.length - 1];
  const targetPosition = position + (direction >= 0 ? 1 : -1);
  if (targetPosition >= 0 && targetPosition < indices.length) return indices[targetPosition];
  if (!allowWrap) return -1;
  return direction >= 0 ? indices[0] : indices[indices.length - 1];
}

function stopForNoPlayableTracks(notify = false) {
  try { invalidateMainPlaybackRequests(); } catch (_) {}
  [audio1, audio2].forEach(audio => {
    if (!audio) return;
    if (audio._fadeInterval) { clearInterval(audio._fadeInterval); audio._fadeInterval = null; }
    try { audio.pause(); } catch (_) {}
  });
  if (playerCard) playerCard.classList.remove('playing');
  if (playIcon) playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
  syncCinemaPlayControl(false);
  syncMiniPlayer();
  syncVehicleMode();
  syncMobileNowPlaying();
  if (notify && typeof showToast === 'function') showToast('No hay canciones visibles para reproducir en esta cola.', 'info');
}

function navigatePlayableTrack(direction = 1, options = {}) {
  const { shouldPlay = true, allowWrap = true, useShuffle = isShuffle, notifyIfEmpty = false } = options;
  const targetIndex = chooseAdjacentPlayableIndex(direction, { useShuffle, allowWrap });
  if (targetIndex < 0) {
    stopForNoPlayableTracks(notifyIfEmpty);
    return false;
  }
  return loadSong(targetIndex, shouldPlay) !== false;
}

function loadSong(index, shouldPlay = true) {
  if (index < 0 || index >= songList.length) return false;
  if (shouldPlay && songList[index] && songList[index].isHidden) {
    console.warn('Se ignoró la reproducción de una canción oculta:', songList[index].title);
    return false;
  }
  // Si Concluidor tomó los elementos de audio compartidos, invalídalo antes de
  // cargar una selección normal para que ningún fundido suyo vuelva a arrancar.
  if (typeof concludorAudioOwned !== 'undefined' && (concludorAudioOwned || concludorPlaying)) {
    stopConcludorPlayback({ resetPosition: false, render: false });
  }
  const playbackToken = invalidateMainPlaybackRequests();
  // Desactivar primero evita que una mezcla anterior siga sonando; después se cargan únicamente
  // las pistas que estén guardadas para la nueva canción y el perfil activo.
  if (externalMixerActive) deactivateExternalMix(true, { resumeOriginal: false });
  currentIndex = index;
  const song = songList[currentIndex];
  latestMainPlaybackUrl = song.url || '';
  prepareExternalMixForSongChange(song);

  // Si cambiaste de canción (ej. con las teclas multimedia) mientras el Estudio estaba
  // abierto, lo cerramos: si no, se queda mostrando/editando datos de la canción anterior.
  const lyricsStudioElCheck = document.getElementById('lyrics-studio');
  if (lyricsStudioElCheck && lyricsStudioElCheck.classList.contains('active')) {
    lyricsStudioElCheck.classList.remove('active');
    showToast('Se cerró el Estudio de Letras porque cambiaste de canción.', 'info');
  }

  if (title) title.textContent = song.title;
  if (artist) artist.textContent = song.artist;
  if (cover) cover.src = song.cover;
  if (playerBgFluid) playerBgFluid.style.backgroundImage = `url(${song.cover})`;
  if (lyricsBg) lyricsBg.style.backgroundImage = `url(${song.cover})`;

  if (cinemaCover) cinemaCover.src = song.cover;
  if (cinemaTitle) cinemaTitle.textContent = song.title;
  if (cinemaArtist) cinemaArtist.textContent = song.artist;
  if (cinemaBg) cinemaBg.style.backgroundImage = `url(${song.cover})`;

  applyLyricsCalibration(song);
  syncFavoriteButtons(song);
  displayLyrics(song.lyrics);
  syncKaraokeMetadata();
  if (typeof window.__glasstrackMobile3DSync === 'function') {
    window.__glasstrackMobile3DSync();
  }
  updateMediaSession(song);

  audio1.pause();
  audio2.pause();

  if (shouldPlay) {
    if (toggleCrossfade && toggleCrossfade.checked) {
      playSongWithCrossfade(song.url, 0, playbackToken);
    } else {
      activeAudio.src = song.url;
      activeAudio.currentTime = 0;
      playSong();
    }
  } else {
    activeAudio.src = song.url;
    activeAudio.currentTime = 0;
  }

  applyAudioEngineSettings();
  syncMiniPlayer(true);
  syncVehicleMode();
  syncMobileNowPlaying();
  renderPlaylist();
  if (window.glasstrackRhythm && typeof window.glasstrackRhythm.syncSong === 'function') {
    try { window.glasstrackRhythm.syncSong(); } catch (_) {}
  }
  return true;
}

function playSongWithCrossfade(newUrl, startAt = 0, requestToken) {
  if (requestToken === undefined) requestToken = invalidateMainPlaybackRequests();
  if (requestToken !== mainPlaybackRequestToken) return;
  latestMainPlaybackUrl = newUrl || latestMainPlaybackUrl;
  initAudioContext();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

  const currentAudio = activeAudio;
  const nextAudio = (activeAudio === audio1) ? audio2 : audio1;
  if (mainCrossfadeTimer !== null) { clearInterval(mainCrossfadeTimer); mainCrossfadeTimer = null; }
  if (nextAudio._fadeInterval) { clearInterval(nextAudio._fadeInterval); nextAudio._fadeInterval = null; }
  nextAudio.pause();
  nextAudio.src = newUrl;
  nextAudio.volume = startAt ? 0 : (toggleCrossfade && toggleCrossfade.checked ? 0 : (volumeSlider ? parseFloat(volumeSlider.value) : 1));

  if (startAt > 0) {
    const seekNext = () => {
      if (mainPendingMetadataLoad && mainPendingMetadataLoad.handler === seekNext) mainPendingMetadataLoad = null;
      if (requestToken !== mainPlaybackRequestToken || !sourceMatches(nextAudio, newUrl)) return;
      try { nextAudio.currentTime = startAt; } catch (_) {}
    };
    if (nextAudio.readyState >= 1) seekNext();
    else {
      mainPendingMetadataLoad = { audio: nextAudio, handler: seekNext };
      nextAudio.addEventListener('loadedmetadata', seekNext, { once: true });
    }
  } else {
    try { nextAudio.currentTime = 0; } catch (_) {}
  }
  // Publica el destino de esta solicitud antes de esperar play(): si el usuario
  // pulsa Play o cambia otra vez de pista durante la carga, nunca usará el audio viejo.
  activeAudio = nextAudio;

  const playPromise = nextAudio.play();
  if (playPromise !== undefined) {
    Promise.resolve(playPromise).then(() => {
      // No se debe permitir que una selección anterior reclame el audio activo.
      if (requestToken !== mainPlaybackRequestToken) {
        if (!sourceMatches(nextAudio, latestMainPlaybackUrl)) nextAudio.pause();
        return;
      }
      const targetVol = Math.max(0, Math.min(1, volumeSlider ? parseFloat(volumeSlider.value) : 1));
      if (toggleCrossfade && toggleCrossfade.checked) {
        const currentStartVolume = Math.max(0, Math.min(1, currentAudio ? currentAudio.volume : 0));
        const tickMs = 60;
        // Conserva la cadencia de fundido que ya tenía el reproductor (≈1.2 s al 100%).
        const steps = Math.max(1, Math.ceil(targetVol / 0.05));
        let stepCount = 0;
        mainCrossfadeTimer = setInterval(() => {
          if (requestToken !== mainPlaybackRequestToken) {
            clearInterval(mainCrossfadeTimer); mainCrossfadeTimer = null; return;
          }
          stepCount += 1;
          const progress = Math.min(1, stepCount / steps);
          if (currentAudio) {
            currentAudio.volume = currentStartVolume * (1 - progress);
            if (progress >= 1) { currentAudio.volume = 0; currentAudio.pause(); }
          }
          nextAudio.volume = targetVol * progress;
          if (progress >= 1) {
            nextAudio.volume = targetVol;
            clearInterval(mainCrossfadeTimer); mainCrossfadeTimer = null;
          }
        }, tickMs);
      } else nextAudio.volume = targetVol;

      activeAudio = nextAudio;
      if (playerCard) playerCard.classList.add('playing');
      if (playIcon) playIcon.innerHTML = '<path d="M5 4h6v16H5zM13 4h6v16h-6z"/>';
      syncCinemaPlayControl(true);
      syncMiniPlayer();
      syncVehicleMode();
      syncMobileNowPlaying();
    }).catch(err => {
      if (requestToken === mainPlaybackRequestToken) console.error('Error en crossfade:', err);
    });
  }
}

function playSong() {
  if (songList[currentIndex] && songList[currentIndex].isHidden) {
    const replacement = chooseAdjacentPlayableIndex(1, { useShuffle: isShuffle, allowWrap: true });
    if (replacement >= 0) loadSong(replacement, true);
    else stopForNoPlayableTracks(true);
    return;
  }
  if (externalMixerActive) {
    initAudioContext();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    if (!activeAudio) return;
    const startAt = Number(activeAudio.currentTime) || 0;
    const masterPlay = activeAudio.paused ? activeAudio.play() : Promise.resolve();
    Promise.resolve(masterPlay).then(() => startExternalTracksAt(startAt)).catch(error => {
      console.warn('No se pudo iniciar el reloj de la mezcla externa:', error);
      updateExternalMixerStatus('No se pudo iniciar la reproducción. Pulsa Reproducir de nuevo.', false, true);
    });
    return;
  }
  if (songList.length === 0) return;
  initAudioContext();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();

  const requestToken = mainPlaybackRequestToken;
  const requestedAudio = activeAudio;
  const requestedUrl = requestedAudio ? (requestedAudio.currentSrc || requestedAudio.src) : '';
  const targetVol = volumeSlider ? parseFloat(volumeSlider.value) : 1;
  const useFade = !toggleFadePlayback || toggleFadePlayback.checked;
  // En mezcla externa, el audio de la biblioteca actúa solo como reloj silenciado.
  // Conservamos su volumen normal para que desactivar la mezcla no deje el audio casi mudo.
  activeAudio.volume = externalMixerActive ? targetVol : (useFade ? 0 : targetVol);
  const playPromise = activeAudio.play();

  if (playPromise !== undefined) {
    playPromise.then(() => {
      if (requestToken !== mainPlaybackRequestToken || requestedAudio !== activeAudio ||
          (requestedUrl && !sourceMatches(requestedAudio, requestedUrl))) return;
      if (playerCard) playerCard.classList.add('playing');
      if (playIcon) playIcon.innerHTML = '<path d="M5 4h6v16H5zM13 4h6v16h-6z"/>';
      syncCinemaPlayControl(true);
      syncMiniPlayer();
      syncVehicleMode();
      syncMobileNowPlaying();
      if (useFade && !externalMixerActive) fadeVolumeTo(activeAudio, targetVol, 300);
    }).catch(err => console.error("Error en reproducción:", err));
  }
}

function fadeVolumeTo(audioEl, target, ms) {
  clearInterval(audioEl._fadeInterval);
  const steps = Math.max(1, ms / 40);
  const step = (target - audioEl.volume) / steps;
  audioEl._fadeInterval = setInterval(() => {
    const next = audioEl.volume + step;
    if ((step > 0 && next >= target) || (step < 0 && next <= target)) {
      audioEl.volume = target;
      clearInterval(audioEl._fadeInterval);
    } else {
      audioEl.volume = next;
    }
  }, 40);
}

function pauseSong() {
  if (externalMixerActive) {
    pauseExternalTracks();
    if (activeAudio && !activeAudio.paused) activeAudio.pause();
    updateExternalTransportUi(false);
    return;
  }
  if (playerCard) playerCard.classList.remove('playing');
  if (playIcon) playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
  syncCinemaPlayControl(false);
  const useFade = !toggleFadePlayback || toggleFadePlayback.checked;
  if (externalMixerActive) {
    // El reloj de la canción debe pausarse sin desvanecer su volumen guardado:
    // este elemento está silenciado mientras suenan las pistas externas.
    clearInterval(activeAudio._fadeInterval);
    activeAudio.pause();
  } else if (useFade) {
    const a = activeAudio;
    clearInterval(a._fadeInterval);
    const startVol = a.volume;
    const steps = 6;
    let i = 0;
    a._fadeInterval = setInterval(() => {
      i++;
      a.volume = Math.max(0, startVol * (1 - i / steps));
      if (i >= steps) { clearInterval(a._fadeInterval); a.pause(); }
    }, 40);
  } else {
    activeAudio.pause();
  }
  syncMiniPlayer();
  syncVehicleMode();
  syncMobileNowPlaying();
}

if (playBtn) playBtn.addEventListener('click', () => { playSFX('click'); playerCard.classList.contains('playing') ? pauseSong() : playSong(); });
if (nextBtn) nextBtn.addEventListener('click', () => {
  playSFX('click');
  navigatePlayableTrack(1, { shouldPlay: true, allowWrap: true, useShuffle: isShuffle, notifyIfEmpty: true });
});
if (prevBtn) prevBtn.addEventListener('click', () => {
  playSFX('click');
  navigatePlayableTrack(-1, { shouldPlay: true, allowWrap: true, useShuffle: false, notifyIfEmpty: true });
});

function setShuffleEnabled(enabled, persist = true) {
  isShuffle = !!enabled;
  [shuffleBtn, cinemaShuffleBtn].forEach(button => {
    if (!button) return;
    button.classList.toggle('active', isShuffle);
    button.setAttribute('aria-pressed', String(isShuffle));
    button.title = isShuffle ? 'Aleatorio activado' : 'Aleatorio desactivado';
    button.setAttribute('aria-label', button.title);
  });
  if (persist) {
    try { localStorage.setItem('glasstrack_shuffle', isShuffle ? 'true' : 'false'); } catch (_) {}
  }
}

function syncLoopButtons() {
  const labels = ['Repetición desactivada', activePlaybackPlaylist ? 'Repetir playlist' : 'Repetir toda la lista', 'Repetir una canción'];
  [loopBtn, cinemaLoopBtn].forEach(button => {
    if (!button) return;
    const active = loopMode !== 0;
    button.classList.toggle('active', active);
    button.classList.toggle('repeat-one', loopMode === 2);
    button.setAttribute('aria-pressed', String(active));
    button.title = labels[loopMode];
    button.setAttribute('aria-label', labels[loopMode]);
    button.dataset.repeatMode = String(loopMode);
  });
  isLoop = loopMode === 2;
}

function advanceLoopMode() {
  loopMode = (loopMode + 1) % 3;
  syncLoopButtons();
}

if (shuffleBtn) shuffleBtn.addEventListener('click', () => { playSFX('click'); setShuffleEnabled(!isShuffle); });
if (cinemaShuffleBtn) cinemaShuffleBtn.addEventListener('click', () => { playSFX('click'); setShuffleEnabled(!isShuffle); });
if (loopBtn) loopBtn.addEventListener('click', () => { playSFX('click'); advanceLoopMode(); });
if (cinemaLoopBtn) cinemaLoopBtn.addEventListener('click', () => { playSFX('click'); advanceLoopMode(); });
setShuffleEnabled(isShuffle, false);
syncLoopButtons();

[audio1, audio2].forEach(a => {
  a.addEventListener('ended', () => {
    if (externalMixerActive) {
      handleExternalTrackEndMismatch();
      return;
    }
    // Un elemento antiguo puede emitir ended después de cambiar de canción; nunca
    // debe avanzar la cola si ya no es el audio activo.
    if (a !== activeAudio) return;
    const endedSong = songList[currentIndex];
    if (loopMode === 2 && endedSong && !endedSong.isHidden) {
      a.currentTime = 0;
      const restartPromise = a.play();
      if (restartPromise && typeof restartPromise.catch === 'function') restartPromise.catch(() => {});
      return;
    } else if (concludorPlaying) {
      // Conserva la cola independiente de Concluidor; no entra en la navegación normal.
      advanceConcludorChain();
      return;
    }

    const playableIndices = getPlayableTrackIndices();
    const currentPosition = playableIndices.indexOf(currentIndex);

    // Una pista que se ocultó durante la reproducción no puede repetirse ni autoplay.
    if (!endedSong || endedSong.isHidden || !playableIndices.includes(currentIndex)) {
      navigatePlayableTrack(1, { shouldPlay: true, allowWrap: true, useShuffle: isShuffle, notifyIfEmpty: false });
      return;
    }

    if (loopMode === 0) {
      // Sin repetir lista, se detiene al llegar al límite de la cola activa; si aleatorio
      // está habilitado, solo continúa cuando exista otra pista visible distinta.
      const canContinue = isShuffle
        ? playableIndices.some(index => index !== currentIndex)
        : (currentPosition < 0 || currentPosition < playableIndices.length - 1);
      if (!canContinue) {
        pauseSong();
        return;
      }
      navigatePlayableTrack(1, { shouldPlay: true, allowWrap: false, useShuffle: isShuffle, notifyIfEmpty: false });
      return;
    }

    // Repetir lista: la cola elegida vuelve a su primera canción; en shuffle elige otra
    // pista de esa misma cola. Nunca salta a la biblioteca completa desde una playlist.
    navigatePlayableTrack(1, { shouldPlay: true, allowWrap: true, useShuffle: isShuffle, notifyIfEmpty: false });
  });
});

function syncFavoriteButtons(song = songList[currentIndex]) {
  const isFav = !!(song && song.isFav);
  [btnFav, cinemaFavBtn].forEach(button => {
    if (!button) return;
    button.classList.toggle('active', isFav);
    button.setAttribute('aria-pressed', String(isFav));
    button.title = isFav ? 'Quitar de Me gusta' : 'Me gusta';
    button.setAttribute('aria-label', button.title);
  });
}

function toggleCurrentFavorite() {
  const song = songList[currentIndex];
  if (!song) return;
  song.isFav = !song.isFav;
  syncFavoriteButtons(song);
  updateSongInDB(song);
  renderPlaylist();
  syncMiniPlayer();
}

if (btnFav) {
  btnFav.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    playSFX('click');
    if (!songList.length) return;
    toggleCurrentFavorite();
  });
}
if (cinemaFavBtn) {
  cinemaFavBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    playSFX('click');
    if (!songList.length) return;
    toggleCurrentFavorite();
  });
}

// ==========================================
// 7. MODO ENFOQUE (DRAGGABLE) Y VENTANAS
// ==========================================
let isDragging = false;
let dragStartX, dragStartY, cardStartX, cardStartY;

if (btnFocusMode) {
  btnFocusMode.addEventListener('click', (event) => {
    event.preventDefault();

    try {
      playSFX('open');
    } catch (_) {}

    const isFocus = !document.body.classList.contains('focus-mode');
    document.body.classList.toggle('focus-mode', isFocus);
    btnFocusMode.classList.toggle('active', isFocus);

    if (!playerCard) return;

    if (isFocus) {
      playerCard.style.position = 'fixed';
      playerCard.style.top = '50%';
      playerCard.style.left = '50%';
      playerCard.style.transform = 'translate3d(-50%, -50%, 0)';
    } else {
      playerCard.style.removeProperty('position');
      playerCard.style.removeProperty('left');
      playerCard.style.removeProperty('top');
      playerCard.style.removeProperty('transform');
    }
  });
}

if (playerCard) {
  playerCard.addEventListener('mousedown', (e) => {
    if (!document.body.classList.contains('focus-mode')) return;
    if (document.body.classList.contains('mobile-player-expanded') || document.body.classList.contains('mobile-layout') || document.body.classList.contains('mobile-mode')) return;
    if (e.target.closest('button') || e.target.closest('input')) return;

    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    const rect = playerCard.getBoundingClientRect();
    cardStartX = rect.left;
    cardStartY = rect.top;

    playerCard.style.transform = 'none';
    playerCard.style.left = `${cardStartX}px`;
    playerCard.style.top = `${cardStartY}px`;
  });
}

window.addEventListener('mousemove', (e) => {
  if (!isDragging || !playerCard) return;
  playerCard.style.left = `${cardStartX + (e.clientX - dragStartX)}px`;
  playerCard.style.top = `${cardStartY + (e.clientY - dragStartY)}px`;
});
window.addEventListener('mouseup', () => { isDragging = false; });

if (btnFullscreen) {
  btnFullscreen.addEventListener('click', () => {
    playSFX('click');
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(err => console.error(err));
    else if (document.exitFullscreen) document.exitFullscreen();
  });
}

// El mini reproductor abre una ventana nueva (window.open), algo que en Chrome de celular
// casi nunca funciona bien (se bloquea o abre como pestaña rara). En celular avisamos en vez de fallar solo.
const isMobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth <= 480;
document.body.classList.toggle('is-mobile-device', isMobileDevice);

if (btnMiniPlayer) {
  btnMiniPlayer.addEventListener('click', () => {
    playSFX('open');
    if (isMobileDevice) {
      showToast('El Mini Reproductor es una función de escritorio (abre una ventana aparte) y no está disponible en el navegador de celular. Usa el reproductor principal.', 'error', 5000);
      return;
    }
    if (miniWin && !miniWin.closed) { miniWin.focus(); return; }
    miniWin = window.open("", "MiniPlayer", "width=300,height=430,resizable=yes");
    if (!miniWin) return;
    miniWin.document.title = "Mini Reproductor";
    const showBgFluid = miniPlayerStyle.bg === 'acrylic';

    miniWin.document.body.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        :root { --mp-bg-color: 18,19,28; --mp-opacity: ${miniPlayerStyle.bg === 'transparent' ? 0 : miniPlayerStyle.opacity}; --mp-scale: ${miniPlayerStyle.scale}; --mp-blur: ${showBgFluid ? '20px' : '0px'}; }
        html { zoom: var(--mp-scale, 1); }
        body {
          background: rgba(var(--mp-bg-color), var(--mp-opacity));
          backdrop-filter: blur(var(--mp-blur));
          -webkit-backdrop-filter: blur(var(--mp-blur));
          color: #fff; font-family: 'Segoe UI', sans-serif; margin: 0; padding: 18px; min-height: 100vh;
          position: relative; overflow: hidden;
        }
        #mini-bg-fluid {
          position: absolute; top: -50%; left: -50%; width: 200%; height: 200%;
          background-size: cover; background-position: center;
          filter: blur(40px) brightness(0.4); z-index: -1;
          opacity: ${showBgFluid ? 1 : 0};
        }
        .mp-topbar { display: flex; gap: 16px; margin-bottom: 14px; }
        .mp-topbar button { background: none; border: none; color: #8a99ad; font-size: 0.8rem; font-weight: 600; cursor: pointer; padding: 0; }
        .mp-topbar button:hover { color: #fff; }
        .mp-cover-wrap { display: flex; justify-content: center; margin-bottom: 14px; }
        #mini-cover { width: 140px; height: 140px; border-radius: 50%; object-fit: cover; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
        .mp-info { text-align: center; margin-bottom: 14px; }
        #mini-title { margin: 0 0 2px 0; font-size: 1rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #mini-artist { margin: 0; font-size: 0.8rem; color: #8a99ad; }
        .mp-progress-container { background: rgba(255,255,255,0.1); border-radius: 4px; height: 4px; width: 100%; cursor: pointer; }
        .mp-progress-bar { background: #e8a33d; border-radius: 4px; height: 100%; width: 0%; }
        .mp-times { display: flex; justify-content: space-between; font-size: 0.7rem; color: #8a99ad; margin: 6px 0 16px 0; }
        .mp-controls { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
        .mp-controls button { background: none; border: none; color: #d5dae2; cursor: pointer; padding: 4px; display: flex; }
        .mp-controls button:hover { color: #fff; }
        .mp-controls button.mp-active { color: #e8a33d; }
        #mini-play { background: #e8a33d; color: #12131c; border-radius: 50%; width: 40px; height: 40px; align-items: center; justify-content: center; }
        .mp-volume { display: flex; align-items: center; gap: 8px; color: #8a99ad; }
        .mp-volume input { flex: 1; accent-color: #e8a33d; }
      </style>
      <div id="mini-bg-fluid"></div>
      <div class="mp-topbar">
        <button onclick="window.opener.document.getElementById('btn-eq-toggle') && window.opener.document.getElementById('btn-eq-toggle').click()">EQ</button>
        <button onclick="window.opener.document.getElementById('btn-lyrics-toggle') && window.opener.document.getElementById('btn-lyrics-toggle').click()">Letras</button>
      </div>
      <div class="mp-cover-wrap"><img id="mini-cover" src="" alt="Portada"></div>
      <div class="mp-info">
        <h4 id="mini-title">-</h4>
        <p id="mini-artist">-</p>
      </div>
      <div class="mp-progress-container" id="mini-progress-container">
        <div class="mp-progress-bar" id="mini-progress"></div>
      </div>
      <div class="mp-times"><span id="mini-current-time">0:00</span><span id="mini-duration">0:00</span></div>
      <div class="mp-controls">
        <button id="mini-shuffle" title="Aleatorio"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg></button>
        <button id="mini-prev" title="Anterior"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg></button>
        <button id="mini-play" title="Reproducir / Pausa"><svg id="mini-play-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
        <button id="mini-next" title="Siguiente"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg></button>
        <button id="mini-loop" title="Repetir"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></button>
        <button id="mini-fav" title="Me gusta"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l8.72-8.72 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></button>
      </div>
      <div class="mp-volume">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/></svg>
        <input type="range" id="mini-volume" min="0" max="1" step="0.01" value="1">
      </div>
    `;

    const mw = miniWin;
    const passthrough = (id) => { const el = window.document.getElementById(id); if (el) el.click(); };
    const shuffleBtn = mw.document.getElementById('mini-shuffle');
    const prevMiniBtn = mw.document.getElementById('mini-prev');
    const playMiniBtn = mw.document.getElementById('mini-play');
    const nextMiniBtn = mw.document.getElementById('mini-next');
    const loopMiniBtn = mw.document.getElementById('mini-loop');
    const favMiniBtn = mw.document.getElementById('mini-fav');
    const volMiniInput = mw.document.getElementById('mini-volume');
    const progressMiniContainer = mw.document.getElementById('mini-progress-container');

    if (shuffleBtn) shuffleBtn.addEventListener('click', () => passthrough('shuffle'));
    if (prevMiniBtn) prevMiniBtn.addEventListener('click', () => passthrough('prev'));
    if (playMiniBtn) playMiniBtn.addEventListener('click', () => passthrough('play'));
    if (nextMiniBtn) nextMiniBtn.addEventListener('click', () => passthrough('next'));
    if (loopMiniBtn) loopMiniBtn.addEventListener('click', () => passthrough('loop'));
    if (favMiniBtn) favMiniBtn.addEventListener('click', () => passthrough('btn-fav'));
    if (volMiniInput) {
      volMiniInput.value = volumeSlider ? volumeSlider.value : 1;
      volMiniInput.addEventListener('input', (e) => {
        if (volumeSlider) {
          volumeSlider.value = e.target.value;
          volumeSlider.dispatchEvent(new Event('input'));
        }
      });
    }
    if (progressMiniContainer) {
      progressMiniContainer.addEventListener('click', (e) => {
        if (activeAudio && activeAudio.duration) {
          activeAudio.currentTime = (e.offsetX / progressMiniContainer.clientWidth) * activeAudio.duration;
        }
      });
    }

    mw.addEventListener('beforeunload', () => { miniWin = null; });
    applyMiniPlayerStyle();
    syncMiniPlayer(true);
  });
}

// ==========================================
// PERSONALIZACIÓN VISUAL DEL MINI REPRODUCTOR
// ==========================================
let miniPlayerStyle = { bg: 'acrylic', opacity: 0.85, scale: 1 };

function applyMiniPlayerStyle() {
  if (!miniWin || miniWin.closed) return;
  try {
    const root = miniWin.document.documentElement.style;
    if (miniPlayerStyle.bg === 'black') root.setProperty('--mp-bg-color', '0,0,0');
    else if (miniPlayerStyle.bg === 'white') root.setProperty('--mp-bg-color', '255,255,255');
    else if (miniPlayerStyle.bg === 'transparent') root.setProperty('--mp-bg-color', '18,19,28');
    else root.setProperty('--mp-bg-color', '18,19,28'); // acrílico/difuminado

    root.setProperty('--mp-opacity', miniPlayerStyle.bg === 'transparent' ? 0 : miniPlayerStyle.opacity);
    root.setProperty('--mp-blur', miniPlayerStyle.bg === 'acrylic' ? '20px' : '0px');
    root.setProperty('--mp-scale', miniPlayerStyle.scale);
    const miniBgFluid = miniWin.document.getElementById('mini-bg-fluid');
    if (miniBgFluid) miniBgFluid.style.opacity = miniPlayerStyle.bg === 'acrylic' ? '1' : '0';
  } catch (err) {}
}

document.querySelectorAll('.mp-bg-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    playSFX('click');
    document.querySelectorAll('.mp-bg-btn').forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    miniPlayerStyle.bg = e.currentTarget.dataset.mpbg;
    applyMiniPlayerStyle();
  });
});
const inputMpOpacity = document.getElementById('input-mp-opacity');
const inputMpScale = document.getElementById('input-mp-scale');
if (inputMpOpacity) inputMpOpacity.addEventListener('input', (e) => { miniPlayerStyle.opacity = parseFloat(e.target.value); applyMiniPlayerStyle(); });
if (inputMpScale) inputMpScale.addEventListener('input', (e) => { miniPlayerStyle.scale = parseFloat(e.target.value); applyMiniPlayerStyle(); });

// Mantiene el mini reproductor sincronizado en vivo con el reproductor principal
function syncMiniPlayer(full = false) {
  if (!miniWin || miniWin.closed) return;
  try {
    const doc = miniWin.document;
    if (full) {
      const miniCover = doc.getElementById('mini-cover');
      const miniTitle = doc.getElementById('mini-title');
      const miniArtist = doc.getElementById('mini-artist');
      const miniBgFluid = doc.getElementById('mini-bg-fluid');
      if (miniCover && cover) miniCover.src = cover.src;
      if (miniTitle && title) miniTitle.textContent = title.textContent;
      if (miniArtist && artist) miniArtist.textContent = artist.textContent;
      if (miniBgFluid && cover) miniBgFluid.style.backgroundImage = `url(${cover.src})`;
    }
    const miniPlayIcon = doc.getElementById('mini-play-icon');
    if (miniPlayIcon && playIcon) miniPlayIcon.innerHTML = playIcon.innerHTML;

    if (activeAudio && !isNaN(activeAudio.duration) && activeAudio.duration > 0) {
      const pct = (activeAudio.currentTime / activeAudio.duration) * 100;
      const miniProgress = doc.getElementById('mini-progress');
      const miniCurrentTime = doc.getElementById('mini-current-time');
      const miniDuration = doc.getElementById('mini-duration');
            if (miniProgress) miniProgress.style.width = pct + '%';
      if (miniCurrentTime) miniCurrentTime.textContent = formatTime(activeAudio.currentTime);
      if (miniDuration) miniDuration.textContent = formatTime(activeAudio.duration);
    }
  } catch (err) {
    // La ventanita se pudo haber cerrado justo en este instante; no pasa nada.
  }
}

if (btnEqToggle) btnEqToggle.addEventListener('click', () => { playSFX('click'); eqPanel.classList.toggle('hidden'); });
if (btnCloseEq) btnCloseEq.addEventListener('click', () => { playSFX('close'); eqPanel.classList.add('hidden'); });
if (btnVmToggle) btnVmToggle.addEventListener('click', () => { playSFX('click'); initAudioContext(); if (vmPanel) vmPanel.classList.toggle('hidden'); });
const btnCloseVm = document.getElementById('btn-close-vm');
if (btnCloseVm) btnCloseVm.addEventListener('click', () => { playSFX('close'); if (vmPanel) vmPanel.classList.add('hidden'); });

// ==========================================
// 8. RENDERIZADO Y NAVEGACIÓN DE BIBLIOTECA
// ==========================================
function syncLibrarySectionIndicators() {
  const hiddenOpen = !!(modalHidden && modalHidden.classList.contains('active'));
  document.querySelectorAll('.nav-btn[data-tab]').forEach(button => {
    const selected = !hiddenOpen && button.dataset.tab === currentTab;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  if (btnOpenHidden) {
    btnOpenHidden.classList.toggle('active', hiddenOpen);
    btnOpenHidden.setAttribute('aria-pressed', String(hiddenOpen));
  }
}

function getVisiblePlaylistEntries(playlistName) {
  const entries = playlists && Array.isArray(playlists[playlistName]) ? playlists[playlistName] : [];
  return entries.map((storedSong, index) => ({ storedSong, index, realSong: findSongInLibrary(storedSong) }))
    .filter(entry => !entry.realSong || !entry.realSong.isHidden);
}

document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    playSFX('click');
    currentTab = e.currentTarget.dataset.tab;
    currentPlaylistView = null;
    if (btnBackPlaylist) btnBackPlaylist.classList.add('hidden');
    if (playlistViewHeader) playlistViewHeader.classList.add('hidden');
    if (btnCreatePlaylist) btnCreatePlaylist.classList.toggle('hidden', currentTab !== 'playlists');
    syncLibrarySectionIndicators();
    renderPlaylist();
  });
});
syncLibrarySectionIndicators();

if (btnBackPlaylist) {
  btnBackPlaylist.addEventListener('click', () => {
    playSFX('close');
    currentPlaylistView = null;
    btnBackPlaylist.classList.add('hidden');
    if (playlistViewHeader) playlistViewHeader.classList.add('hidden');
    renderPlaylist();
  });
}

// El botón "Reproducir" de una playlist no tenía NINGÚN listener conectado.
// Ahora reproduce la primera canción disponible de esa playlist específica (nunca una ajena).
if (btnPlayPlaylist) {
  btnPlayPlaylist.addEventListener('click', () => {
    playSFX('click');
    if (!currentPlaylistView) return;
    activePlaybackPlaylist = currentPlaylistView;
    syncLoopButtons();
    const entries = getVisiblePlaylistEntries(currentPlaylistView);
    for (const entry of entries) {
      const realIndex = entry.realSong ? songList.indexOf(entry.realSong) : -1;
      if (realIndex > -1 && !entry.realSong.isHidden) { loadSong(realIndex); return; }
    }
    showToast('Esta playlist no tiene canciones visibles disponibles para reproducir.', 'error');
  });
}

function savePlaylistsToStorage() {
  writeProfileValue('playlistsDB', JSON.stringify(playlists));
}

// Las playlists guardan una "foto" de cada canción; esta función busca la canción
// REAL y actual en tu biblioteca (por id, o por título/artista si no tiene id todavía).
function findSongInLibrary(storedSong) {
  if (!storedSong) return null;
  if (storedSong.id !== undefined) {
    const byId = songList.find(s => s.id === storedSong.id);
    if (byId) return byId;
  }
  return songList.find(s => s.title === storedSong.title && s.artist === storedSong.artist) || null;
}

function renderPlaylist() {
  if (!playlistEl) return;
  playlistEl.innerHTML = '';

  if (currentTab === 'playlists' && !currentPlaylistView) {
    const pKeys = Object.keys(playlists);
    if (pKeys.length === 0) {
      playlistEl.innerHTML = '<li class="empty-msg">No hay playlists creadas</li>';
      return;
    }
    pKeys.forEach(pName => {
      const visibleEntries = getVisiblePlaylistEntries(pName);
      const coverSong = visibleEntries.length ? (visibleEntries[0].realSong || visibleEntries[0].storedSong) : null;
      const coverUrl = coverSong && coverSong.cover ? coverSong.cover : "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=500&q=80";

      const li = document.createElement('li');
      li.className = 'playlist-item';
      li.innerHTML = `
        <img src="${coverUrl}" class="item-thumb">
        <div class="item-details" style="padding: 10px;">
          <div class="item-title">${pName}</div>
          <div class="item-artist">${visibleEntries.length} canciones disponibles</div>
        </div>
      `;
      li.addEventListener('click', () => {
        playSFX('open');
        currentPlaylistView = pName;
        activePlaybackPlaylist = pName;
        syncLoopButtons();
        if (btnBackPlaylist) btnBackPlaylist.classList.remove('hidden');
        renderPlaylist();
      });
      playlistEl.appendChild(li);
    });
    return;
  }

  if (currentPlaylistView) {
    const pSongs = playlists[currentPlaylistView] || [];
    const visibleEntries = getVisiblePlaylistEntries(currentPlaylistView);
    if (playlistViewTitle) playlistViewTitle.textContent = currentPlaylistView;
    const coverSong = visibleEntries.length ? (visibleEntries[0].realSong || visibleEntries[0].storedSong) : null;
    if (playlistViewCover) playlistViewCover.src = coverSong && coverSong.cover ? coverSong.cover : "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=500&q=80";
    if (playlistViewHeader) playlistViewHeader.classList.remove('hidden');

    if (pSongs.length === 0) {
      playlistEl.innerHTML = '<li class="empty-msg">Playlist vacía. Agrega canciones usando el menú de 3 puntos.</li>';
      return;
    }
    if (visibleEntries.length === 0) {
      playlistEl.innerHTML = '<li class="empty-msg">Esta playlist solo contiene canciones ocultas. Muéstralas en Ocultos para poder reproducirlas.</li>';
      return;
    }

    visibleEntries.forEach(({ storedSong, index: pIndex, realSong }) => {
      const realIndex = realSong ? songList.indexOf(realSong) : -1;
      const song = realSong || storedSong; // usa los datos actuales (título/portada editados), si existe
      const li = document.createElement('li');
      li.className = `playlist-item ${realIndex === currentIndex ? 'active' : ''} ${!realSong ? 'song-unavailable' : ''}`;
      li.innerHTML = `
        <img src="${song.cover}" class="item-thumb">
        <div class="item-details">
          <div class="item-title">${song.title}${!realSong ? ' (no disponible)' : ''}</div>
          <div class="item-artist">${song.artist}</div>
        </div>
        <button class="item-remove-btn" title="Quitar de la Playlist">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      `;

      li.querySelector('.item-remove-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        playSFX('click');
        playlists[currentPlaylistView].splice(pIndex, 1);
        savePlaylistsToStorage();
        renderPlaylist();
      });

      li.addEventListener('click', () => {
        if (realSong && realSong.isHidden) return;
        if (song.sourceType === 'youtube' && song.youtubeId) { openYoutubePlayerModal(song); return; }
        if (realIndex > -1) {
          activePlaybackPlaylist = currentPlaylistView;
          syncLoopButtons();
          loadSong(realIndex);
        }
      });
      playlistEl.appendChild(li);
    });
    return;
  }

  let filtered = songList.filter(s => !s.isHidden);
  if (currentTab === 'favorites') filtered = filtered.filter(s => s.isFav);

  if (filtered.length === 0) {
    playlistEl.innerHTML = '<li class="empty-msg">Sin canciones disponibles</li>';
    return;
  }

  filtered.forEach((song) => {
    const realIndex = songList.indexOf(song);
    const li = document.createElement('li');
    li.className = `playlist-item ${realIndex === currentIndex ? 'active' : ''}`;
    li.innerHTML = `
      <div class="item-bg-cover" style="background-image: url('${song.cover}')"></div>
      <img src="${song.cover}" class="item-thumb">
      <div class="item-details">
        <div class="item-title">${song.title}</div>
        <div class="item-artist">${song.artist}</div>
      </div>
      <button class="item-menu-btn" title="Opciones">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
      </button>
    `;

    li.querySelector('.item-menu-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      playSFX('open');
      openSongMenu(song);
    });

    li.addEventListener('click', () => {
      if (song.sourceType === 'youtube' && song.youtubeId) { openYoutubePlayerModal(song); return; }
      activePlaybackPlaylist = null;
      syncLoopButtons();
      loadSong(realIndex);
    });
    playlistEl.appendChild(li);
  });
}

// ==========================================
// 9. MODALES Y EDICIÓN
// ==========================================
function openModal(modal) {
  if (!modal) return;
  modal.classList.add('active');
  // El Modo Cine oculta el resto de la aplicación. Si una acción abre un modal
  // reutilizado (Biblioteca, metadatos, playlist), habilitamos temporalmente la capa.
  if (document.body.classList.contains('cinema-exclusive-active')) {
    document.body.classList.add('cinema-modal-open');
  }
  if (modal === modalHidden) syncLibrarySectionIndicators();
}
function closeModal(modal) {
  if (!modal) return;
  modal.classList.remove('active');
  if (document.body.classList.contains('cinema-modal-open') && !document.querySelector('.modal-overlay.active')) {
    document.body.classList.remove('cinema-modal-open');
  }
  if (modal === modalHidden) syncLibrarySectionIndicators();
}

if (btnRenamePlaylist) {
  btnRenamePlaylist.addEventListener('click', () => {
    if (!currentPlaylistView) return;
    playSFX('open');
    editingPlaylistName = currentPlaylistView;
    if (modalPlaylistTitle) modalPlaylistTitle.textContent = "Renombrar Playlist";
    if (inputPlaylistName) inputPlaylistName.value = currentPlaylistView;
    openModal(modalCreatePlaylist);
  });
}

if (btnDeletePlaylist) {
  btnDeletePlaylist.addEventListener('click', () => {
    if (!currentPlaylistView) return;
    playSFX('click');
    if (confirm(`¿Seguro que deseas eliminar la playlist "${currentPlaylistView}"?`)) {
      if (activePlaybackPlaylist === currentPlaylistView) {
        activePlaybackPlaylist = null;
        syncLoopButtons();
      }
      delete playlists[currentPlaylistView];
      savePlaylistsToStorage();
      currentPlaylistView = null;
      if (btnBackPlaylist) btnBackPlaylist.classList.add('hidden');
      if (playlistViewHeader) playlistViewHeader.classList.add('hidden');
      renderPlaylist();
    }
  });
}

if (btnCreatePlaylist) {
  btnCreatePlaylist.addEventListener('click', () => {
    playSFX('open');
    editingPlaylistName = null;
    if (modalPlaylistTitle) modalPlaylistTitle.textContent = "Nueva Playlist";
    if (inputPlaylistName) inputPlaylistName.value = '';
    openModal(modalCreatePlaylist);
  });
}

if (btnCloseCreatePlaylist) btnCloseCreatePlaylist.addEventListener('click', () => { playSFX('close'); closeModal(modalCreatePlaylist); });

if (btnSavePlaylist) {
  btnSavePlaylist.addEventListener('click', () => {
    playSFX('click');
    const name = inputPlaylistName.value.trim();
    if (!name) return;

    if (editingPlaylistName) {
      if (editingPlaylistName !== name) {
        playlists[name] = playlists[editingPlaylistName];
        delete playlists[editingPlaylistName];
        if (activePlaybackPlaylist === editingPlaylistName) activePlaybackPlaylist = name;
        currentPlaylistView = name;
      }
    } else {
      if (!playlists[name]) playlists[name] = [];
    }

    savePlaylistsToStorage();
    closeModal(modalCreatePlaylist);
    renderPlaylist();
  });
}

if (btnMainMenu) btnMainMenu.addEventListener('click', () => {
  playSFX('open');
  resetSettingsSlide();
  if (modalSettings) {
    modalSettings.style.display = 'flex';
    modalSettings.classList.add('active');
    modalSettings.setAttribute('aria-hidden', 'false');
  }
});
if (btnCloseSettings) btnCloseSettings.addEventListener('click', () => { playSFX('close'); closeModalSettings(); });

function closeModalSettings() {
  if (modalSettings) {
    modalSettings.classList.remove('active');
    modalSettings.style.display = 'none';
    modalSettings.setAttribute('aria-hidden', 'true');
  }
  const secondaryButton = document.getElementById('btn-mobile-secondary-menu');
  if (secondaryButton) secondaryButton.setAttribute('aria-expanded', 'false');
  resetSettingsSlide();
  // La barra inferior de celular se quedaba marcando "Ajustes" aunque ya hubieras cerrado el panel
  const mobileTabBarEl = document.getElementById('mobile-tab-bar');
  if (mobileTabBarEl) {
    mobileTabBarEl.querySelectorAll('.mobile-tab-btn').forEach(b => b.classList.remove('active'));
    const inicioTab = mobileTabBarEl.querySelector('[data-tab="inicio"]');
    if (inicioTab) inicioTab.classList.add('active');
  }
}

function resetSettingsSlide() {
  if (settingsMainView) settingsMainView.classList.remove('slide-out');
  document.querySelectorAll('.settings-sub-panel').forEach(p => p.classList.remove('slide-in'));
}

document.querySelectorAll('.setting-card-item[data-target]').forEach(card => {
  card.addEventListener('click', (e) => {
    playSFX('open');
    const targetId = e.currentTarget.dataset.target;
    const subPanel = document.getElementById(targetId);
    if (subPanel) {
      if (settingsMainView) settingsMainView.classList.add('slide-out');
      subPanel.classList.add('slide-in');
    }
  });
});

document.querySelectorAll('.btn-sub-back').forEach(btn => {
  btn.addEventListener('click', () => { playSFX('close'); resetSettingsSlide(); });
});

if (btnOpenHidden) btnOpenHidden.addEventListener('click', () => { playSFX('open'); renderHiddenList(); openModal(modalHidden); });
if (btnCloseHidden) btnCloseHidden.addEventListener('click', () => { playSFX('close'); closeModal(modalHidden); });

function renderHiddenList() {
  if (!hiddenPlaylistEl) return;
  hiddenPlaylistEl.innerHTML = '';
  const hiddenSongs = songList.filter(s => s.isHidden);
  if (hiddenSongs.length === 0) {
    hiddenPlaylistEl.innerHTML = '<li class="empty-msg">No hay canciones ocultas</li>';
    return;
  }
  hiddenSongs.forEach(song => {
    const li = document.createElement('li');
    li.className = 'playlist-item';
    li.innerHTML = `
      <img src="${song.cover}" class="item-thumb">
      <div class="item-details"><div class="item-title">${song.title}</div></div>
      <button class="item-menu-btn" title="Opciones">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
      </button>
    `;
    li.querySelector('.item-menu-btn').addEventListener('click', (e) => { e.stopPropagation(); playSFX('open'); openSongMenu(song); });
    hiddenPlaylistEl.appendChild(li);
  });
}

function openSongMenu(song) {
  selectedSongForMenu = song;
  if (modalSongTitle) modalSongTitle.textContent = song.title;
  if (txtHideOpt) txtHideOpt.textContent = song.isHidden ? "Mostrar Canción" : "Ocultar Canción";
  openModal(modalSongMenu);
}
if (btnCloseSongMenu) btnCloseSongMenu.addEventListener('click', () => { playSFX('close'); closeModal(modalSongMenu); });

if (optEditSong) {
  optEditSong.addEventListener('click', () => {
    playSFX('open');
    if (!selectedSongForMenu) return;
    pendingEditCover = null;
    if (inputEditTitle) inputEditTitle.value = selectedSongForMenu.title || "";
    if (editCoverPreview) editCoverPreview.src = selectedSongForMenu.cover || "";
    closeModal(modalSongMenu);
    openModal(modalEditSong);
  });
}

if (btnCloseEditSong) btnCloseEditSong.addEventListener('click', () => { playSFX('close'); closeModal(modalEditSong); });
if (editCoverWrapper) editCoverWrapper.addEventListener('click', () => { if (inputEditCover) inputEditCover.click(); });

if (inputEditCover) {
  inputEditCover.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (ev.target && ev.target.result) {
        pendingEditCover = ev.target.result;
        if (editCoverPreview) editCoverPreview.src = pendingEditCover;
      }
    };
    reader.readAsDataURL(file);
  });
}

if (btnSaveSongEdit) {
  btnSaveSongEdit.addEventListener('click', () => {
    playSFX('click');
    if (!selectedSongForMenu) { closeModal(modalEditSong); return; }

    const newTitle = inputEditTitle ? inputEditTitle.value.trim() : "";
    if (newTitle) selectedSongForMenu.title = newTitle;
    if (pendingEditCover) selectedSongForMenu.cover = pendingEditCover;

    updateSongInDB(selectedSongForMenu);

    if (songList[currentIndex] === selectedSongForMenu) {
      if (title) title.textContent = selectedSongForMenu.title;
      if (cover) cover.src = selectedSongForMenu.cover;
      if (playerBgFluid) playerBgFluid.style.backgroundImage = `url(${selectedSongForMenu.cover})`;
      if (lyricsBg) lyricsBg.style.backgroundImage = `url(${selectedSongForMenu.cover})`;
      if (cinemaCover) cinemaCover.src = selectedSongForMenu.cover;
      if (cinemaTitle) cinemaTitle.textContent = selectedSongForMenu.title;
      if (cinemaArtist) cinemaArtist.textContent = selectedSongForMenu.artist;
      if (cinemaBg) cinemaBg.style.backgroundImage = `url(${selectedSongForMenu.cover})`;
      updateMediaSession(selectedSongForMenu);
    }

    pendingEditCover = null;
    closeModal(modalEditSong);
    renderPlaylist();
    renderHiddenList();
  });
}

if (optHideSong) {
  optHideSong.addEventListener('click', () => {
    playSFX('click');
    if (selectedSongForMenu) {
      const changedSong = selectedSongForMenu;
      changedSong.isHidden = !changedSong.isHidden;
      updateSongInDB(changedSong);
      closeModal(modalSongMenu);

      // Si se oculta la canción que está sonando, no permitas que siga hasta un loop
      // ni que se reinicie. Cambia a una pista visible de la cola activa o detén el audio.
      if (changedSong.isHidden && songList[currentIndex] === changedSong) {
        const wasPlaying = !!(activeAudio && !activeAudio.paused);
        const replacement = chooseAdjacentPlayableIndex(1, { useShuffle: isShuffle, allowWrap: true });
        if (replacement >= 0) loadSong(replacement, wasPlaying);
        else stopForNoPlayableTracks(false);
      }
      renderPlaylist();
      renderHiddenList();
      syncLibrarySectionIndicators();
    }
  });
}


// =========================================================
// METADATOS DE CANCIÓN — LECTOR, EDITOR Y DIAGNÓSTICO
// =========================================================
const SONG_METADATA_FIELDS = [
  ['title', 'Título'],
  ['artist', 'Artista'],
  ['album', 'Álbum'],
  ['albumArtist', 'Artista del álbum'],
  ['genre', 'Género'],
  ['year', 'Año'],
  ['track', 'Número de pista'],
  ['disc', 'Disco'],
  ['composer', 'Compositor'],
  ['publisher', 'Editorial'],
  ['copyright', 'Derechos de autor'],
  ['comment', 'Comentario'],
  ['lyrics', 'Letras incrustadas']
];
let songMetadataMode = 'edit';
let songMetadataReadRaw = null;

function getSongMetadataObject(song) {
  const meta = song?.metadata && typeof song.metadata === 'object' ? song.metadata : {};
  return {
    title: song?.title || meta.title || '',
    artist: song?.artist || meta.artist || '',
    album: meta.album || '',
    albumArtist: meta.albumArtist || '',
    genre: meta.genre || '',
    year: meta.year || '',
    track: meta.track || '',
    disc: meta.disc || '',
    composer: meta.composer || '',
    publisher: meta.publisher || '',
    copyright: meta.copyright || '',
    comment: meta.comment || '',
    lyrics: meta.lyrics || meta.unsynchronizedLyrics || ''
  };
}

function hasUsefulEmbeddedLyrics(tags) {
  if (!tags || typeof tags !== 'object') return false;
  const seen = new WeakSet();
  const walk = (value, keyName = '') => {
    if (value == null) return false;
    if (typeof value === 'string') {
      return /lyric/i.test(keyName) && value.trim().length > 0;
    }
    if (Array.isArray(value)) return value.some(item => walk(item, keyName));
    if (typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    return Object.entries(value).some(([k,v]) => walk(v, k));
  };
  return walk(tags);
}

function normalizeTagValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.join('; ');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.description === 'string') return value.description;
    return '';
  }
  return String(value).trim();
}

function extractReadableTags(tags) {
  const pick = (...keys) => {
    for (const key of keys) {
      const v = normalizeTagValue(tags?.[key]);
      if (v) return v;
    }
    return '';
  };
  return {
    title: pick('title'),
    artist: pick('artist'),
    album: pick('album'),
    albumArtist: pick('albumartist', 'albumArtist', 'TPE2'),
    genre: pick('genre'),
    year: pick('year', 'TYER', 'date'),
    track: pick('track', 'TRCK'),
    disc: pick('disk', 'disc', 'TPOS'),
    composer: pick('composer', 'TCOM'),
    publisher: pick('publisher', 'TPUB'),
    copyright: pick('copyright', 'TCOP'),
    comment: pick('comment', 'COMM'),
    lyrics: hasUsefulEmbeddedLyrics(tags) ? '[Letras incrustadas detectadas]' : ''
  };
}

function safeMetadataString(value, max=12000) {
  return String(value ?? '').replace(/\0/g, '').slice(0, max);
}

function formatDurationForMetadata(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return 'No disponible';
  const s = Math.floor(n);
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}

async function getSongDurationForMetadata(song) {
  if (!song) return null;
  if (song === songList[currentIndex] && Number.isFinite(activeAudio?.duration)) return activeAudio.duration;
  if (!song.fileBlob) return null;
  return await new Promise(resolve => {
    try {
      const url = URL.createObjectURL(song.fileBlob);
      const probe = document.createElement('audio');
      let done = false;
      const finish = value => { if (done) return; done = true; URL.revokeObjectURL(url); probe.remove(); resolve(value); };
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => finish(probe.duration);
      probe.onerror = () => finish(null);
      probe.src = url;
      probe.load();
    } catch (_) { resolve(null); }
  });
}

function setMetadataField(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value == null ? '' : String(value);
}
function getMetadataField(id) {
  const el = document.getElementById(id);
  return el ? safeMetadataString(el.value, id === 'meta-lyrics' ? 12000 : 1000).trim() : '';
}

function updateMetadataDownloadButtons(song) {
  const canDownload = !!song?.fileBlob;
  [btnDownloadSongFile, btnDownloadSongFileInfo].forEach(btn => {
    if (!btn) return;
    btn.disabled = !canDownload;
    btn.title = canDownload ? 'Descargar el archivo local guardado' : 'Solo disponible para archivos locales guardados';
  });
}

function downloadSongFile(song) {
  if (!song?.fileBlob) {
    showToast('Esta canción no tiene un archivo local descargable.', 'info', 2200);
    return;
  }
  try {
    const url = URL.createObjectURL(song.fileBlob);
    const a = document.createElement('a');
    a.href = url;
    const fallback = `${song.title || 'Glasstrack'}${song.fileBlob.type?.includes('mpeg') ? '.mp3' : ''}`;
    a.download = song.fileBlob.name || fallback;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  } catch (_) {
    showToast('No se pudo preparar la descarga.', 'error', 2200);
  }
}

function renderMetadataSummary(song, tags, duration, target = songMetadataSummary) {
  if (!target) return;
  const source = song?.fileBlob ? 'Archivo local' : song?.sourceType === 'url' ? 'URL' : song?.sourceType === 'youtube' ? 'YouTube' : 'Biblioteca';
  const type = song?.fileBlob?.type || 'tipo no disponible';
  const size = song?.fileBlob?.size ? `${(song.fileBlob.size / 1048576).toFixed(2)} MB` : '—';
  const embeddedLyrics = tags ? hasUsefulEmbeddedLyrics(tags) : !!song?.metadata?.lyrics;
  target.replaceChildren();
  const items = [
    ['Fuente', source],
    ['Formato', type],
    ['Tamaño', size],
    ['Duración', formatDurationForMetadata(duration)],
    ['Letras en metadatos', embeddedLyrics ? 'Sí' : 'No / no detectadas']
  ];
  for (const [label, value] of items) {
    const card = document.createElement('div');
    card.className = 'song-meta-badge';
    const strong = document.createElement('strong');
    strong.textContent = label;
    const span = document.createElement('span');
    span.textContent = value;
    card.append(strong, span);
    target.appendChild(card);
  }
}

function appendMetadataRow(container, label, value, kind='positive') {
  const row = document.createElement('div');
  row.className = `song-meta-row ${kind}`;
  const strong = document.createElement('strong'); strong.textContent = label;
  const span = document.createElement('span'); span.textContent = value || 'No disponible';
  row.append(strong, span); container.appendChild(row);
}

function renderMetadataDiagnosis(song, current, tags, duration) {
  if (songMetadataFound) songMetadataFound.replaceChildren();
  if (songMetadataMissing) songMetadataMissing.replaceChildren();
  const tagData = tags ? extractReadableTags(tags) : {};
  const sourceData = { ...tagData, ...Object.fromEntries(Object.entries(current).filter(([k,v]) => v)) };
  for (const [key, label] of SONG_METADATA_FIELDS) {
    const value = sourceData[key];
    if (value) appendMetadataRow(songMetadataFound, label, key === 'lyrics' ? (tagData.lyrics || 'Sí') : value, 'positive');
    else appendMetadataRow(songMetadataMissing, label, 'No disponible', 'negative');
  }
  appendMetadataRow(songMetadataFound, 'Duración', formatDurationForMetadata(duration), 'positive');
  appendMetadataRow(songMetadataFound, 'Archivo local', song?.fileBlob ? 'Sí' : 'No', 'positive');
  if (songMetadataRaw) {
    const filtered = {};
    if (tags && typeof tags === 'object') {
      for (const [k,v] of Object.entries(tags)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') filtered[k] = v;
        else if (Array.isArray(v)) filtered[k] = v.slice(0, 8);
      }
    }
    songMetadataRaw.textContent = Object.keys(filtered).length ? JSON.stringify(filtered, null, 2) : 'No hay lectura de etiquetas externas; se muestran los datos conocidos de Glasstrack.';
  }
}

function openSongMetadataModal(song, mode='edit') {
  const isEdit = mode === 'edit';
  const targetModal = isEdit ? modalSongMetadataEdit : modalSongMetadata;
  const summaryTarget = isEdit ? songMetadataEditSummary : songMetadataSummary;
  if (!song || !targetModal) return;

  songMetadataMode = mode;
  if (songMetadataTitle) songMetadataTitle.textContent = 'Todos los metadatos';
  if (songMetadataSubtitle) songMetadataSubtitle.textContent = song.title || 'Canción';
  if (songMetadataEditSubtitle) songMetadataEditSubtitle.textContent = song.title || 'Editar datos de la canción';
  // Cada ventana conserva su propio contenido visible: lectura y edición no se mezclan.
  songMetadataEditor?.classList.remove('hidden');
  songMetadataInfo?.classList.remove('hidden');

  const current = getSongMetadataObject(song);
  setMetadataField('meta-title', current.title);
  setMetadataField('meta-artist', current.artist);
  setMetadataField('meta-album', current.album);
  setMetadataField('meta-album-artist', current.albumArtist);
  setMetadataField('meta-genre', current.genre);
  setMetadataField('meta-year', current.year);
  setMetadataField('meta-track', current.track);
  setMetadataField('meta-disc', current.disc);
  setMetadataField('meta-composer', current.composer);
  setMetadataField('meta-publisher', current.publisher);
  setMetadataField('meta-copyright', current.copyright);
  setMetadataField('meta-comment', current.comment);
  setMetadataField('meta-lyrics', current.lyrics);
  songMetadataReadRaw = null;
  const knownDuration = song === songList[currentIndex] ? activeAudio?.duration : song.duration;
  renderMetadataSummary(song, null, knownDuration, summaryTarget);
  updateMetadataDownloadButtons(song);
  openModal(targetModal);
  targetModal.setAttribute('aria-hidden', 'false');

  const readFileTags = () => {
    if (!song.fileBlob || !window.jsmediatags) {
      renderMetadataSummary(song, null, knownDuration, summaryTarget);
      if (!isEdit) renderMetadataDiagnosis(song, current, null, knownDuration);
      return;
    }
    window.jsmediatags.read(song.fileBlob, {
      onSuccess(tag) {
        songMetadataReadRaw = tag.tags || {};
        const detected = extractReadableTags(songMetadataReadRaw);
        if (isEdit) {
          // Completa únicamente campos vacíos; nunca pisa lo que ya está guardado.
          const merged = { ...current };
          Object.entries(detected).forEach(([k,v]) => { if (!merged[k] && v && k !== 'lyrics') merged[k] = v; });
          setMetadataField('meta-title', merged.title);
          setMetadataField('meta-artist', merged.artist);
          setMetadataField('meta-album', merged.album);
          setMetadataField('meta-album-artist', merged.albumArtist);
          setMetadataField('meta-genre', merged.genre);
          setMetadataField('meta-year', merged.year);
          setMetadataField('meta-track', merged.track);
          setMetadataField('meta-disc', merged.disc);
          setMetadataField('meta-composer', merged.composer);
          setMetadataField('meta-publisher', merged.publisher);
          setMetadataField('meta-copyright', merged.copyright);
          setMetadataField('meta-comment', merged.comment);
          if (!merged.lyrics && detected.lyrics) setMetadataField('meta-lyrics', '[Letras incrustadas detectadas]');
        }
        getSongDurationForMetadata(song).then(duration => {
          renderMetadataSummary(song, songMetadataReadRaw, duration, summaryTarget);
          if (!isEdit) renderMetadataDiagnosis(song, getSongMetadataObject(song), songMetadataReadRaw, duration);
        });
      },
      onError() {
        getSongDurationForMetadata(song).then(duration => {
          renderMetadataSummary(song, null, duration, summaryTarget);
          if (!isEdit) renderMetadataDiagnosis(song, current, null, duration);
        });
      }
    });
  };
  readFileTags();
}

function saveSongMetadata() {
  const song = selectedSongForMenu;
  if (!song) return;
  const metadata = {
    ...(song.metadata && typeof song.metadata === 'object' ? song.metadata : {}),
    title: getMetadataField('meta-title'),
    artist: getMetadataField('meta-artist'),
    album: getMetadataField('meta-album'),
    albumArtist: getMetadataField('meta-album-artist'),
    genre: getMetadataField('meta-genre'),
    year: getMetadataField('meta-year'),
    track: getMetadataField('meta-track'),
    disc: getMetadataField('meta-disc'),
    composer: getMetadataField('meta-composer'),
    publisher: getMetadataField('meta-publisher'),
    copyright: getMetadataField('meta-copyright'),
    comment: getMetadataField('meta-comment'),
    lyrics: getMetadataField('meta-lyrics')
  };
  song.metadata = metadata;
  song.title = metadata.title || song.title || 'Canción sin título';
  song.artist = metadata.artist || song.artist || 'Artista desconocido';
  updateSongInDB(song);
  if (songList[currentIndex] === song) {
    if (title) title.textContent = song.title;
    if (artist) artist.textContent = song.artist;
    if (cover) cover.src = song.cover || cover.src;
    if (playerBgFluid && song.cover) playerBgFluid.style.backgroundImage = `url("${String(song.cover).replace(/"/g,'\\"')}")`;
    if (lyricsBg && song.cover) lyricsBg.style.backgroundImage = `url("${String(song.cover).replace(/"/g,'\\"')}")`;
    if (cinemaCover && song.cover) cinemaCover.src = song.cover;
    if (cinemaTitle) cinemaTitle.textContent = song.title;
    if (cinemaArtist) cinemaArtist.textContent = song.artist;
    if (cinemaBg && song.cover) cinemaBg.style.backgroundImage = `url("${String(song.cover).replace(/"/g,'\\"')}")`;
    updateMediaSession(song);
  }
  renderPlaylist();
  renderHiddenList();
  closeModal(modalSongMetadataEdit);
  modalSongMetadataEdit?.setAttribute('aria-hidden', 'true');
  showToast('Metadatos guardados en Glasstrack.', 'success', 2200);
}

function exportSongMetadata(song, diagnostic=false) {
  if (!song) return;
  const data = diagnostic ? {
    app: 'Glasstrack Pro', type: 'song-metadata-diagnostic', exportedAt: new Date().toISOString(),
    song: { title: song.title || '', artist: song.artist || '', sourceType: song.sourceType || 'local', hasLocalFile: !!song.fileBlob },
    metadata: getSongMetadataObject(song),
    detectedTags: songMetadataReadRaw || null
  } : {
    app: 'Glasstrack Pro', type: 'song-metadata', exportedAt: new Date().toISOString(),
    metadata: getSongMetadataObject(song)
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=`${(song.title || 'cancion').replace(/[^\w\- ]+/g,'_')}-metadata.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1200);
}

if (optEditMetadata) {
  optEditMetadata.addEventListener('click', () => {
    playSFX('open');
    if (!selectedSongForMenu) return;
    closeModal(modalSongMenu);
    openSongMetadataModal(selectedSongForMenu, 'edit');
  });
}
if (optSongMetadata) {
  optSongMetadata.addEventListener('click', () => {
    playSFX('open');
    if (!selectedSongForMenu) return;
    closeModal(modalSongMenu);
    openSongMetadataModal(selectedSongForMenu, 'info');
  });
}
if (btnCloseSongMetadata) btnCloseSongMetadata.addEventListener('click', () => { playSFX('close'); closeModal(modalSongMetadata); modalSongMetadata?.setAttribute('aria-hidden', 'true'); });
if (modalSongMetadata) modalSongMetadata.addEventListener('click', e => { if (e.target === modalSongMetadata) { closeModal(modalSongMetadata); modalSongMetadata.setAttribute('aria-hidden', 'true'); } });
if (btnCloseSongMetadataEdit) btnCloseSongMetadataEdit.addEventListener('click', () => { playSFX('close'); closeModal(modalSongMetadataEdit); modalSongMetadataEdit?.setAttribute('aria-hidden', 'true'); });
if (modalSongMetadataEdit) modalSongMetadataEdit.addEventListener('click', e => { if (e.target === modalSongMetadataEdit) { closeModal(modalSongMetadataEdit); modalSongMetadataEdit.setAttribute('aria-hidden', 'true'); } });
if (btnSaveSongMetadata) btnSaveSongMetadata.addEventListener('click', () => { playSFX('click'); saveSongMetadata(); });
if (btnDownloadSongFile) btnDownloadSongFile.addEventListener('click', () => downloadSongFile(selectedSongForMenu));
if (btnDownloadSongFileInfo) btnDownloadSongFileInfo.addEventListener('click', () => downloadSongFile(selectedSongForMenu));
if (btnExportSongMetadata) btnExportSongMetadata.addEventListener('click', () => exportSongMetadata(selectedSongForMenu, false));
if (btnExportSongMetadataInfo) btnExportSongMetadataInfo.addEventListener('click', () => exportSongMetadata(selectedSongForMenu, true));

async function hardDeleteSong(song) {
  if (!song || song.id === undefined || song.id === null) {
    showToast('No se pudo eliminar la canción: falta su ID de IndexedDB.', 'error');
    return false;
  }

  try {
    // 1) Elimina físicamente el registro que contiene el Blob de audio.
    await new Promise((resolve, reject) => {
      if (!db) {
        reject(new Error('IndexedDB no está disponible'));
        return;
      }

      const storeNames = ["songs"];
      if (db.objectStoreNames.contains("charts")) storeNames.push("charts");
      const tx = db.transaction(storeNames, "readwrite");
      const store = tx.objectStore("songs");
      store.delete(song.id);
      if (db.objectStoreNames.contains("charts")) {
        tx.objectStore("charts").delete(song.id);
      }

      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('Error eliminando la canción'));
      tx.onabort = () => reject(tx.error || new Error('Transacción abortada'));
    });

    // 2) Libera la URL temporal de memoria.
    if (song.url) {
      try { URL.revokeObjectURL(song.url); } catch (_) {}
    }

    const deletedIndex = songList.indexOf(song);
    const wasCurrent = deletedIndex === currentIndex;
    const wasPlaying = activeAudio && !activeAudio.paused;

    // 3) Elimina la referencia de memoria.
    if (deletedIndex > -1) {
      songList.splice(deletedIndex, 1);
    }
    saveLibraryCountHint(activeProfileId, songList.length);
    refreshLibraryCountHint(activeProfileId).catch(() => {});

    // 4) Quita también la canción eliminada de todas las playlists guardadas.
    Object.keys(playlists).forEach(name => {
      const list = Array.isArray(playlists[name]) ? playlists[name] : [];
      playlists[name] = list.filter(item => {
        if (song.id !== undefined && item && item.id !== undefined) {
          return item.id !== song.id;
        }
        return !(
          item &&
          item.title === song.title &&
          item.artist === song.artist
        );
      });
    });
    savePlaylistsToStorage();

    // 5) Mantén currentIndex consistente.
    if (songList.length === 0) {
      currentIndex = 0;
      audio1.pause();
      audio2.pause();
      audio1.removeAttribute('src');
      audio2.removeAttribute('src');
      audio1.load();
      audio2.load();
      if (title) title.textContent = 'Sin canción cargada';
      if (artist) artist.textContent = '—';
      if (cover) cover.removeAttribute('src');
      if (playerBgFluid) playerBgFluid.style.backgroundImage = '';
      if (lyricsBg) lyricsBg.style.backgroundImage = '';
      if (cinemaCover) cinemaCover.removeAttribute('src');
      if (cinemaTitle) cinemaTitle.textContent = 'Sin canción cargada';
      if (cinemaArtist) cinemaArtist.textContent = '—';
      if (cinemaBg) cinemaBg.style.backgroundImage = '';
      displayLyrics('');
    } else if (wasCurrent) {
      currentIndex = Math.min(
        deletedIndex,
        songList.length - 1
      );
      loadSong(currentIndex, false);
      if (wasPlaying) pauseSong();
    } else {
      if (deletedIndex > -1 && deletedIndex < currentIndex) {
        currentIndex -= 1;
      }
      renderPlaylist();
      renderHiddenList();
    }

    selectedSongForMenu = null;
    renderPlaylist();
    renderHiddenList();
    showToast(`"${song.title}" eliminada permanentemente.`, 'info');
    return true;
  } catch (error) {
    console.error('Error en hardDeleteSong:', error);
    showToast('No se pudo eliminar la canción permanentemente.', 'error');
    return false;
  }
}

if (optDeleteSong) {
  optDeleteSong.addEventListener('click', async () => {
    playSFX('click');
    if (!selectedSongForMenu) return;

    const song = selectedSongForMenu;
    const confirmed = confirm(
      `¿Eliminar permanentemente "${song.title}"?\n\nEl archivo se borrará de la biblioteca local y no podrá recuperarse desde Glasstrack.`
    );

    if (!confirmed) return;

    closeModal(modalSongMenu);
    await hardDeleteSong(song);
  });
}

if (optAddToPlaylist) {
  optAddToPlaylist.addEventListener('click', () => {
    playSFX('open');
    closeModal(modalSongMenu);
    renderTargetPlaylists();
    openModal(modalSelectPlaylist);
  });
}
if (btnCloseSelectPlaylist) btnCloseSelectPlaylist.addEventListener('click', () => { playSFX('close'); closeModal(modalSelectPlaylist); });

function renderTargetPlaylists() {
  if (!targetPlaylistsList) return;
  targetPlaylistsList.innerHTML = '';
  const pKeys = Object.keys(playlists);
  if (pKeys.length === 0) {
    targetPlaylistsList.innerHTML = '<li class="empty-msg">Crea una playlist primero</li>';
    return;
  }
  pKeys.forEach(pName => {
    const li = document.createElement('li');
    li.className = 'playlist-item';
    li.innerHTML = `<div class="item-details" style="padding:10px;"><div class="item-title">${pName}</div></div>`;
    li.addEventListener('click', () => {
      playSFX('click');
      const alreadyIn = selectedSongForMenu && playlists[pName].some(s =>
        (selectedSongForMenu.id !== undefined && s.id === selectedSongForMenu.id) ||
        (s.title === selectedSongForMenu.title && s.artist === selectedSongForMenu.artist)
      );
      if (selectedSongForMenu && !alreadyIn) {
        playlists[pName].push(selectedSongForMenu);
        savePlaylistsToStorage();
      }
      closeModal(modalSelectPlaylist);
    });
    targetPlaylistsList.appendChild(li);
  });
}

// ==========================================
// 10. ESTILOS, ATAJOS Y PERSONALIZACIÓN
// ==========================================
// Compatibilidad con B30: el selector antiguo fue sustituido por los perfiles B32.
function applyGraphicsLevel(level) {
  document.body.classList.remove('graphics-level-0', 'graphics-level-1');
  if (String(level) === '0') document.body.classList.add('graphics-level-0');
  else if (String(level) === '1') document.body.classList.add('graphics-level-1');
}


if (toggleSFX) {
  toggleSFX.checked = sfxEnabled;
  toggleSFX.addEventListener('change', (e) => {
    sfxEnabled = e.target.checked;
    localStorage.setItem('glasstrack_sfx_enabled', String(sfxEnabled));
  });
}

function resetInterfaceSettingsPreservingLibrary() {
  // Restablecer el aspecto no debe cerrar/desvincular la cuenta ni ocultar la biblioteca.
  // Las canciones viven en IndexedDB; estas claves son la identidad usada para encontrarlas.
  const exactKeysToKeep = new Set([
    GLASSTRACK_ACCOUNTS_KEY,
    GLASSTRACK_ACTIVE_PROFILE_KEY,
    GLASSTRACK_SESSION_KEY,
    GLASSTRACK_INITIALIZED_KEY,
    'glasstrack_library_had_songs_v1',
    'glasstrack_storage_persisted',
    'playlistsDB', 'listeningStats', 'totalPlayedSeconds', 'concludorChain'
  ]);
  const keysToKeep = key => {
    if (exactKeysToKeep.has(key)) return true;
    if (key.startsWith('glasstrackAccount')) return true; // compatibilidad con cuentas antiguas
    if (key.startsWith(GLASSTRACK_LIBRARY_COUNT_PREFIX)) return true;
    return /^glasstrack\.profile\..+\.(playlistsDB|listeningStats|totalPlayedSeconds|concludorChain)$/.test(key);
  };
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && !keysToKeep(key)) keys.push(key);
  }
  keys.forEach(key => {
    try { localStorage.removeItem(key); }
    catch (error) { console.warn('No se pudo restablecer una preferencia:', key, error); }
  });
}

if (btnFactoryReset) {
  btnFactoryReset.addEventListener('click', () => {
    playSFX('click');
    if (confirm("¿Restablecer la apariencia y las preferencias? La biblioteca musical, las cuentas y las playlists se conservarán.")) {
      resetInterfaceSettingsPreservingLibrary();
      location.reload();
    }
  });
}

// Alineación de texto en Modo Cine (Gemini dejó estos botones sin ninguna lógica)
document.querySelectorAll('.align-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    playSFX('click');
    document.querySelectorAll('.align-btn').forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    const align = e.currentTarget.dataset.align || 'center';
    document.documentElement.style.setProperty('--cinema-lyrics-align', align);
  });
});

// Escalado y tamaño del Modo Cine (también sin lógica)
document.querySelectorAll('.cinema-scale-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    playSFX('click');
    document.querySelectorAll('.cinema-scale-btn').forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    const scale = e.currentTarget.dataset.scale;
    const presetValue = scale === 'max' ? 1.5 : (scale === 'large' ? 1.25 : 1);
    document.documentElement.style.setProperty('--cinema-scale-preset', presetValue);
  });
});

// Efectos de Modo Cine: preferencias propias, sin tocar IndexedDB ni la biblioteca.
(() => {
  const root = document.getElementById('cinema-mode');
  if (!root) return;
  const prefKey = 'glasstrack_cinema_visual_preferences_v1';
  const animationClasses = ['none','ghost','typewriter','fade','word','scanner','echo'];
  const effectNames = ['depth','focus-frame','audio-underline','reflection','contrast'];
  const defaults = { animation: 'none', effects: [], position: 50, size: 100, controls: ['seekbar','visualizer','lyrics-style','song-menu'] };
  let prefs = {...defaults};
  try { const saved = JSON.parse(localStorage.getItem(prefKey) || 'null'); if (saved && typeof saved === 'object') prefs = {...defaults,...saved}; } catch (_) {}
  function save(){ try { localStorage.setItem(prefKey, JSON.stringify(prefs)); } catch (_) {} }
  function apply(){
    root.classList.remove(...animationClasses.map(v => 'cinema-animation-' + v));
    root.classList.add('cinema-animation-' + (animationClasses.includes(prefs.animation) ? prefs.animation : 'none'));
    effectNames.forEach(name => root.classList.toggle('cinema-effect-' + name, Array.isArray(prefs.effects) && prefs.effects.includes(name)));
    document.documentElement.style.setProperty('--cinema-lyrics-position', `${Math.max(25,Math.min(75,Number(prefs.position)||50))}%`);
    document.documentElement.style.setProperty('--cinema-user-lyrics-size', String(Math.max(75,Math.min(140,Number(prefs.size)||100))/100));
    document.querySelectorAll('[data-cinema-control]').forEach(el => {
      const key = el.dataset.cinemaControl; const target = ({seekbar: cinemaSeekbarWrapper, visualizer: document.getElementById('btn-cinema-audio-visualizer'), 'lyrics-style': cinemaLyricsStyleBtn, 'song-menu': cinemaSongMenuBtn})[key];
      if (target) target.classList.toggle('cinema-user-hidden', !prefs.controls.includes(key));
    });
    const pos = document.getElementById('cinema-lyrics-position'); if (pos) pos.value = prefs.position;
    const size = document.getElementById('cinema-lyrics-size'); if (size) size.value = prefs.size;
    document.querySelectorAll('input[name="cinema-lyric-animation"]').forEach(el => el.checked = el.value === prefs.animation);
    document.querySelectorAll('[data-cinema-effect]').forEach(el => el.checked = prefs.effects.includes(el.dataset.cinemaEffect));
    document.querySelectorAll('[data-cinema-control]').forEach(el => el.checked = prefs.controls.includes(el.dataset.cinemaControl));
  }
  document.querySelectorAll('input[name="cinema-lyric-animation"]').forEach(el => el.addEventListener('change', () => { if (el.checked) { prefs.animation = el.value; save(); apply(); } }));
  document.querySelectorAll('[data-cinema-effect]').forEach(el => el.addEventListener('change', () => { const v = el.dataset.cinemaEffect; prefs.effects = el.checked ? [...new Set([...prefs.effects,v])] : prefs.effects.filter(x => x !== v); save(); apply(); }));
  document.querySelectorAll('[data-cinema-control]').forEach(el => el.addEventListener('change', () => { const v = el.dataset.cinemaControl; prefs.controls = el.checked ? [...new Set([...prefs.controls,v])] : prefs.controls.filter(x => x !== v); save(); apply(); }));
  const position = document.getElementById('cinema-lyrics-position'); if (position) position.addEventListener('input', () => { prefs.position = Number(position.value); document.documentElement.style.setProperty('--cinema-lyrics-position', `${prefs.position}%`); save(); });
  const size = document.getElementById('cinema-lyrics-size'); if (size) size.addEventListener('input', () => { prefs.size = Number(size.value); document.documentElement.style.setProperty('--cinema-user-lyrics-size', String(prefs.size/100)); save(); });
  apply();
})();

// Mostrar / ocultar la barra de tiempo del Modo Cine (el switch tampoco hacía nada)
if (toggleCinemaSeekbar && cinemaSeekbarWrapper) {
  toggleCinemaSeekbar.addEventListener('change', (e) => {
    cinemaSeekbarWrapper.classList.toggle('hidden', !e.target.checked);
  });
}

// Barra de control: un único estado controla el bloque completo.
function setControlNotificationBarVisible(visible) {
  if (!controlNotificationBar) return;
  controlNotificationBar.classList.toggle('bar-hidden', !visible);
  localStorage.setItem('glasstrackShowBar', visible ? 'true' : 'false');
}
if (toggleShowBar) {
  const savedShowBar = localStorage.getItem('glasstrackShowBar');
  if (savedShowBar !== null) toggleShowBar.checked = savedShowBar !== 'false';
  setControlNotificationBarVisible(toggleShowBar.checked);
  toggleShowBar.addEventListener('change', e => setControlNotificationBarVisible(e.target.checked));
}

// Estas opciones controlan Media Session sin crear estados de interfaz que se queden visibles.
function clearMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;
  ['play','pause','previoustrack','nexttrack'].forEach(action => {
    try { navigator.mediaSession.setActionHandler(action, null); } catch (e) {}
  });
}
function applyMediaSessionVisibilitySettings() {
  if (!('mediaSession' in navigator)) return;
  const showBar = toggleShowBar ? toggleShowBar.checked : true;
  if (!showBar) {
    try { navigator.mediaSession.metadata = null; } catch (e) {}
    clearMediaSessionHandlers();
    return;
  }
  const song = songList[currentIndex];
  if (song) updateMediaSession(song);
}
if (toggleShowIcon) toggleShowIcon.addEventListener('change', () => {
  localStorage.setItem('glasstrackShowIcon', toggleShowIcon.checked ? 'true' : 'false');
  if (songList[currentIndex]) updateMediaSession(songList[currentIndex]);
});
if (toggleShowName) toggleShowName.addEventListener('change', () => {
  localStorage.setItem('glasstrackShowName', toggleShowName.checked ? 'true' : 'false');
  if (songList[currentIndex]) updateMediaSession(songList[currentIndex]);
});
if (toggleMediaKeys) toggleMediaKeys.addEventListener('change', () => {
  localStorage.setItem('glasstrackMediaKeys', toggleMediaKeys.checked ? 'true' : 'false');
  if (toggleMediaKeys.checked && songList[currentIndex]) updateMediaSession(songList[currentIndex]);
  else clearMediaSessionHandlers();
});



// =========================================================
// GLASSTRACK PRO B31 — TANDA 1
// Tema, apariencia, fondos y personalización del reproductor.
// No cambia los valores existentes hasta que el usuario modifica una opción.
// =========================================================

// -------------------------
// Transparencia de cristal
// -------------------------
const inputGlassOpacityB31 = document.getElementById('input-glass-opacity');
const glassOpacityValB31 = document.getElementById('glass-opacity-val');
function setGlassAlphaB31(value) {
  const raw = Number(value);
  const alpha = Number.isFinite(raw) ? Math.max(0.05, Math.min(0.90, raw)) : 0.25;
  document.documentElement.style.setProperty('--glass-alpha', alpha.toFixed(2));
  if (glassOpacityValB31) glassOpacityValB31.textContent = `${Math.round(alpha * 100)}%`;
  localStorage.setItem('glasstrackGlassAlpha', String(alpha));
}
if (inputGlassOpacityB31) {
  const savedGlassAlpha = Number(localStorage.getItem('glasstrackGlassAlpha'));
  if (Number.isFinite(savedGlassAlpha)) {
    inputGlassOpacityB31.value = Math.max(0.05, Math.min(0.90, savedGlassAlpha));
  }
  // Este ajuste ya existía en B30: conservar su comportamiento actual.
  setGlassAlphaB31(inputGlassOpacityB31.value);
  inputGlassOpacityB31.addEventListener('input', (e) => setGlassAlphaB31(e.target.value));
}

// -------------------------
// Color dinámico + color manual
// -------------------------
let b31DynamicColorBusy = false;
function normalizeB31Hex(value, fallback = '#ffffff') {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : fallback;
}

async function applyB31DynamicInterfaceColor(src) {
  if (!toggleDynamicColor || toggleDynamicColor.checked !== true) return;
  if (localStorage.getItem('glasstrackDynamicColor') !== 'true') return;
  if (b31DynamicColorBusy || !src) return;

  b31DynamicColorBusy = true;
  try {
    const image = new Image();
    image.decoding = 'async';
    const source = String(src);
    if (!source.startsWith('blob:') && !source.startsWith('data:')) image.crossOrigin = 'anonymous';

    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = source;
    });

    const canvas = document.createElement('canvas');
    canvas.width = 28;
    canvas.height = 28;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(image, 0, 0, 28, 28);

    const data = ctx.getImageData(0, 0, 28, 28).data;
    let r = 0, g = 0, b = 0, count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      const rr = data[i];
      const gg = data[i + 1];
      const bb = data[i + 2];
      const max = Math.max(rr, gg, bb);
      const min = Math.min(rr, gg, bb);
      if (a < 140 || max < 22 || (max > 246 && max - min < 18)) continue;
      r += rr;
      g += gg;
      b += bb;
      count++;
    }
    if (!count) return;

    const boost = 1.06;
    const R = Math.min(255, Math.round((r / count) * boost));
    const G = Math.min(255, Math.round((g / count) * boost));
    const B = Math.min(255, Math.round((b / count) * boost));
    const hex = '#' + [R, G, B].map(v => v.toString(16).padStart(2, '0')).join('');

    document.documentElement.style.setProperty('--primary-color', hex);
    document.documentElement.style.setProperty('--accent-color', hex);
    document.querySelectorAll('.color-dot[data-color]').forEach(d => d.classList.remove('active'));
  } catch (_) {
    // Imágenes remotas sin CORS pueden no permitir lectura de píxeles; se conserva el color actual.
  } finally {
    b31DynamicColorBusy = false;
  }
}

if (toggleDynamicColor) {
  const savedDynamic = localStorage.getItem('glasstrackDynamicColor');
  if (savedDynamic !== null) toggleDynamicColor.checked = savedDynamic === 'true';

  toggleDynamicColor.addEventListener('change', () => {
    playSFX('click');
    const enabled = toggleDynamicColor.checked === true;
    localStorage.setItem('glasstrackDynamicColor', enabled ? 'true' : 'false');
    localStorage.setItem('glasstrackDynamicColorExplicit', 'true');
    if (enabled && cover && cover.src) applyB31DynamicInterfaceColor(cover.src);
    else {
      const savedManual = normalizeB31Hex(localStorage.getItem('glasstrackAccentColor'), '#ffffff');
      document.documentElement.style.setProperty('--primary-color', savedManual);
      document.documentElement.style.setProperty('--accent-color', savedManual);
      const isPreset = [...document.querySelectorAll('.color-dot[data-color]')].some(d => String(d.dataset.color).toLowerCase() === savedManual.toLowerCase());
      document.querySelectorAll('.color-dot[data-color]').forEach(d => d.classList.toggle('active', String(d.dataset.color).toLowerCase() === savedManual.toLowerCase()));
      if (!isPreset) document.querySelectorAll('.color-dot[data-color]').forEach(d => d.classList.remove('active'));
    }
  });
}

// Los presets / color personalizado usan la función manual existente.
document.querySelectorAll('.color-dot').forEach(dot => {
  dot.addEventListener('click', (e) => {
    playSFX('click');
    const color = e.currentTarget.dataset.color;
    if (!color) return;
    applyAccentColor(color);
    document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
    e.currentTarget.classList.add('active');
  });
});

if (inputCustomColor) {
  inputCustomColor.addEventListener('input', (e) => {
    const color = normalizeB31Hex(e.target.value, '#ffffff');
    applyAccentColor(color);
    document.querySelectorAll('.color-dot[data-color]').forEach(d => d.classList.remove('active'));
  });
}

if (cover) {
  cover.addEventListener('load', () => {
    const source = cover.src;
    if (localStorage.getItem('glasstrackDynamicColor') === 'true') {
      applyB31DynamicInterfaceColor(source);
    }
    if (getB31BackgroundMode() === 'dynamic') {
      applyB31DynamicBackground(source);
    }
  });
}

// -------------------------
// B31.1 — Personalizar apariencia
// -------------------------
function renderB31AppearanceValues(data) {
  if (glassBlurVal) glassBlurVal.textContent = `${data.blur}px`;
  if (glassBorderVal) glassBorderVal.textContent = `${Math.round(data.border * 100)}%`;
  if (glassShadowVal) glassShadowVal.textContent = `${Math.round(data.shadow * 100)}%`;
  if (glassRadiusVal) glassRadiusVal.textContent = `${data.radius}px`;
}

function applyB31Appearance(data, persist = false) {
  const safe = {
    blur: Math.max(0, Math.min(24, Number(data.blur) || 0)),
    border: Math.max(0, Math.min(0.30, Number(data.border) || 0)),
    shadow: Math.max(0, Math.min(1, Number(data.shadow) || 0)),
    radius: Math.max(8, Math.min(32, Number(data.radius) || 20))
  };

  document.documentElement.style.setProperty('--b31-glass-blur', `${safe.blur}px`);
  document.documentElement.style.setProperty('--b31-glass-border-alpha', String(safe.border));
  document.documentElement.style.setProperty('--b31-glass-shadow-alpha', String(safe.shadow));
  document.documentElement.style.setProperty('--b31-glass-radius', `${safe.radius}px`);
  renderB31AppearanceValues(safe);

  if (persist) {
    document.body.classList.add('b31-appearance-customized');
    localStorage.setItem('glasstrackB31Appearance', JSON.stringify(safe));
  }
}

(function restoreB31Appearance() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem('glasstrackB31Appearance') || 'null');
  } catch (_) {}

  const data = saved || {
    blur: Number(inputGlassBlur?.value || 12),
    border: Number(inputGlassBorder?.value || 0.08),
    shadow: Number(inputGlassShadow?.value || 0.40),
    radius: Number(inputGlassRadius?.value || 20)
  };

  if (saved) {
    if (inputGlassBlur) inputGlassBlur.value = Math.max(0, Math.min(24, Number(saved.blur)));
    if (inputGlassBorder) inputGlassBorder.value = Math.max(0, Math.min(0.30, Number(saved.border)));
    if (inputGlassShadow) inputGlassShadow.value = Math.max(0, Math.min(1, Number(saved.shadow)));
    if (inputGlassRadius) inputGlassRadius.value = Math.max(8, Math.min(32, Number(saved.radius)));
    document.body.classList.add('b31-appearance-customized');
  }

  applyB31Appearance(data, false);
})();

[inputGlassBlur, inputGlassBorder, inputGlassShadow, inputGlassRadius].forEach(el => {
  if (!el) return;
  el.addEventListener('input', () => {
    applyB31Appearance({
      blur: inputGlassBlur?.value,
      border: inputGlassBorder?.value,
      shadow: inputGlassShadow?.value,
      radius: inputGlassRadius?.value
    }, true);
  });
  el.addEventListener('change', () => {
    applyB31Appearance({
      blur: inputGlassBlur?.value,
      border: inputGlassBorder?.value,
      shadow: inputGlassShadow?.value,
      radius: inputGlassRadius?.value
    }, true);
  });
});

// -------------------------
// B31.2 — Fondos avanzados
// -------------------------
function clampB31(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function validB31Hex(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : fallback;
}
function getB31BackgroundMode() {
  const raw = localStorage.getItem('glasstrackB31BackgroundMode');
  return ['stored', 'solid', 'gradient', 'dynamic'].includes(raw) ? raw : 'stored';
}

function applyB31BackgroundVars() {
  const darken = clampB31(inputBgDarken?.value, 0, 80, 60);
  const blur = clampB31(inputBgBlur?.value, 0, 30, 0);
  const saturation = clampB31(inputBgSaturation?.value, 50, 160, 100);
  const overlay = (darken / 100).toFixed(3);

  document.documentElement.style.setProperty('--b31-bg-overlay-alpha', overlay);
  document.documentElement.style.setProperty('--b31-bg-blur', `${blur}px`);
  document.documentElement.style.setProperty('--b31-bg-saturation', (saturation / 100).toFixed(2));
  document.documentElement.style.setProperty('--b31-solid-bg', validB31Hex(inputBgSolidColor?.value, '#0a0a0f'));
  document.documentElement.style.setProperty('--b31-gradient-a', validB31Hex(inputBgGradientA?.value, '#0a0a0f'));
  document.documentElement.style.setProperty('--b31-gradient-b', validB31Hex(inputBgGradientB?.value, '#12131c'));
  document.documentElement.style.setProperty('--b31-gradient-angle', selectBgGradientDirection?.value || '135deg');

  if (bgDarkenVal) bgDarkenVal.textContent = `${Math.round(darken)}%`;
  if (bgBlurVal) bgBlurVal.textContent = `${Math.round(blur)}px`;
  if (bgSaturationVal) bgSaturationVal.textContent = `${Math.round(saturation)}%`;
}

function saveB31BackgroundValues() {
  const data = {
    solid: validB31Hex(inputBgSolidColor?.value, '#0a0a0f'),
    gradientA: validB31Hex(inputBgGradientA?.value, '#0a0a0f'),
    gradientB: validB31Hex(inputBgGradientB?.value, '#12131c'),
    direction: ['135deg', '90deg', '0deg', '225deg'].includes(selectBgGradientDirection?.value) ? selectBgGradientDirection.value : '135deg',
    darken: clampB31(inputBgDarken?.value, 0, 80, 60),
    blur: clampB31(inputBgBlur?.value, 0, 30, 0),
    saturation: clampB31(inputBgSaturation?.value, 50, 160, 100)
  };
  localStorage.setItem('glasstrackB31BackgroundValues', JSON.stringify(data));
}

const BG_REMOVED_FLAG = 'glasstrackBackgroundRemovedByUser';
let storedBackgroundLoadGeneration = 0;

function hideStoredBackgroundLayers() {
  // Invalidar cualquier lectura de IndexedDB que estuviera pendiente y pudiera
  // volver a mostrar un fondo después de que el usuario lo quitó.
  storedBackgroundLoadGeneration++;
  if (bgCustomImage) {
    bgCustomImage.style.display = 'none';
    bgCustomImage.style.backgroundImage = '';
  }
  if (bgVideo) {
    bgVideo.classList.add('bg-video-hidden');
    bgVideo.pause();
    bgVideo.src = '';
  }
}

function applyB31DynamicBackground(src) {
  if (!src) return;
  const image = new Image();
  image.decoding = 'async';
  const source = String(src);
  if (!source.startsWith('blob:') && !source.startsWith('data:')) image.crossOrigin = 'anonymous';
  image.onload = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 24;
      canvas.height = 24;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(image, 0, 0, 24, 24);
      const data = ctx.getImageData(0, 0, 24, 24).data;
      let r = 0, g = 0, b = 0, count = 0;
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        const rr = data[i];
        const gg = data[i + 1];
        const bb = data[i + 2];
        const max = Math.max(rr, gg, bb);
        const min = Math.min(rr, gg, bb);
        if (a < 140 || max < 24 || (max > 246 && max - min < 18)) continue;
        r += rr; g += gg; b += bb; count++;
      }
      if (!count) return;
      const rgb = `${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)}`;
      document.documentElement.style.setProperty('--b31-dynamic-rgb', rgb);
    } catch (_) {}
  };
  image.src = source;
}

function setB31BackgroundMode(mode, options = {}) {
  const safeMode = ['stored', 'solid', 'gradient', 'dynamic'].includes(mode) ? mode : 'stored';
  localStorage.setItem('glasstrackB31BackgroundMode', safeMode);
  document.body.classList.remove('b31-bg-solid', 'b31-bg-gradient', 'b31-bg-dynamic');

  if (safeMode === 'stored') {
    document.body.style.removeProperty('background');
    // Si el usuario ya tocó los ajustes avanzados, el fondo subido puede seguir
    // usando esos filtros; de lo contrario se conserva exactamente el comportamiento B30.
    if (localStorage.getItem('glasstrackB31BackgroundValues')) document.body.classList.add('b31-background-customized');
    else document.body.classList.remove('b31-background-customized');
    loadStoredBackground();
  } else {
    document.body.classList.add('b31-background-customized', `b31-bg-${safeMode}`);
    hideStoredBackgroundLayers();
    applyB31BackgroundVars();
    if (safeMode === 'dynamic') {
      const currentCover = songList[currentIndex]?.cover || cover?.src;
      if (currentCover) applyB31DynamicBackground(currentCover);
    }
  }

  if (options.silent !== true) playSFX('click');
}

(function restoreB31BackgroundValues() {
  try {
    const saved = JSON.parse(localStorage.getItem('glasstrackB31BackgroundValues') || 'null');
    if (saved) {
      if (inputBgSolidColor) inputBgSolidColor.value = validB31Hex(saved.solid, '#0a0a0f');
      if (inputBgGradientA) inputBgGradientA.value = validB31Hex(saved.gradientA, '#0a0a0f');
      if (inputBgGradientB) inputBgGradientB.value = validB31Hex(saved.gradientB, '#12131c');
      if (selectBgGradientDirection && ['135deg', '90deg', '0deg', '225deg'].includes(saved.direction)) selectBgGradientDirection.value = saved.direction;
      if (inputBgDarken) inputBgDarken.value = clampB31(saved.darken, 0, 80, 60);
      if (inputBgBlur) inputBgBlur.value = clampB31(saved.blur, 0, 30, 0);
      if (inputBgSaturation) inputBgSaturation.value = clampB31(saved.saturation, 50, 160, 100);
    }
  } catch (_) {}

  applyB31BackgroundVars();
  if (selectBgMode) selectBgMode.value = getB31BackgroundMode();

  const mode = getB31BackgroundMode();
  if (mode !== 'stored') setB31BackgroundMode(mode, { silent: true });
})();

if (selectBgMode) {
  selectBgMode.addEventListener('change', e => setB31BackgroundMode(e.target.value));
}

[ inputBgSolidColor, inputBgGradientA, inputBgGradientB, selectBgGradientDirection, inputBgDarken, inputBgBlur, inputBgSaturation ].forEach(el => {
  if (!el) return;
  const handle = () => {
    document.body.classList.add('b31-background-customized');
    applyB31BackgroundVars();
    saveB31BackgroundValues();
    const mode = getB31BackgroundMode();
    if (mode !== 'stored') setB31BackgroundMode(mode, { silent: true });
    else loadStoredBackground();
  };
  el.addEventListener('input', handle);
  el.addEventListener('change', handle);
});

// Subir imagen/video conserva el almacenamiento IndexedDB ya usado por B30, y
// solo cambia al modo "actual / subido" de forma explícita.
if (inputBgImage) {
  inputBgImage.addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (!file || !bgCustomImage || !bgVideo) return;
    localStorage.removeItem(BG_REMOVED_FLAG);
    localStorage.setItem('glasstrackB31BackgroundMode', 'stored');
    if (selectBgMode) selectBgMode.value = 'stored';
    bgCustomImage.style.backgroundImage = `url('${URL.createObjectURL(file)}')`;
    bgCustomImage.style.display = 'block';
    bgVideo.classList.add('bg-video-hidden');
    bgVideo.pause();
    saveBackgroundToDB('image', file);
  });
}

if (inputBgVideo) {
  inputBgVideo.addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (!file || !bgVideo || !bgCustomImage) return;
    localStorage.removeItem(BG_REMOVED_FLAG);
    localStorage.setItem('glasstrackB31BackgroundMode', 'stored');
    if (selectBgMode) selectBgMode.value = 'stored';
    bgVideo.src = URL.createObjectURL(file);
    bgVideo.classList.remove('bg-video-hidden');
    bgVideo.play().catch(() => {});
    bgCustomImage.style.display = 'none';
    saveBackgroundToDB('video', file);
  });
}

if (btnRemoveBg) {
  btnRemoveBg.addEventListener('click', () => {
    playSFX('click');
    // Marcar la eliminación ANTES de tocar IndexedDB evita que una lectura tardía
    // vuelva a restaurar el archivo anterior, incluso si la base aún está abriendo.
    localStorage.setItem(BG_REMOVED_FLAG, 'true');
    if (selectBgMode) selectBgMode.value = 'stored';
    if (typeof setB31BackgroundMode === 'function') setB31BackgroundMode('stored', { silent: true });
    hideStoredBackgroundLayers();
    if (db && db.objectStoreNames.contains('settings')) {
      try {
        const tx = db.transaction(['settings'], 'readwrite');
        tx.objectStore('settings').delete('background');
      } catch (error) { console.warn('No se pudo eliminar el fondo guardado:', error); }
    }
    showToast('Fondo eliminado. No se restaurará automáticamente.', 'success', 1800);
  });
}

// Guarda el fondo (imagen o video) en IndexedDB para que no se pierda al recargar.
function saveBackgroundToDB(type, file) {
  localStorage.removeItem(BG_REMOVED_FLAG);
  if (!db || !db.objectStoreNames.contains('settings')) return;
  try {
    const transaction = db.transaction(['settings'], 'readwrite');
    transaction.objectStore('settings').put({ key: 'background', type, blob: file });
  } catch (_) {}
}

function loadStoredBackground() {
  if (!db || !db.objectStoreNames.contains('settings')) return;
  if (getB31BackgroundMode() !== 'stored') return;

  if (localStorage.getItem(BG_REMOVED_FLAG) === 'true') {
    hideStoredBackgroundLayers();
    // Limpieza diferida si se pulsó Quitar Fondo antes de que IndexedDB estuviera lista.
    try { db.transaction(['settings'], 'readwrite').objectStore('settings').delete('background'); } catch (_) {}
    return;
  }

  const requestGeneration = ++storedBackgroundLoadGeneration;
  try {
    const transaction = db.transaction(['settings'], 'readonly');
    const request = transaction.objectStore('settings').get('background');
    request.onsuccess = () => {
      if (requestGeneration !== storedBackgroundLoadGeneration) return;
      if (getB31BackgroundMode() !== 'stored' || localStorage.getItem(BG_REMOVED_FLAG) === 'true') return;
      const entry = request.result;
      if (!entry || !entry.blob || !bgVideo || !bgCustomImage) return;
      const url = URL.createObjectURL(entry.blob);
      if (entry.type === 'video') {
        bgVideo.src = url;
        bgVideo.classList.remove('bg-video-hidden');
        bgVideo.play().catch(() => {});
        bgCustomImage.style.display = 'none';
      } else if (entry.type === 'image') {
        bgCustomImage.style.backgroundImage = `url('${url}')`;
        bgCustomImage.style.display = 'block';
        bgVideo.classList.add('bg-video-hidden');
      }
    };
  } catch (error) { console.warn('No se pudo restaurar el fondo guardado:', error); }
}

// -------------------------
// B31.3 — Personalizar reproductor
// -------------------------
const B31_PLAYER_HIDE_MAP = {
  topTools: 'b31-player-hide-top-tools',
  cover: 'b31-player-hide-cover',
  visualizer: 'b31-player-hide-visualizer',
  title: 'b31-player-hide-title',
  artist: 'b31-player-hide-artist',
  progress: 'b31-player-hide-progress',
  times: 'b31-player-hide-times',
  controls: 'b31-player-hide-controls',
  volume: 'b31-player-hide-volume'
};

function applyB31PlayerCustomization(persist = false) {
  Object.entries(B31_PLAYER_HIDE_MAP).forEach(([key, className]) => {
    const control = playerCustomControls[key];
    if (!control) return;
    document.body.classList.toggle(className, !control.checked);
  });

  if (playerCustomControls.visualizer && toggleAudioVisualizerForB31) {
    const enabled = !!playerCustomControls.visualizer.checked;
    toggleAudioVisualizerForB31.checked = enabled;
    const visualizerCanvasB31 = document.getElementById('player-visualizer');
    if (visualizerCanvasB31) visualizerCanvasB31.classList.toggle('hidden', !enabled);
    document.body.classList.toggle('b32-visualizer-user-enabled', enabled);
    if (persist) toggleAudioVisualizerForB31.dispatchEvent(new Event('change'));
  }

  const radius = clampB31(inputPlayerCoverRadius?.value, 0, 50, 50);
  const intensity = clampB31(inputPlayerCoverIntensity?.value, 0, 100, 100);
  const allowedAnimations = ['rotate', 'breathe', 'pulse', 'quick-pulse', 'gradient-pulse', 'none'];
  const animation = allowedAnimations.includes(selectPlayerCoverAnimation?.value)
    ? selectPlayerCoverAnimation.value
    : 'rotate';

  const i = intensity / 100;
  // Geometría: el contenedor y la imagen reciben la misma máscara. 50% = círculo.
  document.documentElement.style.setProperty('--b31-player-cover-radius', `${radius}%`);
  document.documentElement.style.setProperty('--b31-cover-intensity', (0.018 + i * 0.072).toFixed(4));
  document.documentElement.style.setProperty('--b31-cover-rotate-duration', `${(24 - i * 18).toFixed(2)}s`);
  document.documentElement.style.setProperty('--b31-cover-breathe-duration', `${(4.8 - i * 2.8).toFixed(2)}s`);
  document.documentElement.style.setProperty('--b31-cover-pulse-duration', `${(1.8 - i * 0.85).toFixed(2)}s`);
  document.documentElement.style.setProperty('--b31-cover-quick-duration', `${(1.05 - i * 0.45).toFixed(2)}s`);
  document.documentElement.style.setProperty('--b31-cover-gradient-duration', `${(1.75 - i * 0.65).toFixed(2)}s`);
  document.documentElement.style.setProperty('--b31-cover-pulse-scale', (1 + 0.025 + i * 0.105).toFixed(4));

  if (playerCoverRadiusVal) playerCoverRadiusVal.textContent = `${Math.round(radius)}%`;
  if (playerCoverIntensityVal) playerCoverIntensityVal.textContent = `${Math.round(intensity)}%`;

  document.body.classList.remove(
    'b31-player-cover-rotate', 'b31-player-cover-breathe', 'b31-player-cover-pulse',
    'b31-player-cover-quick-pulse', 'b31-player-cover-gradient-pulse', 'b31-player-cover-none'
  );
  document.body.classList.add(`b31-player-cover-${animation}`);

  const labelTarget = document.getElementById('b31-cover-intensity-label');
  if (labelTarget) {
    const labels = {
      rotate: 'Velocidad / intensidad del giro',
      breathe: 'Densidad del pulso suave',
      pulse: 'Intensidad del pulso',
      'quick-pulse': 'Intensidad del pulso rápido',
      'gradient-pulse': 'Intensidad del pulso gradiente',
      none: 'Intensidad'
    };
    labelTarget.textContent = labels[animation] || 'Intensidad de animación';
  }

  if (persist) {
    const data = {};
    Object.keys(playerCustomControls).forEach(key => { data[key] = !!playerCustomControls[key]?.checked; });
    data.radius = radius;
    data.intensity = intensity;
    data.animation = animation;
    localStorage.setItem('glasstrackB31PlayerCustomization', JSON.stringify(data));
  }
}
(function restoreB31PlayerCustomization() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('glasstrackB31PlayerCustomization') || 'null'); } catch (_) {}

  if (saved) {
    Object.keys(playerCustomControls).forEach(key => {
      if (playerCustomControls[key] && typeof saved[key] === 'boolean') playerCustomControls[key].checked = saved[key];
    });
    if (inputPlayerCoverRadius && Number.isFinite(Number(saved.radius))) inputPlayerCoverRadius.value = clampB31(saved.radius, 0, 50, 50);
    if (inputPlayerCoverIntensity && Number.isFinite(Number(saved.intensity))) inputPlayerCoverIntensity.value = clampB31(saved.intensity, 0, 100, 100);
    if (selectPlayerCoverAnimation && ['rotate', 'breathe', 'pulse', 'quick-pulse', 'gradient-pulse', 'none'].includes(saved.animation)) selectPlayerCoverAnimation.value = saved.animation;

    document.body.classList.add('b31-player-customized');
    applyB31PlayerCustomization(false);
    // El listener real del visualizador se registra después en script.js; el cambio
    // diferido permite que este estado inicial también lo despierte correctamente.
    if (playerCustomControls.visualizer && toggleAudioVisualizerForB31?.checked) {
      setTimeout(() => toggleAudioVisualizerForB31?.dispatchEvent(new Event('change')), 0);
    }
  } else {
    // El B30 actual deja el visualizador oculto. El nuevo control nace con ese mismo estado.
    if (playerCustomControls.visualizer && toggleAudioVisualizerForB31) {
      playerCustomControls.visualizer.checked = toggleAudioVisualizerForB31.checked;
    }
  }
})();

Object.values(playerCustomControls).forEach(control => {
  if (!control) return;
  control.addEventListener('change', () => {
    playSFX('click');
    document.body.classList.add('b31-player-customized');
    applyB31PlayerCustomization(true);
  });
});

[inputPlayerCoverRadius, inputPlayerCoverIntensity, selectPlayerCoverAnimation].forEach(el => {
  if (!el) return;
  const apply = () => {
    playSFX('click');
    document.body.classList.add('b31-player-customized');
    applyB31PlayerCustomization(true);
  };
  el.addEventListener('input', apply);
  el.addEventListener('change', apply);
});

// -------------------------
// Persistencia de controles que ya existían en B30
// -------------------------
document.querySelectorAll('.font-size-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    playSFX('click');
    document.querySelectorAll('.font-size-btn').forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    const size = e.currentTarget.dataset.fontsize;
    document.documentElement.style.setProperty('--font-base-size', size === 'small' ? '14px' : (size === 'large' ? '18px' : '16px'));
    localStorage.setItem('glasstrackFontSize', size);
  });
});


document.querySelectorAll('.size-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    playSFX('click');
    document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    const size = e.currentTarget.dataset.size;
    if (playlistEl) playlistEl.className = `playlist-view list-${size}`;
    localStorage.setItem('glasstrackPlaylistSize', size);
  });
});

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    playSFX('click');
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    const mode = e.currentTarget.dataset.mode === 'light' ? 'light' : 'dark';
    document.body.classList.toggle('light-mode', mode === 'light');
    localStorage.setItem('glasstrackInterfaceMode', mode);
  });
});


// Restauración segura sin tocar el resto de la personalización existente.
(function restoreB31ExistingThemeState() {
  const savedList = localStorage.getItem('glasstrackPlaylistSize');
  if (savedList && ['small', 'medium', 'large'].includes(savedList)) {
    const button = document.querySelector(`.size-btn[data-size="${savedList}"]`);
    if (button) {
      document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
      button.classList.add('active');
      if (playlistEl) playlistEl.className = `playlist-view list-${savedList}`;
    }
  }

  const savedFontSize = localStorage.getItem('glasstrackFontSize');
  if (savedFontSize && ['small', 'medium', 'large'].includes(savedFontSize)) {
    const button = document.querySelector(`.font-size-btn[data-fontsize="${savedFontSize}"]`);
    if (button) {
      document.querySelectorAll('.font-size-btn').forEach(b => b.classList.remove('active'));
      button.classList.add('active');
    }
    document.documentElement.style.setProperty('--font-base-size', savedFontSize === 'small' ? '14px' : (savedFontSize === 'large' ? '18px' : '16px'));
  }

  const savedMode = localStorage.getItem('glasstrackInterfaceMode');
  if (savedMode === 'light' || savedMode === 'dark') {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    const button = document.querySelector(`.mode-btn[data-mode="${savedMode}"]`);
    if (button) button.classList.add('active');
    document.body.classList.toggle('light-mode', savedMode === 'light');
  }
})();

// La tipografía avanzada de B32 la gestiona initB32Tanda2() con una capa CSS de mayor prioridad.
if (selectFont) {
  const legacyFont = localStorage.getItem('glasstrackFontFamily');
  if (legacyFont && !readProfileValue('glasstrackB32FontSettings', activeProfileId, null)) {
    selectFont.value = legacyFont;
  }
}

document.querySelectorAll('.hotkey-bind-btn').forEach(btn => {
  const action = btn.dataset.action;
  if (action && hotkeys[action]) btn.textContent = hotkeys[action];
  btn.addEventListener('click', (e) => {
    playSFX('click');
    recordingAction = e.currentTarget.dataset.action;
    e.currentTarget.textContent = 'Presiona una tecla…';
    e.currentTarget.classList.add('recording');
  });
});

window.addEventListener('keydown', (e) => {
  if (recordingAction) {
    e.preventDefault();
    e.stopPropagation();
    hotkeys[recordingAction] = e.code;
    const btn = document.querySelector(`.hotkey-bind-btn[data-action="${recordingAction}"]`);
    if (btn) { btn.textContent = e.code; btn.classList.remove('recording'); }
    try { localStorage.setItem('glasstrackHotkeys_b52', JSON.stringify(hotkeys)); } catch (_) {}
    recordingAction = null;
    return;
  }
  if (e.defaultPrevented || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
  const target = e.target;
  if (target && (target.isContentEditable || target.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]'))) return;

  if (e.code === hotkeys.playPause) { e.preventDefault(); if (playBtn) playBtn.click(); }
  else if (e.code === hotkeys.nextTrack) { e.preventDefault(); if (nextBtn) nextBtn.click(); }
  else if (e.code === hotkeys.prevTrack) { e.preventDefault(); if (prevBtn) prevBtn.click(); }
  else if (e.code === hotkeys.toggleFocus) { e.preventDefault(); if (btnFocusMode) btnFocusMode.click(); }
  else if (e.code === hotkeys.toggleMute) {
    e.preventDefault();
    if (externalMixerActive) { externalMixerMuted = !externalMixerMuted; applyExternalMixGains(); showToast(externalMixerMuted ? 'Mezcla externa silenciada.' : 'Mezcla externa con sonido.', 'info', 1500); }
    else if (activeAudio) activeAudio.muted = !activeAudio.muted;
  }
  else if (e.code === hotkeys.toggleCinema) {
    e.preventDefault();
    if (cinemaMode?.classList.contains('active')) { if (btnCloseCinema) btnCloseCinema.click(); }
    else if (btnCinemaMode) { if (modalSongMenu?.classList.contains('active')) closeModal(modalSongMenu); btnCinemaMode.click(); }
  }
  else if (e.code === hotkeys.toggleLyrics) { e.preventDefault(); if (btnLyricsToggle) btnLyricsToggle.click(); }
  else if (e.code === hotkeys.toggleKaraoke) {
    e.preventDefault();
    const karaoke = document.getElementById('karaoke-mode');
    if (karaoke?.classList.contains('active')) document.getElementById('btn-close-karaoke')?.click();
    else document.getElementById('btn-open-karaoke-main')?.click();
  }
  else if (e.code === hotkeys.toggleEQ) { e.preventDefault(); if (btnEqToggle) btnEqToggle.click(); }
  else if (e.code === hotkeys.toggleVM) { e.preventDefault(); if (btnVmToggle) btnVmToggle.click(); }
  else if (e.code === hotkeys.toggleShuffle) { e.preventDefault(); if (shuffleBtn) shuffleBtn.click(); }
});

// ==========================================
// 11. PROGRESO Y SINCRONIZACIÓN DE LETRAS — V29 ESTABLE
// ==========================================
[audio1, audio2].forEach(a => {
  a.addEventListener('timeupdate', () => {
    if (a !== activeAudio) return;
    const { duration, currentTime } = a;
    if (isNaN(duration)) return;

    if (!isSeekingMain) {
      if (progress) progress.style.width = `${(currentTime / duration) * 100}%`;
      if (currentTimeEl) currentTimeEl.textContent = formatTime(currentTime);
      if (durationEl) durationEl.textContent = formatTime(duration);
      if (cinemaProgress) cinemaProgress.style.width = `${(currentTime / duration) * 100}%`;
      if (cinemaCurrentTimeEl) cinemaCurrentTimeEl.textContent = formatTime(currentTime);
      if (cinemaDurationEl) cinemaDurationEl.textContent = formatTime(duration);
    }

    syncMiniPlayer();
    syncKaraokeMetadata();
    updateKaraokeProgress(currentTime, duration);

    if (!lyricsBody) return;
    const lines = lyricsBody.querySelectorAll('.lyrics-line');
    if (lines.length > 0) {
      const currentSong = songList[currentIndex] || {};
      const hasRealTimes = Array.isArray(currentSong.lrcLines) && currentSong.lrcLines.length > 0;
      // Un único reloj de calibración para LRC y letras sin marcas.
      const calib = currentSong.lyricsCalibration || { speed: 1, offset: 0 };
      const calibrationSpeed = Math.max(0.25, Math.min(4, Number(calib.speed) || 1));
      const adjustedTime = Math.max(0, (currentTime + (Number(calib.offset) || 0)) * calibrationSpeed);

      let lineIndex;
      if (hasRealTimes) {
        lineIndex = -1;
        for (let i = 0; i < currentSong.lrcLines.length; i++) {
          const t = currentSong.lrcLines[i].time;
          if (t !== null && t !== undefined && t <= adjustedTime) lineIndex = i;
          else if (t !== null && t !== undefined) break;
        }
        if (lineIndex === -1) lineIndex = 0;
        if (lineIndex > lines.length - 1) lineIndex = lines.length - 1;
      } else {
        lineIndex = Math.floor((adjustedTime / duration) * lines.length);
        if (lineIndex < 0) lineIndex = 0;
        if (lineIndex > lines.length - 1) lineIndex = lines.length - 1;
      }

      lines.forEach((l, idx) => l.classList.toggle('active', idx === lineIndex));

      if (lineIndex !== lastLyricsLineIndex && lines[lineIndex]) {
        lastLyricsLineIndex = lineIndex;
        if (!karaokeActive) autoScrollLyricsLine(lines[lineIndex]);
      }

      if (cinemaLyricsBody) {
        const cinemaLines = cinemaLyricsBody.querySelectorAll('.lyrics-line');
        cinemaLines.forEach((l, idx) => l.classList.toggle('active', idx === lineIndex));
        if (cinemaMode && cinemaMode.classList.contains('active') && lineIndex !== lastCinemaLyricsLineIndex && cinemaLines[lineIndex]) {
          lastCinemaLyricsLineIndex = lineIndex;
          autoScrollLyricsLine(cinemaLines[lineIndex]);
        }
      }

      const karaokeBodies = [karaokeLyricsSimpleBody, karaokeLyricsCoverBody].filter(Boolean);
      karaokeBodies.forEach((body) => {
        const karaokeLines = body.querySelectorAll('.karaoke-line');
        karaokeLines.forEach((line, idx) => {
          line.classList.toggle('active', idx === lineIndex);
          line.classList.toggle('karaoke-nearby', Math.abs(idx - lineIndex) === 1);
          line.classList.toggle('karaoke-hidden-context', !karaokeShowNeighbors && idx !== lineIndex);
          line.querySelectorAll('.karaoke-word').forEach(word => word.classList.remove('word-active'));
        });
        if (karaokeActive && karaokeLines[lineIndex]) {
          updateKaraokeWords(karaokeLines[lineIndex], lineIndex, adjustedTime, lines.length, duration);
          const isVisibleKaraokeBody = karaokeDisplayMode === 'cover'
            ? body === karaokeLyricsCoverBody
            : body === karaokeLyricsSimpleBody;
          const manualFollowResume = karaokeManualScrollUntil > 0 && Date.now() >= karaokeManualScrollUntil;
          if (isVisibleKaraokeBody && karaokeAutoFollowEnabled && (lineIndex !== karaokeLastLineIndex || manualFollowResume)) {
            if (manualFollowResume) {
              karaokeManualScrollUntil = 0;
              if (btnKaraokeFollow) btnKaraokeFollow.classList.add('hidden');
            }
            scrollKaraokeLineIntoView(body, karaokeLines[lineIndex]);
          }
        }
      });
      if (karaokeActive && karaokeProgressEl && !karaokeSeeking && duration > 0) {
        const ratio = Math.max(0, Math.min(1, currentTime / duration));
        karaokeProgressEl.value = String(Math.round(ratio * 1000));
        karaokeProgressEl.style.setProperty('--karaoke-progress', `${ratio * 100}%`);
      }
      karaokeLastLineIndex = lineIndex;
    }
  });
});

// Barra de progreso arrastrable: el relleno y el tiempo siguen al dedo/cursor en vivo,
// y la posición real del audio solo se actualiza al soltar (para no trabar la reproducción).
let isSeekingMain = false;

function makeSeekbarDraggable(container, fillEl, timeLabelEl) {
  if (!container || !fillEl) return;
  let dragging = false;

  function computeRatio(clientX) {
    const rect = container.getBoundingClientRect();
    let ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    if (ratio < 0) ratio = 0;
    if (ratio > 1) ratio = 1;
    return ratio;
  }

  function updateVisual(ratio) {
    fillEl.style.width = (ratio * 100) + '%';
    if (timeLabelEl && activeAudio.duration) {
      const t = ratio * activeAudio.duration;
      timeLabelEl.textContent = formatTime(t);
    }
  }

  function start(clientX) { dragging = true; isSeekingMain = true; updateVisual(computeRatio(clientX)); }
  function move(clientX) { if (dragging) updateVisual(computeRatio(clientX)); }
  function end(clientX) {
    if (!dragging) return;
    dragging = false;
    if (activeAudio.duration) activeAudio.currentTime = computeRatio(clientX) * activeAudio.duration;
    isSeekingMain = false;
  }

  container.addEventListener('mousedown', (e) => start(e.clientX));
  window.addEventListener('mousemove', (e) => move(e.clientX));
  window.addEventListener('mouseup', (e) => end(e.clientX));

  container.addEventListener('touchstart', (e) => start(e.touches[0].clientX), { passive: true });
  window.addEventListener('touchmove', (e) => move(e.touches[0].clientX), { passive: true });
  window.addEventListener('touchend', (e) => end(e.changedTouches[0].clientX));
}

makeSeekbarDraggable(progressContainer, progress, currentTimeEl);
makeSeekbarDraggable(cinemaProgressContainer, cinemaProgress, cinemaCurrentTimeEl);

// =========================================================
// B43 — BARRA SERPIENTE: audio-reactiva y transición de pausa
// Se dibuja encima de la barra de progreso existente para conservar el seek.
// =========================================================
(function setupSnakeProgress() {
  const toggle = document.getElementById('toggle-snake-progress');
  const canvas = document.getElementById('snake-progress-canvas');
  const layer = document.getElementById('snake-progress-layer');
  const card = document.getElementById('player-card');
  const container = document.getElementById('progress-container');
  if (!toggle || !canvas || !layer || !card || !container) return;

  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;
  const STORAGE_KEY = 'glasstrack_snake_progress_enabled_v1';
  let rafId = 0;
  let lastTimestamp = 0;
  let phase = 0;
  let amplitude = 0;
  let smoothEnergy = 0;
  let lastWidth = 0;
  let lastHeight = 0;
  let waveformData = new Uint8Array(64);

  try { toggle.checked = localStorage.getItem(STORAGE_KEY) === 'true'; } catch (_) { toggle.checked = false; }

  function setEnabled(enabled) {
    const on = !!enabled;
    card.classList.toggle('snake-progress-enabled', on);
    container.classList.toggle('snake-progress-enabled', on);
    layer.setAttribute('aria-hidden', on ? 'false' : 'true');
    if (on) start();
    else stop();
  }

  function canvasSize() {
    const rect = container.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    // Keep a narrow track; the expanded CSS height gives room for the small waves.
    const height = Math.max(18, Math.round(rect.height));
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    if (width !== lastWidth || height !== lastHeight || canvas.width !== Math.round(width*dpr) || canvas.height !== Math.round(height*dpr)) {
      lastWidth = width; lastHeight = height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return { width, height };
  }

  function readAudioEnergy() {
    if (!activeAudio || activeAudio.paused || activeAudio.ended) return 0;
    let energy = 0;
    try {
      if (concludorAnalyser && typeof concludorAnalyser.getByteTimeDomainData === 'function') {
        const fftSize = Number(concludorAnalyser.fftSize) || 64;
        if (waveformData.length !== fftSize) waveformData = new Uint8Array(fftSize);
        const data = waveformData;
        concludorAnalyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        energy = Math.sqrt(sum / Math.max(1, data.length));
      }
    } catch (_) { energy = 0; }
    // Even before AudioContext starts, keep a subtle moving wave while audio plays.
    if (!Number.isFinite(energy)) energy = 0;
    return Math.max(0, Math.min(1, energy * 2.8));
  }

  function draw(timestamp) {
    rafId = 0;
    if (!toggle.checked) return;
    const { width, height } = canvasSize();
    const dt = lastTimestamp ? Math.min(48, timestamp - lastTimestamp) : 16;
    lastTimestamp = timestamp;
    const playing = !!(activeAudio && !activeAudio.paused && !activeAudio.ended);
    const energy = playing ? readAudioEnergy() : 0;
    smoothEnergy += (energy - smoothEnergy) * (playing ? 0.22 : 0.08);
    const targetAmplitude = playing ? (1.0 + smoothEnergy * Math.min(5.5, height * 0.25)) : 0;
    // On pause the wave eases back to a flat line instead of snapping.
    const easing = 1 - Math.exp(-dt / (playing ? 90 : 260));
    amplitude += (targetAmplitude - amplitude) * easing;
    phase += dt * (playing ? 0.0065 : 0.0025);

    ctx.clearRect(0, 0, width, height);
    const centerY = height / 2;
    const points = Math.max(48, Math.round(width / 3));
    const period = Math.max(26, width / Math.max(5, width / 34));
    const wave = [];
    for (let i = 0; i <= points; i++) {
      const x = (i / points) * width;
      const t = x / period;
      const y = centerY + Math.sin(t * Math.PI * 2 + phase) * amplitude
        + Math.sin(t * Math.PI * 4 - phase * 0.55) * amplitude * 0.22;
      wave.push([x, y]);
    }

    // Single wavy track: no straight grey progress line underneath the snake.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    wave.forEach(([x,y], i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
    ctx.strokeStyle = 'rgba(210, 216, 226, 0.27)';
    ctx.lineWidth = 2.25;
    ctx.stroke();

    let ratio = 0;
    if (activeAudio && Number.isFinite(activeAudio.duration) && activeAudio.duration > 0) {
      ratio = Math.max(0, Math.min(1, activeAudio.currentTime / activeAudio.duration));
    }
    const progressX = ratio * width;
    ctx.beginPath();
    wave.forEach(([x,y], i) => {
      if (x > progressX) return;
      if (i === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim() || '#d69a7b';
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.65;
    ctx.shadowColor = accent;
    ctx.shadowBlur = playing ? 2.5 : 0;
    ctx.stroke();
    ctx.shadowBlur = 0;

    const markerIndex = Math.max(0, Math.min(points, Math.round(ratio * points)));
    const markerY = wave[markerIndex][1];
    ctx.beginPath();
    ctx.arc(progressX, markerY, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.7)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // Keep animating while active so the pause-to-line transition completes smoothly.
    if (toggle.checked && (playing || amplitude > 0.08)) {
      rafId = requestAnimationFrame(draw);
    }
  }

  function start() {
    if (rafId) return;
    lastTimestamp = 0;
    rafId = requestAnimationFrame(draw);
  }
  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    lastTimestamp = 0;
    amplitude = 0;
    smoothEnergy = 0;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  toggle.addEventListener('change', () => {
    try { localStorage.setItem(STORAGE_KEY, toggle.checked ? 'true' : 'false'); } catch (_) {}
    setEnabled(toggle.checked);
  });
  window.addEventListener('resize', () => { if (toggle.checked) start(); }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (rafId) cancelAnimationFrame(rafId); rafId = 0; }
    else if (toggle.checked) start();
  });
  [audio1, audio2].forEach(audio => {
    ['play','pause','ended','loadedmetadata','timeupdate','seeked'].forEach(type => {
      audio.addEventListener(type, () => { if (toggle.checked && !rafId) start(); }, { passive: true });
    });
  });
  setEnabled(toggle.checked);
})();

// B44 BUGFIX: evitar que el navegador interprete el arrastre del slider como
// una operación de arrastrar elementos, sin bloquear los eventos nativos de range.
function syncCinemaVolumeFill() {
  if (!cinemaVolumeSlider) return;
  const value = Math.max(0, Math.min(1, Number(cinemaVolumeSlider.value) || 0));
  cinemaVolumeSlider.style.setProperty('--volume-progress', `${(value * 100).toFixed(2)}%`);
  cinemaVolumeSlider.setAttribute('aria-valuetext', `${Math.round(value * 100)}%`);
}

// B66: protección de rangos nativos (velocidad, calibración, EQ y posibles controles Pitch).
// Detener la propagación no cancela el valor nativo del slider; evita que el gestor de arrastre
// de la página lo interprete como arrastre de archivos y muestre el cursor de bloqueo.
function protectNativeRangeDragging(slider) {
  if (!slider || slider.dataset.gspRangeDragProtected === '1') return;
  slider.dataset.gspRangeDragProtected = '1';
  slider.draggable = false;
  slider.style.webkitUserDrag = 'none';
  slider.addEventListener('dragstart', event => { event.preventDefault(); event.stopPropagation(); });
  slider.addEventListener('pointerdown', event => { if (event.button === 0) event.stopPropagation(); }, { passive: true });
  slider.addEventListener('mousedown', event => { if (event.button === 0) event.stopPropagation(); });
  slider.addEventListener('selectstart', event => event.preventDefault());
}
document.querySelectorAll('input[type="range"]').forEach(protectNativeRangeDragging);
// También protege controles de rango que algunos paneles crean bajo demanda (por ejemplo, Pitch/calibración).
// El observador solo procesa nodos nuevos y no interviene en los valores ni en el evento input nativo.
if (typeof MutationObserver !== 'undefined') {
  const nativeRangeDragObserver = new MutationObserver(records => {
    records.forEach(record => record.addedNodes.forEach(node => {
      if (!(node instanceof Element)) return;
      if (node instanceof HTMLInputElement && node.type === 'range') protectNativeRangeDragging(node);
      node.querySelectorAll?.('input[type="range"]').forEach(protectNativeRangeDragging);
    }));
  });
  nativeRangeDragObserver.observe(document.documentElement, { childList: true, subtree: true });
}
[volumeSlider, cinemaVolumeSlider].filter(Boolean).forEach((slider) => {
  slider.draggable = false;
  slider.style.webkitUserDrag = 'none';
  slider.addEventListener('dragstart', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  slider.addEventListener('selectstart', (event) => event.preventDefault());
  slider.addEventListener('pointerdown', (event) => {
    if (event.button === 0) event.stopPropagation();
  }, { passive: true });
  slider.addEventListener('mousedown', (event) => {
    if (event.button === 0) event.stopPropagation();
  });
});

if (volumeSlider) {
  volumeSlider.addEventListener('input', (e) => {
    if (karaokeVolumeEl && karaokeVolumeEl.value !== e.target.value) karaokeVolumeEl.value = e.target.value;
    if (cinemaVolumeSlider && cinemaVolumeSlider.value !== e.target.value) cinemaVolumeSlider.value = e.target.value;
    syncCinemaVolumeFill();
    if (externalMixerActive) applyExternalMixGains();
    else activeAudio.volume = e.target.value;
  });
}
if (cinemaVolumeSlider && volumeSlider) {
  cinemaVolumeSlider.value = volumeSlider.value;
  syncCinemaVolumeFill();
  cinemaVolumeSlider.addEventListener('input', () => {
    syncCinemaVolumeFill();
    volumeSlider.value = cinemaVolumeSlider.value;
    volumeSlider.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

if (btnLyricsToggle) btnLyricsToggle.addEventListener('click', () => { playSFX('open'); lyricsPanel.classList.add('active'); });
if (btnCloseLyrics) btnCloseLyrics.addEventListener('click', () => { playSFX('close'); lyricsPanel.classList.remove('active'); });

function setCinemaExclusiveUI(enabled) {
  const active = !!enabled;
  const body = document.body;
  const cinema = cinemaMode || document.getElementById('cinema-mode');
  if (!body || !cinema) return;

  body.classList.toggle('cinema-exclusive-active', active);
  if (!active) body.classList.remove('cinema-modal-open');
  cinema.setAttribute('aria-hidden', active ? 'false' : 'true');
  // El propio contenedor se saca del árbol interactivo al cerrar Cine.
  // Algunos estilos antiguos fuerzan pointer-events:auto en botones internos;
  // inert impide que esos descendientes reciban clics o foco aunque el overlay
  // siga montado para conservar la transición visual.
  cinema.inert = !active;

  // Guarda y restaura el estado previo de cada hermano de body. Así, aunque
  // Cine se cierre desde otro flujo, la lista no queda inertada.
  Array.from(body.children).forEach((element) => {
    if (element === cinema || element.classList.contains('modal-overlay')) return;
    if (active) {
      if (!element.hasAttribute('data-cinema-inert-previous')) {
        element.setAttribute('data-cinema-inert-previous', element.inert ? '1' : '0');
      }
      element.inert = true;
    } else if (element.hasAttribute('data-cinema-inert-previous')) {
      element.inert = element.getAttribute('data-cinema-inert-previous') === '1';
      element.removeAttribute('data-cinema-inert-previous');
    }
  });

  // Suprime temporalmente tooltips nativos de botones que quedan detrás de Cine.
  // Se guardan para devolverlos intactos al salir; evita el texto fantasma "Anterior".
  if (active) {
    body.querySelectorAll('[title]').forEach((element) => {
      if (cinema.contains(element)) return;
      if (!element.hasAttribute('data-cinema-original-title')) {
        element.setAttribute('data-cinema-original-title', element.getAttribute('title') || '');
      }
      element.removeAttribute('title');
    });
    const topMenu = document.getElementById('top-experiences-menu');
    const quickMenu = document.getElementById('mobile-quick-menu');
    if (topMenu) {
      topMenu.classList.add('hidden');
      topMenu.setAttribute('aria-hidden', 'true');
      topMenu.setAttribute('aria-expanded', 'false');
    }
    if (quickMenu) {
      quickMenu.classList.remove('active');
      quickMenu.setAttribute('aria-hidden', 'true');
    }
  } else {
    body.querySelectorAll('[data-cinema-original-title]').forEach((element) => {
      element.setAttribute('title', element.getAttribute('data-cinema-original-title') || '');
      element.removeAttribute('data-cinema-original-title');
    });
  }
}

// Fail-safe on boot: a closed cinema overlay must never intercept keyboard focus
// or pointer events, even before the first open/close cycle.
if (cinemaMode && !cinemaMode.classList.contains('active')) {
  cinemaMode.inert = true;
  cinemaMode.setAttribute('aria-hidden', 'true');
}

if (btnCinemaMode) {
  btnCinemaMode.addEventListener('click', () => {
    playSFX('open');
    if (karaokeActive && typeof closeKaraokeMode === 'function') closeKaraokeMode();
    if (songList.length === 0) return;
    syncCinemaPlayControl();
    if (!karaokeActive && cinemaMode) cinemaMode.classList.remove('karaoke-layout');
    if (cinemaMode) {
      cinemaMode.classList.add('active');
      setCinemaExclusiveUI(true);
    }
  });
}
if (btnCloseCinema) btnCloseCinema.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  playSFX('close');
  // No dejar el menú de canción flotando al cerrar Cine con Q o con la X.
  if (modalSongMenu?.classList.contains('active')) closeModal(modalSongMenu);
  if (modalSongMetadata?.classList.contains('active')) closeModal(modalSongMetadata);
  if (modalSongMetadataEdit?.classList.contains('active')) closeModal(modalSongMetadataEdit);
  if (cinemaMode) cinemaMode.classList.remove('active');
  setCinemaExclusiveUI(false);
  document.body.classList.remove('mobile-lyrics-exclusive-active');
});
if (cinemaPrev) cinemaPrev.addEventListener('click', () => { if (prevBtn) prevBtn.click(); });
if (cinemaPlay) cinemaPlay.addEventListener('click', () => { if (playBtn) playBtn.click(); });
if (cinemaNext) cinemaNext.addEventListener('click', () => { if (nextBtn) nextBtn.click(); });
if (cinemaSongMenuBtn) cinemaSongMenuBtn.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (!event.currentTarget || event.currentTarget.id !== 'btn-cinema-song-menu') return;
  playSFX('open');
  const currentSong = songList[currentIndex];
  if (!currentSong) return;
  // Solo una pulsación explícita en los tres puntos puede abrir el menú compartido.
  openSongMenu(currentSong);
});

if (btnCalibrateLyrics) {
  btnCalibrateLyrics.addEventListener('click', () => {
    playSFX('open');
    if (songList.length === 0) return;
    const song = songList[currentIndex];
    const calib = song.lyricsCalibration || { scale: 100, speed: 1, offset: 0 };
    pendingCalibration = { scale: calib.scale || 100, speed: calib.speed || 1, offset: calib.offset || 0 };
    pendingBpm = song.bpm || null;

    if (calibrateScale) calibrateScale.value = pendingCalibration.scale;
    if (calibrateScaleValue) calibrateScaleValue.textContent = pendingCalibration.scale + '%';
    if (calibrateSpeed) calibrateSpeed.value = pendingCalibration.speed;
    if (calibrateSpeedValue) calibrateSpeedValue.textContent = pendingCalibration.speed.toFixed(2) + 'x';
    if (calibrateOffsetValue) calibrateOffsetValue.textContent = pendingCalibration.offset.toFixed(1) + 's';
    if (inputBpm) inputBpm.value = pendingBpm ? Math.round(pendingBpm) : '';

    openModal(modalCalibrateLyrics);
  });
}

if (btnCloseCalibrate) btnCloseCalibrate.addEventListener('click', () => { playSFX('close'); closeModal(modalCalibrateLyrics); });

if (calibrateScale) {
  calibrateScale.addEventListener('input', (e) => {
    pendingCalibration.scale = parseInt(e.target.value, 10);
    if (calibrateScaleValue) calibrateScaleValue.textContent = pendingCalibration.scale + '%';
    document.documentElement.style.setProperty('--lyrics-scale', pendingCalibration.scale / 100);
  });
}

if (calibrateSpeed) {
  calibrateSpeed.addEventListener('input', (e) => {
    pendingCalibration.speed = parseFloat(e.target.value);
    if (calibrateSpeedValue) calibrateSpeedValue.textContent = pendingCalibration.speed.toFixed(2) + 'x';
  });
}

if (calibrateOffsetBack) {
  calibrateOffsetBack.addEventListener('click', () => {
    playSFX('click');
    pendingCalibration.offset = Math.max(-30, Math.round((pendingCalibration.offset - 0.5) * 10) / 10);
    if (calibrateOffsetValue) calibrateOffsetValue.textContent = pendingCalibration.offset.toFixed(1) + 's';
  });
}

if (calibrateOffsetForward) {
  calibrateOffsetForward.addEventListener('click', () => {
    playSFX('click');
    pendingCalibration.offset = Math.min(30, Math.round((pendingCalibration.offset + 0.5) * 10) / 10);
    if (calibrateOffsetValue) calibrateOffsetValue.textContent = pendingCalibration.offset.toFixed(1) + 's';
  });
}

// El BPM real de la canción ajusta automáticamente la velocidad de la letra
// (tomando 120 BPM como referencia "normal" = velocidad 1.00x)
if (inputBpm) {
  inputBpm.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    if (!val || val <= 0) { pendingBpm = null; return; }
    pendingBpm = val;
    let autoSpeed = val / 120;
    if (autoSpeed < 0.5) autoSpeed = 0.5;
    if (autoSpeed > 2) autoSpeed = 2;
    autoSpeed = Math.round(autoSpeed * 20) / 20; // redondeado al escalón del slider (0.05)
    pendingCalibration.speed = autoSpeed;
    if (calibrateSpeed) calibrateSpeed.value = autoSpeed;
    if (calibrateSpeedValue) calibrateSpeedValue.textContent = autoSpeed.toFixed(2) + 'x';
  });
}

if (btnResetBpm) {
  btnResetBpm.addEventListener('click', () => {
    playSFX('click');
    pendingBpm = null;
    if (inputBpm) inputBpm.value = '';
    pendingCalibration.speed = 1;
    if (calibrateSpeed) calibrateSpeed.value = 1;
    if (calibrateSpeedValue) calibrateSpeedValue.textContent = '1.00x';
  });
}

if (btnSaveCalibration) {
  btnSaveCalibration.addEventListener('click', () => {
    playSFX('click');
    if (songList.length === 0) { closeModal(modalCalibrateLyrics); return; }
    const song = songList[currentIndex];
    song.lyricsCalibration = { scale: pendingCalibration.scale, speed: pendingCalibration.speed, offset: pendingCalibration.offset };
    if (pendingBpm) song.bpm = Math.round(pendingBpm);
    else delete song.bpm;
    updateSongInDB(song);
    closeModal(modalCalibrateLyrics);
  });
}

function applyLyricsCalibration(song) {
  const calib = (song && song.lyricsCalibration) || { scale: 100, speed: 1, offset: 0 };
  document.documentElement.style.setProperty('--lyrics-scale', (calib.scale || 100) / 100);
}

function isDecoratedLyricsEnabled() {
  return !!toggleDecoratedLyrics?.checked;
}

function normalizeDecoratedCharacter(char) {
  return char.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function appendDecoratedCharacter(container, char) {
  const normalized = normalizeDecoratedCharacter(char);

  if (char === ' ') {
    const space = document.createElement('span');
    space.className = 'decorated-space';
    space.setAttribute('aria-hidden', 'true');
    container.appendChild(space);
    return;
  }

  const isLetter = /^[a-z]$/.test(normalized);
  const isNumber = /^[0-9]$/.test(normalized);

  if (isLetter || isNumber) {
    const img = document.createElement('img');
    img.className = `decorated-char ${isNumber ? 'decorated-number' : 'decorated-letter'}`;
    const variant = isNumber ? 1 : Math.floor(Math.random() * 3) + 1;
    img.src = `img/letras/${normalized}_${variant}.png`;
    img.alt = char;
    img.draggable = false;
    img.loading = 'lazy';
    img.onerror = function () { this.style.display = 'none'; };
    container.appendChild(img);
    return;
  }

  const fallback = document.createElement('span');
  fallback.className = 'decorated-fallback';
  fallback.textContent = char;
  container.appendChild(fallback);
}

function createDecoratedWordElement(word) {
  const wordSpan = document.createElement('span');
  wordSpan.className = 'karaoke-word decorated-word';
  const wrapper = document.createElement('span');
  wrapper.className = 'decorated-lyrics-wrapper';
  for (const char of word) appendDecoratedCharacter(wrapper, char);
  wordSpan.appendChild(wrapper);
  return wordSpan;
}

function getCinemaFirstWordTime(song = songList[currentIndex] || {}) {
  const timed = Array.isArray(song.lrcLines)
    ? song.lrcLines.find(line => line && line.time !== null && line.time !== undefined && Number(line.time) > 0)
    : null;
  return timed ? Math.max(0, Number(timed.time)) : 0;
}

function displayLyrics(text) {
  if (!lyricsBody) return;
  lastLyricsLineIndex = -1;
  lastCinemaLyricsLineIndex = -1;
  lyricsBody.innerHTML = '';
  if (cinemaLyricsBody) cinemaLyricsBody.innerHTML = '';

  const source = String(text || '');
  renderKaraokeLyrics(source);
  if (!source.trim()) {
    const placeholder = document.createElement('p');
    placeholder.className = 'lyrics-placeholder';
    placeholder.textContent = 'Sin letra disponible.';
    lyricsBody.appendChild(placeholder);
    if (cinemaLyricsBody) cinemaLyricsBody.appendChild(placeholder.cloneNode(true));
    return;
  }

  source.split('\n').forEach(line => {
    const originalLine = line || '';
    const p = document.createElement('p');
    p.className = 'lyrics-line';
    p.textContent = originalLine;
    lyricsBody.appendChild(p);

    if (cinemaLyricsBody) {
      const p2 = document.createElement('p');
      p2.className = 'lyrics-line';
      if (isDecoratedLyricsEnabled()) {
        const parts = originalLine.split(/(\s+)/);
        parts.forEach(part => {
          if (!part) return;
          if (/^\s+$/.test(part)) {
            for (const char of part) appendDecoratedCharacter(p2, char);
          } else {
            p2.appendChild(createDecoratedWordElement(part));
          }
        });
      } else {
        const words = originalLine.split(' ');
        words.forEach((word, i) => {
          const span = document.createElement('span');
          span.className = 'karaoke-word';
          span.textContent = word + (i < words.length - 1 ? ' ' : '');
          p2.appendChild(span);
        });
      }
      cinemaLyricsBody.appendChild(p2);
    }
  });
}

if (btnEditLyrics) {
  btnEditLyrics.addEventListener('click', () => {
    playSFX('click');
    if (songList.length === 0) return;
    if (lyricsTextarea) lyricsTextarea.value = songList[currentIndex].lyrics;
    if (lyricsBody) lyricsBody.classList.add('hidden');
    if (lyricsEditor) lyricsEditor.classList.remove('hidden');
  });
}

if (btnSaveLyrics) {
  btnSaveLyrics.addEventListener('click', () => {
    playSFX('click');
    if (songList.length === 0) return;
    const rawText = lyricsTextarea ? lyricsTextarea.value : "";
    const song = songList[currentIndex];
    // Si lo que se pegó ya trae marcas de tiempo tipo [mm:ss.xx], las usamos de una.
    // Si no, limpiamos cualquier tiempo viejo (de una edición anterior) para que no
    // quede desincronizado con el texto nuevo — eso era lo que "congelaba" la letra.
    if (/\[\d{2}:\d{2}[.:]\d{2,3}\]/.test(rawText)) {
      const parsed = parseLrcText(rawText);
      song.lyrics = parsed.map(l => l.text).join('\n');
      song.lrcLines = parsed;
    } else {
      song.lyrics = rawText;
      delete song.lrcLines;
    }
    updateSongInDB(song);
    displayLyrics(song.lyrics);
    if (lyricsEditor) lyricsEditor.classList.add('hidden');
    if (lyricsBody) lyricsBody.classList.remove('hidden');
  });
}

if (btnClearLyrics) {
  btnClearLyrics.addEventListener('click', () => {
    playSFX('click');
    if (songList.length === 0) return;
    if (!confirm('¿Seguro que vas a borrar las letras?')) return;
    const song = songList[currentIndex];
    song.lyrics = '';
    delete song.lrcLines;
    updateSongInDB(song);
    displayLyrics('');
    if (lyricsTextarea) lyricsTextarea.value = '';
  });
}
// ==========================================
// MODO VEHÍCULO
// ==========================================
function syncVehicleMode() {
  if (!vehicleMode || !vehicleMode.classList.contains('active')) return;
  const song = songList[currentIndex];
  if (!song) return;
  if (vehicleCover) vehicleCover.src = song.cover;
  if (vehicleTitle) vehicleTitle.textContent = song.title;
  if (vehicleArtist) vehicleArtist.textContent = song.artist;
  if (vehicleBg) vehicleBg.style.backgroundImage = `url(${song.cover})`;
  if (vehiclePlayIcon && playIcon) vehiclePlayIcon.innerHTML = playIcon.innerHTML;
}

if (btnVehicleMode) {
  btnVehicleMode.addEventListener('click', () => {
    playSFX('open');
    if (songList.length === 0) return;
    if (vehicleMode) vehicleMode.classList.add('active');
    syncVehicleMode();
  syncMobileNowPlaying();
  });
}
if (btnExitVehicle) {
  btnExitVehicle.addEventListener('click', () => { playSFX('close'); vehicleMode.classList.remove('active'); });
}
const vehiclePrevBtn = document.getElementById('vehicle-prev');
const vehiclePlayBtn = document.getElementById('vehicle-play');
const vehicleNextBtn = document.getElementById('vehicle-next');
if (vehiclePrevBtn) vehiclePrevBtn.addEventListener('click', () => prevBtn.click());
if (vehiclePlayBtn) vehiclePlayBtn.addEventListener('click', () => playBtn.click());
if (vehicleNextBtn) vehicleNextBtn.addEventListener('click', () => nextBtn.click());

// ==========================================
// MODO KARAOKE INDEPENDIENTE — comparte audio/datos, no la ventana del Cine
// ==========================================
let karaokeActive = false;
let karaokeSeeking = false;
let karaokeLastLineIndex = -1;
let karaokeManualScrollUntil = 0;
let karaokeAutoFollowEnabled = localStorage.getItem('glasstrackKaraokeAutoFollow') !== 'false';
let karaokeShowNeighbors = localStorage.getItem('glasstrackKaraokeShowNeighbors') !== 'false';
let karaokeDuetEnabled = localStorage.getItem('glasstrackKaraokeDuetEnabled') === 'true';
let karaokeDuetNameA = localStorage.getItem('glasstrackKaraokeDuetNameA') || 'Voz A';
let karaokeDuetNameB = localStorage.getItem('glasstrackKaraokeDuetNameB') || 'Voz B';
let karaokeDuetColorA = localStorage.getItem('glasstrackKaraokeDuetColorA') || '#f2c94c';
let karaokeDuetColorB = localStorage.getItem('glasstrackKaraokeDuetColorB') || '#8bb8ff';
let karaokeDisplayMode = localStorage.getItem('glasstrackKaraokeDisplayMode') === 'cover' ? 'cover' : 'simple';
let karaokeFontSize = Math.max(24, Math.min(76, Number(localStorage.getItem('glasstrackKaraokeFontSize')) || 44));

const karaokeSettingDisplayMode = document.getElementById('karaoke-display-mode');
const karaokeSettingFontSize = document.getElementById('karaoke-font-size');
const karaokeSettingFontSizeLabel = document.getElementById('karaoke-font-size-label');
const karaokeSettingNeighbors = document.getElementById('karaoke-show-neighbors');
const karaokeSettingAutoFollow = document.getElementById('karaoke-follow-enabled');
const karaokeSettingDuet = document.getElementById('karaoke-duet-enabled');
const karaokeDuetOptions = document.getElementById('karaoke-duet-options');
const karaokeDuetNameAInput = document.getElementById('karaoke-duet-name-a');
const karaokeDuetNameBInput = document.getElementById('karaoke-duet-name-b');
const karaokeDuetColorAInput = document.getElementById('karaoke-duet-color-a');
const karaokeDuetColorBInput = document.getElementById('karaoke-duet-color-b');
const btnKaraokePlay = document.getElementById('karaoke-play');
const btnKaraokePrev = document.getElementById('karaoke-prev');
const btnKaraokeNext = document.getElementById('karaoke-next');
const btnCloseKaraoke = document.getElementById('btn-close-karaoke');
const btnKaraokeSettings = document.getElementById('btn-karaoke-settings');
const btnKaraokeSettingsOpen = document.getElementById('btn-karaoke-settings-open');
const btnCloseKaraokeSettings = document.getElementById('btn-close-karaoke-settings');
const btnSaveKaraokeSettings = document.getElementById('btn-save-karaoke-settings');
const btnKaraokeFollow = document.getElementById('btn-karaoke-follow');
const karaokeLyricsScrollBodies = [karaokeLyricsSimpleBody, karaokeLyricsCoverBody].filter(Boolean);

function normalizeKaraokeLineForDuet(rawLine) {
  let text = String(rawLine ?? '');
  let voice = '';
  if (karaokeDuetEnabled) {
    const matchA = text.match(/^\s*(?:\[A\]|A:)\s*/i);
    const matchB = text.match(/^\s*(?:\[B\]|B:)\s*/i);
    if (matchA) { voice = 'a'; text = text.slice(matchA[0].length); }
    else if (matchB) { voice = 'b'; text = text.slice(matchB[0].length); }
  }
  return { text, voice };
}

function makeKaraokeLine(rawLine, lineIndex) {
  const p = document.createElement('p');
  p.className = 'lyrics-line karaoke-line';
  p.dataset.karaokeLineIndex = String(lineIndex);
  const parsed = normalizeKaraokeLineForDuet(rawLine);
  if (parsed.voice) {
    p.classList.add(`karaoke-duet-${parsed.voice}`);
    p.dataset.duetLabel = parsed.voice === 'a' ? karaokeDuetNameA : karaokeDuetNameB;
  }
  const parts = String(parsed.text || '').match(/\s+|[^\s]+/g) || [];
  let wordIndex = 0;
  parts.forEach((part) => {
    if (/^\s+$/.test(part)) {
      p.appendChild(document.createTextNode(part));
      return;
    }
    const word = document.createElement('span');
    word.className = 'karaoke-word';
    word.dataset.karaokeWordIndex = String(wordIndex++);
    word.textContent = part;
    p.appendChild(word);
  });
  if (!parts.length) p.textContent = '\u00a0';
  return p;
}

function renderKaraokeLyrics(text) {
  const source = String(text || '');
  karaokeLyricsScrollBodies.forEach((body) => {
    if (!body) return;
    body.innerHTML = '';
    if (!source.trim()) {
      const placeholder = document.createElement('p');
      placeholder.className = 'lyrics-placeholder karaoke-placeholder';
      placeholder.textContent = 'Aún no has agregado letras para esta canción.';
      body.appendChild(placeholder);
      return;
    }
    source.split('\n').forEach((line, index) => body.appendChild(makeKaraokeLine(line, index)));
  });
  karaokeLastLineIndex = -1;
  applyKaraokeSettingsToUI();
}

function syncKaraokeMetadata() {
  if (!karaokeModeEl) return;
  const song = songList[currentIndex];
  const safeTitle = song?.title || 'Sin canción cargada';
  const safeArtist = song?.artist || 'Selecciona una canción para comenzar';
  if (karaokeTitleEl && karaokeTitleEl.textContent !== safeTitle) karaokeTitleEl.textContent = safeTitle;
  if (karaokeArtistEl && karaokeArtistEl.textContent !== safeArtist) karaokeArtistEl.textContent = safeArtist;
  if (karaokeCoverTitleEl && karaokeCoverTitleEl.textContent !== safeTitle) karaokeCoverTitleEl.textContent = safeTitle;
  if (karaokeCoverArtistEl && karaokeCoverArtistEl.textContent !== safeArtist) karaokeCoverArtistEl.textContent = safeArtist;
  if (karaokeCoverEl && song?.cover && karaokeCoverEl.getAttribute('src') !== song.cover) karaokeCoverEl.src = song.cover;
  if (karaokeVolumeEl && volumeSlider && karaokeVolumeEl.value !== volumeSlider.value) karaokeVolumeEl.value = volumeSlider.value;
}

function syncKaraokePlayControl(forcePlaying) {
  if (!karaokePlayIconEl) return;
  const isPlaying = typeof forcePlaying === 'boolean' ? forcePlaying : !!(activeAudio && !activeAudio.paused);
  karaokePlayIconEl.innerHTML = isPlaying
    ? '<path d="M5.5 4h5.2v16H5.5zM13.3 4h5.2v16h-5.2z"/>'
    : '<path d="M8 5.1c0-.8.9-1.3 1.6-.9l10 6.8c.6.4.6 1.3 0 1.7l-10 6.8c-.7.5-1.6 0-1.6-.9z"/>';
  if (btnKaraokePlay) {
    btnKaraokePlay.title = isPlaying ? 'Pausar' : 'Reproducir';
    btnKaraokePlay.setAttribute('aria-label', btnKaraokePlay.title);
  }
}

function updateKaraokeProgress(currentTime, duration) {
  if (!Number.isFinite(duration) || duration <= 0) {
    if (karaokeCurrentTimeEl) karaokeCurrentTimeEl.textContent = formatTime(currentTime || 0);
    if (karaokeDurationEl) karaokeDurationEl.textContent = '0:00';
    return;
  }
  if (!karaokeSeeking && karaokeProgressEl) {
    const ratio = Math.max(0, Math.min(1, currentTime / duration));
    karaokeProgressEl.value = String(Math.round(ratio * 1000));
    karaokeProgressEl.style.setProperty('--karaoke-progress', `${ratio * 100}%`);
  }
  if (karaokeCurrentTimeEl) karaokeCurrentTimeEl.textContent = formatTime(currentTime || 0);
  if (karaokeDurationEl) karaokeDurationEl.textContent = formatTime(duration);
}

function scrollKaraokeLineIntoView(body, line) {
  if (!body || !line || !karaokeAutoFollowEnabled || Date.now() < karaokeManualScrollUntil) return;
  const targetTop = line.offsetTop - (body.clientHeight - line.offsetHeight) / 2;
  body.scrollTo({ top: Math.max(0, targetTop), behavior: document.body.classList.contains('no-animations') ? 'auto' : 'smooth' });
}

function applyKaraokeLayout(mode) {
  karaokeDisplayMode = mode === 'cover' ? 'cover' : 'simple';
  if (karaokeModeEl) karaokeModeEl.dataset.layout = karaokeDisplayMode;
  document.querySelectorAll('[data-karaoke-layout]').forEach((button) => {
    const active = button.dataset.karaokeLayout === karaokeDisplayMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  if (karaokeSettingDisplayMode && karaokeSettingDisplayMode.value !== karaokeDisplayMode) karaokeSettingDisplayMode.value = karaokeDisplayMode;
  try { localStorage.setItem('glasstrackKaraokeDisplayMode', karaokeDisplayMode); } catch (_) {}
  if (karaokeActive && karaokeAutoFollowEnabled) {
    const body = karaokeDisplayMode === 'cover' ? karaokeLyricsCoverBody : karaokeLyricsSimpleBody;
    const activeLine = body?.querySelector('.karaoke-line.active');
    if (body && activeLine) scrollKaraokeLineIntoView(body, activeLine);
  }
}

function applyKaraokeSettingsToUI() {
  if (!karaokeModeEl) return;
  karaokeModeEl.style.setProperty('--karaoke-font-size', `${karaokeFontSize}px`);
  karaokeModeEl.style.setProperty('--karaoke-voice-a', karaokeDuetColorA);
  karaokeModeEl.style.setProperty('--karaoke-voice-b', karaokeDuetColorB);
  karaokeModeEl.classList.toggle('karaoke-show-neighbors', karaokeShowNeighbors);
  karaokeModeEl.classList.toggle('karaoke-hide-neighbors', !karaokeShowNeighbors);
  karaokeModeEl.classList.toggle('karaoke-auto-follow', karaokeAutoFollowEnabled);
  karaokeModeEl.classList.toggle('karaoke-duet-enabled', karaokeDuetEnabled);
  if (karaokeSettingDisplayMode) karaokeSettingDisplayMode.value = karaokeDisplayMode;
  if (karaokeSettingFontSize) karaokeSettingFontSize.value = String(karaokeFontSize);
  if (karaokeSettingFontSizeLabel) karaokeSettingFontSizeLabel.textContent = `${karaokeFontSize} px`;
  if (karaokeSettingNeighbors) karaokeSettingNeighbors.checked = karaokeShowNeighbors;
  if (karaokeSettingAutoFollow) karaokeSettingAutoFollow.checked = karaokeAutoFollowEnabled;
  if (typeof syncKaraokeFollowButton === 'function') syncKaraokeFollowButton();
  if (karaokeSettingDuet) karaokeSettingDuet.checked = karaokeDuetEnabled;
  if (karaokeDuetOptions) karaokeDuetOptions.classList.toggle('hidden', !karaokeDuetEnabled);
  if (karaokeDuetNameAInput) karaokeDuetNameAInput.value = karaokeDuetNameA;
  if (karaokeDuetNameBInput) karaokeDuetNameBInput.value = karaokeDuetNameB;
  if (karaokeDuetColorAInput) karaokeDuetColorAInput.value = karaokeDuetColorA;
  if (karaokeDuetColorBInput) karaokeDuetColorBInput.value = karaokeDuetColorB;
  karaokeLyricsScrollBodies.forEach(body => body.querySelectorAll('.karaoke-line').forEach(line => {
    line.classList.toggle('karaoke-hidden-context', !karaokeShowNeighbors && !line.classList.contains('active'));
    if (line.classList.contains('karaoke-duet-a')) line.dataset.duetLabel = karaokeDuetNameA;
    if (line.classList.contains('karaoke-duet-b')) line.dataset.duetLabel = karaokeDuetNameB;
  }));
}

function persistKaraokeSettings() {
  try {
    localStorage.setItem('glasstrackKaraokeDisplayMode', karaokeDisplayMode);
    localStorage.setItem('glasstrackKaraokeFontSize', String(karaokeFontSize));
    localStorage.setItem('glasstrackKaraokeShowNeighbors', String(karaokeShowNeighbors));
    localStorage.setItem('glasstrackKaraokeAutoFollow', String(karaokeAutoFollowEnabled));
    localStorage.setItem('glasstrackKaraokeDuetEnabled', String(karaokeDuetEnabled));
    localStorage.setItem('glasstrackKaraokeDuetNameA', karaokeDuetNameA);
    localStorage.setItem('glasstrackKaraokeDuetNameB', karaokeDuetNameB);
    localStorage.setItem('glasstrackKaraokeDuetColorA', karaokeDuetColorA);
    localStorage.setItem('glasstrackKaraokeDuetColorB', karaokeDuetColorB);
  } catch (_) {}
}

function openKaraokeSettings() {
  if (!karaokeSettingsModal) return;
  applyKaraokeSettingsToUI();
  karaokeSettingsModal.classList.add('active');
  karaokeSettingsModal.setAttribute('aria-hidden', 'false');
}
function closeKaraokeSettings() {
  if (!karaokeSettingsModal) return;
  karaokeSettingsModal.classList.remove('active');
  karaokeSettingsModal.setAttribute('aria-hidden', 'true');
}

function openKaraokeMode() {
  if (!karaokeModeEl) return;
  // Los modos son independientes y no deben quedar superpuestos.
  if (cinemaMode?.classList.contains('active') && btnCloseCinema) btnCloseCinema.click();
  if (lyricsPanel) lyricsPanel.classList.remove('active');
  if (modalSongMenu?.classList.contains('active')) closeModal(modalSongMenu);
  if (modalSongMetadata?.classList.contains('active')) closeModal(modalSongMetadata);
  if (modalSongMetadataEdit?.classList.contains('active')) closeModal(modalSongMetadataEdit);
  if (document.getElementById('modal-settings')?.classList.contains('active')) closeModalSettings();
  applyKaraokeLayout(karaokeDisplayMode);
  applyKaraokeSettingsToUI();
  syncKaraokeMetadata();
  syncKaraokePlayControl();
  updateKaraokeProgress(activeAudio?.currentTime || 0, activeAudio?.duration || 0);
  karaokeActive = true;
  karaokeModeEl.classList.add('active');
  karaokeModeEl.setAttribute('aria-hidden', 'false');
  document.body.classList.add('karaoke-mode-active');
  closeKaraokeSettings();
  try { activeAudio?.dispatchEvent(new Event('timeupdate')); } catch (_) {}
}
function closeKaraokeMode() {
  karaokeActive = false;
  if (karaokeModeEl) {
    karaokeModeEl.classList.remove('active');
    karaokeModeEl.setAttribute('aria-hidden', 'true');
  }
  document.body.classList.remove('karaoke-mode-active');
  closeKaraokeSettings();
}

if (btnOpenKaraoke) btnOpenKaraoke.addEventListener('click', openKaraokeMode);
if (btnOpenKaraokeMain) btnOpenKaraokeMain.addEventListener('click', openKaraokeMode);
if (btnConfigureKaraoke && btnCalibrateLyrics) btnConfigureKaraoke.addEventListener('click', () => btnCalibrateLyrics.click());
if (btnCloseKaraoke) btnCloseKaraoke.addEventListener('click', closeKaraokeMode);
if (btnKaraokePlay && playBtn) btnKaraokePlay.addEventListener('click', () => playBtn.click());
if (btnKaraokePrev && prevBtn) btnKaraokePrev.addEventListener('click', () => prevBtn.click());
if (btnKaraokeNext && nextBtn) btnKaraokeNext.addEventListener('click', () => nextBtn.click());
btnKaraokeSettings?.addEventListener('click', openKaraokeSettings);
btnKaraokeSettingsOpen?.addEventListener('click', openKaraokeSettings);
btnCloseKaraokeSettings?.addEventListener('click', closeKaraokeSettings);
karaokeSettingsModal?.addEventListener('click', event => { if (event.target === karaokeSettingsModal) closeKaraokeSettings(); });
document.querySelectorAll('[data-karaoke-layout]').forEach(button => button.addEventListener('click', () => applyKaraokeLayout(button.dataset.karaokeLayout)));

karaokeSettingDisplayMode?.addEventListener('change', () => applyKaraokeLayout(karaokeSettingDisplayMode.value));
karaokeSettingFontSize?.addEventListener('input', () => {
  karaokeFontSize = Math.max(24, Math.min(76, Number(karaokeSettingFontSize.value) || 44));
  applyKaraokeSettingsToUI();
});
karaokeSettingNeighbors?.addEventListener('change', () => { karaokeShowNeighbors = karaokeSettingNeighbors.checked; applyKaraokeSettingsToUI(); });
karaokeSettingAutoFollow?.addEventListener('change', () => {
  karaokeAutoFollowEnabled = karaokeSettingAutoFollow.checked;
  try { localStorage.setItem('glasstrackKaraokeAutoFollow', String(karaokeAutoFollowEnabled)); } catch (_) {}
  applyKaraokeSettingsToUI();
  syncKaraokeFollowButton();
});
karaokeSettingDuet?.addEventListener('change', () => {
  karaokeDuetEnabled = karaokeSettingDuet.checked;
  renderKaraokeLyrics(songList[currentIndex]?.lyrics || '');
  applyKaraokeSettingsToUI();
});
karaokeDuetNameAInput?.addEventListener('input', () => { karaokeDuetNameA = karaokeDuetNameAInput.value.trim() || 'Voz A'; applyKaraokeSettingsToUI(); });
karaokeDuetNameBInput?.addEventListener('input', () => { karaokeDuetNameB = karaokeDuetNameBInput.value.trim() || 'Voz B'; applyKaraokeSettingsToUI(); });
karaokeDuetColorAInput?.addEventListener('input', () => { karaokeDuetColorA = karaokeDuetColorAInput.value || '#f2c94c'; applyKaraokeSettingsToUI(); });
karaokeDuetColorBInput?.addEventListener('input', () => { karaokeDuetColorB = karaokeDuetColorBInput.value || '#8bb8ff'; applyKaraokeSettingsToUI(); });
btnSaveKaraokeSettings?.addEventListener('click', () => {
  persistKaraokeSettings();
  closeKaraokeSettings();
  showToast('Ajustes del Karaoke guardados.', 'success', 1600);
});

if (karaokeProgressEl) {
  karaokeProgressEl.addEventListener('input', () => {
    karaokeSeeking = true;
    const duration = Number(activeAudio?.duration) || 0;
    const time = duration * (Number(karaokeProgressEl.value) / 1000);
    if (karaokeCurrentTimeEl) karaokeCurrentTimeEl.textContent = formatTime(time);
    karaokeProgressEl.style.setProperty('--karaoke-progress', `${Math.max(0, Math.min(100, Number(karaokeProgressEl.value) / 10))}%`);
  });
  const commitKaraokeSeek = () => {
    const duration = Number(activeAudio?.duration) || 0;
    if (duration > 0) activeAudio.currentTime = duration * (Number(karaokeProgressEl.value) / 1000);
    karaokeSeeking = false;
  };
  karaokeProgressEl.addEventListener('change', commitKaraokeSeek);
  karaokeProgressEl.addEventListener('pointerup', commitKaraokeSeek);
  karaokeProgressEl.addEventListener('touchend', commitKaraokeSeek, { passive: true });
}
if (karaokeVolumeEl && volumeSlider) {
  karaokeVolumeEl.value = volumeSlider.value;
  karaokeVolumeEl.addEventListener('input', () => {
    volumeSlider.value = karaokeVolumeEl.value;
    volumeSlider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  volumeSlider.addEventListener('input', () => {
    if (karaokeVolumeEl.value !== volumeSlider.value) karaokeVolumeEl.value = volumeSlider.value;
  });
}

function syncKaraokeFollowButton() {
  if (!btnKaraokeFollow) return;
  btnKaraokeFollow.classList.toggle('active', !!karaokeAutoFollowEnabled);
  btnKaraokeFollow.setAttribute('aria-pressed', karaokeAutoFollowEnabled ? 'true' : 'false');
  btnKaraokeFollow.title = karaokeAutoFollowEnabled ? 'Seguir letra activado' : 'Seguir letra desactivado';
  btnKaraokeFollow.setAttribute('aria-label', btnKaraokeFollow.title);
}
if (btnKaraokeFollow) btnKaraokeFollow.addEventListener('click', () => {
  karaokeAutoFollowEnabled = !karaokeAutoFollowEnabled;
  karaokeManualScrollUntil = 0;
  try { localStorage.setItem('glasstrackKaraokeAutoFollow', String(karaokeAutoFollowEnabled)); } catch (_) {}
  if (karaokeSettingAutoFollow) karaokeSettingAutoFollow.checked = karaokeAutoFollowEnabled;
  applyKaraokeSettingsToUI();
  syncKaraokeFollowButton();
  if (karaokeAutoFollowEnabled) {
    const activeBody = karaokeDisplayMode === 'cover' ? karaokeLyricsCoverBody : karaokeLyricsSimpleBody;
    const activeLine = activeBody?.querySelector('.karaoke-line.active');
    if (activeBody && activeLine) scrollKaraokeLineIntoView(activeBody, activeLine);
  }
});
karaokeLyricsScrollBodies.forEach(body => {
  body.addEventListener('wheel', () => {
    karaokeManualScrollUntil = Date.now() + 2200;
    syncKaraokeFollowButton();
  }, { passive: true });
  body.addEventListener('touchstart', () => {
    karaokeManualScrollUntil = Date.now() + 2200;
    syncKaraokeFollowButton();
  }, { passive: true });
  body.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch' || event.button === 0) {
      karaokeManualScrollUntil = Date.now() + 2200;
      syncKaraokeFollowButton();
    }
  }, { passive: true });
});

function applyKaraokeSettingsToUIInitial() {
  applyKaraokeLayout(karaokeDisplayMode);
  applyKaraokeSettingsToUI();
  syncKaraokeMetadata();
}
applyKaraokeSettingsToUIInitial();

// El botón de reproducción del Karaoke refleja el estado real incluso si el usuario
// cambia de pista o pulsa pausa desde los controles originales de Glasstrack.
[audio1, audio2].filter(Boolean).forEach(audioEl => {
  audioEl.addEventListener('play', () => { if (audioEl === activeAudio) syncKaraokePlayControl(true); });
  audioEl.addEventListener('pause', () => { if (audioEl === activeAudio) syncKaraokePlayControl(false); });
  audioEl.addEventListener('loadedmetadata', () => {
    if (audioEl === activeAudio) {
      syncKaraokeMetadata();
      updateKaraokeProgress(audioEl.currentTime || 0, audioEl.duration || 0);
      try { audioEl.dispatchEvent(new Event('timeupdate')); } catch (_) {}
    }
  });
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && karaokeModeEl?.classList.contains('active')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeKaraokeMode();
  }
}, true);

// Usa marcas por palabra ya guardadas en el Estudio de Letras; no inventa tiempos.
function updateKaraokeWords(activeLineEl, lineIndex, adjustedTime, totalLines, duration) {
  if (!activeLineEl) return;
  const words = Array.from(activeLineEl.querySelectorAll('.karaoke-word'));
  if (!words.length) return;
  const song = songList[currentIndex];
  const realWords = song && song.karaokeWords && song.karaokeWords[lineIndex];
  if (!Array.isArray(realWords) || !realWords.length) return;
  let wordTimes = realWords;
  if (wordTimes.length !== words.length) {
    const sourceLine = String(song?.lyrics || '').split('\n')[lineIndex] || '';
    const hasDuetPrefix = /^\s*(?:\[A\]|\[B\]|A:|B:)\s*/i.test(sourceLine);
    if (hasDuetPrefix && wordTimes.length > words.length) wordTimes = wordTimes.slice(wordTimes.length - words.length);
    else return;
  }
  let activeWordIndex = -1;
  for (let i = 0; i < wordTimes.length; i++) {
    const time = Number(wordTimes[i]?.time);
    if (Number.isFinite(time) && time <= adjustedTime) activeWordIndex = i;
    else if (Number.isFinite(time)) break;
  }
  words.forEach((word, index) => word.classList.toggle('word-active', index <= activeWordIndex));
}


document.querySelectorAll('.lyrics-bg-mode-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    playSFX('click');
    document.querySelectorAll('.lyrics-bg-mode-btn').forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    applyCinemaBgMode(e.currentTarget.dataset.bg);
  });
});

// Aplica el modo de fondo elegido para el Modo Cine / Karaoke.
// "Automático" usa tu fondo animado si tienes uno puesto; si no, usa la carátula difuminada.
function applyCinemaBgMode(mode) {
  if (!cinemaMode) return;
  cinemaMode.classList.remove('bg-black', 'bg-white', 'bg-animated');
  if (mode === 'auto') {
    const hasAnimatedBg = bgVideo && bgVideo.src && !bgVideo.classList.contains('bg-video-hidden');
    if (hasAnimatedBg) cinemaMode.classList.add('bg-animated');
  } else if (mode === 'black') cinemaMode.classList.add('bg-black');
  else if (mode === 'white') cinemaMode.classList.add('bg-white');
  else if (mode === 'animated') cinemaMode.classList.add('bg-animated');
}

// Resalta palabra por palabra dentro de la línea activa: usa los tiempos reales
// calibrados en el Modo Karaoke si existen; si no, aproxima repartiendo el tiempo.
// ==========================================
// PRESETS DE MODO (Juego / Noche / Estudio)
// ==========================================
function clearModePresets() {
  document.body.classList.remove('preset-game', 'preset-night', 'preset-study');
  const nightOverlay = document.getElementById('night-mode-overlay');
  if (nightOverlay) nightOverlay.classList.remove('active');
}
const presetNormalBtn = document.getElementById('preset-normal');
const presetGameBtn = document.getElementById('preset-game');
const presetNightBtn = document.getElementById('preset-night');
const presetStudyBtn = document.getElementById('preset-study');
if (presetNormalBtn) presetNormalBtn.addEventListener('click', () => { playSFX('click'); clearModePresets(); });
if (presetGameBtn) presetGameBtn.addEventListener('click', () => { playSFX('click'); clearModePresets(); document.body.classList.add('preset-game'); });
if (presetNightBtn) {
  presetNightBtn.addEventListener('click', () => {
    playSFX('click');
    clearModePresets();
    document.body.classList.add('preset-night');
    const nightOverlay = document.getElementById('night-mode-overlay');
    if (nightOverlay) nightOverlay.classList.add('active');
  });
}
if (presetStudyBtn) presetStudyBtn.addEventListener('click', () => { playSFX('click'); clearModePresets(); document.body.classList.add('preset-study'); });

// ==========================================
// INTERRUPTORES DE ANIMACIONES
// ==========================================
if (toggleAnimMaster) {
  toggleAnimMaster.addEventListener('change', (e) => {
    const enabled = !!e.target.checked;
    // .checked no dispara "change" por sí solo. Actualizamos los hijos directamente
    // y sincronizamos las clases una sola vez para evitar bucles al segundo clic.
    document.querySelectorAll('.anim-toggle-input').forEach(input => {
      input.checked = enabled;
    });
    document.body.classList.toggle('no-animations', !enabled);
    document.body.classList.toggle('anim-no-glide', !enabled);
    document.body.classList.toggle('anim-no-addsong', !enabled);
    document.body.classList.toggle('anim-no-modals', !enabled);
  });
}
if (toggleAnimGlide) {
  toggleAnimGlide.addEventListener('change', (e) => {
    document.body.classList.toggle('anim-no-glide', !e.target.checked);
  });
}
if (toggleAnimAddSong) {
  toggleAnimAddSong.addEventListener('change', (e) => {
    document.body.classList.toggle('anim-no-addsong', !e.target.checked);
  });
}
if (toggleAnimModals) {
  toggleAnimModals.addEventListener('change', (e) => {
    document.body.classList.toggle('anim-no-modals', !e.target.checked);
  });
}



// ==========================================
// EDITOR VISUAL EN VIVO (base real: fondo, bordes, sombra y cristal por tarjeta)
// ==========================================
let visualEditorActive = false;
const EDITABLE_CARDS = {
  'player-card': document.getElementById('player-card'),
  'eq-panel': document.getElementById('eq-panel'),
  'vm-panel': document.getElementById('vm-panel'),
  'library-panel': document.getElementById('library-panel'),
  'lyrics-panel': document.getElementById('lyrics-panel')
};
let customCardStyles = {};
try { customCardStyles = JSON.parse(localStorage.getItem('customCardStyles') || '{}'); } catch (e) { customCardStyles = {}; }

function applyCardStyle(el, style) {
  if (!el || !style) return;
  if (style.bgImage) {
    el.style.backgroundImage = `url(${style.bgImage})`;
    el.style.backgroundSize = style.fit === 'contain' ? 'contain' : (style.fit === 'repeat' ? 'auto' : 'cover');
    el.style.backgroundRepeat = style.fit === 'repeat' ? 'repeat' : 'no-repeat';
    el.style.backgroundPosition = 'center';
  }
  if (style.radius !== undefined) el.style.borderRadius = style.radius + 'px';
  if (style.borderWidth !== undefined) el.style.borderWidth = style.borderWidth + 'px';
  if (style.borderColor) { el.style.borderStyle = 'solid'; el.style.borderColor = style.borderColor; }
  if (style.shadow !== undefined) el.style.boxShadow = style.shadow > 0 ? `0 8px ${style.shadow}px rgba(0,0,0,0.5)` : 'none';
  if (style.glass !== undefined) {
    const alpha = Math.max(0.05, Math.min(0.90, Number(style.glass) || 0.25));
    el.style.setProperty('--glass-alpha', alpha.toFixed(2));
    el.style.background = 'rgba(18, 18, 24, var(--glass-alpha))';
  }
}

Object.keys(customCardStyles).forEach(key => {
  if (EDITABLE_CARDS[key]) applyCardStyle(EDITABLE_CARDS[key], customCardStyles[key]);
});

const btnOpenVisualEditor = document.getElementById('btn-open-visual-editor');
const visualEditorToolbar = document.getElementById('visual-editor-toolbar');
const btnExitVisualEditor = document.getElementById('btn-exit-visual-editor');
const btnResetVisualEditor = document.getElementById('btn-reset-visual-editor');
const modalCardEditor = document.getElementById('modal-card-editor');
const btnCloseCardEditor = document.getElementById('btn-close-card-editor');
const cardEditorTitle = document.getElementById('card-editor-title');
const btnCardBgImage = document.getElementById('btn-card-bg-image');
const inputCardBgImage = document.getElementById('input-card-bg-image');
const inputCardRadius = document.getElementById('input-card-radius');
const inputCardBorderWidth = document.getElementById('input-card-border-width');
const inputCardBorderColor = document.getElementById('input-card-border-color');
const inputCardShadow = document.getElementById('input-card-shadow');
const inputCardGlass = document.getElementById('input-card-glass');
const btnApplyCardStyle = document.getElementById('btn-apply-card-style');
const btnClearCardStyle = document.getElementById('btn-clear-card-style');

let editingCardKey = null;
let pendingCardBgImage = null;
let forcedVisibleCards = [];

function enterVisualEditor() {
  visualEditorActive = true;
  if (modalSettings) {
    modalSettings.classList.add('ve-closing');
    setTimeout(() => { modalSettings.classList.remove('active', 've-closing'); }, 300);
  }
  if (visualEditorToolbar) visualEditorToolbar.classList.remove('hidden');
  forcedVisibleCards = [];
  Object.entries(EDITABLE_CARDS).forEach(([key, el]) => {
    if (!el) return;
    el.classList.add('editable-highlight');
    // Algunos paneles (EQ, Voz/Música, Letras) normalmente están ocultos hasta que los abres:
    // los mostramos igual durante la edición para que se puedan tocar y personalizar.
    if (el.classList.contains('hidden')) {
      el.classList.remove('hidden');
      forcedVisibleCards.push({ el, type: 'hidden' });
    }
    if (key === 'lyrics-panel' && !el.classList.contains('active')) {
      el.classList.add('active');
      forcedVisibleCards.push({ el, type: 'active' });
    }
  });
}
function exitVisualEditor() {
  visualEditorActive = false;
  if (visualEditorToolbar) visualEditorToolbar.classList.add('hidden');
  Object.values(EDITABLE_CARDS).forEach(el => { if (el) el.classList.remove('editable-highlight'); });
  forcedVisibleCards.forEach(({ el, type }) => {
    if (type === 'hidden') el.classList.add('hidden');
    else if (type === 'active') el.classList.remove('active');
  });
  forcedVisibleCards = [];
}

if (btnOpenVisualEditor) btnOpenVisualEditor.addEventListener('click', () => { playSFX('open'); enterVisualEditor(); });
if (btnExitVisualEditor) btnExitVisualEditor.addEventListener('click', () => { playSFX('close'); exitVisualEditor(); });

if (btnResetVisualEditor) {
  btnResetVisualEditor.addEventListener('click', () => {
    if (!confirm('¿Restablecer toda la interfaz personalizada a los valores por defecto?')) return;
    customCardStyles = {};
    localStorage.removeItem('customCardStyles');
    Object.values(EDITABLE_CARDS).forEach(el => {
      if (!el) return;
      ['backgroundImage', 'backgroundColor', 'borderRadius', 'borderWidth', 'borderColor', 'borderStyle', 'boxShadow'].forEach(p => el.style[p] = '');
    });
    playSFX('click');
  });
}

Object.keys(EDITABLE_CARDS).forEach(key => {
  const el = EDITABLE_CARDS[key];
  if (!el) return;
  el.addEventListener('click', (e) => {
    if (!visualEditorActive) return;
    e.stopPropagation();
    editingCardKey = key;
    pendingCardBgImage = null;
    const existing = customCardStyles[key] || {};
    if (inputCardRadius) inputCardRadius.value = existing.radius !== undefined ? existing.radius : 20;
    if (inputCardBorderWidth) inputCardBorderWidth.value = existing.borderWidth !== undefined ? existing.borderWidth : 1;
    if (inputCardBorderColor) inputCardBorderColor.value = existing.borderColor || '#ffffff';
    if (inputCardShadow) inputCardShadow.value = existing.shadow !== undefined ? existing.shadow : 0;
    if (inputCardGlass) inputCardGlass.value = existing.glass !== undefined ? existing.glass : 0.9;
    document.querySelectorAll('.card-fit-btn').forEach(b => b.classList.toggle('active', b.dataset.fit === (existing.fit || 'cover')));
    if (cardEditorTitle) cardEditorTitle.textContent = 'Personalizar: ' + key;
    openModal(modalCardEditor);
  });
});

if (btnCloseCardEditor) btnCloseCardEditor.addEventListener('click', () => { playSFX('close'); closeModal(modalCardEditor); });
if (btnCardBgImage) btnCardBgImage.addEventListener('click', () => { if (inputCardBgImage) inputCardBgImage.click(); });
if (inputCardBgImage) {
  inputCardBgImage.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { pendingCardBgImage = ev.target.result; };
    reader.readAsDataURL(file);
  });
}
document.querySelectorAll('.card-fit-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    playSFX('click');
    document.querySelectorAll('.card-fit-btn').forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
  });
});

if (btnApplyCardStyle) {
  btnApplyCardStyle.addEventListener('click', () => {
    playSFX('click');
    if (!editingCardKey || !EDITABLE_CARDS[editingCardKey]) { closeModal(modalCardEditor); return; }
    const activeFitBtn = document.querySelector('.card-fit-btn.active');
    const style = {
      radius: inputCardRadius ? parseInt(inputCardRadius.value, 10) : 20,
      borderWidth: inputCardBorderWidth ? parseInt(inputCardBorderWidth.value, 10) : 1,
      borderColor: inputCardBorderColor ? inputCardBorderColor.value : '#ffffff',
      shadow: inputCardShadow ? parseInt(inputCardShadow.value, 10) : 0,
      glass: inputCardGlass ? parseFloat(inputCardGlass.value) : 0.9,
      fit: activeFitBtn ? activeFitBtn.dataset.fit : 'cover'
    };
    if (pendingCardBgImage) style.bgImage = pendingCardBgImage;
    else if (customCardStyles[editingCardKey] && customCardStyles[editingCardKey].bgImage) style.bgImage = customCardStyles[editingCardKey].bgImage;

    customCardStyles[editingCardKey] = style;
    try { localStorage.setItem('customCardStyles', JSON.stringify(customCardStyles)); }
    catch (err) { showToast('La imagen es muy grande para guardarse permanentemente. Prueba con una imagen más liviana.', 'error'); }
    applyCardStyle(EDITABLE_CARDS[editingCardKey], style);
    closeModal(modalCardEditor);
  });
}

// Dibuja SOLO el marco (fondo, borde y sombra) de la tarjeta en un canvas, sin su
// ícono ni texto, y lo descarga como PNG con transparencia real.
function roundRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function downloadCardTemplate(key) {
  const el = EDITABLE_CARDS[key];
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const w = Math.max(Math.round(rect.width), 40);
  const h = Math.max(Math.round(rect.height), 40);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');

  const radius = inputCardRadius ? parseInt(inputCardRadius.value, 10) : 20;
  const borderWidth = inputCardBorderWidth ? parseInt(inputCardBorderWidth.value, 10) : 1;
  const borderColor = inputCardBorderColor ? inputCardBorderColor.value : '#ffffff';
  const shadow = inputCardShadow ? parseInt(inputCardShadow.value, 10) : 0;
  const glass = inputCardGlass ? parseFloat(inputCardGlass.value) : 0.9;
  const bgImageSrc = pendingCardBgImage || (customCardStyles[key] && customCardStyles[key].bgImage);

  function strokeBorder() {
    if (borderWidth > 0) {
      roundRectPath(ctx, borderWidth / 2, borderWidth / 2, w - borderWidth, h - borderWidth, radius);
      ctx.lineWidth = borderWidth;
      ctx.strokeStyle = borderColor;
      ctx.stroke();
    }
  }

  function triggerDownload() {
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `plantilla-${key}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  if (bgImageSrc) {
    const img = new Image();
    img.onload = () => {
      roundRectPath(ctx, borderWidth / 2, borderWidth / 2, w - borderWidth, h - borderWidth, radius);
      ctx.save();
      ctx.clip();
      ctx.drawImage(img, 0, 0, w, h);
      ctx.restore();
      strokeBorder();
      triggerDownload();
    };
    img.onerror = () => { strokeBorder(); triggerDownload(); };
    img.src = bgImageSrc;
  } else {
    if (shadow > 0) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = shadow;
      ctx.shadowOffsetY = 8;
    }
    roundRectPath(ctx, borderWidth / 2, borderWidth / 2, w - borderWidth, h - borderWidth, radius);
    ctx.fillStyle = `rgba(20,21,30,${glass})`;
    ctx.fill();
    if (shadow > 0) ctx.restore();
    strokeBorder();
    triggerDownload();
  }
}

const btnDownloadCardTemplate = document.getElementById('btn-download-card-template');
if (btnDownloadCardTemplate) {
  btnDownloadCardTemplate.addEventListener('click', () => {
    playSFX('click');
    if (editingCardKey) downloadCardTemplate(editingCardKey);
  });
}

if (btnClearCardStyle) {
  btnClearCardStyle.addEventListener('click', () => {
    playSFX('click');
    if (!editingCardKey) { closeModal(modalCardEditor); return; }
    delete customCardStyles[editingCardKey];
    localStorage.setItem('customCardStyles', JSON.stringify(customCardStyles));
    const el = EDITABLE_CARDS[editingCardKey];
    if (el) {
      ['backgroundImage', 'backgroundColor', 'borderRadius', 'borderWidth', 'borderColor', 'borderStyle', 'boxShadow'].forEach(p => el.style[p] = '');
    }
    closeModal(modalCardEditor);
  });
}


// =========================================================
// GLASSTRACK PRO B32 — TANDA 2
// Tipografía, letras normales, Modo Cine compartido,
// rendimiento personalizado y reset seguro de personalización avanzada.
// =========================================================

(function initB32Tanda2() {
  const ROOT = document.documentElement;
  const BODY = document.body;

  // -------------------------------------------------------
  // 5. TIPOGRAFÍA REAL DE LA INTERFAZ
  // -------------------------------------------------------
  const fontSelectB32 = document.getElementById('select-font');
  const fontSizeRangeB32 = document.getElementById('b32-font-size-range');
  const fontSizeValueB32 = document.getElementById('b32-font-size-value');
  const fontWeightButtonsB32 = document.querySelectorAll('[data-font-weight]');
  const FONT_KEY = 'glasstrackB32FontSettings';
  const FONT_FALLBACK = 'Inter, sans-serif';

  function safeFont(value) {
    const allowed = [
      'Inter, sans-serif', 'Roboto, sans-serif', 'Poppins, sans-serif',
      'Montserrat, sans-serif', "'Outfit', sans-serif", "'Space Grotesk', sans-serif",
      "'Orbitron', sans-serif", "'Permanent Marker', cursive", "'Pacifico', cursive",
      "'Caveat', cursive", "'Cinzel', serif", "'Fira Code', monospace", "'Oswald', sans-serif",
      "'Lato', sans-serif", "'Nunito', sans-serif", "'Raleway', sans-serif",
      "'Rubik', sans-serif", "'Bebas Neue', sans-serif", "'Playfair Display', serif",
      "'Press Start 2P', cursive"
    ];
    return allowed.includes(value) ? value : FONT_FALLBACK;
  }

  function readB32FontSettings() {
    try {
      const raw = readProfileValue(FONT_KEY, activeProfileId, null);
      if (!raw) {
        const legacyFamily = localStorage.getItem('glasstrackFontFamily');
        const legacySize = localStorage.getItem('glasstrackFontSize');
        const legacyMap = { small: 90, medium: 100, large: 110 };
        return {
          family: safeFont(legacyFamily || FONT_FALLBACK),
          size: legacyMap[legacySize] || 100,
          weight: 400
        };
      }
      const data = JSON.parse(raw);
      return {
        family: safeFont(data.family),
        size: clampB31(data.size, 80, 125, 100),
        weight: [400, 500, 600, 700].includes(Number(data.weight)) ? Number(data.weight) : 400
      };
    } catch (_) {
      return { family: FONT_FALLBACK, size: 100, weight: 400 };
    }
  }

  function saveB32FontSettings(settings) {
    writeProfileValue(FONT_KEY, JSON.stringify(settings), activeProfileId);
  }

  function applyB32FontSettings(settings, persist = false) {
    const safe = {
      family: safeFont(settings.family),
      size: clampB31(settings.size, 80, 125, 100),
      weight: [400, 500, 600, 700].includes(Number(settings.weight)) ? Number(settings.weight) : 400
    };
    ROOT.style.setProperty('--b32-font-ui', safe.family);
    // Press Start 2P tiene glifos deliberadamente anchos; reduce la escala global
    // ligeramente al seleccionarla para evitar que la tipografía deforme la interfaz.
    const pixelFont = safe.family.includes('Press Start 2P');
    BODY.classList.toggle('b32-font-pixel', pixelFont);
    ROOT.style.setProperty('--b32-font-scale', `${(safe.size / 100) * (pixelFont ? 0.88 : 1)}`);
    ROOT.style.setProperty('--b32-font-weight', String(safe.weight));
    BODY.classList.add('b32-font-customized');
    if (fontSelectB32) fontSelectB32.value = safe.family;
    if (fontSizeRangeB32) fontSizeRangeB32.value = String(safe.size);
    if (fontSizeValueB32) fontSizeValueB32.textContent = `${Math.round(safe.size)}%`;
    const fontPreview = document.querySelector('.b32-font-preview');
    if (fontPreview) fontPreview.setAttribute('data-font-ready', 'true');
    fontWeightButtonsB32.forEach(btn => {
      btn.classList.toggle('active', Number(btn.dataset.fontWeight) === safe.weight);
      btn.setAttribute('aria-pressed', Number(btn.dataset.fontWeight) === safe.weight ? 'true' : 'false');
    });
    if (persist) saveB32FontSettings(safe);
  }

  const initialFont = readB32FontSettings();
  applyB32FontSettings(initialFont, false);

  if (fontSelectB32) {
    fontSelectB32.addEventListener('change', (e) => {
      const current = readB32FontSettings();
      applyB32FontSettings({ ...current, family: e.target.value }, true);
    });
  }
  if (fontSizeRangeB32) {
    const handleFontSize = (e) => {
      const current = readB32FontSettings();
      applyB32FontSettings({ ...current, size: e.target.value }, true);
    };
    fontSizeRangeB32.addEventListener('input', handleFontSize);
    fontSizeRangeB32.addEventListener('change', handleFontSize);
  }
  fontWeightButtonsB32.forEach(btn => {
    btn.addEventListener('click', () => {
      const current = readB32FontSettings();
      applyB32FontSettings({ ...current, weight: Number(btn.dataset.fontWeight) }, true);
      playSFX('click');
    });
  });

  // -------------------------------------------------------
  // 6. LETRAS NORMALES — ventana independiente y persistente
  // -------------------------------------------------------
  const modalLyricsCustom = document.getElementById('modal-lyrics-customization');
  const btnOpenLyricsCustom = document.getElementById('btn-open-lyrics-custom');
  const btnCloseLyricsCustom = document.getElementById('btn-close-lyrics-custom');
  const btnResetLyricsCustom = document.getElementById('btn-reset-lyrics-custom');
  const btnApplyLyricsCustom = document.getElementById('btn-apply-lyrics-custom');
  const lyricsSizeB32 = document.getElementById('b32-lyrics-size');
  const lyricsSizeValueB32 = document.getElementById('b32-lyrics-size-value');
  const lyricsPositionB32 = document.getElementById('b32-lyrics-position');
  const lyricsPositionValueB32 = document.getElementById('b32-lyrics-position-value');
  const lyricsSpacingB32 = document.getElementById('b32-lyrics-spacing');
  const lyricsSpacingValueB32 = document.getElementById('b32-lyrics-spacing-value');
  const lyricsOpacityB32 = document.getElementById('b32-lyrics-opacity');
  const lyricsOpacityValueB32 = document.getElementById('b32-lyrics-opacity-value');
  const lyricsActiveColorB32 = document.getElementById('b32-lyrics-active-color');
  const lyricsPastColorB32 = document.getElementById('b32-lyrics-past-color');
  const lyricsFutureColorB32 = document.getElementById('b32-lyrics-future-color');
  const LYRICS_KEY = 'glasstrackB32LyricsCustomization';
  const LYRICS_DEFAULTS = {
    size: 100,
    position: 50,
    spacing: 2.2,
    opacity: 100,
    activeColor: '#ffffff',
    pastColor: '#8f9aab',
    futureColor: '#566070'
  };

  function readLyricsCustomization() {
    try {
      const raw = readProfileValue(LYRICS_KEY, activeProfileId, null);
      if (!raw) return { ...LYRICS_DEFAULTS };
      const d = JSON.parse(raw);
      return {
        size: clampB31(d.size, 70, 160, 100),
        position: clampB31(d.position, 0, 100, 50),
        spacing: clampB31(d.spacing, 0, 5, 2.2),
        opacity: clampB31(d.opacity, 10, 100, 100),
        activeColor: validB31Hex(d.activeColor, '#ffffff'),
        pastColor: validB31Hex(d.pastColor, '#8f9aab'),
        futureColor: validB31Hex(d.futureColor, '#566070')
      };
    } catch (_) { return { ...LYRICS_DEFAULTS }; }
  }

  function saveLyricsCustomization(data) {
    writeProfileValue(LYRICS_KEY, JSON.stringify(data), activeProfileId);
  }

  function positionLabel(value) {
    const n = Number(value);
    if (n <= 20) return 'Izquierda';
    if (n >= 80) return 'Derecha';
    return 'Centro';
  }

  function applyLyricsCustomization(data, persist = false) {
    const safe = {
      size: clampB31(data.size, 70, 160, 100),
      position: clampB31(data.position, 0, 100, 50),
      spacing: clampB31(data.spacing, 0, 5, 2.2),
      opacity: clampB31(data.opacity, 10, 100, 100),
      activeColor: validB31Hex(data.activeColor, '#ffffff'),
      pastColor: validB31Hex(data.pastColor, '#8f9aab'),
      futureColor: validB31Hex(data.futureColor, '#566070')
    };
    ROOT.style.setProperty('--b32-lyrics-scale', (safe.size / 100).toFixed(3));
    ROOT.style.setProperty('--b32-lyrics-position', `${(safe.position - 50) * 0.32}%`);
    ROOT.style.setProperty('--b32-lyrics-spacing', safe.spacing.toFixed(2));
    ROOT.style.setProperty('--b32-lyrics-opacity', (safe.opacity / 100).toFixed(3));
    ROOT.style.setProperty('--b32-lyrics-active-color', safe.activeColor);
    ROOT.style.setProperty('--b32-lyrics-past-color', safe.pastColor);
    ROOT.style.setProperty('--b32-lyrics-future-color', safe.futureColor);
    const hasSavedLyricsCustomization = !!readProfileValue(LYRICS_KEY, activeProfileId, null);
    BODY.classList.toggle('b32-lyrics-customized', persist || hasSavedLyricsCustomization);

    if (lyricsSizeB32) lyricsSizeB32.value = safe.size;
    if (lyricsSizeValueB32) lyricsSizeValueB32.textContent = `${Math.round(safe.size)}%`;
    if (lyricsPositionB32) lyricsPositionB32.value = safe.position;
    if (lyricsPositionValueB32) lyricsPositionValueB32.textContent = positionLabel(safe.position);
    if (lyricsSpacingB32) lyricsSpacingB32.value = safe.spacing;
    if (lyricsSpacingValueB32) lyricsSpacingValueB32.textContent = `${safe.spacing.toFixed(1)}x`;
    if (lyricsOpacityB32) lyricsOpacityB32.value = safe.opacity;
    if (lyricsOpacityValueB32) lyricsOpacityValueB32.textContent = `${Math.round(safe.opacity)}%`;
    if (lyricsActiveColorB32) lyricsActiveColorB32.value = safe.activeColor;
    if (lyricsPastColorB32) lyricsPastColorB32.value = safe.pastColor;
    if (lyricsFutureColorB32) lyricsFutureColorB32.value = safe.futureColor;

    if (persist) saveLyricsCustomization(safe);
    return safe;
  }

  let lyricsDraft = applyLyricsCustomization(readLyricsCustomization(), false);

  function openLyricsCustomization() {
    lyricsDraft = readLyricsCustomization();
    applyLyricsCustomization(lyricsDraft, false);
    // Esta ventana es hija de "Calibrar Letras" y debe quedar siempre en primer plano.
    if (modalLyricsCustom) {
      modalLyricsCustom.classList.add('lyrics-custom-top');
      modalLyricsCustom.setAttribute('aria-hidden', 'false');
      openModal(modalLyricsCustom);
    }
    playSFX('open');
  }
  function closeLyricsCustomization() {
    if (modalLyricsCustom) {
      closeModal(modalLyricsCustom);
      modalLyricsCustom.setAttribute('aria-hidden', 'true');
      modalLyricsCustom.classList.remove('lyrics-custom-top');
    }
    playSFX('close');
  }

  if (btnOpenLyricsCustom) btnOpenLyricsCustom.addEventListener('click', openLyricsCustomization);
  if (btnCloseLyricsCustom) btnCloseLyricsCustom.addEventListener('click', closeLyricsCustomization);

  const liveLyricInputs = [lyricsSizeB32, lyricsPositionB32, lyricsSpacingB32, lyricsOpacityB32, lyricsActiveColorB32, lyricsPastColorB32, lyricsFutureColorB32];
  liveLyricInputs.forEach(input => {
    if (!input) return;
    const updateDraft = () => {
      lyricsDraft = {
        size: lyricsSizeB32?.value,
        position: lyricsPositionB32?.value,
        spacing: lyricsSpacingB32?.value,
        opacity: lyricsOpacityB32?.value,
        activeColor: lyricsActiveColorB32?.value,
        pastColor: lyricsPastColorB32?.value,
        futureColor: lyricsFutureColorB32?.value
      };
      BODY.classList.add('b32-lyrics-customized');
      applyLyricsCustomization(lyricsDraft, false);
    };
    input.addEventListener('input', updateDraft);
    input.addEventListener('change', updateDraft);
  });

  if (btnApplyLyricsCustom) btnApplyLyricsCustom.addEventListener('click', () => {
    const finalSettings = readLyricsCustomizationFromInputs();
    applyLyricsCustomization(finalSettings, true);
    closeLyricsCustomization();
  });

  function readLyricsCustomizationFromInputs() {
    return {
      size: lyricsSizeB32?.value ?? 100,
      position: lyricsPositionB32?.value ?? 50,
      spacing: lyricsSpacingB32?.value ?? 2.2,
      opacity: lyricsOpacityB32?.value ?? 100,
      activeColor: lyricsActiveColorB32?.value ?? '#ffffff',
      pastColor: lyricsPastColorB32?.value ?? '#8f9aab',
      futureColor: lyricsFutureColorB32?.value ?? '#566070'
    };
  }

  if (btnResetLyricsCustom) btnResetLyricsCustom.addEventListener('click', () => {
    lyricsDraft = { ...LYRICS_DEFAULTS };
    applyLyricsCustomization(lyricsDraft, true);
    playSFX('click');
  });

  // -------------------------------------------------------
  // 7. MODO CINE — fondo compartido real
  // -------------------------------------------------------
  const cinemaBgButtons = document.querySelectorAll('.cinema-bg-mode-btn');
  const cinemaSharedVideo = document.getElementById('cinema-shared-bg-video');
  const CINEMA_BG_KEY = 'glasstrackCinemaBgMode';

  function syncCinemaSharedVideo() {
    const globalVideoVisible = !!(bgVideo && !bgVideo.classList.contains('bg-video-hidden'));
    const source = globalVideoVisible ? (bgVideo.currentSrc || bgVideo.src || '') : '';
    if (!cinemaSharedVideo) return;
    if (!source) {
      cinemaSharedVideo.pause();
      cinemaSharedVideo.removeAttribute('src');
      cinemaSharedVideo.load();
      cinemaSharedVideo.classList.add('hidden');
      return;
    }
    if (cinemaSharedVideo.src !== source) {
      cinemaSharedVideo.src = source;
      cinemaSharedVideo.load();
    }
    cinemaSharedVideo.classList.remove('hidden');
    cinemaSharedVideo.muted = true;
    cinemaSharedVideo.loop = true;
    cinemaSharedVideo.playsInline = true;
    if (cinemaMode?.classList.contains('active')) cinemaSharedVideo.play().catch(() => {});
  }

  function applyCinemaBgModeB32(mode, persist = true) {
    let safe = ['normal', 'black', 'white', 'animated'].includes(mode) ? mode : 'normal';
    if (safe === 'animated') {
      const globalVideoVisible = !!(bgVideo && !bgVideo.classList.contains('bg-video-hidden') && (bgVideo.currentSrc || bgVideo.src));
      if (!globalVideoVisible) safe = 'normal';
    }
    if (cinemaMode) cinemaMode.classList.remove('bg-black', 'bg-white', 'bg-animated', 'bg-normal');
    if (cinemaMode) cinemaMode.classList.add(`bg-${safe}`);
    cinemaBgButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.cinemaBg === safe));

    if (cinemaSharedVideo) {
      if (safe === 'animated') {
        syncCinemaSharedVideo();
        const hasVideo = !!(cinemaSharedVideo.src || cinemaSharedVideo.currentSrc);
        cinemaSharedVideo.classList.toggle('hidden', !hasVideo);
        if (hasVideo && cinemaMode?.classList.contains('active')) cinemaSharedVideo.play().catch(() => {});
      } else {
        cinemaSharedVideo.pause();
        cinemaSharedVideo.classList.add('hidden');
      }
    }
    if (persist) localStorage.setItem(CINEMA_BG_KEY, safe);
  }

  const savedCinemaBg = ['normal', 'black', 'white', 'animated'].includes(localStorage.getItem(CINEMA_BG_KEY))
    ? localStorage.getItem(CINEMA_BG_KEY) : 'normal';

  cinemaBgButtons.forEach(btn => btn.addEventListener('click', () => {
    playSFX('click');
    applyCinemaBgModeB32(btn.dataset.cinemaBg, true);
  }));

  // Keep the shared video in sync whenever the global background source changes.
  if (bgVideo) {
    ['loadedmetadata', 'canplay', 'loadeddata'].forEach(evt => bgVideo.addEventListener(evt, syncCinemaSharedVideo));
  }
  if (cinemaMode) {
    const cinemaObserver = new MutationObserver(() => {
      if (cinemaMode.classList.contains('active') && localStorage.getItem(CINEMA_BG_KEY) === 'animated') syncCinemaSharedVideo();
    });
    cinemaObserver.observe(cinemaMode, { attributes: true, attributeFilter: ['class'] });
  }

  applyCinemaBgModeB32(savedCinemaBg, false);

  // Legacy global function now delegates to the new source of truth so any old
  // code path that calls applyCinemaBgMode still behaves consistently.
  window.applyCinemaBgMode = (mode) => {
    const mapped = mode === 'black' ? 'black' : mode === 'white' ? 'white' : mode === 'animated' ? 'animated' : 'normal';
    applyCinemaBgModeB32(mapped, true);
  };

  // -------------------------------------------------------
  // 8. RENDIMIENTO PERSONALIZADO
  // -------------------------------------------------------
  const PERF_KEY = 'glasstrackB32PerformanceCustom';
  const perfButtons = document.querySelectorAll('.b32-performance-btn');
  const perfPanel = document.getElementById('b32-performance-custom-panel');
  const perfInputs = {
    bgAnimation: document.getElementById('b32-perf-bg-animation'),
    shadows: document.getElementById('b32-perf-shadows'),
    coverEffects: document.getElementById('b32-perf-cover-effects'),
    animations: document.getElementById('b32-perf-animations'),
    particles: document.getElementById('b32-perf-particles'),
    transitions: document.getElementById('b32-perf-transitions'),
    blur: document.getElementById('b32-perf-blur'),
    visualizerQuality: document.getElementById('b32-perf-visualizer-quality'),
    backgroundQuality: document.getElementById('b32-perf-background-quality'),
    fps: document.getElementById('b32-perf-fps')
  };
  const perfDefaults = {
    bgAnimation: true, shadows: true, coverEffects: true, animations: true,
    particles: true, transitions: true, blur: 12, visualizerQuality: 'medium',
    backgroundQuality: 'medium', fps: 60
  };
  function readPerfCustom() {
    try {
      const raw = readProfileValue(PERF_KEY, activeProfileId, null);
      if (!raw) return { ...perfDefaults };
      const d = JSON.parse(raw);
      return {
        bgAnimation: d.bgAnimation !== false,
        shadows: d.shadows !== false,
        coverEffects: d.coverEffects !== false,
        animations: d.animations !== false,
        particles: d.particles !== false,
        transitions: d.transitions !== false,
        blur: clampB31(d.blur, 0, 24, 12),
        visualizerQuality: ['low','medium','high'].includes(d.visualizerQuality) ? d.visualizerQuality : 'medium',
        backgroundQuality: ['low','medium','high'].includes(d.backgroundQuality) ? d.backgroundQuality : 'medium',
        fps: [30,45,60].includes(Number(d.fps)) ? Number(d.fps) : 60
      };
    } catch (_) { return { ...perfDefaults }; }
  }
  function savePerfCustom(data) { writeProfileValue(PERF_KEY, JSON.stringify(data), activeProfileId); }
  function readPerfInputs() {
    return {
      bgAnimation: !!perfInputs.bgAnimation?.checked,
      shadows: !!perfInputs.shadows?.checked,
      coverEffects: !!perfInputs.coverEffects?.checked,
      animations: !!perfInputs.animations?.checked,
      particles: !!perfInputs.particles?.checked,
      transitions: !!perfInputs.transitions?.checked,
      blur: clampB31(perfInputs.blur?.value, 0, 24, 12),
      visualizerQuality: ['low','medium','high'].includes(perfInputs.visualizerQuality?.value) ? perfInputs.visualizerQuality.value : 'medium',
      backgroundQuality: ['low','medium','high'].includes(perfInputs.backgroundQuality?.value) ? perfInputs.backgroundQuality.value : 'medium',
      fps: [30,45,60].includes(Number(perfInputs.fps?.value)) ? Number(perfInputs.fps.value) : 60
    };
  }
  function fillPerfInputs(data) {
    Object.entries(perfInputs).forEach(([key, input]) => {
      if (!input) return;
      if (input.type === 'checkbox') input.checked = !!data[key];
      else input.value = String(data[key]);
    });
    const blurValue = document.getElementById('b32-perf-blur-value');
    if (blurValue) blurValue.textContent = `${Math.round(data.blur)}px`;
  }
  function applyPerfClasses(profile) {
    BODY.classList.remove('graphics-level-0', 'graphics-level-1', 'b32-perf-custom');
    if (profile === '0') BODY.classList.add('graphics-level-0');
    else if (profile === '1') BODY.classList.add('graphics-level-1');
    else if (profile === 'custom') BODY.classList.add('b32-perf-custom');
  }
  function applyCustomPerf(data, persist = true) {
    BODY.classList.toggle('b32-no-bg-animation', !data.bgAnimation);
    BODY.classList.toggle('b32-no-shadows', !data.shadows);
    BODY.classList.toggle('b32-no-cover-effects', !data.coverEffects);
    BODY.classList.toggle('b32-no-animations', !data.animations);
    BODY.classList.toggle('b32-no-particles', !data.particles);
    BODY.classList.toggle('b32-no-transitions', !data.transitions);
    ROOT.style.setProperty('--b32-perf-blur', `${data.blur}px`);
    ROOT.style.setProperty('--b32-visualizer-bars', data.visualizerQuality === 'low' ? '20' : data.visualizerQuality === 'high' ? '48' : '32');
    ROOT.style.setProperty('--b32-background-quality', data.backgroundQuality);
    BODY.classList.remove('b32-bg-quality-low', 'b32-bg-quality-medium', 'b32-bg-quality-high');
    BODY.classList.add(`b32-bg-quality-${data.backgroundQuality}`);
    if (bgVideo) {
      if (data.bgAnimation) ensureBgVideoPlaying();
      else if (!bgVideo.paused) bgVideo.pause();
    }
    const sharedCinemaVideo = document.getElementById('cinema-shared-bg-video');
    if (sharedCinemaVideo) {
      if (data.bgAnimation && document.getElementById('cinema-mode')?.classList.contains('bg-animated')) sharedCinemaVideo.play().catch(() => {});
      else if (!data.bgAnimation) sharedCinemaVideo.pause();
    }
    window.__glasstrackB32Perf = { ...data };
    if (persist) savePerfCustom(data);
    // El bucle del visualizador se inicia después de que sus referencias estén declaradas.
    window.setTimeout(() => {
      const vizToggle = document.getElementById('toggle-player-visualizer');
      const vizCanvas = document.getElementById('player-visualizer');
      if (!vizToggle?.checked || typeof drawPlayerVisualizer !== 'function') return;
      BODY.classList.add('b32-visualizer-user-enabled');
      vizCanvas?.classList.remove('hidden');
      if (typeof playerVizRafId !== 'undefined' && playerVizRafId === null) drawPlayerVisualizer();
    }, 0);
  }
  const PERF_PROFILE_KEY = 'glasstrackB32PerformanceProfile';
  let currentPerfProfile = readProfileValue(PERF_PROFILE_KEY, activeProfileId, null);
  if (!['0','1','2','custom'].includes(currentPerfProfile)) currentPerfProfile = localStorage.getItem('graphicsLevel');
  if (!['0','1','2','custom'].includes(currentPerfProfile)) currentPerfProfile = '2';
  const savedPerfCustom = readPerfCustom();
  fillPerfInputs(savedPerfCustom);

  function selectPerfProfile(profile, persist = true) {
    const safe = ['0','1','2','custom'].includes(String(profile)) ? String(profile) : '2';
    currentPerfProfile = safe;
    perfButtons.forEach(btn => {
      const active = btn.dataset.performanceProfile === safe;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const custom = safe === 'custom';
    if (perfPanel) {
      perfPanel.classList.toggle('hidden', !custom);
      perfPanel.setAttribute('aria-hidden', custom ? 'false' : 'true');
    }
    if (safe === 'custom') {
      applyPerfClasses('custom');
      applyCustomPerf(readPerfInputs(), persist);
      fillPerfInputs(readPerfInputs());
      if (persist) {
        writeProfileValue(PERF_PROFILE_KEY, 'custom', activeProfileId);
        // Compatibilidad con el motor gráfico antiguo: personalización no significa nivel 0/1.
        localStorage.setItem('graphicsLevel', '2');
      }
    } else {
      applyPerfClasses(safe);
      const profilePerf = safe === '0'
        ? { visualizerQuality: 'low', fps: 30 }
        : safe === '1'
          ? { visualizerQuality: 'medium', fps: 45 }
          : { visualizerQuality: 'high', fps: 60 };
      window.__glasstrackB32Perf = { ...profilePerf };
      ROOT.style.setProperty('--b32-visualizer-bars', profilePerf.visualizerQuality === 'low' ? '20' : profilePerf.visualizerQuality === 'high' ? '48' : '32');
      BODY.classList.remove('b32-no-bg-animation', 'b32-no-shadows', 'b32-no-cover-effects', 'b32-no-animations', 'b32-no-particles', 'b32-no-transitions', 'b32-bg-quality-low', 'b32-bg-quality-medium', 'b32-bg-quality-high');
      if (bgVideo?.src && !bgVideo.classList.contains('bg-video-hidden')) ensureBgVideoPlaying();
      const sharedCinemaVideo = document.getElementById('cinema-shared-bg-video');
      if (sharedCinemaVideo && document.getElementById('cinema-mode')?.classList.contains('bg-animated')) {
        sharedCinemaVideo.play().catch(() => {});
      }
      if (persist) {
        writeProfileValue(PERF_PROFILE_KEY, safe, activeProfileId);
        localStorage.setItem('graphicsLevel', safe);
      }
    }
  }
  perfButtons.forEach(btn => btn.addEventListener('click', () => {
    selectPerfProfile(btn.dataset.performanceProfile, true);
    playSFX('click');
  }));
  Object.values(perfInputs).forEach(input => {
    if (!input) return;
    input.addEventListener('input', () => {
      if (currentPerfProfile !== 'custom') selectPerfProfile('custom', true);
      else applyCustomPerf(readPerfInputs(), true);
      if (input.id === 'b32-perf-blur') {
        const out = document.getElementById('b32-perf-blur-value');
        if (out) out.textContent = `${Math.round(Number(input.value))}px`;
      }
    });
    input.addEventListener('change', () => {
      if (currentPerfProfile !== 'custom') selectPerfProfile('custom', true);
      else applyCustomPerf(readPerfInputs(), true);
    });
  });
  selectPerfProfile(currentPerfProfile, false);

  // -------------------------------------------------------
  // Visualizador: visible por defecto y con el rendimiento real aplicado.
  // Se difiere un tick para no tocar referencias declaradas más abajo en script.js.
  // -------------------------------------------------------
  window.setTimeout(() => {
    const vizToggleB32 = document.getElementById('toggle-player-visualizer');
    const vizCanvasB32 = document.getElementById('player-visualizer');
    if (!vizToggleB32 || !vizCanvasB32) return;
    if (!localStorage.getItem('glasstrackB31PlayerCustomization')) vizToggleB32.checked = true;
    BODY.classList.toggle('b32-visualizer-user-enabled', !!vizToggleB32.checked);
    vizCanvasB32.classList.toggle('hidden', !vizToggleB32.checked);
    if (vizToggleB32.checked && typeof drawPlayerVisualizer === 'function' && typeof playerVizRafId !== 'undefined' && playerVizRafId === null) {
      drawPlayerVisualizer();
    }
    [audio1, audio2].forEach(a => {
      if (!a || a.dataset.b32VizHooked === '1') return;
      a.dataset.b32VizHooked = '1';
      a.addEventListener('play', () => {
        if (!vizToggleB32.checked || typeof drawPlayerVisualizer !== 'function') return;
        vizCanvasB32.classList.remove('hidden');
        if (playerVizRafId === null) drawPlayerVisualizer();
      });
    });
  }, 0);

  // -------------------------------------------------------
  // Reset seguro de las opciones avanzadas de Tanda 1.
  // No toca cuentas, biblioteca, letras ni audio.
  // -------------------------------------------------------
  const resetAdvancedB32 = document.getElementById('btn-reset-advanced-personalization');
  if (resetAdvancedB32) {
    resetAdvancedB32.addEventListener('click', () => {
      if (!confirm('¿Restablecer las opciones avanzadas a la normalidad?')) return;

      localStorage.removeItem('glasstrackB31Appearance');
      localStorage.removeItem('glasstrackB31BackgroundMode');
      localStorage.removeItem('glasstrackB31BackgroundValues');
      localStorage.removeItem('glasstrackB31PlayerCustomization');

      BODY.classList.remove(
        'b31-appearance-customized', 'b31-background-customized',
        'b31-bg-solid', 'b31-bg-gradient', 'b31-bg-dynamic',
        'b31-player-customized',
        'b31-player-hide-top-tools', 'b31-player-hide-cover', 'b31-player-hide-visualizer',
        'b31-player-hide-title', 'b31-player-hide-artist', 'b31-player-hide-progress',
        'b31-player-hide-times', 'b31-player-hide-controls', 'b31-player-hide-volume',
        'b31-player-cover-rotate', 'b31-player-cover-breathe', 'b31-player-cover-pulse', 'b31-player-cover-none',
        'b32-visualizer-user-enabled'
      );

      ROOT.style.setProperty('--b31-glass-blur', '12px');
      ROOT.style.setProperty('--b31-glass-border-alpha', '.08');
      ROOT.style.setProperty('--b31-glass-shadow-alpha', '0');
      ROOT.style.setProperty('--b31-glass-radius', '20px');
      if (inputGlassBlur) inputGlassBlur.value = '12';
      if (inputGlassBorder) inputGlassBorder.value = '0.08';
      if (inputGlassShadow) inputGlassShadow.value = '0.40';
      if (inputGlassRadius) inputGlassRadius.value = '20';
      if (typeof renderB31AppearanceValues === 'function') renderB31AppearanceValues({ blur: 12, border: 0.08, shadow: 0.40, radius: 20 });

      if (selectBgMode) selectBgMode.value = 'stored';
      try {
        if (playerCustomControls.visualizer) playerCustomControls.visualizer.checked = true;
        if (toggleAudioVisualizerForB31) toggleAudioVisualizerForB31.checked = true;
        const vizReset = document.getElementById('player-visualizer');
        if (vizReset) vizReset.classList.remove('hidden');
        BODY.classList.add('b32-visualizer-user-enabled');
      } catch (_) {}
      try {
        if (inputBgSolidColor) inputBgSolidColor.value = '#0a0a0f';
        if (inputBgGradientA) inputBgGradientA.value = '#0a0a0f';
        if (inputBgGradientB) inputBgGradientB.value = '#12131c';
        if (selectBgGradientDirection) selectBgGradientDirection.value = '135deg';
        if (inputBgDarken) inputBgDarken.value = '60';
        if (inputBgBlur) inputBgBlur.value = '0';
        if (inputBgSaturation) inputBgSaturation.value = '100';
        if (typeof applyB31BackgroundVars === 'function') applyB31BackgroundVars();
      } catch (_) {}
      localStorage.setItem('glasstrackB31BackgroundMode', 'stored');
      hideStoredBackgroundLayers();
      loadStoredBackground();

      Object.keys(playerCustomControls || {}).forEach(key => { if (playerCustomControls[key]) playerCustomControls[key].checked = key === 'visualizer' ? true : true; });
      if (inputPlayerCoverRadius) inputPlayerCoverRadius.value = '50';
      if (inputPlayerCoverIntensity) inputPlayerCoverIntensity.value = '100';
      if (selectPlayerCoverAnimation) selectPlayerCoverAnimation.value = 'rotate';
      if (typeof applyB31PlayerCustomization === 'function') applyB31PlayerCustomization(false);
      if (playerCustomControls?.visualizer) playerCustomControls.visualizer.checked = true;
      if (playerVisualizerCanvas) playerVisualizerCanvas.classList.remove('hidden');
      if (toggleAudioVisualizer) toggleAudioVisualizer.checked = true;
      if (toggleAudioVisualizer) toggleAudioVisualizer.dispatchEvent(new Event('change'));

      playSFX('click');
      showToast('Personalización avanzada restablecida.', 'success');
    });
  }

  // Reaplica la personalización B32 cuando se cambia de cuenta sin recargar la página.
  document.addEventListener('glasstrack:profile-switched', () => {
    applyB32FontSettings(readB32FontSettings(), false);
    applyLyricsCustomization(readLyricsCustomization(), false);
    const profileSetting = readProfileValue(PERF_PROFILE_KEY, activeProfileId, null);
    const legacySetting = ['0','1','2'].includes(localStorage.getItem('graphicsLevel')) ? localStorage.getItem('graphicsLevel') : '2';
    selectPerfProfile(['0','1','2','custom'].includes(profileSetting) ? profileSetting : legacySetting, false);
  });
})();

// ==========================================
// MODO CONCLUIDOR (cadena de canciones + mezcla en secuencia, con recorte por pista)
// ==========================================
function songKeyOf(song) {
  return song.id !== undefined ? ('id:' + song.id) : (song.title + '||' + song.artist);
}

let concludorChain = []; // [{ song, clipStart, clipEnd, clipDuration, fadeAt, fadeOutDuration }]
let concludorPlaying = false;
let concludorPosition = 0;
let concludorPreviewAudio = null;
let concludorMixMode = ['fluid', 'rhythm', 'manual', 'smart'].includes(localStorage.getItem('concludorMixMode')) ? localStorage.getItem('concludorMixMode') : 'fluid';

const CONCLUDOR_MODE_LABELS = {
  fluid: 'Fluido',
  rhythm: 'Ritmo',
  manual: 'Manual',
  smart: 'Inteligente'
};
const CONCLUDOR_MODE_DESCRIPTIONS = {
  fluid: 'Las canciones se conectan automáticamente con un fundido suave y configurable.',
  rhythm: 'Usa fundidos más largos y envolventes para dar continuidad al ritmo. No realiza detección exacta de BPM.',
  manual: 'La mezcla espera tu indicación: usa “Transición siguiente” cuando quieras pasar a la próxima pista.',
  smart: 'Ajusta la duración del fundido según el tamaño de los fragmentos de ambas canciones.'
};

function setConcludorMixMode(mode, persist = true) {
  if (!Object.prototype.hasOwnProperty.call(CONCLUDOR_MODE_LABELS, mode)) mode = 'fluid';
  concludorMixMode = mode;
  if (persist) localStorage.setItem('concludorMixMode', mode);
  document.querySelectorAll('[data-concludor-mode]').forEach(button => {
    const selected = button.dataset.concludorMode === mode;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
  const description = document.getElementById('concludor-mode-description');
  if (description) description.textContent = CONCLUDOR_MODE_DESCRIPTIONS[mode];
  const footerMode = document.getElementById('concludor-footer-mode');
  if (footerMode) footerMode.textContent = `MODO ${CONCLUDOR_MODE_LABELS[mode].toUpperCase()}`;
  const hint = document.getElementById('concludor-playback-hint');
  if (hint) hint.textContent = mode === 'manual'
    ? 'La transición espera tu orden. Usa “Transición siguiente” cuando decidas.'
    : mode === 'smart'
      ? 'El fundido se adapta a la duración de cada fragmento.'
      : mode === 'rhythm'
        ? 'Transiciones extendidas para una mezcla más envolvente.'
        : 'Prepara tu lista y disfruta de transiciones automáticas.';
  const nextButton = document.getElementById('btn-concludor-next');
  if (nextButton) nextButton.title = mode === 'manual' ? 'Iniciar la siguiente transición manualmente' : 'Pasar manualmente a la siguiente pista';
}

function getConcludorFadeSeconds(index = concludorPosition) {
  const entry = concludorChain[index];
  const nextEntry = concludorChain[index + 1];
  if (!entry) return 1;
  const base = Math.max(0.5, Math.min(8, Number(entry.fadeOutDuration) || Number(document.getElementById('concludor-crossfade')?.value) || 3));
  let seconds = base;
  if (concludorMixMode === 'rhythm') seconds = Math.max(base, 4.5);
  if (concludorMixMode === 'smart' && nextEntry) {
    const a = Math.max(1, Number(entry.clipDuration) || 20);
    const b = Math.max(1, Number(nextEntry.clipDuration) || 20);
    seconds = Math.max(1, Math.min(8, Math.round(Math.min(a, b) * 0.18 * 2) / 2));
  }
  const fadeAt = entry.fadeAt !== undefined ? entry.fadeAt : (entry.clipEnd || ((entry.clipStart || 0) + (entry.clipDuration || 20)));
  const available = Math.max(0.5, fadeAt - (entry.clipStart || 0));
  return Math.max(0.5, Math.min(8, seconds, available));
}

function renderConcludorStudioState() {
  const count = concludorChain.length;
  const safePosition = count ? Math.max(0, Math.min(concludorPosition, count - 1)) : 0;
  const current = count ? concludorChain[safePosition] : null;
  const next = count > 0 && safePosition + 1 < count ? concludorChain[safePosition + 1] : null;
  const totalSeconds = concludorChain.reduce((sum, entry) => sum + Math.max(0, Number(entry.clipDuration) || 0), 0);
  const countEl = document.getElementById('concludor-track-count');
  const totalEl = document.getElementById('concludor-total-duration');
  const statusEl = document.getElementById('concludor-status');
  const nowTitle = document.getElementById('concludor-now-title');
  const nowArtist = document.getElementById('concludor-now-artist');
  const nowCover = document.getElementById('concludor-now-cover');
  const currentLabel = document.getElementById('concludor-current-index');
  const nextTitle = document.getElementById('concludor-up-next-title');
  const nextArtist = document.getElementById('concludor-up-next-artist');
  const nextCover = document.getElementById('concludor-next-cover');
  const waveState = document.getElementById('concludor-wave-state');
  const playButton = document.getElementById('btn-concludor-play');
  const nextButton = document.getElementById('btn-concludor-next');
  const clearButton = document.getElementById('btn-concludor-clear');

  if (countEl) countEl.textContent = `${count} ${count === 1 ? 'pista' : 'pistas'}`;
  if (totalEl) totalEl.textContent = `Duración total: ${formatTime(totalSeconds)}`;
  if (statusEl) {
    statusEl.classList.toggle('is-playing', concludorPlaying);
    statusEl.innerHTML = `<i></i>${concludorPlaying ? ' MEZCLA ACTIVA' : count ? ' LISTO PARA MEZCLAR' : ' AÑADE CANCIONES'}`;
  }
  if (nowTitle) nowTitle.textContent = current ? current.song.title : 'Tu próxima mezcla empieza aquí';
  if (nowArtist) nowArtist.textContent = current ? current.song.artist : 'Agrega música para crear una secuencia.';
  if (nowCover) {
    if (current?.song?.cover) nowCover.src = current.song.cover;
    else nowCover.removeAttribute('src');
    nowCover.alt = current ? `Portada de ${current.song.title}` : 'Sin portada seleccionada';
  }
  if (currentLabel) currentLabel.textContent = current ? `PISTA ${safePosition + 1} DE ${count}${concludorPlaying ? ' · EN REPRODUCCIÓN' : ' · PREPARADA'}` : 'LISTO PARA EMPEZAR';
  if (nextTitle) nextTitle.textContent = next ? next.song.title : count ? 'Última pista de la secuencia' : 'Añade una segunda pista';
  if (nextArtist) nextArtist.textContent = next ? next.song.artist : count ? 'No hay otra canción en cola' : 'Tu mezcla aparecerá aquí';
  if (nextCover) {
    if (next?.song?.cover) nextCover.src = next.song.cover;
    else nextCover.removeAttribute('src');
  }
  if (waveState) waveState.textContent = concludorPlaying ? 'SEÑAL ACTIVA' : 'EN ESPERA';
  if (playButton && !concludorPlaying) playButton.textContent = '▶ Iniciar mezcla';
  if (nextButton) nextButton.disabled = count < 2;
  if (clearButton) clearButton.disabled = count === 0;
}

function findSongByKey(key) {
  if (key.startsWith('id:')) {
    const idVal = key.slice(3);
    return songList.find(s => String(s.id) === idVal);
  }
  const [t, a] = key.split('||');
  return songList.find(s => s.title === t && s.artist === a);
}

function loadConcludorChain() {
  let stored = [];
  try { stored = JSON.parse(localStorage.getItem('concludorChain') || '[]'); } catch (e) { stored = []; }
  concludorChain = stored.map(entry => {
    const song = findSongByKey(entry.key);
    if (!song) return null;
    const clipStart = entry.clipStart || 0;
    const clipEnd = entry.clipEnd !== undefined ? entry.clipEnd : clipStart + (entry.clipDuration || 20);
    return {
      song, clipStart, clipEnd, clipDuration: clipEnd - clipStart,
      fadeAt: entry.fadeAt !== undefined ? entry.fadeAt : clipEnd,
      fadeOutDuration: entry.fadeOutDuration !== undefined ? entry.fadeOutDuration : 2
    };
  }).filter(Boolean);
}
function saveConcludorChain() {
  localStorage.setItem('concludorChain', JSON.stringify(concludorChain.map(e => ({
    key: songKeyOf(e.song), clipStart: e.clipStart, clipEnd: e.clipEnd,
    fadeAt: e.fadeAt, fadeOutDuration: e.fadeOutDuration
  }))));
}

function escapeConcludorHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function renderConcludorCarousel() {
  const carousel = document.getElementById('concludor-carousel');
  const cable = document.getElementById('concludor-cable');
  if (!carousel) return;
  if (cable) cable.style.display = 'none';
  if (concludorChain.length === 0) {
    carousel.innerHTML = `<div class="concludor-empty-state"><span class="concludor-empty-icon">♫</span><strong>Tu mezcla está vacía</strong><p>Agrega música desde tu biblioteca o importa pistas locales.</p><button type="button" class="concludor-empty-add" data-concludor-open-add>＋ Agregar canciones</button></div>`;
    carousel.querySelector('[data-concludor-open-add]')?.addEventListener('click', () => document.getElementById('btn-concludor-add')?.click());
    renderConcludorStudioState();
    return;
  }

  carousel.innerHTML = concludorChain.map((entry, i) => `
    <article class="concludor-track-row ${concludorPlaying && i === concludorPosition ? 'is-current' : ''}" data-idx="${i}">
      <span class="concludor-track-number">${String(i + 1).padStart(2, '0')}</span>
      <img class="concludor-track-cover" src="${escapeConcludorHtml(entry.song.cover)}" alt="">
      <span class="concludor-track-copy"><strong title="${escapeConcludorHtml(entry.song.title)}">${escapeConcludorHtml(entry.song.title)}</strong><small title="${escapeConcludorHtml(entry.song.artist)}">${escapeConcludorHtml(entry.song.artist)}</small><em>${concludorPlaying && i === concludorPosition ? 'SONANDO AHORA' : (i === concludorPosition ? 'SELECCIONADA' : `PISTA ${String(i + 1).padStart(2, '0')}`)}</em></span>
      <span class="concludor-track-duration">${formatTime(entry.clipDuration || 0)}</span>
      <div class="concludor-track-actions">
        <button class="concludor-edit-clip" data-idx="${i}" type="button" title="Editar fragmento y conexión" aria-label="Editar ${escapeConcludorHtml(entry.song.title)}">✎</button>
        <button class="concludor-move-up" data-idx="${i}" type="button" title="Mover antes" aria-label="Mover arriba" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="concludor-move-down" data-idx="${i}" type="button" title="Mover después" aria-label="Mover abajo" ${i === concludorChain.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="concludor-remove" data-idx="${i}" type="button" title="Quitar pista" aria-label="Quitar ${escapeConcludorHtml(entry.song.title)}">×</button>
      </div>
    </article>
  `).join('');

  carousel.querySelectorAll('.concludor-track-row').forEach(row => {
    row.addEventListener('click', (event) => {
      if (event.target.closest('button') || concludorPlaying) return;
      const idx = Number(row.dataset.idx);
      if (Number.isInteger(idx) && concludorChain[idx]) {
        concludorPosition = idx;
        renderConcludorCarousel();
      }
    });
  });
  carousel.querySelectorAll('.concludor-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      playSFX('click');
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      const wasCurrent = concludorPlaying && idx === concludorPosition;
      concludorChain.splice(idx, 1);
      if (idx < concludorPosition) concludorPosition -= 1;
      else if (wasCurrent) {
        // La entrada actual desapareció de la cola: invalida cargas/fundidos antes de renderizar.
        stopConcludorPlayback({ resetPosition: false, render: false });
      }
      if (concludorPosition >= concludorChain.length) concludorPosition = Math.max(0, concludorChain.length - 1);
      saveConcludorChain();
      renderConcludorCarousel();
    });
  });
  carousel.querySelectorAll('.concludor-move-up').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      playSFX('click');
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      if (idx > 0) {
        [concludorChain[idx - 1], concludorChain[idx]] = [concludorChain[idx], concludorChain[idx - 1]];
        if (concludorPosition === idx) concludorPosition -= 1;
        else if (concludorPosition === idx - 1) concludorPosition += 1;
        saveConcludorChain();
        renderConcludorCarousel();
      }
    });
  });
  carousel.querySelectorAll('.concludor-move-down').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      playSFX('click');
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      if (idx < concludorChain.length - 1) {
        [concludorChain[idx + 1], concludorChain[idx]] = [concludorChain[idx], concludorChain[idx + 1]];
        if (concludorPosition === idx) concludorPosition += 1;
        else if (concludorPosition === idx + 1) concludorPosition -= 1;
        saveConcludorChain();
        renderConcludorCarousel();
      }
    });
  });
  carousel.querySelectorAll('.concludor-edit-clip').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      playSFX('click');
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      const entry = concludorChain[idx];
      if (!entry) return;
      renderConcludorAddList();
      openModal(document.getElementById('modal-concludor-add'));
      openConcludorTrimView(entry.song, entry, idx);
    });
  });
  renderConcludorStudioState();
}

function renderConcludorAddList(filterText) {
  const list = document.getElementById('concludor-add-list');
  const trimView = document.getElementById('concludor-trim-view');
  if (!list) return;
  list.classList.remove('hidden');
  if (trimView) trimView.classList.add('hidden');
  if (songList.length === 0) {
    list.innerHTML = '<li class="empty-msg">No tienes canciones cargadas todavía.</li>';
    return;
  }
  const term = (filterText || '').trim().toLowerCase();
  const visibleSongs = songList
    .map((song, i) => ({ song, i }))
    .filter(({ song }) => !term || song.title.toLowerCase().includes(term) || song.artist.toLowerCase().includes(term));

  if (visibleSongs.length === 0) {
    list.innerHTML = '<li class="empty-msg">Sin resultados para esa búsqueda.</li>';
    return;
  }
  list.innerHTML = visibleSongs.map(({ song, i }) => `<li class="playlist-item" data-idx="${i}" style="cursor:pointer;">
      <img src="${song.cover}" alt="" style="width:44px;height:44px;border-radius:8px;object-fit:cover;flex-shrink:0;">
      <div style="flex:1;overflow:hidden;">
        <div style="font-size:0.85rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${song.title}</div>
        <div style="font-size:0.73rem;color:var(--text-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${song.artist}</div>
      </div>
      <button class="menu-opt-btn concludor-choose-one" data-idx="${i}" style="width:auto;padding:8px 14px;font-size:0.75rem;flex-shrink:0;">Elegir</button>
    </li>`).join('');
  list.querySelectorAll('.concludor-choose-one').forEach(btn => {
    btn.addEventListener('click', (e) => {
      playSFX('click');
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      openConcludorTrimView(songList[idx]);
    });
  });
}

const concludorSearchInput = document.getElementById('concludor-search');
if (concludorSearchInput) {
  concludorSearchInput.addEventListener('input', (e) => renderConcludorAddList(e.target.value));
}

let trimTargetSong = null;
let trimEditingIndex = null; // si no es null, estamos EDITANDO esa entrada de la cadena, no agregando una nueva
let trimClipStart = 0;
let trimClipEnd = 20;
let trimFadeAt = 20; // segundo (relativo a 0, igual que start/end) donde se conecta con la siguiente canción
let trimDuration = 180;
let trimAudioBuffer = null;

function redrawTrimWaveform() {
  const canvas = document.getElementById('concludor-trim-waveform');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (trimAudioBuffer) {
    const data = trimAudioBuffer.getChannelData(0);
    const step = Math.ceil(data.length / w);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    for (let x = 0; x < w; x++) {
      let min = 1.0, max = -1.0;
      const base = x * step;
      for (let j = 0; j < step; j += 4) {
        const idx = base + j;
        if (idx >= data.length) break;
        const v = data[idx];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const y1 = (1 + min) * h / 2;
      const y2 = (1 + max) * h / 2;
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
  }

  const startX = (trimClipStart / trimDuration) * w;
  const endX = (trimClipEnd / trimDuration) * w;
  const fadeX = (trimFadeAt / trimDuration) * w;

  // Región seleccionada (el fragmento que se va a usar), resaltada en amarillo neón
  ctx.fillStyle = 'rgba(255, 229, 0, 0.22)';
  ctx.fillRect(startX, 0, endX - startX, h);
  ctx.fillStyle = '#FFE500';
  ctx.fillRect(startX - 1, 0, 3, h);
  ctx.fillRect(endX - 1, 0, 3, h);

  // Línea blanca: el segundo exacto de conexión con la siguiente canción
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 6;
  ctx.fillRect(fadeX - 1, 0, 3, h);
  ctx.shadowBlur = 0;
}

function updateTrimTimeLabels() {
  const startVal = document.getElementById('concludor-trim-start-value');
  const endVal = document.getElementById('concludor-trim-end-value');
  const fadeVal = document.getElementById('concludor-trim-fade-value');
  if (startVal) startVal.textContent = formatTime(trimClipStart);
  if (endVal) endVal.textContent = formatTime(trimClipEnd);
  if (fadeVal) fadeVal.textContent = formatTime(trimFadeAt);
}

// Arrastre: detecta cuál de los 3 controles (inicio, fin, conexión) está más cerca del punto tocado
let trimDragMode = null;
function pickTrimHandle(canvas, clientX) {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const startX = (trimClipStart / trimDuration) * rect.width;
  const endX = (trimClipEnd / trimDuration) * rect.width;
  const fadeX = (trimFadeAt / trimDuration) * rect.width;
  const distances = [
    { mode: 'fade', d: Math.abs(x - fadeX) },
    { mode: 'start', d: Math.abs(x - startX) },
    { mode: 'end', d: Math.abs(x - endX) }
  ].sort((a, b) => a.d - b.d);
  return distances[0].mode;
}
function dragTrimHandle(canvas, clientX) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const t = Math.round(ratio * trimDuration * 10) / 10;
  if (trimDragMode === 'start') {
    trimClipStart = Math.min(t, trimClipEnd - 1);
    if (trimFadeAt < trimClipStart) trimFadeAt = trimClipStart;
  } else if (trimDragMode === 'end') {
    trimClipEnd = Math.max(t, trimClipStart + 1);
    if (trimFadeAt > trimClipEnd) trimFadeAt = trimClipEnd;
  } else if (trimDragMode === 'fade') {
    trimFadeAt = Math.max(trimClipStart, Math.min(t, trimClipEnd));
  }
  updateTrimTimeLabels();
  redrawTrimWaveform();
}

function openConcludorTrimView(song, existingEntry, existingIndex) {
  trimTargetSong = song;
  trimEditingIndex = existingIndex !== undefined ? existingIndex : null;
  trimClipStart = existingEntry ? existingEntry.clipStart : 0;
  trimClipEnd = existingEntry ? existingEntry.clipEnd : 20;
  trimFadeAt = existingEntry && existingEntry.fadeAt !== undefined ? existingEntry.fadeAt : trimClipEnd;
  trimAudioBuffer = null;
  const list = document.getElementById('concludor-add-list');
  const trimView = document.getElementById('concludor-trim-view');
  const trimCover = document.getElementById('concludor-trim-cover');
  const trimTitle = document.getElementById('concludor-trim-title');
  const trimArtist = document.getElementById('concludor-trim-artist');
  const fadeoutInput = document.getElementById('concludor-trim-fadeout');
  const fadeoutVal = document.getElementById('concludor-trim-fadeout-value');
  const confirmBtn = document.getElementById('btn-concludor-confirm-add');
  if (!trimView) return;

  if (trimCover) trimCover.src = song.cover;
  if (trimTitle) trimTitle.textContent = song.title;
  if (trimArtist) trimArtist.textContent = song.artist;
  const fadeOutValue = existingEntry ? (existingEntry.fadeOutDuration || 2) : (parseFloat(document.getElementById('concludor-crossfade')?.value) || 3);
  if (fadeoutInput) fadeoutInput.value = fadeOutValue;
  if (fadeoutVal) fadeoutVal.textContent = fadeOutValue.toFixed(1) + 's';
  if (confirmBtn) confirmBtn.textContent = existingEntry ? 'Guardar Cambios' : 'Agregar a la Cadena';
  updateTrimTimeLabels();

  if (list) list.classList.add('hidden');
  trimView.classList.remove('hidden');

  // Decodificamos el audio real para dibujar su forma de onda de verdad (no es decorativo)
  initAudioContext();
  fetch(song.url)
    .then(res => res.arrayBuffer())
    .then(buf => audioCtx.decodeAudioData(buf))
    .then(audioBuffer => {
      trimAudioBuffer = audioBuffer;
      trimDuration = audioBuffer.duration || 180;
      if (!existingEntry) { trimClipEnd = Math.min(20, trimDuration); trimFadeAt = trimClipEnd; updateTrimTimeLabels(); }
      redrawTrimWaveform();
    })
    .catch(() => { trimDuration = 180; redrawTrimWaveform(); });
}

const concludorTrimFadeoutInput = document.getElementById('concludor-trim-fadeout');
if (concludorTrimFadeoutInput) {
  concludorTrimFadeoutInput.addEventListener('input', (e) => {
    const el = document.getElementById('concludor-trim-fadeout-value');
    if (el) el.textContent = parseFloat(e.target.value).toFixed(1) + 's';
  });
}

const concludorTrimCanvas = document.getElementById('concludor-trim-waveform');
if (concludorTrimCanvas) {
  concludorTrimCanvas.addEventListener('mousedown', (e) => { trimDragMode = pickTrimHandle(concludorTrimCanvas, e.clientX); dragTrimHandle(concludorTrimCanvas, e.clientX); });
  window.addEventListener('mousemove', (e) => { if (trimDragMode) dragTrimHandle(concludorTrimCanvas, e.clientX); });
  window.addEventListener('mouseup', () => { trimDragMode = null; });
  concludorTrimCanvas.addEventListener('touchstart', (e) => { trimDragMode = pickTrimHandle(concludorTrimCanvas, e.touches[0].clientX); dragTrimHandle(concludorTrimCanvas, e.touches[0].clientX); }, { passive: true });
  window.addEventListener('touchmove', (e) => { if (trimDragMode) dragTrimHandle(concludorTrimCanvas, e.touches[0].clientX); }, { passive: true });
  window.addEventListener('touchend', () => { trimDragMode = null; });
}

let concludorPlaybackToken = 0;
let concludorFadeTimer = null;
let concludorMonitorTimer = null;
let concludorPendingMetadata = null;
let concludorCrossfadeInProgress = false;
let concludorAudioOwned = false;
let concludorPreviewTimer = null;
let concludorPreviewToken = 0;
let concludorPreviewPendingMetadata = null;

function clearConcludorPendingMetadata() {
  if (!concludorPendingMetadata) return;
  const pending = concludorPendingMetadata;
  concludorPendingMetadata = null;
  try { pending.audio.removeEventListener('loadedmetadata', pending.handler); } catch (_) {}
}

function stopConcludorPreview(expectedToken) {
  if (expectedToken !== undefined && expectedToken !== concludorPreviewToken) return;
  concludorPreviewToken += 1;
  if (concludorPreviewTimer !== null) { clearTimeout(concludorPreviewTimer); concludorPreviewTimer = null; }
  if (concludorPreviewPendingMetadata) {
    const pending = concludorPreviewPendingMetadata;
    concludorPreviewPendingMetadata = null;
    try { pending.audio.removeEventListener('loadedmetadata', pending.handler); } catch (_) {}
  }
  if (concludorPreviewAudio) {
    try { concludorPreviewAudio.pause(); } catch (_) {}
    try { concludorPreviewAudio.removeAttribute('src'); concludorPreviewAudio.load(); } catch (_) {}
    concludorPreviewAudio = null;
  }
}

function stopConcludorMonitor() {
  if (concludorMonitorTimer !== null) { clearInterval(concludorMonitorTimer); concludorMonitorTimer = null; }
}

function startConcludorMonitor() {
  if (concludorMonitorTimer === null) concludorMonitorTimer = setInterval(tickConcludorMonitor, 300);
}

function stopConcludorPlayback(options = {}) {
  const stopSharedAudio = !!(concludorAudioOwned || concludorPlaying);
  concludorPlaybackToken += 1;
  clearConcludorPendingMetadata();
  if (concludorFadeTimer !== null) { clearInterval(concludorFadeTimer); concludorFadeTimer = null; }
  concludorCrossfadeInProgress = false;
  stopConcludorMonitor();
  stopConcludorPreview();
  if (stopSharedAudio) {
    [audio1, audio2].forEach(audio => { try { audio.pause(); } catch (_) {} });
  }
  concludorAudioOwned = false;
  concludorPlaying = false;
  concludorFadeTriggered = false;
  if (options.resetPosition) concludorPosition = 0;
  if (btnConcludorPlay) btnConcludorPlay.textContent = '▶ Iniciar mezcla';
  const waveState = document.getElementById('concludor-wave-state');
  if (waveState) waveState.textContent = 'EN ESPERA';
  if (concludorRafId !== null) { cancelAnimationFrame(concludorRafId); concludorRafId = null; }
  if (options.render !== false && typeof renderConcludorCarousel === 'function') renderConcludorCarousel();
}

const btnConcludorPreview = document.getElementById('btn-concludor-preview');
if (btnConcludorPreview) {
  btnConcludorPreview.addEventListener('click', () => {
    playSFX('click');
    if (!trimTargetSong) return;
    stopConcludorPreview();
    const previewToken = concludorPreviewToken;
    const preview = new Audio(trimTargetSong.url);
    concludorPreviewAudio = preview;
    const startAt = trimClipStart;
    const durationMs = Math.max(0.5, trimClipEnd - trimClipStart) * 1000;
    const startPreview = () => {
      if (previewToken !== concludorPreviewToken || concludorPreviewAudio !== preview) return;
      if (concludorPreviewPendingMetadata && concludorPreviewPendingMetadata.handler === startPreview) concludorPreviewPendingMetadata = null;
      try { preview.currentTime = startAt; } catch (_) {}
      Promise.resolve(preview.play()).catch(() => {});
      concludorPreviewTimer = window.setTimeout(() => stopConcludorPreview(previewToken), durationMs);
    };
    if (preview.readyState >= 1) startPreview();
    else {
      concludorPreviewPendingMetadata = { audio: preview, handler: startPreview };
      preview.addEventListener('loadedmetadata', startPreview, { once: true });
    }
  });
}

const btnConcludorBackList = document.getElementById('btn-concludor-back-list');
if (btnConcludorBackList) {
  btnConcludorBackList.addEventListener('click', () => {
    playSFX('click');
    stopConcludorPreview();
    if (concludorSearchInput) concludorSearchInput.value = '';
    renderConcludorAddList();
  });
}

const btnConcludorConfirmAdd = document.getElementById('btn-concludor-confirm-add');
if (btnConcludorConfirmAdd) {
  btnConcludorConfirmAdd.addEventListener('click', () => {
    playSFX('click');
    if (!trimTargetSong) return;
    stopConcludorPreview();
    const fadeoutInput = document.getElementById('concludor-trim-fadeout');
    const entry = {
      song: trimTargetSong,
      clipStart: trimClipStart,
      clipEnd: trimClipEnd,
      clipDuration: trimClipEnd - trimClipStart,
      fadeAt: trimFadeAt,
      fadeOutDuration: fadeoutInput ? parseFloat(fadeoutInput.value) : 2
    };
    const wasEditing = trimEditingIndex !== null;
    if (trimEditingIndex !== null) concludorChain[trimEditingIndex] = entry;
    else concludorChain.push(entry);
    saveConcludorChain();
    renderConcludorCarousel();
    trimTargetSong = null;
    trimEditingIndex = null;
    closeModal(document.getElementById('modal-concludor-add'));
    showToast(wasEditing ? 'Cambios guardados.' : 'Canción agregada a la cadena.', 'info', 2500);
  });
}

// Dispara el crossfade real hacia la siguiente canción de la cadena, respetando el punto
// de conexión y el fundido configurados en el editor (antes esto se ignoraba por completo).
let concludorFadeTriggered = false;

function triggerConcludorCrossfade() {
  if (!concludorPlaying || !concludorAudioOwned || concludorCrossfadeInProgress) return;
  const nextIndex = concludorPosition + 1;
  if (nextIndex >= concludorChain.length) return;
  const nextEntry = concludorChain[nextIndex];
  const realIndex = songList.indexOf(nextEntry.song);
  if (realIndex < 0) {
    concludorPosition = nextIndex;
    advanceConcludorChain();
    return;
  }

  const currentEntry = concludorChain[concludorPosition];
  const fadeSeconds = getConcludorFadeSeconds(concludorPosition);
  const nextAudio = (activeAudio === audio1) ? audio2 : audio1;
  const currentAudio = activeAudio;
  clearConcludorPendingMetadata();
  if (concludorFadeTimer !== null) { clearInterval(concludorFadeTimer); concludorFadeTimer = null; }
  const requestToken = ++concludorPlaybackToken;
  concludorCrossfadeInProgress = true;
  concludorAudioOwned = true;

  initAudioContext();
  nextAudio.pause();
  nextAudio.src = nextEntry.song.url;
  nextAudio.volume = 0;

  // Espera a metadatos para aplicar el punto de inicio; el token cancela cualquier
  // carga pendiente si el usuario cambia de pista, detiene o cierra Concluidor.
  let startInvoked = false;
  const startCrossfadePlayback = () => {
    if (startInvoked) return;
    startInvoked = true;
    if (concludorPendingMetadata && concludorPendingMetadata.handler === startCrossfadePlayback) concludorPendingMetadata = null;
    if (requestToken !== concludorPlaybackToken || !concludorPlaying || !concludorAudioOwned) return;
    try { nextAudio.currentTime = nextEntry.clipStart || 0; } catch (_) {}
    Promise.resolve(nextAudio.play()).then(() => {
      if (requestToken !== concludorPlaybackToken || !concludorPlaying || !concludorAudioOwned) return;
      const tickMs = 60;
      const steps = Math.max(1, Math.ceil((fadeSeconds * 1000) / tickMs));
      const targetVol = Math.max(0, Math.min(1, volumeSlider ? parseFloat(volumeSlider.value) : 1));
      const currentStartVolume = Math.max(0, Math.min(1, currentAudio ? currentAudio.volume : 0));
      let stepCount = 0;
      activeAudio = nextAudio;
      concludorPosition = nextIndex;
      concludorFadeTriggered = false;

      // Mantiene el fundido durante la sesión; al invalidar la sesión, el timer se cancela.
      concludorFadeTimer = setInterval(() => {
        if (requestToken !== concludorPlaybackToken || !concludorPlaying || !concludorAudioOwned) {
          if (concludorFadeTimer !== null) { clearInterval(concludorFadeTimer); concludorFadeTimer = null; }
          return;
        }
        stepCount += 1;
        const progress = Math.min(1, stepCount / steps);
        if (currentAudio) {
          currentAudio.volume = currentStartVolume * (1 - progress);
          if (progress >= 1) { currentAudio.volume = 0; currentAudio.pause(); }
        }
        nextAudio.volume = targetVol * progress;
        if (progress >= 1) {
          nextAudio.volume = targetVol;
          clearInterval(concludorFadeTimer); concludorFadeTimer = null;
          concludorCrossfadeInProgress = false;
        }
      }, tickMs);

      currentIndex = realIndex;
      const song = nextEntry.song;
      if (title) title.textContent = song.title;
      if (artist) artist.textContent = song.artist;
      if (cover) cover.src = song.cover;
      if (playerBgFluid) playerBgFluid.style.backgroundImage = `url(${song.cover})`;
      if (lyricsBg) lyricsBg.style.backgroundImage = `url(${song.cover})`;
      if (cinemaCover) cinemaCover.src = song.cover;
      if (cinemaTitle) cinemaTitle.textContent = song.title;
      if (cinemaArtist) cinemaArtist.textContent = song.artist;
      if (cinemaBg) cinemaBg.style.backgroundImage = `url(${song.cover})`;
      applyLyricsCalibration(song);
      displayLyrics(song.lyrics);
      updateMediaSession(song);
      syncMiniPlayer(true);
      syncVehicleMode();
      syncMobileNowPlaying();
      renderPlaylist();
      renderConcludorCarousel();
    }).catch(err => {
      if (requestToken !== concludorPlaybackToken) return;
      concludorCrossfadeInProgress = false;
      try { nextAudio.pause(); } catch (_) {}
      console.error('Error en crossfade del Concluidor:', err);
      showToast('No se pudo iniciar la siguiente pista. La mezcla sigue disponible para reintentarlo.', 'error', 3000);
    });
  };

  if (nextAudio.readyState >= 1) startCrossfadePlayback();
  else {
    concludorPendingMetadata = { audio: nextAudio, handler: startCrossfadePlayback };
    nextAudio.addEventListener('loadedmetadata', startCrossfadePlayback, { once: true });
  }
}

function playConcludorEntry(entry) {
  const realIndex = songList.indexOf(entry.song);
  if (realIndex < 0) { advanceConcludorChain(); return; }

  clearConcludorPendingMetadata();
  if (concludorFadeTimer !== null) { clearInterval(concludorFadeTimer); concludorFadeTimer = null; }
  concludorCrossfadeInProgress = false;
  const requestToken = ++concludorPlaybackToken;
  concludorAudioOwned = true;
  initAudioContext();
  audio1.pause();
  audio2.pause();
  activeAudio = audio1;
  currentIndex = realIndex;
  activeAudio.src = entry.song.url;
  activeAudio.volume = Math.max(0, Math.min(1, volumeSlider ? parseFloat(volumeSlider.value) : 1));
  const entryAudio = activeAudio;
  const entryUrl = entry.song.url;

  let startInvoked = false;
  const startPlayback = () => {
    if (startInvoked) return;
    startInvoked = true;
    if (concludorPendingMetadata && concludorPendingMetadata.handler === startPlayback) concludorPendingMetadata = null;
    if (requestToken !== concludorPlaybackToken || !concludorPlaying || !concludorAudioOwned || !sourceMatches(entryAudio, entryUrl)) return;
    try { entryAudio.currentTime = entry.clipStart || 0; } catch (_) {}
    Promise.resolve(entryAudio.play()).catch(err => {
      if (requestToken === concludorPlaybackToken) console.error('Error al reproducir en Concluidor:', err);
    });
  };
  if (entryAudio.readyState >= 1) startPlayback();
  else {
    concludorPendingMetadata = { audio: entryAudio, handler: startPlayback };
    entryAudio.addEventListener('loadedmetadata', startPlayback, { once: true });
  }

  const song = entry.song;
  if (title) title.textContent = song.title;
  if (artist) artist.textContent = song.artist;
  if (cover) cover.src = song.cover;
  if (playerBgFluid) playerBgFluid.style.backgroundImage = `url(${song.cover})`;
  if (lyricsBg) lyricsBg.style.backgroundImage = `url(${song.cover})`;
  if (cinemaCover) cinemaCover.src = song.cover;
  if (cinemaTitle) cinemaTitle.textContent = song.title;
  if (cinemaArtist) cinemaArtist.textContent = song.artist;
  if (cinemaBg) cinemaBg.style.backgroundImage = `url(${song.cover})`;
  applyLyricsCalibration(song);
  displayLyrics(song.lyrics);
  updateMediaSession(song);
  syncMiniPlayer(true);
  syncVehicleMode();
  syncMobileNowPlaying();
  renderPlaylist();
  renderConcludorCarousel();
  concludorFadeTriggered = false;
}

function advanceConcludorChain() {
  if (!concludorPlaying || !concludorAudioOwned) return;
  concludorPosition++;
  if (concludorPosition < concludorChain.length) {
    playConcludorEntry(concludorChain[concludorPosition]);
  } else {
    stopConcludorPlayback({ resetPosition: true, render: false });
    renderConcludorCarousel();
    showToast('Mezcla completa terminada.', 'info');
  }
}

// Visualizador de frecuencias con audio real (no decorativo)
let concludorBars = [];
let concludorRafId = null;
function setupConcludorVisualizer() {
  const viz = document.getElementById('concludor-eq-viz');
  if (!viz || concludorBars.length > 0) return;
  viz.innerHTML = '';
  for (let i = 0; i < 32; i++) {
    const bar = document.createElement('div');
    bar.className = 'concludor-eq-bar';
    bar.style.animation = 'none';
    bar.style.height = '15%';
    viz.appendChild(bar);
    concludorBars.push(bar);
  }
}
function drawConcludorVisualizer() {
  const concludorModeEl = document.getElementById('concludor-mode');
  if (!concludorModeEl || !concludorModeEl.classList.contains('active')) { concludorRafId = null; return; }
  if (concludorAnalyser && concludorBars.length > 0) {
    const data = new Uint8Array(concludorAnalyser.frequencyBinCount);
    concludorAnalyser.getByteFrequencyData(data);
    const step = Math.max(1, Math.floor(data.length / concludorBars.length));
    concludorBars.forEach((bar, i) => {
      const val = data[i * step] || 0;
      bar.style.height = Math.max(6, (val / 255) * 60) + 'px';
    });
  }
  concludorRafId = requestAnimationFrame(drawConcludorVisualizer);
}

const btnConcludorMode = document.getElementById('btn-concludor-mode');
const concludorMode = document.getElementById('concludor-mode');
const btnConcludorFinish = document.getElementById('btn-concludor-finish');
const btnConcludorClose = document.getElementById('btn-concludor-close');
const btnConcludorAdd = document.getElementById('btn-concludor-add');
const modalConcludorAdd = document.getElementById('modal-concludor-add');
const btnCloseConcludorAdd = document.getElementById('btn-close-concludor-add');
const btnConcludorPlay = document.getElementById('btn-concludor-play');
const btnConcludorVoice = document.getElementById('btn-concludor-voice');
const btnConcludorMusic = document.getElementById('btn-concludor-music');
const btnConcludorNext = document.getElementById('btn-concludor-next');
const btnConcludorClear = document.getElementById('btn-concludor-clear');
const btnConcludorLocal = document.getElementById('btn-concludor-local');
const concludorCrossfadeInput = document.getElementById('concludor-crossfade');
const concludorCrossfadeValue = document.getElementById('concludor-crossfade-value');

function closeConcludorWindow() {
  // Cerrar/guardar la ventana es una parada real, no solo ocultar una capa.
  stopConcludorPlayback({ resetPosition: false, render: false });
  if (concludorMode) {
    concludorMode.classList.remove('active');
    concludorMode.setAttribute('aria-hidden', 'true');
  }
  document.body.classList.remove('concludor-open');
  saveConcludorChain();
}

// Restore saved visual/control preferences without changing the user's existing cut points.
setConcludorMixMode(concludorMixMode, false);
if (concludorCrossfadeInput) {
  const storedCrossfade = Number(localStorage.getItem('concludorCrossfade'));
  if (Number.isFinite(storedCrossfade) && storedCrossfade >= 0.5 && storedCrossfade <= 8) concludorCrossfadeInput.value = String(storedCrossfade);
  if (concludorCrossfadeValue) concludorCrossfadeValue.textContent = `${Number(concludorCrossfadeInput.value).toFixed(1)} s`;
}

if (btnConcludorMode) {
  btnConcludorMode.addEventListener('click', () => {
    playSFX('open');
    // Una transición pendiente del reproductor principal no debe competir con Concluidor.
    invalidateMainPlaybackRequests({ stabilizeCurrent: true });
    loadConcludorChain();
    const savedMode = localStorage.getItem('concludorMixMode');
    setConcludorMixMode(['fluid', 'rhythm', 'manual', 'smart'].includes(savedMode) ? savedMode : concludorMixMode, false);
    if (concludorMode) {
      concludorMode.classList.add('active');
      concludorMode.setAttribute('aria-hidden', 'false');
    }
    document.body.classList.add('concludor-open');
    renderConcludorCarousel();
    setupConcludorVisualizer();
    if (!concludorRafId) drawConcludorVisualizer();
  });
}
if (btnConcludorFinish) {
  btnConcludorFinish.addEventListener('click', () => {
    playSFX('close');
    saveConcludorChain();
    closeConcludorWindow();
    showToast('Sesión de Concluidor guardada.', 'info', 2000);
  });
}
if (btnConcludorClose) {
  btnConcludorClose.addEventListener('click', () => {
    playSFX('close');
    closeConcludorWindow();
  });
}
if (btnConcludorAdd) {
  btnConcludorAdd.addEventListener('click', () => {
    playSFX('click');
    if (concludorSearchInput) concludorSearchInput.value = '';
    renderConcludorAddList();
    openModal(modalConcludorAdd);
  });
}
if (btnCloseConcludorAdd) {
  btnCloseConcludorAdd.addEventListener('click', () => {
    playSFX('close');
    stopConcludorPreview();
    closeModal(modalConcludorAdd);
  });
}
if (btnConcludorLocal) {
  btnConcludorLocal.addEventListener('click', () => {
    playSFX('click');
    // Reutiliza el importador de audio de Glasstrack: los archivos pasan primero a la biblioteca.
    if (btnConcludorAdd) btnConcludorAdd.click();
    if (fileInput) fileInput.click();
  });
}
if (fileInput) {
  fileInput.addEventListener('change', () => {
    // Respaldo para archivos cuya lectura de metadatos tarda más de lo habitual.
    window.setTimeout(() => {
      if (modalConcludorAdd?.classList.contains('active')) renderConcludorAddList(concludorSearchInput?.value || '');
    }, 1400);
  });
}
document.addEventListener('glasstrack:track-added', () => {
  if (modalConcludorAdd?.classList.contains('active')) renderConcludorAddList(concludorSearchInput?.value || '');
});

document.querySelectorAll('[data-concludor-mode]').forEach(button => {
  button.addEventListener('click', () => {
    playSFX('click');
    setConcludorMixMode(button.dataset.concludorMode);
    renderConcludorCarousel();
  });
});
if (concludorCrossfadeInput) {
  concludorCrossfadeInput.addEventListener('input', () => {
    if (concludorCrossfadeValue) concludorCrossfadeValue.textContent = `${Number(concludorCrossfadeInput.value).toFixed(1)} s`;
  });
  concludorCrossfadeInput.addEventListener('change', () => {
    const seconds = Math.max(0.5, Math.min(8, Number(concludorCrossfadeInput.value) || 3));
    localStorage.setItem('concludorCrossfade', String(seconds));
    concludorChain.forEach(entry => { entry.fadeOutDuration = seconds; });
    saveConcludorChain();
    renderConcludorCarousel();
  });
}

if (btnConcludorPlay) {
  btnConcludorPlay.addEventListener('click', () => {
    playSFX('click');
    if (concludorPlaying) {
      // Pausar/reanudar mantiene la posición. Si Manual llegó al punto de corte,
      // este botón también puede confirmar la siguiente transición.
      if (activeAudio.paused) {
        const currentEntry = concludorChain[concludorPosition];
        const currentFadeAt = currentEntry ? (currentEntry.fadeAt !== undefined ? currentEntry.fadeAt : currentEntry.clipEnd) : Infinity;
        if (concludorMixMode === 'manual' && concludorPosition + 1 < concludorChain.length && activeAudio.currentTime >= currentFadeAt) {
          concludorFadeTriggered = true;
          triggerConcludorCrossfade();
          return;
        }
        const resumeAudio = activeAudio;
        const resumeToken = concludorPlaybackToken;
        Promise.resolve(resumeAudio.play()).then(() => {
          if (resumeToken !== concludorPlaybackToken || !concludorPlaying || !concludorAudioOwned) return;
          startConcludorMonitor();
          btnConcludorPlay.textContent = 'Ⅱ Pausar mezcla';
          renderConcludorStudioState();
        }).catch(() => {});
      } else {
        const pausedDuringCrossfade = concludorCrossfadeInProgress;
        audio1.pause();
        audio2.pause();
        if (concludorFadeTimer !== null) { clearInterval(concludorFadeTimer); concludorFadeTimer = null; }
        if (pausedDuringCrossfade && activeAudio) {
          const targetVol = Math.max(0, Math.min(1, volumeSlider ? parseFloat(volumeSlider.value) : 1));
          activeAudio.volume = targetVol;
          const otherAudio = activeAudio === audio1 ? audio2 : audio1;
          otherAudio.volume = 0;
        }
        concludorCrossfadeInProgress = false;
        // La sesión queda en pausa, no se invalida; se puede continuar desde el punto actual.
        btnConcludorPlay.textContent = '▶ Continuar mezcla';
        const waveState = document.getElementById('concludor-wave-state');
        if (waveState) waveState.textContent = 'EN PAUSA';
      }
      return;
    }
    if (concludorChain.length === 0) { showToast('Agrega al menos una canción a la secuencia primero.', 'error'); return; }
    concludorPlaying = true;
    concludorPosition = Math.max(0, Math.min(concludorPosition, concludorChain.length - 1));
    startConcludorMonitor();
    playConcludorEntry(concludorChain[concludorPosition]);
    btnConcludorPlay.textContent = 'Ⅱ Pausar mezcla';
    renderConcludorStudioState();
  });
}
if (btnConcludorNext) {
  btnConcludorNext.addEventListener('click', () => {
    playSFX('click');
    if (concludorChain.length < 2) { showToast('Agrega al menos dos pistas para crear una transición.', 'info', 2200); return; }
    if (concludorPosition >= concludorChain.length - 1 && concludorPlaying) {
      showToast('Esta es la última pista de la secuencia.', 'info', 2200);
      return;
    }
    if (!concludorPlaying) {
      concludorPlaying = true;
      concludorPosition = Math.max(0, Math.min(concludorPosition, concludorChain.length - 1));
      startConcludorMonitor();
      playConcludorEntry(concludorChain[concludorPosition]);
      if (btnConcludorPlay) btnConcludorPlay.textContent = 'Ⅱ Pausar mezcla';
      renderConcludorStudioState();
      return;
    }
    concludorFadeTriggered = true;
    triggerConcludorCrossfade();
  });
}
if (btnConcludorClear) {
  btnConcludorClear.addEventListener('click', () => {
    if (!concludorChain.length) return;
    if (!confirm('¿Vaciar todas las pistas de la sesión Concluidor?')) return;
    stopConcludorPlayback({ resetPosition: true, render: false });
    concludorChain = [];
    concludorPosition = 0;
    concludorFadeTriggered = false;
    saveConcludorChain();
    if (btnConcludorPlay) btnConcludorPlay.textContent = '▶ Iniciar mezcla';
    renderConcludorCarousel();
  });
}

// Escape cierra primero el selector de pistas; luego la ventana completa.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !concludorMode?.classList.contains('active')) return;
  if (modalConcludorAdd?.classList.contains('active')) {
    if (btnCloseConcludorAdd) btnCloseConcludorAdd.click();
  } else {
    closeConcludorWindow();
  }
});

// "Voz" / "Música" reutilizan el procesador Voz/Música de Glasstrack.
if (btnConcludorVoice) {
  btnConcludorVoice.addEventListener('click', () => {
    playSFX('click');
    initAudioContext();
    btnConcludorVoice.classList.add('active');
    btnConcludorMusic.classList.remove('active');
    if (toggleVmEnabled) toggleVmEnabled.checked = true;
    if (midGain) midGain.gain.value = 1.6;
    if (sideGain) sideGain.gain.value = 0.5;
  });
}
if (btnConcludorMusic) {
  btnConcludorMusic.addEventListener('click', () => {
    playSFX('click');
    initAudioContext();
    btnConcludorMusic.classList.add('active');
    btnConcludorVoice.classList.remove('active');
    if (toggleVmEnabled) toggleVmEnabled.checked = true;
    if (midGain) midGain.gain.value = 0.5;
    if (sideGain) sideGain.gain.value = 1.6;
  });
}

// Monitor de reproducción: solo existe mientras una sesión Concluidor está activa.
// Al cerrar, vaciar o terminar la sesión se cancela, igual que sus fundidos pendientes.
function tickConcludorMonitor() {
  if (!concludorPlaying || !concludorAudioOwned || !activeAudio) return;
  const entry = concludorChain[concludorPosition];
  if (!entry) return;
  const fadeAt = entry.fadeAt !== undefined ? entry.fadeAt : entry.clipEnd;
  const fadeOutDuration = getConcludorFadeSeconds(concludorPosition);
  const triggerPoint = Math.max(entry.clipStart || 0, fadeAt - fadeOutDuration);

  if (concludorMixMode !== 'manual' && !concludorFadeTriggered && !concludorCrossfadeInProgress && activeAudio.currentTime >= triggerPoint) {
    concludorFadeTriggered = true;
    if (concludorPosition + 1 < concludorChain.length) triggerConcludorCrossfade();
  }
  if (concludorMixMode === 'manual' && concludorPosition < concludorChain.length - 1 && activeAudio.currentTime >= fadeAt) {
    activeAudio.pause();
    try { activeAudio.currentTime = fadeAt; } catch (_) {}
    const waveState = document.getElementById('concludor-wave-state');
    if (waveState) waveState.textContent = 'ESPERANDO TRANSICIÓN';
    const hint = document.getElementById('concludor-playback-hint');
    if (hint) hint.textContent = 'Fragmento terminado. Pulsa “Transición siguiente” cuando estés listo.';
    const playBtn = document.getElementById('btn-concludor-play');
    if (playBtn && activeAudio.paused) playBtn.textContent = '↗ Transición pendiente';
  }
  if (concludorPosition === concludorChain.length - 1 && activeAudio.currentTime >= fadeAt) {
    stopConcludorPlayback({ resetPosition: true, render: false });
    renderConcludorCarousel();
    showToast('Mezcla completa terminada.', 'info');
  }
}

window.addEventListener('pagehide', () => {
  stopConcludorPlayback({ resetPosition: false, render: false });
  stopConcludorPreview();
  invalidateMainPlaybackRequests();
});

// ==========================================
// BUSCADOR DE BIBLIOTECA
// ==========================================
const librarySearchInput = document.getElementById('library-search');
if (librarySearchInput) {
  librarySearchInput.addEventListener('input', (e) => {
    const term = e.target.value.trim().toLowerCase();
    document.querySelectorAll('#playlist > li').forEach(item => {
      const match = !term || item.textContent.toLowerCase().includes(term);
      item.style.display = match ? '' : 'none';
    });
  });
}

// ==========================================
// MODO INTERFAZ CELULAR (diseño tipo app de celular, con barra inferior)
// ==========================================
const toggleMobileLayout = document.getElementById('toggle-mobile-layout');
const mobileNowplayingBar = document.getElementById('mobile-nowplaying-bar');
const mobileTabBar = document.getElementById('mobile-tab-bar');

let mobileLayoutRafId = 0;

function scheduleMobileLayoutFrame(callback) {
  if (mobileLayoutRafId) return;
  mobileLayoutRafId = window.requestAnimationFrame(() => {
    mobileLayoutRafId = 0;
    callback();
  });
}

function cancelMobileLayoutFrame() {
  if (!mobileLayoutRafId) return;
  window.cancelAnimationFrame(mobileLayoutRafId);
  mobileLayoutRafId = 0;
}

function restoreDesktopPointerEvents() {
  const restoreTargets = [
    document.body,
    document.documentElement,
    document.getElementById('app-layout'),
    document.getElementById('control-notification-bar'),
    document.querySelector('.top-global-bar'),
    document.querySelector('.top-left-global-bar'),
    document.getElementById('player-card')
  ];

  restoreTargets.forEach(el => {
    if (!el) return;
    el.style.pointerEvents = 'auto';
  });

  const hiddenMobileOverlays = [
    document.getElementById('mobile-quick-menu'),
    document.getElementById('top-experiences-menu')
  ];

  hiddenMobileOverlays.forEach(el => {
    if (!el) return;
    el.style.pointerEvents = 'none';
  });
}

function applyMobileLayoutState(enabled) {
  const body = document.body;
  const root = document.documentElement;
  const wasMobile = body.classList.contains('mobile-layout') ||
    body.classList.contains('mobile-mode') ||
    body.classList.contains('mobile-layout-active') ||
    body.classList.contains('mobile-mode-active');

  if (enabled) {
    if (!wasMobile) {
      const currentScroll = window.scrollY || root.scrollTop || 0;
      body.dataset.mobileScrollY = String(currentScroll);
    }

    body.classList.add(
      'mobile-layout',
      'mobile-mode',
      'mobile-layout-active',
      'mobile-mode-active'
    );
    root.classList.add('mobile-layout-enabled');

    const currentScroll = Number(body.dataset.mobileScrollY || 0);

    scheduleMobileLayoutFrame(() => {
      body.style.top = `-${Math.max(0, currentScroll)}px`;
      body.style.pointerEvents = 'auto';
    });
    return;
  }

  const previousScroll = Number(body.dataset.mobileScrollY || 0);

  // Al salir, cancelar cualquier frame pendiente del estado anterior.
  // Así nunca se ejecuta después del cleanup un callback que vuelva a escribir
  // estilos móviles sobre la interfaz de escritorio.
  cancelMobileLayoutFrame();

  body.classList.remove(
    'mobile-layout',
    'mobile-mode',
    'mobile-layout-active',
    'mobile-mode-active',
    'mobile-player-expanded',
    'mobile-modal-lock',
    'mobile-ui-hidden',
    'mobile-player-layer-open'
  );

  root.classList.remove('mobile-layout-enabled', 'mobile-player-layer-open');
  body.style.removeProperty('top');
  body.style.removeProperty('pointer-events');
  root.style.removeProperty('pointer-events');

  const player = document.getElementById('player-card');
  if (player) player.classList.remove('mobile-expanded');

  const topMenu = document.getElementById('top-experiences-menu');
  const secondaryButton = document.getElementById('btn-mobile-secondary-menu');
  const quickMenu = document.getElementById('mobile-quick-menu');
  const mobileBar = document.getElementById('mobile-nowplaying-bar');
  const mobileTabBar = document.getElementById('mobile-tab-bar');

  if (topMenu) {
    topMenu.classList.add('hidden');
    topMenu.style.pointerEvents = 'none';
    topMenu.setAttribute('aria-hidden', 'true');
  }
  if (secondaryButton) secondaryButton.setAttribute('aria-expanded', 'false');
  if (quickMenu) {
    quickMenu.classList.remove('active');
    quickMenu.style.pointerEvents = 'none';
    quickMenu.setAttribute('aria-hidden', 'true');
  }
  if (mobileBar) mobileBar.removeAttribute('aria-hidden');
  if (mobileTabBar) mobileTabBar.removeAttribute('aria-hidden');

  restoreDesktopPointerEvents();

  /* Un solo reajuste del layout después de retirar las clases móviles. */
  scheduleMobileLayoutFrame(() => {
    window.scrollTo(0, Math.max(0, previousScroll));
  });
  delete body.dataset.mobileScrollY;
}

if (toggleMobileLayout) {
  const savedMobileLayout = localStorage.getItem('mobileLayoutEnabled') === 'true';
  toggleMobileLayout.checked = savedMobileLayout;
  applyMobileLayoutState(savedMobileLayout);

  toggleMobileLayout.addEventListener('change', event => {
    const enabled = !!event.target.checked;
    playSFX('click');
    localStorage.setItem('mobileLayoutEnabled', enabled ? 'true' : 'false');
    applyMobileLayoutState(enabled);
  });
}

function syncMobileNowPlaying() {
  const mnpCover = document.getElementById('mobile-np-cover');
  const mnpTitle = document.getElementById('mobile-np-title');
  const mnpArtist = document.getElementById('mobile-np-artist');
  const mnpPlayIcon = document.getElementById('mobile-np-play-icon');
  if (mnpCover && cover) mnpCover.src = cover.src;
  if (mnpTitle && title) mnpTitle.textContent = title.textContent;
  if (mnpArtist && artist) mnpArtist.textContent = artist.textContent;
  if (mnpPlayIcon && playIcon) mnpPlayIcon.innerHTML = playIcon.innerHTML;
}

if (mobileNowplayingBar) {
  mobileNowplayingBar.addEventListener('click', (e) => {
    if (e.target.closest('#mobile-np-play')) return; // el botón de play/pausa se maneja aparte
    playSFX('click');
    if (playerCard) playerCard.classList.toggle('mobile-expanded');
    document.body.classList.toggle('mobile-player-expanded');
  });
}
const mobileNpPlayBtn = document.getElementById('mobile-np-play');
if (mobileNpPlayBtn) mobileNpPlayBtn.addEventListener('click', (e) => { e.stopPropagation(); if (playBtn) playBtn.click(); });

const mobileSecondaryMenu = document.getElementById('btn-mobile-secondary-menu');
if (mobileSecondaryMenu) {
  mobileSecondaryMenu.addEventListener('click', () => {
    playSFX('open');
    const settingsOpen = modalSettings && modalSettings.classList.contains('active');
    if (settingsOpen) {
      closeModalSettings();
      mobileSecondaryMenu.setAttribute('aria-expanded', 'false');
    } else if (btnMainMenu) {
      btnMainMenu.click();
      mobileSecondaryMenu.setAttribute('aria-expanded', 'true');
    }
  });
}

if (mobileTabBar) {
  mobileTabBar.querySelectorAll('.mobile-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      playSFX('click');
      mobileTabBar.querySelectorAll('.mobile-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      if (playerCard) playerCard.classList.remove('mobile-expanded');
      document.body.classList.remove('mobile-player-expanded');
      if (tab === 'ajustes') {
        if (btnMainMenu) btnMainMenu.click();
      } else if (tab === 'buscar') {
        if (librarySearchInput) setTimeout(() => librarySearchInput.focus(), 100);
      }
    });
  });
}


// =========================================================
// MENÚ SUPERIOR — MODOS Y EXPERIENCIAS
// =========================================================
(() => {
  'use strict';

  const trigger = document.getElementById('btn-top-experiences');
  const menu = document.getElementById('top-experiences-menu');
  const stageItem = document.getElementById('top-mode-stage');
  const rhythmItem = document.getElementById('top-mode-rhythm');
  const visualItem = document.getElementById('top-mode-visual');
  const jkItem = document.getElementById('top-mode-jk');
  const mobileQuickMenu = document.getElementById('mobile-quick-menu');
  const isMobileUi = () => document.body.classList.contains('mobile-layout') ||
    document.body.classList.contains('mobile-mode') ||
    document.body.classList.contains('mobile-layout-active') ||
    document.body.classList.contains('mobile-mode-active');

  if (!trigger || !menu) return;

  const isOpen = () => !menu.classList.contains('hidden');

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  const positionMenu = () => {
    if (!isOpen()) return;
    // En escritorio posiciona el menú el listener dedicado de btn-pc-secondary-menu.
    // Esto evita que un resize/scroll reubique el menú usando el botón móvil oculto.
    if (!isMobileUi() && window.innerWidth > 768) return;

    const rect = trigger.getBoundingClientRect();
    const menuWidth = Math.min(340, menu.getBoundingClientRect().width || 320, Math.max(0, window.innerWidth - 20));
    const menuHeight = menu.offsetHeight || 210;
    const gap = 8;
    const viewportPadding = 10;

    let left = rect.right - menuWidth;
    let top = rect.bottom + gap;

    left = clamp(left, viewportPadding, window.innerWidth - menuWidth - viewportPadding);

    if (top + menuHeight > window.innerHeight - viewportPadding) {
      top = rect.top - menuHeight - gap;
    }

    top = clamp(top, viewportPadding, Math.max(viewportPadding, window.innerHeight - menuHeight - viewportPadding));

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };

  const openMenu = () => {
    menu.classList.remove('hidden');
    if (mobileQuickMenu) mobileQuickMenu.classList.toggle('active', isMobileUi());
    trigger.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(positionMenu);
  };

  const closeMenu = () => {
    menu.classList.add('hidden');
    if (mobileQuickMenu) mobileQuickMenu.classList.remove('active');
    trigger.setAttribute('aria-expanded', 'false');
  };

  const toggleMenu = (event) => {
    event.preventDefault();
    event.stopPropagation();

    try {
      if (typeof playSFX === 'function') playSFX('click');
    } catch (_) {}

    if (isOpen()) closeMenu();
    else openMenu();
  };

  trigger.addEventListener('click', toggleMenu);

  document.addEventListener('click', event => {
    if (!isOpen()) return;
    if (menu.contains(event.target) || trigger.contains(event.target)) return;
    closeMenu();
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      closeMenu();
      trigger.focus();
    }
  });

  window.addEventListener('resize', positionMenu, { passive: true });
  window.addEventListener('scroll', positionMenu, { passive: true });

  if (stageItem) {
    stageItem.addEventListener('click', () => {
      closeMenu();
      try {
        if (typeof playSFX === 'function') playSFX('click');
      } catch (_) {}

      const manager = window.StageManager;
      if (manager && typeof manager.show === 'function') {
        manager.show();
      } else {
        console.warn('[Glasstrack] StageManager no está disponible todavía.');
      }
    });
  }

  if (rhythmItem) {
    rhythmItem.addEventListener('click', () => {
      closeMenu();
      try {
        if (typeof playSFX === 'function') playSFX('click');
      } catch (_) {}

      const rhythm = window.glasstrackRhythm;
      if (!rhythm || typeof rhythm.open !== 'function') {
        console.warn('[Glasstrack] Modo Ritmo no está disponible todavía.');
        return;
      }

      // El acceso ya no depende del panel de Ajustes Generales.
      // Se reactiva automáticamente para que el nuevo menú sea el punto de entrada único.
      if (typeof rhythm.enableAndOpen === 'function') {
        rhythm.enableAndOpen('game');
      } else {
        rhythm.open('game');
      }
    });
  }

  // Modo Visual: reproductor estilo edit/HUD, sin editor de personajes.
  if (visualItem) {
    visualItem.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      if (typeof window.openGlasstrackVisualMode === 'function') {
        window.openGlasstrackVisualMode();
      } else {
        console.warn('[Glasstrack] Modo Visual no está disponible todavía.');
      }
    });
  }

  // Modo JK permanece visible en el menú, pero bloqueado hasta que exista su módulo.
  if (jkItem) {
    jkItem.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
    });
  }
})();

// El cierre de reproductor móvil se conecta en MOBILE UI V3 / STATE SYNC,
// donde también se sincroniza aria-hidden y la capa visual. Evitamos registrar
// dos listeners sobre la misma X y duplicar los efectos de cierre.

// ==========================================
// AUTO-PAUSA AL CAMBIAR DE PESTAÑA Y RECORDAR POSICIÓN EXACTA
// ==========================================
document.addEventListener('visibilitychange', () => {
  if (document.hidden && toggleAutopauseTab && toggleAutopauseTab.checked) {
    if (playerCard && playerCard.classList.contains('playing') && pauseBtn) pauseBtn.click();
  }
});

// Guarda el segundo exacto de la canción actual cada pocos segundos
setInterval(() => {
  if (!toggleResumePosition || !toggleResumePosition.checked) return;
  const song = songList[currentIndex];
  if (!song || !activeAudio || isNaN(activeAudio.currentTime)) return;
  localStorage.setItem('resumePlayback', JSON.stringify({
    key: songKeyOf(song), time: activeAudio.currentTime
  }));
}, 4000);

// Al cargar la app, si hay una posición guardada de la última canción, la retoma
function tryResumeLastPosition() {
  if (!toggleResumePosition || !toggleResumePosition.checked) return;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('resumePlayback') || 'null'); } catch (e) { saved = null; }
  if (!saved || !saved.key) return;
  const song = findSongByKey(saved.key);
  if (!song) return;
  const realIndex = songList.indexOf(song);
  if (realIndex < 0) return;
  loadSong(realIndex, false);
  const seekOnce = () => { activeAudio.currentTime = saved.time || 0; activeAudio.removeEventListener('canplay', seekOnce); };
  if (activeAudio.readyState >= 2) activeAudio.currentTime = saved.time || 0;
  else activeAudio.addEventListener('canplay', seekOnce);
}
setTimeout(tryResumeLastPosition, 800);

// ==========================================
// VISUALIZADOR DE AUDIO EN EL REPRODUCTOR PRINCIPAL (controlado desde Personalización avanzada)
// ==========================================
const toggleAudioVisualizer = document.getElementById('toggle-player-visualizer');
const playerVisualizerCanvas = document.getElementById('player-visualizer');
let playerVizRafId = null;

function drawPlayerVisualizer() {
  if (!toggleAudioVisualizer || !toggleAudioVisualizer.checked || !playerVisualizerCanvas) {
    playerVizRafId = null;
    return;
  }
  const canvas = playerVisualizerCanvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) { playerVizRafId = null; return; }

  const perf = window.__glasstrackB32Perf || { visualizerQuality: 'medium', fps: 60 };
  const minFrameMs = 1000 / ([30,45,60].includes(Number(perf.fps)) ? Number(perf.fps) : 60);
  const now = performance.now();
  const last = Number(canvas.dataset.lastFrameTime || 0);
  if (last && now - last < minFrameMs) {
    playerVizRafId = requestAnimationFrame(drawPlayerVisualizer);
    return;
  }
  canvas.dataset.lastFrameTime = String(now);

  const rect = canvas.getBoundingClientRect();
  if (document.hidden || canvas.classList.contains('hidden') || rect.width < 2 || rect.height < 2) {
    playerVizRafId = null;
    return;
  }
  const dpr = Math.min(window.devicePixelRatio || 1, perf.visualizerQuality === 'low' ? 1 : 1.5);
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.clearRect(0, 0, w, h);

  const barCount = perf.visualizerQuality === 'low' ? 20 : perf.visualizerQuality === 'high' ? 48 : 32;
  const barWidth = w / barCount;
  const data = concludorAnalyser ? new Uint8Array(concludorAnalyser.frequencyBinCount) : null;
  if (data) concludorAnalyser.getByteFrequencyData(data);
  const step = data ? Math.max(1, Math.floor(data.length / barCount)) : 1;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary-color') || '#fff';
  for (let i = 0; i < barCount; i++) {
    const value = data ? (data[i * step] || 0) : 10;
    const normalized = Math.max(0.04, value / 255);
    const barHeight = Math.max(2 * dpr, normalized * h);
    ctx.fillRect(i * barWidth + Math.max(1, dpr), h - barHeight, Math.max(1, barWidth - 2 * dpr), barHeight);
  }
  playerVizRafId = requestAnimationFrame(drawPlayerVisualizer);
}

if (toggleAudioVisualizer) {
  toggleAudioVisualizer.addEventListener('change', (e) => {
    playSFX('click');
    BODY.classList.toggle('b32-visualizer-user-enabled', !!e.target.checked);
    initAudioContext();
    if (playerVisualizerCanvas) playerVisualizerCanvas.classList.toggle('hidden', !e.target.checked);
    if (e.target.checked && !playerVizRafId) drawPlayerVisualizer();
  });
}
// B66: si el canvas pasa de oculto/0px a visible al expandir el reproductor móvil,
// se inicia una sola vez el bucle existente en vez de dejarlo girando en un tamaño inválido.
if (playerVisualizerCanvas && typeof ResizeObserver !== 'undefined') {
  const playerVizResizeObserver = new ResizeObserver(() => {
    if (toggleAudioVisualizer?.checked && !playerVisualizerCanvas.classList.contains('hidden') && !document.hidden && !playerVizRafId) {
      drawPlayerVisualizer();
    }
  });
  playerVizResizeObserver.observe(playerVisualizerCanvas);
  const playerForVizResize = document.getElementById('player-card');
  if (playerForVizResize) playerVizResizeObserver.observe(playerForVizResize);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && toggleAudioVisualizer?.checked && !playerVisualizerCanvas.classList.contains('hidden') && !playerVizRafId) drawPlayerVisualizer();
  });
  window.addEventListener('resize', () => {
    if (toggleAudioVisualizer?.checked && !playerVisualizerCanvas.classList.contains('hidden') && !playerVizRafId) drawPlayerVisualizer();
  }, { passive: true });
}

// ==========================================
// MODO ESTUDIO DE LETRAS (importar .lrc/.txt, tap-sync, ajuste fino, exportar .lrc)
// ==========================================
let studioLines = []; // [{ time: segundos|null, text: "", instrumental: bool }]
let studioTapIndex = 0;

function parseLrcText(text) {
  const lines = text.split('\n');
  const result = [];
  const timeTag = /\[(\d{2}):(\d{2})[.:](\d{2,3})\]/g;
  lines.forEach(rawLine => {
    const matches = [...rawLine.matchAll(timeTag)];
    const cleanText = rawLine.replace(timeTag, '').trim();
    if (matches.length > 0) {
      matches.forEach(m => {
        const mins = parseInt(m[1], 10);
        const secs = parseInt(m[2], 10);
        const frac = parseInt(m[3].padEnd(3, '0'), 10) / 1000;
        result.push({ time: mins * 60 + secs + frac, text: cleanText, instrumental: false });
      });
    } else if (cleanText) {
      result.push({ time: null, text: cleanText, instrumental: false });
    }
  });
  return result;
}
function parseTxtText(text) {
  return text.split('\n').filter(l => l.trim() !== '').map(l => ({ time: null, text: l.trim(), instrumental: false }));
}
function formatLrcTime(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return ('0' + m).slice(-2) + ':' + ('0' + s).slice(-2) + '.' + ('0' + ms).slice(-2);
}

function renderStudioList() {
  const list = document.getElementById('studio-line-list');
  if (!list) return;
  if (studioLines.length === 0) {
    list.innerHTML = '<li class="empty-msg">Importa un archivo o edita la letra normal primero.</li>';
    return;
  }
  list.innerHTML = studioLines.map((line, i) => `
    <li class="studio-line-row${line.instrumental ? ' studio-instrumental' : ''}" data-idx="${i}">
      <span class="studio-line-time">${formatLrcTime(line.time)}</span>
      <input class="studio-line-text" data-idx="${i}" value="${line.text.replace(/"/g, '&quot;')}">
      <button class="studio-nudge-btn" data-idx="${i}" data-nudge="-500">-.5</button>
      <button class="studio-nudge-btn" data-idx="${i}" data-nudge="-100">-.1</button>
      <button class="studio-nudge-btn" data-idx="${i}" data-nudge="100">+.1</button>
      <button class="studio-nudge-btn" data-idx="${i}" data-nudge="500">+.5</button>
      <button class="studio-nudge-btn studio-instrumental-toggle" data-idx="${i}" title="Marcar como instrumental">🎵</button>
      <button class="studio-nudge-btn studio-delete-line" data-idx="${i}" title="Eliminar esta línea">✕</button>
    </li>`).join('');

  list.querySelectorAll('.studio-line-text').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      if (studioLines[idx]) { studioLines[idx].text = e.target.value; saveStudioLyrics(); }
    });
  });
  list.querySelectorAll('.studio-nudge-btn[data-nudge]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      playSFX('click');
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      const delta = parseInt(e.currentTarget.dataset.nudge, 10) / 1000;
      if (studioLines[idx] && studioLines[idx].time !== null) {
        studioLines[idx].time = Math.max(0, studioLines[idx].time + delta);
        renderStudioList();
        saveStudioLyrics();
      }
    });
  });
  list.querySelectorAll('.studio-instrumental-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      playSFX('click');
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      if (studioLines[idx]) {
        studioLines[idx].instrumental = !studioLines[idx].instrumental;
        renderStudioList();
        saveStudioLyrics();
      }
    });
  });
  list.querySelectorAll('.studio-delete-line').forEach(btn => {
    btn.addEventListener('click', (e) => {
      playSFX('click');
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      studioLines.splice(idx, 1);
      if (studioTapIndex > idx) studioTapIndex--;
      renderStudioList();
      saveStudioLyrics();
    });
  });
}

// Agregar una línea nueva vacía al final, para letras que quedaron incompletas
const btnStudioAddLine = document.getElementById('btn-studio-add-line');
if (btnStudioAddLine) {
  btnStudioAddLine.addEventListener('click', () => {
    playSFX('click');
    studioLines.push({ time: null, text: '', instrumental: false });
    renderStudioList();
    saveStudioLyrics();
    const rows = document.querySelectorAll('.studio-line-row');
    if (rows.length > 0) rows[rows.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

// Elimina todos los tiempos marcados (conserva el texto) para volver a calibrar desde cero
const btnStudioResetAll = document.getElementById('btn-studio-reset-all');
if (btnStudioResetAll) {
  btnStudioResetAll.addEventListener('click', () => {
    playSFX('click');
    if (!confirm('¿Seguro que vas a borrar todos los tiempos marcados? El texto de las líneas se conserva.')) return;
    studioLines.forEach(l => { l.time = null; });
    studioTapIndex = 0;
    const song = songList[currentIndex];
    if (song) song.karaokeWords = {};
    renderStudioList();
    saveStudioLyrics();
    showToast('Se borraron todos los tiempos. Puedes volver a calibrar desde cero.', 'info');
  });
}

function saveStudioLyrics() {
  if (songList.length === 0) return;
  const song = songList[currentIndex];
  // Guardamos TODAS las líneas (con time:null si aún no se marcaron), para que la posición
  // de cada una siga coincidiendo con su línea real en el texto de la letra.
  song.lrcLines = studioLines.map(l => ({ time: l.time, text: l.text, instrumental: l.instrumental }));
  song.lyrics = studioLines.map(l => l.text).join('\n');
  updateSongInDB(song);
  displayLyrics(song.lyrics);
}

const btnLyricsStudio = document.getElementById('btn-lyrics-studio');
const lyricsStudioEl = document.getElementById('lyrics-studio');
const btnCloseStudio = document.getElementById('btn-close-studio');
const studioDropzone = document.getElementById('studio-dropzone');
const inputStudioFile = document.getElementById('input-studio-file');
const btnStudioBrowse = document.getElementById('btn-studio-browse');
const btnTapSync = document.getElementById('btn-tap-sync');
const btnStudioPlayPause = document.getElementById('btn-studio-playpause');
const btnStudioExport = document.getElementById('btn-studio-export');
const btnStudioHelp = document.getElementById('btn-studio-help');
const modalStudioHelp = document.getElementById('modal-studio-help');
const btnCloseStudioHelp = document.getElementById('btn-close-studio-help');
if (btnStudioHelp) btnStudioHelp.addEventListener('click', () => { playSFX('open'); openModal(modalStudioHelp); });
if (btnCloseStudioHelp) btnCloseStudioHelp.addEventListener('click', () => { playSFX('close'); closeModal(modalStudioHelp); });
const btnStudioDistribute = document.getElementById('btn-studio-distribute');
const studioProgressContainer = document.getElementById('studio-progress-container');
const studioProgress = document.getElementById('studio-progress');

if (btnLyricsStudio) {
  btnLyricsStudio.addEventListener('click', () => {
    playSFX('open');
    if (songList.length === 0) { showToast('Carga una canción primero.', 'error'); return; }
    const song = songList[currentIndex];
    const studioCover = document.getElementById('studio-cover');
    const studioTitle = document.getElementById('studio-title');
    const studioArtist = document.getElementById('studio-artist');
    if (studioCover) studioCover.src = song.cover;
    if (studioTitle) studioTitle.textContent = song.title;
    if (studioArtist) studioArtist.textContent = song.artist;

    if (song.lrcLines && song.lrcLines.length > 0) {
      studioLines = song.lrcLines.map(l => ({ ...l }));
    } else if (song.lyrics) {
      studioLines = parseTxtText(song.lyrics);
    } else {
      studioLines = [];
    }
    studioTapIndex = 0;
    renderStudioList();
    document.querySelectorAll('.studio-speed-btn').forEach(b => b.classList.toggle('active', b.dataset.speed === '1'));
    // Siempre arranca en la pestaña de Letras Normales, aunque la última vez hayas usado Karaoke
    if (studioTabLines) studioTabLines.click();
    karaokeRenderedLineIndex = null;
    if (lyricsStudioEl) lyricsStudioEl.classList.add('active');
  });
}
if (btnCloseStudio) {
  btnCloseStudio.addEventListener('click', () => {
    playSFX('close');
    if (lyricsStudioEl) lyricsStudioEl.classList.remove('active');
    applyAudioEngineSettings(); // restablece la velocidad real (la del Estudio era solo temporal)
  });
}

// Arrastrar y soltar / buscar archivo .txt o .lrc
function handleStudioFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const isLrc = file.name.toLowerCase().endsWith('.lrc') || /\[\d{2}:\d{2}/.test(text);
    studioLines = isLrc ? parseLrcText(text) : parseTxtText(text);
    studioTapIndex = studioLines.findIndex(l => l.time === null);
    if (studioTapIndex === -1) studioTapIndex = studioLines.length;
    renderStudioList();
    saveStudioLyrics();
    showToast(isLrc ? 'Archivo .lrc importado con sus tiempos.' : 'Archivo .txt importado. Usa Tap Sync para ponerle tiempos.', 'info');
  };
  reader.readAsText(file);
}
if (studioDropzone) {
  studioDropzone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); studioDropzone.classList.add('drag-over'); });
  studioDropzone.addEventListener('dragleave', (e) => { e.stopPropagation(); studioDropzone.classList.remove('drag-over'); });
  studioDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    studioDropzone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) handleStudioFile(e.dataTransfer.files[0]);
  });
}
if (btnStudioBrowse) btnStudioBrowse.addEventListener('click', () => { if (inputStudioFile) inputStudioFile.click(); });
if (inputStudioFile) inputStudioFile.addEventListener('change', (e) => handleStudioFile(e.target.files[0]));

// Tap-Sync: marca el segundo exacto en la línea actual y pasa a la siguiente
let studioTabMode = 'lines'; // 'lines' | 'karaoke'

function doTapSync() {
  if (studioTabMode === 'karaoke') { showToast('Tap-Sync está desactivado en la pestaña de Calibración Karaoke.', 'error'); return; }
  if (studioLines.length === 0) return;
  if (studioTapIndex >= studioLines.length) { showToast('Ya marcaste todas las líneas.', 'info', 2000); return; }
  studioLines[studioTapIndex].time = activeAudio.currentTime || 0;
  studioTapIndex++;
  renderStudioList();
  saveStudioLyrics();
  const rows = document.querySelectorAll('.studio-line-row');
  if (rows[studioTapIndex]) rows[studioTapIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
}
if (btnTapSync) btnTapSync.addEventListener('click', () => { playSFX('click'); doTapSync(); });
document.addEventListener('keydown', (e) => {
  if (lyricsStudioEl && lyricsStudioEl.classList.contains('active') && e.code === 'Space' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    doTapSync();
  }
});

if (btnStudioPlayPause) btnStudioPlayPause.addEventListener('click', () => { if (playBtn) playBtn.click(); });

const btnStudioBack5 = document.getElementById('btn-studio-back5');
const btnStudioFwd5 = document.getElementById('btn-studio-fwd5');
if (btnStudioBack5) {
  btnStudioBack5.addEventListener('click', () => {
    playSFX('click');
    activeAudio.currentTime = Math.max(0, activeAudio.currentTime - 5);
  });
}
if (btnStudioFwd5) {
  btnStudioFwd5.addEventListener('click', () => {
    playSFX('click');
    activeAudio.currentTime = Math.min(activeAudio.duration || Infinity, activeAudio.currentTime + 5);
  });
}

// Velocidad de escucha lenta SOLO dentro del Estudio (no toca tu velocidad normal guardada
// en Ajustes); al cerrar el Estudio, vuelve a la velocidad real de forma automática.
document.querySelectorAll('.studio-speed-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    playSFX('click');
    document.querySelectorAll('.studio-speed-btn').forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    const rate = parseFloat(e.currentTarget.dataset.speed);
    [audio1, audio2].filter(Boolean).forEach(a => {
      a.playbackRate = rate;
      applyLinkedPlaybackRate(a);
    });
    syncPlaybackSpeedIndicators();
  });
});

makeSeekbarDraggable(studioProgressContainer, studioProgress, document.getElementById('studio-current-time'));

// Ajuste en lote: mueve TODAS las líneas ya marcadas la misma cantidad de tiempo
document.querySelectorAll('.studio-mini-btn[data-batch]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    playSFX('click');
    const delta = parseInt(e.currentTarget.dataset.batch, 10) / 1000;
    studioLines.forEach(l => { if (l.time !== null) l.time = Math.max(0, l.time + delta); });
    renderStudioList();
    saveStudioLyrics();
  });
});

// Distribución uniforme: reparte el tiempo entre la primera y la última línea ya marcadas
if (btnStudioDistribute) {
  btnStudioDistribute.addEventListener('click', () => {
    playSFX('click');
    const markedIdxs = studioLines.map((l, i) => l.time !== null ? i : -1).filter(i => i !== -1);
    if (markedIdxs.length < 2) { showToast('Marca al menos la primera y la última línea del tramo primero.', 'error'); return; }
    const first = markedIdxs[0];
    const last = markedIdxs[markedIdxs.length - 1];
    const startTime = studioLines[first].time;
    const endTime = studioLines[last].time;
    const span = last - first;
    if (span > 0) {
      for (let i = first; i <= last; i++) {
        studioLines[i].time = startTime + ((endTime - startTime) * (i - first)) / span;
      }
    }
    renderStudioList();
    saveStudioLyrics();
    showToast('Tiempos repartidos entre las líneas marcadas.', 'info');
  });
}

// Exportar como .lrc (copia y descarga)
if (btnStudioExport) {
  btnStudioExport.addEventListener('click', () => {
    playSFX('click');
    const timed = studioLines.filter(l => l.time !== null).sort((a, b) => a.time - b.time);
    if (timed.length === 0) { showToast('Todavía no hay líneas con tiempo marcado.', 'error'); return; }
    const lrcText = timed.map(l => `[${formatLrcTime(l.time)}]${l.instrumental ? '[Instrumental] ' : ''}${l.text}`).join('\n');
    const song = songList[currentIndex];
    const blob = new Blob([lrcText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${(song ? song.title : 'letra')}.lrc`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    if (navigator.clipboard) navigator.clipboard.writeText(lrcText).catch(() => {});
    showToast('Archivo .lrc descargado (y copiado al portapapeles).', 'info');
  });
}

// Sincroniza la vista previa del estudio en vivo con la reproducción real
function getActiveStudioLineIndex(currentTime) {
  const timed = studioLines.map((l, i) => ({ ...l, i })).filter(l => l.time !== null);
  if (timed.length === 0) return -1;
  let active = -1;
  for (const l of timed) {
    if (l.time <= currentTime) active = l.i;
    else break;
  }
  return active;
}
setInterval(() => {
  if (!lyricsStudioEl || !lyricsStudioEl.classList.contains('active')) return;
  const duration = activeAudio.duration || 0;
  const currentTime = activeAudio.currentTime || 0;
  if (studioProgress && duration) studioProgress.style.width = (currentTime / duration * 100) + '%';
  const curEl = document.getElementById('studio-current-time');
  const durEl = document.getElementById('studio-duration');
  if (curEl) curEl.textContent = formatTime(currentTime);
  if (durEl) durEl.textContent = formatTime(duration);

  const activeIdx = getActiveStudioLineIndex(currentTime);
  const previewLine = document.getElementById('studio-preview-line');
  if (previewLine) {
    if (activeIdx > -1 && studioLines[activeIdx]) {
      previewLine.textContent = studioLines[activeIdx].instrumental ? '🎵 (Instrumental)' : studioLines[activeIdx].text;
    } else {
      previewLine.textContent = 'Sin letra cargada todavía';
    }
  }
  document.querySelectorAll('.studio-line-row').forEach((row, i) => {
    row.classList.toggle('studio-active-row', i === activeIdx);
  });
  if (activeIdx > -1) {
    const activeRow = document.querySelector(`.studio-line-row[data-idx="${activeIdx}"]`);
    if (activeRow) activeRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  if (btnStudioPlayPause && playIcon) {
    const icon = document.getElementById('studio-play-icon');
    if (icon) icon.innerHTML = playIcon.innerHTML;
  }
}, 300);

// ==========================================
// MODO CALIBRACIÓN KARAOKE (desglosa la línea activa en palabras editables)
// ==========================================
const studioTabLines = document.getElementById('studio-tab-lines');
const studioTabKaraoke = document.getElementById('studio-tab-karaoke');
const studioLineList = document.getElementById('studio-line-list');
const studioDropzoneEl = document.getElementById('studio-dropzone');
const studioBatchRow = document.querySelector('.studio-batch-row');
const studioKaraokePanel = document.getElementById('studio-karaoke-panel');
let karaokeRenderedLineIndex = null;

function songHasCalibratedLines() {
  return studioLines.some(l => l.time !== null && l.time !== undefined);
}

if (studioTabLines) {
  studioTabLines.addEventListener('click', () => {
    playSFX('click');
    studioTabMode = 'lines';
    studioTabLines.classList.add('active');
    if (studioTabKaraoke) studioTabKaraoke.classList.remove('active');
    if (studioLineList) studioLineList.classList.remove('hidden');
    if (studioDropzoneEl) studioDropzoneEl.classList.remove('hidden');
    if (studioBatchRow) studioBatchRow.classList.remove('hidden');
    if (studioKaraokePanel) studioKaraokePanel.classList.add('hidden');
  });
}
if (studioTabKaraoke) {
  studioTabKaraoke.addEventListener('click', () => {
    playSFX('click');
    if (!songHasCalibratedLines()) {
      showToast('No puedes entrar aquí, primero tienes que calibrar las letras normales.', 'error', 5000);
      return;
    }
    studioTabMode = 'karaoke';
    studioTabKaraoke.classList.add('active');
    if (studioTabLines) studioTabLines.classList.remove('active');
    if (studioLineList) studioLineList.classList.add('hidden');
    if (studioDropzoneEl) studioDropzoneEl.classList.add('hidden');
    if (studioBatchRow) studioBatchRow.classList.add('hidden');
    if (studioKaraokePanel) studioKaraokePanel.classList.remove('hidden');
    karaokeRenderedLineIndex = null; // fuerza a redibujar la línea actual ya
  });
}

// Reparte parejo el tiempo entre las palabras de una línea, entre su inicio y el inicio
// de la siguiente línea con tiempo (o +3s si es la última). Es solo el punto de partida:
// después se ajusta fino con los botones de milisegundos.
function generateWordTimes(lineIndex) {
  const line = studioLines[lineIndex];
  if (!line || line.time === null) return [];
  const words = line.text.split(' ').filter(w => w !== '');
  let nextTime = line.time + 3;
  for (let i = lineIndex + 1; i < studioLines.length; i++) {
    if (studioLines[i].time !== null) { nextTime = studioLines[i].time; break; }
  }
  const span = Math.max(0.3, nextTime - line.time);
  return words.map((word, i) => ({ word, time: line.time + (span * i) / words.length }));
}

function renderKaraokeWords(lineIndex) {
  const wordsContainer = document.getElementById('studio-karaoke-words');
  const prevLineEl = document.getElementById('studio-karaoke-prev-line');
  const nextLineEl = document.getElementById('studio-karaoke-next-line');
  if (!wordsContainer) return;

  if (lineIndex < 0 || !studioLines[lineIndex]) {
    wordsContainer.innerHTML = '<p class="empty-msg">Esperando a que suene una línea con tiempo asignado...</p>';
    if (prevLineEl) prevLineEl.textContent = '';
    if (nextLineEl) nextLineEl.textContent = '';
    return;
  }

  if (prevLineEl) prevLineEl.textContent = studioLines[lineIndex - 1] ? studioLines[lineIndex - 1].text : '';
  if (nextLineEl) nextLineEl.textContent = studioLines[lineIndex + 1] ? studioLines[lineIndex + 1].text : '';

  const song = songList[currentIndex];
  if (!song.karaokeWords) song.karaokeWords = {};
  if (!song.karaokeWords[lineIndex]) {
    song.karaokeWords[lineIndex] = generateWordTimes(lineIndex);
    updateSongInDB(song);
  }
  const wordTimes = song.karaokeWords[lineIndex];

  wordsContainer.innerHTML = wordTimes.map((w, i) => `
    <div class="studio-karaoke-word-chip" data-line="${lineIndex}" data-word="${i}">
      <button class="studio-karaoke-word-text" data-line="${lineIndex}" data-word="${i}" title="Tócala justo cuando se cante">${w.word}</button>
      <span class="studio-karaoke-word-time">${formatLrcTime(w.time)}</span>
      <div class="studio-karaoke-word-btns">
        <button class="studio-nudge-btn" data-nudge="-100">-100</button>
        <button class="studio-nudge-btn" data-nudge="-50">-50</button>
        <button class="studio-nudge-btn" data-nudge="50">+50</button>
        <button class="studio-nudge-btn" data-nudge="100">+100</button>
      </div>
    </div>`).join('');

  // Tap-sync por palabra: tócala justo cuando se cante y le marca su tiempo real
  wordsContainer.querySelectorAll('.studio-karaoke-word-text').forEach(btn => {
    btn.addEventListener('click', (e) => {
      playSFX('click');
      const li = parseInt(e.currentTarget.dataset.line, 10);
      const wi = parseInt(e.currentTarget.dataset.word, 10);
      const song2 = songList[currentIndex];
      if (song2.karaokeWords && song2.karaokeWords[li] && song2.karaokeWords[li][wi]) {
        song2.karaokeWords[li][wi].time = activeAudio.currentTime || 0;
        updateSongInDB(song2);
        renderKaraokeWords(li);
      }
    });
  });

  wordsContainer.querySelectorAll('.studio-nudge-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      playSFX('click');
      const chip = e.currentTarget.closest('.studio-karaoke-word-chip');
      const li = parseInt(chip.dataset.line, 10);
      const wi = parseInt(chip.dataset.word, 10);
      const delta = parseInt(e.currentTarget.dataset.nudge, 10) / 1000;
      const song2 = songList[currentIndex];
      if (song2.karaokeWords && song2.karaokeWords[li] && song2.karaokeWords[li][wi]) {
        song2.karaokeWords[li][wi].time = Math.max(0, song2.karaokeWords[li][wi].time + delta);
        updateSongInDB(song2);
        renderKaraokeWords(li);
      }
    });
  });
}

// Se conecta al mismo reloj que ya sigue la línea activa del Estudio
setInterval(() => {
  if (!lyricsStudioEl || !lyricsStudioEl.classList.contains('active') || studioTabMode !== 'karaoke') return;
  const activeIdx = getActiveStudioLineIndex(activeAudio.currentTime || 0);
  if (activeIdx !== karaokeRenderedLineIndex) {
    karaokeRenderedLineIndex = activeIdx;
    renderKaraokeWords(activeIdx);
  }
}, 300);

// ==========================================
// LETRAS DECORADAS EN MODO CINE
// ==========================================
function syncCinemaDecoratedButton() {
  if (!cinemaLyricsStyleBtn || !toggleDecoratedLyrics) return;
  const decorated = !!toggleDecoratedLyrics.checked;
  cinemaLyricsStyleBtn.classList.toggle('decorated', decorated);
  cinemaLyricsStyleBtn.classList.toggle('normal', !decorated);
  cinemaLyricsStyleBtn.setAttribute('aria-pressed', String(decorated));
  cinemaLyricsStyleBtn.title = decorated ? 'Cambiar a letras normales' : 'Cambiar a letras decoradas';
  cinemaLyricsStyleBtn.setAttribute('aria-label', cinemaLyricsStyleBtn.title);
  const image = cinemaLyricsStyleBtn.querySelector('img');
  const letter = cinemaLyricsStyleBtn.querySelector('span');
  if (image) image.hidden = !decorated || cinemaLyricsStyleBtn.classList.contains('asset-missing');
  if (letter) letter.hidden = decorated && !cinemaLyricsStyleBtn.classList.contains('asset-missing');
  if (cinemaLyricsStyleBtn.classList.contains('asset-missing') && letter) letter.textContent = decorated ? 'Aa' : 'A';
}

if (cinemaLyricsStyleBtn) {
  const iconImage = cinemaLyricsStyleBtn.querySelector('img');
  if (iconImage) {
    const markMissingIcon = () => {
      cinemaLyricsStyleBtn.classList.add('asset-missing');
      syncCinemaDecoratedButton();
    };
    iconImage.addEventListener('error', markMissingIcon, { once: true });
    if (iconImage.complete && iconImage.naturalWidth === 0) markMissingIcon();
  }
  cinemaLyricsStyleBtn.addEventListener('click', () => {
    if (!toggleDecoratedLyrics) return;
    toggleDecoratedLyrics.checked = !toggleDecoratedLyrics.checked;
    toggleDecoratedLyrics.dispatchEvent(new Event('change', { bubbles: true }));
    syncCinemaDecoratedButton();
  });
}

if (toggleDecoratedLyrics) {
  const savedDecoratedLyrics = localStorage.getItem('decoratedLyricsEnabled');

  // La primera vez empieza con letras decoradas; las preferencias guardadas se respetan.
  toggleDecoratedLyrics.checked = savedDecoratedLyrics === null ? true : savedDecoratedLyrics === 'true';
  if (savedDecoratedLyrics === null) localStorage.setItem('decoratedLyricsEnabled', 'true');
  syncCinemaDecoratedButton();

  toggleDecoratedLyrics.addEventListener('change', (event) => {
    const enabled = event.target.checked;

    localStorage.setItem(
      'decoratedLyricsEnabled',
      enabled ? 'true' : 'false'
    );

    if (typeof syncCinemaDecoratedButton === 'function') syncCinemaDecoratedButton();

    if (typeof playSFX === 'function') {
      playSFX('click');
    }

    if (
      typeof songList !== 'undefined' &&
      Array.isArray(songList) &&
      songList.length > 0
    ) {
      const song = songList[currentIndex];

      if (song) {
        displayLyrics(song.lyrics || '');
      }
    }
  });
}


// =========================================================
// B46 — VISUALIZADOR REAL DEL MODO CINE
// Usa el analizador de audio existente y el color de interfaz activo.
// B47: visualizador apagado por defecto. El botón recorre apagado → compacto → ampliado → apagado.
// El botón de letras también desactiva el visualizador para recuperar la vista de letras.
// =========================================================
const cinemaAudioVisualizerBtn = document.getElementById('btn-cinema-audio-visualizer');
const cinemaAudioVisualizerBar = document.getElementById('cinema-audio-visualizer-bar');
const cinemaAudioVisualizerBarCanvas = document.getElementById('cinema-audio-visualizer-bar-canvas');
const cinemaAudioVisualizerStageCanvas = document.getElementById('cinema-audio-visualizer-stage');
const CINEMA_VISUALIZER_STORAGE_KEY = 'cinemaAudioVisualizerMode_b47';
let cinemaAudioVisualizerMode = (() => {
  let saved = '';
  try { saved = localStorage.getItem(CINEMA_VISUALIZER_STORAGE_KEY) || ''; } catch (_) {}
  return ['bar', 'expanded', 'off'].includes(saved) ? saved : 'off';
})();
let cinemaAudioVisualizerRaf = 0;
let cinemaAudioVisualizerLastFrame = 0;
let cinemaAudioVisualizerFrequencyData = null;

function syncCinemaAudioVisualizerState(mode, persist = true) {
  if (!['bar', 'expanded', 'off'].includes(mode)) mode = 'off';
  cinemaAudioVisualizerMode = mode;
  if (cinemaMode) {
    cinemaMode.classList.toggle('cinema-visualizer-bar-active', mode === 'bar');
    cinemaMode.classList.toggle('cinema-visualizer-expanded', mode === 'expanded');
    cinemaMode.classList.toggle('cinema-visualizer-off', mode === 'off');
    cinemaMode.dataset.visualizerMode = mode;
  }
  if (cinemaAudioVisualizerBtn) {
    const active = mode !== 'off';
    cinemaAudioVisualizerBtn.classList.toggle('active', active);
    cinemaAudioVisualizerBtn.setAttribute('aria-pressed', String(active));
    const title = mode === 'bar'
      ? 'Ampliar visualizador de audio'
      : mode === 'expanded'
        ? 'Desactivar visualizador de audio'
        : 'Activar visualizador compacto';
    cinemaAudioVisualizerBtn.title = title;
    cinemaAudioVisualizerBtn.setAttribute('aria-label', title);
  }
  if (persist) {
    try { localStorage.setItem(CINEMA_VISUALIZER_STORAGE_KEY, mode); } catch (_) {}
  }
  renderCinemaAudioVisualizerOnce();
  startCinemaAudioVisualizer();
}

function cinemaVisualizerAccent() {
  const rootStyles = getComputedStyle(document.documentElement);
  // --primary-color es la misma variable que cambia con los temas y el color dinámico inteligente.
  return rootStyles.getPropertyValue('--primary-color').trim()
    || rootStyles.getPropertyValue('--accent-color').trim()
    || '#d6ad65';
}

function drawCinemaAudioVisualizerCanvas(canvas, variant, frequencyData, isPlaying, deltaSeconds) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const targetWidth = Math.max(1, Math.round(rect.width * dpr));
  const targetHeight = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = rect.width;
  const height = rect.height;
  ctx.clearRect(0, 0, width, height);

  const compact = variant === 'bar';
  const barCount = Math.max(18, Math.min(compact ? 58 : 84, Math.floor(width / (compact ? 6 : 8))));
  if (!Array.isArray(canvas._glasstrackAudioLevels) || canvas._glasstrackAudioLevels.length !== barCount) {
    canvas._glasstrackAudioLevels = new Array(barCount).fill(0);
  }
  const levels = canvas._glasstrackAudioLevels;
  const dataLength = frequencyData ? frequencyData.length : 0;
  const gap = compact ? 1.8 : 2.8;
  const barWidth = Math.max(1.25, (width - gap * (barCount - 1)) / barCount);
  // B47: barras cortas por píxeles, no por porcentaje de toda la pantalla.
  // El modo ampliado ocupa el ancho del área de letras, pero no puede crecer a pantalla completa.
  const maxHeight = compact
    ? Math.min(16, height * 0.66)
    : Math.min(112, height * 0.34);
  const baseY = height * (compact ? 0.90 : 0.72);
  const accent = cinemaVisualizerAccent();
  const gradient = ctx.createLinearGradient(0, baseY - maxHeight, 0, baseY);
  gradient.addColorStop(0, 'rgba(255,255,255,0.76)');
  gradient.addColorStop(0.3, accent);
  gradient.addColorStop(1, accent);
  ctx.fillStyle = gradient;
  ctx.shadowColor = accent;
  ctx.shadowBlur = isPlaying ? (compact ? 2.2 : 5) : 0;

  // Normalización relativa por fotograma: mantiene diferencias entre frecuencias
  // cuando el volumen general es alto y evita que todas las barras se saturen juntas.
  const samples = new Array(barCount).fill(0);
  let framePeak = 0;
  if (isPlaying && dataLength > 0) {
    for (let i = 0; i < barCount; i++) {
      const fraction = i / Math.max(1, barCount - 1);
      const pos = Math.pow(fraction, 1.22) * (dataLength - 1);
      const lo = Math.floor(pos);
      const hi = Math.min(dataLength - 1, lo + 1);
      const mix = pos - lo;
      // Mezcla varios bins cercanos para evitar saltos entre frecuencias.
      const raw = (((frequencyData[lo] || 0) * (1 - mix)) + ((frequencyData[hi] || 0) * mix)) / 255;
      samples[i] = raw;
      if (raw > framePeak) framePeak = raw;
    }
  }
  const hasSignal = isPlaying && dataLength > 0 && framePeak > 0.025;

  for (let i = 0; i < barCount; i++) {
    let target = 0;
    if (hasSignal) {
      // Un poco de base mantiene todas las barras vivas; la curva moderada conserva el ritmo.
      const relativeEnergy = Math.min(1, samples[i] / Math.max(0.025, framePeak * 1.10));
      target = 0.025 + Math.pow(relativeEnergy, 1.42) * 0.62;
      target = Math.min(0.66, target);
    }
    const smoothing = target > levels[i] ? 0.34 : Math.max(0.14, 0.30 - deltaSeconds * 1.2);
    levels[i] = levels[i] + (target - levels[i]) * smoothing;
    const energy = Math.max(0.012, Math.min(0.66, levels[i]));
    const barHeight = Math.max(compact ? 1.5 : 2, energy * maxHeight);
    const x = i * (barWidth + gap);
    const y = baseY - barHeight;
    const radius = Math.min(barWidth / 2, compact ? 1.8 : 2.6);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, barWidth, barHeight, radius);
    else ctx.rect(x, y, barWidth, barHeight);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
  // Línea base fina usando el mismo color de acento del sistema.
  ctx.globalAlpha = compact ? 0.22 : 0.16;
  ctx.fillStyle = accent;
  ctx.fillRect(0, baseY + 1, width, 1);
  ctx.globalAlpha = 1;
}

function renderCinemaAudioVisualizerOnce(timestamp = performance.now()) {
  const analyser = (typeof concludorAnalyser !== 'undefined' && concludorAnalyser)
    ? concludorAnalyser : null;
  let data = null;
  const isPlaying = !!(activeAudio && !activeAudio.paused && !activeAudio.ended);
  if (isPlaying && analyser && typeof analyser.getByteFrequencyData === 'function') {
    try {
      if (!cinemaAudioVisualizerFrequencyData || cinemaAudioVisualizerFrequencyData.length !== analyser.frequencyBinCount) {
        cinemaAudioVisualizerFrequencyData = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(cinemaAudioVisualizerFrequencyData);
      data = cinemaAudioVisualizerFrequencyData;
    } catch (_) { data = null; }
  }
  const deltaSeconds = cinemaAudioVisualizerLastFrame
    ? Math.min(0.05, Math.max(0.001, (timestamp - cinemaAudioVisualizerLastFrame) / 1000)) : 1 / 30;
  cinemaAudioVisualizerLastFrame = timestamp;
  drawCinemaAudioVisualizerCanvas(cinemaAudioVisualizerBarCanvas, 'bar', data, isPlaying, deltaSeconds);
  drawCinemaAudioVisualizerCanvas(cinemaAudioVisualizerStageCanvas, 'expanded', data, isPlaying, deltaSeconds);
}

function startCinemaAudioVisualizer() {
  if (cinemaAudioVisualizerRaf || document.hidden || !cinemaMode?.classList.contains('active') || cinemaAudioVisualizerMode === 'off') return;
  const tick = (timestamp) => {
    cinemaAudioVisualizerRaf = 0;
    if (document.hidden || !cinemaMode?.classList.contains('active') || cinemaAudioVisualizerMode === 'off') {
      renderCinemaAudioVisualizerOnce(timestamp);
      return;
    }
    // 30 FPS basta para el efecto y reduce el coste visual del Modo Cine.
    if (!cinemaAudioVisualizerLastFrame || timestamp - cinemaAudioVisualizerLastFrame >= 30) {
      renderCinemaAudioVisualizerOnce(timestamp);
    }
    cinemaAudioVisualizerRaf = requestAnimationFrame(tick);
  };
  cinemaAudioVisualizerRaf = requestAnimationFrame(tick);
}

function stopCinemaAudioVisualizer() {
  if (cinemaAudioVisualizerRaf) cancelAnimationFrame(cinemaAudioVisualizerRaf);
  cinemaAudioVisualizerRaf = 0;
  renderCinemaAudioVisualizerOnce();
}

if (cinemaAudioVisualizerBtn) {
  cinemaAudioVisualizerBtn.addEventListener('click', () => {
    // B47: apagado por defecto; clic 1 = barra compacta, clic 2 = área ampliada,
    // clic 3 = apagado. Se conserva el ciclo aunque se cambie de canción.
    const next = cinemaAudioVisualizerMode === 'off'
      ? 'bar'
      : cinemaAudioVisualizerMode === 'bar'
        ? 'expanded'
        : 'off';
    try {
      if (typeof initAudioContext === 'function') initAudioContext();
      if (typeof audioCtx !== 'undefined' && audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    } catch (_) {}
    syncCinemaAudioVisualizerState(next, true);
  });
}

// Volver a la vista de letras deja el visualizador apagado; el botón propio lo reactiva.
if (cinemaLyricsStyleBtn) {
  cinemaLyricsStyleBtn.addEventListener('click', () => {
    syncCinemaAudioVisualizerState('off', true);
  });
}

if (cinemaMode) {
  syncCinemaAudioVisualizerState(cinemaAudioVisualizerMode, false);
  const visualizerModeObserver = new MutationObserver(() => {
    if (cinemaMode.classList.contains('active')) {
      renderCinemaAudioVisualizerOnce();
      startCinemaAudioVisualizer();
    } else {
      stopCinemaAudioVisualizer();
    }
  });
  visualizerModeObserver.observe(cinemaMode, { attributes: true, attributeFilter: ['class'] });
}
[audio1, audio2].filter(Boolean).forEach((audioElement) => {
  ['play', 'pause', 'loadedmetadata', 'timeupdate', 'seeked', 'ended'].forEach((eventName) => {
    audioElement.addEventListener(eventName, () => {
      if (cinemaMode?.classList.contains('active')) {
        renderCinemaAudioVisualizerOnce();
        startCinemaAudioVisualizer();
      }
    }, { passive: true });
  });
});
window.addEventListener('resize', () => {
  if (cinemaMode?.classList.contains('active')) renderCinemaAudioVisualizerOnce();
}, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCinemaAudioVisualizer();
  else startCinemaAudioVisualizer();
});


// =========================================================
// =========================================================
// MODO ESTUDIO Y2K STREAM — INDEPENDIENTE DEL MODO CINE
// =========================================================
const STREAM_STUDIO_DEPRECATED = true;
const STREAM_STUDIO_KEY = 'glasstrackStreamStudioConfig';
const STREAM_MEDIA_DB = 'streamMedia';

const defaultStreamSlots = [1, 2, 3, 4].map(i => ({
  slot: i,
  sourceType: 'none',
  sourceName: '',
  sourceUrl: '',
  clipStart: 0,
  clipEnd: 30,
  timelineStart: (i - 1) * 30,
  timelineEnd: i * 30
}));

let streamStudioConfig = {
  enabled: false,
  profile: { name: 'GLASSTRACK', badge: 'STREAMER', frame: 'glass' },
  style: {
    font: 'impact',
    color: '#ffffff',
    neon: true,
    stroke: 2,
    decorated: false,
    lines: 3,
    layout: 'staggered',
    vhsScanlines: true,
    vhsNoise: true,
    vhsFlicker: true,
    vhsRgb: true
  },
  crossfade: 1,
  totalDuration: 120,
  slots: defaultStreamSlots.map(s => ({ ...s }))
};

let streamRuntime = {
  open: false,
  playing: false,
  startedAt: 0,
  elapsedBeforePause: 0,
  currentSlot: 0,
  raf: 0,
  activeLayer: 'a',
  activeSlotKey: null,
  crossfadeSlotKey: null,
  objectUrls: {},
  lastSongIndex: null,
  kineticTimer: null,
  lyricBlockIndex: 0
};

function saveStreamStudioConfig() {
  try {
    localStorage.setItem(STREAM_STUDIO_KEY, JSON.stringify(streamStudioConfig));
  } catch (err) {
    console.warn('No se pudo guardar el Modo Estudio Y2K:', err);
  }
}

function loadStreamStudioConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem(STREAM_STUDIO_KEY) || 'null');
    if (!raw) return;

    streamStudioConfig = {
      ...streamStudioConfig,
      ...raw,
      profile: { ...streamStudioConfig.profile, ...(raw.profile || {}) },
      style: { ...streamStudioConfig.style, ...(raw.style || {}) },
      slots: defaultStreamSlots.map(def => ({
        ...def,
        ...((raw.slots || [])[def.slot - 1] || {})
      }))
    };
  } catch (err) {
    console.warn('No se pudo cargar el Modo Estudio Y2K:', err);
  }
}

function streamFormatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function escapeHtmlStream(value) {
  return String(value || '').replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[c]));
}

function escapeAttrStream(value) {
  return escapeHtmlStream(value);
}

function openStreamMediaDB(mode = 'readonly') {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error('IndexedDB principal aún no está listo'));
    try {
      const tx = db.transaction([STREAM_MEDIA_DB], mode);
      resolve(tx.objectStore(STREAM_MEDIA_DB));
    } catch (err) {
      reject(err);
    }
  });
}

async function saveLocalStreamBlob(slot, file) {
  try {
    const store = await openStreamMediaDB('readwrite');
    await new Promise((resolve, reject) => {
      const req = store.put({ slot, blob: file, name: file.name, type: file.type });
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
    return true;
  } catch (err) {
    console.warn('No se pudo guardar el video local del Stream Studio:', err);
    return false;
  }
}

async function loadLocalStreamBlob(slot) {
  try {
    const store = await openStreamMediaDB('readonly');
    return await new Promise((resolve, reject) => {
      const req = store.get(slot);
      req.onsuccess = () => resolve(req.result?.blob || null);
      req.onerror = () => reject(req.error);
    });
  } catch (_) {
    return null;
  }
}

async function deleteLocalStreamBlob(slot) {
  try {
    const store = await openStreamMediaDB('readwrite');
    await new Promise((resolve, reject) => {
      const req = store.delete(slot);
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
  } catch (_) {}
}

function revokeStreamObjectUrls() {
  Object.values(streamRuntime.objectUrls).forEach(url => {
    try { URL.revokeObjectURL(url); } catch (_) {}
  });
  streamRuntime.objectUrls = {};
}

function streamSourceLabel(slot) {
  if (!slot) return 'Sin fuente';
  if (slot.sourceType === 'local') return slot.sourceName || 'Archivo local';
  if (slot.sourceType === 'url') return slot.sourceUrl || 'URL externa';
  return 'Sin fuente';
}

function streamIsGif(slot) {
  const src = `${slot?.sourceName || ''} ${slot?.sourceUrl || ''}`.toLowerCase();
  return src.includes('.gif') || (slot?.sourceType === 'local' && /\.gif$/i.test(slot.sourceName || ''));
}

function streamMediaUrl(slot) {
  if (!slot) return '';
  if (slot.sourceType === 'url') return slot.sourceUrl || '';
  return streamRuntime.objectUrls[slot.slot] || '';
}

function renderStreamSlotEditor() {
  if (!streamSlotList) return;
  streamSlotList.innerHTML = '';

  streamStudioConfig.slots.forEach(slot => {
    const wrap = document.createElement('div');
    wrap.className = 'stream-slot-card';
    wrap.dataset.slot = String(slot.slot);
    wrap.innerHTML = `
      <div class="stream-slot-head">
        <strong>VIDEO ${slot.slot}</strong>
        <span class="stream-slot-source">${escapeHtmlStream(streamSourceLabel(slot))}</span>
      </div>
      <div class="stream-source-row">
        <label class="stream-file-label">
          <span>Archivo</span>
          <input class="stream-file-input" data-action="file" type="file" accept="video/mp4,video/webm,image/gif">
        </label>
        <label class="stream-url-field">
          <span>URL / GIF</span>
          <input class="stream-url-input" data-action="url" type="url" placeholder="https://.../video.mp4 o .gif" value="${escapeAttrStream(slot.sourceUrl)}">
        </label>
        <button type="button" class="stream-mini-btn" data-action="apply-url">Usar URL</button>
        <button type="button" class="stream-mini-btn stream-danger-btn" data-action="clear-source">Quitar</button>
      </div>
      <div class="stream-range-grid">
        <label>Recorte inicio<input data-action="clip-start" type="number" min="0" step="0.1" value="${slot.clipStart}"></label>
        <label>Recorte fin<input data-action="clip-end" type="number" min="0.1" step="0.1" value="${slot.clipEnd}"></label>
        <label>Timeline inicio<input data-action="timeline-start" type="number" min="0" step="0.1" value="${slot.timelineStart}"></label>
        <label>Timeline fin<input data-action="timeline-end" type="number" min="0.1" step="0.1" value="${slot.timelineEnd}"></label>
      </div>`;
    streamSlotList.appendChild(wrap);
  });
}

function normalizeKineticCharacter(char) {
  return String(char || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function createStreamDecoratedChar(char) {
  const normalized = normalizeKineticCharacter(char);

  if (char === ' ') {
    const space = document.createElement('span');
    space.className = 'decorated-space';
    return space;
  }

  if (/^[a-z]$/.test(normalized) || /^[0-9]$/.test(normalized)) {
    const img = document.createElement('img');
    const variant = /^[0-9]$/.test(normalized) ? 1 : Math.floor(Math.random() * 3) + 1;
    img.className = 'stream-decorated-char';
    img.src = `img/letras/${normalized}_${variant}.png`;
    img.alt = char;
    img.draggable = false;
    img.onerror = function () {
      this.style.display = 'none';
      const fallback = document.createElement('span');
      fallback.className = 'stream-decorated-fallback';
      fallback.textContent = char;
      if (this.parentNode) this.parentNode.appendChild(fallback);
    };
    return img;
  }

  const fallback = document.createElement('span');
  fallback.className = 'stream-decorated-fallback';
  fallback.textContent = char;
  return fallback;
}

function createStreamKineticLine(text) {
  const line = document.createElement('span');
  line.className = 'stream-kinetic-line';

  if (!streamStudioConfig.style.decorated) {
    line.textContent = text;
    return line;
  }

  Array.from(text).forEach(char => {
    line.appendChild(createStreamDecoratedChar(char));
  });
  return line;
}

function getStreamLyricBlocks(text) {
  const rawLines = String(text || '')
    .split(/\r?\n/)
    .map(v => v.trim())
    .filter(Boolean);

  if (!rawLines.length) return [['Modo'], ['Stream Y2K'], ['Visualizer']];

  const wanted = Math.min(4, Math.max(2, Number(streamStudioConfig.style.lines) || 3));
  const blocks = [];

  for (let i = 0; i < rawLines.length; i += wanted) {
    const block = rawLines.slice(i, i + wanted);
    if (block.length >= 2) blocks.push(block);
  }

  if (!blocks.length) {
    const words = rawLines[0].split(/\s+/).filter(Boolean);
    const count = Math.min(wanted, Math.max(2, words.length));
    const perLine = Math.ceil(words.length / count);
    const block = [];
    for (let i = 0; i < words.length; i += perLine) block.push(words.slice(i, i + perLine).join(' '));
    while (block.length < 2) block.push('');
    return [block.slice(0, wanted)];
  }

  return blocks;
}

function renderStreamLyricPreview(text, animate = true) {
  if (!streamLyricPreview) return;

  const blocks = getStreamLyricBlocks(text);
  streamLyricPreview.innerHTML = '';

  const block = blocks[streamRuntime.lyricBlockIndex % blocks.length] || blocks[0];
  block.forEach((lineText, index) => {
    const line = createStreamKineticLine(lineText || ' ');
    line.style.setProperty('--kinetic-index', index);
    line.dataset.index = String(index);
    streamLyricPreview.appendChild(line);
  });

  streamLyricPreview.dataset.layout = streamStudioConfig.style.layout || 'staggered';

  if (animate) {
    streamLyricPreview.classList.remove('kinetic-snap');
    requestAnimationFrame(() => streamLyricPreview.classList.add('kinetic-snap'));
  }
}

function startKineticPreview(text) {
  clearInterval(streamRuntime.kineticTimer);
  const blocks = getStreamLyricBlocks(text);
  streamRuntime.lyricBlockIndex = 0;
  renderStreamLyricPreview(text, true);

  if (blocks.length <= 1) return;

  streamRuntime.kineticTimer = setInterval(() => {
    if (!streamRuntime.open) return;
    streamRuntime.lyricBlockIndex = (streamRuntime.lyricBlockIndex + 1) % blocks.length;
    renderStreamLyricPreview(text, true);
  }, 2500);
}

function updateStreamPreviewInfo() {
  const name = streamStudioConfig.profile.name.trim() || 'GLASSTRACK';
  const badge = streamStudioConfig.profile.badge || 'STREAMER';

  if (streamPreviewNick) streamPreviewNick.textContent = name;
  if (streamPreviewBadge) streamPreviewBadge.textContent = badge;
  if (streamProfilePreview) streamProfilePreview.dataset.frame = streamStudioConfig.profile.frame || 'glass';

  if (streamLivePreview) {
    streamLivePreview.dataset.font = streamStudioConfig.style.font || 'impact';
    streamLivePreview.style.setProperty('--stream-accent', streamStudioConfig.style.color || '#ffffff');
    streamLivePreview.style.setProperty('--stream-stroke', `${Number(streamStudioConfig.style.stroke) || 0}px`);
    streamLivePreview.classList.toggle('stream-neon-off', !streamStudioConfig.style.neon);
    streamLivePreview.classList.toggle('stream-decorated-on', !!streamStudioConfig.style.decorated);
    streamLivePreview.classList.toggle('stream-rgb-off', !streamStudioConfig.style.vhsRgb);
  }

  const scan = document.getElementById('stream-vhs-scanlines-layer');
  const noise = document.getElementById('stream-vhs-noise-layer');
  const flicker = document.getElementById('stream-vhs-flicker-layer');
  const rgb = document.getElementById('stream-vhs-rgb-layer');
  if (scan) scan.hidden = !streamStudioConfig.style.vhsScanlines;
  if (noise) noise.hidden = !streamStudioConfig.style.vhsNoise;
  if (flicker) flicker.hidden = !streamStudioConfig.style.vhsFlicker;
  if (rgb) rgb.hidden = !streamStudioConfig.style.vhsRgb;

  const song = songList[currentIndex];
  if (song) {
    if (streamPreviewTitle) streamPreviewTitle.textContent = song.title || 'Sin título';
    if (streamPreviewArtist) streamPreviewArtist.textContent = song.artist || '—';
    startKineticPreview(song.lyrics || '');
  } else {
    startKineticPreview('Modo Stream Y2K\nKinetic Visualizer\nGLASSTRACK');
  }
}

function getStreamTimelineDuration() {
  const configured = Math.max(1, Number(streamStudioConfig.totalDuration) || 1);
  const slotsMax = streamStudioConfig.slots.reduce((max, slot) => Math.max(max, Number(slot.timelineEnd) || 0), 0);
  return Math.max(configured, slotsMax);
}

function findStreamSlot(time) {
  const candidates = streamStudioConfig.slots.filter(slot => {
    const start = Number(slot.timelineStart) || 0;
    const end = Number(slot.timelineEnd) || 0;
    return slot.sourceType !== 'none' && end > start && time >= start && time < end;
  });
  return candidates.length ? candidates[candidates.length - 1] : null;
}

function clearStreamLayer(layerName) {
  const video = layerName === 'a' ? streamMediaA : streamMediaB;
  const gif = layerName === 'a' ? streamGifA : streamGifB;
  if (video) {
    video.pause();
    video.removeAttribute('src');
    try { video.load(); } catch (_) {}
    video.style.opacity = '0';
  }
  if (gif) {
    gif.removeAttribute('src');
    gif.style.opacity = '0';
  }
}

function setStreamLayerVisibility(layerName, opacity) {
  const video = layerName === 'a' ? streamMediaA : streamMediaB;
  const gif = layerName === 'a' ? streamGifA : streamGifB;
  if (video) video.style.opacity = String(opacity);
  if (gif) gif.style.opacity = String(opacity);
}

function configureStreamVideo(video, slot, url) {
  if (!video) return;
  video.pause();
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.load();
  video.onloadedmetadata = () => {
    try {
      video.currentTime = Math.max(0, Number(slot.clipStart) || 0);
    } catch (_) {}
    if (streamRuntime.playing) video.play().catch(() => {});
  };
}

function loadStreamSlotIntoLayer(slot, layerName) {
  clearStreamLayer(layerName);
  if (!slot) return;
  const url = streamMediaUrl(slot);
  if (!url) return;

  if (streamIsGif(slot)) {
    const gif = layerName === 'a' ? streamGifA : streamGifB;
    if (gif) {
      gif.src = url;
      gif.style.opacity = '0';
    }
  } else {
    configureStreamVideo(layerName === 'a' ? streamMediaA : streamMediaB, slot, url);
  }
}

function playStreamLayerAtTime(slot, layerName, globalTime) {
  if (!slot || streamIsGif(slot)) return;
  const video = layerName === 'a' ? streamMediaA : streamMediaB;
  if (!video) return;

  const clipStart = Math.max(0, Number(slot.clipStart) || 0);
  const clipEnd = Math.max(clipStart + 0.1, Number(slot.clipEnd) || clipStart + 0.1);
  const timelineStart = Number(slot.timelineStart) || 0;
  let target = clipStart + Math.max(0, globalTime - timelineStart);
  if (target >= clipEnd) target = clipStart;

  try {
    if (Math.abs((video.currentTime || 0) - target) > 0.25) video.currentTime = target;
  } catch (_) {}

  if (streamRuntime.playing) video.play().catch(() => {});
}

function updateStreamLayers(slot, time) {
  if (!slot) return;

  if (streamRuntime.activeSlotKey !== slot.slot) {
    const nextLayer = streamRuntime.activeLayer === 'a' ? 'b' : 'a';
    loadStreamSlotIntoLayer(slot, nextLayer);
    setStreamLayerVisibility(nextLayer, 1);
    clearStreamLayer(streamRuntime.activeLayer);
    streamRuntime.activeLayer = nextLayer;
    streamRuntime.activeSlotKey = slot.slot;
    streamRuntime.crossfadeSlotKey = null;
  }

  const fade = Math.min(5, Math.max(0, Number(streamStudioConfig.crossfade) || 0));
  const end = Number(slot.timelineEnd) || 0;
  const remaining = end - time;
  const nextSlot = streamStudioConfig.slots.find(candidate =>
    candidate.slot !== slot.slot &&
    candidate.sourceType !== 'none' &&
    Math.abs((Number(candidate.timelineStart) || 0) - end) < 0.01
  );

  if (fade > 0 && nextSlot && remaining > 0 && remaining <= fade) {
    const nextLayer = streamRuntime.activeLayer === 'a' ? 'b' : 'a';
    if (streamRuntime.crossfadeSlotKey !== nextSlot.slot) {
      loadStreamSlotIntoLayer(nextSlot, nextLayer);
      streamRuntime.crossfadeSlotKey = nextSlot.slot;
    }

    const amount = Math.max(0, Math.min(1, 1 - remaining / fade));
    setStreamLayerVisibility(streamRuntime.activeLayer, 1 - amount);
    setStreamLayerVisibility(nextLayer, amount);
    playStreamLayerAtTime(nextSlot, nextLayer, time);
  } else {
    setStreamLayerVisibility(streamRuntime.activeLayer, 1);
  }

  playStreamLayerAtTime(slot, streamRuntime.activeLayer, time);
}

function renderStreamAtTime(time) {
  const duration = getStreamTimelineDuration();
  const safeTime = Math.min(duration, Math.max(0, Number(time) || 0));
  streamRuntime.elapsedBeforePause = safeTime;

  if (streamPreviewClock) streamPreviewClock.textContent = `${streamFormatTime(safeTime)} / ${streamFormatTime(duration)}`;
  if (streamMarkerFill) streamMarkerFill.style.width = `${duration ? (safeTime / duration) * 100 : 0}%`;

  const slot = findStreamSlot(safeTime);
  if (slot) {
    streamRuntime.currentSlot = slot.slot;
    if (streamCurrentSlot) streamCurrentSlot.textContent = `Video ${slot.slot}`;
    if (streamCurrentMedia) streamCurrentMedia.textContent = streamSourceLabel(slot);
    updateStreamLayers(slot, safeTime);
  } else {
    streamRuntime.currentSlot = 0;
    streamRuntime.activeSlotKey = null;
    streamRuntime.crossfadeSlotKey = null;
    if (streamCurrentSlot) streamCurrentSlot.textContent = 'Sin video activo';
    if (streamCurrentMedia) streamCurrentMedia.textContent = 'Añade una fuente a una ranura';
    clearStreamLayer('a');
    clearStreamLayer('b');
  }

  if (streamRuntime.lastSongIndex !== currentIndex) {
    streamRuntime.lastSongIndex = currentIndex;
    updateStreamPreviewInfo();
  }
}

function streamAnimationLoop(now) {
  if (!streamRuntime.playing) return;
  const elapsed = (now - streamRuntime.startedAt) / 1000 + streamRuntime.elapsedBeforePause;
  const duration = getStreamTimelineDuration();

  if (elapsed >= duration) {
    streamRuntime.elapsedBeforePause = duration;
    streamRuntime.playing = false;
    streamStatus && (streamStatus.textContent = 'READY');
    renderStreamAtTime(duration);
    return;
  }

  renderStreamAtTime(elapsed);
  streamRuntime.raf = requestAnimationFrame(streamAnimationLoop);
}

function playStreamSequence() {
  if (STREAM_STUDIO_DEPRECATED) return;
  if (!streamRuntime.open) openStreamStudio();
  streamRuntime.playing = true;
  streamRuntime.startedAt = performance.now();
  if (streamStatus) streamStatus.textContent = 'LIVE';
  cancelAnimationFrame(streamRuntime.raf);
  streamRuntime.raf = requestAnimationFrame(streamAnimationLoop);
}

function pauseStreamSequence() {
  streamRuntime.playing = false;
  cancelAnimationFrame(streamRuntime.raf);
  [streamMediaA, streamMediaB].forEach(v => { if (v) v.pause(); });
  if (streamStatus) streamStatus.textContent = 'PAUSED';
}

function restartStreamSequence() {
  if (STREAM_STUDIO_DEPRECATED) return;
  streamRuntime.playing = false;
  cancelAnimationFrame(streamRuntime.raf);
  streamRuntime.elapsedBeforePause = 0;
  streamRuntime.activeSlotKey = null;
  streamRuntime.crossfadeSlotKey = null;
  streamRuntime.activeLayer = 'a';
  renderStreamAtTime(0);
  playStreamSequence();
}

async function prepareStreamMedia() {
  revokeStreamObjectUrls();
  await Promise.all(streamStudioConfig.slots.map(async slot => {
    if (slot.sourceType !== 'local') return;
    const blob = await loadLocalStreamBlob(slot.slot);
    if (blob) streamRuntime.objectUrls[slot.slot] = URL.createObjectURL(blob);
  }));
}

async function setStreamSlotSource(slotNumber, file) {
  const slot = streamStudioConfig.slots[slotNumber - 1];
  if (!slot || !file) return;

  slot.sourceType = 'local';
  slot.sourceName = file.name;
  slot.sourceUrl = '';

  await saveLocalStreamBlob(slot.slot, file);
  await prepareStreamMedia();
  saveStreamStudioConfig();
  renderStreamSlotEditor();
  renderStreamAtTime(streamRuntime.elapsedBeforePause);
}

async function setStreamSlotUrl(slotNumber, url) {
  const slot = streamStudioConfig.slots[slotNumber - 1];
  if (!slot) return;

  const clean = String(url || '').trim();
  if (!clean) return;

  slot.sourceType = 'url';
  slot.sourceName = clean.split('/').pop() || 'URL externa';
  slot.sourceUrl = clean;

  await deleteLocalStreamBlob(slot.slot);
  await prepareStreamMedia();
  saveStreamStudioConfig();
  renderStreamSlotEditor();
  renderStreamAtTime(streamRuntime.elapsedBeforePause);
}

async function clearStreamSlot(slotNumber) {
  const slot = streamStudioConfig.slots[slotNumber - 1];
  if (!slot) return;

  slot.sourceType = 'none';
  slot.sourceName = '';
  slot.sourceUrl = '';

  await deleteLocalStreamBlob(slot.slot);
  await prepareStreamMedia();
  saveStreamStudioConfig();
  renderStreamSlotEditor();
  renderStreamAtTime(streamRuntime.elapsedBeforePause);
}

function openStreamStudio() {
  if (STREAM_STUDIO_DEPRECATED || !streamStudioMode) return;

  streamRuntime.open = true;
  streamStudioMode.classList.add('active');
  streamStudioMode.setAttribute('aria-hidden', 'false');
  document.body.classList.add('stream-studio-open');
  if (toggleStreamStudio) toggleStreamStudio.checked = true;
  streamStudioConfig.enabled = true;
  if (streamStatus) streamStatus.textContent = 'READY';

  updateStreamPreviewInfo();
  renderStreamSlotEditor();
  prepareStreamMedia().then(() => renderStreamAtTime(streamRuntime.elapsedBeforePause));
}

function closeStreamStudio() {
  if (!streamStudioMode) return;

  streamRuntime.open = false;
  streamRuntime.playing = false;
  clearInterval(streamRuntime.kineticTimer);
  streamRuntime.kineticTimer = null;
  cancelAnimationFrame(streamRuntime.raf);

  [streamMediaA, streamMediaB].forEach(v => { if (v) v.pause(); });

  streamStudioMode.classList.remove('active');
  streamStudioMode.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('stream-studio-open');
  if (toggleStreamStudio) toggleStreamStudio.checked = false;
  streamStudioConfig.enabled = false;
  if (streamStatus) streamStatus.textContent = 'OFFLINE';
  saveStreamStudioConfig();
}

function bindStreamStudioUI() {
  loadStreamStudioConfig();
  if (STREAM_STUDIO_DEPRECATED) {
    if (toggleStreamStudio) { toggleStreamStudio.disabled = true; toggleStreamStudio.checked = false; }
    if (btnOpenStreamStudio) btnOpenStreamStudio.disabled = true;
    if (streamStudioMode) { streamStudioMode.classList.remove('active'); streamStudioMode.setAttribute('aria-hidden', 'true'); }
    return;
  }
  if (toggleStreamStudio) toggleStreamStudio.checked = false;

  // Pestañas
  document.querySelectorAll('.stream-tab[data-stream-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.streamTab;
      document.querySelectorAll('.stream-tab[data-stream-tab]').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.stream-tab-panel[data-stream-panel]').forEach(panel => {
        panel.classList.toggle('active', panel.dataset.streamPanel === target);
      });
    });
  });

  if (toggleStreamStudio) {
    toggleStreamStudio.disabled = STREAM_STUDIO_DEPRECATED;
    toggleStreamStudio.checked = false;
    if (!STREAM_STUDIO_DEPRECATED) {
      toggleStreamStudio.addEventListener('change', () => {
        if (toggleStreamStudio.checked) openStreamStudio();
        else closeStreamStudio();
      });
    }
  }

  if (btnOpenStreamStudio) {
    btnOpenStreamStudio.disabled = STREAM_STUDIO_DEPRECATED;
    if (!STREAM_STUDIO_DEPRECATED) {
      btnOpenStreamStudio.addEventListener('click', () => { playSFX('open'); openStreamStudio(); });
    }
  }
  if (btnStreamStudioClose) btnStreamStudioClose.addEventListener('click', () => { playSFX('close'); closeStreamStudio(); });
  if (btnStreamStudioPlay) btnStreamStudioPlay.addEventListener('click', () => { playSFX('click'); playStreamSequence(); });
  if (btnStreamStudioPause) btnStreamStudioPause.addEventListener('click', () => { playSFX('click'); pauseStreamSequence(); });
  if (btnStreamStudioRestart) btnStreamStudioRestart.addEventListener('click', () => { playSFX('click'); restartStreamSequence(); });

  if (btnStreamStudioReset) {
    btnStreamStudioReset.addEventListener('click', async () => {
      playSFX('click');
      if (!confirm('¿Restablecer el Modo Estudio Y2K Stream?')) return;
      for (const slot of streamStudioConfig.slots) await deleteLocalStreamBlob(slot.slot);
      revokeStreamObjectUrls();
      streamStudioConfig = {
        enabled: false,
        profile: { name: 'GLASSTRACK', badge: 'STREAMER', frame: 'glass' },
        style: {
          font: 'impact', color: '#ffffff', neon: true, stroke: 2, decorated: false,
          lines: 3, layout: 'staggered', vhsScanlines: true, vhsNoise: true,
          vhsFlicker: true, vhsRgb: true
        },
        crossfade: 1,
        totalDuration: 120,
        slots: defaultStreamSlots.map(s => ({ ...s }))
      };
      streamRuntime.elapsedBeforePause = 0;
      streamRuntime.activeSlotKey = null;
      streamRuntime.crossfadeSlotKey = null;
      if (toggleStreamStudio) toggleStreamStudio.checked = false;
      syncStreamInputsFromConfig();
      renderStreamSlotEditor();
      updateStreamPreviewInfo();
      renderStreamAtTime(0);
      closeStreamStudio();
      saveStreamStudioConfig();
    });
  }

  // Slots
  if (streamSlotList) {
    streamSlotList.addEventListener('change', async e => {
      const card = e.target.closest('.stream-slot-card');
      if (!card) return;
      const slotNum = Number(card.dataset.slot);
      const slot = streamStudioConfig.slots[slotNum - 1];
      if (!slot) return;

      const action = e.target.dataset.action;
      if (action === 'file') {
        await setStreamSlotSource(slotNum, e.target.files?.[0]);
        return;
      }
      if (action === 'clip-start') slot.clipStart = Math.max(0, Number(e.target.value) || 0);
      if (action === 'clip-end') slot.clipEnd = Math.max(slot.clipStart + 0.1, Number(e.target.value) || 0);
      if (action === 'timeline-start') slot.timelineStart = Math.max(0, Number(e.target.value) || 0);
      if (action === 'timeline-end') slot.timelineEnd = Math.max(slot.timelineStart + 0.1, Number(e.target.value) || 0);

      saveStreamStudioConfig();
      renderStreamSlotEditor();
      renderStreamAtTime(streamRuntime.elapsedBeforePause);
    });

    streamSlotList.addEventListener('click', async e => {
      const btn = e.target.closest('button[data-action]');
      const card = e.target.closest('.stream-slot-card');
      if (!btn || !card) return;

      const slotNum = Number(card.dataset.slot);
      if (btn.dataset.action === 'apply-url') {
        const input = card.querySelector('.stream-url-input');
        await setStreamSlotUrl(slotNum, input?.value || '');
      } else if (btn.dataset.action === 'clear-source') {
        await clearStreamSlot(slotNum);
      }
    });
  }

  const bindValue = (id, fn) => {
    const el = document.getElementById(id);
    if (!el) return;
    const apply = () => {
      fn(el.value, el);
      saveStreamStudioConfig();
      updateStreamPreviewInfo();
      renderStreamAtTime(streamRuntime.elapsedBeforePause);
    };
    el.addEventListener('input', apply);
    el.addEventListener('change', apply);
  };

  bindValue('stream-profile-name', v => streamStudioConfig.profile.name = v);
  bindValue('stream-profile-badge', v => streamStudioConfig.profile.badge = v);
  bindValue('stream-profile-frame', v => streamStudioConfig.profile.frame = v);
  bindValue('stream-style-font', v => streamStudioConfig.style.font = v);
  bindValue('stream-style-color', v => streamStudioConfig.style.color = v);
  bindValue('stream-style-stroke', v => streamStudioConfig.style.stroke = Number(v) || 0);
  bindValue('stream-style-lines', v => streamStudioConfig.style.lines = Math.min(4, Math.max(2, Number(v) || 3)));
  bindValue('stream-style-layout', v => streamStudioConfig.style.layout = v || 'staggered');
  bindValue('stream-crossfade', v => streamStudioConfig.crossfade = Math.min(5, Math.max(0, Number(v) || 0)));
  bindValue('stream-total-duration', v => streamStudioConfig.totalDuration = Math.max(1, Number(v) || 1));

  const bindCheck = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      streamStudioConfig.style[key] = !!el.checked;
      saveStreamStudioConfig();
      updateStreamPreviewInfo();
    });
  };

  bindCheck('stream-style-neon', 'neon');
  bindCheck('stream-style-decorated', 'decorated');
  bindCheck('stream-vhs-scanlines', 'vhsScanlines');
  bindCheck('stream-vhs-noise', 'vhsNoise');
  bindCheck('stream-vhs-flicker', 'vhsFlicker');
  bindCheck('stream-vhs-rgb', 'vhsRgb');

  syncStreamInputsFromConfig();
  renderStreamSlotEditor();
  updateStreamPreviewInfo();

  if (!STREAM_STUDIO_DEPRECATED) {
    document.addEventListener('keydown', e => {
      if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.code === 'KeyP') {
        e.preventDefault();
        if (streamRuntime.open) closeStreamStudio();
        else openStreamStudio();
      } else if (e.code === 'KeyI') {
        e.preventDefault();
        if (streamRuntime.open) closeStreamStudio();
      }
    });
  }
}

function syncStreamInputsFromConfig() {
  const setVal = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  };
  const setCheck = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.checked = !!value;
  };

  setVal('stream-profile-name', streamStudioConfig.profile.name);
  setVal('stream-profile-badge', streamStudioConfig.profile.badge);
  setVal('stream-profile-frame', streamStudioConfig.profile.frame);
  setVal('stream-style-font', streamStudioConfig.style.font);
  setVal('stream-style-color', streamStudioConfig.style.color);
  setVal('stream-style-stroke', streamStudioConfig.style.stroke);
  setVal('stream-style-lines', streamStudioConfig.style.lines);
  setVal('stream-style-layout', streamStudioConfig.style.layout);
  setVal('stream-crossfade', streamStudioConfig.crossfade);
  setVal('stream-total-duration', streamStudioConfig.totalDuration);
  setCheck('stream-style-neon', streamStudioConfig.style.neon);
  setCheck('stream-style-decorated', streamStudioConfig.style.decorated);
  setCheck('stream-vhs-scanlines', streamStudioConfig.style.vhsScanlines);
  setCheck('stream-vhs-noise', streamStudioConfig.style.vhsNoise);
  setCheck('stream-vhs-flicker', streamStudioConfig.style.vhsFlicker);
  setCheck('stream-vhs-rgb', streamStudioConfig.style.vhsRgb);
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', bindStreamStudioUI);
}


// =========================================================
// MODO PERSPECTIVA MOBILE 3D — INDEPENDIENTE
// =========================================================
(() => {
  'use strict';

  const overlay = document.getElementById('mobile-3d-mode');
  const phone = document.getElementById('mobile-3d-phone');
  const closeBtn = document.getElementById('mobile-3d-close');
  const art = document.getElementById('mobile-3d-art');
  const trackTitle = document.getElementById('mobile-3d-title');
  const trackArtist = document.getElementById('mobile-3d-artist');
  const progress = document.getElementById('mobile-3d-progress');
  const currentTimeEl = document.getElementById('mobile-3d-current-time');
  const durationEl = document.getElementById('mobile-3d-duration');
  const playButton = document.getElementById('mobile-3d-play');
  const playIcon = document.getElementById('mobile-3d-play-icon');
  const canvas = document.getElementById('mobile-3d-visualizer');

  if (!overlay || !phone || !canvas) return;

  let visualizerFrame = 0;
  let lastColorSource = '';
  let isSeeking = false;

  function format3DTime(seconds) {
    const safe = Number.isFinite(Number(seconds)) ? Math.max(0, Number(seconds)) : 0;
    const m = Math.floor(safe / 60);
    const s = Math.floor(safe % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function setAccent(r, g, b) {
    const rgb = `${r}, ${g}, ${b}`;
    const root = document.documentElement;
    root.style.setProperty('--dominant-rgb', rgb);
    root.style.setProperty('--m3d-accent', `rgb(${rgb})`);
    root.style.setProperty('--m3d-accent-rgb', rgb);
  }

  function setAccentFromHex(hex) {
    const clean = String(hex || '').replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
      setAccent(154, 163, 173);
      return;
    }
    setAccent(
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16)
    );
  }

  async function extractDominantColor(src) {
    if (!src) return null;

    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';

    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = src;
    });

    const sample = 64;
    const temp = document.createElement('canvas');
    temp.width = sample;
    temp.height = sample;

    const ctx = temp.getContext('2d', {
      willReadFrequently: true
    });

    if (!ctx) return null;

    ctx.drawImage(image, 0, 0, sample, sample);

    const data = ctx.getImageData(
      0,
      0,
      sample,
      sample
    ).data;

    // Cuantizamos colores en cubos de 32 niveles para encontrar
    // un color dominante real en lugar de promediar toda la portada.
    const buckets = new Map();

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha < 120) continue;

      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max - min;

      // Evitamos negros/grises casi puros y blancos lavados.
      if (max < 22 || (min > 242 && saturation < 18)) continue;

      const rq = Math.round(r / 32) * 32;
      const gq = Math.round(g / 32) * 32;
      const bq = Math.round(b / 32) * 32;
      const key = `${rq},${gq},${bq}`;

      const weight =
        1 +
        Math.min(3, saturation / 70) +
        Math.min(2, max / 170);

      const existing = buckets.get(key) || {
        weight: 0,
        r: 0,
        g: 0,
        b: 0
      };

      existing.weight += weight;
      existing.r += r * weight;
      existing.g += g * weight;
      existing.b += b * weight;

      buckets.set(key, existing);
    }

    if (!buckets.size) return null;

    let winner = null;

    for (const bucket of buckets.values()) {
      if (!winner || bucket.weight > winner.weight) {
        winner = bucket;
      }
    }

    if (!winner || !winner.weight) return null;

    return {
      r: Math.max(0, Math.min(255, Math.round(winner.r / winner.weight))),
      g: Math.max(0, Math.min(255, Math.round(winner.g / winner.weight))),
      b: Math.max(0, Math.min(255, Math.round(winner.b / winner.weight)))
    };
  }

  async function updatePalette(src) {
    const source = String(src || '');
    if (!source || source === lastColorSource) return;
    lastColorSource = source;

    try {
      const color = await extractDominantColor(source);
      if (color) setAccent(color.r, color.g, color.b);
      else setAccent(154, 163, 173);
    } catch (_) {
      // CORS o imagen inaccesible: color neutro de respaldo.
      setAccent(154, 163, 173);
    }
  }

  function syncMetadata() {
    if (typeof songList !== 'undefined' && Array.isArray(songList)) {
      const song = songList[currentIndex];
      if (song) {
        if (trackTitle) trackTitle.textContent = song.title || 'Sin canción cargada';
        if (trackArtist) trackArtist.textContent = song.artist || '—';
        if (art && song.cover && art.src !== song.cover) art.src = song.cover;
        updatePalette(song.cover || (cover && cover.src) || '');
        return;
      }
    }

    if (title && trackTitle) trackTitle.textContent = title.textContent || 'Sin canción cargada';
    if (artist && trackArtist) trackArtist.textContent = artist.textContent || '—';
    if (cover && art && cover.src) {
      art.src = cover.src;
      updatePalette(cover.src);
    }
  }

  // Permite que loadSong sincronice este panel incluso si la portada no cambia.
  window.__glasstrackMobile3DSync = syncMetadata;

  function updatePlayIcon() {
    if (!playIcon || typeof activeAudio === 'undefined') return;
    playIcon.textContent = activeAudio && !activeAudio.paused ? 'Ⅱ' : '▶';
  }

  function syncProgress() {
    if (typeof activeAudio === 'undefined' || !activeAudio) return;
    const duration = Number(activeAudio.duration);
    const current = Number(activeAudio.currentTime);

    if (Number.isFinite(duration) && duration > 0 && !isSeeking) {
      progress.max = String(duration);
      progress.value = String(Math.min(duration, Math.max(0, current || 0)));
      durationEl.textContent = format3DTime(duration);
    } else if (!Number.isFinite(duration) || duration <= 0) {
      progress.max = '100';
      progress.value = '0';
      durationEl.textContent = '0:00';
    }

    currentTimeEl.textContent = format3DTime(current);
    updatePlayIcon();
  }

  function togglePlayback() {
    if (playBtn) {
      playBtn.click();
    }
  }

  function seekFromProgress() {
    if (typeof activeAudio === 'undefined' || !activeAudio) return;
    const duration = Number(activeAudio.duration);
    if (!Number.isFinite(duration) || duration <= 0) return;
    activeAudio.currentTime = Math.min(duration, Math.max(0, Number(progress.value) || 0));
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return { width, height, dpr };
  }

  function drawVisualizer() {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height } = resizeCanvas();
    ctx.clearRect(0, 0, width, height);

    let data = null;
    if (typeof concludorAnalyser !== 'undefined' && concludorAnalyser) {
      data = new Uint8Array(concludorAnalyser.frequencyBinCount);
      concludorAnalyser.getByteFrequencyData(data);
    }

    const bars = 30;
    const gap = Math.max(1, width / (bars * 8));
    const barWidth = (width - gap * (bars - 1)) / bars;
    const rgb = getComputedStyle(document.documentElement).getPropertyValue('--m3d-accent-rgb').trim() || '154, 163, 173';

    for (let i = 0; i < bars; i++) {
      let value = 0.06;
      if (data && data.length) {
        const index = Math.min(data.length - 1, Math.floor((i / bars) * data.length));
        value = Math.max(0.06, data[index] / 255);
      }

      const barHeight = Math.max(4, value * height * 0.88);
      const x = i * (barWidth + gap);
      const y = height - barHeight;

      ctx.fillStyle = `rgba(${rgb}, 0.92)`;
      ctx.shadowColor = `rgba(${rgb}, 0.85)`;
      ctx.shadowBlur = 10;
      ctx.fillRect(x, y, barWidth, barHeight);
    }

    ctx.shadowBlur = 0;
    visualizerFrame = requestAnimationFrame(drawVisualizer);
  }

  function resetParallax() {
    if (coverSide) coverSide.style.transform = 'translate3d(0, 0, 0)';
  }

  function handleParallax(event) {
    const settings = getVisualSettings();
    if (!settings.parallax || !coverSide || !root.classList.contains('is-open')) return;
    const x = Number(event.clientX);
    const y = Number(event.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const rect = coverSide.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const nx = Math.max(-1, Math.min(1, (x - (rect.left + rect.width / 2)) / (rect.width / 2)));
    const ny = Math.max(-1, Math.min(1, (y - (rect.top + rect.height / 2)) / (rect.height / 2)));
    coverSide.style.transform = `translate3d(${(nx * 5.5).toFixed(2)}px, ${(ny * 5.5).toFixed(2)}px, 0)`;
  }

  function open() {
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('mobile-3d-open');
    syncMetadata();
    syncProgress();
    cancelAnimationFrame(visualizerFrame);
    drawVisualizer();
  }

  function close() {
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('mobile-3d-open');
    cancelAnimationFrame(visualizerFrame);
  }

  closeBtn?.addEventListener('click', close);
  playButton?.addEventListener('click', togglePlayback);

  progress?.addEventListener('pointerdown', () => { isSeeking = true; });
  progress?.addEventListener('pointerup', () => { isSeeking = false; seekFromProgress(); });
  progress?.addEventListener('change', () => { isSeeking = false; seekFromProgress(); });
  progress?.addEventListener('input', () => {
    const duration = Number(activeAudio?.duration);
    currentTimeEl.textContent = format3DTime(
      Number.isFinite(duration) && duration > 0 ? Number(progress.value) : 0
    );
  });

  window.addEventListener('resize', () => {
    if (overlay.classList.contains('active')) resizeCanvas();
  });

  [audio1, audio2].forEach(audio => {
    if (!audio) return;
    audio.addEventListener('timeupdate', syncProgress);
    audio.addEventListener('loadedmetadata', syncProgress);
    audio.addEventListener('play', syncProgress);
    audio.addEventListener('pause', syncProgress);
    audio.addEventListener('durationchange', syncProgress);
  });

  if (cover) {
    cover.addEventListener('load', () => {
      if (!cover.src) return;
      if (art) art.src = cover.src;
      updatePalette(cover.src);
    });
  }

  // Cierre del Modo Perspectiva Mobile 3D con Escape.
  // El antiguo atajo H fue eliminado por completo.
  document.addEventListener('keydown', event => {
    if (event.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
    if (event.code === 'Escape' && overlay.classList.contains('active')) {
      event.preventDefault();
      close();
    }
  });

  syncMetadata();
  syncProgress();
  setAccentFromHex('#9aa3ad');
})();


/* =========================================================
   GLASSTRACK PRO — MODO MINIJUEGO DE RITMO / CHART STUDIO
   - Gameplay por carriles
   - Editor/grabador en tiempo real
   - Mapeo 2K / 4K / Custom
   - Charts persistentes en IndexedDB
   - Atajo global X / guardado L
   ========================================================= */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const rhythmOverlay = $('rhythm-overlay');
  if (!rhythmOverlay) return;

  const rhythmTabGame = $('rhythm-tab-game');
  const rhythmTabStudy = $('rhythm-tab-study');
  const rhythmGameView = $('rhythm-game-view');
  const rhythmStudyView = $('rhythm-study-view');
  const rhythmClose = $('rhythm-close');
  const toggleRhythm = $('toggle-rhythm-mode');
  const toggleRhythmDetail = $('toggle-rhythm-mode-detail');
  const btnOpenRhythmGame = $('btn-open-rhythm-game');
  const btnOpenRhythmStudy = $('btn-open-rhythm-study');

  const songCover = $('rhythm-song-cover');
  const songTitle = $('rhythm-song-title');
  const songArtist = $('rhythm-song-artist');
  const songStatus = $('rhythm-song-status');

  const gameHighway = $('rhythm-highway');
  const gameLanes = $('rhythm-lanes');
  const gameKeyRow = $('rhythm-key-row');
  const gameJudgement = $('rhythm-judgement');
  const gameScoreEl = $('rhythm-score');
  const gameComboEl = $('rhythm-combo');
  const gameAccuracyEl = $('rhythm-accuracy');
  const gameFeedback = $('rhythm-feedback');
  const gameProgressFill = $('rhythm-progress-fill');
  const gameTimeReadout = $('rhythm-time-readout');
  const gameChartName = $('rhythm-chart-name');
  const gameChartCount = $('rhythm-chart-count');
  const gameEnergyFill = $('rhythm-energy-fill');
  const gameEnergyText = $('rhythm-energy-text');
  const gameRestart = $('rhythm-game-restart');
  const gameStudy = $('rhythm-game-study');

  const editorCover = $('rhythm-editor-cover');
  const editorTitle = $('rhythm-editor-title');
  const editorArtist = $('rhythm-editor-artist');
  const editorTime = $('rhythm-editor-time');
  const editorPlay = $('rhythm-editor-play');
  const editorBack = $('rhythm-editor-back');
  const editorForward = $('rhythm-editor-forward');
  const editorStage = $('rhythm-editor-stage');
  const editorGrid = $('rhythm-editor-grid');
  const editorCursor = $('rhythm-editor-cursor');
  const editorReadheadLabel = $('rhythm-editor-readhead-label');
  const rhythmSave = $('rhythm-save-chart');
  const rhythmExport = $('rhythm-export-chart');
  const rhythmImport = $('rhythm-import-chart');
  const rhythmImportInput = $('rhythm-import-input');
  const rhythmClear = $('rhythm-clear-chart');
  const rhythmKeyModeLabel = $('rhythm-key-mode-label');
  const rhythmKeyConfig = $('rhythm-key-config');
  const rhythmApplyMapping = $('rhythm-apply-mapping');
  const rhythmNoteList = $('rhythm-note-list');
  const rhythmNotesCount = $('rhythm-notes-count');

  const rhythmSettingsOpen = $('rhythm-settings-open');
  const rhythmSettingsModal = $('rhythm-settings-modal');
  const rhythmSettingsClose = $('rhythm-settings-close');
  const rhythmSettingsApply = $('rhythm-settings-apply');
  const rhythmSettingsReset = $('rhythm-settings-reset');
  const rhythmSettingsKeyConfig = $('rhythm-settings-key-config');
  const rhythmSettingsApplyMapping = $('rhythm-settings-apply-mapping');
  const rhythmScrollSpeedInput = $('rhythm-scroll-speed');
  const rhythmScrollSpeedValue = $('rhythm-scroll-speed-value');
  const rhythmOffsetInput = $('rhythm-offset');
  const rhythmOffsetValue = $('rhythm-offset-value');
  const rhythmMusicVolumeInput = $('rhythm-music-volume');
  const rhythmMusicVolumeValue = $('rhythm-music-volume-value');
  const rhythmSfxVolumeInput = $('rhythm-sfx-volume');
  const rhythmSfxVolumeValue = $('rhythm-sfx-volume-value');
  const rhythmAccentColorInput = $('rhythm-accent-color');

  const RYTHM_SETTING_KEY = 'glasstrack_rhythm_enabled';
  // Tanda 2: Modo Ritmo queda cerrado temporalmente hasta terminar sus correcciones.
  const RHYTHM_BETA_LOCKED = true;
  const RYTHM_GAME_SETTINGS_KEY = 'glasstrack_rhythm_game_settings';
  const RYTHM_MAPPING_KEY = 'glasstrack_rhythm_mapping';
  const RYTHM_TAB_KEY = 'glasstrack_rhythm_last_tab';
  const RYTHM_CHART_VERSION = 1;
  const JUDGEMENT_WINDOWS = [
    { name: 'Sick', max: 45, points: 350, accuracy: 1 },
    { name: 'Perfect', max: 70, points: 300, accuracy: 0.98 },
    { name: 'Good', max: 105, points: 180, accuracy: 0.80 },
    { name: 'Bad', max: 150, points: 60, accuracy: 0.45 }
  ];
  const MISS_WINDOW = 190;
  const SPAWN_WINDOW = 1800;

  const DEFAULT_MAPPINGS = {
    '2k': ['KeyD', 'KeyK'],
    '4k': ['KeyS', 'KeyD', 'KeyK', 'KeyL']
  };
  const DEFAULT_RHYTHM_GAME_SETTINGS = {
    scrollSpeed: 1,
    offsetMs: 0,
    musicVolume: 1,
    sfxVolume: 0.65,
    layout: 'window',
    accentColor: '#9aa3ad'
  };

  let rhythmGameSettings = { ...DEFAULT_RHYTHM_GAME_SETTINGS };
  try {
    const savedSettings = JSON.parse(localStorage.getItem(RYTHM_GAME_SETTINGS_KEY) || 'null');
    if (savedSettings && typeof savedSettings === 'object') {
      rhythmGameSettings = {
        ...DEFAULT_RHYTHM_GAME_SETTINGS,
        ...savedSettings
      };
      rhythmGameSettings.scrollSpeed = Math.max(0.5, Math.min(2.5, Number(rhythmGameSettings.scrollSpeed) || 1));
      rhythmGameSettings.offsetMs = Math.max(-250, Math.min(250, Number(rhythmGameSettings.offsetMs) || 0));
      rhythmGameSettings.musicVolume = Math.max(0, Math.min(1, Number(rhythmGameSettings.musicVolume) ?? 1));
      rhythmGameSettings.sfxVolume = Math.max(0, Math.min(1, Number(rhythmGameSettings.sfxVolume) ?? 0.65));
      rhythmGameSettings.layout = rhythmGameSettings.layout === 'centered' ? 'centered' : 'window';
      if (!/^#[0-9a-f]{6}$/i.test(String(rhythmGameSettings.accentColor || ''))) rhythmGameSettings.accentColor = DEFAULT_RHYTHM_GAME_SETTINGS.accentColor;
    }
  } catch (_) {}

  let rhythmEnabled = true;
  let rhythmOriginalPlaybackRate = null;
  try {
    const raw = localStorage.getItem(RYTHM_SETTING_KEY);
    if (raw === 'false') rhythmEnabled = false;
  } catch (_) {}

  let rhythmMappingMode = '2k';
  let rhythmMapping = [...DEFAULT_MAPPINGS['2k']];
  try {
    const saved = JSON.parse(localStorage.getItem(RYTHM_MAPPING_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      rhythmMappingMode = ['2k', '4k', 'custom'].includes(saved.mode) ? saved.mode : '2k';
      rhythmMapping = Array.isArray(saved.keys) && saved.keys.length >= 2 ? saved.keys.map(String) : [...DEFAULT_MAPPINGS['2k']];
    }
  } catch (_) {}

  let rhythmActiveTab = 'game';
  let chart = [];
  let chartLoadedForSongId = null;
  let chartDirty = false;
  let gameRunning = false;
  let gameRaf = null;
  let gameRoundId = 0;
  let gameNotes = [];
  let gameScore = 0;
  let gameCombo = 0;
  let gameEnergy = 100;
  let gameJudgedCount = 0;
  let gameAccuracyTotal = 0;
  let gameLastSongId = null;
  let editorRaf = null;
  const pressedKeys = new Set();
  const lastRecordedByLane = new Map();
  let editorSpeed = 1;
  let rhythmOriginalVolume = null;

  function hexToRgbString(hex) {
    const value = String(hex || '').replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(value)) return '154, 163, 173';
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `${r}, ${g}, ${b}`;
  }

  function saveRhythmGameSettings() {
    try {
      localStorage.setItem(RYTHM_GAME_SETTINGS_KEY, JSON.stringify(rhythmGameSettings));
    } catch (_) {}
  }

  function applyRhythmGameSettings() {
    const rgb = hexToRgbString(rhythmGameSettings.accentColor);
    rhythmOverlay.style.setProperty('--dominant-rgb', rgb);
    rhythmOverlay.classList.toggle('is-centered', rhythmGameSettings.layout === 'centered');

    if (rhythmScrollSpeedInput) rhythmScrollSpeedInput.value = String(rhythmGameSettings.scrollSpeed);
    if (rhythmScrollSpeedValue) rhythmScrollSpeedValue.textContent = `${rhythmGameSettings.scrollSpeed.toFixed(2)}×`;
    if (rhythmOffsetInput) rhythmOffsetInput.value = String(rhythmGameSettings.offsetMs);
    if (rhythmOffsetValue) rhythmOffsetValue.textContent = `${rhythmGameSettings.offsetMs > 0 ? '+' : ''}${Math.round(rhythmGameSettings.offsetMs)} ms`;
    if (rhythmMusicVolumeInput) rhythmMusicVolumeInput.value = String(rhythmGameSettings.musicVolume);
    if (rhythmMusicVolumeValue) rhythmMusicVolumeValue.textContent = `${Math.round(rhythmGameSettings.musicVolume * 100)}%`;
    if (rhythmSfxVolumeInput) rhythmSfxVolumeInput.value = String(rhythmGameSettings.sfxVolume);
    if (rhythmSfxVolumeValue) rhythmSfxVolumeValue.textContent = `${Math.round(rhythmGameSettings.sfxVolume * 100)}%`;
    if (rhythmAccentColorInput) rhythmAccentColorInput.value = rhythmGameSettings.accentColor;
    document.querySelectorAll('.rhythm-layout-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.rhythmLayout === rhythmGameSettings.layout);
    });

    const audio = getRhythmAudio();
    if (audio && !rhythmOverlay.classList.contains('hidden') && rhythmOriginalVolume !== null) {
      try { audio.volume = rhythmGameSettings.musicVolume; } catch (_) {}
    }
  }

  function resetRhythmGameSettings() {
    rhythmGameSettings = { ...DEFAULT_RHYTHM_GAME_SETTINGS };
    saveRhythmGameSettings();
    applyRhythmGameSettings();
    rhythmNotify('Ajustes de juego restablecidos.');
  }

  function openRhythmSettings() {
    if (!rhythmSettingsModal) return;
    rhythmSettingsModal.classList.remove('hidden');
    rhythmSettingsModal.setAttribute('aria-hidden', 'false');
    renderMappingEditor();
  }

  function closeRhythmSettings() {
    if (!rhythmSettingsModal) return;
    rhythmSettingsModal.classList.add('hidden');
    rhythmSettingsModal.setAttribute('aria-hidden', 'true');
  }

  function syncRhythmSongIfChanged() {
    const song = getRhythmSong();
    const id = song?.id ?? null;
    if (id === lastObservedSongId && chartLoadedForSongId === id) return;
    lastObservedSongId = id;
    setSongMeta();
    loadRhythmChart(id);
    resetGameStats();
    lastRecordedByLane.clear();
    clearPressedKeys();
    gameLastSongId = id;
  }

  function playRhythmSfx(kind) {
    if (rhythmGameSettings.sfxVolume <= 0) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = (typeof audioCtx !== 'undefined' && audioCtx) ? audioCtx : new Ctx();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const now = ctx.currentTime;
      const freq = kind === 'Miss' ? 130 : kind === 'Sick' ? 880 : kind === 'Perfect' ? 720 : kind === 'Good' ? 560 : 380;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(Math.max(100, freq * 0.72), now + 0.07);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, 0.045 * rhythmGameSettings.sfxVolume), now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.085);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.09);
    } catch (_) {}
  }

  function clearPressedKeys() {
    pressedKeys.clear();
    if (gameKeyRow) {
      gameKeyRow.querySelectorAll('.rhythm-key.is-down').forEach(el => el.classList.remove('is-down'));
    }
  }

  function setGameplayKeyVisual(code, isDown) {
    if (!gameKeyRow) return;
    gameKeyRow.querySelectorAll('.rhythm-key').forEach(key => {
      if (key.dataset.code === code) key.classList.toggle('is-down', isDown);
    });
  }

  function getMappingFromContainer(container) {
    if (!container) return null;
    const inputs = Array.from(container.querySelectorAll('.rhythm-key-input'));
    const values = inputs.map(input => String(input.value || '').trim()).filter(Boolean);
    if (!values.length || values.some(value => value === 'Presiona tecla...')) return null;
    if (values.length < 2 || new Set(values).size !== values.length) return null;
    return values;
  }

  function getRhythmAudio() {
    return typeof activeAudio !== 'undefined' && activeAudio ? activeAudio : null;
  }

  function getRhythmSong() {
    try {
      if (Array.isArray(songList) && songList.length && Number.isInteger(currentIndex)) {
        return songList[currentIndex] || null;
      }
    } catch (_) {}
    return null;
  }

  function setRhythmEnabled(enabled) {
    rhythmEnabled = RHYTHM_BETA_LOCKED ? false : !!enabled;
    try { localStorage.setItem(RYTHM_SETTING_KEY, rhythmEnabled ? 'true' : 'false'); } catch (_) {}
    if (toggleRhythm) {
      toggleRhythm.checked = rhythmEnabled;
      if (RHYTHM_BETA_LOCKED) { toggleRhythm.disabled = true; toggleRhythm.setAttribute('aria-disabled', 'true'); }
    }
    if (toggleRhythmDetail) {
      toggleRhythmDetail.checked = rhythmEnabled;
      if (RHYTHM_BETA_LOCKED) { toggleRhythmDetail.disabled = true; toggleRhythmDetail.setAttribute('aria-disabled', 'true'); }
    }
    if (btnOpenRhythmGame && RHYTHM_BETA_LOCKED) { btnOpenRhythmGame.disabled = true; btnOpenRhythmGame.setAttribute('aria-disabled', 'true'); }
    if (btnOpenRhythmStudy && RHYTHM_BETA_LOCKED) { btnOpenRhythmStudy.disabled = true; btnOpenRhythmStudy.setAttribute('aria-disabled', 'true'); }
    if ((!rhythmEnabled || RHYTHM_BETA_LOCKED) && !rhythmOverlay.classList.contains('hidden')) closeRhythm();
  }

  function formatRhythmMs(sec) {
    const n = Number(sec);
    if (!Number.isFinite(n) || n < 0) return '0.000 ms';
    return `${(n * 1000).toFixed(3)} ms`;
  }

  function formatRhythmClock(sec) {
    const n = Math.max(0, Number(sec) || 0);
    const m = Math.floor(n / 60);
    const s = Math.floor(n % 60);
    const ms = Math.floor((n % 1) * 1000);
    return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }

  function rhythmNotify(text) {
    if (typeof showToast === 'function') {
      showToast(text, 'info');
    }
  }

  function getDominantAccentVars() {
    try {
      const styles = getComputedStyle(document.documentElement);
      return styles.getPropertyValue('--dominant-rgb').trim() || '138, 153, 173';
    } catch (_) {
      return '138, 153, 173';
    }
  }

  function setSongMeta() {
    const song = getRhythmSong();
    if (!song) {
      [songCover, editorCover].forEach(img => { if (img) img.removeAttribute('src'); });
      [songTitle, editorTitle].forEach(el => { if (el) el.textContent = 'Sin canción'; });
      [songArtist, editorArtist].forEach(el => { if (el) el.textContent = 'Selecciona una canción para empezar'; });
      if (songStatus) songStatus.textContent = 'SIN CANCIÓN';
      return;
    }
    const coverSrc = song.cover || '';
    [songCover, editorCover].forEach(img => { if (img) { img.src = coverSrc; img.style.opacity = coverSrc ? '1' : '.35'; } });
    if (songTitle) songTitle.textContent = song.title || 'Sin título';
    if (songArtist) songArtist.textContent = song.artist || 'Artista desconocido';
    if (editorTitle) editorTitle.textContent = song.title || 'Sin título';
    if (editorArtist) editorArtist.textContent = song.artist || 'Artista desconocido';
  }

  function getChartRecordFromState(songId) {
    return {
      songId,
      version: RYTHM_CHART_VERSION,
      title: getRhythmSong()?.title || 'Sin título',
      artist: getRhythmSong()?.artist || 'Artista desconocido',
      mappingMode: rhythmMappingMode,
      mapping: [...rhythmMapping],
      notes: chart.map((n, index) => ({
        id: n.id || `n_${index}_${Math.round(n.time * 1000)}`,
        time: Math.max(0, Number(n.time) || 0),
        lane: Math.max(0, Math.min(rhythmMapping.length - 1, Number(n.lane) || 0))
      })).sort((a, b) => a.time - b.time || a.lane - b.lane)
    };
  }

  function ensureChartStore() {
    return !!(typeof db !== 'undefined' && db && db.objectStoreNames.contains('charts'));
  }

  function loadRhythmChart(songId) {
    chart = [];
    chartLoadedForSongId = songId ?? null;
    chartDirty = false;
    if (!songId || !ensureChartStore()) {
      refreshChartUI();
      return;
    }
    try {
      const tx = db.transaction(['charts'], 'readonly');
      const req = tx.objectStore('charts').get(songId);
      req.onsuccess = () => {
        const record = req.result;
        if (record && Array.isArray(record.notes)) {
          if (Array.isArray(record.mapping) && record.mapping.length >= 2) {
            rhythmMapping = record.mapping.map(String);
            rhythmMappingMode = ['2k','4k','custom'].includes(record.mappingMode) ? record.mappingMode : (rhythmMapping.length === 4 ? '4k' : 'custom');
            saveRhythmMapping();
          }
          chart = record.notes.map((n, i) => ({
            id: String(n.id || `n_${i}_${Math.round((Number(n.time) || 0) * 1000)}`),
            time: Math.max(0, Number(n.time) || 0),
            lane: Math.max(0, Math.min(rhythmMapping.length - 1, Number(n.lane) || 0))
          })).sort((a,b) => a.time - b.time || a.lane - b.lane);
        }
        chartLoadedForSongId = songId;
        chartDirty = false;
        refreshChartUI();
        if (rhythmActiveTab === 'game') loadGameChart();
      };
      req.onerror = () => { refreshChartUI(); };
    } catch (error) {
      console.warn('No se pudo leer el chart de Glasstrack:', error);
      refreshChartUI();
    }
  }

  function saveRhythmChart(showMessage = true) {
    const song = getRhythmSong();
    if (!song || song.id == null) {
      rhythmNotify('Selecciona una canción antes de guardar un chart.');
      return false;
    }
    if (!ensureChartStore()) {
      rhythmNotify('La base de datos actual no tiene el almacenamiento de charts disponible. Recarga Glasstrack.');
      return false;
    }
    try {
      const record = getChartRecordFromState(song.id);
      const tx = db.transaction(['charts'], 'readwrite');
      tx.objectStore('charts').put(record);
      tx.oncomplete = () => {
        chartDirty = false;
        chartLoadedForSongId = song.id;
        updateRhythmStatus();
        if (showMessage) rhythmNotify('Chart guardado en IndexedDB para esta canción.');
      };
      tx.onerror = () => rhythmNotify('No se pudo guardar el chart.');
      return true;
    } catch (error) {
      console.error('Error guardando chart:', error);
      rhythmNotify('No se pudo guardar el chart.');
      return false;
    }
  }

  function updateRhythmStatus() {
    if (!songStatus) return;
    if (!getRhythmSong()) {
      songStatus.textContent = 'SIN CANCIÓN';
      return;
    }
    songStatus.textContent = `${chart.length} NOTAS${chartDirty ? ' • EDITANDO' : ' • GUARDADO'}`;
  }

  function saveRhythmMapping() {
    try {
      localStorage.setItem(RYTHM_MAPPING_KEY, JSON.stringify({ mode: rhythmMappingMode, keys: rhythmMapping }));
    } catch (_) {}
  }

  function renderMappingEditorInto(container) {
    if (!container) return;
    container.innerHTML = '';
    rhythmMapping.forEach((code, index) => {
      const row = document.createElement('div');
      row.className = 'rhythm-key-row-editor';
      const label = document.createElement('div');
      label.className = 'rhythm-key-lane-label';
      label.textContent = String(index + 1);
      const input = document.createElement('input');
      input.className = 'rhythm-key-input';
      input.dataset.lane = String(index);
      input.value = code;
      input.placeholder = 'Haz clic y presiona una tecla';
      input.title = 'Haz clic aquí y presiona la tecla que quieres usar en este carril';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.readOnly = true;
      input.setAttribute('aria-label', `Tecla del carril ${index + 1}`);
      input.addEventListener('focus', () => {
        input.classList.add('is-listening');
        input.value = 'Presiona tecla...';
      });
      input.addEventListener('blur', () => {
        input.classList.remove('is-listening');
        if (!input.value || input.value === 'Presiona tecla...') input.value = rhythmMapping[index] || '';
      });
      input.addEventListener('keydown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        if (event.code === 'Escape') {
          input.blur();
          return;
        }
        if (event.code === 'Tab') {
          input.blur();
          return;
        }
        const duplicateLane = Array.from(container.querySelectorAll('.rhythm-key-input'))
          .find(other => other !== input && other.value === event.code);
        if (duplicateLane) {
          rhythmNotify('Esa tecla ya está asignada a otro carril.');
          return;
        }
        input.value = event.code;
        input.classList.remove('is-listening');
        input.blur();
      });
      row.appendChild(label);
      row.appendChild(input);
      container.appendChild(row);
    });
  }

  function renderMappingEditor() {
    if (rhythmKeyModeLabel) rhythmKeyModeLabel.textContent = rhythmMappingMode.toUpperCase();
    renderMappingEditorInto(rhythmKeyConfig);
    renderMappingEditorInto(rhythmSettingsKeyConfig);
  }

  function setMappingPreset(mode) {
    rhythmMappingMode = ['2k', '4k', 'custom'].includes(mode) ? mode : '2k';
    if (rhythmMappingMode === '2k') rhythmMapping = [...DEFAULT_MAPPINGS['2k']];
    else if (rhythmMappingMode === '4k') rhythmMapping = [...DEFAULT_MAPPINGS['4k']];
    else if (!Array.isArray(rhythmMapping) || rhythmMapping.length < 2) rhythmMapping = [...DEFAULT_MAPPINGS['2k']];
    clearPressedKeys();
    lastRecordedByLane.clear();
    document.querySelectorAll('.rhythm-map-preset').forEach(btn => btn.classList.toggle('active', btn.dataset.rhythmMapping === rhythmMappingMode));
    renderMappingEditor();
    saveRhythmMapping();
    refreshChartUI();
  }

  function applyMappingFromContainer(container) {
    const values = getMappingFromContainer(container);
    if (!values) {
      rhythmNotify('Asigna una tecla diferente a cada carril antes de aplicar el mapeo.');
      return false;
    }
    clearPressedKeys();
    rhythmMapping = values;
    rhythmMappingMode = values.length === 2 && JSON.stringify(values) === JSON.stringify(DEFAULT_MAPPINGS['2k'])
      ? '2k'
      : (values.length === 4 && JSON.stringify(values) === JSON.stringify(DEFAULT_MAPPINGS['4k']) ? '4k' : 'custom');
    saveRhythmMapping();
    lastRecordedByLane.clear();
    document.querySelectorAll('.rhythm-map-preset').forEach(btn => btn.classList.toggle('active', btn.dataset.rhythmMapping === rhythmMappingMode));
    chart = chart.map(note => ({ ...note, lane: Math.min(note.lane, rhythmMapping.length - 1) }));
    chartDirty = true;
    renderMappingEditor();
    refreshChartUI();
    loadGameChart();
    rhythmNotify(`Mapeo aplicado: ${rhythmMapping.length}K.`);
    return true;
  }

  function applyCustomMappingFromUI() {
    applyMappingFromContainer(rhythmKeyConfig);
  }

  function refreshChartUI() {
    if (!editorGrid) return;
    const lanes = Math.max(2, rhythmMapping.length);
    editorGrid.style.setProperty('--rhythm-lanes', lanes);
    gameHighway.style.setProperty('--rhythm-lanes', lanes);
    gameLanes.style.setProperty('--rhythm-lanes', lanes);
    gameKeyRow.style.setProperty('--rhythm-lanes', lanes);
    editorGrid.innerHTML = '';
    for (let i = 0; i < lanes; i++) {
      const lane = document.createElement('div');
      lane.className = 'rhythm-editor-lane';
      lane.dataset.lane = String(i);
      lane.addEventListener('dblclick', (e) => {
        const rect = lane.getBoundingClientRect();
        const y = e.clientY - rect.top + editorStage.scrollTop;
        const seconds = editorYToSeconds(y);
        addChartNote(seconds, i);
      });
      editorGrid.appendChild(lane);
    }

    const duration = getRhythmAudio()?.duration;
    const total = Number.isFinite(duration) && duration > 0 ? duration : Math.max(chart.length ? chart[chart.length - 1].time + 2 : 10, 10);
    const rowHeight = 80;
    editorGrid.style.minHeight = `${Math.max(320, total * rowHeight)}px`;

    chart.forEach(note => renderEditorNote(note, total, rowHeight));
    renderNoteList();
    renderGameKeys();
    gameChartName.textContent = getRhythmSong()?.title || 'Sin chart';
    gameChartCount.textContent = `${chart.length} ${chart.length === 1 ? 'nota' : 'notas'}`;
    if (rhythmNotesCount) rhythmNotesCount.textContent = String(chart.length);
    updateRhythmStatus();
  }

  function editorYToSeconds(y) {
    const rowHeight = 80;
    return Math.max(0, y / rowHeight);
  }

  function secondsToEditorY(time) {
    return (Math.max(0, Number(time) || 0)) * 80;
  }

  function renderEditorNote(note, total, rowHeight) {
    const lanes = editorGrid.children;
    const lane = lanes[note.lane] || lanes[0];
    if (!lane) return;
    const el = document.createElement('div');
    el.className = 'rhythm-editor-note';
    el.dataset.noteId = note.id;
    el.style.top = `${secondsToEditorY(note.time)}px`;
    el.title = `${formatRhythmMs(note.time)} • Carril ${note.lane + 1}`;
    el.tabIndex = 0;
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      document.querySelectorAll('.rhythm-editor-note.selected').forEach(n => n.classList.remove('selected'));
      el.classList.add('selected');
      editorSeekTo(note.time);
    });
    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      removeChartNote(note.id);
    });
    const label = document.createElement('span');
    label.className = 'rhythm-editor-note-label';
    label.textContent = `${Math.round(note.time * 1000)}ms`;
    el.appendChild(label);
    lane.appendChild(el);
  }

  function renderGameKeys() {
    if (!gameKeyRow) return;
    gameKeyRow.innerHTML = '';
    rhythmMapping.forEach((code, index) => {
      const key = document.createElement('div');
      key.className = 'rhythm-key';
      key.dataset.lane = String(index);
      key.dataset.code = code;
      key.textContent = humanizeKey(code);
      gameKeyRow.appendChild(key);
    });
  }

  function humanizeKey(code) {
    const map = {
      Numpad0: 'Num 0', Numpad1: 'Num 1', Numpad2: 'Num 2', Numpad3: 'Num 3', Numpad4: 'Num 4', Numpad5: 'Num 5', Numpad6: 'Num 6', Numpad7: 'Num 7', Numpad8: 'Num 8', Numpad9: 'Num 9',
      Space: 'SPACE', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', ShiftLeft: 'SHIFT', ShiftRight: 'SHIFT', ControlLeft: 'CTRL', ControlRight: 'CTRL'
    };
    return map[code] || code.replace(/^Key/, '').replace(/^Digit/, '');
  }

  function renderNoteList() {
    if (!rhythmNoteList) return;
    rhythmNoteList.innerHTML = '';
    if (!chart.length) {
      rhythmNoteList.innerHTML = '<div class="rhythm-empty-notes">Aún no hay notas. Reproduce la canción y usa las teclas mapeadas.</div>';
      return;
    }
    chart.forEach(note => {
      const row = document.createElement('div');
      row.className = 'rhythm-note-row';
      row.dataset.noteId = note.id;
      const time = document.createElement('input');
      time.type = 'number'; time.step = '1'; time.min = '0'; time.value = Math.round(note.time * 1000); time.title = 'Tiempo en milisegundos';
      const lane = document.createElement('input');
      lane.type = 'number'; lane.step = '1'; lane.min = '1'; lane.max = String(rhythmMapping.length); lane.value = note.lane + 1; lane.title = 'Carril';
      const key = document.createElement('div'); key.style.cssText = 'font:700 .52rem/1 Fira Code,monospace;color:rgba(255,255,255,.45);text-align:center;overflow:hidden;text-overflow:ellipsis'; key.textContent = humanizeKey(rhythmMapping[note.lane] || '');
      const del = document.createElement('button'); del.className = 'rhythm-note-delete'; del.type = 'button'; del.title = 'Eliminar nota'; del.textContent = '×';
      time.addEventListener('change', () => { note.time = Math.max(0, Number(time.value) / 1000 || 0); chartDirty = true; normalizeChart(); refreshChartUI(); });
      lane.addEventListener('change', () => { note.lane = Math.max(0, Math.min(rhythmMapping.length - 1, (parseInt(lane.value, 10) || 1) - 1)); chartDirty = true; normalizeChart(); refreshChartUI(); });
      del.addEventListener('click', () => removeChartNote(note.id));
      row.appendChild(time); row.appendChild(lane); row.appendChild(key); row.appendChild(del);
      rhythmNoteList.appendChild(row);
    });
  }

  function normalizeChart() {
    chart = chart
      .map((n, i) => ({ ...n, id: String(n.id || `n_${i}`), time: Math.max(0, Number(n.time) || 0), lane: Math.max(0, Math.min(rhythmMapping.length - 1, Number(n.lane) || 0)) }))
      .sort((a,b) => a.time - b.time || a.lane - b.lane);
  }

  function addChartNote(time, lane, fromRecording = false) {
    const audio = getRhythmAudio();
    const duration = audio?.duration;
    const t = Math.max(0, Number(time) || 0);
    if (Number.isFinite(duration) && duration > 0 && t > duration) return false;
    if (fromRecording) {
      const last = lastRecordedByLane.get(lane);
      if (last != null && (t - last) * 1000 < 80) return false;
      lastRecordedByLane.set(lane, t);
    }
    const exists = chart.some(n => n.lane === lane && Math.abs(n.time - t) < 0.018);
    if (exists) return false;
    chart.push({ id: `n_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, time: t, lane });
    normalizeChart();
    chartDirty = true;
    refreshChartUI();
    return true;
  }

  function removeChartNote(id) {
    chart = chart.filter(n => n.id !== id);
    chartDirty = true;
    refreshChartUI();
    loadGameChart();
  }

  function clearChart() {
    if (!chart.length) return;
    if (!confirm('¿Vaciar todas las notas del chart?')) return;
    chart = [];
    chartDirty = true;
    refreshChartUI();
    loadGameChart();
  }

  function stopEditorClock() {
    if (editorRaf) cancelAnimationFrame(editorRaf);
    editorRaf = null;
  }

  function startEditorClock() {
    stopEditorClock();
    const tick = () => {
      const audio = getRhythmAudio();
      if (rhythmOverlay.classList.contains('hidden') || rhythmActiveTab !== 'study' || !audio || audio.paused || audio.ended) {
        editorRaf = null;
        return;
      }
      updateEditorTime();
      editorRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  function bindAudioToRhythm() {
    const audios = [typeof audio1 !== 'undefined' ? audio1 : null, typeof audio2 !== 'undefined' ? audio2 : null].filter(Boolean);
    audios.forEach(audio => {
      audio.addEventListener('timeupdate', rhythmAudioTick, { passive: true });
      audio.addEventListener('loadedmetadata', () => {
        syncRhythmSongIfChanged();
        refreshChartUI();
        updateEditorTime();
      });
      audio.addEventListener('durationchange', () => {
        refreshChartUI();
        updateEditorTime();
      });
      audio.addEventListener('play', () => {
        syncRhythmSongIfChanged();
        if (rhythmActiveTab === 'game' && !gameRunning) startGameplay();
        else if (gameRunning) updateGameplay();
        updateEditorTime();
        if (rhythmActiveTab === 'study') startEditorClock();
      });
      audio.addEventListener('pause', () => {
        updateEditorTime();
        stopEditorClock();
        if (gameRunning) updateGameplay();
      });
      audio.addEventListener('seeking', () => {
        // Al hacer seek, reconstruimos desde el chart original para que las notas
        // limpiadas por memoria puedan volver a aparecer si se retrocede.
        clearPressedKeys();
        lastRecordedByLane.clear();
        loadGameChart();
        updateEditorTime();
        if (rhythmActiveTab === 'study' && !audio.paused) startEditorClock();
        if (gameRunning) updateGameplay();
      });
      audio.addEventListener('ended', () => {
        if (gameRunning) finishGameplay();
        clearPressedKeys();
        stopEditorClock();
        updateEditorTime();
      });
    });
  }

  function rhythmAudioTick() {
    const audio = getRhythmAudio();
    if (!audio) return;
    syncRhythmSongIfChanged();
    updateEditorTime();
    if (gameRunning) updateGameplay();
  }

  function updateEditorTime() {
    const audio = getRhythmAudio();
    const current = audio?.currentTime || 0;
    const duration = Number.isFinite(audio?.duration) ? audio.duration : 0;
    if (editorTime) editorTime.textContent = `${formatRhythmMs(current)}`;
    if (editorReadheadLabel) editorReadheadLabel.textContent = formatRhythmMs(current);
    if (gameTimeReadout) gameTimeReadout.textContent = `${formatRhythmClock(current)} / ${formatRhythmClock(duration)}`;
    if (gameProgressFill) gameProgressFill.style.width = duration > 0 ? `${Math.max(0, Math.min(100, current / duration * 100))}%` : '0%';
    if (editorCursor && editorStage) {
      const y = secondsToEditorY(current);
      editorCursor.style.top = `${Math.max(0, Math.min(editorStage.scrollHeight - 2, y))}px`;
    }
  }

  function editorSeekTo(seconds) {
    const audio = getRhythmAudio();
    if (!audio || !Number.isFinite(seconds)) return;
    audio.currentTime = Math.max(0, Math.min(Number.isFinite(audio.duration) ? audio.duration : seconds, seconds));
    updateEditorTime();
  }

  function loadGameChart() {
    gameNotes = chart.map(n => ({ ...n, hit: false, missed: false }));
    gameNotes.sort((a,b) => a.time - b.time || a.lane - b.lane);
    renderGameLanes();
  }

  function renderGameLanes() {
    if (!gameLanes) return;
    gameLanes.innerHTML = '';
    rhythmMapping.forEach((_, laneIndex) => {
      const lane = document.createElement('div');
      lane.className = 'rhythm-lane';
      lane.dataset.lane = String(laneIndex);
      gameLanes.appendChild(lane);
    });
    gameHighway.style.setProperty('--rhythm-lanes', rhythmMapping.length);
    renderGameKeys();
  }

  function resetGameStats() {
    gameScore = 0;
    gameCombo = 0;
    gameEnergy = 100;
    gameJudgedCount = 0;
    gameAccuracyTotal = 0;
    updateGameStatsUI();
    if (gameFeedback) gameFeedback.textContent = 'Listo.';
  }

  function updateGameStatsUI() {
    if (gameScoreEl) gameScoreEl.textContent = Math.round(gameScore).toLocaleString('es-PE');
    if (gameComboEl) gameComboEl.textContent = String(gameCombo);
    const acc = gameJudgedCount ? (gameAccuracyTotal / gameJudgedCount * 100) : 100;
    if (gameAccuracyEl) gameAccuracyEl.textContent = `${acc.toFixed(2)}%`;
    if (gameEnergyFill) gameEnergyFill.style.width = `${Math.max(0, Math.min(100, gameEnergy))}%`;
    if (gameEnergyText) gameEnergyText.textContent = `${Math.round(gameEnergy)}%`;
  }

  function startGameplay(restart = false) {
    if (!rhythmEnabled) return;
    const audio = getRhythmAudio();
    if (!audio) return;
    if (restart) {
      try { audio.currentTime = 0; } catch (_) {}
      resetGameStats();
      loadGameChart();
    }
    gameRoundId += 1;
    gameRunning = true;
    gameLastSongId = getRhythmSong()?.id ?? null;
    if (gameRaf) cancelAnimationFrame(gameRaf);
    updateGameplay();
  }

  function finishGameplay() {
    gameRunning = false;
    if (gameRaf) cancelAnimationFrame(gameRaf);
    gameRaf = null;
    if (gameFeedback) gameFeedback.textContent = `Fin del chart • ${gameScore.toLocaleString('es-PE')} pts`;
  }

  function updateGameplay() {
    if (!gameRunning) return;
    const audio = getRhythmAudio();
    if (!audio || !gameLanes || !gameHighway) return;
    const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const round = gameRoundId;
    const lanes = Array.from(gameLanes.children || []);
    lanes.forEach(lane => lane.querySelectorAll('.rhythm-note').forEach(el => el.remove()));

    // La posición de cada nota depende únicamente de audio.currentTime.
    // Scroll Speed modifica cuánto tiempo tarda en recorrer el highway, nunca crea
    // un reloj paralelo, por lo que pausar/seekear el audio recalcula la posición al instante.
    const travelSec = Math.max(0.35, (SPAWN_WINDOW / 1000) / rhythmGameSettings.scrollSpeed);
    const cleanupBefore = current - (MISS_WINDOW / 1000);

    for (let i = 0; i < gameNotes.length; i++) {
      const note = gameNotes[i];
      const delta = note.time - current;
      if (!note.hit && !note.missed && delta < -(MISS_WINDOW / 1000)) {
        note.missed = true;
        gameCombo = 0;
        gameEnergy = Math.max(0, gameEnergy - 4);
        gameJudgedCount += 1;
        showJudgement('Miss', false);
      playRhythmSfx('Miss');
        continue;
      }
      if (note.hit || note.missed || delta > travelSec) continue;
      const lane = lanes[note.lane];
      if (!lane) continue;
      const progress = Math.max(0, Math.min(1, 1 - delta / travelSec));
      const top = 6 + progress * 82;
      const el = document.createElement('div');
      el.className = 'rhythm-note';
      el.style.top = `${top}%`;
      lane.appendChild(el);
    }

    // Elimina del array las notas que ya pasaron el límite inferior de impacto.
    // Esto mantiene gameNotes acotado durante canciones largas.
    if (gameNotes.length > 256) {
      gameNotes = gameNotes.filter(note => note.time >= cleanupBefore || (!note.hit && !note.missed));
    } else {
      gameNotes = gameNotes.filter(note => note.time >= cleanupBefore || (!note.hit && !note.missed));
    }

    if (duration > 0 && gameProgressFill) gameProgressFill.style.width = `${Math.max(0, Math.min(100, current / duration * 100))}%`;
    if (gameLastSongId !== (getRhythmSong()?.id ?? null)) {
      syncRhythmSongIfChanged();
      loadGameChart();
      resetGameStats();
      gameLastSongId = getRhythmSong()?.id ?? null;
    }
    if (audio.paused || audio.ended) {
      if (gameRaf) cancelAnimationFrame(gameRaf);
      gameRaf = null;
      return;
    }
    gameRaf = requestAnimationFrame(() => {
      if (round === gameRoundId) updateGameplay();
    });
  }

  function findBestHittableNote(lane) {
    const audio = getRhythmAudio();
    if (!audio) return null;
    const adjustedNowMs = audio.currentTime * 1000 + rhythmGameSettings.offsetMs;
    let best = null;
    let bestDiff = Infinity;
    for (const note of gameNotes) {
      if (note.hit || note.missed || note.lane !== lane) continue;
      const diff = Math.abs(note.time * 1000 - adjustedNowMs);
      if (diff <= MISS_WINDOW && diff < bestDiff) {
        best = note;
        bestDiff = diff;
      }
    }
    return best ? { note: best, diff: bestDiff } : null;
  }

  function judgeLane(lane) {
    if (!gameRunning) return;
    const found = findBestHittableNote(lane);
    if (!found) return;
    const judgement = JUDGEMENT_WINDOWS.find(item => found.diff <= item.max);
    found.note.hit = true;
    if (!judgement) {
      gameCombo = 0;
      gameEnergy = Math.max(0, gameEnergy - 3);
      gameJudgedCount += 1;
      showJudgement('Bad', false);
      playRhythmSfx('Bad');
    } else {
      gameCombo += 1;
      gameEnergy = Math.min(100, gameEnergy + (judgement.name === 'Sick' ? 1.7 : .8));
      const multiplier = 1 + Math.min(2, gameCombo / 40);
      gameScore += Math.round(judgement.points * multiplier);
      gameJudgedCount += 1;
      gameAccuracyTotal += judgement.accuracy;
      showJudgement(judgement.name, true, found.diff);
      playRhythmSfx(judgement.name);
    }
    updateGameStatsUI();
  }

  let judgementTimer = 0;
  function showJudgement(text, good = true, diff = null) {
    if (!gameJudgement) return;
    if (judgementTimer) clearTimeout(judgementTimer);
    gameJudgement.className = 'rhythm-judgement';
    gameJudgement.textContent = diff == null ? text : `${text}  ${Math.round(diff)}ms`;
    gameJudgement.style.color = good ? `rgb(${getDominantAccentVars()})` : '#ff7777';
    void gameJudgement.offsetWidth;
    gameJudgement.classList.add('show');
    judgementTimer = setTimeout(() => gameJudgement.classList.remove('show'), 420);
    if (gameFeedback) gameFeedback.textContent = diff == null ? text : `${text} • ±${Math.round(diff)} ms`;
  }

  function openRhythm(tab = 'game') {
    if (RHYTHM_BETA_LOCKED) {
      rhythmNotify('Modo Ritmo bloqueado temporalmente mientras se corrige.');
      return;
    }
    if (!rhythmEnabled) {
      rhythmNotify('El Modo Ritmo está desactivado en Ajustes.');
      return;
    }
    const currentAudio = getRhythmAudio();
    if (rhythmOriginalPlaybackRate === null && currentAudio) {
      rhythmOriginalPlaybackRate = Number.isFinite(currentAudio.playbackRate) ? currentAudio.playbackRate : 1;
    }
    if (rhythmOriginalVolume === null && currentAudio) {
      rhythmOriginalVolume = Number.isFinite(currentAudio.volume) ? currentAudio.volume : 1;
    }
    rhythmOverlay.classList.remove('hidden');
    rhythmOverlay.setAttribute('aria-hidden', 'false');
    setRhythmTab(tab, false);
    setSongMeta();
    const song = getRhythmSong();
    if (song?.id !== chartLoadedForSongId) loadRhythmChart(song?.id ?? null);
    else refreshChartUI();
    if (typeof syncMetadata === 'function') { try { syncMetadata(); } catch (_) {} }
    applyRhythmGameSettings();
    const rhythmAudio = getRhythmAudio();
    if (rhythmAudio) { try { rhythmAudio.volume = rhythmGameSettings.musicVolume; } catch (_) {} }
    try { localStorage.setItem(RYTHM_TAB_KEY, tab); } catch (_) {}
    document.body.classList.add('rhythm-open');
    if (tab === 'game') {
      loadGameChart();
      startGameplay(false);
    }
  }

  function closeRhythm() {
    if (gameRunning) finishGameplay();
    const currentAudio = getRhythmAudio();
    if (currentAudio && rhythmOriginalPlaybackRate !== null) {
      try { currentAudio.playbackRate = rhythmOriginalPlaybackRate; } catch (_) {}
    }
    if (currentAudio && rhythmOriginalVolume !== null) {
      try { currentAudio.volume = rhythmOriginalVolume; } catch (_) {}
    }
    rhythmOriginalPlaybackRate = null;
    rhythmOriginalVolume = null;
    stopEditorClock();
    clearPressedKeys();
    closeRhythmSettings();
    rhythmOverlay.classList.add('hidden');
    rhythmOverlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('rhythm-open');
  }

  function setRhythmTab(tab, save = true) {
    rhythmActiveTab = tab === 'study' ? 'study' : 'game';
    const isGame = rhythmActiveTab === 'game';
    rhythmGameView.classList.toggle('active', isGame);
    rhythmStudyView.classList.toggle('active', !isGame);
    rhythmTabGame.classList.toggle('active', isGame);
    rhythmTabStudy.classList.toggle('active', !isGame);
    rhythmTabGame.setAttribute('aria-selected', String(isGame));
    rhythmTabStudy.setAttribute('aria-selected', String(!isGame));
    if (save) { try { localStorage.setItem(RYTHM_TAB_KEY, rhythmActiveTab); } catch (_) {} }
    if (isGame) {
      stopEditorClock();
      if (gameRunning) updateGameplay();
      else loadGameChart();
    } else {
      if (gameRunning) finishGameplay();
      renderMappingEditor();
      refreshChartUI();
      updateEditorTime();
      const audio = getRhythmAudio();
      if (audio && !audio.paused) startEditorClock();
    }
  }

  function openSettingsToRhythm() {
    // Abre el panel de categoría usando el mecanismo de ajustes existente.
    const settingsCard = document.querySelector('.setting-card-item[data-target="sub-rhythm-mode"]');
    if (settingsCard) settingsCard.click();
  }

  // --- UI de ajustes ---
  if (toggleRhythm) {
    toggleRhythm.checked = rhythmEnabled;
    toggleRhythm.addEventListener('change', () => setRhythmEnabled(toggleRhythm.checked));
  }
  if (toggleRhythmDetail) {
    toggleRhythmDetail.checked = rhythmEnabled;
    toggleRhythmDetail.addEventListener('change', () => setRhythmEnabled(toggleRhythmDetail.checked));
  }
  if (btnOpenRhythmGame) btnOpenRhythmGame.addEventListener('click', () => { if (typeof playSFX === 'function') playSFX('click'); openRhythm('game'); });
  if (btnOpenRhythmStudy) btnOpenRhythmStudy.addEventListener('click', () => { if (typeof playSFX === 'function') playSFX('click'); openRhythm('study'); });
  if (rhythmClose) rhythmClose.addEventListener('click', closeRhythm);
  if (rhythmTabGame) rhythmTabGame.addEventListener('click', () => setRhythmTab('game'));
  if (rhythmTabStudy) rhythmTabStudy.addEventListener('click', () => setRhythmTab('study'));
  if (gameStudy) gameStudy.addEventListener('click', () => setRhythmTab('study'));
  if (gameRestart) gameRestart.addEventListener('click', () => {
    const audio = getRhythmAudio();
    if (!audio) return;
    resetGameStats();
    loadGameChart();
    try { audio.currentTime = 0; } catch (_) {}
    audio.play().then(() => startGameplay(true)).catch(() => startGameplay(true));
  });

  document.querySelectorAll('.rhythm-map-preset').forEach(btn => {
    btn.addEventListener('click', () => setMappingPreset(btn.dataset.rhythmMapping || '2k'));
  });
  if (rhythmApplyMapping) rhythmApplyMapping.addEventListener('click', applyCustomMappingFromUI);

  // --- Ajustes avanzados del Modo Ritmo ---
  if (rhythmSettingsOpen) rhythmSettingsOpen.addEventListener('click', () => {
    if (typeof playSFX === 'function') playSFX('click');
    openRhythmSettings();
  });
  if (rhythmSettingsClose) rhythmSettingsClose.addEventListener('click', closeRhythmSettings);
  if (rhythmSettingsModal) rhythmSettingsModal.querySelectorAll('[data-rhythm-settings-close="true"]').forEach(el => el.addEventListener('click', closeRhythmSettings));
  if (rhythmScrollSpeedInput) rhythmScrollSpeedInput.addEventListener('input', () => {
    rhythmGameSettings.scrollSpeed = Math.max(0.5, Math.min(2.5, Number(rhythmScrollSpeedInput.value) || 1));
    saveRhythmGameSettings();
    applyRhythmGameSettings();
  });
  if (rhythmOffsetInput) rhythmOffsetInput.addEventListener('input', () => {
    rhythmGameSettings.offsetMs = Math.max(-250, Math.min(250, Number(rhythmOffsetInput.value) || 0));
    saveRhythmGameSettings();
    applyRhythmGameSettings();
  });
  if (rhythmMusicVolumeInput) rhythmMusicVolumeInput.addEventListener('input', () => {
    rhythmGameSettings.musicVolume = Math.max(0, Math.min(1, Number(rhythmMusicVolumeInput.value) || 0));
    saveRhythmGameSettings();
    applyRhythmGameSettings();
  });
  if (rhythmSfxVolumeInput) rhythmSfxVolumeInput.addEventListener('input', () => {
    rhythmGameSettings.sfxVolume = Math.max(0, Math.min(1, Number(rhythmSfxVolumeInput.value) || 0));
    saveRhythmGameSettings();
    applyRhythmGameSettings();
  });
  if (rhythmAccentColorInput) rhythmAccentColorInput.addEventListener('input', () => {
    rhythmGameSettings.accentColor = rhythmAccentColorInput.value;
    saveRhythmGameSettings();
    applyRhythmGameSettings();
  });
  document.querySelectorAll('.rhythm-layout-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      rhythmGameSettings.layout = btn.dataset.rhythmLayout === 'centered' ? 'centered' : 'window';
      saveRhythmGameSettings();
      applyRhythmGameSettings();
    });
  });
  document.querySelectorAll('.rhythm-settings-map-preset').forEach(btn => {
    btn.addEventListener('click', () => setMappingPreset(btn.dataset.rhythmMapping || '2k'));
  });
  if (rhythmSettingsApplyMapping) rhythmSettingsApplyMapping.addEventListener('click', () => applyMappingFromContainer(rhythmSettingsKeyConfig));
  if (rhythmSettingsReset) rhythmSettingsReset.addEventListener('click', resetRhythmGameSettings);
  if (rhythmSettingsApply) rhythmSettingsApply.addEventListener('click', () => {
    saveRhythmGameSettings();
    applyRhythmGameSettings();
    closeRhythmSettings();
    rhythmNotify('Ajustes del Modo Ritmo guardados.');
  });

  // --- Editor playback ---
  if (editorPlay) editorPlay.addEventListener('click', () => {
    const audio = getRhythmAudio();
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  });
  if (editorBack) editorBack.addEventListener('click', () => editorSeekTo((getRhythmAudio()?.currentTime || 0) - 5));
  if (editorForward) editorForward.addEventListener('click', () => editorSeekTo((getRhythmAudio()?.currentTime || 0) + 5));
  document.querySelectorAll('.rhythm-speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const speed = Number(btn.dataset.rhythmSpeed) || 1;
      editorSpeed = speed;
      document.querySelectorAll('.rhythm-speed-btn').forEach(b => b.classList.toggle('active', b === btn));
      const audio = getRhythmAudio();
      if (audio) {
        audio.playbackRate = speed;
        if (typeof applyLinkedPlaybackRate === 'function') applyLinkedPlaybackRate(audio);
      }
      if (typeof syncPlaybackSpeedIndicators === 'function') syncPlaybackSpeedIndicators();
    });
  });

  // --- Chart persistence / export / import ---
  if (rhythmSave) rhythmSave.addEventListener('click', () => saveRhythmChart(true));
  if (rhythmExport) rhythmExport.addEventListener('click', () => {
    const song = getRhythmSong();
    if (!song) return rhythmNotify('Selecciona una canción antes de exportar.');
    const payload = getChartRecordFromState(song.id);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safe = (song.title || 'glasstrack-chart').replace(/[^a-z0-9\-_]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'glasstrack-chart';
    a.href = url; a.download = `${safe}.json`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    rhythmNotify('Chart exportado en JSON.');
  });
  if (rhythmImport) rhythmImport.addEventListener('click', () => rhythmImportInput?.click());
  if (rhythmImportInput) rhythmImportInput.addEventListener('change', async () => {
    const file = rhythmImportInput.files?.[0];
    rhythmImportInput.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      if (!payload || !Array.isArray(payload.notes)) throw new Error('Formato de chart inválido');
      const importedMapping = Array.isArray(payload.mapping) && payload.mapping.length >= 2 ? payload.mapping.map(String) : null;
      if (importedMapping) {
        rhythmMapping = importedMapping;
        rhythmMappingMode = ['2k','4k','custom'].includes(payload.mappingMode) ? payload.mappingMode : 'custom';
        saveRhythmMapping();
        renderMappingEditor();
      }
      chart = payload.notes.map((n, i) => ({ id: String(n.id || `import_${i}`), time: Math.max(0, Number(n.time) || 0), lane: Math.max(0, Math.min(rhythmMapping.length - 1, Number(n.lane) || 0)) }));
      normalizeChart();
      chartDirty = true;
      refreshChartUI();
      loadGameChart();
      rhythmNotify(`Importadas ${chart.length} notas.`);
    } catch (error) {
      console.error(error);
      rhythmNotify('No se pudo importar el JSON del chart.');
    }
  });
  if (rhythmClear) rhythmClear.addEventListener('click', clearChart);

  // --- Teclado gameplay + grabación ---
  window.addEventListener('keydown', (e) => {
    const tag = String(e.target?.tagName || '').toUpperCase();
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable;

    if (!RHYTHM_BETA_LOCKED && e.code === 'KeyX' && !e.ctrlKey && !e.altKey && !e.metaKey && !typing && !e.repeat) {
      e.preventDefault();
      rhythmOverlay.classList.contains('hidden') ? openRhythm('game') : closeRhythm();
      return;
    }

    if (rhythmOverlay.classList.contains('hidden')) return;

    if (e.code === 'Escape' && !e.repeat) {
      e.preventDefault();
      if (rhythmSettingsModal && !rhythmSettingsModal.classList.contains('hidden')) closeRhythmSettings();
      else closeRhythm();
      return;
    }

    // Las pulsaciones repetidas del sistema operativo nunca generan juicios ni notas.
    if (e.repeat) return;
    if (typing) return;

    if (rhythmActiveTab === 'study') {
      if (e.code === 'KeyL') {
        e.preventDefault();
        saveRhythmChart(true);
        return;
      }
      const lane = rhythmMapping.indexOf(e.code);
      if (lane !== -1) {
        e.preventDefault();
        const audio = getRhythmAudio();
        if (audio && !audio.paused) {
          const t = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
          if (addChartNote(t, lane, true)) {
            rhythmNotify(`Nota grabada: carril ${lane + 1} • ${formatRhythmMs(t)}`);
          }
        }
      }
      return;
    }

    const lane = rhythmMapping.indexOf(e.code);
    if (lane !== -1) {
      e.preventDefault();
      pressedKeys.add(e.code);
      setGameplayKeyVisual(e.code, true);
      judgeLane(lane);
    }
  }, true);

  window.addEventListener('keyup', (e) => {
    if (pressedKeys.has(e.code)) pressedKeys.delete(e.code);
    setGameplayKeyVisual(e.code, false);
  }, true);

  window.addEventListener('blur', clearPressedKeys);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearPressedKeys();
  });

  // --- Atajo global L para el editor sin chocar con inputs ---
  window.addEventListener('beforeunload', () => {
    if (chartDirty && rhythmOverlay && !rhythmOverlay.classList.contains('hidden')) {
      try { saveRhythmChart(false); } catch (_) {}
    }
  });

  // --- Sincronización con cambios de canción (sin temporizadores) ---
  let lastObservedSongId = null;

  // Sincronización inicial.
  setRhythmEnabled(rhythmEnabled);
  setMappingPreset(rhythmMappingMode);
  applyRhythmGameSettings();
  bindAudioToRhythm();
  setSongMeta();
  const startupSong = getRhythmSong();
  lastObservedSongId = startupSong?.id ?? null;
  if (startupSong) loadRhythmChart(startupSong.id);

  // Exponer una API pequeña para otros módulos de Glasstrack.
  window.glasstrackRhythm = {
    open: openRhythm,
    close: closeRhythm,
    setTab: setRhythmTab,
    saveChart: saveRhythmChart,
    loadChart: loadRhythmChart,
    syncSong: syncRhythmSongIfChanged,
    getChart: () => chart.map(n => ({ ...n })),
    enableAndOpen: (tab = 'game') => {
      if (RHYTHM_BETA_LOCKED) {
        rhythmNotify('Modo Ritmo bloqueado temporalmente mientras se corrige.');
        return false;
      }
      if (!rhythmEnabled) setRhythmEnabled(true);
      openRhythm(tab);
      return true;
    }
  };
})();

/* =========================================================
   GLASSTRACK PRO — STAGE MANAGER
   BLOQUE 3: JS
   Pegar al FINAL de script.js

   Módulo completamente independiente.

   IMPORTANTE:
   - NO crea AudioContext.
   - NO crea MediaElementSource.
   - NO reconecta <audio>.
   - Utiliza concludorAnalyser existente del reproductor.
   - Utiliza activeAudio/audio1/audio2 existentes cuando están disponibles.
   ========================================================= */

(function (window, document) {
  'use strict';

  class StageManager {
    constructor() {
      this.name = 'StageManager';
      this.version = '1.0.1';
      this.locked = true;

      this.dbName = 'GlasstrackStageDB';
      this.dbVersion = 1;
      this.storeName = 'stageState';
      this.stateKey = 'main';

      this.db = null;
      this.dbReady = false;

      this.rafId = null;
      this.resizeTimer = null;
      this.destroyed = false;

      this.backgroundObjectUrl = null;
      this.characterObjectUrl = null;

      this.dragState = {
        active: false,
        pointerId: null,
        startClientX: 0,
        startClientY: 0,
        startX: 50,
        startY: 70
      };

      this.resizeState = {
        active: false,
        pointerId: null,
        startClientX: 0,
        startClientY: 0,
        startScale: 100
      };

      this.audioData = null;
      this.frequencyData = null;
      this.lastBass = 0;
      this.lastMid = 0;
      this.lastEnergy = 0;
      this.smoothedBass = 0;
      this.smoothedMid = 0;
      this.smoothedEnergy = 0;
      this.lastBeat = 0;
      this.beatPulse = 0;

      this.particles = [];

      this.lyrics = [];
      this.activeLyricIndex = -1;
      this.lyricElements = [];

      this.defaults = {
        enabled: false,

        layers: {
          background: true,
          effects: true,
          character: true,
          lyrics: true,
          hud: true
        },

        background: {
          type: '',
          source: '',
          blob: null
        },

        character: {
          source: '',
          blob: null,
          x: 50,
          y: 70,
          scale: 100,
          rotation: 0,
          bounce: true
        },

        effects: {
          type: 'particles',
          particleCount: 90,
          sensitivity: 1,
          intensity: 1,
          speed: 1
        },

        reaction: {
          bass: 1,
          mid: 1,
          brightness: 0.7
        },

        lyrics: {
          mode: 'simple',
          text: ''
        }
      };

      this.state = this.cloneDefaults();

      this.dom = {};
      this.ctx = null;

      this.bound = {
        render: this.render.bind(this),
        resize: this.resizeCanvas.bind(this),
        dragMove: this.onDragMove.bind(this),
        dragEnd: this.onDragEnd.bind(this),
        resizeMove: this.onResizeMove.bind(this),
        resizeEnd: this.onResizeEnd.bind(this)
      };
    }

    /* -----------------------------------------------------
       UTILIDADES
       ----------------------------------------------------- */

    cloneDefaults() {
      return {
        enabled: this.defaults.enabled,

        layers: {
          ...this.defaults.layers
        },

        background: {
          ...this.defaults.background
        },

        character: {
          ...this.defaults.character
        },

        effects: {
          ...this.defaults.effects
        },

        reaction: {
          ...this.defaults.reaction
        },

        lyrics: {
          ...this.defaults.lyrics
        }
      };
    }

    clamp(value, min, max) {
      const n = Number(value);

      if (!Number.isFinite(n)) {
        return min;
      }

      return Math.min(max, Math.max(min, n));
    }

    safeNumber(value, fallback) {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    }

    lerp(current, target, amount) {
      return current + (target - current) * amount;
    }

    getActiveAudio() {
      try {
        if (
          typeof activeAudio !== 'undefined' &&
          activeAudio &&
          typeof activeAudio.currentTime === 'number'
        ) {
          return activeAudio;
        }
      } catch (_) {}

      try {
        if (
          typeof audio1 !== 'undefined' &&
          audio1 &&
          typeof audio1.currentTime === 'number'
        ) {
          return audio1;
        }
      } catch (_) {}

      try {
        if (
          typeof audio2 !== 'undefined' &&
          audio2 &&
          typeof audio2.currentTime === 'number'
        ) {
          return audio2;
        }
      } catch (_) {}

      return null;
    }

    /*
     * Obtiene el AnalalyserNode YA EXISTENTE del reproductor.
     *
     * No se crea AudioContext.
     * No se crea MediaElementSource.
     * No se conecta nuevamente ningún <audio>.
     */
    getExistingAnalyser() {
      try {
        if (
          typeof concludorAnalyser !== 'undefined' &&
          concludorAnalyser &&
          typeof concludorAnalyser.getByteFrequencyData === 'function'
        ) {
          return concludorAnalyser;
        }
      } catch (_) {}

      return null;
    }

    /* -----------------------------------------------------
       INICIALIZACIÓN
       ----------------------------------------------------- */

    async init() {
      if (this.destroyed) {
        return this;
      }

      this.cacheDom();
      this.bindEvents();

      this.frequencyData = null;

      await this.openDatabase();
      await this.loadState();

      this.applyStateToUI();
      this.applyLayerVisibility();
      this.applyBackground();
      this.applyCharacter();
      this.applyLyrics();

      this.resizeCanvas();

      if (this.locked) {
        this.state.enabled = false;
        if (this.dom.toggleMaster) {
          this.dom.toggleMaster.checked = false;
        }
      }

      return this;
    }

    cacheDom() {
      this.dom.root = document.getElementById('stage-manager');

      this.dom.backgroundLayer =
        document.getElementById('stage-background-layer');

      this.dom.backgroundVideo =
        document.getElementById('stage-background-video');

      this.dom.backgroundImage =
        document.getElementById('stage-background-image');

      this.dom.backgroundOverlay =
        document.getElementById('stage-background-overlay');

      this.dom.effectsLayer =
        document.getElementById('stage-effects-layer');

      this.dom.canvas =
        document.getElementById('stage-effects-canvas');

      this.dom.glow =
        document.getElementById('stage-stage-glow');

      this.dom.pulseRing =
        document.getElementById('stage-pulse-ring');

      this.dom.characterLayer =
        document.getElementById('stage-character-layer');

      this.dom.character =
        document.getElementById('stage-character');

      this.dom.characterImage =
        document.getElementById('stage-character-image');

      this.dom.characterGlow =
        document.querySelector('.stage-character-glow');

      this.dom.characterResize =
        document.getElementById('stage-character-resize');

      this.dom.lyricsLayer =
        document.getElementById('stage-lyrics-layer');

      this.dom.lyricsPanel =
        document.getElementById('stage-lyrics-panel');

      this.dom.lyricsContainer =
        document.getElementById('stage-lyrics-word-container');

      this.dom.hudLayer =
        document.getElementById('stage-hud');

      this.dom.settings =
        document.getElementById('stage-settings');

      this.dom.close =
        document.getElementById('stage-close-button');

      this.dom.openSettings =
        document.getElementById('stage-open-settings');

      this.dom.settingsClose =
        document.getElementById('stage-settings-close');

      this.dom.toggleMaster =
        document.getElementById('stage-toggle-master');

      this.dom.toggleBackground =
        document.getElementById('stage-toggle-background');

      this.dom.toggleEffects =
        document.getElementById('stage-toggle-effects');

      this.dom.toggleCharacter =
        document.getElementById('stage-toggle-character');

      this.dom.toggleLyrics =
        document.getElementById('stage-toggle-lyrics');

      this.dom.toggleHud =
        document.getElementById('stage-toggle-hud');

      this.dom.backgroundFile =
        document.getElementById('stage-background-file');

      this.dom.backgroundUrl =
        document.getElementById('stage-background-url');

      this.dom.backgroundClear =
        document.getElementById('stage-background-clear');

      this.dom.characterFile =
        document.getElementById('stage-character-file');

      this.dom.characterUrl =
        document.getElementById('stage-character-url');

      this.dom.characterX =
        document.getElementById('stage-character-x');

      this.dom.characterY =
        document.getElementById('stage-character-y');

      this.dom.characterScale =
        document.getElementById('stage-character-scale');

      this.dom.characterRotation =
        document.getElementById('stage-character-rotation');

      this.dom.toggleBounce =
        document.getElementById('stage-toggle-bounce');

      this.dom.characterReset =
        document.getElementById('stage-character-reset');

      this.dom.effectType =
        document.getElementById('stage-effect-type');

      this.dom.particleCount =
        document.getElementById('stage-particle-count');

      this.dom.particleCountValue =
        document.getElementById('stage-particle-count-value');

      this.dom.sensitivity =
        document.getElementById('stage-sensitivity');

      this.dom.sensitivityValue =
        document.getElementById('stage-sensitivity-value');

      this.dom.intensity =
        document.getElementById('stage-intensity');

      this.dom.intensityValue =
        document.getElementById('stage-intensity-value');

      this.dom.speed =
        document.getElementById('stage-speed');

      this.dom.speedValue =
        document.getElementById('stage-speed-value');

      this.dom.bassReact =
        document.getElementById('stage-bass-react');

      this.dom.bassReactValue =
        document.getElementById('stage-bass-react-value');

      this.dom.midReact =
        document.getElementById('stage-mid-react');

      this.dom.midReactValue =
        document.getElementById('stage-mid-react-value');

      this.dom.brightness =
        document.getElementById('stage-brightness');

      this.dom.brightnessValue =
        document.getElementById('stage-brightness-value');

      this.dom.lyricsMode =
        document.getElementById('stage-lyrics-mode');

      this.dom.lyricsInput =
        document.getElementById('stage-lyrics-input');

      this.dom.lyricsApply =
        document.getElementById('stage-lyrics-apply');

      this.dom.saveNow =
        document.getElementById('stage-save-now');

      this.dom.resetAll =
        document.getElementById('stage-reset-all');
    }

    bindEvents() {
      if (!this.dom.root) {
        return;
      }

      if (this.dom.close) {
        this.dom.close.addEventListener(
          'click',
          () => this.hide()
        );
      }

      if (this.dom.openSettings) {
        this.dom.openSettings.addEventListener(
          'click',
          () => this.toggleSettings()
        );
      }

      if (this.dom.settingsClose) {
        this.dom.settingsClose.addEventListener(
          'click',
          () => this.closeSettings()
        );
      }

      if (this.dom.toggleMaster) {
        this.dom.toggleMaster.addEventListener(
          'change',
          () => {
            if (this.locked) {
              this.state.enabled = false;
              this.dom.toggleMaster.checked = false;
              this.hide();
              return;
            }

            this.state.enabled =
              this.dom.toggleMaster.checked;

            if (this.state.enabled) {
              this.show();
            } else {
              this.hide();
            }

            this.saveState();
          }
        );
      }

      this.bindLayerSwitch(
        this.dom.toggleBackground,
        'background'
      );

      this.bindLayerSwitch(
        this.dom.toggleEffects,
        'effects'
      );

      this.bindLayerSwitch(
        this.dom.toggleCharacter,
        'character'
      );

      this.bindLayerSwitch(
        this.dom.toggleLyrics,
        'lyrics'
      );

      this.bindLayerSwitch(
        this.dom.toggleHud,
        'hud'
      );

      if (this.dom.backgroundFile) {
        this.dom.backgroundFile.addEventListener(
          'change',
          event => {
            const file = event.target.files &&
              event.target.files[0];

            if (file) {
              this.setBackgroundFile(file);
            }
          }
        );
      }

      if (this.dom.backgroundUrl) {
        this.dom.backgroundUrl.addEventListener(
          'change',
          () => {
            this.setBackgroundUrl(
              this.dom.backgroundUrl.value.trim()
            );
          }
        );
      }

      if (this.dom.backgroundClear) {
        this.dom.backgroundClear.addEventListener(
          'click',
          () => this.clearBackground()
        );
      }

      if (this.dom.characterFile) {
        this.dom.characterFile.addEventListener(
          'change',
          event => {
            const file = event.target.files &&
              event.target.files[0];

            if (file) {
              this.setCharacterFile(file);
            }
          }
        );
      }

      if (this.dom.characterUrl) {
        this.dom.characterUrl.addEventListener(
          'change',
          () => {
            this.setCharacterUrl(
              this.dom.characterUrl.value.trim()
            );
          }
        );
      }

      this.bindNumericControl(
        this.dom.characterX,
        value => {
          this.state.character.x =
            this.clamp(value, 0, 100);

          this.applyCharacterTransform();
          this.saveState();
        }
      );

      this.bindNumericControl(
        this.dom.characterY,
        value => {
          this.state.character.y =
            this.clamp(value, 0, 100);

          this.applyCharacterTransform();
          this.saveState();
        }
      );

      this.bindNumericControl(
        this.dom.characterScale,
        value => {
          this.state.character.scale =
            this.clamp(value, 5, 300);

          this.applyCharacterTransform();
          this.saveState();
        }
      );

      this.bindNumericControl(
        this.dom.characterRotation,
        value => {
          this.state.character.rotation =
            this.clamp(value, -180, 180);

          this.applyCharacterTransform();
          this.saveState();
        }
      );

      if (this.dom.toggleBounce) {
        this.dom.toggleBounce.addEventListener(
          'change',
          () => {
            this.state.character.bounce =
              this.dom.toggleBounce.checked;

            this.saveState();
          }
        );
      }

      if (this.dom.characterReset) {
        this.dom.characterReset.addEventListener(
          'click',
          () => this.resetCharacter()
        );
      }

      this.bindRangeControl(
        this.dom.particleCount,
        this.dom.particleCountValue,
        value => {
          this.state.effects.particleCount =
            this.clamp(value, 10, 250);

          this.rebuildParticles();
          this.saveState();
        },
        value => String(Math.round(value))
      );

      this.bindRangeControl(
        this.dom.sensitivity,
        this.dom.sensitivityValue,
        value => {
          this.state.effects.sensitivity =
            this.clamp(value, 0.1, 3);

          this.saveState();
        },
        value => Number(value).toFixed(2)
      );

      this.bindRangeControl(
        this.dom.intensity,
        this.dom.intensityValue,
        value => {
          this.state.effects.intensity =
            this.clamp(value, 0, 2);

          this.saveState();
        },
        value => Number(value).toFixed(2)
      );

      this.bindRangeControl(
        this.dom.speed,
        this.dom.speedValue,
        value => {
          this.state.effects.speed =
            this.clamp(value, 0.1, 3);

          this.saveState();
        },
        value => Number(value).toFixed(2)
      );

      this.bindRangeControl(
        this.dom.bassReact,
        this.dom.bassReactValue,
        value => {
          this.state.reaction.bass =
            this.clamp(value, 0, 2);

          this.saveState();
        },
        value => Number(value).toFixed(2)
      );

      this.bindRangeControl(
        this.dom.midReact,
        this.dom.midReactValue,
        value => {
          this.state.reaction.mid =
            this.clamp(value, 0, 2);

          this.saveState();
        },
        value => Number(value).toFixed(2)
      );

      this.bindRangeControl(
        this.dom.brightness,
        this.dom.brightnessValue,
        value => {
          this.state.reaction.brightness =
            this.clamp(value, 0.2, 1.5);

          this.saveState();
        },
        value => Number(value).toFixed(2)
      );

      if (this.dom.effectType) {
        this.dom.effectType.addEventListener(
          'change',
          () => {
            this.state.effects.type =
              this.dom.effectType.value;

            this.rebuildParticles();
            this.saveState();
          }
        );
      }

      if (this.dom.lyricsMode) {
        this.dom.lyricsMode.addEventListener(
          'change',
          () => {
            this.state.lyrics.mode =
              this.dom.lyricsMode.value;

            this.applyLyricsMode();
            this.saveState();
          }
        );
      }

      if (this.dom.lyricsApply) {
        this.dom.lyricsApply.addEventListener(
          'click',
          () => {
            this.state.lyrics.text =
              this.dom.lyricsInput
                ? this.dom.lyricsInput.value
                : '';

            this.parseLyrics();
            this.applyLyrics();
            this.saveState();
          }
        );
      }

      if (this.dom.saveNow) {
        this.dom.saveNow.addEventListener(
          'click',
          () => this.saveState()
        );
      }

      if (this.dom.resetAll) {
        this.dom.resetAll.addEventListener(
          'click',
          () => this.resetAll()
        );
      }

      this.bindCharacterPointerEvents();

      window.addEventListener(
        'resize',
        this.bound.resize,
        { passive: true }
      );
    }

    bindLayerSwitch(input, layerName) {
      if (!input) {
        return;
      }

      input.addEventListener(
        'change',
        () => {
          this.state.layers[layerName] =
            input.checked;

          this.applyLayerVisibility();
          this.saveState();
        }
      );
    }

    bindNumericControl(input, callback) {
      if (!input) {
        return;
      }

      const update = () => {
        callback(
          this.safeNumber(
            input.value,
            Number(input.defaultValue || 0)
          )
        );
      };

      input.addEventListener('input', update);
      input.addEventListener('change', update);
    }

    bindRangeControl(
      input,
      output,
      callback,
      formatter
    ) {
      if (!input) {
        return;
      }

      const update = () => {
        const value =
          this.safeNumber(input.value, 0);

        if (output) {
          output.textContent =
            formatter(value);
        }

        callback(value);
      };

      input.addEventListener('input', update);
      input.addEventListener('change', update);
    }

    /* -----------------------------------------------------
       INDEXEDDB
       ----------------------------------------------------- */

    openDatabase() {
      return new Promise(resolve => {
        if (!window.indexedDB) {
          this.dbReady = false;
          resolve(false);
          return;
        }

        let request;

        try {
          request = window.indexedDB.open(
            this.dbName,
            this.dbVersion
          );
        } catch (_) {
          this.dbReady = false;
          resolve(false);
          return;
        }

        request.onupgradeneeded = event => {
          const database = event.target.result;

          if (!database.objectStoreNames.contains(
            this.storeName
          )) {
            database.createObjectStore(
              this.storeName,
              { keyPath: 'id' }
            );
          }
        };

        request.onsuccess = event => {
          this.db = event.target.result;
          this.dbReady = true;
          resolve(true);
        };

        request.onerror = () => {
          this.dbReady = false;
          resolve(false);
        };

        request.onblocked = () => {
          this.dbReady = false;
          resolve(false);
        };
      });
    }

    async saveState() {
      const serializableState = {
        id: this.stateKey,

        enabled: Boolean(this.state.enabled),

        layers: {
          ...this.state.layers
        },

        background: {
          type: this.state.background.type,
          source: this.state.background.source,
          blob: this.state.background.blob || null
        },

        character: {
          source: this.state.character.source,
          blob: this.state.character.blob || null,
          x: this.clamp(
            this.state.character.x,
            0,
            100
          ),
          y: this.clamp(
            this.state.character.y,
            0,
            100
          ),
          scale: this.clamp(
            this.state.character.scale,
            5,
            300
          ),
          rotation: this.clamp(
            this.state.character.rotation,
            -180,
            180
          ),
          bounce: Boolean(
            this.state.character.bounce
          )
        },

        effects: {
          ...this.state.effects
        },

        reaction: {
          ...this.state.reaction
        },

        lyrics: {
          ...this.state.lyrics
        },

        updatedAt: Date.now()
      };

      if (!this.dbReady || !this.db) {
        return false;
      }

      return new Promise(resolve => {
        try {
          const transaction =
            this.db.transaction(
              this.storeName,
              'readwrite'
            );

          const store =
            transaction.objectStore(
              this.storeName
            );

          store.put(serializableState);

          transaction.oncomplete = () => {
            resolve(true);
          };

          transaction.onerror = () => {
            resolve(false);
          };

          transaction.onabort = () => {
            resolve(false);
          };
        } catch (_) {
          resolve(false);
        }
      });
    }

    async loadState() {
      if (!this.dbReady || !this.db) {
        this.state = this.cloneDefaults();
        return false;
      }

      return new Promise(resolve => {
        try {
          const transaction =
            this.db.transaction(
              this.storeName,
              'readonly'
            );

          const store =
            transaction.objectStore(
              this.storeName
            );

          const request =
            store.get(this.stateKey);

          request.onsuccess = () => {
            const saved = request.result;

            if (!saved) {
              this.state = this.cloneDefaults();
              resolve(false);
              return;
            }

            this.state = this.mergeState(
              this.cloneDefaults(),
              saved
            );

            resolve(true);
          };

          request.onerror = () => {
            this.state = this.cloneDefaults();
            resolve(false);
          };
        } catch (_) {
          this.state = this.cloneDefaults();
          resolve(false);
        }
      });
    }

    mergeState(base, saved) {
      const result = {
        ...base,
        ...saved,

        layers: {
          ...base.layers,
          ...(saved.layers || {})
        },

        background: {
          ...base.background,
          ...(saved.background || {})
        },

        character: {
          ...base.character,
          ...(saved.character || {})
        },

        effects: {
          ...base.effects,
          ...(saved.effects || {})
        },

        reaction: {
          ...base.reaction,
          ...(saved.reaction || {})
        },

        lyrics: {
          ...base.lyrics,
          ...(saved.lyrics || {})
        }
      };

      result.character.x =
        this.clamp(
          result.character.x,
          0,
          100
        );

      result.character.y =
        this.clamp(
          result.character.y,
          0,
          100
        );

      result.character.scale =
        this.clamp(
          result.character.scale,
          5,
          300
        );

      result.character.rotation =
        this.clamp(
          result.character.rotation,
          -180,
          180
        );

      result.effects.particleCount =
        this.clamp(
          result.effects.particleCount,
          10,
          250
        );

      return result;
    }

    /* -----------------------------------------------------
       UI / ESTADO
       ----------------------------------------------------- */

    applyStateToUI() {
      const s = this.state;

      if (this.dom.toggleMaster) {
        this.dom.toggleMaster.checked =
          Boolean(s.enabled);
      }

      if (this.dom.toggleBackground) {
        this.dom.toggleBackground.checked =
          Boolean(s.layers.background);
      }

      if (this.dom.toggleEffects) {
        this.dom.toggleEffects.checked =
          Boolean(s.layers.effects);
      }

      if (this.dom.toggleCharacter) {
        this.dom.toggleCharacter.checked =
          Boolean(s.layers.character);
      }

      if (this.dom.toggleLyrics) {
        this.dom.toggleLyrics.checked =
          Boolean(s.layers.lyrics);
      }

      if (this.dom.toggleHud) {
        this.dom.toggleHud.checked =
          Boolean(s.layers.hud);
      }

      if (this.dom.backgroundUrl) {
        this.dom.backgroundUrl.value =
          s.background.source || '';
      }

      if (this.dom.characterUrl) {
        this.dom.characterUrl.value =
          s.character.source || '';
      }

      if (this.dom.characterX) {
        this.dom.characterX.value =
          String(s.character.x);
      }

      if (this.dom.characterY) {
        this.dom.characterY.value =
          String(s.character.y);
      }

      if (this.dom.characterScale) {
        this.dom.characterScale.value =
          String(s.character.scale);
      }

      if (this.dom.characterRotation) {
        this.dom.characterRotation.value =
          String(s.character.rotation);
      }

      if (this.dom.toggleBounce) {
        this.dom.toggleBounce.checked =
          Boolean(s.character.bounce);
      }

      if (this.dom.effectType) {
        this.dom.effectType.value =
          s.effects.type;
      }

      if (this.dom.particleCount) {
        this.dom.particleCount.value =
          String(s.effects.particleCount);
      }

      if (this.dom.sensitivity) {
        this.dom.sensitivity.value =
          String(s.effects.sensitivity);
      }

      if (this.dom.intensity) {
        this.dom.intensity.value =
          String(s.effects.intensity);
      }

      if (this.dom.speed) {
        this.dom.speed.value =
          String(s.effects.speed);
      }

      if (this.dom.bassReact) {
        this.dom.bassReact.value =
          String(s.reaction.bass);
      }

      if (this.dom.midReact) {
        this.dom.midReact.value =
          String(s.reaction.mid);
      }

      if (this.dom.brightness) {
        this.dom.brightness.value =
          String(s.reaction.brightness);
      }

      if (this.dom.lyricsMode) {
        this.dom.lyricsMode.value =
          s.lyrics.mode;
      }

      if (this.dom.lyricsInput) {
        this.dom.lyricsInput.value =
          s.lyrics.text || '';
      }

      this.updateRangeOutputs();
    }

    updateRangeOutputs() {
      if (this.dom.particleCountValue) {
        this.dom.particleCountValue.textContent =
          String(
            Math.round(
              this.state.effects.particleCount
            )
          );
      }

      if (this.dom.sensitivityValue) {
        this.dom.sensitivityValue.textContent =
          Number(
            this.state.effects.sensitivity
          ).toFixed(2);
      }

      if (this.dom.intensityValue) {
        this.dom.intensityValue.textContent =
          Number(
            this.state.effects.intensity
          ).toFixed(2);
      }

      if (this.dom.speedValue) {
        this.dom.speedValue.textContent =
          Number(
            this.state.effects.speed
          ).toFixed(2);
      }

      if (this.dom.bassReactValue) {
        this.dom.bassReactValue.textContent =
          Number(
            this.state.reaction.bass
          ).toFixed(2);
      }

      if (this.dom.midReactValue) {
        this.dom.midReactValue.textContent =
          Number(
            this.state.reaction.mid
          ).toFixed(2);
      }

      if (this.dom.brightnessValue) {
        this.dom.brightnessValue.textContent =
          Number(
            this.state.reaction.brightness
          ).toFixed(2);
      }
    }

    applyLayerVisibility() {
      if (!this.dom.root) {
        return;
      }

      this.dom.root.classList.toggle(
        'stage-background-disabled',
        !this.state.layers.background
      );

      this.dom.root.classList.toggle(
        'stage-effects-disabled',
        !this.state.layers.effects
      );

      this.dom.root.classList.toggle(
        'stage-character-disabled',
        !this.state.layers.character
      );

      this.dom.root.classList.toggle(
        'stage-lyrics-disabled',
        !this.state.layers.lyrics
      );

      this.dom.root.classList.toggle(
        'stage-hud-disabled',
        !this.state.layers.hud
      );
    }

    /* -----------------------------------------------------
       VISIBILIDAD / RAF
       ----------------------------------------------------- */

    show() {
      if (
        this.locked ||
        this.destroyed ||
        !this.dom.root
      ) {
        return false;
      }

      this.state.enabled = true;

      if (this.dom.toggleMaster) {
        this.dom.toggleMaster.checked = true;
      }

      this.dom.root.classList.add(
        'stage-active'
      );

      this.applyLayerVisibility();

      this.rebuildParticles();
      this.resizeCanvas();

      /*
       * Arranca un único requestAnimationFrame.
       */
      this.startAnimation();

      this.saveState();
      return true;
    }

    hide() {
      this.state.enabled = false;

      if (this.dom.toggleMaster) {
        this.dom.toggleMaster.checked = false;
      }

      if (this.dom.root) {
        this.dom.root.classList.remove(
          'stage-active'
        );
      }

      /*
       * Cancelación inmediata del RAF.
       * Esto evita mantener consumo de CPU/GPU
       * cuando el escenario está oculto.
       */
      this.stopAnimation();

      this.closeSettings();

      this.resetVisualEffects();
      this.saveState();
    }

    startAnimation() {
      if (this.rafId !== null) {
        return;
      }

      if (
        !this.state.enabled ||
        this.destroyed
      ) {
        return;
      }

      this.rafId =
        window.requestAnimationFrame(
          this.bound.render
        );
    }

    stopAnimation() {
      if (this.rafId !== null) {
        window.cancelAnimationFrame(
          this.rafId
        );

        this.rafId = null;
      }
    }

    render(timestamp) {
      /*
       * Primero anulamos la referencia actual.
       * Así el siguiente frame se registra de forma
       * explícita y nunca quedan dos bucles simultáneos.
       */
      this.rafId = null;

      if (
        this.destroyed ||
        !this.state.enabled ||
        !this.dom.root ||
        !this.dom.root.classList.contains(
          'stage-active'
        )
      ) {
        return;
      }

      this.updateAudioData();
      this.updateBackgroundReaction();
      this.updateParticles(timestamp);
      this.updateCharacterReaction();
      this.updateLyricsReaction();
      this.updatePulseEffects();

      this.rafId =
        window.requestAnimationFrame(
          this.bound.render
        );
    }

    /* -----------------------------------------------------
       AUDIO — SOLO ANALYSER EXISTENTE
       ----------------------------------------------------- */

    updateAudioData() {
      const analyser =
        this.getExistingAnalyser();

      if (!analyser) {
        this.smoothedBass =
          this.lerp(
            this.smoothedBass,
            0,
            0.08
          );

        this.smoothedMid =
          this.lerp(
            this.smoothedMid,
            0,
            0.08
          );

        this.smoothedEnergy =
          this.lerp(
            this.smoothedEnergy,
            0,
            0.08
          );

        return;
      }

      try {
        const requiredLength =
          analyser.frequencyBinCount;

        if (
          !this.frequencyData ||
          this.frequencyData.length !==
            requiredLength
        ) {
          this.frequencyData =
            new Uint8Array(
              requiredLength
            );
        }

        analyser.getByteFrequencyData(
          this.frequencyData
        );

        const bass =
          this.getFrequencyAverage(
            analyser,
            50,
            250
          );

        const mid =
          this.getFrequencyAverage(
            analyser,
            250,
            2000
          );

        const energy =
          this.getFrequencyAverage(
            analyser,
            50,
            8000
          );

        const bassNormalized =
          this.clamp(
            bass / 255,
            0,
            1
          );

        const midNormalized =
          this.clamp(
            mid / 255,
            0,
            1
          );

        const energyNormalized =
          this.clamp(
            energy / 255,
            0,
            1
          );

        this.smoothedBass =
          this.lerp(
            this.smoothedBass,
            bassNormalized,
            0.18
          );

        this.smoothedMid =
          this.lerp(
            this.smoothedMid,
            midNormalized,
            0.14
          );

        this.smoothedEnergy =
          this.lerp(
            this.smoothedEnergy,
            energyNormalized,
            0.12
          );

        /*
         * Detector sencillo de golpe.
         * No intenta reemplazar un beat detector profesional:
         * solo proporciona una reacción visual estable.
         */
        const beatThreshold =
          0.48 / Math.max(
            0.1,
            this.state.effects.sensitivity
          );

        if (
          this.smoothedBass > beatThreshold &&
          this.smoothedBass >
            this.lastBass + 0.045
        ) {
          this.beatPulse = 1;
          this.lastBeat =
            performance.now();
        }

        this.beatPulse =
          this.lerp(
            this.beatPulse,
            0,
            0.13
          );

        this.lastBass =
          this.smoothedBass;

        this.lastMid =
          this.smoothedMid;

        this.lastEnergy =
          this.smoothedEnergy;
      } catch (_) {}
    }

    getFrequencyAverage(
      analyser,
      minHz,
      maxHz
    ) {
      if (
        !this.frequencyData ||
        !analyser ||
        !analyser.context
      ) {
        return 0;
      }

      const sampleRate =
        analyser.context.sampleRate ||
        44100;

      const nyquist =
        sampleRate / 2;

      const binCount =
        analyser.frequencyBinCount;

      const minIndex =
        Math.max(
          0,
          Math.floor(
            minHz / nyquist * binCount
          )
        );

      const maxIndex =
        Math.min(
          binCount - 1,
          Math.ceil(
            maxHz / nyquist * binCount
          )
        );

      if (maxIndex < minIndex) {
        return 0;
      }

      let sum = 0;
      let count = 0;

      for (
        let i = minIndex;
        i <= maxIndex;
        i++
      ) {
        sum +=
          this.frequencyData[i] || 0;

        count++;
      }

      return count > 0
        ? sum / count
        : 0;
    }

    /* -----------------------------------------------------
       FONDO REACTIVO
       ----------------------------------------------------- */

    applyBackground() {
      const bg =
        this.state.background;

      this.releaseBackgroundObjectUrl();

      if (
        !bg ||
        (
          !bg.source &&
          !bg.blob
        )
      ) {
        this.clearBackgroundVisuals();
        return;
      }

      if (bg.blob) {
        try {
          this.backgroundObjectUrl =
            URL.createObjectURL(
              bg.blob
            );

          this.setBackgroundSource(
            this.backgroundObjectUrl,
            bg.type
          );

          return;
        } catch (_) {}
      }

      if (bg.source) {
        this.setBackgroundSource(
          bg.source,
          bg.type
        );
      }
    }

    setBackgroundSource(
      source,
      type
    ) {
      const normalizedType =
        type ||
        this.detectBackgroundType(
          source
        );

      const isVideo =
        normalizedType === 'video';

      const isImage =
        normalizedType === 'image' ||
        normalizedType === 'gif';

      if (isVideo) {
        if (this.dom.backgroundImage) {
          this.dom.backgroundImage.classList.remove(
            'stage-media-visible'
          );

          this.dom.backgroundImage.removeAttribute(
            'src'
          );
        }

        if (this.dom.backgroundVideo) {
          this.dom.backgroundVideo.src =
            source;

          this.dom.backgroundVideo.classList.add(
            'stage-media-visible'
          );

          this.dom.backgroundVideo.muted = true;
          this.dom.backgroundVideo.loop = true;
          this.dom.backgroundVideo.playsInline = true;

          const playPromise =
            this.dom.backgroundVideo.play();

          if (
            playPromise &&
            typeof playPromise.catch ===
              'function'
          ) {
            playPromise.catch(() => {});
          }
        }
      } else if (isImage) {
        if (this.dom.backgroundVideo) {
          this.dom.backgroundVideo.pause();

          this.dom.backgroundVideo.removeAttribute(
            'src'
          );

          this.dom.backgroundVideo.load();

          this.dom.backgroundVideo.classList.remove(
            'stage-media-visible'
          );
        }

        if (this.dom.backgroundImage) {
          this.dom.backgroundImage.src =
            source;

          this.dom.backgroundImage.classList.add(
            'stage-media-visible'
          );
        }
      }
    }

    detectBackgroundType(source) {
      const value =
        String(source || '')
          .toLowerCase()
          .split('?')[0]
          .split('#')[0];

      if (
        value.endsWith('.mp4') ||
        value.endsWith('.webm') ||
        value.startsWith('blob:')
      ) {
        return 'video';
      }

      if (value.endsWith('.gif')) {
        return 'gif';
      }

      return 'image';
    }

    async setBackgroundFile(file) {
      if (!file) {
        return;
      }

      const type =
        file.type.startsWith('video/')
          ? 'video'
          : file.type === 'image/gif'
            ? 'gif'
            : 'image';

      this.state.background = {
        type,
        source: '',
        blob: file
      };

      if (this.dom.backgroundUrl) {
        this.dom.backgroundUrl.value =
          '';
      }

      this.applyBackground();
      await this.saveState();
    }

    async setBackgroundUrl(url) {
      if (!url) {
        return;
      }

      const type =
        this.detectBackgroundType(url);

      this.state.background = {
        type,
        source: url,
        blob: null
      };

      this.applyBackground();
      await this.saveState();
    }

    async clearBackground() {
      this.releaseBackgroundObjectUrl();

      this.state.background = {
        type: '',
        source: '',
        blob: null
      };

      this.clearBackgroundVisuals();

      if (this.dom.backgroundUrl) {
        this.dom.backgroundUrl.value = '';
      }

      if (this.dom.backgroundFile) {
        this.dom.backgroundFile.value = '';
      }

      await this.saveState();
    }

    clearBackgroundVisuals() {
      if (this.dom.backgroundVideo) {
        this.dom.backgroundVideo.pause();

        this.dom.backgroundVideo.removeAttribute(
          'src'
        );

        this.dom.backgroundVideo.load();

        this.dom.backgroundVideo.classList.remove(
          'stage-media-visible'
        );
      }

      if (this.dom.backgroundImage) {
        this.dom.backgroundImage.removeAttribute(
          'src'
        );

        this.dom.backgroundImage.classList.remove(
          'stage-media-visible'
        );
      }
    }

    releaseBackgroundObjectUrl() {
      if (this.backgroundObjectUrl) {
        try {
          URL.revokeObjectURL(
            this.backgroundObjectUrl
          );
        } catch (_) {}

        this.backgroundObjectUrl = null;
      }
    }

    updateBackgroundReaction() {
      const video =
        this.dom.backgroundVideo;

      const image =
        this.dom.backgroundImage;

      const target =
        video &&
        video.classList.contains(
          'stage-media-visible'
        )
          ? video
          : image;

      if (!target) {
        return;
      }

      const sensitivity =
        this.state.effects.sensitivity;

      const bass =
        this.smoothedBass *
        this.state.reaction.bass *
        sensitivity;

      const mid =
        this.smoothedMid *
        this.state.reaction.mid *
        sensitivity;

      const energy =
        this.smoothedEnergy *
        sensitivity;

      const brightness =
        this.state.reaction.brightness +
        bass * 0.55 +
        mid * 0.15;

      const contrast =
        0.92 +
        energy * 0.38;

      const hue =
        (
          mid * 18 +
          bass * 8
        );

      const scale =
        1 +
        energy * 0.012;

      target.style.filter =
        [
          `brightness(${this.clamp(
            brightness,
            0.2,
            1.8
          )})`,
          `contrast(${this.clamp(
            contrast,
            0.7,
            1.6
          )})`,
          `hue-rotate(${hue.toFixed(2)}deg)`
        ].join(' ');

      target.style.transform =
        `translate3d(0,0,0) scale(${scale.toFixed(4)})`;
    }

    /* -----------------------------------------------------
       PERSONAJE
       ----------------------------------------------------- */

    applyCharacter() {
      this.applyCharacterTransform();

      this.releaseCharacterObjectUrl();

      const character =
        this.state.character;

      if (
        character.blob
      ) {
        try {
          this.characterObjectUrl =
            URL.createObjectURL(
              character.blob
            );

          this.setCharacterImageSource(
            this.characterObjectUrl
          );

          return;
        } catch (_) {}
      }

      if (character.source) {
        this.setCharacterImageSource(
          character.source
        );

        return;
      }

      if (this.dom.characterImage) {
        this.dom.characterImage.removeAttribute(
          'src'
        );
      }
    }

    setCharacterImageSource(source) {
      if (!this.dom.characterImage) {
        return;
      }

      this.dom.characterImage.src =
        source;
    }

    async setCharacterFile(file) {
      if (!file) {
        return;
      }

      if (
        !file.type.startsWith('image/')
      ) {
        return;
      }

      this.state.character.source = '';
      this.state.character.blob = file;

      if (this.dom.characterUrl) {
        this.dom.characterUrl.value = '';
      }

      this.applyCharacter();
      await this.saveState();
    }

    async setCharacterUrl(url) {
      if (!url) {
        return;
      }

      this.state.character.source =
        url;

      this.state.character.blob =
        null;

      this.applyCharacter();
      await this.saveState();
    }

    releaseCharacterObjectUrl() {
      if (this.characterObjectUrl) {
        try {
          URL.revokeObjectURL(
            this.characterObjectUrl
          );
        } catch (_) {}

        this.characterObjectUrl = null;
      }
    }

    applyCharacterTransform(
      beatScale = 1
    ) {
      if (!this.dom.character) {
        return;
      }

      const c =
        this.state.character;

      this.dom.character.style.setProperty(
        '--stage-character-x',
        String(c.x)
      );

      this.dom.character.style.setProperty(
        '--stage-character-y',
        String(c.y)
      );

      this.dom.character.style.setProperty(
        '--stage-character-scale',
        String(c.scale)
      );

      this.dom.character.style.setProperty(
        '--stage-character-rotation',
        String(c.rotation)
      );

      this.dom.character.style.setProperty(
        '--stage-character-beat-scale',
        String(beatScale)
      );
    }

    updateCharacterReaction() {
      if (
        !this.dom.character ||
        !this.state.layers.character
      ) {
        return;
      }

      if (!this.state.character.bounce) {
        this.applyCharacterTransform(1);
        return;
      }

      const beat =
        this.clamp(
          this.smoothedBass *
          this.state.effects.sensitivity *
          0.28,
          0,
          0.16
        );

      const bounce =
        1 + beat;

      this.applyCharacterTransform(
        bounce
      );

      if (this.dom.characterGlow) {
        const glowScale =
          0.9 +
          beat * 2.5;

        const glowOpacity =
          0.55 +
          beat * 2;

        this.dom.characterGlow.style.transform =
          `translate3d(0,0,0) scale(${glowScale.toFixed(3)})`;

        this.dom.characterGlow.style.opacity =
          String(
            this.clamp(
              glowOpacity,
              0.4,
              1
            )
          );
      }
    }

    resetCharacter() {
      const currentSource =
        this.state.character.source;

      const currentBlob =
        this.state.character.blob;

      this.state.character = {
        ...this.defaults.character,
        source: currentSource,
        blob: currentBlob
      };

      this.applyStateToUI();
      this.applyCharacter();

      this.saveState();
    }

    /* -----------------------------------------------------
       DRAG & DROP
       Coordenadas siempre en X/Y porcentuales.
       ----------------------------------------------------- */

    bindCharacterPointerEvents() {
      if (!this.dom.character) {
        return;
      }

      this.dom.character.addEventListener(
        'pointerdown',
        event => {
          if (
            event.button !== 0 &&
            event.pointerType !== 'touch'
          ) {
            return;
          }

          if (
            event.target ===
            this.dom.characterResize
          ) {
            return;
          }

          event.preventDefault();

          this.dragState.active = true;
          this.dragState.pointerId =
            event.pointerId;

          this.dragState.startClientX =
            event.clientX;

          this.dragState.startClientY =
            event.clientY;

          this.dragState.startX =
            this.state.character.x;

          this.dragState.startY =
            this.state.character.y;

          this.dom.character.classList.add(
            'stage-dragging'
          );

          try {
            this.dom.character.setPointerCapture(
              event.pointerId
            );
          } catch (_) {}
        }
      );

      this.dom.character.addEventListener(
        'pointermove',
        this.bound.dragMove
      );

      this.dom.character.addEventListener(
        'pointerup',
        this.bound.dragEnd
      );

      this.dom.character.addEventListener(
        'pointercancel',
        this.bound.dragEnd
      );

      if (this.dom.characterResize) {
        this.dom.characterResize.addEventListener(
          'pointerdown',
          event => {
            event.preventDefault();
            event.stopPropagation();

            this.resizeState.active =
              true;

            this.resizeState.pointerId =
              event.pointerId;

            this.resizeState.startClientX =
              event.clientX;

            this.resizeState.startClientY =
              event.clientY;

            this.resizeState.startScale =
              this.state.character.scale;

            try {
              this.dom.characterResize.setPointerCapture(
                event.pointerId
              );
            } catch (_) {}
          }
        );

        this.dom.characterResize.addEventListener(
          'pointermove',
          this.bound.resizeMove
        );

        this.dom.characterResize.addEventListener(
          'pointerup',
          this.bound.resizeEnd
        );

        this.dom.characterResize.addEventListener(
          'pointercancel',
          this.bound.resizeEnd
        );
      }
    }

    onDragMove(event) {
      if (
        !this.dragState.active ||
        event.pointerId !==
          this.dragState.pointerId
      ) {
        return;
      }

      const viewportWidth =
        window.innerWidth || 1;

      const viewportHeight =
        window.innerHeight || 1;

      const deltaX =
        (
          event.clientX -
          this.dragState.startClientX
        ) /
        viewportWidth *
        100;

      const deltaY =
        (
          event.clientY -
          this.dragState.startClientY
        ) /
        viewportHeight *
        100;

      /*
       * Guardamos porcentajes, no píxeles.
       */
      this.state.character.x =
        this.clamp(
          this.dragState.startX +
            deltaX,
          0,
          100
        );

      this.state.character.y =
        this.clamp(
          this.dragState.startY +
            deltaY,
          0,
          100
        );

      this.applyCharacterTransform();
      this.syncCharacterInputs();
    }

    onDragEnd(event) {
      if (
        event.pointerId !==
          this.dragState.pointerId
      ) {
        return;
      }

      this.dragState.active = false;
      this.dragState.pointerId = null;

      if (this.dom.character) {
        this.dom.character.classList.remove(
          'stage-dragging'
        );
      }

      this.syncCharacterInputs();
      this.saveState();
    }

    onResizeMove(event) {
      if (
        !this.resizeState.active ||
        event.pointerId !==
          this.resizeState.pointerId
      ) {
        return;
      }

      const viewportWidth =
        window.innerWidth || 1;

      const deltaX =
        event.clientX -
        this.resizeState.startClientX;

      const deltaScale =
        deltaX /
        viewportWidth *
        150;

      this.state.character.scale =
        this.clamp(
          this.resizeState.startScale +
            deltaScale,
          5,
          300
        );

      this.applyCharacterTransform();
      this.syncCharacterInputs();
    }

    onResizeEnd(event) {
      if (
        event.pointerId !==
          this.resizeState.pointerId
      ) {
        return;
      }

      this.resizeState.active = false;
      this.resizeState.pointerId = null;

      this.syncCharacterInputs();
      this.saveState();
    }

    syncCharacterInputs() {
      if (this.dom.characterX) {
        this.dom.characterX.value =
          String(
            Number(
              this.state.character.x
            ).toFixed(1)
          );
      }

      if (this.dom.characterY) {
        this.dom.characterY.value =
          String(
            Number(
              this.state.character.y
            ).toFixed(1)
          );
      }

      if (this.dom.characterScale) {
        this.dom.characterScale.value =
          String(
            Math.round(
              this.state.character.scale
            )
          );
      }

      if (this.dom.characterRotation) {
        this.dom.characterRotation.value =
          String(
            Math.round(
              this.state.character.rotation
            )
          );
      }
    }

    /* -----------------------------------------------------
       CANVAS
       ----------------------------------------------------- */

    resizeCanvas() {
      if (
        !this.dom.canvas
      ) {
        return;
      }

      const rect =
        this.dom.canvas.getBoundingClientRect();

      const dpr =
        Math.min(
          window.devicePixelRatio || 1,
          2
        );

      const width =
        Math.max(
          1,
          Math.floor(
            rect.width * dpr
          )
        );

      const height =
        Math.max(
          1,
          Math.floor(
            rect.height * dpr
          )
        );

      if (
        this.dom.canvas.width !== width ||
        this.dom.canvas.height !== height
      ) {
        this.dom.canvas.width =
          width;

        this.dom.canvas.height =
          height;
      }

      if (!this.ctx) {
        this.ctx =
          this.dom.canvas.getContext(
            '2d',
            {
              alpha: true,
              desynchronized: true
            }
          );
      }

      if (this.ctx) {
        this.ctx.setTransform(
          dpr,
          0,
          0,
          dpr,
          0,
          0
        );
      }

      this.rebuildParticles();
    }

    rebuildParticles() {
      const canvas =
        this.dom.canvas;

      if (!canvas) {
        return;
      }

      const rect =
        canvas.getBoundingClientRect();

      const width =
        Math.max(
          1,
          rect.width
        );

      const height =
        Math.max(
          1,
          rect.height
        );

      const desired =
        Math.round(
          this.state.effects.particleCount
        );

      const current =
        this.particles.length;

      if (current < desired) {
        for (
          let i = current;
          i < desired;
          i++
        ) {
          this.particles.push(
            this.createParticle(
              width,
              height
            )
          );
        }
      } else if (
        current > desired
      ) {
        this.particles.length =
          desired;
      }
    }

    createParticle(
      width,
      height
    ) {
      return {
        x: Math.random() * width,
        y: Math.random() * height,
        vx:
          (Math.random() - 0.5) *
          0.4,
        vy:
          (Math.random() - 0.5) *
          0.4,
        size:
          1 +
          Math.random() * 3,
        life:
          0.4 +
          Math.random() * 0.6,
        phase:
          Math.random() *
          Math.PI *
          2,
        alpha:
          0.2 +
          Math.random() * 0.7
      };
    }

    updateParticles(timestamp) {
      if (
        !this.state.layers.effects ||
        !this.dom.canvas ||
        !this.ctx
      ) {
        return;
      }

      const rect =
        this.dom.canvas.getBoundingClientRect();

      const width =
        rect.width;

      const height =
        rect.height;

      const dpr =
        Math.min(
          window.devicePixelRatio || 1,
          2
        );

      this.ctx.setTransform(
        dpr,
        0,
        0,
        dpr,
        0,
        0
      );

      this.ctx.clearRect(
        0,
        0,
        width,
        height
      );

      const type =
        this.state.effects.type;

      const intensity =
        this.state.effects.intensity;

      const speed =
        this.state.effects.speed;

      const sensitivity =
        this.state.effects.sensitivity;

      const energy =
        this.smoothedEnergy *
        sensitivity;

      const bass =
        this.smoothedBass *
        sensitivity;

      if (
        type === 'pulse' ||
        type === 'mixed'
      ) {
        this.drawPulseWave(
          width,
          height,
          energy,
          intensity
        );
      }

      if (
        type === 'sparkles' ||
        type === 'mixed'
      ) {
        this.drawSparkles(
          width,
          height,
          energy,
          intensity
        );
      }

      if (
        type === 'fire' ||
        type === 'particles' ||
        type === 'mixed'
      ) {
        this.drawParticles(
          width,
          height,
          energy,
          bass,
          speed,
          intensity,
          timestamp
        );
      }
    }

    drawParticles(
      width,
      height,
      energy,
      bass,
      speed,
      intensity,
      timestamp
    ) {
      const ctx =
        this.ctx;

      if (!ctx) {
        return;
      }

      const isFire =
        this.state.effects.type ===
        'fire';

      for (
        let i = 0;
        i < this.particles.length;
        i++
      ) {
        const p =
          this.particles[i];

        const motion =
          (
            0.25 +
            energy * 2
          ) *
          speed;

        if (isFire) {
          p.vy =
            -(
              0.3 +
              energy * 1.7
            ) *
            speed;

          p.vx +=
            Math.sin(
              timestamp * 0.002 +
              p.phase
            ) *
            0.01;

          p.y += p.vy;
          p.x += p.vx;

          p.size =
            1.5 +
            Math.random() *
              3.5 +
            bass * 4;
        } else {
          p.x +=
            p.vx * motion +
            Math.sin(
              timestamp * 0.001 +
              p.phase
            ) *
              energy *
              0.4;

          p.y +=
            p.vy * motion;
        }

        if (
          p.x < -20 ||
          p.x > width + 20 ||
          p.y < -30 ||
          p.y > height + 30
        ) {
          p.x =
            Math.random() *
            width;

          p.y =
            isFire
              ? height +
                Math.random() *
                  40
              : Math.random() *
                height;

          p.vx =
            (Math.random() - 0.5) *
            0.5;

          p.vy =
            isFire
              ? -(
                  0.4 +
                  Math.random() *
                    0.8
                )
              : (
                  Math.random() - 0.5
                ) *
                0.5;
        }

        const alpha =
          this.clamp(
            p.alpha *
              (
                0.55 +
                energy * 1.2
              ) *
              intensity,
            0.03,
            0.95
          );

        if (isFire) {
          ctx.fillStyle =
            `rgba(255, ${Math.round(
              80 +
              110 *
                (1 - p.life)
            )}, 50, ${alpha})`;
        } else {
          ctx.fillStyle =
            `rgba(255,255,255,${alpha})`;
        }

        ctx.beginPath();

        ctx.arc(
          p.x,
          p.y,
          p.size,
          0,
          Math.PI * 2
        );

        ctx.fill();
      }
    }

    drawSparkles(
      width,
      height,
      energy,
      intensity
    ) {
      const ctx =
        this.ctx;

      if (!ctx) {
        return;
      }

      const count =
        Math.min(
          24,
          Math.floor(
            5 +
            energy * 18
          )
        );

      for (
        let i = 0;
        i < count;
        i++
      ) {
        const x =
          Math.random() *
          width;

        const y =
          Math.random() *
          height;

        const size =
          1 +
          Math.random() *
            3 *
            intensity;

        const alpha =
          this.clamp(
            0.2 +
              energy *
                intensity,
            0,
            1
          );

        ctx.fillStyle =
          `rgba(255,255,255,${alpha})`;

        ctx.fillRect(
          x - size,
          y - size,
          size * 2,
          size * 2
        );
      }
    }

    drawPulseWave(
      width,
      height,
      energy,
      intensity
    ) {
      const ctx =
        this.ctx;

      if (!ctx) {
        return;
      }

      const centerX =
        width / 2;

      const centerY =
        height / 2;

      const maxRadius =
        Math.max(
          width,
          height
        ) *
        0.75;

      const radius =
        maxRadius *
        (
          0.1 +
          energy * 0.5
        );

      const alpha =
        this.clamp(
          energy *
            0.22 *
            intensity,
          0,
          0.35
        );

      ctx.beginPath();

      ctx.arc(
        centerX,
        centerY,
        radius,
        0,
        Math.PI * 2
      );

      ctx.strokeStyle =
        `rgba(139,92,246,${alpha})`;

      ctx.lineWidth =
        1 +
        energy * 4;

      ctx.stroke();
    }

    resetVisualEffects() {
      if (this.dom.canvas && this.ctx) {
        const rect =
          this.dom.canvas.getBoundingClientRect();

        this.ctx.clearRect(
          0,
          0,
          rect.width,
          rect.height
        );
      }

      if (this.dom.glow) {
        this.dom.glow.style.setProperty(
          '--stage-glow-scale',
          '1'
        );

        this.dom.glow.style.setProperty(
          '--stage-glow-alpha',
          '0.14'
        );
      }

      if (this.dom.pulseRing) {
        this.dom.pulseRing.style.setProperty(
          '--stage-pulse-scale',
          '0.85'
        );

        this.dom.pulseRing.style.setProperty(
          '--stage-pulse-alpha',
          '0'
        );
      }

      this.applyCharacterTransform(1);
    }

    /* -----------------------------------------------------
       PULSO VISUAL
       ----------------------------------------------------- */

    updatePulseEffects() {
      const energy =
        this.smoothedEnergy *
        this.state.effects.sensitivity;

      const bass =
        this.smoothedBass *
        this.state.effects.sensitivity;

      if (this.dom.glow) {
        const scale =
          0.9 +
          energy * 0.45;

        const alpha =
          this.clamp(
            0.08 +
              energy *
                0.32 *
                this.state.effects.intensity,
            0.05,
            0.5
          );

        this.dom.glow.style.setProperty(
          '--stage-glow-scale',
          scale.toFixed(3)
        );

        this.dom.glow.style.setProperty(
          '--stage-glow-alpha',
          alpha.toFixed(3)
        );
      }

      if (this.dom.pulseRing) {
        const scale =
          0.85 +
          this.beatPulse * 0.7;

        const alpha =
          this.clamp(
            this.beatPulse *
              this.state.effects.intensity,
            0,
            0.8
          );

        this.dom.pulseRing.style.setProperty(
          '--stage-pulse-scale',
          scale.toFixed(3)
        );

        this.dom.pulseRing.style.setProperty(
          '--stage-pulse-alpha',
          alpha.toFixed(3)
        );
      }
    }

    /* -----------------------------------------------------
       LETRAS SINCRONIZADAS
       ----------------------------------------------------- */

    parseLyrics() {
      const text =
        this.state.lyrics.text || '';

      const lines =
        text.split(/\r?\n/);

      const parsed = [];

      for (
        let i = 0;
        i < lines.length;
        i++
      ) {
        const line =
          lines[i].trim();

        if (!line) {
          continue;
        }

        const match =
          line.match(
            /^\s*\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.+?)\s*$/
          );

        if (!match) {
          continue;
        }

        const minutes =
          Number(match[1]);

        const seconds =
          Number(match[2]);

        const fraction =
          match[3]
            ? Number(
                `0.${match[3]}`
              )
            : 0;

        const time =
          minutes * 60 +
          seconds +
          fraction;

        parsed.push({
          time,
          text: match[4],
          index: parsed.length
        });
      }

      parsed.sort(
        (a, b) =>
          a.time - b.time
      );

      this.lyrics =
        parsed;

      this.activeLyricIndex =
        -1;
    }

    applyLyrics() {
      if (!this.dom.lyricsContainer) {
        return;
      }

      this.parseLyrics();

      this.dom.lyricsContainer.innerHTML =
        '';

      this.lyricElements = [];

      for (
        let i = 0;
        i < this.lyrics.length;
        i++
      ) {
        const lyric =
          this.lyrics[i];

        const span =
          document.createElement(
            'span'
          );

        span.className =
          'stage-lyric-word';

        span.textContent =
          lyric.text;

        span.dataset.index =
          String(i);

        this.dom.lyricsContainer.appendChild(
          span
        );

        this.lyricElements.push(
          span
        );
      }

      this.applyLyricsMode();
    }

    applyLyricsMode() {
      if (!this.dom.lyricsPanel) {
        return;
      }

      const decorated =
        this.state.lyrics.mode ===
        'decorated';

      this.dom.lyricsPanel.classList.toggle(
        'stage-lyrics-decorated',
        decorated
      );

      this.dom.lyricsPanel.classList.toggle(
        'stage-lyrics-simple',
        !decorated
      );
    }

    getCurrentLyricIndex(
      currentTime
    ) {
      let current = -1;

      for (
        let i = 0;
        i < this.lyrics.length;
        i++
      ) {
        if (
          this.lyrics[i].time <=
          currentTime
        ) {
          current = i;
        } else {
          break;
        }
      }

      return current;
    }

    updateLyricsReaction() {
      if (
        !this.state.layers.lyrics ||
        !this.lyricElements.length
      ) {
        return;
      }

      const audio =
        this.getActiveAudio();

      if (!audio) {
        return;
      }

      const currentTime =
        Number.isFinite(
          audio.currentTime
        )
          ? audio.currentTime
          : 0;

      const currentIndex =
        this.getCurrentLyricIndex(
          currentTime
        );

      if (
        currentIndex !==
        this.activeLyricIndex
      ) {
        this.activeLyricIndex =
          currentIndex;

        for (
          let i = 0;
          i < this.lyricElements.length;
          i++
        ) {
          this.lyricElements[i].classList.toggle(
            'stage-word-active',
            i === currentIndex
          );
        }
      }

      /*
       * El golpe de audio añade un pequeño impulso
       * sin modificar la sincronización temporal.
       */
      if (
        currentIndex >= 0 &&
        this.lyricElements[currentIndex]
      ) {
        const beat =
          this.beatPulse *
          this.state.effects.sensitivity;

        const scale =
          1.04 +
          this.clamp(
            beat * 0.08,
            0,
            0.1
          );

        this.lyricElements[
          currentIndex
        ].style.transform =
          `translate3d(0,-4px,0) scale(${scale.toFixed(3)})`;
      }
    }

    /* -----------------------------------------------------
       PANEL
       ----------------------------------------------------- */

    toggleSettings() {
      if (!this.dom.settings) {
        return;
      }

      const open =
        this.dom.settings.classList.contains(
          'stage-settings-open'
        );

      if (open) {
        this.closeSettings();
      } else {
        this.openSettings();
      }
    }

    openSettings() {
      if (!this.dom.settings) {
        return;
      }

      this.dom.settings.classList.add(
        'stage-settings-open'
      );

      this.dom.settings.setAttribute(
        'aria-hidden',
        'false'
      );
    }

    closeSettings() {
      if (!this.dom.settings) {
        return;
      }

      this.dom.settings.classList.remove(
        'stage-settings-open'
      );

      this.dom.settings.setAttribute(
        'aria-hidden',
        'true'
      );
    }

    /* -----------------------------------------------------
       RESET
       ----------------------------------------------------- */

    async resetAll() {
      this.stopAnimation();

      this.releaseBackgroundObjectUrl();
      this.releaseCharacterObjectUrl();

      this.state =
        this.cloneDefaults();

      this.applyStateToUI();
      this.applyLayerVisibility();
      this.applyBackground();
      this.applyCharacter();
      this.applyLyrics();

      this.rebuildParticles();

      await this.saveState();

      if (this.state.enabled) {
        this.startAnimation();
      }
    }

    /* -----------------------------------------------------
       DESTROY
       ----------------------------------------------------- */

    destroy() {
      if (this.destroyed) {
        return;
      }

      this.destroyed = true;

      /*
       * Cancelación inmediata del frame.
       */
      this.stopAnimation();

      if (this.resizeTimer) {
        window.clearTimeout(
          this.resizeTimer
        );

        this.resizeTimer = null;
      }

      window.removeEventListener(
        'resize',
        this.bound.resize
      );

      this.releaseBackgroundObjectUrl();
      this.releaseCharacterObjectUrl();

      if (this.dom.backgroundVideo) {
        this.dom.backgroundVideo.pause();
      }

      this.particles.length = 0;

      if (this.ctx && this.dom.canvas) {
        const rect =
          this.dom.canvas.getBoundingClientRect();

        this.ctx.clearRect(
          0,
          0,
          rect.width,
          rect.height
        );
      }

      if (this.db) {
        try {
          this.db.close();
        } catch (_) {}
      }

      this.db = null;
      this.dbReady = false;

      if (this.dom.root) {
        this.dom.root.classList.remove(
          'stage-active'
        );
      }
    }
  }

  /* =======================================================
     INSTANCIA GLOBAL ÚNICA
     ======================================================= */

  const stageManager =
    new StageManager();

  /*
   * Se expone para que Glasstrack Pro pueda abrir/cerrar
   * el escenario desde cualquier parte sin modificar
   * su lógica existente.
   *
   * Ejemplos externos:
   *
   * window.StageManager.show();
   * window.StageManager.hide();
   * window.StageManager.toggleSettings();
   * window.StageManager.destroy();
   */
  window.StageManager =
    stageManager;

  /*
   * Inicialización independiente después de que el DOM
   * existente haya terminado de cargarse.
   */
  const initializeStageManager =
    () => {
      stageManager
        .init()
        .catch(error => {
          console.warn(
            '[StageManager] Error de inicialización:',
            error
          );
        });
    };

  if (
    document.readyState ===
    'loading'
  ) {
    document.addEventListener(
      'DOMContentLoaded',
      initializeStageManager,
      { once: true }
    );
  } else {
    initializeStageManager();
  }

})(window, document);



/* =========================================================
   GLASSTRACK PRO — SPLASH SCREEN HUD / INTRO v2.5 PRO
   ========================================================= */
(() => {
  'use strict';

  const INTRO_KEY = 'glasstrack_intro_seen';
  const TARGET_COUNT = 1230;
  const TIPS_LIST = [
    "Atajo HUD: Presiona F7 para ocultar o mostrar instantáneamente todos los botones e íconos de la pantalla.",
    "Control de Reproducción: Usa la Barra Espaciadora para pausar o reanudar tu música en cualquier momento.",
    "Importación Rápida: Arrastra y suelta archivos .sim o .sims directamente a la ventana para añadirlos a tu biblioteca.",
    "Modo Enfoque: Presiona la tecla F para activar el Modo Enfoque y escuchar música sin distracciones.",
    "Menú de Experiencias: La tecla M abre directamente el menú flotante con los modos de visualización.",
    "Transparencia Glass: Ajusta el nivel de opacidad del efecto cristal desde el panel de Ajustes Generales.",
    "Cierre Rápido: Presiona Esc para cerrar de inmediato cualquier ventana o menú que tengas abierto.",
    "Letras Decoradas: En el Modo Karaoke, activa las letras decoradas para una animación tipo concierto.",
    "Balance de Audio: Usa el ajuste L/R en la configuración de sonido si usas audífonos con volumen descompensado.",
    "Graves Intensos: El ecualizador avanzado permite activar el realce de bajos en canciones de mucho ritmo.",
    "Estilo Karaoke: Cambia entre fondo difuminado o negro sólido para leer las letras cómodamente.",
    "Rendimiento: Si notas tirones de pantalla, desactiva las animaciones secundarias en Ajustes.",
    "Persistencia Local: Tu biblioteca y configuraciones se guardan automáticamente en IndexedDB.",
    "Barra de Tiempo: Haz clic sobre la barra de progreso para saltar al segundo exacto de la pista.",
    "Normalizador: Activa la normalización de volumen para evitar saltos bruscos entre distintas canciones.",
    "Velocidad de Canto: Puedes cambiar la velocidad de la pista sin alterar la afinación ni el tono de la voz.",
    "Botón Saltar: Si no quieres esperar la animación de entrada, haz clic en el botón flotante \"Saltar\".",
    "Temporizador: Programa un temporizador de apagado si te gusta dormir escuchando tu música.",
    "Formato Limpio: El contador de tiempo muestra formato exacto en horas, minutos y segundos.",
    "Listas Personalizadas: Crea carpetas de reproducción temáticas desde el gestor de archivos.",
    "Teclas Rápidas: Mantén la barra de atajos visible para memorizar los controles del reproductor.",
  ];

  const splash = document.getElementById('glasstrack-splash');
  if (!splash) return;

  let audio = null;
  let countTimer = null;
  let unlockTimer = null;
  let currentCount = 0;
  let lockedCount = 0;
  let isClosing = false;
  let hudHidden = false;

  const countEl = document.getElementById('splash-count');
  const tipEl = document.getElementById('splash-tip');
  const skipBtn = document.getElementById('btn-skip-splash');
  const logoEl = document.getElementById('splash-logo');
  const hud = document.getElementById('splash-hud');

  function hasSeenIntro() {
    try {
      return localStorage.getItem(INTRO_KEY) === 'true';
    } catch (_) {
      return false;
    }
  }

  function markIntroSeen() {
    try {
      localStorage.setItem(INTRO_KEY, 'true');
    } catch (_) {}
    document.documentElement.classList.add('glasstrack-intro-seen');
  }

  function randomTip() {
    if (!tipEl || !TIPS_LIST.length) return;
    const index = Math.floor(Math.random() * TIPS_LIST.length);
    tipEl.textContent = TIPS_LIST[index];
  }

  function safePlaySfx() {
    try {
      if (typeof playSFX === 'function') playSFX('click');
    } catch (_) {}
  }

  function startIntroAudio() {
    try {
      audio = new Audio('assets/sounds/intro-effect.mp3');
      audio.preload = 'auto';
      audio.volume = 0.72;
      const promise = audio.play();
      if (promise && typeof promise.catch === 'function') {
        promise.catch(() => {});
      }
    } catch (_) {
      audio = null;
    }
  }

  function updateCount(value) {
    currentCount = Math.max(0, Math.min(TARGET_COUNT, Math.floor(value)));
    if (countEl) countEl.textContent = String(currentCount);
  }

  function pickRandomLockPoint() {
    const min = 250;
    const max = TARGET_COUNT - 170;
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  function pickLockDuration() {
    return Math.floor(1500 + Math.random() * 2200);
  }

  function showSkipButton() {
    if (!skipBtn) return;
    splash.classList.add('splash-stuck');
    skipBtn.classList.add('splash-skip-visible');
  }

  function hideSkipButton() {
    if (!skipBtn) return;
    skipBtn.classList.remove('splash-skip-visible');
  }

  function stopTimers() {
    if (countTimer !== null) {
      window.clearInterval(countTimer);
      countTimer = null;
    }
    if (unlockTimer !== null) {
      window.clearTimeout(unlockTimer);
      unlockTimer = null;
    }
  }

  function finishIntro() {
    if (isClosing) return;
    isClosing = true;
    stopTimers();
    updateCount(TARGET_COUNT);
    hideSkipButton();
    splash.classList.remove('splash-stuck');
    splash.classList.add('splash-exiting');

    window.setTimeout(() => {
      markIntroSeen();
      splash.classList.add('splash-hidden');
      splash.hidden = true;
      if (audio) {
        try { audio.pause(); } catch (_) {}
        audio = null;
      }
    }, 440);
  }

  function startCounter() {
    lockedCount = pickRandomLockPoint();
    const lockDuration = pickLockDuration();
    currentCount = 0;
    updateCount(0);

    const COUNT_DURATION_MS = 15000;
    const stepDelay = Math.max(16, Math.floor(COUNT_DURATION_MS / TARGET_COUNT));

    countTimer = window.setInterval(() => {
      if (isClosing) {
        stopTimers();
        return;
      }

      if (currentCount < lockedCount) {
        const jump = Math.random() < 0.18 ? 2 : 1;
        updateCount(Math.min(lockedCount, currentCount + jump));
        return;
      }

      if (!splash.classList.contains('splash-stuck')) {
        updateCount(lockedCount);
        showSkipButton();
        unlockTimer = window.setTimeout(() => {
          if (isClosing) return;
          splash.classList.remove('splash-stuck');
          hideSkipButton();
          unlockTimer = null;
          countTimer = window.setInterval(() => {
            if (currentCount >= TARGET_COUNT) {
              finishIntro();
              return;
            }
            const boost = currentCount < TARGET_COUNT - 20 ? Math.ceil(Math.random() * 4) : 1;
            updateCount(Math.min(TARGET_COUNT, currentCount + boost));
          }, stepDelay);
        }, lockDuration);

        window.clearInterval(countTimer);
        countTimer = null;
      }
    }, stepDelay);
  }

  function toggleHud(force) {
    hudHidden = typeof force === 'boolean' ? force : !hudHidden;
    splash.classList.toggle('splash-hud-hidden', hudHidden);
    if (hud) hud.setAttribute('aria-hidden', String(hudHidden));
  }

  function runShortcut(action) {
    const play = document.getElementById('play');
    const menu = document.getElementById('btn-main-menu');
    const focus = document.getElementById('btn-focus-mode');

    switch (action) {
      case 'play':
        safePlaySfx();
        if (play) play.click();
        break;
      case 'hud':
        toggleHud();
        break;
      case 'menu':
        finishIntro();
        window.setTimeout(() => menu?.click(), 40);
        break;
      case 'focus':
        finishIntro();
        window.setTimeout(() => focus?.click(), 40);
        break;
      case 'close':
        finishIntro();
        break;
      default:
        break;
    }
  }

  skipBtn?.addEventListener('click', () => {
    safePlaySfx();
    updateCount(TARGET_COUNT);
    finishIntro();
  });

  splash.querySelectorAll('[data-splash-action]').forEach(button => {
    button.addEventListener('click', () => {
      runShortcut(button.getAttribute('data-splash-action'));
    });
  });

  logoEl?.addEventListener('error', () => {
    logoEl.style.display = 'none';
  });

  document.addEventListener('keydown', event => {
    if (!splash || splash.classList.contains('splash-hidden') || splash.hidden) return;

    if (event.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;

    if (event.code === 'Space') {
      event.preventDefault();
      runShortcut('play');
    } else if (event.code === 'F7') {
      event.preventDefault();
      runShortcut('hud');
    } else if (event.code === 'KeyM') {
      event.preventDefault();
      runShortcut('menu');
    } else if (event.code === 'KeyF') {
      event.preventDefault();
      runShortcut('focus');
    } else if (event.code === 'Escape') {
      event.preventDefault();
      runShortcut('close');
    }
  });

  if (hasSeenIntro()) {
    document.documentElement.classList.add('glasstrack-intro-seen');
    splash.classList.add('splash-hidden');
    splash.hidden = true;
    return;
  }

  randomTip();
  startIntroAudio();
  startCounter();
})();


/* =========================================================
   GLASSTRACK PRO — MOBILE UI V3 / STATE SYNC
   ========================================================= */
(() => {
  'use strict';

  const player = document.getElementById('player-card');
  const nowPlaying = document.getElementById('mobile-nowplaying-bar');
  const bottomNav = document.getElementById('mobile-tab-bar');
  const closePlayer = document.getElementById('btn-close-mobile-player');

  if (!player) return;

  const syncExpandedMobilePlayer = () => {
    const expanded = document.body.classList.contains('mobile-player-expanded') &&
      player.classList.contains('mobile-expanded');

    if (expanded) {
      document.documentElement.classList.add('mobile-player-layer-open');
      if (nowPlaying) nowPlaying.setAttribute('aria-hidden', 'true');
      if (bottomNav) bottomNav.setAttribute('aria-hidden', 'true');
    } else {
      document.documentElement.classList.remove('mobile-player-layer-open');
      if (nowPlaying) nowPlaying.removeAttribute('aria-hidden');
      if (bottomNav) bottomNav.removeAttribute('aria-hidden');
    }
  };

  const expandPlayer = () => {
    if (!document.body.classList.contains('mobile-layout')) return;
    player.classList.add('mobile-expanded');
    document.body.classList.add('mobile-player-expanded');
    syncExpandedMobilePlayer();
  };

  const collapsePlayer = () => {
    player.classList.remove('mobile-expanded');
    document.body.classList.remove('mobile-player-expanded');
    syncExpandedMobilePlayer();
  };

  if (nowPlaying) {
    nowPlaying.addEventListener('click', event => {
      if (event.target.closest('#mobile-np-play')) return;
      expandPlayer();
    });
  }

  if (closePlayer) {
    closePlayer.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      playSFX('close');
      collapsePlayer();
    }, true);
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.body.classList.contains('mobile-player-expanded')) {
      event.preventDefault();
      collapsePlayer();
    }
  });

  const observer = new MutationObserver(syncExpandedMobilePlayer);
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['class']
  });

  syncExpandedMobilePlayer();
})();


/* =========================================================
   GLASSTRACK PRO — MOBILE UI V4 / INTEGRACIÓN REAL
   Todo el comportamiento añadido aquí se ejecuta solo cuando
   body.mobile-layout/mobile-mode está activo.
   ========================================================= */
(() => {
  'use strict';

  const isMobileMode = () =>
    document.body.classList.contains('mobile-layout') ||
    document.body.classList.contains('mobile-mode');

  const fileInputEl = document.getElementById('file-input');
  const addMusicBtn = document.getElementById('btn-mobile-add-music');
  const quickMenu = document.getElementById('mobile-quick-menu');
  const quickTrigger = document.getElementById('btn-top-experiences');
  const player = document.getElementById('player-card');
  const nowPlaying = document.getElementById('mobile-nowplaying-bar');

  /* (+) reutiliza exactamente el selector de archivos existente. */
  if (addMusicBtn && fileInputEl) {
    addMusicBtn.addEventListener('click', event => {
      if (!isMobileMode()) return;
      event.preventDefault();
      event.stopPropagation();
      try { if (typeof playSFX === 'function') playSFX('click'); } catch (_) {}
      fileInputEl.click();
    });
  }

  /* Los accesos rápidos se muestran dentro del único menú de tres puntos en móvil. */
  if (quickMenu) {
    quickMenu.addEventListener('click', event => {
      const button = event.target.closest('[data-mobile-quick]');
      if (!button || !isMobileMode()) return;
      event.preventDefault();
      event.stopPropagation();

      const action = button.dataset.mobileQuick;
      quickMenu.classList.remove('active');
      const experiences = document.getElementById('top-experiences-menu');
      const experiencesTrigger = document.getElementById('btn-top-experiences');
      experiences?.classList.add('hidden');
      experiencesTrigger?.setAttribute('aria-expanded', 'false');
      quickTrigger?.setAttribute('aria-expanded', 'false');
      try { if (typeof playSFX === 'function') playSFX('click'); } catch (_) {}

      const target = {
        eq: document.getElementById('btn-eq-toggle'),
        lyrics: document.getElementById('btn-lyrics-toggle'),
        vm: document.getElementById('btn-vm-toggle'),
        cinema: document.getElementById('btn-cinema-mode'),
        shuffle: document.getElementById('shuffle'),
        loop: document.getElementById('loop')
      }[action];
      if (target) target.click();
    });
  }

  document.addEventListener('click', event => {
    if (!quickMenu || !quickMenu.classList.contains('active')) return;
    if (quickMenu.contains(event.target) || quickTrigger?.contains(event.target)) return;
    quickMenu.classList.remove('active');
    quickTrigger?.setAttribute('aria-expanded', 'false');
  }, true);

  /* Accesos inferiores del reproductor expandido. */
  const mobilePlayerEq = document.getElementById('mobile-player-eq');
  const mobilePlayerLyrics = document.getElementById('mobile-player-lyrics');
  const mobilePlayerVm = document.getElementById('mobile-player-vm');

  const clickExisting = id => {
    const target = document.getElementById(id);
    if (target) target.click();
  };

  mobilePlayerEq?.addEventListener('click', () => {
    if (!isMobileMode()) return;
    clickExisting('btn-eq-toggle');
  });

  mobilePlayerLyrics?.addEventListener('click', () => {
    if (!isMobileMode()) return;
    clickExisting('btn-lyrics-toggle');
  });

  mobilePlayerVm?.addEventListener('click', () => {
    if (!isMobileMode()) return;
    clickExisting('btn-vm-toggle');
  });

  /* ---------------------------------------------------------
     OCULTAR / RESTAURAR UI EN MODO CINE Y ENFOQUE
     --------------------------------------------------------- */
  const cinema = document.getElementById('cinema-mode');
  const focusButton = document.getElementById('btn-focus-mode');

  const syncVisualHide = () => {
    const body = document.body;
    if (!isMobileMode()) {
      // No escribir la clase si ya está limpia. Esto evita generar una cadena
      // innecesaria de MutationObserver -> syncVisualHide -> MutationObserver.
      if (body.classList.contains('mobile-ui-hidden')) {
        body.classList.remove('mobile-ui-hidden');
      }
      return;
    }
    const hiddenByFocus = body.classList.contains('focus-mode');
    const hiddenByCinema = !!cinema?.classList.contains('active');
    const shouldHide = hiddenByFocus || hiddenByCinema;
    const isHidden = body.classList.contains('mobile-ui-hidden');

    // Solo mutar cuando el estado realmente cambió.
    if (shouldHide !== isHidden) {
      body.classList.toggle('mobile-ui-hidden', shouldHide);
    }
  };

  focusButton?.addEventListener('click', () => {
    window.setTimeout(syncVisualHide, 0);
  }, true);

  document.getElementById('btn-close-cinema')?.addEventListener('click', () => {
    window.setTimeout(syncVisualHide, 0);
  }, true);

  const visualObserver = new MutationObserver(syncVisualHide);
  visualObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  if (cinema) visualObserver.observe(cinema, { attributes: true, attributeFilter: ['class'] });

  document.addEventListener('click', event => {
    if (!isMobileMode() || !document.body.classList.contains('mobile-ui-hidden')) return;
    const clickedControl = event.target.closest('button, input, select, textarea, a, .cinema-controls, .lyrics-panel, .mobile-player-actions');
    if (!clickedControl) {
      document.body.classList.remove('mobile-ui-hidden');
    }
  }, true);

  /* ---------------------------------------------------------
     10 BANDAS EQ MÓVILES — cada deslizador controla la banda real correspondiente.
     Se conserva el motor desktop y se comparte el mismo estado de los filtros.
     --------------------------------------------------------- */
  const mobileEqMap = [
    ['mobile-eq-32', 0], ['mobile-eq-64', 1], ['mobile-eq-125', 2], ['mobile-eq-250', 3],
    ['mobile-eq-500', 4], ['mobile-eq-1k', 5], ['mobile-eq-2k', 6], ['mobile-eq-4k', 7],
    ['mobile-eq-8k', 8], ['mobile-eq-16k', 9]
  ];

  const getDesktopEqSliders = () =>
    Array.from(document.querySelectorAll('.eq-band-range'));

  const updateMobileEqOutput = (id, value) => {
    const output = document.getElementById(id + '-value');
    if (output) output.textContent = `${Number(value).toFixed(1).replace('.0','')} dB`;
    const input = document.getElementById(id);
    const band = input?.closest('.mobile-eq-band');
    if (band) {
      const numeric = Math.max(-12, Math.min(12, Number(value) || 0));
      const fillHeight = Math.round(Math.abs(numeric) / 12 * 54);
      const fillTop = numeric > 0 ? 74 - fillHeight : 74;
      band.style.setProperty('--eq-fill-top', `${fillTop}px`);
      band.style.setProperty('--eq-fill-height', `${fillHeight}px`);
      band.classList.toggle('is-neutral', Math.abs(numeric) < 0.01);
      band.setAttribute('data-eq-value', numeric.toFixed(1));
    }
  };

  const syncMobileEqFromDesktop = () => {
    const desktop = getDesktopEqSliders();
    mobileEqMap.forEach(([id, index]) => {
      const input = document.getElementById(id);
      const source = desktop[index];
      if (input && source) {
        input.value = source.value;
        updateMobileEqOutput(id, source.value);
      }
    });
  };

  mobileEqMap.forEach(([id, desktopIndex]) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('input', () => {
      if (!isMobileMode()) return;
      const value = Number(input.value);
      const desktop = getDesktopEqSliders();
      const source = desktop[desktopIndex];
      initAudioContext();
      if (source) source.value = String(value);
      if (typeof eqFilters !== 'undefined' && eqFilters[desktopIndex]) {
        eqFilters[desktopIndex].gain.value = value;
      }
      updateMobileEqOutput(id, value);
      document.querySelectorAll('.mobile-eq-preset').forEach(btn => btn.classList.toggle('active', btn.dataset.mobileEqPreset === 'custom'));
      saveAudioSettings();
    });
  });

  document.querySelectorAll('.eq-band-range').forEach(slider => {
    slider.addEventListener('input', () => {
      if (isMobileMode()) syncMobileEqFromDesktop();
    }, { passive: true });
  });

  syncMobileEqFromDesktop();

  /* Presets móviles: actualizan los filtros globales reales. */
  const mobileEqPresets = {
    normal:   [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    classic:  [0, -1, -1, 1, 1.5, 1, 0, -0.5, -1, -1],
    dance:    [5, 6, 3.5, 2, 0, 1, 2.5, 3.5, 4.5, 5]
  };

  document.querySelectorAll('.mobile-eq-preset').forEach(button => {
    button.addEventListener('click', () => {
      if (!isMobileMode()) return;
      const preset = button.dataset.mobileEqPreset;
      document.querySelectorAll('.mobile-eq-preset').forEach(btn => btn.classList.toggle('active', btn === button));
      if (preset === 'custom') return;

      initAudioContext();
      const values = mobileEqPresets[preset];
      if (!values) return;
      const desktop = getDesktopEqSliders();
      desktop.forEach((slider, index) => {
        const value = values[index] ?? 0;
        slider.value = String(value);
        if (typeof eqFilters !== 'undefined' && eqFilters[index]) eqFilters[index].gain.value = value;
      });
      syncMobileEqFromDesktop();
      saveAudioSettings();
    });
  });

  /* ---------------------------------------------------------
     BALANCE L/R — un solo estado compartido.
     --------------------------------------------------------- */
  const mobileBalance = document.getElementById('mobile-eq-balance');
  const mobileBalanceValue = document.getElementById('mobile-eq-balance-value');
  const desktopBalance = document.getElementById('input-audio-balance');
  let balanceSyncing = false;

  const setSharedBalance = value => {
    if (balanceSyncing) return;
    const safe = Math.max(-1, Math.min(1, Number(value) || 0));
    balanceSyncing = true;
    if (desktopBalance) desktopBalance.value = String(safe);
    if (mobileBalance) mobileBalance.value = String(safe);
    if (mobileBalanceValue) mobileBalanceValue.textContent = safe === 0 ? '0' : safe.toFixed(2);

    initAudioContext();
    try {
      if (typeof pannerNode !== 'undefined' && pannerNode) {
        if (pannerNode.context && pannerNode.context.state === 'suspended') pannerNode.context.resume().catch(() => {});
        pannerNode.pan.setValueAtTime(safe, pannerNode.context.currentTime);
      }
    } catch (_) {}

    saveAudioSettings();
    balanceSyncing = false;
  };

  desktopBalance?.addEventListener('input', () => {
    const value = Number(desktopBalance.value) || 0;
    if (mobileBalanceValue) mobileBalanceValue.textContent = value === 0 ? '0' : value.toFixed(2);
    if (mobileBalance && !balanceSyncing) mobileBalance.value = String(value);
    try {
      initAudioContext();
      if (typeof pannerNode !== 'undefined' && pannerNode && (!toggle8dAudio || !toggle8dAudio.checked)) {
        pannerNode.pan.setValueAtTime(value, pannerNode.context.currentTime);
      }
    } catch (_) {}
  });

  mobileBalance?.addEventListener('input', () => setSharedBalance(mobileBalance.value));
  syncMobileEqFromDesktop();
  if (desktopBalance) setSharedBalance(desktopBalance.value);

  /* ---------------------------------------------------------
     REVERB MÓVIL — añade un send/return ligero sin crear otra
     fuente de MediaElement. Solo se conecta al pipeline cuando
     el usuario selecciona una opción.
     --------------------------------------------------------- */
  let mobileReverbConvolver = null;
  let mobileReverbGain = null;
  let mobileReverbCurrent = 'none';

  const createImpulseResponse = (context, seconds, decay) => {
    const length = Math.max(1, Math.floor(context.sampleRate * seconds));
    const impulse = context.createBuffer(2, length, context.sampleRate);
    for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return impulse;
  };

  const ensureMobileReverb = () => {
    initAudioContext();
    if (!mobileReverbConvolver && typeof audioCtx !== 'undefined' && audioCtx && typeof limiterNode !== 'undefined' && limiterNode) {
      mobileReverbConvolver = audioCtx.createConvolver();
      mobileReverbGain = audioCtx.createGain();
      mobileReverbGain.gain.value = 0;
      mobileReverbConvolver.buffer = createImpulseResponse(audioCtx, 2.1, 2.8);
      limiterNode.connect(mobileReverbConvolver);
      mobileReverbConvolver.connect(mobileReverbGain);
      mobileReverbGain.connect(stereoBypassGain);
    }
    return !!mobileReverbConvolver;
  };

  const applyMobileReverb = value => {
    if (!isMobileMode()) return;
    mobileReverbCurrent = value;
    if (value === 'none') {
      if (mobileReverbGain) mobileReverbGain.gain.value = 0;
      saveAudioSettings();
      return;
    }

    if (!ensureMobileReverb()) return;
    const settings = {
      small: { gain: 0.12, seconds: 0.75, decay: 3.9 },
      room: { gain: 0.18, seconds: 1.25, decay: 3.0 },
      hall: { gain: 0.24, seconds: 1.9, decay: 2.2 }
    }[value] || { gain: 0, seconds: 1, decay: 3 };

    mobileReverbConvolver.buffer = createImpulseResponse(audioCtx, settings.seconds, settings.decay);
    mobileReverbGain.gain.setValueAtTime(settings.gain, audioCtx.currentTime);
    saveAudioSettings();
  };

  document.getElementById('mobile-eq-reverb')?.addEventListener('change', event => {
    applyMobileReverb(event.target.value);
  });

  /* ---------------------------------------------------------
     CIERRE LIMPIO DE AJUSTES EN MÓVIL
     --------------------------------------------------------- */
  const mobileSettingsButton = document.querySelector('#mobile-tab-bar [data-tab="ajustes"]');
  const settingsClose = document.getElementById('btn-close-settings');
  const modalSettingsEl = document.getElementById('modal-settings');

  const forceCloseSettings = () => {
    if (!modalSettingsEl) return;
    modalSettingsEl.classList.remove('active');
    modalSettingsEl.style.display = 'none';
    modalSettingsEl.setAttribute('aria-hidden', 'true');
  };

  settingsClose?.addEventListener('click', forceCloseSettings, true);

  modalSettingsEl?.addEventListener('click', event => {
    if (event.target === modalSettingsEl) forceCloseSettings();
  }, true);

  mobileSettingsButton?.addEventListener('click', () => {
    window.setTimeout(() => {
      if (modalSettingsEl) {
        modalSettingsEl.style.display = 'flex';
        modalSettingsEl.classList.add('active');
      }
    }, 0);
  }, true);

  /* ---------------------------------------------------------
     EXPANSIÓN DEL REPRODUCTOR: toque en la barra compacta.
     --------------------------------------------------------- */
  if (nowPlaying && player) {
    nowPlaying.addEventListener('click', event => {
      if (!isMobileMode()) return;
      if (event.target.closest('#mobile-np-play')) return;
      player.classList.add('mobile-expanded');
      document.body.classList.add('mobile-player-expanded');
    }, true);
  }

  /* La inicialización ya se realiza una sola vez junto al listener principal.
     No volver a ejecutar applyMobileLayoutState aquí: duplicarlo provoca dos
     ciclos de mutación/layout al cargar la interfaz. */
})();


/* =========================================================
   GLASSTRACK PRO V5 — FIXES PC SIN TOCAR LA UI MÓVIL
   ========================================================= */
(() => {
  'use strict';

  const pcTrigger = document.getElementById('btn-pc-secondary-menu');
  const experiencesMenu = document.getElementById('top-experiences-menu');
  const focusButton = document.getElementById('btn-focus-mode');
  const desktopPlayer = document.getElementById('player-card');
  const desktopVehicle = document.getElementById('vehicle-mode');
  const desktopCinema = document.getElementById('cinema-mode');
  const desktopSettings = document.getElementById('modal-settings');

  const isMobileUI = () =>
    document.body.classList.contains('mobile-layout') ||
    document.body.classList.contains('mobile-mode');

  /* ---------------------------------------------------------
     1. PC — NUEVO BOTÓN DE OPCIONES SECUNDARIAS
     Usa el mismo menú que antes pertenecía a Modo Vista.
     En móvil esta lógica no interviene.
     --------------------------------------------------------- */
  const positionDesktopExperiencesMenu = () => {
    if (isMobileUI() || !pcTrigger || !experiencesMenu || experiencesMenu.classList.contains('hidden')) return;

    const rect = pcTrigger.getBoundingClientRect();
    const width = Math.min(340, Math.max(280, experiencesMenu.offsetWidth || 320));
    const height = experiencesMenu.offsetHeight || 210;
    const gap = 8;
    const padding = 10;

    let left = rect.right - width;
    let top = rect.bottom + gap;

    left = Math.min(
      Math.max(left, padding),
      Math.max(padding, window.innerWidth - width - padding)
    );

    if (top + height > window.innerHeight - padding) {
      top = rect.top - height - gap;
    }

    top = Math.min(
      Math.max(top, padding),
      Math.max(padding, window.innerHeight - height - padding)
    );

    experiencesMenu.style.left = `${left}px`;
    experiencesMenu.style.top = `${top}px`;
  };

  const closeDesktopExperiencesMenu = () => {
    if (!experiencesMenu) return;
    experiencesMenu.classList.add('hidden');
    pcTrigger?.setAttribute('aria-expanded', 'false');
  };

  const openDesktopExperiencesMenu = event => {
    if (isMobileUI() || !pcTrigger || !experiencesMenu) return;
    event?.preventDefault();
    event?.stopPropagation();
    experiencesMenu.classList.remove('hidden');
    pcTrigger.setAttribute('aria-expanded', 'true');
    positionDesktopExperiencesMenu();
  };

  pcTrigger?.addEventListener('click', event => {
    if (isMobileUI()) return;
    try { if (typeof playSFX === 'function') playSFX('click'); } catch (_) {}
    if (experiencesMenu?.classList.contains('hidden')) {
      openDesktopExperiencesMenu(event);
    } else {
      closeDesktopExperiencesMenu();
    }
  });

  window.addEventListener('resize', positionDesktopExperiencesMenu, { passive: true });
  window.addEventListener('scroll', positionDesktopExperiencesMenu, { passive: true });

  /* ---------------------------------------------------------
     2. PC — MODO ENFOQUE
     El botón utiliza una única implementación global para evitar
     listeners duplicados y estados de foco contradictorios.
     --------------------------------------------------------- */
  /* Evita que el arrastre del foco de escritorio se quede vivo después de
     perder el foco de la ventana. */
  window.addEventListener('blur', () => {
    if (!isMobileUI()) window.__glasstrackFocusDragging = false;
  });

  /* ---------------------------------------------------------
     3. MODOS DE PANTALLA PC — CIERRE CONSISTENTE
     --------------------------------------------------------- */
  const closeVehicleSafe = () => {
    if (!desktopVehicle) return;
    desktopVehicle.classList.remove('active');
    desktopVehicle.setAttribute('aria-hidden', 'true');
  };

  const closeCinemaSafe = () => {
    if (!desktopCinema) return;
    desktopCinema.classList.remove('active');
    desktopCinema.classList.remove('karaoke-layout');
    desktopCinema.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modo-cine-active');
  };

  document.addEventListener('keydown', event => {
    if (isMobileUI() || event.key !== 'Escape') return;

    const vehicleActive = desktopVehicle?.classList.contains('active');
    const cinemaActive = desktopCinema?.classList.contains('active');
    const settingsActive = desktopSettings?.classList.contains('active');
    const menuActive = experiencesMenu && !experiencesMenu.classList.contains('hidden');

    if (vehicleActive) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeVehicleSafe();
      try { if (typeof playSFX === 'function') playSFX('close'); } catch (_) {}
      return;
    }

    if (cinemaActive) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeCinemaSafe();
      try { if (typeof playSFX === 'function') playSFX('close'); } catch (_) {}
      return;
    }

    if (settingsActive) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (typeof closeModalSettings === 'function') closeModalSettings();
      return;
    }

    if (menuActive) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeDesktopExperiencesMenu();
      return;
    }
  }, true);

  /* Cerrar un modo de pantalla si el usuario vuelve a abrir el mismo modo.
     No modifica el comportamiento móvil. */
  document.getElementById('btn-vehicle-mode')?.addEventListener('click', () => {
    if (isMobileUI()) return;
    if (desktopVehicle) {
      desktopVehicle.setAttribute('aria-hidden', 'false');
    }
  }, true);

  document.getElementById('btn-cinema-mode')?.addEventListener('click', () => {
    if (isMobileUI()) return;
    if (desktopCinema) {
      desktopCinema.setAttribute('aria-hidden', 'false');
    }
  }, true);

})();


/* =========================================================
   B8 CLEAN MOBILE LYRICS — control independiente
   No intercepta #mobile-player-lyrics ni #btn-lyrics-toggle.
   ========================================================= */
(() => {
  const toggle = document.getElementById('mobile-inline-lyrics-toggle');
  const panel = document.getElementById('mobile-inline-lyrics');
  if (!toggle || !panel) return;

  const isMobileUi = () => document.body.classList.contains('mobile-layout') || document.body.classList.contains('mobile-mode');

  function syncMobileInlineLyrics() {
    if (!isMobileUi() || !panel.classList.contains('is-visible')) return;
    const source = document.getElementById('lyrics-body');
    const active = source?.querySelector('.lyrics-line.active');
    if (active) {
      panel.innerHTML = active.outerHTML;
      panel.setAttribute('aria-hidden', 'false');
      return;
    }
    panel.textContent = 'Sin letra disponible.';
  }

  const sourceLyrics = document.getElementById('lyrics-body');
  let lyricsSyncRaf = 0;
  const queueLyricsSync = () => {
    if (!isMobileUi() || !panel.classList.contains('is-visible')) return;
    if (lyricsSyncRaf) return;
    lyricsSyncRaf = window.requestAnimationFrame(() => {
      lyricsSyncRaf = 0;
      syncMobileInlineLyrics();
    });
  };

  // El reproductor puede cambiar la línea activa después de timeupdate.
  // Observamos esos cambios para que la letra pequeña siga automáticamente
  // la canción, sin obligar al usuario a cerrar y volver a abrir el botón.
  const lyricsObserver = sourceLyrics ? new MutationObserver(queueLyricsSync) : null;
  lyricsObserver?.observe(sourceLyrics, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'data-active']
  });

  toggle.addEventListener('click', (event) => {
    if (!isMobileUi()) return;
    event.preventDefault();
    event.stopPropagation();
    const visible = panel.classList.toggle('is-visible');
    toggle.setAttribute('aria-expanded', String(visible));
    panel.setAttribute('aria-hidden', String(!visible));
    if (visible) syncMobileInlineLyrics();
  });

  // Reutiliza el mismo reloj de audio de la aplicación; no crea intervalos nuevos.
  const audioNodes = [document.getElementById('audio1'), document.getElementById('audio2')].filter(Boolean);
  audioNodes.forEach(audio => {
    audio.addEventListener('timeupdate', queueLyricsSync, { passive: true });
  });

  window.addEventListener('resize', queueLyricsSync, { passive: true });
})();


// =========================================================
// GLASSTRACK PRO — VISUAL OVERLAY STUDIO
// Editor independiente para recrear layouts tipo edit/TikTok.
// No toca la interfaz normal del reproductor.
// =========================================================
(() => {
  'use strict';

  const $v = (id) => document.getElementById(id);
  const root = $v('visual-editor');
  const openItem = $v('top-mode-visual-editor');
  if (!root || !openItem) return;

  const preview = $v('visual-editor-preview');
  const stickersLayer = $v('visual-editor-stickers');
  const stickerList = $v('visual-editor-sticker-list');
  const bg = $v('visual-editor-bg');
  const bgImage = $v('visual-editor-bg-media-image');
  const bgVideo = $v('visual-editor-bg-media-video');
  const dark = $v('visual-editor-dark');
  const watermark = $v('visual-editor-watermark');
  const watermarkPreview = $v('visual-editor-watermark-preview');
  const font = $v('visual-editor-watermark-font');
  const color = $v('visual-editor-watermark-color');
  const spectrum = $v('visual-editor-spectrum');
  const frame = $v('visual-editor-frame');
  const frameToggle = $v('visual-editor-frame-toggle');
  const visualizerToggle = $v('visual-editor-visualizer');
  const vizRange = $v('visual-editor-viz');
  const bgDark = $v('visual-editor-bg-dark');
  const bgBlur = $v('visual-editor-bg-blur');

  const DB_NAME = 'glasstrack_visual_editor_v1';
  const STORE = 'state';
  const STATE_KEY = 'scene';
  let db = null;
  let state = {
    stickers: [], watermark: 'Glasstrack Pro', watermarkFont: 'Inter', watermarkColor: '#ffffff',
    bgType: '', bgData: '', bgDark: 25, bgBlur: 0, visualizer: true, frame: true, viz: 70
  };
  let selectedId = null;
  let drag = null;
  let vizRaf = 0;
  let analyserData = null;

  const uid = () => 'st_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const clamp = (n, a, b) => Math.min(Math.max(n, a), b);
  const fileToDataURL = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });

  function openDB() {
    return new Promise((resolve) => {
      if (!('indexedDB' in window)) return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => resolve(null);
    });
  }
  function dbGet() {
    return new Promise((resolve) => {
      if (!db) return resolve(null);
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(STATE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }
  function dbPut(value) {
    return new Promise((resolve) => {
      if (!db) return resolve(false);
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, STATE_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  async function saveState() {
    await dbPut(state);
    try { localStorage.setItem('glasstrack_visual_editor_meta', JSON.stringify({
      watermark: state.watermark, watermarkFont: state.watermarkFont, watermarkColor: state.watermarkColor,
      bgDark: state.bgDark, bgBlur: state.bgBlur, visualizer: state.visualizer, frame: state.frame, viz: state.viz
    })); } catch (_) {}
  }

  function applySettingsUI() {
    watermark.value = state.watermark;
    font.value = state.watermarkFont;
    color.value = state.watermarkColor;
    bgDark.value = state.bgDark;
    bgBlur.value = state.bgBlur;
    visualizerToggle.checked = !!state.visualizer;
    frame.style.display = state.frame ? '' : 'none';
    if (frameToggle) frameToggle.checked = !!state.frame;
    vizRange.value = state.viz;
    $v('visual-editor-bg-dark-value').textContent = `${state.bgDark}%`;
    $v('visual-editor-bg-blur-value').textContent = `${state.bgBlur}px`;
    $v('visual-editor-viz-value').textContent = `${state.viz}%`;
    updateWatermark();
  }

  function updateWatermark() {
    watermarkPreview.textContent = state.watermark || '';
    watermarkPreview.style.fontFamily = `'${state.watermarkFont}', Inter, sans-serif`;
    watermarkPreview.style.color = state.watermarkColor;
  }

  function applyBackground() {
    bg.style.filter = `blur(${state.bgBlur}px)`;
    bg.style.transform = state.bgBlur ? `scale(${1 + state.bgBlur / 80})` : '';
    dark.style.opacity = String(state.bgDark / 100);
    bgImage.style.display = 'none';
    bgVideo.style.display = 'none';
    if (!state.bgData) {
      bg.style.backgroundImage = '';
      bg.style.backgroundColor = '#0a0b0f';
      return;
    }
    if (state.bgType === 'video') {
      bgVideo.src = state.bgData;
      bgVideo.style.display = 'block';
      bgVideo.play().catch(() => {});
    } else {
      bg.style.backgroundImage = `url(${state.bgData})`;
      bg.style.backgroundColor = '#0a0b0f';
      if (state.bgType === 'image') {
        bgImage.src = state.bgData;
        bgImage.style.display = 'block';
        bgImage.style.filter = `blur(${state.bgBlur}px)`;
        bgImage.style.transform = state.bgBlur ? `scale(${1 + state.bgBlur / 80})` : '';
      }
    }
  }

  function renderStickerList() {
    stickerList.innerHTML = '';
    state.stickers.forEach((s, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'visual-editor-sticker-item' + (selectedId === s.id ? ' active' : '');
      item.innerHTML = `<img src="${s.src}" alt=""><span>${s.name || `Sticker ${i + 1}`}</span>`;
      item.addEventListener('click', () => { selectedId = s.id; renderStickers(); renderStickerList(); });
      stickerList.appendChild(item);
    });
  }

  function renderStickers() {
    stickersLayer.innerHTML = '';
    state.stickers.forEach((s) => {
      const el = document.createElement('div');
      el.className = 'visual-editor-sticker' + (selectedId === s.id ? ' selected' : '');
      el.dataset.id = s.id;
      el.style.left = `${s.x}%`;
      el.style.top = `${s.y}%`;
      el.style.width = `${s.width}px`;
      el.style.transform = `translate(-50%,-50%) rotate(${s.rotation || 0}deg)`;
      const img = document.createElement('img');
      img.src = s.src; img.alt = s.name || 'Sticker'; img.draggable = false;
      img.style.width = '100%'; img.style.height = 'auto'; img.style.display = 'block';
      const handle = document.createElement('span');
      handle.className = 'visual-editor-resize';
      el.append(img, handle);
      stickersLayer.appendChild(el);
      bindSticker(el, s, handle);
    });
  }

  function pointFromEvent(e) {
    const r = preview.getBoundingClientRect();
    const p = e.touches?.[0] || e;
    return { x: p.clientX - r.left, y: p.clientY - r.top, w: r.width, h: r.height };
  }

  function bindSticker(el, s, handle) {
    const startDrag = (e) => {
      if (e.target === handle) return;
      e.preventDefault(); e.stopPropagation();
      selectedId = s.id; renderStickerList();
      const p = pointFromEvent(e);
      drag = { type: 'move', id: s.id, el, dx: p.x - (s.x / 100) * p.w, dy: p.y - (s.y / 100) * p.h };
    };
    const startResize = (e) => {
      e.preventDefault(); e.stopPropagation();
      selectedId = s.id;
      const p = pointFromEvent(e);
      drag = { type: 'resize', id: s.id, el, startX: p.x, startY: p.y, startW: s.width };
    };
    el.addEventListener('pointerdown', startDrag, { passive: false });
    handle.addEventListener('pointerdown', startResize, { passive: false });
  }

  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const s = state.stickers.find(x => x.id === drag.id);
    if (!s) return;
    const p = pointFromEvent(e);
    if (drag.type === 'move') {
      s.x = clamp(((p.x - drag.dx) / p.w) * 100, 4, 96);
      s.y = clamp(((p.y - drag.dy) / p.h) * 100, 4, 96);
      if (drag.el) {
        drag.el.style.left = `${s.x}%`;
        drag.el.style.top = `${s.y}%`;
      }
    } else {
      s.width = clamp(drag.startW + (p.x - drag.startX) * 1.2, 40, Math.min(720, preview.clientWidth * 1.5));
      if (drag.el) drag.el.style.width = `${s.width}px`;
    }
  }, { passive: false });
  window.addEventListener('pointerup', () => {
    if (drag) { drag = null; saveState(); }
  }, { passive: true });

  async function addFiles(files) {
    for (const file of Array.from(files || [])) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const src = await fileToDataURL(file);
        state.stickers.push({ id: uid(), name: file.name.replace(/\.[^.]+$/, ''), src, x: 50, y: 52, width: 180, rotation: 0 });
      } catch (_) {}
    }
    selectedId = state.stickers.at(-1)?.id || selectedId;
    renderStickers(); renderStickerList(); await saveState();
  }

  function resizeSpectrum() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = spectrum.getBoundingClientRect();
    spectrum.width = Math.max(1, Math.floor(r.width * dpr));
    spectrum.height = Math.max(1, Math.floor(r.height * dpr));
  }

  function drawSpectrum() {
    if (!root.classList.contains('is-open')) { vizRaf = 0; return; }
    const ctx = spectrum.getContext('2d');
    if (!ctx) return;
    const w = spectrum.width, h = spectrum.height;
    ctx.clearRect(0,0,w,h);
    if (!state.visualizer) { vizRaf = requestAnimationFrame(drawSpectrum); return; }
    const analyser = window.concludorAnalyser;
    if (!analyser) {
      ctx.globalAlpha = .18; ctx.fillStyle = '#fff';
      for (let i=0;i<28;i++) { const bh=(Math.sin(Date.now()/260+i*.7)+1)*.12*h; ctx.fillRect(i*w/28,h-bh,w/28-2,bh); }
    } else {
      if (!analyserData || analyserData.length !== analyser.frequencyBinCount) analyserData = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(analyserData);
      const bars = Math.min(48, analyserData.length);
      const bw = w / bars;
      ctx.fillStyle = `rgba(255,255,255,${Math.max(.1, state.viz/100)})`;
      for (let i=0;i<bars;i++) {
        const v = analyserData[i] / 255;
        const bh = Math.max(2, v * h * .9);
        ctx.fillRect(i*bw, h-bh, Math.max(1,bw-2), bh);
      }
    }
    vizRaf = requestAnimationFrame(drawSpectrum);
  }

  async function loadState() {
    try {
      await openDB();
      const saved = await dbGet();
      if (saved && typeof saved === 'object') {
        state = { ...state, ...saved };
        if (!Array.isArray(state.stickers)) state.stickers = [];
        state.bgDark = clamp(Number(state.bgDark) || 0, 0, 80);
        state.bgBlur = clamp(Number(state.bgBlur) || 0, 0, 18);
        state.viz = clamp(Number(state.viz) || 70, 10, 100);
        state.visualizer = state.visualizer !== false;
        state.frame = state.frame !== false;
      }
    } catch (error) {
      console.warn('[Glasstrack] No se pudo cargar el diseño del Editor Visual:', error);
    }
    applySettingsUI(); applyBackground(); renderStickers(); renderStickerList();
  }

  function open() {
    root.classList.add('is-open'); root.setAttribute('aria-hidden','false');
    document.body.classList.add('visual-editor-open');
    resizeSpectrum();
    cancelAnimationFrame(vizRaf); vizRaf = requestAnimationFrame(drawSpectrum);
    loadState();
  }
  function close() {
    root.classList.remove('is-open'); root.setAttribute('aria-hidden','true');
    document.body.classList.remove('visual-editor-open');
    cancelAnimationFrame(vizRaf); vizRaf = 0;
    bgVideo.pause();
  }

  openItem.addEventListener('click', () => { closeTopMenu(); open(); try{playSFX('open')}catch(_){} });
  $v('visual-editor-close')?.addEventListener('click', () => { close(); try{playSFX('close')}catch(_){} });
  $v('visual-editor-save')?.addEventListener('click', async () => { await saveState(); try{playSFX('click')}catch(_){}; if (typeof showToast==='function') showToast('Diseño visual guardado.'); });
  $v('visual-editor-reset')?.addEventListener('click', async () => {
    state = { stickers: [], watermark: 'Glasstrack Pro', watermarkFont: 'Inter', watermarkColor: '#ffffff', bgType: '', bgData: '', bgDark: 25, bgBlur: 0, visualizer: true, frame: true, viz: 70 };
    selectedId = null; bgVideo.removeAttribute('src'); bgImage.removeAttribute('src');
    applySettingsUI(); applyBackground(); renderStickers(); renderStickerList(); await saveState();
  });
  $v('visual-editor-delete-selected')?.addEventListener('click', async () => {
    if (!selectedId) return;
    state.stickers = state.stickers.filter(s => s.id !== selectedId); selectedId = null;
    renderStickers(); renderStickerList(); await saveState();
  });
  $v('visual-editor-sticker-file')?.addEventListener('change', e => addFiles(e.target.files));
  $v('visual-editor-bg-image')?.addEventListener('change', async e => { const f=e.target.files?.[0]; if(!f)return; state.bgType='image';state.bgData=await fileToDataURL(f);applyBackground();await saveState(); });
  $v('visual-editor-bg-video')?.addEventListener('change', async e => { const f=e.target.files?.[0]; if(!f)return; state.bgType='video';state.bgData=await fileToDataURL(f);applyBackground();await saveState(); });
  $v('visual-editor-bg-clear')?.addEventListener('click', async () => { state.bgType='';state.bgData='';applyBackground();await saveState(); });
  watermark?.addEventListener('input', () => { state.watermark=watermark.value; updateWatermark(); saveState(); });
  font?.addEventListener('change', () => { state.watermarkFont=font.value; updateWatermark(); saveState(); });
  color?.addEventListener('input', () => { state.watermarkColor=color.value; updateWatermark(); saveState(); });
  bgDark?.addEventListener('input', () => { state.bgDark=Number(bgDark.value); dark.style.opacity=state.bgDark/100; $v('visual-editor-bg-dark-value').textContent=`${state.bgDark}%`; saveState(); });
  bgBlur?.addEventListener('input', () => { state.bgBlur=Number(bgBlur.value); applyBackground(); $v('visual-editor-bg-blur-value').textContent=`${state.bgBlur}px`; saveState(); });
  visualizerToggle?.addEventListener('change', () => { state.visualizer=visualizerToggle.checked; saveState(); });
  frameToggle?.addEventListener('change', () => { state.frame = frameToggle.checked; applySettingsUI(); saveState(); });
  $v('visual-editor-viz')?.addEventListener('input', () => { state.viz=Number(vizRange.value); $v('visual-editor-viz-value').textContent=`${state.viz}%`; saveState(); });
  preview.addEventListener('dragover', e => e.preventDefault());
  preview.addEventListener('drop', async e => { e.preventDefault(); await addFiles(Array.from(e.dataTransfer.files).filter(f=>f.type.startsWith('image/'))); });
  document.addEventListener('keydown', e => { if (e.key==='Escape' && root.classList.contains('is-open')) close(); if ((e.key==='Delete'||e.key==='Backspace') && root.classList.contains('is-open') && selectedId && !/input|textarea|select/i.test(e.target.tagName)) $v('visual-editor-delete-selected')?.click(); });
  window.addEventListener('resize', resizeSpectrum, { passive:true });

  function closeTopMenu() {
    const m=$v('top-experiences-menu'), t=$v('btn-top-experiences');
    if(m){m.classList.add('hidden');t?.setAttribute('aria-expanded','false');}
  }
  loadState();
})();


// =========================================================
// GLASSTRACK PRO — MODO VISUAL V29
// Reproductor visual tipo edit/HUD basado en la reproducción real.
// V25: personalización persistente de partículas, ondas, aro, halo, beat,
// parallax y contraste, con efectos aplicables en vivo desde Ajustes.
// =========================================================
(() => {
  'use strict';

  const root = document.getElementById('visual-mode');
  if (!root) return;

  const $ = (id) => document.getElementById(id);
  const coverEl = $('visual-mode-cover');
  const coverSide = root.querySelector('.visual-mode-cover-side');
  const titleEl = $('visual-mode-title');
  const artistEl = $('visual-mode-artist');
  const lyricEl = $('visual-mode-lyric');
  const currentEl = $('visual-mode-current');
  const durationEl = $('visual-mode-duration');
  const progressEl = $('visual-mode-progress');
  const wave = $('visual-mode-wave');
  const bottomWaves = $('visual-mode-bottom-waves');
  const particlesEl = $('visual-mode-particles');
  const bgCover = $('visual-mode-bg-cover');
  const bgVideoVisual = $('visual-mode-bg-video');
  const halo = root.querySelector('.visual-mode-cover-halo');
  const closeBtn = $('visual-mode-close');
  const prevBtn = $('visual-mode-prev');
  const playBtn = $('visual-mode-play');
  const nextBtn = $('visual-mode-next');
  const volumeInput = $('visual-mode-volume');
  const volumeValue = $('visual-mode-volume-value');
  const statusTime = $('visual-mode-status-time');
  const stickerEl = $('visual-mode-sticker');
  const yukiRoot = $('visual-mode-yuki');
  const yukiCover = yukiRoot?.querySelector('.visual-yuki-cover');
  const yukiTitle = yukiRoot?.querySelector('.visual-yuki-title');
  const yukiArtist = yukiRoot?.querySelector('.visual-yuki-artist');
  const yukiCurrent = yukiRoot?.querySelector('.visual-yuki-current');
  const yukiDuration = yukiRoot?.querySelector('.visual-yuki-duration');
  const yukiProgress = yukiRoot?.querySelector('.visual-yuki-progress-fill');
  const yukiPlay = yukiRoot?.querySelector('.visual-yuki-play');
  const yukiCurrentTop = yukiRoot?.querySelector('#visual-yuki-top-time');
  const yukiVolumeFill = yukiRoot?.querySelector('.visual-yuki-volume-fill');
  const yukiVolumeValue = yukiRoot?.querySelector('.visual-yuki-volume-value');
  const yukiSpectrum = yukiRoot?.querySelector('.visual-yuki-spectrum');
  const yukiBottomWaves = yukiRoot?.querySelector('.visual-yuki-bottom-waves');
  const yukiHalo = yukiRoot?.querySelector('.visual-yuki-halo');
  const yukiParticles = yukiRoot?.querySelector('.visual-yuki-particles');
  const yukiSticker = yukiRoot?.querySelector('.visual-yuki-sticker');

  const original = {
    play: document.getElementById('play'),
    prev: document.getElementById('prev'),
    next: document.getElementById('next'),
    volume: document.getElementById('volume'),
    cover: document.getElementById('cover'),
    title: document.getElementById('title'),
    artist: document.getElementById('artist'),
    bgVideo: document.getElementById('bg-video'),
    bgImage: document.getElementById('bg-custom-image'),
    audio1: document.getElementById('audio-player-1'),
    audio2: document.getElementById('audio-player-2'),
    lyrics: document.getElementById('lyrics-body')
  };

  let raf = 0;
  let resizeObserver = null;
  let observer = null;
  let lyricsObserver = null;
  let analyserData = null;
  let bottomWavesDpr = 1;
  let paletteSource = '';
  let paletteBusy = false;
  let particleTimer = 0;
  let beatLevel = 0;
  let previousEnergy = 0;
  let beatPulse = 0;
  let wavePhase = 0;
  let yukiWavesDpr = 1;

  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const VISUAL_DEFAULTS = Object.freeze({
    yukiMode: false,
    yukiGeometry: true,
    yukiRingDecor: true,
    yukiSpectrum: true,
    particles: true,
    particleDepth: true,
    particleDensity: 8,
    particleSpeed: 100,
    particleTypes: ['✦', '✧', '◇', '✣', '·', '❀'],
    waves: true,
    waveHeight: 120,
    ring: true,
    ringSpeed: 24,
    halo: true,
    beat: true,
    beatIntensity: 70,
    textFlash: false,
    parallax: false,
    controlsContrast: true,
    stickerEnabled: false,
    stickerPosition: 'progress-top'
  });

  function getVisualSettings() {
    const incoming = window.glasstrackVisualSettings;
    if (!incoming || typeof incoming !== 'object') return VISUAL_DEFAULTS;
    return {
      ...VISUAL_DEFAULTS,
      ...incoming,
      particleTypes: Array.isArray(incoming.particleTypes) && incoming.particleTypes.length
        ? incoming.particleTypes
        : VISUAL_DEFAULTS.particleTypes
    };
  }

  function applyVisualSettings(settings = getVisualSettings()) {
    const current = { ...VISUAL_DEFAULTS, ...settings };
    root.classList.toggle('visual-no-particles', !current.particles);
    root.classList.toggle('visual-no-particle-depth', !current.particleDepth);
    root.classList.toggle('visual-no-waves', !current.waves);
    root.classList.toggle('visual-no-ring', !current.ring);
    root.classList.toggle('visual-no-halo', !current.halo);
    root.classList.toggle('visual-no-beat', !current.beat);
    root.classList.toggle('visual-text-flash-on', !!current.textFlash);
    root.classList.toggle('visual-parallax-on', !!current.parallax);
    root.classList.toggle('visual-controls-contrast', !!current.controlsContrast);
    root.classList.toggle('visual-yuki-on', !!current.yukiMode);
    root.classList.toggle('visual-no-yuki-geometry', !current.yukiGeometry);
    root.classList.toggle('visual-no-yuki-ring-decor', !current.yukiRingDecor);
    root.classList.toggle('visual-no-yuki-spectrum', !current.yukiSpectrum);
    if (yukiRoot) {
      yukiRoot.classList.toggle('is-active', !!current.yukiMode);
      yukiRoot.setAttribute('aria-hidden', current.yukiMode ? 'false' : 'true');
    }
    root.style.setProperty('--visual-ring-duration', `${Math.max(8, Math.min(48, Number(current.ringSpeed) || 24))}s`);
    root.style.setProperty('--visual-wave-height', `${Math.max(70, Math.min(170, Number(current.waveHeight) || 120))}px`);
    root.style.setProperty('--visual-beat-intensity', `${Math.max(0.35, Math.min(1, Number(current.beatIntensity) / 100 || .7))}`);
    root.style.setProperty('--visual-particle-speed', `${Math.max(60, Math.min(160, Number(current.particleSpeed) || 100))}`);
    applyStickerState({ src: window.glasstrackVisualSticker || '', enabled: !!current.stickerEnabled, position: current.stickerPosition || 'progress-top' });
    if (root.classList.contains('is-open')) requestAnimationFrame(updateStickerPosition);
  }

  window.applyGlasstrackVisualSettings = applyVisualSettings;

  function updateStickerPosition() {
    if (!stickerEl || stickerEl.hidden) return;
    const settings = getVisualSettings();
    if (!settings.stickerEnabled || !window.glasstrackVisualSticker) return;

    const position = settings.stickerPosition || 'progress-top';
    stickerEl.style.position = 'fixed';
    stickerEl.style.left = '';
    stickerEl.style.right = '';
    stickerEl.style.top = '';
    stickerEl.style.bottom = '';
    stickerEl.style.transform = 'translate(0,0)';

    if (position === 'progress-top') {
      const progressTrack = root.querySelector('.visual-mode-progress-track');
      const rect = progressTrack?.getBoundingClientRect();
      if (rect && rect.width) {
        const stickerHeight = stickerEl.getBoundingClientRect().height || 80;
        stickerEl.style.left = `${rect.left + rect.width / 2}px`;
        stickerEl.style.top = `${Math.max(12, rect.top - stickerHeight - 12)}px`;
        stickerEl.style.transform = 'translateX(-50%)';
      }
      return;
    }

    const padX = Math.max(14, Math.round(window.innerWidth * .025));
    const padY = Math.max(14, Math.round(window.innerHeight * .025));
    if (position === 'top-left') {
      stickerEl.style.left = `${padX}px`;
      stickerEl.style.top = `${padY + 44}px`;
    } else if (position === 'top-right') {
      stickerEl.style.right = `${padX}px`;
      stickerEl.style.top = `${padY + 44}px`;
    } else if (position === 'bottom-left') {
      stickerEl.style.left = `${padX}px`;
      stickerEl.style.bottom = `${padY + 18}px`;
    } else {
      stickerEl.style.right = `${padX}px`;
      stickerEl.style.bottom = `${padY + 18}px`;
    }
  }

  function updateYukiStickerPosition() {
    if (!yukiSticker) return;
    const settings = getVisualSettings();
    if (!settings.stickerEnabled || !window.glasstrackVisualSticker || !settings.yukiMode) {
      yukiSticker.hidden = true;
      return;
    }
    yukiSticker.hidden = false;
    yukiSticker.style.position = 'absolute';
    yukiSticker.style.left = '';
    yukiSticker.style.right = '';
    yukiSticker.style.top = '';
    yukiSticker.style.bottom = '';
    yukiSticker.style.transform = '';
    const position = settings.stickerPosition || 'progress-top';
    const pad = 22;
    if (position === 'progress-top') {
      const track = yukiRoot?.querySelector('.visual-yuki-progress-track');
      const rect = track?.getBoundingClientRect();
      const rootRect = yukiRoot?.getBoundingClientRect();
      if (rect && rootRect && rect.width) {
        const h = yukiSticker.getBoundingClientRect().height || 80;
        yukiSticker.style.left = `${rect.left - rootRect.left + rect.width / 2}px`;
        yukiSticker.style.top = `${Math.max(8, rect.top - rootRect.top - h - 10)}px`;
        yukiSticker.style.transform = 'translateX(-50%)';
      }
      return;
    }
    if (position === 'top-left') { yukiSticker.style.left=`${pad}px`; yukiSticker.style.top=`${pad + 42}px`; }
    else if (position === 'top-right') { yukiSticker.style.right=`${pad}px`; yukiSticker.style.top=`${pad + 42}px`; }
    else if (position === 'bottom-left') { yukiSticker.style.left=`${pad}px`; yukiSticker.style.bottom=`${pad}px`; }
    else { yukiSticker.style.right=`${pad}px`; yukiSticker.style.bottom=`${pad}px`; }
  }

  function applyStickerState(state = {}) {
    if (!stickerEl) return;
    const src = String(state.src || window.glasstrackVisualSticker || '');
    const enabled = !!state.enabled && !!src;
    if (src && stickerEl.src !== src) stickerEl.src = src;
    stickerEl.hidden = !enabled;
    stickerEl.style.display = enabled ? '' : 'none';
    if (enabled) {
      stickerEl.onload = () => updateStickerPosition();
      requestAnimationFrame(updateStickerPosition);
    }
    if (yukiSticker) {
      if (src && yukiSticker.src !== src) yukiSticker.src = src;
      yukiSticker.hidden = !enabled || !getVisualSettings().yukiMode;
      if (enabled) {
        yukiSticker.onload = () => updateYukiStickerPosition();
        requestAnimationFrame(updateYukiStickerPosition);
      }
    }
  }

  window.applyGlasstrackVisualSticker = applyStickerState;
  window.addEventListener('glasstrack:visual-sticker-change', event => {
    const state = event.detail || {};
    applyStickerState(state);
    if (root.classList.contains('is-open')) requestAnimationFrame(updateStickerPosition);
  });

  window.addEventListener('glasstrack:visual-settings-change', (event) => {
    applyVisualSettings(event.detail || getVisualSettings());
    if (root.classList.contains('is-open')) {
      clearParticles();
      const density = Math.max(2, Math.min(10, Number(getVisualSettings().particleDensity) || 6));
      for (let i = 0; i < Math.min(12, density + 2); i++) spawnParticle();
      scheduleParticles();
      if (bottomWaves) resizeCanvases();
    }
  });

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const s = Math.floor(sec);
    const m = Math.floor(s / 60);
    const r = String(s % 60).padStart(2, '0');
    return `${m}:${r}`;
  }

  function activeAudioNode() {
    if (typeof activeAudio !== 'undefined' && activeAudio) return activeAudio;
    return original.audio1 || original.audio2 || null;
  }

  function readAnalyser() {
    try {
      const analyser =
        (typeof concludorAnalyser !== 'undefined' && concludorAnalyser) ||
        window.concludorAnalyser || null;

      if (!analyser || typeof analyser.getByteFrequencyData !== 'function') return null;
      if (!analyserData || analyserData.length !== analyser.frequencyBinCount) {
        analyserData = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(analyserData);
      return analyserData;
    } catch (_) {
      return null;
    }
  }

  function readEnergy(data) {
    if (!data || !data.length) return 0;

    const lowCount = Math.max(1, Math.min(8, Math.floor(data.length * 0.16)));
    let low = 0;
    for (let i = 0; i < lowCount; i++) low += data[i];
    low /= lowCount * 255;

    let all = 0;
    for (let i = 0; i < data.length; i++) all += data[i];
    const average = all / (data.length * 255);

    return Math.max(0, Math.min(1, low * 0.78 + average * 0.22));
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    const d = max - min;

    if (d !== 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d) + (g < b ? 6 : 0); break;
        case g: h = ((b - r) / d) + 2; break;
        default: h = ((r - g) / d) + 4; break;
      }
      h /= 6;
    }

    return [h, s, l];
  }

  function hslToRgb(h, s, l) {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    if (s === 0) {
      const v = Math.round(l * 255);
      return [v, v, v];
    }

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      Math.round(hue2rgb(p, q, h) * 255),
      Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
    ];
  }

  function parseRgbString(value) {
    const m = String(value || '').match(/(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])].map(v => Math.max(0, Math.min(255, v)));
  }

  function rgbText(rgb) {
    return `${rgb[0]}, ${rgb[1]}, ${rgb[2]}`;
  }

  function colorDistance(a, b) {
    const dr = a[0] - b[0];
    const dg = a[1] - b[1];
    const db = a[2] - b[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  function makeSecondaryFallback(primary) {
    const [h, s, l] = rgbToHsl(primary[0], primary[1], primary[2]);
    const hue = (h + 0.11) % 1;
    return hslToRgb(hue, Math.max(0.28, Math.min(0.9, s * 0.88 + 0.12)), Math.max(0.32, Math.min(0.7, l + 0.03)));
  }

  async function extractPalette(src) {
    if (!src) return null;

    const image = new Image();
    image.decoding = 'async';
    if (!src.startsWith('blob:') && !src.startsWith('data:')) image.crossOrigin = 'anonymous';

    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = src;
    });

    const sample = 54;
    const canvas = document.createElement('canvas');
    canvas.width = sample;
    canvas.height = sample;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    ctx.drawImage(image, 0, 0, sample, sample);
    const data = ctx.getImageData(0, 0, sample, sample).data;
    const buckets = new Map();

    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 110) continue;

      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const spread = max - min;

      if (max < 24) continue;
      if (max > 244 && spread < 16) continue;

      const [h, s, l] = rgbToHsl(r, g, b);
      if (s < 0.14 || l < 0.09) continue;

      const rq = Math.round(r / 24) * 24;
      const gq = Math.round(g / 24) * 24;
      const bq = Math.round(b / 24) * 24;
      const key = `${rq},${gq},${bq}`;
      const weight = 1 + s * 3 + Math.min(1.5, l * 1.8);

      const bucket = buckets.get(key) || { weight: 0, r: 0, g: 0, b: 0 };
      bucket.weight += weight;
      bucket.r += r * weight;
      bucket.g += g * weight;
      bucket.b += b * weight;
      buckets.set(key, bucket);
    }

    const colors = [...buckets.values()]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 18)
      .map(item => [
        Math.round(item.r / item.weight),
        Math.round(item.g / item.weight),
        Math.round(item.b / item.weight)
      ]);

    if (!colors.length) return null;

    const primary = colors[0];
    const secondary = colors.find(color => colorDistance(color, primary) > 65) || makeSecondaryFallback(primary);
    return { primary, secondary };
  }

  async function applyPalette(src) {
    const computed = getComputedStyle(root);
    let primary = parseRgbString(computed.getPropertyValue('--visual-primary-rgb'));
    if (!primary) {
      const global = getComputedStyle(document.documentElement).getPropertyValue('--dominant-rgb');
      primary = parseRgbString(global) || [154, 163, 173];
    }
    let secondary = parseRgbString(computed.getPropertyValue('--visual-secondary-rgb')) || makeSecondaryFallback(primary);

    if (!src || src === paletteSource || paletteBusy) {
      root.style.setProperty('--visual-primary-rgb', rgbText(primary));
      root.style.setProperty('--visual-secondary-rgb', rgbText(secondary));
      root.style.setProperty('--visual-primary', `rgb(${rgbText(primary)})`);
      root.style.setProperty('--visual-secondary', `rgb(${rgbText(secondary)})`);
      return;
    }

    paletteSource = src;
    paletteBusy = true;

    try {
      const palette = await extractPalette(src);
      if (palette) {
        primary = palette.primary;
        secondary = palette.secondary;
      }
    } catch (_) {
      secondary = makeSecondaryFallback(primary);
    } finally {
      root.style.setProperty('--visual-primary-rgb', rgbText(primary));
      root.style.setProperty('--visual-secondary-rgb', rgbText(secondary));
      root.style.setProperty('--visual-primary', `rgb(${rgbText(primary)})`);
      root.style.setProperty('--visual-secondary', `rgb(${rgbText(secondary)})`);
      paletteBusy = false;
    }
  }

  function syncBackground() {
    const coverSrc = original.cover?.currentSrc || original.cover?.src || '';
    if (coverSrc) {
      bgCover.style.backgroundImage = `url("${coverSrc.replace(/"/g, '\\"')}")`;
    }

    const appBgVideo = original.bgVideo;
    const appBgImage = original.bgImage;
    const hasVideo = !!(appBgVideo && appBgVideo.src && !appBgVideo.classList.contains('bg-video-hidden'));

    if (hasVideo) {
      if (bgVideoVisual.src !== appBgVideo.src) bgVideoVisual.src = appBgVideo.src;
      bgVideoVisual.style.display = 'block';
      bgVideoVisual.play().catch(() => {});
      return;
    }

    bgVideoVisual.pause();
    if (bgVideoVisual.src) {
      bgVideoVisual.removeAttribute('src');
      bgVideoVisual.load();
    }
    bgVideoVisual.style.display = 'none';

    const bgStyle = appBgImage ? getComputedStyle(appBgImage).backgroundImage : '';
    if (bgStyle && bgStyle !== 'none') {
      bgCover.style.backgroundImage = bgStyle;
    }
  }

  function syncLyric() {
    if (!lyricEl) return;
    const source = original.lyrics;
    const active = source?.querySelector('.lyrics-line.active, .lyric-line.active, [data-active="true"]');
    const text = active?.textContent?.replace(/\s+/g, ' ').trim() || '';

    if (text) {
      lyricEl.textContent = text;
      lyricEl.setAttribute('aria-hidden', 'false');
      lyricEl.classList.add('has-lyric');
    } else {
      lyricEl.textContent = '';
      lyricEl.setAttribute('aria-hidden', 'true');
      lyricEl.classList.remove('has-lyric');
    }
  }

  function syncTrack() {
    const songTitle = original.title?.textContent?.trim() || 'Sin canción cargada';
    const songArtist = original.artist?.textContent?.trim() || '—';
    const songCover = original.cover?.currentSrc || original.cover?.src || '';
    const audio = activeAudioNode();

    titleEl.textContent = songTitle;
    artistEl.textContent = songArtist;
    if (songCover && coverEl.src !== songCover) coverEl.src = songCover;
    if (yukiTitle) yukiTitle.textContent = songTitle;
    if (yukiArtist) yukiArtist.textContent = songArtist;
    if (songCover && yukiCover?.src !== songCover) yukiCover.src = songCover;
    syncBackground();
    syncLyric();
    applyPalette(songCover);

    if (audio) {
      const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      currentEl.textContent = formatTime(current);
      durationEl.textContent = formatTime(duration);
      if (yukiCurrent) yukiCurrent.textContent = formatTime(current);
      if (yukiDuration) yukiDuration.textContent = formatTime(duration);
      const pct = duration > 0 ? Math.max(0, Math.min(100, current / duration * 100)) : 0;
      progressEl.style.width = `${pct}%`;
      if (yukiProgress) yukiProgress.style.width = `${pct}%`;
      root.style.setProperty('--visual-progress', `${pct}%`);
      root.classList.toggle('is-playing', !audio.paused);
      playBtn.textContent = audio.paused ? '▶' : 'Ⅱ';
      if (yukiPlay) yukiPlay.textContent = audio.paused ? '▶' : 'Ⅱ';
      if (yukiCurrentTop) yukiCurrentTop.textContent = formatTime(current);
      statusTime.textContent = formatTime(current);
      if (volumeInput && Number.isFinite(audio.volume)) {
        volumeInput.value = String(audio.volume);
        const volumePercent = Math.round(audio.volume * 100);
        volumeInput.style.setProperty('--visual-volume-percent', `${volumePercent}%`);
        volumeValue.textContent = `${volumePercent}%`;
        if (yukiVolumeFill) yukiVolumeFill.style.width = `${volumePercent}%`;
        if (yukiVolumeValue) yukiVolumeValue.textContent = `${volumePercent}%`;
      }
    }
  }

  function resizeCanvas(canvas) {
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  }

  function resizeCanvases() {
    resizeCanvas(wave);
    resizeCanvas(bottomWaves);
    resizeCanvas(yukiSpectrum);
    resizeCanvas(yukiBottomWaves);
    bottomWavesDpr = Math.min(2, window.devicePixelRatio || 1);
    yukiWavesDpr = Math.min(2, window.devicePixelRatio || 1);
  }

  function drawTopWave(ctx, w, h, data, now) {
    ctx.clearRect(0, 0, w, h);
    const count = 32;
    const gap = Math.max(2, w / 420);
    const barWidth = Math.max(3, (w - gap * (count - 1)) / count);
    const primaryRgb = root.style.getPropertyValue('--visual-primary-rgb').trim() || '154, 163, 173';
    const secondaryRgb = root.style.getPropertyValue('--visual-secondary-rgb').trim() || '110, 128, 160';

    // Las barras nacen exactamente desde la línea superior del canvas (la línea de progreso)
    // y crecen hacia ABAJO según las frecuencias del AudioContext.
    for (let i = 0; i < count; i++) {
      const srcIndex = data
        ? Math.min(data.length - 1, Math.floor((i / count) * data.length * 0.72))
        : 0;
      const spectral = data ? data[srcIndex] / 255 : 0.05;
      const pulse = Math.min(1, beatLevel * 0.6 + beatPulse * 0.35);
      const height = Math.max(3, Math.min(h, (spectral * 0.86 + pulse * 0.16) * h));
      const x = i * (barWidth + gap);
      const rgb = i % 2 === 0 ? primaryRgb : secondaryRgb;

      ctx.fillStyle = `rgba(${rgb}, .82)`;
      ctx.shadowColor = `rgba(${rgb}, .54)`;
      ctx.shadowBlur = 9;
      ctx.fillRect(x, 0, barWidth, height);
      ctx.shadowBlur = 0;

      // Pequeña cabeza brillante para conservar el aspecto HUD sin redondear los bloques.
      ctx.fillStyle = 'rgba(255,255,255,.20)';
      ctx.fillRect(x, 0, barWidth, Math.min(2, height));
    }
  }

  function drawBottomWaves(ctx, w, h, data, now) {
    ctx.clearRect(0, 0, w, h);

    const settings = getVisualSettings();
    if (!settings.waves) return;

    const primaryRgb = root.style.getPropertyValue('--visual-primary-rgb').trim() || '154, 163, 173';
    const secondaryRgb = root.style.getPropertyValue('--visual-secondary-rgb').trim() || '110, 128, 160';
    const t = now * 0.0012;
    const energy = beatLevel;
    const pulse = beatPulse;
    const points = Math.max(72, Math.min(150, Math.floor(w / (bottomWavesDpr * 6))));
    const centerA = h * 0.27;
    const centerB = h * 0.73;
    const joinY = h * 0.5;

    const drawWave = (center, direction, rgb, mirrored) => {
      const coords = [];

      for (let i = 0; i < points; i++) {
        const x = (i / (points - 1)) * w;
        const idx = data ? Math.min(data.length - 1, Math.floor(i / points * data.length * 0.72)) : 0;
        const spectral = data ? data[idx] / 255 : 0.15;
        const amp = h * (0.075 + energy * 0.14 + pulse * 0.115 + spectral * 0.03);
        const phase = i * 0.26 + (direction * t * 2.6);
        const wobble = Math.sin(phase) * amp;
        const y = mirrored ? center - wobble : center + wobble;
        coords.push([x, y]);
      }

      // Relleno completo para que cada onda se vea como una masa de color, no como un simple trazo.
      ctx.beginPath();
      ctx.moveTo(coords[0][0], joinY);
      for (const [x, y] of coords) ctx.lineTo(x, y);
      ctx.lineTo(coords[coords.length - 1][0], joinY);
      ctx.closePath();
      ctx.fillStyle = `rgba(${rgb}, .24)`;
      ctx.shadowColor = `rgba(${rgb}, .26)`;
      ctx.shadowBlur = 16;
      ctx.fill();

      ctx.beginPath();
      ctx.lineWidth = Math.max(1.6, w / 720);
      ctx.strokeStyle = `rgba(${rgb}, .92)`;
      ctx.shadowColor = `rgba(${rgb}, .46)`;
      ctx.shadowBlur = 10;
      for (let i = 0; i < coords.length; i++) {
        const [x, y] = coords[i];
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    };

    drawWave(centerA, 1, primaryRgb, false);
    drawWave(centerB, -1, secondaryRgb, true);

    ctx.beginPath();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.moveTo(0, joinY);
    ctx.lineTo(w, joinY);
    ctx.stroke();
  }

  function drawYukiBottomWaves(ctx, w, h, data, now) {
    ctx.clearRect(0, 0, w, h);
    const settings = getVisualSettings();
    if (!settings.waves) return;

    const primaryRgb = root.style.getPropertyValue('--visual-primary-rgb').trim() || '154, 163, 173';
    const t = now * 0.00095;
    const energy = beatLevel;
    const pulse = beatPulse;
    const points = Math.max(90, Math.min(220, Math.floor(w / 5)));
    const intensity = Math.max(.35, Math.min(1, Number(settings.waveHeight) / 170));
    const frontBase = h * .63;
    const rearBase = h * .78;

    function buildWave(base, phaseOffset, ampBoost) {
      const pts = [];
      for (let i = 0; i < points; i++) {
        const x = (i / (points - 1)) * w;
        const idx = data ? Math.min(data.length - 1, Math.floor((i / points) * data.length * .76)) : 0;
        const spectral = data ? data[idx] / 255 : .10;
        const rhythm = .55 + energy * .65 + pulse * .65;
        const amp = h * (.035 + .095 * intensity) * ampBoost * (0.86 + spectral * .22) * rhythm;
        const waveA = Math.sin(i * .078 + t * 2.2 + phaseOffset) * amp;
        const waveB = Math.sin(i * .031 - t * 1.45 + phaseOffset * .7) * amp * .34;
        const waveC = Math.sin(i * .147 + t * .86) * amp * .16;
        pts.push([x, Math.max(4, base - waveA - waveB - waveC)]);
      }
      return pts;
    }

    const rear = buildWave(rearBase, 1.4, .72);
    const front = buildWave(frontBase, 0, 1.0);

    // Onda trasera cálida: se mantiene parcialmente transparente.
    ctx.beginPath();
    ctx.moveTo(0, h);
    rear.forEach(([x,y], i) => i ? ctx.lineTo(x,y) : ctx.lineTo(x,y));
    ctx.lineTo(w,h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(243,173,99,.26)';
    ctx.shadowColor = 'rgba(243,173,99,.18)';
    ctx.shadowBlur = 18;
    ctx.fill();

    // Onda frontal blanca/primaria: la capa protagonista.
    ctx.beginPath();
    ctx.moveTo(0, h);
    front.forEach(([x,y], i) => i ? ctx.lineTo(x,y) : ctx.lineTo(x,y));
    ctx.lineTo(w,h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,.23)';
    ctx.shadowColor = `rgba(${primaryRgb},.22)`;
    ctx.shadowBlur = 20;
    ctx.fill();

    // Bordes superiores finos para conservar el acabado HUD.
    ctx.beginPath();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(255,255,255,.76)';
    ctx.shadowColor = 'rgba(255,255,255,.28)';
    ctx.shadowBlur = 10;
    front.forEach(([x,y], i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
    ctx.stroke();

    ctx.beginPath();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(243,173,99,.62)';
    ctx.shadowColor = 'rgba(243,173,99,.16)';
    rear.forEach(([x,y], i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function updateBeat(data, audio) {
    const settings = getVisualSettings();
    const isPlaying = !!(audio && !audio.paused);
    const targetEnergy = isPlaying ? readEnergy(data) : 0;
    beatLevel += (targetEnergy - beatLevel) * (isPlaying ? 0.18 : 0.24);

    const delta = targetEnergy - previousEnergy;
    if (isPlaying && delta > 0.012) {
      beatPulse = Math.min(1, beatPulse + delta * 9.2 + targetEnergy * 0.060);
    } else {
      beatPulse *= isPlaying ? 0.875 : 0.82;
    }
    previousEnergy = targetEnergy;

    const intensity = Math.max(0.35, Math.min(1, Number(settings.beatIntensity) / 100 || .7));
    const beatEnabled = isPlaying && settings.beat;
    const coverScale = beatEnabled
      ? 1 + Math.min(0.072 + intensity * 0.068, beatLevel * 0.045 + beatPulse * (0.072 + intensity * 0.066))
      : 1;
    const coverLift = beatEnabled
      ? -Math.min(10.5, beatPulse * (4.2 + intensity * 6.2))
      : 0;

    if (coverEl) {
      coverEl.style.transform = `translateY(${coverLift.toFixed(2)}px) scale(${coverScale.toFixed(4)})`;
    }
    if (yukiCover) {
      yukiCover.style.transform = `translateY(${(coverLift * 0.92).toFixed(2)}px) scale(${coverScale.toFixed(4)})`;
    }
    if (halo) {
      const haloScale = settings.halo
        ? 1 + beatLevel * 0.050 + beatPulse * (0.075 + intensity * 0.025)
        : 1;
      halo.style.setProperty('--visual-halo-scale', haloScale.toFixed(4));
      if (yukiHalo) yukiHalo.style.setProperty('--visual-halo-scale', haloScale.toFixed(4));
    }
  }

  function drawVisuals(now) {
    if (!root.classList.contains('is-open')) {
      raf = 0;
      return;
    }

    const audio = activeAudioNode();
    const data = readAnalyser();
    updateBeat(data, audio);

    if (wave) {
      const ctx = wave.getContext('2d');
      if (ctx) drawTopWave(ctx, wave.width, wave.height, data, now);
    }

    if (bottomWaves) {
      const ctx = bottomWaves.getContext('2d');
      if (ctx) drawBottomWaves(ctx, bottomWaves.width, bottomWaves.height, data, now);
    }
    if (yukiSpectrum && getVisualSettings().yukiMode) {
      const ctx = yukiSpectrum.getContext('2d');
      if (ctx) drawTopWave(ctx, yukiSpectrum.width, yukiSpectrum.height, data, now);
    }
    if (yukiBottomWaves && getVisualSettings().yukiMode) {
      const ctx = yukiBottomWaves.getContext('2d');
      if (ctx) drawYukiBottomWaves(ctx, yukiBottomWaves.width, yukiBottomWaves.height, data, now);
    }

    wavePhase += 0.002;
    raf = requestAnimationFrame(drawVisuals);
  }

  function spawnParticle() {
    const settings = getVisualSettings();
    const particleHost = settings.yukiMode ? yukiParticles : particlesEl;
    if (!particleHost || !settings.particles || reducedMotion() || !root.classList.contains('is-open')) return;

    const particle = document.createElement('span');
    const available = Array.isArray(settings.particleTypes) && settings.particleTypes.length
      ? settings.particleTypes
      : VISUAL_DEFAULTS.particleTypes;
    particle.textContent = available[Math.floor(Math.random() * available.length)];
    particle.classList.toggle('visual-particle-flat', !settings.particleDepth);
    particle.style.left = `${4 + Math.random() * 92}%`;
    particle.style.top = `${76 + Math.random() * 20}%`;
    particle.style.setProperty('--particle-dx', `${-180 + Math.random() * 360}px`);
    particle.style.setProperty('--particle-dy', `${-170 - Math.random() * 280}px`);
    particle.style.setProperty('--particle-dz', `${-620 - Math.random() * 520}px`);
    particle.style.setProperty('--particle-scale', `${0.86 + Math.random() * 1.12}`);
    particle.style.setProperty('--particle-rotate', `${-180 + Math.random() * 360}deg`);
    const speed = Math.max(60, Math.min(160, Number(settings.particleSpeed) || 100));
    particle.style.setProperty('--particle-duration', `${(4.4 + Math.random() * 3.8) * (100 / speed)}s`);
    particle.style.color = Math.random() < 0.5 ? 'var(--visual-primary)' : 'var(--visual-secondary)';
    particle.addEventListener('animationend', () => particle.remove(), { once: true });
    particleHost.appendChild(particle);
  }

  function scheduleParticles() {
    window.clearTimeout(particleTimer);
    const settings = getVisualSettings();
    if (!root.classList.contains('is-open') || !settings.particles || reducedMotion()) return;
    spawnParticle();
    const density = Math.max(2, Math.min(10, Number(settings.particleDensity) || 6));
    const interval = Math.max(210, 1420 - density * 118) + Math.random() * 300;
    particleTimer = window.setTimeout(scheduleParticles, interval);
  }

  function clearParticles() {
    window.clearTimeout(particleTimer);
    particleTimer = 0;
    if (particlesEl) particlesEl.replaceChildren();
    if (yukiParticles) yukiParticles.replaceChildren();
  }

  function open() {
    root.classList.add('is-open');
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('visual-mode-open');
    applyVisualSettings(getVisualSettings());
    syncTrack();
    applyStickerState({ src: window.glasstrackVisualSticker || '', enabled: !!getVisualSettings().stickerEnabled, position: getVisualSettings().stickerPosition || 'progress-top' });
    resizeCanvases();
    requestAnimationFrame(updateYukiStickerPosition);
    cancelAnimationFrame(raf);
    beatLevel = 0;
    previousEnergy = 0;
    beatPulse = 0;
    raf = requestAnimationFrame(drawVisuals);
    clearParticles();
    const settings = getVisualSettings();
    const density = Math.max(2, Math.min(10, Number(settings.particleDensity) || 6));
    if (settings.particles) {
      for (let i = 0; i < Math.min(12, density + 2); i++) spawnParticle();
      scheduleParticles();
    }

    try {
      if (typeof initAudioContext === 'function') initAudioContext();
      if (typeof playSFX === 'function') playSFX('open');
    } catch (_) {}
  }

  function close() {
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('visual-mode-open');
    cancelAnimationFrame(raf);
    raf = 0;
    clearParticles();
    beatLevel = 0;
    previousEnergy = 0;
    beatPulse = 0;
    if (coverEl) coverEl.style.transform = 'translateY(0) scale(1)';
    if (yukiCover) yukiCover.style.transform = 'translateY(0) scale(1)';
    if (halo) halo.style.setProperty('--visual-halo-scale', '1');
    if (yukiHalo) yukiHalo.style.setProperty('--visual-halo-scale', '1');
    if (yukiSticker) yukiSticker.hidden = true;
    resetParallax();
    if (stickerEl) stickerEl.hidden = true;
    bgVideoVisual.pause();
  }

  window.openGlasstrackVisualMode = open;
  window.closeGlasstrackVisualMode = close;

  closeBtn?.addEventListener('click', close);
  prevBtn?.addEventListener('click', () => original.prev?.click());
  nextBtn?.addEventListener('click', () => original.next?.click());
  playBtn?.addEventListener('click', () => original.play?.click());
  yukiRoot?.querySelector('.visual-yuki-prev')?.addEventListener('click', () => original.prev?.click());
  yukiRoot?.querySelector('.visual-yuki-next')?.addEventListener('click', () => original.next?.click());
  yukiRoot?.querySelector('.visual-yuki-play')?.addEventListener('click', () => original.play?.click());
  yukiRoot?.querySelector('.visual-yuki-progress-track')?.addEventListener('pointerdown', event => {
    const audio = activeAudioNode();
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const track = event.currentTarget;
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    try { audio.currentTime = ratio * audio.duration; } catch (_) {}
    syncTrack();
  });

  volumeInput?.addEventListener('input', () => {
    const value = Math.max(0, Math.min(1, Number(volumeInput.value)));
    if (original.volume) {
      original.volume.value = String(value);
      original.volume.dispatchEvent(new Event('input', { bubbles: true }));
      original.volume.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const volumePercent = Math.round(value * 100);
    volumeInput.style.setProperty('--visual-volume-percent', `${volumePercent}%`);
    volumeValue.textContent = `${volumePercent}%`;
  });

  const progressTrack = root.querySelector('.visual-mode-progress-track');
  progressTrack?.addEventListener('pointerdown', event => {
    const audio = activeAudioNode();
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const rect = progressTrack.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    try { audio.currentTime = ratio * audio.duration; } catch (_) {}
    syncTrack();
  });

  [original.audio1, original.audio2].filter(Boolean).forEach(audio => {
    ['timeupdate', 'play', 'pause', 'loadedmetadata', 'durationchange', 'volumechange', 'ended'].forEach(evt => {
      audio.addEventListener(evt, syncTrack, { passive: true });
    });
  });

  original.volume?.addEventListener('input', syncTrack, { passive: true });

  window.addEventListener('resize', () => {
    if (root.classList.contains('is-open')) { resizeCanvases(); updateStickerPosition(); updateYukiStickerPosition(); }
  }, { passive: true });

  document.addEventListener('keydown', (event) => {
    if (!root.classList.contains('is-open')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
    if (event.code === 'Space' && !/input|textarea|button/i.test(event.target?.tagName || '')) {
      event.preventDefault();
      original.play?.click();
    }
  });

  observer = new MutationObserver(() => {
    if (root.classList.contains('is-open')) syncTrack();
  });
  if (original.title) observer.observe(original.title, { childList: true, characterData: true, subtree: true });
  if (original.artist) observer.observe(original.artist, { childList: true, characterData: true, subtree: true });
  if (original.cover) observer.observe(original.cover, { attributes: true, attributeFilter: ['src'] });

  lyricsObserver = original.lyrics ? new MutationObserver(syncLyric) : null;
  lyricsObserver?.observe(original.lyrics, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'data-active']
  });

  resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
    if (root.classList.contains('is-open')) resizeCanvases();
  }) : null;
  if (wave) resizeObserver?.observe(wave);
  if (bottomWaves) resizeObserver?.observe(bottomWaves);

  // Estos manejadores deben vivir dentro de esta IIFE: la definición anterior
  // pertenece a otro visor y no está disponible en este ámbito léxico.
  function handleParallax(event) {
    const settings = getVisualSettings();
    if (!settings.parallax || !coverSide || !root.classList.contains('is-open')) return;
    const x = Number(event.clientX);
    const y = Number(event.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const rect = coverSide.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const nx = Math.max(-1, Math.min(1, (x - (rect.left + rect.width / 2)) / (rect.width / 2)));
    const ny = Math.max(-1, Math.min(1, (y - (rect.top + rect.height / 2)) / (rect.height / 2)));
    coverSide.style.transform = `translate3d(${(nx * 5.5).toFixed(2)}px, ${(ny * 5.5).toFixed(2)}px, 0)`;
  }
  function resetParallax() {
    if (coverSide) coverSide.style.transform = 'translate3d(0, 0, 0)';
  }

  root.addEventListener('pointermove', handleParallax, { passive: true });
  root.addEventListener('pointerleave', resetParallax, { passive: true });

  applyVisualSettings(getVisualSettings());
  syncTrack();
})();


// =========================================================
// GLASSTRACK PRO — PUENTE ROBUSTO DEL BOTÓN MODO VISUAL V24
// Evita que una capa antigua o un orden de inicialización deje el botón sin acción.
// =========================================================
(() => {
  'use strict';
  const item = document.getElementById('top-mode-visual');
  const menu = document.getElementById('top-experiences-menu');
  const trigger = document.getElementById('btn-top-experiences');
  const root = document.getElementById('visual-mode');
  if (!item || !root) return;

  let opening = false;

  const hideMenu = () => {
    menu?.classList.add('hidden');
    trigger?.setAttribute('aria-expanded', 'false');
  };

  const openDirect = () => {
    if (opening) return;
    opening = true;
    try {
      hideMenu();
      if (typeof window.openGlasstrackVisualMode === 'function') {
        window.openGlasstrackVisualMode();
      } else {
        root.classList.add('is-open');
        root.setAttribute('aria-hidden', 'false');
        document.body.classList.add('visual-mode-open');
      }
    } finally {
      window.setTimeout(() => { opening = false; }, 120);
    }
  };

  item.addEventListener('pointerup', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    openDirect();
  }, true);

  item.addEventListener('click', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    openDirect();
  }, true);

  item.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    openDirect();
  });
})();


// =========================================================
// GLASSTRACK PRO — PERSONALIZAR MODO ESTILO V29
// Preferencias persistentes y aplicación en vivo al Modo Visual.
// =========================================================
(() => {
  'use strict';

  const STORAGE_KEY = 'glasstrackVisualModeSettingsV25';
  const DEFAULTS = {
    yukiMode: false,
    yukiGeometry: true,
    yukiRingDecor: true,
    yukiSpectrum: true,
    particles: true,
    particleDepth: true,
    particleDensity: 8,
    particleSpeed: 100,
    particleTypes: ['✦', '✧', '◇', '✣', '·', '❀'],
    waves: true,
    waveHeight: 120,
    ring: true,
    ringSpeed: 24,
    halo: true,
    beat: true,
    beatIntensity: 70,
    textFlash: false,
    parallax: false,
    controlsContrast: true,
    stickerEnabled: false,
    stickerPosition: 'progress-top'
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value)));

  function readSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULTS };
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULTS,
        ...parsed,
        particleDensity: Math.round(clamp(parsed.particleDensity ?? DEFAULTS.particleDensity, 2, 10)),
        particleSpeed: clamp(parsed.particleSpeed ?? DEFAULTS.particleSpeed, 60, 160),
        waveHeight: Math.round(clamp(parsed.waveHeight ?? DEFAULTS.waveHeight, 70, 170)),
        ringSpeed: Math.round(clamp(parsed.ringSpeed ?? DEFAULTS.ringSpeed, 8, 48)),
        beatIntensity: Math.round(clamp(parsed.beatIntensity ?? DEFAULTS.beatIntensity, 35, 100)),
        stickerEnabled: !!parsed.stickerEnabled,
        stickerPosition: ['progress-top','top-left','top-right','bottom-left','bottom-right'].includes(parsed.stickerPosition) ? parsed.stickerPosition : DEFAULTS.stickerPosition,
        particleTypes: Array.isArray(parsed.particleTypes) && parsed.particleTypes.length
          ? parsed.particleTypes.filter(Boolean).slice(0, 6)
          : [...DEFAULTS.particleTypes]
      };
    } catch (_) {
      return { ...DEFAULTS };
    }
  }

  let settings = readSettings();
  window.glasstrackVisualSettings = settings;

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) {}
    window.glasstrackVisualSettings = { ...settings, particleTypes: [...settings.particleTypes] };
    window.dispatchEvent(new CustomEvent('glasstrack:visual-settings-change', { detail: window.glasstrackVisualSettings }));
  }

  const ids = {
    yukiMode: 'visual-setting-yuki-mode',
    yukiGeometry: 'visual-setting-yuki-geometry',
    yukiRingDecor: 'visual-setting-yuki-ring-decor',
    yukiSpectrum: 'visual-setting-yuki-spectrum',
    particles: 'visual-setting-particles',
    particleDepth: 'visual-setting-particle-depth',
    particleDensity: 'visual-setting-particle-density',
    particleSpeed: 'visual-setting-particle-speed',
    waves: 'visual-setting-waves',
    waveHeight: 'visual-setting-wave-height',
    ring: 'visual-setting-ring',
    ringSpeed: 'visual-setting-ring-speed',
    halo: 'visual-setting-halo',
    beat: 'visual-setting-beat',
    beatIntensity: 'visual-setting-beat-intensity',
    textFlash: 'visual-setting-text-flash',
    parallax: 'visual-setting-parallax',
    controlsContrast: 'visual-setting-controls',
    stickerEnabled: 'visual-setting-sticker-enabled',
    stickerPosition: 'visual-setting-sticker-position'
  };

  const valueIds = {
    particleDensity: 'visual-setting-particle-density-value',
    particleSpeed: 'visual-setting-particle-speed-value',
    waveHeight: 'visual-setting-wave-height-value',
    ringSpeed: 'visual-setting-ring-speed-value',
    beatIntensity: 'visual-setting-beat-intensity-value'
  };

  function el(id) { return document.getElementById(id); }

  function updateRangeLabels() {
    const labels = {
      particleDensity: String(settings.particleDensity),
      particleSpeed: `${settings.particleSpeed}%`,
      waveHeight: `${settings.waveHeight} px`,
      ringSpeed: `${settings.ringSpeed} s/vuelta`,
      beatIntensity: `${settings.beatIntensity}%`
    };
    Object.entries(labels).forEach(([key, value]) => {
      const node = el(valueIds[key]);
      if (node) node.textContent = value;
    });
  }

  let stickerObjectUrl = '';

  function dispatchStickerChange() {
    window.glasstrackVisualStickerState = {
      src: stickerObjectUrl,
      enabled: !!settings.stickerEnabled,
      position: settings.stickerPosition || 'progress-top'
    };
    window.glasstrackVisualSticker = stickerObjectUrl;
    window.dispatchEvent(new CustomEvent('glasstrack:visual-sticker-change', {
      detail: window.glasstrackVisualStickerState
    }));
  }

  function updateStickerStatus() {
    const node = el('visual-sticker-file-status');
    if (node) node.textContent = stickerObjectUrl ? 'Sticker cargado y listo para el Modo Visual.' : 'Ningún PNG o GIF cargado.';
  }

  function loadStickerFromDb() {
    if (!db) return false;
    try {
      const request = db.transaction(['settings'], 'readonly').objectStore('settings').get('visualModeSticker');
      request.onsuccess = () => {
        const record = request.result;
        if (record?.blob instanceof Blob) {
          if (stickerObjectUrl) URL.revokeObjectURL(stickerObjectUrl);
          stickerObjectUrl = URL.createObjectURL(record.blob);
        }
        updateStickerStatus();
        dispatchStickerChange();
      };
      request.onerror = () => { updateStickerStatus(); dispatchStickerChange(); };
      return true;
    } catch (_) {
      return false;
    }
  }

  function waitForStickerDb() {
    if (loadStickerFromDb()) return;
    const timer = window.setInterval(() => {
      if (loadStickerFromDb()) window.clearInterval(timer);
    }, 250);
    window.setTimeout(() => window.clearInterval(timer), 6000);
  }

  function saveStickerFile(file) {
    if (!file) return;
    const name = String(file.name || '').toLowerCase();
    const type = String(file.type || '').toLowerCase();
    const valid = type === 'image/png' || type === 'image/gif' || /\.(png|gif)$/i.test(name);
    if (!valid) {
      if (typeof showToast === 'function') showToast('Solo se permiten archivos PNG o GIF.', 'error');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      if (typeof showToast === 'function') showToast('El sticker supera el límite de 8 MB.', 'error');
      return;
    }
    try {
      if (!db) {
        if (typeof showToast === 'function') showToast('El almacenamiento todavía no está disponible. Inténtalo de nuevo.', 'error');
        return;
      }
      const tx = db.transaction(['settings'], 'readwrite');
      tx.objectStore('settings').put({ key: 'visualModeSticker', blob: file, name: file.name, type: file.type || 'image/*' });
      tx.oncomplete = () => {
        if (stickerObjectUrl) URL.revokeObjectURL(stickerObjectUrl);
        stickerObjectUrl = URL.createObjectURL(file);
        settings.stickerEnabled = true;
        updateControls();
        save();
        updateStickerStatus();
        dispatchStickerChange();
      };
      tx.onerror = () => {
        if (typeof showToast === 'function') showToast('No se pudo guardar el sticker.', 'error');
      };
    } catch (_) {
      if (typeof showToast === 'function') showToast('No se pudo guardar el sticker.', 'error');
    }
  }

  function clearSticker() {
    try {
      if (db) db.transaction(['settings'], 'readwrite').objectStore('settings').delete('visualModeSticker');
    } catch (_) {}
    if (stickerObjectUrl) URL.revokeObjectURL(stickerObjectUrl);
    stickerObjectUrl = '';
    settings.stickerEnabled = false;
    updateControls();
    save();
    updateStickerStatus();
    dispatchStickerChange();
  }

  function updateControls() {
    Object.entries(ids).forEach(([key, id]) => {
      const node = el(id);
      if (!node) return;
      if (node.type === 'checkbox') node.checked = !!settings[key];
      else node.value = String(settings[key]);
    });

    document.querySelectorAll('.visual-particle-option').forEach(button => {
      const selected = settings.particleTypes.includes(button.dataset.particle);
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    updateRangeLabels();
  }

  updateStickerStatus();
  window.glasstrackVisualSticker = '';
  window.glasstrackVisualStickerState = { src: '', enabled: !!settings.stickerEnabled, position: settings.stickerPosition || 'progress-top' };

  function bind() {
    Object.entries(ids).forEach(([key, id]) => {
      const node = el(id);
      if (!node || node.dataset.visualSettingsBound === '1') return;
      node.dataset.visualSettingsBound = '1';
      node.addEventListener(node.type === 'checkbox' ? 'change' : 'input', () => {
        settings[key] = node.type === 'checkbox' ? node.checked : Number(node.value);
        if (key === 'particleDensity') settings[key] = Math.round(clamp(settings[key], 2, 10));
        if (key === 'particleSpeed') settings[key] = clamp(settings[key], 60, 160);
        if (key === 'waveHeight') settings[key] = Math.round(clamp(settings[key], 70, 170));
        if (key === 'ringSpeed') settings[key] = Math.round(clamp(settings[key], 8, 48));
        if (key === 'beatIntensity') settings[key] = Math.round(clamp(settings[key], 35, 100));
        updateRangeLabels();
        save();
      });
    });

    document.querySelectorAll('.visual-particle-option').forEach(button => {
      if (button.dataset.visualSettingsBound === '1') return;
      button.dataset.visualSettingsBound = '1';
      button.addEventListener('click', () => {
        const symbol = button.dataset.particle;
        if (!symbol) return;
        if (settings.particleTypes.includes(symbol)) {
          if (settings.particleTypes.length <= 1) return;
          settings.particleTypes = settings.particleTypes.filter(item => item !== symbol);
        } else {
          settings.particleTypes = [...settings.particleTypes, symbol].slice(0, 6);
        }
        updateControls();
        save();
      });
    });

    const stickerFile = el('visual-sticker-file');
    if (stickerFile && stickerFile.dataset.visualSettingsBound !== '1') {
      stickerFile.dataset.visualSettingsBound = '1';
      stickerFile.addEventListener('change', event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        saveStickerFile(file);
      });
    }

    const stickerClear = el('visual-sticker-clear');
    if (stickerClear && stickerClear.dataset.visualSettingsBound !== '1') {
      stickerClear.dataset.visualSettingsBound = '1';
      stickerClear.addEventListener('click', clearSticker);
    }
  }

  // Reaplica el estado cuando el subpanel sea inyectado o abierto por el flujo de Ajustes.
  updateControls();
  bind();
  try {
    window.applyGlasstrackVisualSettings?.(settings);
  } catch (_) {}
  waitForStickerDb();
})();


/* B38: cuenta móvil ya enlazada junto a openAccount; se evita un segundo listener. */


/* B35 BUGFIX: aislamiento táctil móvil de Letras. Evita clics fantasma de la UI inferior. */
(() => {
  const panel = document.getElementById('lyrics-panel');
  const body = document.body;
  if (!panel || !body || body.dataset.mobileLyricsLayerPatch === '1') return;
  body.dataset.mobileLyricsLayerPatch = '1';

  const sync = () => {
    const mobile = body.classList.contains('mobile-layout') ||
      body.classList.contains('mobile-mode') ||
      body.classList.contains('mobile-layout-active') ||
      body.classList.contains('mobile-mode-active');
    const open = panel.classList.contains('active');
    const shouldIsolate = mobile && open && !document.getElementById('cinema-mode')?.classList.contains('active');
    if (body.classList.contains('mobile-lyrics-exclusive-active') !== shouldIsolate) {
      body.classList.toggle('mobile-lyrics-exclusive-active', shouldIsolate);
    }
  };

  const panelObserver = new MutationObserver(sync);
  panelObserver.observe(panel, { attributes: true, attributeFilter: ['class'] });
  const bodyObserver = new MutationObserver(sync);
  bodyObserver.observe(body, { attributes: true, attributeFilter: ['class'] });
  sync();
  window.addEventListener('resize', sync, { passive: true });
})();


/* B35 BUGFIX: sincronización de capa exclusiva de Cine para todos los flujos existentes. */
(() => {
  const cinema = document.getElementById('cinema-mode');
  if (!cinema || cinema.dataset.exclusiveLayerObserver === '1') return;
  cinema.dataset.exclusiveLayerObserver = '1';
  let lastState = null;
  const sync = () => {
    const enabled = cinema.classList.contains('active');
    if (enabled === lastState) return;
    lastState = enabled;
    if (typeof setCinemaExclusiveUI === 'function') setCinemaExclusiveUI(enabled);
    if (enabled) {
      document.body.classList.remove('mobile-lyrics-exclusive-active');
    } else {
      document.body.classList.remove('cinema-exclusive-active');
      if (!document.body.classList.contains('focus-mode')) {
        document.body.classList.remove('mobile-ui-hidden');
      }
    }
  };
  new MutationObserver(sync).observe(cinema, { attributes: true, attributeFilter: ['class'] });
  sync();
})();

/* B39 BUGFIX: account modal lifecycle cleanup + reversible exclusive cinema layers. */


/* B48 — Balance L/R: selección visual compatible; los tonos los deriva CSS de --primary-color. */
(function initSegmentedBalanceLR() {
  const modeSelect = document.getElementById('balance-lr-color-mode');
  const desktopRange = document.getElementById('input-audio-balance');
  const mobileRange = document.getElementById('mobile-eq-balance');
  const desktopOutput = document.getElementById('audio-balance-value');
  const mobileOutput = document.getElementById('mobile-eq-balance-value');
  const modeKey = 'glasstrackBalanceColorMode';

  const applyMode = (mode, persist = false) => {
    const normalized = mode === 'interface' ? 'interface' : 'gradient';
    document.documentElement.dataset.balanceColorMode = normalized;
    if (modeSelect && modeSelect.value !== normalized) modeSelect.value = normalized;
    if (persist) {
      try { localStorage.setItem(modeKey, normalized); } catch (_) {}
    }
  };

  const describeValue = raw => {
    const value = Math.max(-1, Math.min(1, Number(raw) || 0));
    if (Math.abs(value) < 0.025) return 'Centro · 0%';
    const percent = Math.round(Math.abs(value) * 100);
    return value < 0 ? `L · ${percent}%` : `R · ${percent}%`;
  };

  const syncLabel = () => {
    const value = desktopRange ? desktopRange.value : (mobileRange ? mobileRange.value : 0);
    const label = describeValue(value);
    if (desktopOutput) desktopOutput.textContent = label;
    if (mobileOutput) mobileOutput.textContent = label;
    if (desktopRange) desktopRange.setAttribute('aria-valuetext', label);
    if (mobileRange) mobileRange.setAttribute('aria-valuetext', label);
  };

  let savedMode = 'gradient';
  try {
    const stored = localStorage.getItem(modeKey);
    if (stored === 'interface' || stored === 'gradient') savedMode = stored;
  } catch (_) {}
  applyMode(savedMode, false);

  modeSelect?.addEventListener('change', () => {
    applyMode(modeSelect.value, true);
  });
  desktopRange?.addEventListener('input', syncLabel);
  mobileRange?.addEventListener('input', syncLabel);
  syncLabel();
})();


/* Glasstrack Pro B50 — apariencia de Karaoke aislada. No modifica el motor de letras ni la calibración. */
(() => {
  'use strict';
  const root = document.getElementById('karaoke-mode');
  const video = document.getElementById('karaoke-background-video');
  const coverBg = document.getElementById('karaoke-background-cover');
  const canvas = document.getElementById('karaoke-background-waves');
  const modeSelect = document.getElementById('karaoke-background-mode');
  const colorInput = document.getElementById('karaoke-background-color');
  const colorRow = document.getElementById('karaoke-bg-color-row');
  const videoRow = document.getElementById('karaoke-bg-video-row');
  const fileInput = document.getElementById('karaoke-background-file');
  const settingsModal = document.getElementById('karaoke-settings-modal');
  const closeSettings = document.getElementById('btn-close-karaoke-settings');
  const closeKaraoke = document.getElementById('btn-close-karaoke');
  let objectUrl = '';
  let raf = 0;
  let lastSize = '';
  let freq = null;
  let lastVideoWasPlaying = false;
  const storageMode = 'glasstrackKaraokeBackgroundMode_b50';
  const storageColor = 'glasstrackKaraokeBackgroundColor_b50';

  function selectedMode() { return ['normal','black','white','custom','animated','cover','video'].includes(modeSelect?.value) ? modeSelect.value : 'normal'; }
  function syncCoverImage() {
    const cover = document.getElementById('karaoke-cover');
    const src = cover?.currentSrc || cover?.getAttribute('src') || '';
    if (coverBg && src && src !== 'about:blank') coverBg.src = src;
    else if (coverBg) coverBg.removeAttribute('src');
  }
  function applyBackground(mode, persist = true) {
    if (!root) return;
    const valid = ['normal','black','white','custom','animated','cover','video'].includes(mode) ? mode : 'normal';
    root.dataset.bg = valid;
    if (modeSelect && modeSelect.value !== valid) modeSelect.value = valid;
    if (colorRow) colorRow.hidden = valid !== 'custom';
    if (videoRow) videoRow.hidden = valid !== 'video';
    if (colorInput) root.style.setProperty('--karaoke-custom-bg', colorInput.value || '#11131b');
    if (valid === 'cover') syncCoverImage();
    if (valid === 'video' && video?.src) {
      const playPromise = video.play();
      if (playPromise?.catch) playPromise.catch(() => {});
    } else if (video && !video.paused) video.pause();
    if (persist) { try { localStorage.setItem(storageMode, valid); } catch (_) {} }
    startAnimationIfNeeded();
  }
  function resizeCanvas() {
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.round(box.width * dpr));
    const h = Math.max(1, Math.round(box.height * dpr));
    const key = `${w}x${h}`;
    if (key !== lastSize) { canvas.width = w; canvas.height = h; lastSize = key; }
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return {ctx, width: box.width, height: box.height};
  }
  function getAudioData() {
    const analyser = (typeof concludorAnalyser !== 'undefined' && concludorAnalyser) ? concludorAnalyser : (window.glasstrackAnalyser || null);
    if (!analyser || typeof analyser.getByteFrequencyData !== 'function') return null;
    try {
      if (!freq || freq.length !== analyser.frequencyBinCount) freq = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(freq);
      return freq;
    } catch (_) { return null; }
  }
  function drawWaves() {
    raf = 0;
    if (!root?.classList.contains('active') || selectedMode() !== 'animated' || document.hidden) return;
    const sized = resizeCanvas();
    if (sized?.ctx && sized.width && sized.height) {
      const {ctx,width,height} = sized;
      ctx.clearRect(0,0,width,height);
      const data = getAudioData();
      let energy = 0;
      if (data?.length) { for (let i=2;i<Math.min(40,data.length);i++) energy += data[i]; energy = energy / Math.max(1,Math.min(38,data.length-2)) / 255; }
      const accent = getComputedStyle(root).getPropertyValue('--primary-color').trim() || '#72d9ff';
      const mid = height * .58;
      for (let wave=0; wave<4; wave++) {
        ctx.beginPath();
        for (let x=0; x<=width; x+=4) {
          const idx = data?.length ? Math.min(data.length-1, Math.floor((x/Math.max(1,width))*data.length*.7)) : 0;
          const bin = data?.[idx] ? data[idx]/255 : 0;
          const amplitude = 8 + (energy*35) + bin*(18 + wave*2);
          const y = mid + Math.sin(x*.014 + performance.now()*.0008 + wave*1.15)*amplitude + Math.sin(x*.0045 - performance.now()*.00045 + wave)*amplitude*.45;
          if (x===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        }
        ctx.strokeStyle = accent;
        ctx.globalAlpha = .26 + wave*.1;
        ctx.lineWidth = wave===0 ? 2.2 : 1.1;
        ctx.shadowColor = accent; ctx.shadowBlur = wave===0 ? 12 : 5;
        ctx.stroke();
      }
      // Líneas sutiles de fondo sincronizadas con la energía, sin cubrir las letras.
      ctx.globalAlpha = .12 + energy*.18; ctx.shadowBlur = 0; ctx.lineWidth = 1;
      for (let i=0;i<13;i++) {
        const x = (width/13)*i + ((performance.now()*.012 + i*7) % Math.max(1,width/13));
        const h = 8 + (data?.[i*2] || 0)/255*height*.16;
        ctx.beginPath(); ctx.moveTo(x,mid-h); ctx.lineTo(x,mid+h); ctx.strokeStyle=accent; ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    }
    raf = requestAnimationFrame(drawWaves);
  }
  function startAnimationIfNeeded() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (root?.classList.contains('active') && selectedMode()==='animated' && !document.hidden) raf = requestAnimationFrame(drawWaves);
  }
  modeSelect?.addEventListener('change', () => applyBackground(selectedMode()));
  colorInput?.addEventListener('input', () => {
    root?.style.setProperty('--karaoke-custom-bg', colorInput.value);
    try { localStorage.setItem(storageColor, colorInput.value); } catch (_) {}
  });
  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('video/')) { fileInput.value = ''; return; }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    if (video) { video.src = objectUrl; video.load(); }
    applyBackground('video');
  });
  const coverEl = document.getElementById('karaoke-cover');
  if (coverEl && typeof MutationObserver !== 'undefined') new MutationObserver(syncCoverImage).observe(coverEl, {attributes:true, attributeFilter:['src']});
  const openSettings = document.getElementById('btn-karaoke-settings');
  const openSettingsSecondary = document.getElementById('btn-karaoke-settings-open');
  // Cierre específico por controles de Karaoke: no propaga clics a los botones del reproductor.
  closeSettings?.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); settingsModal?.classList.remove('active'); settingsModal?.setAttribute('aria-hidden','true'); });
  settingsModal?.addEventListener('keydown', (event) => { if (event.key==='Escape') { event.stopPropagation(); settingsModal.classList.remove('active'); settingsModal.setAttribute('aria-hidden','true'); } });
  closeKaraoke?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeKaraokeMode();
  }, true);
  const mo = new MutationObserver(() => startAnimationIfNeeded());
  if (root) mo.observe(root, {attributes:true, attributeFilter:['class']});
  document.addEventListener('visibilitychange', startAnimationIfNeeded);
  window.addEventListener('resize', () => { lastSize=''; startAnimationIfNeeded(); }, {passive:true});
  window.addEventListener('pagehide', () => { if (raf) cancelAnimationFrame(raf); raf=0; if (objectUrl) URL.revokeObjectURL(objectUrl); });
  let initialMode='normal', initialColor='#11131b';
  try { initialMode=localStorage.getItem(storageMode)||'normal'; initialColor=localStorage.getItem(storageColor)||initialColor; } catch (_) {}
  if (colorInput) colorInput.value = /^#[0-9a-f]{6}$/i.test(initialColor) ? initialColor : '#11131b';
  if (openSettings || openSettingsSecondary) { /* listeners originales conservan el mismo flujo de apertura */ }
  applyBackground(initialMode, false);
})();

/* =========================================================
   GLASSTRACK PRO B57 — TANDA 1 / PANEL EXCLUSIVITY + AUTO FIT
   Aislado del motor de audio. Mantiene la adaptación avanzada
   desactivada de forma predeterminada.
   ========================================================= */
(() => {
  'use strict';

  const body = document.body;
  const root = document.documentElement;
  const eq = document.getElementById('eq-panel');
  const vm = document.getElementById('vm-panel');
  const lyrics = document.getElementById('lyrics-panel');
  const closeMobilePlayer = document.getElementById('btn-close-mobile-player');
  const autoFitToggle = document.getElementById('toggle-mobile-auto-fit');
  const mobileModeActive = () => [
    'mobile-layout', 'mobile-mode', 'mobile-layout-active', 'mobile-mode-active'
  ].some(name => body.classList.contains(name));

  const panelSpecs = {
    eq: { panel: eq, button: document.getElementById('btn-eq-toggle'), isOpen: () => !!eq && !eq.classList.contains('hidden') },
    vm: { panel: vm, button: document.getElementById('btn-vm-toggle'), isOpen: () => !!vm && !vm.classList.contains('hidden') },
    lyrics: { panel: lyrics, button: document.getElementById('btn-lyrics-toggle'), isOpen: () => !!lyrics && lyrics.classList.contains('active') }
  };
  const mobileButtons = {
    eq: document.getElementById('mobile-player-eq'),
    vm: document.getElementById('mobile-player-vm'),
    lyrics: document.getElementById('mobile-player-lyrics')
  };

  function closePanel(name) {
    const spec = panelSpecs[name];
    if (!spec?.panel) return;
    if (name === 'lyrics') spec.panel.classList.remove('active');
    else spec.panel.classList.add('hidden');
  }

  function syncPanelButtons() {
    Object.entries(panelSpecs).forEach(([name, spec]) => {
      const opened = spec.isOpen();
      [spec.button, mobileButtons[name]].filter(Boolean).forEach(button => {
        button.classList.toggle('is-panel-open', opened);
        button.setAttribute('aria-expanded', String(opened));
      });
      spec.panel?.setAttribute('aria-hidden', String(!opened));
    });
  }

  // En móvil los tres paneles comparten una sola superficie: nunca deben
  // permanecer abiertos uno encima de otro. En PC conservan su comportamiento.
  document.addEventListener('click', event => {
    if (!mobileModeActive() || document.getElementById('karaoke-mode')?.classList.contains('active')) return;
    const clicked = event.target.closest('#btn-eq-toggle, #btn-vm-toggle, #btn-lyrics-toggle');
    if (!clicked) return;
    const name = clicked.id === 'btn-eq-toggle' ? 'eq' : clicked.id === 'btn-vm-toggle' ? 'vm' : 'lyrics';
    const current = panelSpecs[name];
    if (!current?.panel) return;

    const isCurrentOpen = current.isOpen();
    // Si se vuelve a pulsar el panel abierto, este se cierra y no se ejecuta
    // el listener antiguo que solo sabía volver a abrir Letras.
    if (isCurrentOpen) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closePanel(name);
      try { if (typeof playSFX === 'function') playSFX('close'); } catch (_) {}
      syncPanelButtons();
      scheduleOverflowCheck();
      return;
    }

    Object.keys(panelSpecs).forEach(other => { if (other !== name) closePanel(other); });
    // Deja continuar el listener original para abrir/inicializar el panel elegido.
    requestAnimationFrame(() => { syncPanelButtons(); scheduleOverflowCheck(); });
  }, true);

  // Mantiene coherencia al cerrar un panel desde su propia X o por otro flujo.
  ['btn-close-eq', 'btn-close-vm', 'btn-close-lyrics'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => requestAnimationFrame(syncPanelButtons), true);
  });
  if (typeof MutationObserver !== 'undefined') {
    [eq, vm, lyrics].filter(Boolean).forEach(panel => {
      new MutationObserver(() => requestAnimationFrame(syncPanelButtons))
        .observe(panel, { attributes: true, attributeFilter: ['class'] });
    });
  }
  syncPanelButtons();

  function syncMobileCloseButton() {
    if (!closeMobilePlayer) return;
    const visible = mobileModeActive() && body.classList.contains('mobile-player-expanded') &&
      !!document.getElementById('player-card')?.classList.contains('mobile-expanded');
    closeMobilePlayer.setAttribute('aria-hidden', String(!visible));
    closeMobilePlayer.tabIndex = visible ? 0 : -1;
  }
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(syncMobileCloseButton).observe(body, { attributes: true, attributeFilter: ['class'] });
    const playerForClose = document.getElementById('player-card');
    if (playerForClose) new MutationObserver(syncMobileCloseButton).observe(playerForClose, { attributes: true, attributeFilter: ['class'] });
  }
  syncMobileCloseButton();

  // Adaptación avanzada opcional. CSS responsive básico no depende de este switch.
  const autoFitKey = 'glasstrackMobileAutoFitEnabled';
  let lastOverflowWidth = 0;
  let checkPending = false;
  let tightActive = false;
  try { autoFitToggle && (autoFitToggle.checked = localStorage.getItem(autoFitKey) === 'true'); } catch (_) {
    if (autoFitToggle) autoFitToggle.checked = false;
  }

  function setAutoFitEnabled(enabled, persist = false) {
    root.classList.toggle('mobile-auto-fit-enabled', !!enabled);
    if (!enabled) {
      root.classList.remove('mobile-auto-fit-tight');
      tightActive = false;
      lastOverflowWidth = 0;
    }
    if (persist) {
      try { localStorage.setItem(autoFitKey, enabled ? 'true' : 'false'); } catch (_) {}
    }
    if (enabled) scheduleOverflowCheck();
  }

  function relevantOverflowingElements() {
    return [
      document.querySelector('.top-global-bar'),
      document.querySelector('.player-card.mobile-expanded .top-bar'),
      document.querySelector('.player-card.mobile-expanded .controls'),
      document.getElementById('mobile-player-actions'),
      document.querySelector('#cinema-mode.active .cinema-controls'),
      document.querySelector('#cinema-mode.active .cinema-seekbar-wrapper'),
      document.querySelector('#cinema-mode.active .cinema-cover-col'),
      document.querySelector('#cinema-mode.active .cinema-volume-row')
    ].filter(el => el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden');
  }

  function detectOverflow() {
    const viewportWidth = Math.max(1, root.clientWidth || window.innerWidth);
    for (const el of relevantOverflowingElements()) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && (rect.left < -1 || rect.right > viewportWidth + 1)) return true;
      const allowsInternalScroll = el.matches('.lyrics-body, .lyrics-panel, .eq-panel, #vm-panel');
      if (!allowsInternalScroll && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 3) return true;
      const kids = Array.from(el.children).filter(child => {
        const style = getComputedStyle(child);
        const r = child.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });
      for (let i = 0; i < kids.length; i++) {
        const a = kids[i].getBoundingClientRect();
        if (a.left < rect.left - 2 || a.right > rect.right + 2) return true;
        for (let j = i + 1; j < kids.length; j++) {
          const b = kids[j].getBoundingClientRect();
          const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlapX > 3 && overlapY > 3) return true;
        }
      }
    }
    return false;
  }

  function runOverflowCheck() {
    checkPending = false;
    const enabled = !!autoFitToggle?.checked && mobileModeActive();
    if (!enabled) {
      if (root.classList.contains('mobile-auto-fit-tight')) root.classList.remove('mobile-auto-fit-tight');
      tightActive = false;
      lastOverflowWidth = 0;
      return;
    }
    const width = Math.max(1, root.clientWidth || window.innerWidth);
    const overflow = detectOverflow();
    if (overflow) {
      if (!tightActive) {
        tightActive = true;
        lastOverflowWidth = width;
      }
      root.classList.add('mobile-auto-fit-tight');
      return;
    }
    // Evita oscilaciones: solo se retira el modo compacto tras un aumento claro
    // del ancho disponible, no en cada ResizeObserver tras aplicar el ajuste.
    if (tightActive && width >= lastOverflowWidth + 72) {
      root.classList.remove('mobile-auto-fit-tight');
      tightActive = false;
      lastOverflowWidth = 0;
      if (detectOverflow()) {
        root.classList.add('mobile-auto-fit-tight');
        tightActive = true;
        lastOverflowWidth = width;
      }
    }
  }

  function scheduleOverflowCheck() {
    if (checkPending) return;
    checkPending = true;
    requestAnimationFrame(runOverflowCheck);
  }

  autoFitToggle?.addEventListener('change', () => {
    setAutoFitEnabled(autoFitToggle.checked, true);
  });
  // Los observadores solo programan una medición ligera; no mutan estilos de audio.
  window.addEventListener('resize', scheduleOverflowCheck, { passive: true });
  window.addEventListener('orientationchange', scheduleOverflowCheck, { passive: true });
  ['btn-cinema-mode', 'btn-close-cinema', 'mobile-nowplaying-bar', 'btn-close-mobile-player', 'toggle-mobile-layout']
    .forEach(id => document.getElementById(id)?.addEventListener('click', () => scheduleOverflowCheck(), true));
  window.visualViewport?.addEventListener('resize', scheduleOverflowCheck, { passive: true });
  if (typeof ResizeObserver !== 'undefined') {
    const autoFitResizeObserver = new ResizeObserver(scheduleOverflowCheck);
    autoFitResizeObserver.observe(root);
    relevantOverflowingElements().forEach(el => autoFitResizeObserver.observe(el));
  }
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(scheduleOverflowCheck).observe(body, { attributes: true, attributeFilter: ['class'] });
  }
  setAutoFitEnabled(!!autoFitToggle?.checked, false);
})();


/* =========================================================
   B61 — TANDA 2: CONTENCIÓN DEL SCROLL DEL REPRODUCTOR MÓVIL
   Impide que la rueda/scroll mueva la página o la tarjeta expandida;
   se conserva el desplazamiento nativo de zonas con contenido largo.
   ========================================================= */
(() => {
  'use strict';
  const SCROLL_ZONE_SELECTOR = [
    '#mobile-inline-lyrics', '.mobile-inline-lyrics', '.mobile-inline-lyrics-body',
    '.lyrics-body', '#cinema-lyrics-body', '.cinema-lyrics-col',
    '.settings-panel', '.settings-sub-panel', '.sub-content',
    '.modal-scroll-area', '.modal-window', '.rhythm-settings-window',
    '.rhythm-view', '.karaoke-lyrics-body', '.karaoke-settings-window',
    '.visual-editor-controls', '.library-content', '.playlist-view'
  ].join(',');

  const hasVerticalScrollRoom = (element) => {
    if (!element || element === document.body || element === document.documentElement) return false;
    const style = window.getComputedStyle(element);
    const permitsScroll = /(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`);
    return permitsScroll && element.scrollHeight > element.clientHeight + 1;
  };

  const isIntentionalScrollZone = (target) => {
    if (!(target instanceof Element)) return false;
    let element = target.closest(SCROLL_ZONE_SELECTOR);
    while (element) {
      if (hasVerticalScrollRoom(element)) return true;
      const parent = element.parentElement;
      element = parent ? parent.closest(SCROLL_ZONE_SELECTOR) : null;
    }
    return false;
  };

  document.addEventListener('wheel', (event) => {
    if (!document.body.classList.contains('mobile-player-expanded')) return;
    if (isIntentionalScrollZone(event.target)) return;
    // No se cancela el gesto de controles horizontales/inputs, solo el scroll exterior.
    if (event.target instanceof Element && event.target.closest('input[type="range"], button, select, textarea')) return;
    event.preventDefault();
  }, { capture: true, passive: false });
})();
