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

const WORLD_W = 360;
const WORLD_H = 180;

// ================= KITA/DENİZ HARİTASI ÜRETİMİ =================
// Kaba kıta çizgileri (lon, lat çiftleri). Dış kaynağa bağlı değil, tamamen burada üretiliyor.
const CONTINENTS = [
  // Kuzey Amerika
  [[-168,66],[-165,60],[-140,60],[-130,55],[-125,49],[-124,40],[-117,32],[-105,20],[-97,16],[-84,9],
   [-80,25],[-81,31],[-75,35],[-70,41],[-65,45],[-60,50],[-75,55],[-95,60],[-110,68],[-130,70],[-150,70],[-168,66]],
  // Güney Amerika
  [[-77,8],[-75,10],[-60,10],[-50,5],[-35,-5],[-40,-20],[-48,-25],[-57,-35],[-65,-45],[-68,-55],
   [-72,-52],[-71,-33],[-70,-18],[-81,-4],[-79,2],[-77,8]],
  // Afrika
  [[-17,21],[-16,15],[-10,6],[2,6],[9,4],[12,-6],[13,-18],[15,-26],[18,-34],[26,-33],[32,-25],
   [40,-15],[42,-5],[51,10],[43,12],[37,27],[32,31],[20,32],[10,37],[-1,35],[-6,35],[-17,21]],
  // Avrupa
  [[-9,43],[-9,36],[3,43],[12,45],[18,40],[27,40],[29,41],[30,46],[40,45],[60,68],[30,70],[20,70],
   [5,62],[5,50],[-5,50],[-9,43]],
  // Asya (kaba)
  [[60,68],[60,50],[50,40],[45,35],[48,30],[56,25],[68,24],[72,21],[73,15],[77,8],[80,13],[87,22],
   [94,16],[99,7],[104,1],[106,10],[108,16],[108,21],[113,23],[121,31],[124,40],[131,43],[140,60],
   [160,65],[175,68],[150,72],[100,73],[60,68]],
  // Avustralya
  [[113,-22],[114,-28],[115,-34],[129,-32],[137,-35],[150,-38],[153,-28],[145,-16],[142,-11],
   [133,-12],[122,-18],[113,-22]],
  // Grönland
  [[-45,60],[-55,66],[-65,76],[-40,83],[-20,76],[-25,70],[-40,62],[-45,60]],
  // Madagaskar
  [[43,-25],[44,-20],[47,-15],[49,-12],[48,-17],[45,-22],[43,-25]],
  // Britanya Adaları
  [[-8,51],[-8,55],[-5,58],[-2,58],[0,53],[-1,51],[-5,50],[-8,51]],
  // Japonya
  [[130,31],[132,34],[137,35],[140,36],[141,40],[142,44],[145,44],[141,45],[139,38],[135,34],[130,31]],
  // Endonezya (kaba)
  [[95,5],[99,2],[104,-3],[110,-7],[115,-8],[119,-4],[117,0],[113,3],[104,1],[99,4],[95,5]],
  // Filipinler
  [[120,18],[122,14],[125,10],[126,13],[123,17],[120,18]],
  // Yeni Zelanda
  [[166,-45],[168,-44],[174,-41],[178,-38],[175,-37],[172,-41],[166,-45]]
];

function pointInPolygon(lon, lat, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function isLand(lon, lat) {
  if (lat <= -60) return true; // Antarktika (kaba yaklaşım)
  for (const poly of CONTINENTS) {
    if (pointInPolygon(lon, lat, poly)) return true;
  }
  return false;
}

console.log('Kıta haritası oluşturuluyor...');
let terrain = '';
for (let gy = 0; gy < WORLD_H; gy++) {
  const lat = 90 - gy - 0.5;
  for (let gx = 0; gx < WORLD_W; gx++) {
    const lon = gx - 180 + 0.5;
    terrain += isLand(lon, lat) ? 'L' : 'S';
  }
}
console.log('Kıta haritası hazır. Kara pixel sayısı:', (terrain.match(/L/g) || []).length);

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
    terrain,
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
      if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) return;

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
