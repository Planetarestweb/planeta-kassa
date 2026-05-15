// netlify/functions/iiko-report.js

const crypto = require('crypto');

const IIKO_RESTO_BASE = process.env.IIKO_RESTO_BASE || 'https://planeta05.iiko.it';
const IIKO_RESTO_LOGIN = process.env.IIKO_RESTO_LOGIN || '';
const IIKO_RESTO_PASSWORD = process.env.IIKO_RESTO_PASSWORD || '';

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
  };
}

async function getText(url) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json,text/plain,*/*'
    }
  });

  const text = await res.text();

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    data,
    rawText: text
  };
}

function sha1(text) {
  return crypto
    .createHash('sha1')
    .update(String(text), 'utf8')
    .digest('hex');
}

async function getRestoKey() {
  if (!IIKO_RESTO_LOGIN || !IIKO_RESTO_PASSWORD) {
    throw new Error('Нет IIKO_RESTO_LOGIN или IIKO_RESTO_PASSWORD в Netlify');
  }

  const base = IIKO_RESTO_BASE.replace(/\/$/, '');

  // iiko RESTO API требует SHA1-хэш пароля, а не обычный пароль
  const sha1Password = sha1(IIKO_RESTO_PASSWORD);

  const url =
    `${base}/resto/api/auth` +
    `?login=${encodeURIComponent(IIKO_RESTO_LOGIN)}` +
    `&pass=${encodeURIComponent(sha1Password)}`;

  const result = await getText(url);

  if (!result.ok) {
    throw new Error(
      `Ошибка авторизации iiko resto: HTTP ${result.status}. ` +
      String(result.rawText || '').slice(0, 500)
    );
  }

  const key =
    typeof result.data === 'string'
      ? result.data
      : String(result.rawText || '').trim();

  if (!key || key.toLowerCase().includes('error')) {
    throw new Error(
      'iiko не вернул key авторизации: ' +
      String(result.rawText || '').slice(0, 500)
    );
  }

  return key.replace(/^"|"$/g, '').trim();
}

function extractPaymentTotals(obj) {
  let cash = 0;
  let card = 0;

  function walk(x) {
    if (!x) return;

    if (Array.isArray(x)) {
      x.forEach(walk);
      return;
    }

    if (typeof x === 'object') {
      const text = [
        x.paymentTypeKind,
        x.paymentTypeName,
        x.paymentType,
        x.type,
        x.name,
        x.title,
        x.paymentName,
        x.paymentSystemName,
        x.paymentTypeId,
        x.kind,
        x.paymentGroupName,
        x.paymentGroup,
        x.paymentSystem,
        x.paymentKind
      ].filter(Boolean).join(' ').toLowerCase();

      const amount =
        Number(x.sum) ||
        Number(x.amount) ||
        Number(x.paymentSum) ||
        Number(x.total) ||
        Number(x.value) ||
        Number(x.revenue) ||
        0;

      if (amount > 0) {
        if (
          text.includes('cash') ||
          text.includes('нал') ||
          text.includes('налич')
        ) {
          cash += amount;
        }

        if (
          text.includes('card') ||
          text.includes('карт') ||
          text.includes('bankcard') ||
          text.includes('credit') ||
          text.includes('безнал')
        ) {
          card += amount;
        }
      }

      // Если iiko вернёт явные поля налички/карты
      if (Number(x.cashSum) > 0) cash += Number(x.cashSum);
      if (Number(x.cardSum) > 0) card += Number(x.cardSum);
      if (Number(x.cash) > 0) cash += Number(x.cash);
      if (Number(x.card) > 0) card += Number(x.card);

      Object.values(x).forEach(walk);
    }
  }

  walk(obj);

  return {
    cash: Math.round(cash),
    card: Math.round(card)
  };
}

exports.handler = async (event) => {
  try {
    const date =
      event.queryStringParameters?.date ||
      new Date().toISOString().slice(0, 10);

    const base = IIKO_RESTO_BASE.replace(/\/$/, '');
    const key = await getRestoKey();

    const url =
      `${base}/resto/api/v2/cashshifts/list` +
      `?key=${encodeURIComponent(key)}` +
      `&openDateFrom=${encodeURIComponent(date)}` +
      `&openDateTo=${encodeURIComponent(date)}` +
      `&status=ANY`;

    const result = await getText(url);
    const totals = extractPaymentTotals(result.data);

    return json(200, {
      ok: result.ok,
      date,
      url: url.replace(encodeURIComponent(key), '***KEY_HIDDEN***'),
      status: result.status,
      statusText: result.statusText,
      cash: totals.cash,
      card: totals.card,
      message: result.ok
        ? 'Авторизация прошла, cashshifts/list ответил.'
        : 'Авторизация прошла, но cashshifts/list вернул ошибку.',
      responsePreview:
        typeof result.rawText === 'string'
          ? result.rawText.slice(0, 2000)
          : '',
      data: result.data
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: e.message
    });
  }
};
