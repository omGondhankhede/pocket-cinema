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

// ROBUST STREAM PROXY (Passes correct Referer headers so video chunks load)
app.get('/proxy-stream', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing stream URL');

  try {
    const upstreamRes = await fetch(targetUrl, {
      headers: {
        'Referer': 'https://www.moviesnexus.fun/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!upstreamRes.ok) {
      return res.status(upstreamRes.status).send('Failed to fetch stream chunk');
    }

    const contentType = upstreamRes.headers.get('content-type') || 'application/vnd.apple.mpegurl';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');

    // If it's the master m3u8 playlist, rewrite chunk URLs to route through our proxy
    let bodyText = await upstreamRes.text();
    if (targetUrl.includes('.m3u8')) {
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      const lines = bodyText.split('\n');
      const rewrittenLines = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const absoluteChunkUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
          return `/proxy-stream?url=${encodeURIComponent(absoluteChunkUrl)}`;
        }
        return line;
      });
      res.send(rewrittenLines.join('\n'));
    } else {
      res.send(bodyText);
    }
  } catch (err) {
    res.status(500).send('Proxy error: ' + err.message);
  }
});

// LIGHTNING-FAST DIRECT API EXTRACTOR (0 seconds lag, no headless browser needed!)
async function resolveStreamDirectly(tmdbParam) {
  console.log(`\n[FastApiResolver] Resolving target: ${tmdbParam}`);
  
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
    const pageUrl = `https://www.moviesnexus.fun/${mediaType === 'tv' ? `tv/${tmdbId}/${season}/${episode}` : `movie/${tmdbId}`}`;
    
    // Call the internal moviesnexus extraction API directly with proper headers
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
      if (data) {
        const streamUrl = data.url || (data.sources && data.sources[0] && (data.sources[0].file || data.sources[0].url));
        if (streamUrl) {
          console.log(`[FastApiResolver] ✅ Successfully extracted stream URL instantly!`);
          return streamUrl;
        }
      }
    }
    console.log(`[FastApiResolver] ⚠️ API returned invalid payload.`);
    return null;
  } catch (err) {
    console.error(`[FastApiResolver] Error: ${err.message}`);
    return null;
  }
}

app.get('/resolve', async (req, res) => {
  const tmdbParam = req.query.tmdb || '550';
  console.log(`\n=========================================`);
  console.log(`[*] Request to resolve target: ${tmdbParam}`);
  
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
