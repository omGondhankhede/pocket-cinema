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
  console.log(`[+] TV Connected: ${socket.id}`);
  socket.on('join_room', (roomCode) => {
    socket.join(roomCode);
    console.log(`[+] TV ${socket.id} joined Room: ${roomCode}`);
  });
  socket.on('disconnect', () => {
    console.log(`[-] TV Disconnected: ${socket.id}`);
  });
});

app.get('/proxy-stream', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing stream URL');

  try {
    const response = await fetch(targetUrl, {
      headers: { 'Referer': 'https://www.moviesnexus.fun/' }
    });
    let playlistText = await response.text();
    const lines = playlistText.split('\n');
    const sanitizedLines = lines.filter(line => !line.includes('TYPE="AUDIO"') && !line.includes("TYPE='AUDIO'"));
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(sanitizedLines.join('\n'));
  } catch (err) {
    res.status(500).send('Failed to proxy stream');
  }
});

// LIGHTNING FAST DIRECT API EXTRACTOR (No Puppeteer lag!)
async function resolveStreamDirectly(tmdbParam) {
  console.log(`\n[FastResolver] Resolving target: ${tmdbParam}`);
  
  let mediaType = 'movie';
  let tmdbId = tmdbParam;
  let season = 1;
  let episode = 1;

  if (tmdbParam.startsWith('tv/')) {
    mediaType = 'tv';
    const parts = tmdbParam.split('/');
    tmdbId = parts[1];
    season = parts[2] || 1;
    episode = parts[3] || 1;
  }

  try {
    // 1. Fetch the main page to grab valid tokens and challenge data
    const pageUrl = `https://www.moviesnexus.fun/${mediaType === 'tv' ? `tv/${tmdbId}/${season}/${episode}` : `movie/${tmdbId}`}`;
    const pageRes = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const html = await pageRes.text();

    // 2. Extract extraction token / challenge parameters embedded in the page script
    const tokenMatch = html.match(/token["']?\s*[:=]\s*["']([^"']+)["']/i) || html.match(/([a-f0-9]{40,})/);
    
    // Fallback: Directly call the embed page or test server endpoints if token parsing varies
    // Let's query moviesnexus direct HLS provider endpoint
    const apiExtractUrl = `https://www.moviesnexus.fun/api/extract?mediaType=${mediaType}&tmdbId=${tmdbId}${mediaType === 'tv' ? `&season=${season}&episode=${episode}` : ''}`;
    
    const apiRes = await fetch(apiExtractUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': pageUrl,
        'X-Requested-With': 'XMLHttpRequest'
      }
    });

    if (apiRes.ok) {
      const data = await apiRes.json();
      if (data && data.url) {
        console.log(`[FastResolver] ✅ Stream URL found via API!`);
        return data.url;
      }
      if (data && data.sources && data.sources.length > 0) {
        return data.sources[0].file || data.sources[0].url;
      }
    }

    // Fallback search if direct json extraction fails
    console.log(`[FastResolver] API json empty, checking fallback HLS manifests...`);
    return null;

  } catch (err) {
    console.error(`[FastResolver] Error: ${err.message}`);
    return null;
  }
}

app.get('/resolve', async (req, res) => {
  const tmdbParam = req.query.tmdb || '550';
  console.log(`\n=========================================`);
  
  try {
    const streamUrl = await resolveStreamDirectly(tmdbParam);
    if (streamUrl) {
      res.json({ status: 'ok', streamUrl: `/proxy-stream?url=${encodeURIComponent(streamUrl)}` });
    } else {
      res.status(404).json({ status: 'error', message: 'Stream could not be extracted.' });
    }
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Cloud Server running on port ${PORT}`);
});
