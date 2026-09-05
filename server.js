// PixelWorld sunucusu - ülke bazlı fetih sistemi
// Her tıklama, bir ülkenin "senin renginle boyalı yüzdesini" bir miktar artırır.
// %50'nin üzerine çıkan renk o ülkenin "sahibi" (owner) olur.

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const SAVE_FILE = path.join(__dirname, 'world-state.json');
const COOLDOWN_MS = 3000;        // her tıklama arası 3 saniye
const CLAIM_STEP = 8;            // her tıklama, o rengin yüzdesini bu kadar artırır

// --- Durumu yükle ---
// state[countryId] = { percentages: { '#e50000': 40, '#0000ea': 10 }, owner: '#e50000', percent: 40 }
let state = {};
if (fs.existsSync(SAVE_FILE)) {
  state = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
  console.log('Dünya durumu diskten yüklendi.');
} else {
  console.log('Yeni boş dünya oluşturuldu.');
}

const lastPlaced = {}; // ip -> timestamp

setInterval(() => {
  fs.writeFileSync(SAVE_FILE, JSON.stringify(state));
}, 10000);

app.use(express.static(path.join(__dirname, 'public')));

function getCountry(id) {
  if (!state[id]) {
    state[id] = { percentages: {}, owner: null, percent: 0 };
  }
  return state[id];
}

function publicView(country) {
  return { owner: country.owner, percent: country.percent };
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log('Yeni bağlantı:', ip);

  // Yeni bağlanan kullanıcıya tüm ülke durumlarını gönder (sadece owner+percent, iç detay değil)
  const publicState = {};
  Object.keys(state).forEach(id => {
    publicState[id] = publicView(state[id]);
  });
  ws.send(JSON.stringify({ type: 'state', state: publicState }));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return;
    }

    if (msg.type === 'claim') {
      const { id, color } = msg;
      if (!id || !color) return;

      const now = Date.now();
      const last = lastPlaced[ip] || 0;
      if (now - last < COOLDOWN_MS) {
        ws.send(JSON.stringify({ type: 'cooldown', remaining: COOLDOWN_MS - (now - last) }));
        return;
      }
      lastPlaced[ip] = now;

      const country = getCountry(id);

      // Bu rengin yüzdesini artır, diğer renklerden orantılı düş
      const current = country.percentages[color] || 0;
      const gain = Math.min(CLAIM_STEP, 100 - current);
      country.percentages[color] = current + gain;

      // Diğer renklerin toplamını normalize et (100'ü geçmesin)
      let total = Object.values(country.percentages).reduce((a, b) => a + b, 0);
      if (total > 100) {
        const excess = total - 100;
        const others = Object.keys(country.percentages).filter(c => c !== color);
        const othersTotal = others.reduce((a, c) => a + country.percentages[c], 0) || 1;
        others.forEach(c => {
          country.percentages[c] = Math.max(0, country.percentages[c] - (excess * (country.percentages[c] / othersTotal)));
        });
      }

      // Yeni sahibi belirle (en yüksek yüzdeye sahip renk, en az %20 olmalı)
      let bestColor = null, bestPct = 0;
      Object.entries(country.percentages).forEach(([c, pct]) => {
        if (pct > bestPct) { bestPct = pct; bestColor = c; }
      });
      if (bestPct >= 20) {
        country.owner = bestColor;
        country.percent = Math.round(bestPct);
      } else {
        country.owner = null;
        country.percent = 0;
      }

      // Herkese yay
      const update = JSON.stringify({ type: 'countryUpdate', id, data: publicView(country) });
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
