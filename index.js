import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import pkg from "pg";
import nodemailer from "nodemailer";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors()); // Gerekirse: app.use(cors({ origin: "*" }))
app.use(bodyParser.json());

// --- DB POOL (SSL güvenli) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Hem External URL'de ?sslmode=require olsa da, bazı ortamlar için emniyet:
  ssl: { rejectUnauthorized: false },
});

// --- HEALTH CHECK (DB'ye dokunmaz) ---
app.get("/health", (req, res) => res.json({ ok: true }));

// --- MEVZUATLAR (DB'den) ---
app.get("/mevzuatlar", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, baslik, ozet, kaynak FROM mevzuatlar ORDER BY id DESC LIMIT 20"
    );
    return res.json(rows);
  } catch (e) {
    console.error("DB error:", e);
    return res.status(500).json({ error: "db_error" });
  }
});

// --- (Opsiyonel) Mail testi ---
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
    console.error(e);
    res.status(500).json({ error: "mail_error" });
  }
});

const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`Backend running on :${port}`));

// kullanıcı oluştur (sadece email)
app.post("/auth/register", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email_required" });
  try {
    const { rows } = await pool.query(
      "INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id, email, sector, keywords, notify_pref",
      [email]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// onboarding adımları: sector, keywords, notify_pref
app.post("/onboarding", async (req, res) => {
  const { email, sector, keywords, notify_pref } = req.body;
  if (!email) return res.status(400).json({ error: "email_required" });
  try {
    const { rows } = await pool.query(
      `UPDATE users
       SET sector = COALESCE($2, sector),
           keywords = COALESCE($3, keywords),
           notify_pref = COALESCE($4, notify_pref)
       WHERE email = $1
       RETURNING id, email, sector, keywords, notify_pref`,
      [email, sector || null, keywords || null, notify_pref || null]
    );
    if (!rows.length) return res.status(404).json({ error: "user_not_found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// akış: sector/keyword filtreli
app.get("/feed", async (req, res) => {
  const { sector, q } = req.query; // sector=...&q=...
  try {
    // basit örnek filtre: başlık/özet LIKE ve sector kolonun yok; sonraki sprintte mevzuatlar tablosuna "sectors TEXT[]" ekleriz
    const search = q ? `%${q}%` : "%";
    const { rows } = await pool.query(
      `SELECT id, baslik, ozet, kaynak
         FROM mevzuatlar
        WHERE (baslik ILIKE $1 OR ozet ILIKE $1)
        ORDER BY id DESC
        LIMIT 50`,
      [search]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db_error" });
  }
});

// Basit arama: q parametresi başlık/özette ILIKE araması yapar.
// Örnek: GET /feed?q=kvkk
app.get("/feed", async (req, res) => {
  const { q } = req.query;
  const LIMIT = 50;

  // q yoksa son kayıtları döndür (istersen boş dizi da döndürebilirsin)
  const baseSql = `
    SELECT id, baslik, ozet, kaynak
      FROM mevzuatlar
     ORDER BY id DESC
     LIMIT $1
  `;

  const searchSql = `
    SELECT id, baslik, ozet, kaynak
      FROM mevzuatlar
     WHERE baslik ILIKE $1 OR ozet ILIKE $1
     ORDER BY id DESC
     LIMIT $2
  `;

  try {
    if (!q) {
      const { rows } = await pool.query(baseSql, [LIMIT]);
      return res.json(rows);
    } else {
      const needle = `%${q}%`;
      const { rows } = await pool.query(searchSql, [needle, LIMIT]);
      return res.json(rows);
    }
  } catch (e) {
    console.error("DB error (/feed):", e);
    return res.status(500).json({ error: "db_error" });
  }
});
