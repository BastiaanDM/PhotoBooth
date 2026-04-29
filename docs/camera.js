// ---- Constants ----

const COUNTDOWN = 3;

// ---- State ----

let photoIndex = 1;
let streaming = false;
let removeBackground = false;
let peerConnection = null;
let localStream = null;
let sessionCode = null;
let processingVideo = false;
let compositeMode = false;

// ---- Remote State ----

let remoteRemoveBackground = false;
let remoteProcessingVideo = false;

// ---- Html Elements ----

const label = document.getElementById("date-label");
const video = document.getElementById("video");
const canvas = document.getElementById("output-canvas");
const ctx = canvas.getContext("2d");
const remoteVideo = document.getElementById("remote-video");
const remoteCanvas = document.getElementById("remote-canvas");
const remoteCtx = remoteCanvas.getContext("2d");
const strip = document.getElementById("strip");
const captureButton = document.getElementById("capture-button");
const toggleButton = document.getElementById("toggle-button");
const createSessionButton = document.getElementById("create-session-button");
const joinSessionButton = document.getElementById("join-session-button");
const sessionCodeInput = document.getElementById("session-code-input");
const sessionCodeDisplay = document.getElementById("session-code-display");
const sessionCodeEl = document.getElementById("session-code");
const sessionStatus = document.getElementById("session-status");
const compositeCanvas = document.getElementById("composite-canvas");
const compositeCtx = compositeCanvas.getContext("2d");
const compositeSlot = document.getElementById("composite-slot");

// ---- Offscreen Buffers ----

const localBuffer = new OffscreenCanvas(1, 1);
const localBufCtx = localBuffer.getContext("2d");

const remoteBuffer = new OffscreenCanvas(1, 1);
const remoteBufCtx = remoteBuffer.getContext("2d");


// ---- MediaPipe Segmentation Setup ----

const segmentation = new SelfieSegmentation({ locateFile: (file) =>
    `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
});

const remoteSegmentation = new SelfieSegmentation({ locateFile: (file) =>
    `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
});

segmentation.setOptions({ modelSelection: 1 });
remoteSegmentation.setOptions({ modelSelection: 1 });

segmentation.onResults((results) => {
    localBuffer.width = results.image.width;
    localBuffer.height = results.image.height;
    localBufCtx.clearRect(0, 0, localBuffer.width, localBuffer.height);
    localBufCtx.drawImage(results.segmentationMask, 0, 0, localBuffer.width, localBuffer.height);
    localBufCtx.globalCompositeOperation = "source-in";
    localBufCtx.drawImage(results.image, 0, 0, localBuffer.width, localBuffer.height);
    localBufCtx.globalCompositeOperation = "source-over";
});

remoteSegmentation.onResults((results) => {
    remoteBuffer.width = results.image.width;
    remoteBuffer.height = results.image.height;
    remoteBufCtx.clearRect(0, 0, remoteBuffer.width, remoteBuffer.height);
    remoteBufCtx.drawImage(results.segmentationMask, 0, 0, remoteBuffer.width, remoteBuffer.height);
    remoteBufCtx.globalCompositeOperation = "source-in";
    remoteBufCtx.drawImage(results.image, 0, 0, remoteBuffer.width, remoteBuffer.height);
    remoteBufCtx.globalCompositeOperation = "source-over";
});

async function processVideo() {
    console.log("processVideo started");
    while (removeBackground) {
        await segmentation.send({ image: video });
    }
    processingVideo = false;
}

async function processRemoteVideo() {
    console.log("processRemoteVideo started");
    while (remoteRemoveBackground) {
        await remoteSegmentation.send({ image: remoteVideo });
    }
    remoteProcessingVideo = false;
}


// ---- Composite Draw Loop ----

function drawComposite() {
    const W = 320;
    const H = 240;

    if (removeBackground || remoteRemoveBackground) {
        compositeSlot.style.display = "flex";
        compositeCanvas.width = W;
        compositeCanvas.height = H;

        compositeCtx.clearRect(0, 0, W, H);

        if (removeBackground) {
            if (remoteVideo.readyState >= 2) {
                compositeCtx.drawImage(remoteVideo, 0, 0, W, H);
            }
            compositeCtx.drawImage(localBuffer, 0, 0, W, H);
        } else {
            compositeCtx.drawImage(video, 0, 0, W, H);
            compositeCtx.drawImage(remoteBuffer, 0, 0, W, H);
        }
    } else {
        compositeSlot.style.display = "none";
    }
    video.style.display = "block";
    canvas.style.display = "none";
    remoteCanvas.style.display = "none";

    requestAnimationFrame(drawComposite);
}


// ---- Camera Setup ----

navigator.mediaDevices
    .getUserMedia({ video: true, audio: false })
    .then((stream) => {
        localStream = stream;
        video.srcObject = stream;
        video.play();
    });

video.addEventListener("canplay", () => {
    if (!streaming) {
        streaming = true;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
    }
    drawComposite();
});


// ---- WebRTC ----

async function createPeerConnection() {
    const turn = await getTurnCredentials();

    peerConnection = new RTCPeerConnection({
        iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            {
                urls: turn.urls,
                username: turn.username,
                credential: turn.credential
            }
        ]
    });

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit("ice-candidate", event.candidate, sessionCode);
        }
    };

    peerConnection.ontrack = (event) => {
        remoteVideo.srcObject = event.streams[0];
        console.log("remote stream received!", event.streams[0]);
    };

    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    return peerConnection;
}

async function startCall() {
    await createPeerConnection();
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit("offer", offer, sessionCode);
}

