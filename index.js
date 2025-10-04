import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import pkg from "pg";
import nodemailer from "nodemailer";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors()); // gerekirse: app.use(cors({ origin: "*" }))
app.use(bodyParser.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "", // Render DB eklenince dolduracağız
  // ssl: { rejectUnauthorized: false }, // Render/Neon gerekirse aç
});

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

// Şimdilik mock veri:
//app.get("/mevzuatlar", async (req, res) => {
//  return res.json([
//    { id: 1, baslik: "2025/101 Sayılı Yönetmelik", ozet: "Mock özet: Vergi usul değişikliği...", kaynak: "https://www.resmigazete.gov.tr/" },
//    { id: 2, baslik: "2025/102 Sayılı Genelge",  ozet: "Mock özet: KVKK ile ilgili güncelleme...",  kaynak: "https://www.resmigazete.gov.tr/" },
//  ]);
//});

// Test e-posta (gmail app password ile çalışır)
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
