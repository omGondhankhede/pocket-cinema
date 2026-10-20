const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('PocketFlix Cinema Backend is Live & Running!');
});

io.on('connection', (socket) => {
  socket.on('join_room', (roomCode) => {
    socket.join(roomCode);
    if (roomCode && roomCode !== 'undefined') {
      console.log(`[+] Device joined Room: ${roomCode}`);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Cloud Server running on port ${PORT}`);
});
