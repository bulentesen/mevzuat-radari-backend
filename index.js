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
