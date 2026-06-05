// ─── Audio & State ────────────────────────────────────────────────────────────

/** Base URL for all audio files stored in Supabase public storage */
const SUPABASE_BASE = "https://cwmndkvftbhtybzkwvqv.supabase.co/storage/v1/object/public/Audio Files"

/**
 * The single shared Audio element used for all playback.
 * crossOrigin is required for Web Audio API analysis across origins.
 */
const currentSong = new Audio()
currentSong.crossOrigin = "anonymous"

/** @type {string[]} Currently loaded song filenames for the active folder */
let songs = []

/** @type {string} Currently displayed/loaded folder name */
let currFolder

/** @type {number} Index of the currently playing song in `songs` */
let currentIndex = 0

/**
 * "Base" state — the last folder/song/index the user explicitly clicked.
 * Used so next/prev navigation always stays within that folder.
 */
let baseIndex = 0
let baseFolder
let baseSongs = []

/** Timestamp of the last localStorage time-save to throttle writes */
let lastSaveTime = 0

/** @type {boolean} True while the YouTube iframe modal is open */
let ytModalActive = false

// ─── Web Audio API nodes ──────────────────────────────────────────────────────

/** @type {AudioContext} */
let audioCtx

/** @type {AnalyserNode} */
let analyser

/** @type {MediaElementAudioSourceNode} */
let source

/** @type {Uint8Array} Frequency data buffer for waveform rendering */
let dataArray

/** @type {GainNode} Master gain node */
let gainNode

// ─── Waveform gradient cache ──────────────────────────────────────────────────

/** @type {CanvasGradient|null} Cached gradient — rebuilt only on height change */
let cachedGradient = null

/** @type {number} Canvas height at the time the gradient was last built */
let cachedCanvasHeight = 0

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Triggers a brief scale-down "press" animation on a DOM element.
 * CSS class `.btn-pressed` handles the actual transform.
 * @param {Element} el - The element to animate
 */
const pressBtnEffect = (el) => {
    if (!el) return
    el.classList.add("btn-pressed")
    setTimeout(() => el.classList.remove("btn-pressed"), 150)
}

// ─── Song Loading ─────────────────────────────────────────────────────────────

/**
 * Fetches the song list for a given folder.
 * Prefers a local JSON manifest (`audio files.json`); falls back to
 * parsing anchor tags from a directory listing response.
 * On any error, `songs` is reset to an empty array.
 * @param {string} folder - Folder name under `Assets/Audio Files/`
 */
const getSongs = async (folder) => {
    try {
        currFolder = folder
        const jsonRes = await fetch(`Assets/Audio Files/${folder}/audio files.json`)
        if (jsonRes.ok) {
            songs = await jsonRes.json()
            if (!Array.isArray(songs) || songs.length === 0) throw new Error("Empty JSON manifest")
            return
        }
        const res = await fetch(`Assets/Audio Files/${folder}/`)
        if (!res.ok) throw new Error(`Folder not found: ${folder}`)
        const text = await res.text()
        const div = document.createElement("div")
        div.innerHTML = text
        const anchors = div.getElementsByTagName("a")
        songs = []
        for (const a of anchors) {
            const href = a.getAttribute("href")
            if (a.href.endsWith(".mp3")) {
                const parts = href.split("/")
                const fileName = parts[parts.length - 1]
                if (fileName) songs.push(fileName)
            }
        }
        if (songs.length === 0) throw new Error(`No songs in folder: ${folder}`)
    } catch (err) {
        console.error("getSongs error:", err)
        songs = []
    }
}

// ─── Media Session ────────────────────────────────────────────────────────────

/**
 * Updates the OS lock-screen / notification-area media metadata.
 * Safe to call on browsers that do not support the Media Session API.
 * @param {string} track  - Encoded filename (e.g. "Song%20Name.mp3")
 * @param {string} folder - Folder name, used to locate the cover image
 */
const updateMediaSession = (track, folder) => {
    if (!("mediaSession" in navigator)) return
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: decodeURIComponent(track).replace(".mp3", ""),
            album: decodeURIComponent(folder),
            artwork: [
                { src: `Assets/Playlist Cover Images/${folder}.jpg`, sizes: "512x512", type: "image/jpeg" },
                { src: `Assets/Playlist Cover Images/${folder}.jpg`, sizes: "256x256", type: "image/jpeg" }
            ]
        })
        navigator.mediaSession.playbackState = "playing"
    } catch (err) {
        console.error("updateMediaSession error:", err)
    }
}

