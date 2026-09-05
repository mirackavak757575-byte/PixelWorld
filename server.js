// PixelEmpire sunucusu
// Klasik pixel-pixel boyama. Cooldown yerine "sayaç" sistemi var:
// - Her oyuncunun bir sayacı var, 0'dan başlıyor, saniyede 1 azalıyor (zamanla erimesi)
// - Her pixel koyduğunda sayaç artıyor: genelde +1, ara sıra +4/+5/+6/+7 (rastgele)
// - Zaten boyalı bir pixelin üzerine FARKLI bir renk koyarsan, artış 2 katına çıkıyor
// - Sayaç 120'ye (2 dakika) ulaşınca/geçince yeni pixel KOYAMAZSIN, azalmasını beklemen lazım

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const SAVE_FILE = path.join(__dirname, 'pixels-state.json');

const MAX_COUNTER = 120;        // 2 dakika (saniye cinsinden)
const DECAY_PER_SECOND = 1;     // sayaç saniyede 1 azalır

// --- Pixelleri yükle ---
// pixels["x_y"] = "#renk"
let pixels = {};
if (fs.existsSync(SAVE_FILE)) {
  try {
    pixels = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    console.log('Kayıtlı pixel verisi yüklendi. Toplam pixel:', Object.keys(pixels).length);
  } catch (e) {
    console.log('Kayıt dosyası okunamadı, boş başlanıyor.');
  }
} else {
  console.log('Yeni boş dünya oluşturuldu.');
}

// --- Kullanıcı sayaçları (IP bazlı) ---
// userCounters[ip] = { value: number, lastUpdate: timestamp_ms }
const userCounters = {};

function getCurrentCounter(ip) {
  const rec = userCounters[ip];
  if (!rec) return 0;
  const elapsedSec = (Date.now() - rec.lastUpdate) / 1000;
  return Math.max(0, rec.value - elapsedSec * DECAY_PER_SECOND);
}

function randomIncrement() {
  // %80 ihtimalle 1, %20 ihtimalle 4/5/6/7 arasından rastgele
  if (Math.random() < 0.2) {
    const options = [4, 5, 6, 7];
    return options[Math.floor(Math.random() * options.length)];
  }
  return 1;
}

// Periyodik kayıt (10 saniyede bir)
setInterval(() => {
  fs.writeFileSync(SAVE_FILE, JSON.stringify(pixels));
}, 10000);

app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log('Yeni bağlantı:', ip);

  ws.send(JSON.stringify({
    type: 'world',
    pixels,
    counter: Math.round(getCurrentCounter(ip))
  }));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return;
    }

    if (msg.type === 'place') {
      const { x, y, color } = msg;
      if (typeof x !== 'number' || typeof y !== 'number' || !color) return;
      if (x < 0 || x >= 360 || y < 0 || y >= 180) return;

      const current = getCurrentCounter(ip);

      if (current >= MAX_COUNTER) {
        ws.send(JSON.stringify({ type: 'blocked', value: Math.round(current) }));
        return;
      }

      const key = x + '_' + y;
      const existingColor = pixels[key];

      let inc = randomIncrement();
      if (existingColor && existingColor !== color) {
        inc *= 2; // farklı renkli boyalı pixelin üzerine koymak 2 katı sayaç yakar
      }

      pixels[key] = color;

      const newValue = current + inc; // MAX'ı geçebilir, bir sonraki koymayı engeller
      userCounters[ip] = { value: newValue, lastUpdate: Date.now() };

      // Bu pixel'i herkese yay
      const update = JSON.stringify({ type: 'update', x, y, color });
      wss.clients.forEach((client) => {
        if (client.readyState === 1) client.send(update);
      });

      // Sayaç bilgisini sadece bu kullanıcıya gönder
      ws.send(JSON.stringify({ type: 'counter', value: Math.round(newValue) }));
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
