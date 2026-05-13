const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// База данных
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'kassa.db');
const db = new Database(DB_PATH);

// Инициализация таблиц
db.exec(`
  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    is_active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER NOT NULL,
    service_id TEXT NOT NULL,
    service_name TEXT NOT NULL,
    price INTEGER NOT NULL,
    cashier TEXT DEFAULT '',
    sold_at INTEGER NOT NULL,
    FOREIGN KEY (shift_id) REFERENCES shifts(id)
  );
`);

// Создать активную смену если нет
function ensureActiveShift() {
  let shift = db.prepare('SELECT * FROM shifts WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
  if (!shift) {
    const result = db.prepare('INSERT INTO shifts (name, started_at, is_active) VALUES (?, ?, 1)')
      .run('Смена', Date.now());
    shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(result.lastInsertRowid);
  }
  return shift;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// === API ===

// Текущее состояние
app.get('/api/state', (req, res) => {
  const shift = ensureActiveShift();
  const sales = db.prepare('SELECT * FROM sales WHERE shift_id = ? ORDER BY sold_at ASC').all(shift.id);
  
  const counts = {};
  let rev = 0;
  sales.forEach(s => {
    counts[s.service_id] = (counts[s.service_id] || 0) + 1;
    rev += s.price;
  });

  res.json({ shift, sales, counts, rev, cnt: sales.length });
});

// Продажа
app.post('/api/sell', (req, res) => {
  const { service_id, service_name, price, cashier } = req.body;
  const shift = ensureActiveShift();
  
  const result = db.prepare(
    'INSERT INTO sales (shift_id, service_id, service_name, price, cashier, sold_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(shift.id, service_id, service_name, price, cashier || '', Date.now());

  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(result.lastInsertRowid);
  res.json({ ok: true, sale });
});

// Отмена последней продажи
app.delete('/api/sell/last', (req, res) => {
  const shift = ensureActiveShift();
  const last = db.prepare('SELECT * FROM sales WHERE shift_id = ? ORDER BY sold_at DESC LIMIT 1').get(shift.id);
  if (!last) return res.json({ ok: false, msg: 'Нет продаж для отмены' });
  
  db.prepare('DELETE FROM sales WHERE id = ?').run(last.id);
  res.json({ ok: true, deleted: last });
});

// Завершить смену
app.post('/api/shift/end', (req, res) => {
  const { name } = req.body;
  const shift = ensureActiveShift();
  db.prepare('UPDATE shifts SET is_active = 0, ended_at = ?, name = ? WHERE id = ?')
    .run(Date.now(), name || 'Смена', shift.id);
  
  // Создать новую
  const newShift = db.prepare('INSERT INTO shifts (name, started_at, is_active) VALUES (?, ?, 1)')
    .run('Смена', Date.now());
  
  res.json({ ok: true, old_shift_id: shift.id, new_shift_id: newShift.lastInsertRowid });
});

// История смен
app.get('/api/shifts', (req, res) => {
  const shifts = db.prepare('SELECT * FROM shifts WHERE is_active = 0 ORDER BY ended_at DESC LIMIT 50').all();
  const result = shifts.map(sh => {
    const sales = db.prepare('SELECT * FROM sales WHERE shift_id = ?').all(sh.id);
    const rev = sales.reduce((a, s) => a + s.price, 0);
    return { ...sh, rev, cnt: sales.length };
  });
  res.json(result);
});

// Детали смены
app.get('/api/shifts/:id', (req, res) => {
  const sh = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!sh) return res.status(404).json({ error: 'Не найдено' });
  const sales = db.prepare('SELECT * FROM sales WHERE shift_id = ? ORDER BY sold_at ASC').all(sh.id);
  const rev = sales.reduce((a, s) => a + s.price, 0);
  res.json({ ...sh, sales, rev, cnt: sales.length });
});

// Экспорт CSV текущей смены
app.get('/api/export/csv', (req, res) => {
  const shift = ensureActiveShift();
  const sales = db.prepare('SELECT * FROM sales WHERE shift_id = ? ORDER BY sold_at ASC').all(shift.id);
  
  const rows = ['\uFEFFВремя;Услуга;Кассир;Сумма (₽)'];
  sales.forEach(s => {
    const t = new Date(s.sold_at).toLocaleString('ru-RU');
    rows.push(`${t};${s.service_name};${s.cashier};${s.price}`);
  });
  const total = sales.reduce((a, s) => a + s.price, 0);
  rows.push(`ИТОГО;;;${total}`);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="smena_${shift.id}.csv"`);
  res.send(rows.join('\n'));
});

app.listen(PORT, () => {
  console.log(`🪐 Касса Планета запущена на порту ${PORT}`);
  ensureActiveShift();
});
