const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'kassa.db');

const db = new sqlite3.Database(DB_PATH);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err); else resolve(this);
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
  });
}

async function init() {
  await run(`CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    is_active INTEGER DEFAULT 1
  )`);
  await run(`CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER NOT NULL,
    service_id TEXT NOT NULL,
    service_name TEXT NOT NULL,
    price INTEGER NOT NULL,
    cashier TEXT DEFAULT '',
    sold_at INTEGER NOT NULL
  )`);
  await ensureActiveShift();
}

async function ensureActiveShift() {
  let shift = await get('SELECT * FROM shifts WHERE is_active = 1 ORDER BY id DESC LIMIT 1');
  if (!shift) {
    const r = await run('INSERT INTO shifts (name, started_at, is_active) VALUES (?, ?, 1)', ['Смена', Date.now()]);
    shift = await get('SELECT * FROM shifts WHERE id = ?', [r.lastID]);
  }
  return shift;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', async (req, res) => {
  try {
    const shift = await ensureActiveShift();
    const sales = await all('SELECT * FROM sales WHERE shift_id = ? ORDER BY sold_at ASC', [shift.id]);
    const counts = {};
    let rev = 0;
    sales.forEach(s => { counts[s.service_id] = (counts[s.service_id] || 0) + 1; rev += s.price; });
    res.json({ shift, sales, counts, rev, cnt: sales.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sell', async (req, res) => {
  try {
    const { service_id, service_name, price, cashier } = req.body;
    const shift = await ensureActiveShift();
    const r = await run(
      'INSERT INTO sales (shift_id, service_id, service_name, price, cashier, sold_at) VALUES (?, ?, ?, ?, ?, ?)',
      [shift.id, service_id, service_name, price, cashier || '', Date.now()]
    );
    const sale = await get('SELECT * FROM sales WHERE id = ?', [r.lastID]);
    res.json({ ok: true, sale });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sell/last', async (req, res) => {
  try {
    const shift = await ensureActiveShift();
    const last = await get('SELECT * FROM sales WHERE shift_id = ? ORDER BY sold_at DESC LIMIT 1', [shift.id]);
    if (!last) return res.json({ ok: false, msg: 'Нет продаж для отмены' });
    await run('DELETE FROM sales WHERE id = ?', [last.id]);
    res.json({ ok: true, deleted: last });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/shift/end', async (req, res) => {
  try {
    const shift = await ensureActiveShift();
    await run('UPDATE shifts SET is_active = 0, ended_at = ? WHERE id = ?', [Date.now(), shift.id]);
    const r = await run('INSERT INTO shifts (name, started_at, is_active) VALUES (?, ?, 1)', ['Смена', Date.now()]);
    res.json({ ok: true, old_shift_id: shift.id, new_shift_id: r.lastID });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/shifts', async (req, res) => {
  try {
    const shifts = await all('SELECT * FROM shifts WHERE is_active = 0 ORDER BY ended_at DESC LIMIT 50');
    const result = await Promise.all(shifts.map(async sh => {
      const sales = await all('SELECT * FROM sales WHERE shift_id = ?', [sh.id]);
      const rev = sales.reduce((a, s) => a + s.price, 0);
      return { ...sh, rev, cnt: sales.length };
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/shifts/:id', async (req, res) => {
  try {
    const sh = await get('SELECT * FROM shifts WHERE id = ?', [req.params.id]);
    if (!sh) return res.status(404).json({ error: 'Не найдено' });
    const sales = await all('SELECT * FROM sales WHERE shift_id = ? ORDER BY sold_at ASC', [sh.id]);
    const rev = sales.reduce((a, s) => a + s.price, 0);
    res.json({ ...sh, sales, rev, cnt: sales.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/export/csv', async (req, res) => {
  try {
    const shift = await ensureActiveShift();
    const sales = await all('SELECT * FROM sales WHERE shift_id = ? ORDER BY sold_at ASC', [shift.id]);
    const rows = ['\uFEFFВремя;Услуга;Сумма (₽)'];
    sales.forEach(s => {
      const t = new Date(s.sold_at).toLocaleString('ru-RU');
      rows.push(`${t};${s.service_name};${s.price}`);
    });
    const total = sales.reduce((a, s) => a + s.price, 0);
    rows.push(`ИТОГО;;${total}`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="smena_${shift.id}.csv"`);
    res.send(rows.join('\n'));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

init().then(() => {
  app.listen(PORT, () => console.log(`Касса Планета запущена на порту ${PORT}`));
}).catch(console.error);
});
