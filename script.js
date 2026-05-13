// ─── Audio & State ────────────────────────────────────────────────────────────

const SUPABASE_BASE = "https://cwmndkvftbhtybzkwvqv.supabase.co/storage/v1/object/public/Audio Files";
const currentSong = new Audio()
currentSong.crossOrigin = "anonymous"

let songs = []
let currFolder
let currentIndex = 0
let baseIndex = 0
let baseFolder
let baseSongs = []
let lastSaveTime = 0

// Web Audio API nodes
let audioCtx, analyser, source, dataArray, gainNode

// Cached waveform gradient
let cachedGradient = null
let cachedCanvasHeight = 0

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Triggers a brief scale-down press animation on an element
 * @param {Element} el
 */
const pressBtnEffect = (el) => {
    if (!el) return
    el.classList.add("btn-pressed")
    setTimeout(() => el.classList.remove("btn-pressed"), 150)
}

// ─── Song Loading ─────────────────────────────────────────────────────────────

/**
 * Fetches song list from a folder via JSON manifest or directory listing fallback
 * @param {string} folder
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
 * Updates OS lock screen media metadata
 * @param {string} track
 * @param {string} folder
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
 * Sets yellow border on the currently playing song's list item
 * @param {string} track
 */
const highlightActiveSong = (track) => {
    document.querySelectorAll(".songlists ul li").forEach(li => {
        li.classList.remove("active")
    })
    const items = document.querySelectorAll(".songlists ul li")
    const idx = songs.indexOf(track)
    if (idx !== -1 && items[idx]) items[idx].classList.add("active")
}

// ─── Playback ─────────────────────────────────────────────────────────────────

/**
 * Internal track loader — sets src, plays/pauses, updates UI
 * @param {string} track
 * @param {string} folder
 * @param {boolean} pause
 */
const _loadTrack = (track, folder, pause) => {
    currentSong.src = `${SUPABASE_BASE}/${encodeURIComponent(folder)}/${track}`
    currentSong.volume = gainNode ? 1 : 1
    if (gainNode) gainNode.gain.value = 1
    localStorage.setItem("lastFolder", folder)
    localStorage.setItem("lastSong", track)
    highlightActiveSong(track)
    if (!pause) {
        currentSong.play().catch(err => console.error("Playback error:", err))
        document.querySelector("#play").src = "Assets/Icons/resume.svg"
        updateMediaSession(track, folder)
    } else {
        document.querySelector("#play").src = "Assets/Icons/play.svg"
    }
}

/**
 * Plays a track within the current folder, updating base state
 * @param {string} track
 * @param {boolean} [pause=false]
 */
const playMusicInFolder = (track, pause = false) => {
    currentIndex = songs.indexOf(track)
    baseIndex = currentIndex
    baseFolder = currFolder
    baseSongs = [...songs]
    _loadTrack(track, currFolder, pause)
}

/**
 * Advances to the next track
 */
const playNextSong = () => {
    if (!baseSongs.length) return
    currFolder = baseFolder
    songs = baseSongs
    playMusicInFolder(baseSongs[(baseIndex + 1) % baseSongs.length])
}

/**
 * Goes to the previous track
 */
const playPrevSong = () => {
    if (!baseSongs.length) return
    currFolder = baseFolder
    songs = baseSongs
    playMusicInFolder(baseSongs[(baseIndex - 1 + baseSongs.length) % baseSongs.length])
}

// ─── Song List UI ─────────────────────────────────────────────────────────────

/**
 * Rebuilds sidebar song list using DocumentFragment for performance
 */
