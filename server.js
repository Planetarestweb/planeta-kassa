const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Проверка переменных
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.log('⚠️ Нет SUPABASE_URL или SUPABASE_KEY в Render Environment');
}

// Разрешаем сайту кассы смены забирать данные
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Универсальный запрос в Supabase
async function supa(pathUrl, method = 'GET', body = null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathUrl}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: body ? JSON.stringify(body) : null
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(text || `Supabase error ${res.status}`);
  }

  try {
    return text ? JSON.parse(text) : [];
  } catch {
    return [];
  }
}

// Получить активную смену или создать новую
async function ensureActiveShift() {
  const rows = await supa('club_shifts?is_active=eq.1&order=id.desc&limit=1');

  if (rows && rows.length > 0) {
    return rows[0];
  }

  const created = await supa('club_shifts', 'POST', {
    started_at: Date.now(),
    is_active: 1
  });

  return created[0];
}

// Главные данные кассы
app.get('/api/state', async (req, res) => {
  try {
    const shift = await ensureActiveShift();

    const sales = await supa(
      `club_sales?shift_id=eq.${shift.id}&order=sold_at.asc`
    );

    const counts = {};
    let rev = 0;

    sales.forEach(s => {
      counts[s.service_id] = (counts[s.service_id] || 0) + 1;
      rev += Number(s.price) || 0;
    });

    res.json({
      shift,
      sales,
      counts,
      rev,
      cnt: sales.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Продажа
app.post('/api/sell', async (req, res) => {
  try {
    const { service_id, service_name, price, cashier } = req.body;

    if (!service_id || !service_name || !price) {
      return res.status(400).json({
        error: 'Не хватает service_id, service_name или price'
      });
    }

    const shift = await ensureActiveShift();

    const created = await supa('club_sales', 'POST', {
      shift_id: shift.id,
      service_id,
      service_name,
      price: Number(price) || 0,
      cashier: cashier || '',
      sold_at: Date.now()
    });

    res.json({
      ok: true,
      sale: created[0]
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Отмена последней продажи
app.delete('/api/sell/last', async (req, res) => {
  try {
    const shift = await ensureActiveShift();

    const rows = await supa(
      `club_sales?shift_id=eq.${shift.id}&order=sold_at.desc&limit=1`
    );

    const last = rows[0];

    if (!last) {
      return res.json({
        ok: false,
        msg: 'Нет продаж для отмены'
      });
    }

    await supa(`club_sales?id=eq.${last.id}`, 'DELETE');

    res.json({
      ok: true,
      deleted: last
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Завершить смену и открыть новую
app.post('/api/shift/end', async (req, res) => {
  try {
    const shift = await ensureActiveShift();

    await supa(`club_shifts?id=eq.${shift.id}`, 'PATCH', {
      is_active: 0,
      ended_at: Date.now()
    });

    const created = await supa('club_shifts', 'POST', {
      started_at: Date.now(),
      is_active: 1
    });

    res.json({
      ok: true,
      old_shift_id: shift.id,
      new_shift_id: created[0].id
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Список закрытых смен
app.get('/api/shifts', async (req, res) => {
  try {
    const shifts = await supa(
      'club_shifts?is_active=eq.0&order=ended_at.desc&limit=50'
    );

    const result = await Promise.all(
      shifts.map(async sh => {
        const sales = await supa(`club_sales?shift_id=eq.${sh.id}`);
        const rev = sales.reduce((a, s) => a + (Number(s.price) || 0), 0);

        return {
          ...sh,
          rev,
          cnt: sales.length
        };
      })
    );

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Одна смена по ID
app.get('/api/shifts/:id', async (req, res) => {
  try {
    const rows = await supa(`club_shifts?id=eq.${req.params.id}&limit=1`);
    const sh = rows[0];

    if (!sh) {
      return res.status(404).json({ error: 'Не найдено' });
    }

    const sales = await supa(
      `club_sales?shift_id=eq.${sh.id}&order=sold_at.asc`
    );

    const rev = sales.reduce((a, s) => a + (Number(s.price) || 0), 0);

    res.json({
      ...sh,
      sales,
      rev,
      cnt: sales.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// CSV выгрузка активной смены
app.get('/api/export/csv', async (req, res) => {
  try {
    const shift = await ensureActiveShift();

    const sales = await supa(
      `club_sales?shift_id=eq.${shift.id}&order=sold_at.asc`
    );

    const rows = ['\uFEFFВремя;Услуга;Оплата;Сумма (₽)'];

    sales.forEach(s => {
      const t = new Date(Number(s.sold_at)).toLocaleString('ru-RU');
      const payLabel = s.cashier === 'card' ? 'Карта' : 'Наличка';

      rows.push(
        t + ';' +
        s.service_name + ';' +
        payLabel + ';' +
        s.price
      );
    });

    const total = sales.reduce((a, s) => a + (Number(s.price) || 0), 0);
    const cash = sales
      .filter(s => s.cashier !== 'card')
      .reduce((a, s) => a + (Number(s.price) || 0), 0);

    const card = sales
      .filter(s => s.cashier === 'card')
      .reduce((a, s) => a + (Number(s.price) || 0), 0);

    rows.push(';;;');
    rows.push('ИТОГО;;Наличка;' + cash);
    rows.push(';;Карта;' + card);
    rows.push(';;ВСЕГО;' + total);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="smena_' + shift.id + '.csv"'
    );

    res.send(rows.join('\n'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 🤖 TELEGRAM BOT — Планета Касса для админа
// Бот пишет данные в таблицу shifts для основного отчета.
// Касса детского клуба пишет данные в club_shifts и club_sales.
// ════════════════════════════════════════════════════════════════

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean)
  .map(Number);

if (BOT_TOKEN && SUPABASE_URL && SUPABASE_KEY) {
  startBot();
} else {
  console.log('⚠️ TG-бот не запущен, нет BOT_TOKEN / SUPABASE_URL / SUPABASE_KEY');
}

function startBot() {
  console.log('🤖 Запуск Telegram-бота…');

  const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  let offset = 0;

  fetch(`${TG_API}/getMe`)
    .then(r => r.json())
    .then(d => {
      if (d.ok) {
        console.log(`✅ Бот @${d.result.username} запущен`);
      }
    })
    .catch(e => console.error('Bot getMe error:', e.message));

  async function pollUpdates() {
    try {
      const res = await fetch(`${TG_API}/getUpdates?offset=${offset}&timeout=30`);
      const data = await res.json();

      if (data.ok && data.result.length > 0) {
        for (const upd of data.result) {
          offset = upd.update_id + 1;

          if (upd.message) {
            handleMessage(upd.message).catch(e =>
              console.error('Handler error:', e.message)
            );
          }
        }
      }
    } catch (e) {
      console.error('Poll error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }

    setImmediate(pollUpdates);
  }

  pollUpdates();

  async function sendMessage(chatId, text, options = {}) {
    try {
      await fetch(`${TG_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'Markdown',
          ...options
        })
      });
    } catch (e) {
      console.error('Send error:', e.message);
    }
  }

  async function supaGet(pathUrl) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathUrl}`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    });

    if (!res.ok) {
      throw new Error(`Supabase GET ${res.status}`);
    }

    return res.json();
  }

  async function supaUpsertShift(shiftDate, data) {
    const existing = await supaGet(`shifts?shift_date=eq.${shiftDate}&select=data`);
    const merged = existing.length ? { ...existing[0].data, ...data } : data;

    const res = await fetch(`${SUPABASE_URL}/rest/v1/shifts`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({
        shift_date: shiftDate,
        data: merged
      })
    });

    if (!res.ok) {
      throw new Error(`Supabase POST ${res.status}: ${await res.text()}`);
    }

    return merged;
  }

  const FIELD_NAMES = {
    expK: '🍳 Кухня',
    expB: '🍹 Бар',
    expH: '🪑 Зал',
    expT: '📦 Тара',
    salary: '👥 Зарплата',
    inkass: '💼 Инкассация',
    bankExp: '🏦 Расч. счёт',
    restCash: '🍽️ Ресторан наличка',
    restCard: '🍽️ Ресторан карта',
    clubCash: '🎠 Клуб наличка',
    clubCard: '🎠 Клуб карта',
    yandex: '🟡 Яндекс Еда'
  };

  const PATTERNS = [
    [/ресторан\s*(нал|нальн)/i, 'restCash'],
    [/ресторан\s*(карт|безнал)/i, 'restCard'],
    [/клуб\s*(нал|нальн)/i, 'clubCash'],
    [/клуб\s*(карт|безнал)/i, 'clubCard'],
    [/(яндекс|yandex)/i, 'yandex'],
    [/(зарплат|зп|з\/п)/i, 'salary'],
    [/(инкасс|руслан)/i, 'inkass'],
    [/(расч[её]тн|р\/с|р\.\s*с|безнал|счет)/i, 'bankExp'],
    [/(кухн[яеи])/i, 'expK'],
    [/(бар|бару)/i, 'expB'],
    [/(зал|залу)/i, 'expH'],
    [/(тар[аыеу]|упаковк)/i, 'expT']
  ];

  function parseNumber(s) {
    const cleaned = String(s).replace(/[^\d]/g, '');
    return cleaned ? parseInt(cleaned, 10) : 0;
  }

  function parseMessage(text) {
    const result = {};
    const writeoffLines = [];

    for (const line of text.split('\n')) {
      const clean = line.trim();
      if (!clean) continue;

      if (/\d+\s*(грамм|г\.|\bг\b|кг)/i.test(clean)) {
        writeoffLines.push(clean);
        continue;
      }

      for (const [pattern, field] of PATTERNS) {
        if (pattern.test(clean)) {
          const numMatch = clean.match(/(\d[\d\s.,]*)/);

          if (numMatch) {
            const val = parseNumber(numMatch[1]);

            if (val > 0) {
              result[field] = val;
              break;
            }
          }
        }
      }
    }

    if (writeoffLines.length) {
      result.writeoffText = writeoffLines.join('\n');
    }

    return result;
  }

  function detectDate(text) {
    const m1 = text.match(/\b(\d{1,2})[./](\d{1,2})[./](\d{2,4})\b/);

    if (m1) {
      let [, d, mo, y] = m1;

      if (y.length === 2) {
        y = '20' + y;
      }

      return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }

    const m2 = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);

    if (m2) {
      return `${m2[1]}-${m2[2]}-${m2[3]}`;
    }

    return new Date().toISOString().slice(0, 10);
  }

  function fmt(n) {
    return Math.round(Number(n) || 0).toLocaleString('ru-RU') + ' ₽';
  }

  function checkAccess(userId) {
    if (ALLOWED_USERS.length === 0) return true;
    return ALLOWED_USERS.includes(userId);
  }

  async function handleMessage(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = (msg.text || '').trim();

    if (!text) return;

    if (text.startsWith('/')) {
      const cmd = text.split(' ')[0].split('@')[0].toLowerCase();

      if (cmd === '/start') {
        if (!checkAccess(userId)) {
          return sendMessage(
            chatId,
            `⛔ Доступ закрыт.\nТвой ID: \`${userId}\`\nОтправь его владельцу.`
          );
        }

        return sendMessage(
          chatId,
          `👋 Привет, ${msg.from.first_name}!\n\n` +
          `Я бот *Планета Касса*.\n` +
          `Пиши мне что было за смену — я запишу.\n\n` +
          `*Пример:*\n` +
          `\`\`\`\nКухня 3500\nБар 1200\nЗал 800\nЗарплата 8000\nИнкассация 50000\n\`\`\`\n\n` +
          `*Команды:*\n` +
          `/смена — показать текущую смену\n` +
          `/итог — баланс налички\n` +
          `/myid — твой ID\n` +
          `/help — справка`
        );
      }

      if (cmd === '/myid') {
        return sendMessage(chatId, `Твой Telegram ID: \`${userId}\``);
      }

      if (!checkAccess(userId)) {
        return sendMessage(chatId, `⛔ Доступ закрыт. Твой ID: \`${userId}\``);
      }

      if (cmd === '/help') {
        return sendMessage(
          chatId,
          `📖 *Как пользоваться*\n\n` +
          `Пиши построчно: *ключевое слово + сумма*\n\n` +
          `Я понимаю:\n` +
          `• Кухня, Бар, Зал, Тара\n` +
          `• Зарплата, Инкассация\n` +
          `• Расчётный счёт, Безнал\n` +
          `• Ресторан наличка/карта\n` +
          `• Клуб наличка/карта\n` +
          `• Яндекс Еда\n\n` +
          `Если упоминаешь *граммы* — это списания.\n\n` +
          `Дата по умолчанию — сегодня.\n` +
          `Можно указать: \`за 13.05.2026\``
        );
      }

      if (cmd === '/смена' || cmd === '/smena') {
        try {
          const today = new Date().toISOString().slice(0, 10);
          const rows = await supaGet(`shifts?shift_date=eq.${today}&select=*`);

          if (!rows.length) {
            return sendMessage(chatId, `📋 Смена за ${today} пустая.`);
          }

          const d = rows[0].data;
          const lines = [`📋 *Смена за ${today}*\n`];

          for (const [k, label] of Object.entries(FIELD_NAMES)) {
            if (d[k]) {
              lines.push(`${label}: *${fmt(d[k])}*`);
            }
          }

          if (d.writeoffText) {
            lines.push(`\n🗑️ *Списания:*\n${String(d.writeoffText).slice(0, 300)}`);
          }

          return sendMessage(chatId, lines.join('\n'));
        } catch (e) {
          return sendMessage(chatId, `❌ Ошибка: ${e.message}`);
        }
      }

      if (cmd === '/итог' || cmd === '/itog') {
        try {
          const today = new Date().toISOString().slice(0, 10);
          const rows = await supaGet(`shifts?shift_date=eq.${today}&select=data`);

          if (!rows.length) {
            return sendMessage(chatId, 'Нет данных за сегодня.');
          }

          const d = rows[0].data;

          const cashIn =
            (Number(d.restCash) || 0) +
            (Number(d.clubCash) || 0);

          const cashOut = ['expK', 'expB', 'expH', 'expT', 'salary', 'inkass']
            .reduce((s, k) => s + (Number(d[k]) || 0), 0);

          const balance = cashIn - cashOut;

          return sendMessage(
            chatId,
            `💵 *Наличка за ${today}*\n\n` +
            `Пришло: *${fmt(cashIn)}*\n` +
            `Расходы: −${fmt(cashOut)}\n` +
            `────────\n` +
            `*В кассе: ${fmt(balance)}*`
          );
        } catch (e) {
          return sendMessage(chatId, `❌ Ошибка: ${e.message}`);
        }
      }

      return sendMessage(chatId, 'Неизвестная команда. /help');
    }

    if (!checkAccess(userId)) {
      return sendMessage(chatId, `⛔ Доступ закрыт. Твой ID: \`${userId}\``);
    }

    const parsed = parseMessage(text);

    if (Object.keys(parsed).length === 0) {
      return sendMessage(
        chatId,
        `🤔 Не понял что записать.\n\n` +
        `Пиши в формате: \`Кухня 3500\`\n` +
        `Подсказка: /help`
      );
    }

    const shiftDate = detectDate(text);

    try {
      await supaUpsertShift(shiftDate, parsed);
    } catch (e) {
      return sendMessage(chatId, `❌ Ошибка БД: ${e.message}`);
    }

    const lines = [`📅 *${shiftDate}*\n`];

    for (const [k, v] of Object.entries(parsed)) {
      if (FIELD_NAMES[k]) {
        lines.push(`✅ ${FIELD_NAMES[k]}: *${fmt(v)}*`);
      } else if (k === 'writeoffText') {
        lines.push('✅ Списания записаны');
      }
    }

    lines.push(`\n_Откроется в кассе автоматически._`);

    return sendMessage(chatId, lines.join('\n'));
  }
}

// Запуск сервера
app.listen(PORT, () => {
  console.log(`Касса Планета запущена на порту ${PORT}`);
});