// ─── Active Song Highlight ────────────────────────────────────────────────────

/**
 * Applies a yellow `.active` border to the sidebar list item that corresponds
 * to `track`. Clears all existing highlights first.
 * If the YouTube modal is currently open, no item is highlighted (audio is not playing).
 * @param {string} track - Filename of the currently playing track
 */
const highlightActiveSong = (track) => {
    document.querySelectorAll(".songlists ul li").forEach(li => li.classList.remove("active"))
    if (ytModalActive) return
    const items = document.querySelectorAll(".songlists ul li")
    const idx = songs.indexOf(track)
    if (idx !== -1 && items[idx]) items[idx].classList.add("active")
}

// ─── Playback ─────────────────────────────────────────────────────────────────

/**
 * Internal track loader — sets the audio src, optionally starts playback,
 * and syncs all related UI (icon, title, highlight, localStorage).
 * @param {string}  track  - Filename of the track to load
 * @param {string}  folder - Folder that contains the track
 * @param {boolean} pause  - If true, load but do not auto-play
 */
const _loadTrack = (track, folder, pause) => {
    currentSong.src = `${SUPABASE_BASE}/${encodeURIComponent(folder)}/${track}`
    if (gainNode) gainNode.gain.value = 1
    localStorage.setItem("lastFolder", folder)
    localStorage.setItem("lastSong", track)
    highlightActiveSong(track)
    if (!pause) {
        currentSong.play().catch(err => console.error("Playback error:", err))
        document.querySelector("#play").src = "Assets/Icons/resume.svg"
        document.querySelector("#play").title = "Pause"
        updateMediaSession(track, folder)
    } else {
        document.querySelector("#play").src = "Assets/Icons/play.svg"
        document.querySelector("#play").title = "Play"
    }
}

/**
 * Plays a track within the currently loaded folder.
 * Also captures the "base" state (folder/songs/index) used by next/prev navigation.
 * If the YouTube modal is open it is closed first so audio and video don't overlap.
 * @param {string}  track         - Filename to play
 * @param {boolean} [pause=false] - Load without auto-playing when true
 */
const playMusicInFolder = (track, pause = false) => {
    if (ytModalActive) closeYTModal()
    currentIndex = songs.indexOf(track)
    baseIndex = currentIndex
    baseFolder = currFolder
    baseSongs = [...songs]
    _loadTrack(track, currFolder, pause)
}

/**
 * Advances playback to the next track in `baseSongs` (wraps around).
 * Restores folder context so next/prev always stays within the base folder.
 */
const playNextSong = () => {
    if (!baseSongs.length) return
    currFolder = baseFolder
    songs = baseSongs
    playMusicInFolder(baseSongs[(baseIndex + 1) % baseSongs.length])
}

/**
 * Goes back to the previous track in `baseSongs` (wraps around).
 * Restores folder context so next/prev always stays within the base folder.
 */
const playPrevSong = () => {
    if (!baseSongs.length) return
    currFolder = baseFolder
    songs = baseSongs
    playMusicInFolder(baseSongs[(baseIndex - 1 + baseSongs.length) % baseSongs.length])
}

// ─── YouTube Modal ────────────────────────────────────────────────────────────

/**
 * Map of song filenames to YouTube URLs.
 * Any song listed here will open the YouTube modal instead of playing audio.
 * Key   : exact filename string as stored in the JSON manifest.
 * Value : any YouTube URL format (youtu.be short, watch?v=, or /embed/).
 */
const YT_SONGS = {
    "Moha Mudgara.mp3": "https://youtu.be/noYKaEjwEeE?si=U2Kq_fCFOnDBmLC1"
}

/**
 * Converts any YouTube URL variant to the standard embed URL with autoplay.
 * Supports youtu.be short links, youtube.com/watch?v= links, and passthrough
 * for URLs already in embed format.
 * @param {string} url - Any YouTube URL
 * @returns {string}   - Embed URL with autoplay=1 & rel=0
 */
const toEmbedUrl = (url) => {
    try {
        const u = new URL(url)
        if (u.hostname === "youtu.be") {
            return `https://www.youtube.com/embed/${u.pathname.slice(1)}?autoplay=1&rel=0`
        }
        if ((u.hostname === "www.youtube.com" || u.hostname === "youtube.com") && u.searchParams.get("v")) {
            return `https://www.youtube.com/embed/${u.searchParams.get("v")}?autoplay=1&rel=0`
        }
        return url
    } catch {
        return url
    }
}

