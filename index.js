// backend/index.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import pkg from "pg";
import nodemailer from "nodemailer";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- Postgres Pool ---
// Render için: DATABASE_URL External/İnternal URL'inde ?sslmode=require veya no-verify kullanın.
// Kodda ayrıca ssl: { rejectUnauthorized:false } ile self-signed sorunlarını by-pass ediyoruz.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- Health check ---
app.get("/health", (_req, res) => res.json({ ok: true, version: "0.2" }));

// --- Mevzuatlar: son kayıtlar (DB'den) ---
app.get("/mevzuatlar", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, baslik, ozet, kaynak, sectors FROM mevzuatlar ORDER BY id DESC LIMIT 20"
    );
    return res.json(rows);
  } catch (e) {
    console.error("DB error (/mevzuatlar):", e);
    return res.status(500).json({ error: "db_error" });
  }
});

// --- Feed: arama + isteğe bağlı sektör filtresi ---
// Ör: GET /feed?q=kvkk&sector=Hukuk%20Hizmetleri
app.get("/feed", async (req, res) => {
  const { q, sector } = req.query;
  const LIMIT = 50;

  const conds = [];
  const params = [];
  let pi = 1;

  if (q) {
    conds.push(`(baslik ILIKE $${pi} OR ozet ILIKE $${pi})`);
    params.push(`%${q}%`);
    pi++;
  }
  if (sector) {
    conds.push(`$${pi} = ANY(sectors)`);
    params.push(sector);
    pi++;
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const sql = `
    SELECT id, baslik, ozet, kaynak, sectors
      FROM mevzuatlar
      ${where}
     ORDER BY id DESC
     LIMIT $${pi}
  `;
  params.push(LIMIT);

  try {
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error("DB error (/feed):", e);
    res.status(500).json({ error: "db_error" });
  }
});

// --- Kişisel Feed: kullanıcının keywords[] + (varsa) sector tercihine göre ---
// Ör: GET /feed/personal?email=ornek@firma.com
app.get("/feed/personal", async (req, res) => {
  const { email } = req.query;
  const LIMIT = 50;
  if (!email) return res.status(400).json({ error: "email_required" });

  try {
    const u = await pool.query(
      "SELECT email, sector, keywords FROM users WHERE email = $1 LIMIT 1",
      [email]
    );
    if (!u.rows.length) return res.status(404).json({ error: "user_not_found" });

    const { sector, keywords } = u.rows[0];

    // keywords boşsa sadece sektöre göre (varsa) son kayıtlar
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      const params = [LIMIT];
      let sql = `
        SELECT id, baslik, ozet, kaynak, sectors
          FROM mevzuatlar
      `;
      if (sector) {
        sql += ` WHERE $2 = ANY(sectors)`;
        params.push(sector);
      }
      sql += ` ORDER BY id DESC LIMIT $1`;
      const { rows } = await pool.query(sql, params);
      return res.json(rows);
    }

    // keywords + (opsiyonel) sector birlikte
    const needles = keywords.map((k) => `%${k}%`);
    let sql = `
      SELECT id, baslik, ozet, kaynak, sectors
        FROM mevzuatlar
       WHERE (baslik ILIKE ANY($1) OR ozet ILIKE ANY($1))
    `;
    const params = [needles, LIMIT];
    if (sector) {
      sql += ` AND $3 = ANY(sectors)`;
      // params: [needles, sector, LIMIT]
      params.splice(1, 0, sector);
    }
    sql += ` ORDER BY id DESC LIMIT $${sector ? 3 : 2}`;

    const { rows } = await pool.query(sql, params);
    return res.json(rows);
  } catch (e) {
    console.error("DB error (/feed/personal):", e);
    return res.status(500).json({ error: "db_error" });
  }
});

// --- Auth: sadece email ile kayıt (MVP) ---
app.post("/auth/register", async (req, res) => {
  const { email } = req.body;
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: "email_invalid" });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email)
       VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id, email, sector, keywords, notify_pref, created_at`,
      [email]
    );
    return res.json(rows[0]);
  } catch (e) {
    console.error("DB error (/auth/register):", e);
    return res.status(500).json({ error: "db_error" });
  }
});

// --- Onboarding: sector, keywords[], notify_pref ---
app.post("/onboarding", async (req, res) => {
  const { email, sector, keywords, notify_pref } = req.body;
  if (!email) return res.status(400).json({ error: "email_required" });

  let kw = keywords;
  if (!Array.isArray(kw) && typeof kw === "string") {
    kw = kw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  try {
    const { rows } = await pool.query(
      `UPDATE users
          SET sector = COALESCE($2, sector),
              keywords = COALESCE($3, keywords),
              notify_pref = COALESCE($4, notify_pref)
        WHERE email = $1
        RETURNING id, email, sector, keywords, notify_pref, created_at`,
      [email, sector || null, Array.isArray(kw) ? kw : null, notify_pref || null]
    );
    if (!rows.length) return res.status(404).json({ error: "user_not_found" });
    return res.json(rows[0]);
  } catch (e) {
    console.error("DB error (/onboarding):", e);
    return res.status(500).json({ error: "db_error" });
  }
});

// --- Admin: Mevzuat Ekle (MVP; korumasız) ---
// POST /admin/mevzuat
// Body: { baslik: string, ozet?: string, kaynak?: string, sectors?: string[] }
app.post("/admin/mevzuat", async (req, res) => {
  const { baslik, ozet, kaynak, sectors } = req.body;
  if (!baslik) return res.status(400).json({ error: "baslik_required" });
  try {
    const sec = Array.isArray(sectors) ? sectors : [];
    const { rows } = await pool.query(
      `INSERT INTO mevzuatlar (baslik, ozet, kaynak, sectors)
       VALUES ($1, $2, $3, $4)
       RETURNING id, baslik, ozet, kaynak, sectors`,
      [baslik, ozet || null, kaynak || null, sec]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error("DB error (/admin/mevzuat):", e);
    res.status(500).json({ error: "db_error" });
  }
});

// --- (Opsiyonel) Mail testi endpoint'i ---
app.post("/send-mail", async (req, res) => {
  const { to, subject, text } = req.body;
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
    });
    await transporter.sendMail({ from: process.env.MAIL_USER, to, subject, text });
    res.json({ success: true });
  } catch (e) {
    console.error("mail_error:", e);
    res.status(500).json({ error: "mail_error" });
  }
});

// --- Start ---
const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`Backend running on :${port}`));
