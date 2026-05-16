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

function sha1(text) {
  return crypto
    .createHash('sha1')
    .update(String(text), 'utf8')
    .digest('hex');
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

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json,text/plain,*/*',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
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

function hideKey(url, key) {
  return String(url).replace(encodeURIComponent(key), '***KEY_HIDDEN***');
}

function buildUrl(base, path, params) {
  const url = new URL(path, base);

  Object.entries(params).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach(v => url.searchParams.append(key, v));
    } else if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  });

  return url.toString();
}

async function getRestoKey() {
  if (!IIKO_RESTO_LOGIN || !IIKO_RESTO_PASSWORD) {
    throw new Error('Нет IIKO_RESTO_LOGIN или IIKO_RESTO_PASSWORD в Netlify');
  }

  const base = IIKO_RESTO_BASE.replace(/\/$/, '');
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

      // Явные поля кассовой смены iiko
      if (Number(x.salesCash) > 0) cash += Number(x.salesCash);
      if (Number(x.salesCard) > 0) card += Number(x.salesCard);

      // Дополнительные возможные поля налички/карты
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

function normalizeRows(data) {
  if (!data) return [];

  if (Array.isArray(data)) return data;

  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.rows)) return data.rows;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.result)) return data.result;

  return [];
}

function pickValue(row, exactKeys, includesKeys = []) {
  if (!row || typeof row !== 'object') return null;

  for (const key of exactKeys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
      return row[key];
    }
  }

  const entries = Object.entries(row);

  for (const [key, value] of entries) {
    const lowKey = String(key).toLowerCase();
    if (
      value !== undefined &&
      value !== null &&
      value !== '' &&
      includesKeys.some(part => lowKey.includes(part.toLowerCase()))
    ) {
      return value;
    }
  }

  return null;
}

function toNum(value) {
  if (value === undefined || value === null || value === '') return 0;

  if (typeof value === 'number') return value;

  const cleaned = String(value)
    .replace(/\s/g, '')
    .replace(',', '.')
    .replace(/[^\d.-]/g, '');

  return Number(cleaned) || 0;
}

function parseWaitersFromOlap(data) {
  const rows = normalizeRows(data);
  const map = new Map();

  for (const row of rows) {
    const waiterRaw = pickValue(
      row,
      [
        'OrderWaiter.Name',
        'OrderWaiter',
        'Waiter.Name',
        'Waiter',
        'User.Name',
        'Cashier.Name',
        'Employee.Name',
        'Delivery.Customer.Name'
      ],
      ['waiter', 'официант', 'employee', 'cashier', 'user']
    );

    const paymentRaw = pickValue(
      row,
      [
        'PayTypes.Name',
        'PaymentTypes.Name',
        'PaymentType.Name',
        'PaymentType',
        'Payment',
        'PayType'
      ],
      ['paytype', 'payment', 'оплат', 'платеж']
    );

    const payText = String(paymentRaw || '').toLowerCase();

    const isCash =
      payText.includes('cash') ||
      payText.includes('нал') ||
      payText.includes('налич');

    if (!isCash) continue;

    const amountRaw = pickValue(
      row,
      [
        'PayTypes.Sum',
        'PaymentTypes.Sum',
        'Payment.Sum',
        'PaymentSum',
        'PaySum',
        'Sum',
        'sum',
        'Amount',
        'amount',
        'Revenue',
        'revenue',
        'DishDiscountSumInt'
      ],
      ['sum', 'amount', 'revenue', 'выруч', 'сумм']
    );

    const amount = toNum(amountRaw);

    if (amount <= 0) continue;

    const waiter = String(waiterRaw || 'Без официанта').trim() || 'Без официанта';
    map.set(waiter, (map.get(waiter) || 0) + amount);
  }

  return Array.from(map.entries())
    .map(([name, cash]) => ({
      name,
      cash: Math.round(cash)
    }))
    .sort((a, b) => b.cash - a.cash);
}

async function getWaitersCashFromOlap(base, key, date) {
  const dayFrom = date;

const nextDayDate = new Date(date + 'T00:00:00Z');
nextDayDate.setUTCDate(nextDayDate.getUTCDate() + 1);

const dayTo = nextDayDate.toISOString().slice(0, 10);

  const url = buildUrl(base, '/resto/api/v2/reports/olap', {
    key
  });

  const attempts = [
    {
      name: 'sales_waiter_paytypes',
      body: {
        reportType: 'SALES',
        buildSummary: false,
        groupByRowFields: ['WaiterName', 'PayTypes'],
        aggregateFields: ['DishDiscountSumInt'],
        filters: {
          'OpenDate.Typed': {
            filterType: 'DateRange',
            periodType: 'CUSTOM',
            from: dayFrom,
            to: dayTo
          }
        }
      }
    },
    {
      name: 'sales_waiter_paymenttype',
      body: {
        reportType: 'SALES',
        buildSummary: false,
        groupByRowFields: ['WaiterName', 'PaymentType'],
        aggregateFields: ['DishDiscountSumInt'],
        filters: {
          'OpenDate.Typed': {
            filterType: 'DateRange',
            periodType: 'CUSTOM',
            from: dayFrom,
            to: dayTo
          }
        }
      }
    },
    {
      name: 'sales_waiter_paymenttypes',
      body: {
        reportType: 'SALES',
        buildSummary: false,
        groupByRowFields: ['WaiterName', 'PaymentTypes'],
        aggregateFields: ['DishDiscountSumInt'],
        filters: {
          'OpenDate.Typed': {
            filterType: 'DateRange',
            periodType: 'CUSTOM',
            from: dayFrom,
            to: dayTo
          }
        }
      }
    },
    {
      name: 'sales_waiter_payment_kind',
      body: {
        reportType: 'SALES',
        buildSummary: false,
        groupByRowFields: ['WaiterName', 'PaymentType.Kind'],
        aggregateFields: ['DishDiscountSumInt'],
        filters: {
          'OpenDate.Typed': {
            filterType: 'DateRange',
            periodType: 'CUSTOM',
            from: dayFrom,
            to: dayTo
          }
        }
      }
    },
    {
      name: 'sales_waiter_only',
      body: {
        reportType: 'SALES',
        buildSummary: false,
        groupByRowFields: ['WaiterName'],
        aggregateFields: ['DishDiscountSumInt'],
        filters: {
          'OpenDate.Typed': {
            filterType: 'DateRange',
            periodType: 'CUSTOM',
            from: dayFrom,
            to: dayTo
          }
        }
      }
    }
  ];

  const debug = [];

  for (const attempt of attempts) {
    const result = await postJson(url, attempt.body);
    const waitersCash = result.ok ? parseWaitersFromOlap(result.data) : [];

    debug.push({
      method: attempt.name,
      url: hideKey(url, key),
      status: result.status,
      ok: result.ok,
      foundWaiters: waitersCash.length,
      body: attempt.body,
      preview: String(result.rawText || '').slice(0, 3000)
    });

    if (waitersCash.length > 0) {
      const total = waitersCash.reduce((s, w) => s + (Number(w.cash) || 0), 0);

      return {
        ok: true,
        waitersCash,
        waitersCashTotal: Math.round(total),
        olapDebug: debug
      };
    }
  }

  try {
    const columnsUrl = buildUrl(base, '/resto/api/v2/reports/olap/columns', {
      key,
      reportType: 'SALES'
    });

    const columnsResult = await getText(columnsUrl);

    let relevantColumns = [];

    if (columnsResult.ok && columnsResult.data && typeof columnsResult.data === 'object') {
      relevantColumns = Object.entries(columnsResult.data)
        .filter(([field, meta]) => {
          const text = [
            field,
            meta?.name,
            ...(Array.isArray(meta?.tags) ? meta.tags : [])
          ].join(' ').toLowerCase();

          return (
            text.includes('официант') ||
            text.includes('waiter') ||
            text.includes('кассир') ||
            text.includes('cashier') ||
            text.includes('оплат') ||
            text.includes('payment') ||
            text.includes('pay') ||
            text.includes('налич') ||
            text.includes('cash')
          );
        })
        .map(([field, meta]) => ({
          field,
          name: meta?.name,
          type: meta?.type,
          aggregationAllowed: meta?.aggregationAllowed,
          groupingAllowed: meta?.groupingAllowed,
          filteringAllowed: meta?.filteringAllowed,
          tags: meta?.tags
        }));
    }

    debug.push({
      method: 'olap_columns_sales_relevant',
      url: hideKey(columnsUrl, key),
      status: columnsResult.status,
      ok: columnsResult.ok,
      relevantColumns,
      preview: String(columnsResult.rawText || '').slice(0, 8000)
    });
  } catch (e) {
    debug.push({
      method: 'olap_columns_sales_relevant',
      ok: false,
      error: e.message
    });
  }

  return {
    ok: false,
    waitersCash: [],
    waitersCashTotal: 0,
    olapDebug: debug
  };
}

exports.handler = async (event) => {
  try {
    const date =
      event.queryStringParameters?.date ||
      new Date().toISOString().slice(0, 10);

    const base = IIKO_RESTO_BASE.replace(/\/$/, '');
    const key = await getRestoKey();

    const cashShiftsUrl =
      `${base}/resto/api/v2/cashshifts/list` +
      `?key=${encodeURIComponent(key)}` +
      `&openDateFrom=${encodeURIComponent(date)}` +
      `&openDateTo=${encodeURIComponent(date)}` +
      `&status=ANY`;

    const cashShiftsResult = await getText(cashShiftsUrl);
    const totals = extractPaymentTotals(cashShiftsResult.data);

    let waitersResult = {
      ok: false,
      waitersCash: [],
      waitersCashTotal: 0,
      olapDebug: []
    };

    if (cashShiftsResult.ok) {
      waitersResult = await getWaitersCashFromOlap(base, key, date);
    }

    return json(200, {
      ok: cashShiftsResult.ok,
      date,
      url: hideKey(cashShiftsUrl, key),
      status: cashShiftsResult.status,
      statusText: cashShiftsResult.statusText,

      cash: totals.cash,
      card: totals.card,

      waitersCash: waitersResult.waitersCash,
      waitersCashTotal: waitersResult.waitersCashTotal,
      waitersCashOk: waitersResult.ok,
      olapDebug: waitersResult.olapDebug,

      message: cashShiftsResult.ok
        ? 'Авторизация прошла, cashshifts/list ответил. OLAP по официантам смотри в waitersCash / olapDebug.'
        : 'Авторизация прошла, но cashshifts/list вернул ошибку.',

      responsePreview:
        typeof cashShiftsResult.rawText === 'string'
          ? cashShiftsResult.rawText.slice(0, 2000)
          : '',

      data: cashShiftsResult.data
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: e.message
    });
  }
};