/**
 * Opens the draggable YouTube modal for a given song.
 * Pauses any active audio playback so audio and video do not overlap.
 * Centres the modal horizontally using pixel coordinates so drag works correctly.
 * @param {string} songName - Filename used as the modal title
 * @param {string} ytUrl    - YouTube URL to embed (any supported format)
 */
const openYTModal = (songName, ytUrl) => {
    const overlay = document.getElementById("yt-modal-overlay")
    const modal   = document.getElementById("yt-modal")
    const body    = document.getElementById("yt-modal-body")
    const titleEl = document.getElementById("yt-modal-title")

    // Pause audio so nothing plays in parallel with the video
    if (!currentSong.paused) {
        currentSong.pause()
        const playBtn = document.querySelector("#play")
        if (playBtn) { playBtn.src = "Assets/Icons/play.svg"; playBtn.title = "Play" }
    }

    ytModalActive = true

    // Clear the active song highlight — no audio song is "playing" right now
    document.querySelectorAll(".songlists ul li").forEach(li => li.classList.remove("active"))

    titleEl.textContent = decodeURIComponent(songName).replace(".mp3", "")
    body.innerHTML = ""

    const iframe = document.createElement("iframe")
    iframe.src = toEmbedUrl(ytUrl)
    iframe.title = titleEl.textContent
    iframe.frameBorder = "0"
    iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    iframe.allowFullscreen = true
    iframe.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:none;"
    body.appendChild(iframe)

    // Always pixel-position so drag never fights a CSS transform
    const vw = window.innerWidth
    const modalW = Math.min(640, vw * 0.92)
    modal.style.width     = modalW + "px"
    modal.style.left      = Math.round((vw - modalW) / 2) + "px"
    modal.style.top       = "80px"
    modal.style.transform = "none"

    overlay.setAttribute("aria-hidden", "false")
    overlay.classList.add("active")
    modal.classList.add("visible")
}

/**
 * Closes the YouTube modal and clears the embedded iframe (stops playback).
 * Restores the active song highlight for whichever audio track was last playing
 * if the user is still browsing the same folder.
 */
const closeYTModal = () => {
    const overlay = document.getElementById("yt-modal-overlay")
    const modal   = document.getElementById("yt-modal")
    const body    = document.getElementById("yt-modal-body")

    // Clearing innerHTML stops YouTube iframe playback immediately
    body.innerHTML = ""
    overlay.setAttribute("aria-hidden", "true")
    overlay.classList.remove("active")
    modal.classList.remove("visible")

    ytModalActive = false

    // Restore the active highlight for the last audio track (if in same folder)
    const savedSong   = localStorage.getItem("lastSong")
    const savedFolder = localStorage.getItem("lastFolder")
    if (savedSong && currFolder === savedFolder) {
        highlightActiveSong(savedSong)
    }
}

// Close button & Escape key
document.getElementById("yt-modal-close").addEventListener("click", closeYTModal)
window.addEventListener("keydown", e => { if (e.key === "Escape") closeYTModal() })

// ─── Drag Logic (Mouse + Touch) ───────────────────────────────────────────────

/**
 * IIFE that attaches drag-to-move behaviour to the YouTube modal.
 * Works on both desktop (mouse) and mobile (touch).
 * Uses pixel-based positioning only — no CSS transforms — so the
 * drag delta calculation is always accurate.
 */
