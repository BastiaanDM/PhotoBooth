// ---- Constants ----

const COUNTDOWN = 3;


//---- State ----

let photoIndex = 1;
let streaming = false;
let removeBackground = false;
let peerConnection = null;
let localStream = null;
let sessionCode = null;
let canvasStream = null;
let processingVideo = false;


// ---- Html Elements ----

const label = document.getElementById("date-label");
const video = document.getElementById("video");
const canvas = document.getElementById("output-canvas");
const ctx = canvas.getContext("2d");
const remoteVideo = document.getElementById("remote-video");
const strip = document.getElementById("strip"); 
const captureButton = document.getElementById("capture-button");
const toggleButton = document.getElementById("toggle-button");
const createSessionButton = document.getElementById("create-session-button");
const joinSessionButton = document.getElementById("join-session-button");
const sessionCodeInput = document.getElementById("session-code-input");
const sessionCodeDisplay = document.getElementById("session-code-display");
const sessionCodeEl = document.getElementById("session-code");
const sessionStatus = document.getElementById("session-status");


// ---- MediaPipe Segmentation Setup ----

const segmentation = new SelfieSegmentation({ locateFile: (file) =>
    `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
});

remoteVideo.autoplay = true;

segmentation.setOptions({ modelSelection: 1 });

segmentation.onResults((results) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(results.segmentationMask, 0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "source-in";
    ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "source-over";
});

async function processVideo() {
    if (!removeBackground) {
        processingVideo = false;
        return;
    }
    processingVideo = true;
    await segmentation.send({ image: video });
    requestAnimationFrame(processVideo);
}


// ---- Camera Setup ----

navigator.mediaDevices
.getUserMedia({ video: true, audio: false })
.then((stream) => {
    localStream = stream;
    video.srcObject = stream;
    video.style.display = "block";
    video.play();
})

video.addEventListener("canplay", () => {
    if (!streaming) {
        streaming = true;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
    }
});


// ---- WebRTC ----

function getActiveStream() {
    return removeBackground ? canvasStream : localStream;
}

async function createPeerConnection() {
    const turn = await getTurnCredentials();

    console.log("TURN RAW:", turn);
    console.log("URLs:", turn.urls, Array.isArray(turn.urls));
    console.log("USERNAME:", turn.username);
    console.log("CRED:", turn.credential);
    
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
        remoteVideo.style.display = "block";
        console.log("remote stream received!", event.streams[0]);
    };

    const activeStream = getActiveStream();
    activeStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, activeStream);
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

    console.log("TURN FROM SERVER:", data);

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
    if (removeBackground && !canvasStream) {
        canvasStream = canvas.captureStream(30);
    }
    if (removeBackground && !processingVideo) {
        processVideo();
    }
    toggleButton.textContent = `Remove Background: ${removeBackground ? "ON" : "OFF"}`;
    toggleButton.classList.toggle("active", removeBackground);
    video.style.display = removeBackground ? "none" : "block";
    canvas.style.display = removeBackground ? "block" : "none";

    if (peerConnection) {
        const newStream = getActiveStream();
        const videoTrack = newStream.getVideoTracks()[0];
        const sender = peerConnection.getSenders().find(s => s.track.kind === "video");
        if (sender) sender.replaceTrack(videoTrack);
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
    const source = removeBackground ? canvas : video;
    const width = removeBackground ? canvas.width : video.videoWidth;
    const height = removeBackground ? canvas.height : video.videoHeight;

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
    strip.style.visibility ="visible";
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
    const offscreen = new OffscreenCanvas(video.videoWidth, video.videoHeight);
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
    })
}

function foo(foo) {}


// ---- Init ----

clearPhoto();