async function handleOffer(offer) {
    await createPeerConnection();
    await peerConnection.setRemoteDescription(offer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit("answer", answer, sessionCode);
}

async function handleAnswer(answer) {
    await peerConnection.setRemoteDescription(answer);
}

async function handleIceCandidate(candidate) {
    await peerConnection.addIceCandidate(candidate);
}

async function getTurnCredentials() {
    const response = await fetch("https://photobooth-txp9.onrender.com/turn-credentials");
    const data = await response.json();

    if (!data.urls || !Array.isArray(data.urls)) {
        throw new Error("Invalid TURN config: missing urls");
    }

    return data;
}


// ---- Socket.io ----

let socket = null;
if (typeof io !== "undefined") {
    socket = io("https://photobooth-txp9.onrender.com");
} else {
    console.log("No server available, running in standalone mode");
}

if (!socket) {
    document.getElementById("session-ui").style.display = "none";
}

if (socket) {
    socket.on("session-created", (code) => {
        sessionCode = code;
        sessionCodeEl.textContent = code;
        sessionCodeDisplay.style.display = "block";
        sessionStatus.textContent = "Waiting for someone to join...";
    });

    socket.on("session-joined", (code) => {
        sessionCode = code;
        sessionStatus.textContent = `Joined session ${code}!`;
    });

    socket.on("session-not-found", () => {
        sessionStatus.textContent = "Session not found, check your code.";
    });

    socket.on("user-joined", () => {
        sessionStatus.textContent = "Someone joined your session!";
        startCall();
    });

    socket.on("offer", async (offer) => await handleOffer(offer));
    socket.on("answer", async (answer) => await handleAnswer(answer));
    socket.on("ice-candidate", async (candidate) => await handleIceCandidate(candidate));
    socket.on("take-photos", () => takePictures());

    socket.on("background-toggled", (state) => {
        remoteRemoveBackground = state;

        if (remoteRemoveBackground) {
            toggleButton.disabled = true;
            toggleButton.title = "Other person is already using this";
            if (!remoteProcessingVideo) {
                remoteProcessingVideo = true;
                processRemoteVideo();
            }
        } else {
            toggleButton.disabled = false;
            toggleButton.title = "";
        }
    });
}


// ---- Event Listeners ----

captureButton.addEventListener("click", (ev) => {
    if (socket && sessionCode) {
        socket.emit("take-photos", sessionCode);
    } else {
        takePictures();
    }
    ev.preventDefault();
});

toggleButton.addEventListener("click", () => {
    removeBackground = !removeBackground;

    if (removeBackground && !processingVideo) {
        processingVideo = true;
        processVideo();
    }

    toggleButton.textContent = `Remove Background: ${removeBackground ? "ON" : "OFF"}`;
    toggleButton.classList.toggle("active", removeBackground);

    if (socket && sessionCode) {
        socket.emit("toggle-background", sessionCode, removeBackground);
    }
});

createSessionButton.addEventListener("click", () => {
    if (socket) socket.emit("create-session");
});

joinSessionButton.addEventListener("click", () => {
    const code = sessionCodeInput.value.trim().toUpperCase();
    if (socket && code) socket.emit("join-session", code);
});


// ---- Photo Logic ----

function takePicture() {
    const inComposite = removeBackground || remoteRemoveBackground;
    const source = inComposite ? compositeCanvas : video;
    const width = inComposite ? compositeCanvas.width : video.videoWidth;
    const height = inComposite ? compositeCanvas.height : video.videoHeight;

    const offscreen = new OffscreenCanvas(width, height);
    const context = offscreen.getContext("2d");
    context.drawImage(source, 0, 0);

    offscreen.convertToBlob({ type: "image/png" }).then((blob) => {
        const photo = document.getElementById(`photo${photoIndex}`);
        photo.src = URL.createObjectURL(blob);
        photoIndex = photoIndex % 3 + 1;
    });
}
async function takePictures() {
    clearPhoto();
    await countdown(COUNTDOWN, showOverlay);

    for (let i = 0; i < 3; i++) {
        hideOverlay();
        takePicture();
        if (i < 2) {
            await countdown(1, foo);
            await countdown(COUNTDOWN, showOverlay);
        }
    }

    writeLabel();
    showStrip();
}


// ---- UI ----

function showOverlay(text) {
    document.getElementById("overlay")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "overlay";
    overlay.style.cssText = `
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9999;
    `;
    const span = document.createElement("span");
    span.style.cssText = `
        color: white;
        font-size: 8rem;
        font-weight: bold;
    `;
    span.textContent = text;
    overlay.appendChild(span);
    document.body.appendChild(overlay);
}

function hideOverlay() {
    document.getElementById("overlay")?.remove();
}

function showStrip() {
    strip.style.visibility = "visible";
}

function hideStrip() {
    strip.style.visibility = "hidden";
}

function writeLabel() {
    const date = new Date();
    const fullDate = date.getDate() + "/" + (date.getMonth() + 1) + "/" + date.getFullYear();
    label.textContent = fullDate;
}

function clearPhoto() {
    const offscreen = new OffscreenCanvas(video.videoWidth || 320, video.videoHeight || 240);
    const context = offscreen.getContext("2d");
    context.fillStyle = "#aaaaaa";
    hideStrip();
}


// ---- Helpers ----

function countdown(n, onTick) {
    return new Promise((resolve) => {
        let remaining = n;
        onTick(remaining);
        remaining--;
        const interval = setInterval(() => {
            onTick(remaining);
            remaining--;
            if (remaining < 0) {
                clearInterval(interval);
                resolve();
            }
        }, 1000);
    });
}

function foo() {}


// ---- Init ----

clearPhoto();