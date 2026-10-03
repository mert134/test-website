"use strict";

const http = require("node:http");
const { randomBytes } = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "https://reports.zanity.net").replace(/\/$/, "");
const MAX_BODY_BYTES = 12 * 1024;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 5;
const rateLimits = new Map();

const CATEGORIES = new Set([
  "Hata bildirimi",
  "Kurulum / kullanım",
  "Öneri",
  "Diğer"
]);

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(data));
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");

  if (origin && origin !== ALLOWED_ORIGIN) return false;
  if (origin) res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  return true;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        const error = new Error("BODY_TOO_LARGE");
        error.code = "BODY_TOO_LARGE";
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        const error = new Error("INVALID_JSON");
        error.code = "INVALID_JSON";
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function getText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/g, "").trim();
}

function fieldError(value, label, maxLength, required = false) {
  if (required && !value) return `${label} alanı zorunludur.`;
  if (value.length > maxLength) return `${label} en fazla ${maxLength} karakter olabilir.`;
  return "";
}

function getClientKey(req) {
  // Render'ın reverse proxy'si x-forwarded-for başlığını ekler.
  const forwarded = req.headers["x-forwarded-for"];
  return (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "")
    || req.socket.remoteAddress
    || "unknown";
}

function isRateLimited(key) {
  const now = Date.now();
  if (rateLimits.size > 5000) {
    for (const [storedKey, storedRecord] of rateLimits) {
      if (now >= storedRecord.resetAt) rateLimits.delete(storedKey);
    }
  }
  const record = rateLimits.get(key);
  if (!record || now >= record.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  record.count += 1;
  return record.count > RATE_LIMIT;
}

function cleanEmbedText(value, fallback = "Belirtilmedi") {
  const text = value || fallback;
  // Discord mention bildirimlerini ayrıca allowed_mentions ile kapatıyoruz.
  return text.slice(0, 1024);
}

function createTicketId() {
  return `ZN-${randomBytes(3).toString("hex").toUpperCase()}`;
}

async function handleReport(req, res) {
  if (!applyCors(req, res)) {
    sendJson(res, 403, { error: "Bu kaynaktan gönderime izin verilmiyor." });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== "POST" || requestUrl.pathname !== "/api/report") {
    sendJson(res, 404, { error: "Bu adres bulunamadı." });
    return;
  }

  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    sendJson(res, 415, { error: "İstek JSON biçiminde gönderilmelidir." });
    return;
  }

  if (isRateLimited(getClientKey(req))) {
    sendJson(res, 429, { error: "Çok fazla bildirim gönderildi. Biraz bekleyip tekrar dene." });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    const tooLarge = error.code === "BODY_TOO_LARGE";
    sendJson(res, tooLarge ? 413 : 400, {
      error: tooLarge ? "Form çok büyük." : "Form verisi okunamadı."
    });
    return;
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendJson(res, 400, { error: "Form verisi geçersiz." });
    return;
  }

  // Görünmeyen tuzak alanını botlar doldurursa bildirimi sessizce yoksay.
  if (getText(body.website, 200)) {
    sendJson(res, 202, { ok: true, ticketId: createTicketId() });
    return;
  }

  const report = {
    category: getText(body.category, 40),
    scriptName: getText(body.scriptName, 80),
    subject: getText(body.subject, 120),
    description: getText(body.description, 2500),
    steps: getText(body.steps, 1200),
    expected: getText(body.expected, 800),
    environment: getText(body.environment, 160),
    contact: getText(body.contact, 180)
  };

  if (!CATEGORIES.has(report.category)) {
    sendJson(res, 400, { error: "Geçerli bir bildirim türü seç." });
    return;
  }

  const errors = [
    fieldError(report.scriptName, "Script adı", 80, true),
    fieldError(report.subject, "Başlık", 120, true),
    fieldError(report.description, "Açıklama", 2500, true),
    fieldError(report.steps, "Tekrarlama adımları", 1200),
    fieldError(report.expected, "Beklenen sonuç", 800),
    fieldError(report.environment, "Ortam bilgisi", 160),
    fieldError(report.contact, "Geri dönüş bilgisi", 180)
  ].filter(Boolean);

  if (errors.length) {
    sendJson(res, 400, { error: errors[0] });
    return;
  }

  if (!WEBHOOK_URL) {
    sendJson(res, 503, { error: "Bildirim servisi henüz yapılandırılmadı." });
    return;
  }

  let webhookHost;
  try {
    webhookHost = new URL(WEBHOOK_URL).hostname;
  } catch {
    sendJson(res, 503, { error: "Bildirim servisi yapılandırması geçersiz." });
    return;
  }
  if (webhookHost !== "discord.com" && webhookHost !== "discordapp.com") {
    sendJson(res, 503, { error: "Bildirim servisi yapılandırması geçersiz." });
    return;
  }

  const ticketId = createTicketId();
  const embeds = [{
    title: `Yeni Zanity bildirimi · ${ticketId}`,
    color: report.category === "Hata bildirimi" ? 0xF0788A : 0x8B72F2,
    description: `**${report.subject}**\n\n${report.description}`.slice(0, 4096),
    fields: [
      { name: "Bildirim türü", value: cleanEmbedText(report.category), inline: true },
      { name: "Script", value: cleanEmbedText(report.scriptName), inline: true },
      { name: "Tekrarlama adımları", value: cleanEmbedText(report.steps), inline: false },
      { name: "Beklenen sonuç", value: cleanEmbedText(report.expected), inline: false },
      { name: "İşletim sistemi / ortam", value: cleanEmbedText(report.environment), inline: true },
      { name: "Geri dönüş bilgisi", value: cleanEmbedText(report.contact), inline: true }
    ],
    footer: { text: "Zanity Rapor Merkezi · reports.zanity.net" },
    timestamp: new Date().toISOString()
  }];

  try {
    const discordResponse = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Zanity Rapor Merkezi",
        embeds,
        allowed_mentions: { parse: [] }
      })
    });

    if (!discordResponse.ok) {
      // Webhook URL'sini veya Discord yanıt gövdesini loglama.
      console.error("Discord bildirimi başarısız; HTTP durumu:", discordResponse.status);
      sendJson(res, 502, { error: "Bildirim Discord'a iletilemedi. Biraz sonra tekrar dene." });
      return;
    }

    sendJson(res, 200, { ok: true, ticketId });
  } catch {
    console.error("Discord servisine ulaşılamadı.");
    sendJson(res, 502, { error: "Bildirim servisine ulaşılamadı. Biraz sonra tekrar dene." });
  }
}

const server = http.createServer((req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  handleReport(req, res).catch(() => {
    if (!res.headersSent) sendJson(res, 500, { error: "Beklenmeyen bir sunucu hatası oluştu." });
    else res.end();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Zanity Reports API listening on port ${PORT}`);
});
