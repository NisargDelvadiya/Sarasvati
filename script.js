// ─── Audio & State ────────────────────────────────────────────────────────────

const currentSong = new Audio()
currentSong.crossOrigin = "anonymous"

let songs = []
let currFolder
let lastVolume = 0.5
let isDragging = false
let currentIndex = 0
let baseIndex = 0
let baseFolder
let baseSongs = []
let lastSaveTime = 0
let queueMode = false
let loopMode = false
let queue = []
let queueWindowOpen = false
let manuallyMutedViaSlider = false

// Web Audio API nodes
let audioCtx, analyser, source, dataArray, gainNode

// Cached waveform gradient — rebuilt only when canvas resizes
let cachedGradient = null
let cachedCanvasHeight = 0

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Converts seconds to MM:SS string
 * @param {number} seconds
 * @returns {string}
 */
const secondsToMinutesSeconds = (seconds) => {
    if (isNaN(seconds) || seconds < 0) return "00:00"
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

/**
 * Triggers a brief scale-down press animation on an element
 * @param {Element} el
 */
const pressBtnEffect = (el) => {
    if (!el) return
    el.classList.add("btn-pressed")
    setTimeout(() => el.classList.remove("btn-pressed"), 150)
}

// ─── Persistence ──────────────────────────────────────────────────────────────

/**
 * Saves queue-related state to localStorage
 */
const saveQueueState = () => {
    try {
        localStorage.setItem("queueMode", queueMode)
        localStorage.setItem("loopMode", loopMode)
        localStorage.setItem("queue", JSON.stringify(queue))
        localStorage.setItem("queueWindowOpen", queueWindowOpen)
        localStorage.setItem("baseFolder", baseFolder || "")
        localStorage.setItem("baseIndex", baseIndex)
    } catch (err) {
        console.error("saveQueueState error:", err)
    }
}

// ─── Song Loading ─────────────────────────────────────────────────────────────

/**
 * Fetches song list from a folder.
 * Falls back to JSON manifest if available (recommended for production/deployment).
 * @param {string} folder
 */
const getSongs = async (folder) => {
    try {
        currFolder = folder

        // Try JSON manifest first (faster, works on all hosts)
        const jsonRes = await fetch(`Assets/Songs/${folder}/songs.json`)
        if (jsonRes.ok) {
            songs = await jsonRes.json()
            if (!Array.isArray(songs) || songs.length === 0) throw new Error("Empty JSON manifest")
            return
        }

        // Fallback: parse directory listing (only works on local/Apache servers)
        const res = await fetch(`Assets/Songs/${folder}/`)
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
                // songs.push(a.href.split(`Assets/Songs/${folder}/`)[1])
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
 * Updates the OS lock screen / notification media metadata
 * @param {string} track - encoded filename
 * @param {string} folder - folder name
 */
const updateMediaSession = (track, folder) => {
    if (!("mediaSession" in navigator)) return
    try {
        const displayTitle = decodeURIComponent(track).replace(".mp3", "") || "Unknown Track"
        const displayAlbum = decodeURIComponent(folder) || "Unknown Album"
        const artworkUrl = `Assets/Playlist%20Cover%20Images/${encodeURIComponent(folder)}.jpg`
        navigator.mediaSession.metadata = new MediaMetadata({
            title: decodeURIComponent(track).replace(".mp3", ""),
            artist: "AudioPhile",
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

// ─── Playback ─────────────────────────────────────────────────────────────────

/**
 * Shared internal function that sets audio source and updates UI.
 * @param {string} track
 * @param {string} folder
 * @param {boolean} pause - if true, load without playing
 */
const _loadTrack = (track, folder, pause) => {
    currentSong.src = `Assets/Songs/${folder}/` + track
    currentSong.volume = gainNode ? 1 : lastVolume
    if (gainNode) gainNode.gain.value = lastVolume
    localStorage.setItem("lastFolder", folder)
    localStorage.setItem("lastSong", track)
    document.querySelector(".songinfo_playbar").innerHTML = decodeURIComponent(track).replace(".mp3", "")
    if (!pause) {
        currentSong.play().catch(err => console.error("Playback error:", err))
        document.querySelector("#play").src = "Assets/Icons/resume.svg"
        updateMediaSession(track, folder)
    } else {
        document.querySelector("#play").src = "Assets/Icons/play.svg"
    }
}

/**
 * Plays a track from the queue (different folder/songList possible).
 * Does NOT update baseIndex/baseFolder — preserves natural next-song flow.
 * @param {string} track
 * @param {string} folder
 * @param {string[]} songList
 */
const playMusicDirect = (track, folder, songList) => {
    currFolder = folder
    songs = songList
    currentIndex = songs.indexOf(track)
    if (currentIndex === -1) currentIndex = 0
    _loadTrack(track, folder, false)
}

/**
 * Plays a track from within the current folder.
 * Updates baseIndex/baseFolder so next/prev work correctly after queue empties.
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
 * Advances to the next track respecting loop, queue, and default order
 */
const playNextSong = () => {
    if (loopMode) {
        currentSong.currentTime = 0
        currentSong.play().catch(err => console.error("Playback error:", err))
        return
    }
    if (queueMode && queue.length > 0) {
        const item = queue.shift()
        saveQueueState()
        renderQueueWindow()
        playMusicDirect(item.track, item.folder, item.songs)
        return
    }
    if (!baseSongs.length) return
    currFolder = baseFolder
    songs = baseSongs
    playMusicInFolder(baseSongs[(baseIndex + 1) % baseSongs.length])
}

/**
 * Goes to the previous track respecting loop and default order
 */
const playPrevSong = () => {
    if (loopMode) {
        currentSong.currentTime = 0
        currentSong.play().catch(err => console.error("Playback error:", err))
        return
    }
    if (!baseSongs.length) return
    currFolder = baseFolder
    songs = baseSongs
    playMusicInFolder(baseSongs[(baseIndex - 1 + baseSongs.length) % baseSongs.length])
}

// ─── Queue UI ─────────────────────────────────────────────────────────────────

/**
 * Rebuilds the queue panel DOM from the current queue array
 */
const renderQueueWindow = () => {
    const list = document.querySelector(".queue-list")
    if (!list) return
    list.innerHTML = ""
    if (!queue.length) {
        list.innerHTML = `<div class="queue-empty">Queue is empty</div>`
        return
    }
    const fragment = document.createDocumentFragment()
    queue.forEach((item, index) => {
        const div = document.createElement("div")
        div.className = "queue-item"

        const nameSpan = document.createElement("span")
        nameSpan.className = "queue-item-name"
        nameSpan.textContent = decodeURIComponent(item.track).replace(".mp3", "")

        const removeBtn = document.createElement("button")
        removeBtn.className = "queue-remove"
        removeBtn.setAttribute("aria-label", "Remove from queue")
        removeBtn.innerHTML = `<img src="Assets/Icons/queue-cross.svg" width="12" height="12" alt="Remove">`
        removeBtn.addEventListener("click", (e) => {
            e.stopPropagation()
            queue.splice(index, 1)
            saveQueueState()
            renderQueueWindow()
        })

        div.append(nameSpan, removeBtn)
        div.addEventListener("click", () => {
            const song = queue.splice(index, 1)[0]
            saveQueueState()
            renderQueueWindow()
            playMusicDirect(song.track, song.folder, song.songs)
        })
        fragment.appendChild(div)
    })
    list.appendChild(fragment)
}

/**
 * Shows or hides the queue panel with animation
 * @param {boolean} visible
 */
const setQueueWindowVisible = (visible) => {
    queueWindowOpen = visible
    saveQueueState()
    const panel = document.querySelector(".queue-panel")
    const arrowBtn = document.querySelector("#queue-arrow")
    if (!panel || !arrowBtn) return
    panel.classList.toggle("open", visible)
    arrowBtn.classList.toggle("rotated", visible)
}

// ─── Song List UI ─────────────────────────────────────────────────────────────

/**
 * Rebuilds the sidebar song list for the current folder.
 * Uses DocumentFragment for a single DOM insertion — fast even with 100+ songs.
 */
const updateSongList = () => {
    const songUL = document.querySelector(".songlists ul")
    songUL.innerHTML = ""
    const fragment = document.createDocumentFragment()
    songs.forEach((song, index) => {
        const li = document.createElement("li")
        const icon = document.createElement("div")
        icon.className = "songlists-icon"
        icon.innerHTML = `<img class="" width="24" src="Assets/Icons/music.png" alt="">`
        const info = document.createElement("div")
        info.className = "songinfo"
        const span = document.createElement("span")
        span.textContent = decodeURIComponent(song).replace(".mp3", "")
        info.appendChild(span)
        li.append(icon, info)
        li.addEventListener("click", () => {
            pressBtnEffect(li)
            if (queueMode) {
                queue.push({ track: song, folder: currFolder, songs: [...songs] })
                saveQueueState()
                renderQueueWindow()
            } else {
                playMusicInFolder(songs[index])
            }
        })
        fragment.appendChild(li)
    })
    songUL.appendChild(fragment)
}

// ─── Time Restore ─────────────────────────────────────────────────────────────

/**
 * Restores saved playback position after metadata loads
 * @param {Element} circle
 * @param {Element} fill
 * @param {string} savedTime
 */
const restoreTime = (circle, fill, savedTime) => {
    const apply = () => {
        const t = parseFloat(savedTime)
        if (isNaN(t) || currentSong.duration <= 0) return
        currentSong.currentTime = t
        const pct = (t / currentSong.duration) * 100
        circle.style.left = pct + "%"
        fill.style.width = pct + "%"
        document.querySelector(".songtime").textContent =
            `${secondsToMinutesSeconds(t)} / ${secondsToMinutesSeconds(currentSong.duration)}`
    }
    currentSong.readyState >= 1 ? apply() : currentSong.addEventListener("loadedmetadata", apply, { once: true })
}

// ─── Volume Helpers ───────────────────────────────────────────────────────────

/**
 * Updates the volume slider UI gradient
 * @param {HTMLInputElement} input
 * @param {number} value - 0 to 100
 */
const updateVolSlider = (input, value) => {
    input.value = value
    input.style.background = `linear-gradient(to right, #bb86fc ${value}%, #ffffff ${value}%)`
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const main = async () => {
    // DOM references
    const left = document.querySelector(".left")
    const play = document.querySelector("#play")
    const next = document.querySelector("#next")
    const previous = document.querySelector("#previous")
    const volumeInput = document.querySelector(".volumerange input")
    const volumeIcon = document.querySelector("#volumeIcon")
    const seekbar = document.querySelector(".seekbar")
    const circle = document.querySelector(".circle")
    const fill = document.querySelector(".seekbar-fill")
    const canvas = document.querySelector("#waveform")
    const canvasCtx = canvas.getContext("2d")
    const queueBtn = document.querySelector("#queue-btn")
    const loopBtn = document.querySelector("#loop-btn")
    const queueArrow = document.querySelector("#queue-arrow")
    const songtime = document.querySelector(".songtime")
    const playbar = document.querySelector(".playbar")

    // ── Restore state ──
    const savedFolder = localStorage.getItem("lastFolder")
    const savedSong = localStorage.getItem("lastSong")
    const savedVolume = localStorage.getItem("lastVolume")
    const savedTime = localStorage.getItem("lastTime")
    const savedBaseFolder = localStorage.getItem("baseFolder")
    const savedBaseIndex = localStorage.getItem("baseIndex")

    queueMode = localStorage.getItem("queueMode") === "true"
    loopMode = localStorage.getItem("loopMode") === "true"
    queueWindowOpen = localStorage.getItem("queueWindowOpen") === "true"

    try {
        const raw = localStorage.getItem("queue")
        queue = raw ? JSON.parse(raw) : []
    } catch { queue = [] }

    left.classList.toggle("open", localStorage.getItem("sidebarOpen") === "true")

    if (queueMode) {
        queueBtn.classList.add("active")
        queueArrow.classList.add("show")
        playbar.classList.add("queue-active")
    }
    if (loopMode) loopBtn.classList.add("active")

    renderQueueWindow()
    if (queueWindowOpen && queueMode) setQueueWindowVisible(true)

    // ── Volume init ──
    lastVolume = savedVolume !== null ? parseFloat(savedVolume) : 0.5
    updateVolSlider(volumeInput, lastVolume * 100)

    // ── Initial song load ──
    const defaultFolder = "Śrī Kṛṣṇa"
    circle.style.left = "0%"
    fill.style.width = "0%"
    songtime.textContent = "00:00 / 00:00"

    if (!savedSong) {
        await getSongs(defaultFolder)
        updateSongList()
        if (songs.length) playMusicInFolder(songs[0], true)
    } else {
        await getSongs(savedFolder || defaultFolder)
        updateSongList()
        if (songs.length) {
            playMusicInFolder(savedSong, true)
            if (savedTime) restoreTime(circle, fill, savedTime)
        }
    }

    // ── Restore base folder ──
    if (savedBaseFolder) {
        baseFolder = savedBaseFolder
        baseIndex = parseInt(savedBaseIndex) || 0
        if (baseFolder === currFolder) {
            baseSongs = [...songs]
        } else {
            try {
                const r = await fetch(`Assets/Songs/${baseFolder}/`)
                if (r.ok) {
                    const text = await r.text()
                    const div = document.createElement("div")
                    div.innerHTML = text
                    const anchors = div.getElementsByTagName("a")
                    baseSongs = []
                    for (const a of anchors) {
                        if (a.href.endsWith(".mp3")) baseSongs.push(a.href.split(`Assets/Songs/${baseFolder}/`)[1])
                    }
                }
            } catch (err) {
                console.error("restoreBase error:", err)
                baseFolder = currFolder
                baseSongs = [...songs]
                baseIndex = currentIndex
            }
        }
    } else {
        baseFolder = currFolder
        baseSongs = [...songs]
        baseIndex = currentIndex
    }

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
            gainNode.gain.value = lastVolume > 0 ? lastVolume : 0.5
            analyser.fftSize = 256
            dataArray = new Uint8Array(analyser.frequencyBinCount)
            startWaveform()
        } catch (err) {
            console.error("initAudioContext error:", err)
        }
    }

    // ── Waveform — gradient cached, only redraws when playing ──
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
                cachedGradient.addColorStop(0, "#bb86fc99")
                cachedGradient.addColorStop(1, "#bb86fc")
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

    // ── Seekbar helpers ──
    const updateUI = (percent) => {
        percent = Math.min(Math.max(0, percent), 100)
        circle.style.left = percent + "%"
        fill.style.width = percent + "%"
        return percent
    }

    const seekTo = (percent) => {
        if (!isNaN(currentSong.duration) && currentSong.duration > 0) {
            currentSong.currentTime = (currentSong.duration * percent) / 100
        }
    }

    const getSeekPercent = (e) => {
        const rect = seekbar.getBoundingClientRect()
        const clientX = e.clientX ?? (e.touches?.[0]?.clientX ?? 0)
        return ((clientX - rect.left) / rect.width) * 100
    }

    // ── Mute / unmute ──
    const doMute = () => {
        const vol = gainNode ? gainNode.gain.value : parseFloat(volumeInput.value) / 100
        if (vol > 0) {
            lastVolume = vol
            manuallyMutedViaSlider = false
            if (gainNode) gainNode.gain.value = 0
            updateVolSlider(volumeInput, 0)
            volumeIcon.src = "Assets/Icons/mute.svg"
            localStorage.setItem("lastVolume", 0)
        } else {
            const restore = manuallyMutedViaSlider ? 0.5 : lastVolume
            if (gainNode) gainNode.gain.value = restore
            updateVolSlider(volumeInput, restore * 100)
            volumeIcon.src = "Assets/Icons/volume.svg"
            localStorage.setItem("lastVolume", restore)
            lastVolume = restore
            manuallyMutedViaSlider = false
        }
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

    // Init audio context on first interaction
    document.addEventListener("click", initAudioContext, { once: true })
    document.addEventListener("keydown", initAudioContext, { once: true })

    // Cards
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

    // Playback controls
    play.addEventListener("click", togglePlay)

    next.addEventListener("click", () => {
        pressBtnEffect(next)
        initAudioContext()
        playNextSong()
    })

    previous.addEventListener("click", () => {
        pressBtnEffect(previous)
        initAudioContext()
        playPrevSong()
    })

    loopBtn.addEventListener("click", () => {
        pressBtnEffect(loopBtn)
        loopMode = !loopMode
        loopBtn.classList.toggle("active", loopMode)
        saveQueueState()
    })

    queueBtn.addEventListener("click", () => {
        pressBtnEffect(queueBtn)
        queueMode = !queueMode
        queueBtn.classList.toggle("active", queueMode)
        queueMode ? queueArrow.classList.add("show") : queueArrow.classList.remove("show")
        playbar.classList.toggle("queue-active", queueMode)
        setQueueWindowVisible(queueMode)
        saveQueueState()
    })

    queueArrow.addEventListener("click", () => setQueueWindowVisible(!queueWindowOpen))

    volumeIcon.addEventListener("click", () => {
        pressBtnEffect(volumeIcon.parentElement)
        doMute()
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
                pressBtnEffect(next)
                next.click()
                break
            case "ArrowLeft":
                pressBtnEffect(previous)
                previous.click()
                break
            case "ArrowUp":
                e.preventDefault()
                if (queueMode) setQueueWindowVisible(true)
                break
            case "ArrowDown":
                e.preventDefault()
                if (queueMode) setQueueWindowVisible(false)
                break
            case "l": case "L":
                pressBtnEffect(loopBtn)
                loopBtn.click()
                break
            case "q": case "Q":
                pressBtnEffect(queueBtn)
                queueBtn.click()
                break
            case "m": case "M":
                pressBtnEffect(volumeIcon.parentElement)
                doMute()
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
        if (
            left.contains(e.target) ||
            e.target.closest(".card") ||
            e.target.closest(".songbuttons") ||
            e.target.closest(".loop-queue") ||
            e.target.closest("#queue-arrow") ||
            e.target.closest(".vol") ||
            e.target.closest(".seekbar") ||
            e.target.closest(".queue-panel")
        ) return
        left.classList.remove("open")
        localStorage.setItem("sidebarOpen", "false")
    })

    // Seekbar time update — throttled localStorage write
    currentSong.addEventListener("timeupdate", () => {
        if (isDragging) return
        const pct = (currentSong.currentTime / currentSong.duration) * 100
        songtime.textContent = `${secondsToMinutesSeconds(currentSong.currentTime)} / ${secondsToMinutesSeconds(currentSong.duration)}`
        updateUI(pct)
        const now = Date.now()
        if (now - lastSaveTime > 5000) {
            localStorage.setItem("lastTime", currentSong.currentTime)
            lastSaveTime = now
        }
    })

    // Seekbar drag
    seekbar.addEventListener("mousedown", (e) => {
        isDragging = true
        document.body.classList.add("no-select")
        seekbar.classList.add("dragging")
        updateUI(getSeekPercent(e))
        const onMove = (e) => updateUI(getSeekPercent(e))
        document.addEventListener("mousemove", onMove)
        document.addEventListener("mouseup", (e) => {
            document.removeEventListener("mousemove", onMove)
            document.body.classList.remove("no-select")
            seekbar.classList.remove("dragging")
            seekTo(updateUI(getSeekPercent(e)))
            isDragging = false
        }, { once: true })
    })

    seekbar.addEventListener("click", (e) => {
        if (!isDragging) seekTo(updateUI(getSeekPercent(e)))
    })

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

    // Song ended
    currentSong.addEventListener("ended", playNextSong)

    // Media Session playback state sync
    currentSong.addEventListener("pause", () => {
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"
    })
    currentSong.addEventListener("play", () => {
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"
    })

    // Media Session action handlers (lock screen controls)
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

    // Volume slider
    volumeInput.addEventListener("input", e => {
        const value = parseFloat(e.target.value)
        if (gainNode) gainNode.gain.value = value / 100
        localStorage.setItem("lastVolume", value / 100)
        updateVolSlider(volumeInput, value)
        volumeIcon.src = value === 0 ? "Assets/Icons/mute.svg" : "Assets/Icons/volume.svg"
        if (value === 0) {
            manuallyMutedViaSlider = true
        } else {
            manuallyMutedViaSlider = false
            lastVolume = value / 100
        }
    })

    // Prevent right-click and common copy/save shortcuts
    document.addEventListener("contextmenu", e => e.preventDefault())
    document.addEventListener("keydown", e => {
        if ((e.ctrlKey || e.metaKey) && ["s", "u", "p", "a", "c"].includes(e.key.toLowerCase())) {
            e.preventDefault()
        }
    })
}

main().catch(err => console.error("App init error:", err))