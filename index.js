// backend/index.js (v0.3.2 — personal feed: (keywords OR sector))
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

// --- Postgres ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- Health ---
app.get("/health", (_req, res) => res.json({ ok: true, version: "0.3.2" }));

// --- Mevzuatlar (liste) ---
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

// --- Genel Feed: arama + sektör ---
app.get("/feed", async (req, res) => {
  const { q, sector } = req.query;
  const LIMIT = 50;

  const conds = [];
  const params = [];
  let pi = 1;

  if (q) {
    conds.push(`EXISTS (
      SELECT 1
        FROM unnest(ARRAY[$${pi}]::text[]) AS pat
       WHERE baslik ILIKE pat OR ozet ILIKE pat
    )`);
    params.push(`%${q}%`);
    pi++;
  }
  if (sector) {
    conds.push(`$${pi}::text = ANY(sectors)`);
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

// --- Kişisel Feed: (keywords OR sector) ---
// GET /feed/personal?email=ornek@firma.com
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
    const hasKw = Array.isArray(keywords) && keywords.length > 0;
    const hasSector = !!sector;

    // Hiç tercih yoksa: son kayıtlar
    if (!hasKw && !hasSector) {
      const { rows } = await pool.query(
        `SELECT id, baslik, ozet, kaynak, sectors
           FROM mevzuatlar
          ORDER BY id DESC
          LIMIT $1`,
        [LIMIT]
      );
      return res.json(rows);
    }

    // OR mantığı: (kw match) OR (sector match)
    let sql = `
      SELECT id, baslik, ozet, kaynak, sectors
        FROM mevzuatlar
       WHERE
         (
           ${hasKw ? `EXISTS (
             SELECT 1 FROM unnest($1::text[]) AS kw
             WHERE baslik ILIKE ('%' || kw || '%')
                OR ozet   ILIKE ('%' || kw || '%')
           )` : `FALSE`}
         )
         OR
         (
           ${hasSector ? `$${hasKw ? 2 : 1}::text = ANY(sectors)` : `FALSE`}
         )
       ORDER BY id DESC
       LIMIT $${hasKw && hasSector ? 3 : 2}
    `;

    const params = [];
    if (hasKw) params.push(keywords);
    if (hasSector) params.push(sector);
    params.push(LIMIT);

    const { rows } = await pool.query(sql, params);
    return res.json(rows);
  } catch (e) {
    console.error("DB error (/feed/personal):", e);
    return res.status(500).json({ error: "db_error" });
  }
});

// --- Auth (MVP) ---
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

// --- Onboarding ---
app.post("/onboarding", async (req, res) => {
  const { email, sector, keywords, notify_pref } = req.body;
  if (!email) return res.status(400).json({ error: "email_required" });

  let kw = keywords;
  if (!Array.isArray(kw) && typeof kw === "string") {
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

// --- Admin: Mevzuat Ekle (MVP) ---
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

const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`Backend running on :${port}`));
