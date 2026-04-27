const express = require("express");
const http = require("http");
const { Server } = require("socket.io")
require("dotenv").config();

// ---- Setup ----

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "https://bastiaandm.github.io",
        methods: ["GET", "POST"]
    }
});
const sessions = {};

app.use(express.static("."));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

app.get("/turn-credentials", (req, res) => {
    res.json({
        urls: [
            process.env.TURN_URL,
            process.env.TURN_URL_TCP
        ],
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL
    });
});

// ---- Socket.io ----

io.on("connection", (socket) => {


    // ---- Session Management ----

    socket.on("create-session", () => {
        const code = Math.random().toString(36).substring(2,8).toUpperCase();
        sessions[code] = socket.id;
        socket.join(code);
        socket.emit("session-created", code);
        console.log(`Session created: ${code}`);
    });

    socket.on("join-session", (code) => {
        const rooms = io.sockets.adapter.rooms;
        if (rooms.has(code)) {
            socket.join(code);
            socket.emit("session-joined", code);
            socket.to(code).emit("user-joined", socket.id);
            console.log(`User joined session: ${code}`);
        } else {
            socket.emit("session-not-found");
        }
    });

    socket.on("disconnect", () => {
        for (const code in sessions) {
            if (sessions[code] === socket.id) {
                delete sessions[code];
            }
        }
        console.log("a user disconnected");
    });


    // ---- WebRTC Signaling ----

    socket.on("offer", (offer, code) => socket.to(code).emit("offer", offer));
    socket.on("answer", (answer, code) => socket.to(code).emit("answer", answer));
    socket.on("ice-candidate", (candidate, code) => socket.to(code).emit("ice-candidate", candidate));


    // ---- Photo ----
    
    socket.on("take-photos", (code) => io.to(code).emit("take-photos"));
});