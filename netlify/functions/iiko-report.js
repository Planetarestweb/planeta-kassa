// netlify/functions/iiko-report.js

const IIKO_BASE = 'https://api-ru.iiko.services';
const IIKO_RESTO_BASE = 'https://planeta05.iikoweb.ru';

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

async function iikoRequest(path, body, token) {
  const res = await fetch(IIKO_BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: JSON.stringify(body || {})
  });

  const text = await res.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(data.errorDescription || data.message || data.raw || `HTTP ${res.status}`);
  }

  return data;
}

async function restoRequest(path, body, token) {
  const res = await fetch(IIKO_RESTO_BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: JSON.stringify(body || {})
  });

  const text = await res.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(data.errorDescription || data.message || data.raw || `HTTP ${res.status}`);
  }

  return data;
}

async function getToken(apiKey) {
  const data = await iikoRequest('/api/1/access_token', {
    apiLogin: apiKey
  });

  if (!data.token) {
    throw new Error('iiko не вернул token');
  }

  return data.token;
}

function dateRange(date) {
  return {
    isoFrom: `${date}T00:00:00`,
    isoTo: `${date}T23:59:59`,
    dateFrom: `${date} 00:00:00.000`,
    dateTo: `${date} 23:59:59.999`
  };
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
        x.paymentGroupName
      ].filter(Boolean).join(' ').toLowerCase();

      const amount =
        Number(x.sum) ||
        Number(x.amount) ||
        Number(x.paymentSum) ||
        Number(x.total) ||
        Number(x.value) ||
        Number(x.revenue) ||
        Number(x.cash) ||
        Number(x.card) ||
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
    const apiKey = process.env.IIKO_API_KEY;
    const envOrgId = process.env.IIKO_ORGANIZATION_ID || '';

    if (!apiKey) {
      return json(500, {
        ok: false,
        error: 'Нет переменной IIKO_API_KEY в Netlify'
      });
    }

    const date =
      event.queryStringParameters?.date ||
      new Date().toISOString().slice(0, 10);

    const token = await getToken(apiKey);

    const orgsData = await iikoRequest('/api/1/organizations', {
      organizationIds: null,
      returnAdditionalInfo: true,
      includeDisabled: false
    }, token);

    const orgs = orgsData.organizations || [];
    const orgId = envOrgId || orgs[0]?.id;

    if (!orgId) {
      return json(500, {
        ok: false,
        error: 'Не найден organizationId',
        organizations: orgs
      });
    }

    const r = dateRange(date);

    const attempts = [
      {
        name: 'deliveries',
        source: 'cloud',
        path: '/api/1/deliveries/by_delivery_date_and_status',
        body: {
          organizationIds: [orgId],
          deliveryDateFrom: r.isoFrom,
          deliveryDateTo: r.isoTo,
          statuses: ['Closed', 'Delivered']
        }
      },

      {
        name: 'table_orders',
        source: 'cloud',
        path: '/api/1/order/by_table',
        body: {
          organizationIds: [orgId],
          tableIds: [],
          dateFrom: r.isoFrom,
          dateTo: r.isoTo,
          statuses: ['Closed']
        }
      },

      {
        name: 'cashshifts_resto',
        source: 'resto',
        path: '/resto/api/v2/cashshifts/list',
        body: {
          organizationId: orgId,
          openDateFrom: r.isoFrom,
          openDateTo: r.isoTo
        }
      }
    ];

    const debug = [];

    for (const attempt of attempts) {
      try {
        const data = attempt.source === 'resto'
          ? await restoRequest(attempt.path, attempt.body, token)
          : await iikoRequest(attempt.path, attempt.body, token);

        const totals = extractPaymentTotals(data);

        debug.push({
          method: attempt.name,
          source: attempt.source,
          path: attempt.path,
          body: attempt.body,
          cash: totals.cash,
          card: totals.card,
          sample: data
        });

        if (totals.cash > 0 || totals.card > 0) {
          return json(200, {
            ok: true,
            date,
            organizationId: orgId,
            method: attempt.name,
            cash: totals.cash,
            card: totals.card,
            debug
          });
        }
      } catch (e) {
        debug.push({
          method: attempt.name,
          source: attempt.source,
          path: attempt.path,
          body: attempt.body,
          error: e.message
        });
      }
    }

    return json(200, {
      ok: false,
      error: 'Подключение есть, но суммы налички/карты не найдены. Пришли debug из ответа функции.',
      date,
      organizationId: orgId,
      cash: 0,
      card: 0,
      debug
    });

  } catch (e) {
    return json(500, {
      ok: false,
      error: e.message
    });
  }
};
