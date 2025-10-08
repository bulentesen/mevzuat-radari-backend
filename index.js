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

// 1) Kayıt (yalnızca e-posta ile—MVP)
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

// 2) Onboarding (sektör, keywords[], bildirim tercihi)
app.post("/onboarding", async (req, res) => {
  const { email, sector, keywords, notify_pref } = req.body;
  if (!email) return res.status(400).json({ error: "email_required" });

  // keywords dizi değilse dönüştürelim (MVP dayanıklılık)
  let kw = keywords;
  if (Array.isArray(kw) === false && typeof kw === "string") {
    kw = kw.split(",").map((s) => s.trim()).filter(Boolean);
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

// 3) Arama feed'i (q parametresi ile; yoksa son kayıtlar)
app.get("/feed", async (req, res) => {
  const { q } = req.query;
  const LIMIT = 50;
  try {
    if (!q) {
      const { rows } = await pool.query(
        `SELECT id, baslik, ozet, kaynak
           FROM mevzuatlar
          ORDER BY id DESC
          LIMIT $1`,
        [LIMIT]
      );
      return res.json(rows);
    } else {
      const needle = `%${q}%`;
      const { rows } = await pool.query(
        `SELECT id, baslik, ozet, kaynak
           FROM mevzuatlar
          WHERE baslik ILIKE $1 OR ozet ILIKE $1
          ORDER BY id DESC
          LIMIT $2`,
        [needle, LIMIT]
      );
      return res.json(rows);
    }
  } catch (e) {
    console.error("DB error (/feed):", e);
    return res.status(500).json({ error: "db_error" });
  }
});

// Kişisel feed: kullanıcının keywords[]'üne göre filtre
// Örnek: GET /feed/personal?email=ornek@firma.com
app.get("/feed/personal", async (req, res) => {
  const { email } = req.query;
  const LIMIT = 50;
  if (!email) return res.status(400).json({ error: "email_required" });

  try {
    // 1) Kullanıcı bilgisi
    const u = await pool.query(
      "SELECT email, sector, keywords FROM users WHERE email = $1 LIMIT 1",
      [email]
    );
    if (!u.rows.length) return res.status(404).json({ error: "user_not_found" });

    const { keywords } = u.rows[0]; // TEXT[]; ör: {KVKK,"e-fatura"}

    // 2) Anahtar kelime yoksa son kayıtlar
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      const { rows } = await pool.query(
        `SELECT id, baslik, ozet, kaynak
           FROM mevzuatlar
          ORDER BY id DESC
          LIMIT $1`,
        [LIMIT]
      );
      return res.json(rows);
    }

    // 3) ILIKE ANY ile herhangi bir kelimeyi eşle
    const needles = keywords.map(k => `%${k}%`);
    const { rows } = await pool.query(
      `SELECT id, baslik, ozet, kaynak
         FROM mevzuatlar
        WHERE (baslik ILIKE ANY($1) OR ozet ILIKE ANY($1))
        ORDER BY id DESC
        LIMIT $2`,
      [needles, LIMIT]
    );

    return res.json(rows);
  } catch (e) {
    console.error("DB error (/feed/personal):", e);
    return res.status(500).json({ error: "db_error" });
  }
});