;(() => {
    const header = document.getElementById("yt-modal-header")
    const modal  = document.getElementById("yt-modal")

    /** @type {boolean} Whether a drag gesture is currently in progress */
    let dragging = false

    /** Drag origin: pointer position and modal position at drag start */
    let startX = 0, startY = 0, startL = 0, startT = 0

    /**
     * Records the initial positions to begin a drag gesture.
     * @param {number} clientX
     * @param {number} clientY
     */
    const startDrag = (clientX, clientY) => {
        startL = parseFloat(modal.style.left) || 0
        startT = parseFloat(modal.style.top)  || 0
        startX = clientX
        startY = clientY
        dragging = true
    }

    /**
     * Updates the modal's pixel position during a drag, clamping to the viewport.
     * @param {number} clientX
     * @param {number} clientY
     */
    const moveDrag = (clientX, clientY) => {
        if (!dragging) return
        const newL = Math.max(0, Math.min(window.innerWidth  - modal.offsetWidth,  startL + clientX - startX))
        const newT = Math.max(0, Math.min(window.innerHeight - modal.offsetHeight, startT + clientY - startY))
        modal.style.left = newL + "px"
        modal.style.top  = newT + "px"
    }

    /** Ends the drag gesture */
    const endDrag = () => { dragging = false }

    // ── Mouse events (desktop) ────────────────────────────────────────────────

    header.addEventListener("mousedown", e => {
        if (e.button !== 0) return
        startDrag(e.clientX, e.clientY)
        document.body.classList.add("no-select")
        e.preventDefault()
    })
    window.addEventListener("mousemove", e => moveDrag(e.clientX, e.clientY))
    window.addEventListener("mouseup", () => {
        endDrag()
        document.body.classList.remove("no-select")
    })

    // ── Touch events (mobile) ─────────────────────────────────────────────────

    header.addEventListener("touchstart", e => {
        const t = e.touches[0]
        startDrag(t.clientX, t.clientY)
    }, { passive: true })
    window.addEventListener("touchmove", e => {
        if (!dragging) return
        const t = e.touches[0]
        moveDrag(t.clientX, t.clientY)
    }, { passive: true })
    window.addEventListener("touchend", endDrag, { passive: true })
})()

// ─── Song List UI ─────────────────────────────────────────────────────────────

/**
 * Rebuilds the sidebar song list from the current `songs` array.
 * Uses a DocumentFragment for a single DOM insertion (better performance).
 * YouTube songs get a special badge and open the modal on click;
 * regular songs call `playMusicInFolder`.
 * After rendering, re-applies the active highlight for the saved track.
 */