const updateSongList = () => {
    const songUL = document.querySelector(".songlists ul")
    songUL.innerHTML = ""
    const fragment = document.createDocumentFragment()
    songs.forEach((song, index) => {
        const li = document.createElement("li")
        const icon = document.createElement("div")
        icon.className = "songlists-icon"
        icon.innerHTML = `<img width="24" src="Assets/Icons/music.png" alt="">`
        const info = document.createElement("div")
        info.className = "songinfo"
        const span = document.createElement("span")
        span.textContent = decodeURIComponent(song).replace(".mp3", "")
        info.appendChild(span)
        li.append(icon, info)
        li.addEventListener("click", () => {
            pressBtnEffect(li)
            playMusicInFolder(songs[index])
        })
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

const main = async () => {
    const left = document.querySelector(".left")
    const play = document.querySelector("#play")
    const canvas = document.querySelector("#waveform")
    const canvasCtx = canvas.getContext("2d")

    // ── Restore state ──
    const savedFolder = localStorage.getItem("lastFolder")
    const savedSong = localStorage.getItem("lastSong")

    left.classList.toggle("open", localStorage.getItem("sidebarOpen") === "true")

    // ── Initial song load ──
    const defaultFolder = "Krsna"

    // To this:
if (!savedSong) {
    await getSongs(defaultFolder)
    updateSongList()
    if (songs.length) {
    const firstSong = "Vishnu_Sahasranama_Stotram.mp3"
    const target = songs.includes(firstSong) ? firstSong : songs[0]
    playMusicInFolder(target, true)
}
} else {
    await getSongs(savedFolder || defaultFolder)
    updateSongList()
    if (songs.length) {
        playMusicInFolder(savedSong, true)
        const savedTime = localStorage.getItem("lastTime")
        if (savedTime) {
            const apply = () => {
                const t = parseFloat(savedTime)
                if (!isNaN(t) && currentSong.duration > 0) currentSong.currentTime = t
            }
            currentSong.readyState >= 1 ? apply() : currentSong.addEventListener("loadedmetadata", apply, { once: true })
        }
    }
}

    // ── Restore base folder ──
    baseFolder = currFolder
    baseSongs = [...songs]
    baseIndex = currentIndex

    // ── Audio Context (lazy init on first user gesture) ──
    const initAudioContext = () => {
        if (audioCtx) return
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)()
            analyser = audioCtx.createAnalyser()
            gainNode = audioCtx.createGain()
            source = audioCtx.createMediaElementSource(currentSong)
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

    // ── Waveform ──
    const startWaveform = () => {
        const draw = () => {
            requestAnimationFrame(draw)
            if (!analyser || currentSong.paused) return
            analyser.getByteFrequencyData(dataArray)
            const w = canvas.offsetWidth
            const h = canvas.offsetHeight
            if (canvas.width !== w) canvas.width = w
            if (canvas.height !== h) {
                canvas.height = h
                cachedGradient = null
            }
            canvasCtx.clearRect(0, 0, w, h)
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

    // ── Toggle play/pause ──
    const togglePlay = () => {
        initAudioContext()
        if (currentSong.paused) {
            currentSong.play().catch(err => console.error("Playback error:", err))
            play.src = "Assets/Icons/resume.svg"
        } else {
            currentSong.pause()
            play.src = "Assets/Icons/play.svg"
        }
    }

    // ── Event listeners ──

    document.addEventListener("click", initAudioContext, { once: true })
    document.addEventListener("keydown", initAudioContext, { once: true })

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

    play.addEventListener("click", () => {
        pressBtnEffect(play)
        togglePlay()
    })

    // Keyboard shortcuts
    window.addEventListener("keydown", e => {
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return
        switch (e.key) {
            case " ":
                e.preventDefault()
                pressBtnEffect(play)
                togglePlay()
                play.blur()
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
                left.classList.remove("open")
                localStorage.setItem("sidebarOpen", "false")
                break
        }
    })

    // Sidebar close on outside click
    document.addEventListener("click", e => {
        if (!left.classList.contains("open")) return
        if (left.contains(e.target) || e.target.closest(".card")) return
        left.classList.remove("open")
        localStorage.setItem("sidebarOpen", "false")
    })

    // Save time periodically
    currentSong.addEventListener("timeupdate", () => {
        const now = Date.now()
        if (now - lastSaveTime > 5000) {
            localStorage.setItem("lastTime", currentSong.currentTime)
            lastSaveTime = now
        }
    })

    currentSong.addEventListener("ended", playNextSong)

    // Media Session state sync
    currentSong.addEventListener("pause", () => {
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"
    })
    currentSong.addEventListener("play", () => {
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"
    })

    if ("mediaSession" in navigator) {
        navigator.mediaSession.setActionHandler("play", () => {
            currentSong.play().catch(err => console.error("Playback error:", err))
            play.src = "Assets/Icons/resume.svg"
        })
        navigator.mediaSession.setActionHandler("pause", () => {
            currentSong.pause()
            play.src = "Assets/Icons/play.svg"
        })
        navigator.mediaSession.setActionHandler("nexttrack", playNextSong)
        navigator.mediaSession.setActionHandler("previoustrack", playPrevSong)
        navigator.mediaSession.setActionHandler("seekto", ({ seekTime }) => {
            if (!isNaN(currentSong.duration) && currentSong.duration > 0) {
                currentSong.currentTime = seekTime
            }
        })
    }

    // Swipe to close sidebar on mobile
    let touchStartX = 0, touchCurrentX = 0, isSwiping = false

    left.addEventListener("touchstart", (e) => {
        touchStartX = touchCurrentX = e.touches[0].clientX
        isSwiping = true
        left.style.transition = "none"
    }, { passive: true })

    left.addEventListener("touchmove", (e) => {
        if (!isSwiping) return
        touchCurrentX = e.touches[0].clientX
        const diff = touchCurrentX - touchStartX
        if (diff < 0) {
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
            left.style.transform = ""
            left.classList.remove("open")
            localStorage.setItem("sidebarOpen", "false")
        } else {
            left.style.transform = ""
        }
    })

    // Prevent right-click and copy/save shortcuts
    document.addEventListener("contextmenu", e => e.preventDefault())
    document.addEventListener("keydown", e => {
        if ((e.ctrlKey || e.metaKey) && ["s", "u", "p", "a", "c"].includes(e.key.toLowerCase())) {
            e.preventDefault()
        }
    })
}

main().catch(err => console.error("App init error:", err))
