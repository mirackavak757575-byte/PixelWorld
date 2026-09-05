// Basit PixelWorld sunucusu
// Node.js + Express (statik dosya sunmak için) + ws (WebSocket için)

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const GRID_SIZE = 64;           // dünya 64x64 pixel
const SAVE_FILE = path.join(__dirname, 'world.json');
const COOLDOWN_MS = 3000;       // her pixel arası 3 saniye bekleme

// --- Dünyayı yükle (daha önce kaydedilmiş bir dosya varsa) ---
let world;
if (fs.existsSync(SAVE_FILE)) {
  world = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
  console.log('Dünya diskten yüklendi.');
} else {
  world = new Array(GRID_SIZE * GRID_SIZE).fill('#ffffff');
  console.log('Yeni boş dünya oluşturuldu.');
}

// Her kullanıcının (IP bazlı) son pixel koyma zamanı
const lastPlaced = {};

// Dünyayı periyodik olarak diske kaydet (her 10 saniyede bir)
setInterval(() => {
  fs.writeFileSync(SAVE_FILE, JSON.stringify(world));
}, 10000);

// --- Statik dosyaları sun (index.html, css, js vs. public klasöründen) ---
app.use(express.static(path.join(__dirname, 'public')));

// --- WebSocket bağlantıları ---
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log('Yeni bağlantı:', ip);

  // Yeni bağlanan kullanıcıya tüm dünyayı gönder
  ws.send(JSON.stringify({ type: 'world', world }));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return; // bozuk mesaj, yok say
    }

    if (msg.type === 'place') {
      const { x, y, color } = msg;

      // Sınır kontrolü
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return;

      // Cooldown kontrolü
      const now = Date.now();
      const last = lastPlaced[ip] || 0;
      if (now - last < COOLDOWN_MS) {
        // Çok erken geldi, reddet ve kalan süreyi bildir
        ws.send(JSON.stringify({
          type: 'cooldown',
          remaining: COOLDOWN_MS - (now - last)
        }));
        return;
      }
      lastPlaced[ip] = now;

      // Pixel'i güncelle
      world[y * GRID_SIZE + x] = color;

      // Bu pixel'i BÜTÜN bağlı kullanıcılara yay (kendisi dahil)
      const update = JSON.stringify({ type: 'update', x, y, color });
      wss.clients.forEach((client) => {
        if (client.readyState === 1) client.send(update);
      });
    }
  });

  ws.on('close', () => {
    console.log('Bağlantı kapandı:', ip);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});