const updateSongList = () => {
    const songUL = document.querySelector(".songlists ul")
    songUL.innerHTML = ""
    const fragment = document.createDocumentFragment()

    songs.forEach((song, index) => {
        const isYT = Object.prototype.hasOwnProperty.call(YT_SONGS, song)
        const li = document.createElement("li")
        if (isYT) li.classList.add("yt-song")

        const icon = document.createElement("div")
        icon.className = "songlists-icon"
        icon.innerHTML = `<img width="24" src="Assets/Icons/music.png" alt="">`

        const info = document.createElement("div")
        info.className = "songinfo"
        const span = document.createElement("span")
        span.textContent = decodeURIComponent(song).replace(".mp3", "")
        info.appendChild(span)

        li.append(icon, info)

        if (isYT) {
            // YouTube badge + modal click handler
            const badge = document.createElement("span")
            badge.className = "yt-song-badge"
            badge.textContent = "▶ YouTube"
            li.appendChild(badge)
            li.addEventListener("click", () => {
                pressBtnEffect(li)
                openYTModal(song, YT_SONGS[song])
            })
        } else {
            // Regular audio click handler
            li.addEventListener("click", () => {
                pressBtnEffect(li)
                playMusicInFolder(songs[index])
            })
        }

        fragment.appendChild(li)
    })

    songUL.appendChild(fragment)

    // Re-highlight active track if it belongs to this folder
    const saved = localStorage.getItem("lastSong")
    if (saved && currFolder === localStorage.getItem("lastFolder")) {
        highlightActiveSong(saved)
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Application entry point.
 * - Restores sidebar & playback state from localStorage
 * - Initialises the Web Audio API lazily on first user gesture
 * - Starts the waveform animation loop
 * - Attaches all global event listeners (keyboard, swipe, media session, etc.)
 */
const main = async () => {
    const left      = document.querySelector(".left")
    const play      = document.querySelector("#play")
    const canvas    = document.querySelector("#waveform")
    const canvasCtx = canvas.getContext("2d")

    // ── Restore sidebar open/closed state ────────────────────────────────────
    const savedFolder = localStorage.getItem("lastFolder")
    const savedSong   = localStorage.getItem("lastSong")
    left.classList.toggle("open", localStorage.getItem("sidebarOpen") === "true")

    // ── Initial song load ─────────────────────────────────────────────────────
    const defaultFolder = "Krsna"

    if (!savedSong) {
        // First visit — load default folder, pre-select but don't auto-play
        await getSongs(defaultFolder)
        updateSongList()
        if (songs.length) {
            const firstSong = "Visnu_Sahasranama_Stotram.mp3"
            const target = songs.includes(firstSong) ? firstSong : songs[0]
            playMusicInFolder(target, true)
        }
    } else {
        // Returning visit — restore the last folder and song
        await getSongs(savedFolder || defaultFolder)
        updateSongList()
        if (songs.length) {
            playMusicInFolder(savedSong, true)
            const savedTime = localStorage.getItem("lastTime")
            if (savedTime) {
                // Apply saved position once metadata is available
                const apply = () => {
                    const t = parseFloat(savedTime)
                    if (!isNaN(t) && currentSong.duration > 0) currentSong.currentTime = t
                }
                currentSong.readyState >= 1
                    ? apply()
                    : currentSong.addEventListener("loadedmetadata", apply, { once: true })
            }
        }
    }

    // ── Restore base folder state for next/prev navigation ───────────────────
    baseFolder = currFolder
    baseSongs  = [...songs]
    baseIndex  = currentIndex

    // ── Audio Context (lazy — initialised on first user gesture) ─────────────

    /**
     * Creates and wires the Web Audio API graph:
     * MediaElementSource → AnalyserNode → GainNode → AudioContext.destination
     * No-ops if the context already exists.
     */
    const initAudioContext = () => {
        if (audioCtx) return
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)()
            analyser = audioCtx.createAnalyser()
            gainNode = audioCtx.createGain()
            source   = audioCtx.createMediaElementSource(currentSong)
            source.connect(analyser)
            analyser.connect(gainNode)
            gainNode.connect(audioCtx.destination)
            gainNode.gain.value = 1
            analyser.fftSize = 256
            dataArray = new Uint8Array(analyser.frequencyBinCount)
            startWaveform()
        } catch (err) {
            console.error("initAudioContext error:", err)
        }
    }

    // ── Waveform animation ────────────────────────────────────────────────────

    /**
     * Starts the requestAnimationFrame loop that draws the frequency-bar waveform
     * on the playbar canvas. The gradient is cached and only rebuilt when the
     * canvas height changes, keeping per-frame allocations near zero.
     */
    const startWaveform = () => {
        const draw = () => {
            requestAnimationFrame(draw)
            if (!analyser || currentSong.paused) return

            analyser.getByteFrequencyData(dataArray)

            const w = canvas.offsetWidth
            const h = canvas.offsetHeight

            // Sync canvas resolution to its CSS size
            if (canvas.width  !== w) canvas.width  = w
            if (canvas.height !== h) {
                canvas.height  = h
                cachedGradient = null  // invalidate cached gradient on resize
            }

            canvasCtx.clearRect(0, 0, w, h)

            // Rebuild gradient only when necessary
            if (!cachedGradient || cachedCanvasHeight !== h) {
                cachedGradient = canvasCtx.createLinearGradient(0, h, 0, 0)
                cachedGradient.addColorStop(0, "#ffff0099")
                cachedGradient.addColorStop(1, "#ffff00")
                cachedCanvasHeight = h
            }

            canvasCtx.fillStyle = cachedGradient
            const barWidth = (w / dataArray.length) * 2.5
            let x = 0
            for (const value of dataArray) {
                const barHeight = (value / 255) * h
                canvasCtx.fillRect(x, h - barHeight, barWidth - 1, barHeight)
                x += barWidth
            }
        }
        draw()
    }

    // ── Play / Pause toggle ───────────────────────────────────────────────────

    /**
     * Toggles playback state.
     * Also ensures the Audio Context is initialised (required after a user gesture).
     */
    const togglePlay = () => {
        initAudioContext()
        if (currentSong.paused) {
            currentSong.play().catch(err => console.error("Playback error:", err))
            play.src   = "Assets/Icons/resume.svg"
            play.title = "Pause"
        } else {
            currentSong.pause()
            play.src   = "Assets/Icons/play.svg"
            play.title = "Play"
        }
    }

    // ── Event Listeners ───────────────────────────────────────────────────────

    // Lazy-init Audio Context on first interaction (click or key)
    document.addEventListener("click",   initAudioContext, { once: true })
    document.addEventListener("keydown", initAudioContext, { once: true })

    // Playlist card clicks — load folder and open sidebar
    document.querySelectorAll(".card").forEach(card => {
        card.addEventListener("click", async () => {
            pressBtnEffect(card)
            const folder = card.dataset.folder
            await getSongs(folder)
            updateSongList()
            localStorage.setItem("lastFolder", folder)
            left.classList.add("open")
            localStorage.setItem("sidebarOpen", "true")
        })
    })

    // Play/pause button click
    play.addEventListener("click", () => {
        pressBtnEffect(play)
        togglePlay()
    })

    // Keyboard shortcuts
    window.addEventListener("keydown", e => {
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return
        switch (e.key) {
            case " ":
                // Space — toggle play/pause, prevent page scroll
                e.preventDefault()
                pressBtnEffect(play)
                togglePlay()
                play.blur()
                // Temporarily force default cursor to avoid flash of text-cursor
                document.documentElement.classList.add("force-cursor")
                requestAnimationFrame(() => document.documentElement.classList.remove("force-cursor"))
                break
            case "ArrowRight":
                initAudioContext()
                playNextSong()
                break
            case "ArrowLeft":
                initAudioContext()
                playPrevSong()
                break
            case "Escape":
                // Close sidebar
                left.classList.remove("open")
                localStorage.setItem("sidebarOpen", "false")
                break
        }
    })

    // Close sidebar when clicking outside of it (not on a card)
    document.addEventListener("click", e => {
        if (!left.classList.contains("open")) return
        if (left.contains(e.target) || e.target.closest(".card")) return
        left.classList.remove("open")
        localStorage.setItem("sidebarOpen", "false")
    })

    // Throttled save of playback position every 5 seconds
    currentSong.addEventListener("timeupdate", () => {
        const now = Date.now()
        if (now - lastSaveTime > 5000) {
            localStorage.setItem("lastTime", currentSong.currentTime)
            lastSaveTime = now
        }
    })

    // Auto-advance to next track when current one ends
    currentSong.addEventListener("ended", playNextSong)

    // Keep Media Session playback state in sync
    currentSong.addEventListener("pause", () => {
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"
    })
    currentSong.addEventListener("play", () => {
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"
    })

    // Media Session action handlers (lock screen / notification controls)
    if ("mediaSession" in navigator) {
        navigator.mediaSession.setActionHandler("play", () => {
            currentSong.play().catch(err => console.error("Playback error:", err))
            play.src = "Assets/Icons/resume.svg"
        })
        navigator.mediaSession.setActionHandler("pause", () => {
            currentSong.pause()
            play.src = "Assets/Icons/play.svg"
        })
        navigator.mediaSession.setActionHandler("nexttrack",     playNextSong)
        navigator.mediaSession.setActionHandler("previoustrack", playPrevSong)
        navigator.mediaSession.setActionHandler("seekto", ({ seekTime }) => {
            if (!isNaN(currentSong.duration) && currentSong.duration > 0) {
                currentSong.currentTime = seekTime
            }
        })
    }

    // ── Swipe-to-close sidebar (mobile) ──────────────────────────────────────

    /** @type {number} X coordinate where the swipe gesture started */
    let touchStartX = 0

    /** @type {number} Latest X coordinate during an active swipe */
    let touchCurrentX = 0

    /** @type {boolean} Whether a swipe is currently in progress */
    let isSwiping = false

    left.addEventListener("touchstart", (e) => {
        touchStartX = touchCurrentX = e.touches[0].clientX
        isSwiping = true
        left.style.transition = "none"  // disable transition during active swipe
    }, { passive: true })

    left.addEventListener("touchmove", (e) => {
        if (!isSwiping) return
        touchCurrentX = e.touches[0].clientX
        const diff = touchCurrentX - touchStartX
        if (diff < 0) {
            // Only translate leftward (closing direction)
            e.preventDefault()
            left.style.transform = `translateX(${diff}px)`
        }
    }, { passive: false })

    left.addEventListener("touchend", () => {
        if (!isSwiping) return
        isSwiping = false
        left.style.transition = "left 0.3s ease, transform 0.3s ease"
        const diff = touchCurrentX - touchStartX
        if (diff < -60) {
            // Swiped far enough left — close the sidebar
            left.style.transform = ""
            left.classList.remove("open")
            localStorage.setItem("sidebarOpen", "false")
        } else {
            // Not far enough — snap back
            left.style.transform = ""
        }
    })

    // ── Content protection ────────────────────────────────────────────────────

    // Block right-click context menu
    document.addEventListener("contextmenu", e => e.preventDefault())

    // Block common save / copy / inspect keyboard shortcuts
    document.addEventListener("keydown", e => {
        if ((e.ctrlKey || e.metaKey) && ["s", "u", "p", "a", "c"].includes(e.key.toLowerCase())) {
            e.preventDefault()
        }
    })
}

main().catch(err => console.error("App init error:", err))
