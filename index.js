// /feed?q=...&sector=...
app.get("/feed", async (req, res) => {
  const { q, sector } = req.query;
  const LIMIT = 50;

  // Dinamik WHERE inşa
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

    // Anahtar kelime yoksa sadece sektörle sınırla (varsa)
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

    // keywords + (opsiyonel) sector
    const needles = keywords.map(k => `%${k}%`);
    let sql = `
      SELECT id, baslik, ozet, kaynak, sectors
        FROM mevzuatlar
       WHERE (baslik ILIKE ANY($1) OR ozet ILIKE ANY($1))
    `;
    const params = [needles, LIMIT];
    if (sector) {
      sql += ` AND $3 = ANY(sectors)`;
      params.splice(1, 0, sector); // [needles, sector, LIMIT]
    }
    sql += ` ORDER BY id DESC LIMIT $${sector ? 3 : 2}`;

    const { rows } = await pool.query(sql, params);
    return res.json(rows);
  } catch (e) {
    console.error("DB error (/feed/personal):", e);
    return res.status(500).json({ error: "db_error" });
  }
});

