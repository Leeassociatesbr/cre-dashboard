require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const DB_SCHEMA = `
You are an AI assistant for a commercial real estate brokerage in Louisiana.
You have access to 5 tables in a PostgreSQL database.

TABLE: buildout_sale_comps
date column = sale_date
price column = sale_price (numeric)
size column = building_sf (numeric)
Columns: id, source, source_id, status, property_type, property_name, address, city, state, zip, sale_price, sale_date, cap_rate, noi, lot_size_acres, building_sf, building_class, year_built, num_units, occupancy_pct, description, latitude, longitude, photo_url

TABLE: buildout_lease_comps
date column = lease_date
rate column = lease_rate (numeric)
size column = leased_sf (numeric)
Columns: id, source, source_id, status, property_name, address, city, state, zip, latitude, longitude, lease_date, property_type, leased_sf, lease_rate, lease_type, suite, building_class, building_sf, lot_size_acres, description, photo_url, lease_rate_note

TABLE: dealius_sale_comps
date column = close_date (NOT sale_date)
price column = sale_price (numeric)
size column = building_sf (numeric)
Columns: id, source, source_id, dealius_deal_id, property_name, address, city, state, zip, county, submarket, property_type, building_sf, sf_sold, acres, zoning, tenancy, primary_use, asking_price, sale_price, price_per_sf, close_date, owner_occupied, investment_sale, off_market, construction_type, industrial_sf, office_sf, seller, buyer, lead_brokers, seller_rep, buyer_rep, confidential, dealius_link

TABLE: dealius_lease_comps
date column = commencement_date
rate column = effective_rate (numeric)
size column = leased_sf (numeric)
Columns: id, source, source_id, dealius_deal_id, property_name, address, city, state, zip, county, submarket, property_type, building_sf, leased_sf, suite, space_type, acres, tenancy, primary_use, lease_type, lease_structure, effective_rate, effective_rate_type, total_lease_value, lease_term, commencement_date, expiration_date, execution_date, free_rent_months, ti_per_sf, nnn_per_sf, cams_per_sf, landlord, tenant, lead_brokers, landlord_rep, tenant_rep, confidential, dealius_link

TABLE: elifin_sale_comps
date column = sale_date
price column = sale_price (numeric)
size column = size_sf (numeric) NOT building_sf
market column = market (Baton Rouge, Lafayette, New Orleans, Northshore)
Columns: id, source, market, address, city, state, zip, property_type, size_sf, sale_price, price_per_sf, sale_date, published_date, buyer, notes

CRITICAL RULES ABOUT WHICH TABLES TO QUERY:

RULE 1 — ALWAYS search ALL relevant tables by default:
- For ANY question about sales, prices, or sale comps → query buildout_sale_comps AND dealius_sale_comps AND elifin_sale_comps using UNION ALL
- For ANY question about leases, lease rates, or lease comps → query buildout_lease_comps AND dealius_lease_comps using UNION ALL
- For ANY question about "all comps", "total", "how many", "average", "market" → query ALL 5 tables
- NEVER query just one table unless the user specifically says "in Buildout" or "in Dealius" or "in Elifin"

RULE 2 — UNION ALL type casting — always cast to matching types:
- All price/rate columns: ::numeric
- All size/sf columns: ::numeric  
- All text columns: ::text
- zip always: zip::text
- Missing columns in a table: NULL::numeric or NULL::text
- dealius_sale_comps date is close_date not sale_date — cast as close_date::text AS sale_date
- elifin_sale_comps size is size_sf not building_sf — cast as size_sf::numeric AS building_sf

RULE 3 — Standard UNION ALL pattern for sale queries:
SELECT address::text, city::text, state::text, property_type::text, 
       sale_price::numeric, sale_date::text AS sale_date, 
       building_sf::numeric, 'buildout' AS source
FROM buildout_sale_comps WHERE sale_price::numeric > 0
UNION ALL
SELECT address::text, city::text, state::text, property_type::text,
       sale_price::numeric, close_date::text AS sale_date,
       building_sf::numeric, 'dealius' AS source
FROM dealius_sale_comps WHERE sale_price::numeric > 0
UNION ALL
SELECT address::text, city::text, state::text, property_type::text,
       sale_price::numeric, sale_date::text AS sale_date,
       size_sf::numeric AS building_sf, 'elifin' AS source
FROM elifin_sale_comps WHERE sale_price::numeric > 0

RULE 4 — Standard UNION ALL pattern for lease queries:
SELECT address::text, city::text, state::text, property_type::text,
       lease_rate::numeric AS rate, lease_date::text AS lease_date,
       leased_sf::numeric, 'buildout' AS source
FROM buildout_lease_comps WHERE lease_rate::numeric > 0 AND lease_rate::numeric < 500
UNION ALL
SELECT address::text, city::text, state::text, property_type::text,
       effective_rate::numeric AS rate, commencement_date::text AS lease_date,
       leased_sf::numeric, 'dealius' AS source
FROM dealius_lease_comps WHERE effective_rate::numeric > 0

RULE 5 — Other SQL rules:
- Return ONLY the raw SQL query — no explanation, no markdown, no backticks, no intro text
- Never end the query with a semicolon
- Only SELECT statements — never INSERT, UPDATE, DELETE or DROP
- For city searches always use ILIKE '%city%'
- Always LIMIT 100 unless user asks for counts, totals, or averages
- Never compare text to numbers without casting: column::numeric
`;

// ── AI CHAT (with conversation memory) ───────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { question, history } = req.body;
  if (!question) return res.status(400).json({ error: 'No question provided' });

  try {
    const conversationMessages = [];
    if (history && history.length > 0) {
      history.forEach(exchange => {
        conversationMessages.push({ role: 'user', content: exchange.question });
        conversationMessages.push({ role: 'assistant', content: exchange.sql });
      });
    }
    conversationMessages.push({ role: 'user', content: question });

    const sqlResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: DB_SCHEMA,
      messages: conversationMessages
    });

    let sqlQuery = sqlResponse.content[0].text
      .replace(/```sql/gi, '')
      .replace(/```/g, '')
      .replace(/;\s*$/, '')
      .trim();

    const lines = sqlQuery.split('\n');
    const sqlStart = lines.findIndex(l =>
      l.trim().toUpperCase().startsWith('SELECT') ||
      l.trim().toUpperCase().startsWith('WITH')
    );
    if (sqlStart > 0) sqlQuery = lines.slice(sqlStart).join('\n').trim();
    sqlQuery = sqlQuery.replace(/;\s*$/, '').trim();

    console.log('\n--- SQL ---\n', sqlQuery, '\n---\n');

    const { data, error } = await supabase.rpc('run_query', { query: sqlQuery });

    if (error) {
      console.error('Supabase error:', error.message);
      return res.json({
        answer: `I could not run that query. Error: ${error.message}. Please try rephrasing.`,
        sql: sqlQuery,
        error: error.message,
        recordCount: 0
      });
    }

    // Fix record count — unwrap nested array from run_query
    let actualData = data;
    if (Array.isArray(data) && data.length === 1 && Array.isArray(data[0])) {
      actualData = data[0];
    }
    const recordCount = Array.isArray(actualData) ? actualData.length : 0;

    const answerMessages = [];
    if (history && history.length > 0) {
      history.forEach(exchange => {
        answerMessages.push({ role: 'user', content: exchange.question });
        answerMessages.push({ role: 'assistant', content: exchange.answer });
      });
    }
    answerMessages.push({
      role: 'user',
      content: `User asked: "${question}"\n\nDatabase returned ${recordCount} records:\n${JSON.stringify(actualData, null, 2)}\n\nAnswer in clean plain text. At the end add: "Based on ${recordCount} records from the database."`
    });

    const answerResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: `You are a commercial real estate data assistant for a brokerage in Louisiana.
Answer in clean plain text only. No markdown, no ##, no **, no |, no bullet points with -.
Write like a professional memo. For multiple results use numbered lines: 1. Address — $500,000
Format dollars as $1,250,000. Format SF as 12,500 SF. Format rates as $15.50/SF/yr.
Keep answers brief and to the point. If no results say so in one sentence.
Always end with: "Based on X records from the database." on its own line.`,
      messages: answerMessages
    });

    res.json({
      answer: answerResponse.content[0].text,
      sql: sqlQuery,
      data: actualData,
      recordCount
    });

  } catch (err) {
    console.error('Server error:', err.message);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ── AREA CHAT ─────────────────────────────────────────────────────────────────
app.post('/area-chat', async (req, res) => {
  const { question, properties, history } = req.body;
  if (!question || !properties) return res.status(400).json({ error: 'Missing data' });

  try {
    const messages = [];
    if (history && history.length > 0) {
      history.forEach(exchange => {
        messages.push({ role: 'user', content: exchange.question });
        messages.push({ role: 'assistant', content: exchange.answer });
      });
    }
    messages.push({
      role: 'user',
      content: `The user has selected ${properties.length} properties in a geographic area on the map.

Properties in selected area:
${JSON.stringify(properties.map(p => ({
  address: p.address,
  city: p.city,
  property_type: p.property_type,
  type: p.type,
  sale_price: p.sale_price,
  lease_rate: p.lease_rate,
  building_sf: p.building_sf,
  sale_date: p.sale_date,
  lease_date: p.lease_date,
})), null, 2)}

User question: "${question}"
Answer based only on the properties listed above.`
    });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: `You are a commercial real estate data assistant.
Answer questions about the selected geographic area properties only.
Answer in clean plain text. No markdown, no ##, no **, no bullet points.
Format dollars as $1,250,000. Format SF as 12,500 SF.
End with: "Based on ${properties.length} properties in the selected area."`,
      messages
    });

    res.json({ answer: response.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MAP DATA — all 5 tables with optional bounds filtering ────────────────────
app.get('/map-data', async (req, res) => {
  try {
    const { north, south, east, west } = req.query;
    const hasBounds = north && south && east && west;

    function addBounds(query, latCol='latitude', lngCol='longitude') {
      if (!hasBounds) return query;
      return query
        .gte(latCol, parseFloat(south))
        .lte(latCol, parseFloat(north))
        .gte(lngCol, parseFloat(west))
        .lte(lngCol, parseFloat(east));
    }

    const [bSales, bLeases, dSales, dLeases, eSales] = await Promise.all([
      addBounds(supabase
        .from('buildout_sale_comps')
        .select('id, property_name, address, city, state, property_type, sale_price, sale_date, building_sf, photo_url, latitude, longitude')
        .not('latitude', 'is', null)
        .not('longitude', 'is', null))
        .limit(2000),
      addBounds(supabase
        .from('buildout_lease_comps')
        .select('id, property_name, address, city, state, property_type, lease_rate, lease_date, building_sf, photo_url, latitude, longitude')
        .not('latitude', 'is', null)
        .not('longitude', 'is', null))
        .limit(2000),
      addBounds(supabase
        .from('dealius_sale_comps')
        .select('id, property_name, address, city, state, property_type, sale_price, close_date, building_sf, latitude, longitude')
        .not('latitude', 'is', null)
        .not('longitude', 'is', null))
        .limit(2000),
      addBounds(supabase
        .from('dealius_lease_comps')
        .select('id, property_name, address, city, state, property_type, effective_rate, commencement_date, building_sf, latitude, longitude')
        .not('latitude', 'is', null)
        .not('longitude', 'is', null))
        .limit(2000),
      addBounds(supabase
        .from('elifin_sale_comps')
        .select('id, address, city, state, property_type, sale_price, sale_date, size_sf, latitude, longitude')
        .not('latitude', 'is', null)
        .not('longitude', 'is', null))
        .limit(2000),
    ]);

    const properties = [
      ...(bSales.data  || []).map(p => ({ ...p, table:'buildout_sale_comps',  type:'Sale',  building_sf:p.building_sf })),
      ...(bLeases.data || []).map(p => ({ ...p, table:'buildout_lease_comps', type:'Lease', building_sf:p.building_sf })),
      ...(dSales.data  || []).map(p => ({ ...p, table:'dealius_sale_comps',   type:'Sale',  sale_date:p.close_date, building_sf:p.building_sf })),
      ...(dLeases.data || []).map(p => ({ ...p, table:'dealius_lease_comps',  type:'Lease', lease_rate:p.effective_rate, lease_date:p.commencement_date, building_sf:p.building_sf })),
      ...(eSales.data  || []).map(p => ({ ...p, table:'elifin_sale_comps',    type:'Sale',  building_sf:p.size_sf })),
    ];

    res.json(properties);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── CHARTS DATA ───────────────────────────────────────────────────────────────
app.get('/api/charts', async (req, res) => {
  const { from, to } = req.query;
  const dateFrom = from || '2020-01-01';
  const dateTo   = to   || new Date().toISOString().slice(0, 10);

  try {
    const priceTrendSQL = `
      SELECT
        to_char(date_trunc('quarter', sale_date::date), 'YYYY-MM') AS period,
        ROUND(AVG(sale_price::numeric)) AS avg_price,
        COUNT(*) AS count
      FROM (
        SELECT sale_date::text AS sale_date, sale_price::numeric AS sale_price
        FROM buildout_sale_comps
        WHERE sale_date IS NOT NULL AND sale_date != ''
          AND sale_date::date BETWEEN '${dateFrom}' AND '${dateTo}'
          AND sale_price::numeric > 0
        UNION ALL
        SELECT close_date::text AS sale_date, sale_price::numeric AS sale_price
        FROM dealius_sale_comps
        WHERE close_date IS NOT NULL AND close_date != ''
          AND close_date::date BETWEEN '${dateFrom}' AND '${dateTo}'
          AND sale_price::numeric > 0
        UNION ALL
        SELECT sale_date::text AS sale_date, sale_price::numeric AS sale_price
        FROM elifin_sale_comps
        WHERE sale_date IS NOT NULL AND sale_date != ''
          AND sale_date::date BETWEEN '${dateFrom}' AND '${dateTo}'
          AND sale_price::numeric > 0
      ) t
      GROUP BY period
      ORDER BY period`;

    const volumeSQL = `
      SELECT property_type, COUNT(*) AS count, ROUND(SUM(sale_price::numeric)) AS total_volume
      FROM (
        SELECT property_type::text, sale_price::numeric FROM buildout_sale_comps WHERE sale_price::numeric > 0
        UNION ALL
        SELECT property_type::text, sale_price::numeric FROM dealius_sale_comps WHERE sale_price::numeric > 0
        UNION ALL
        SELECT property_type::text, sale_price::numeric FROM elifin_sale_comps WHERE sale_price::numeric > 0
      ) t
      WHERE property_type IS NOT NULL AND property_type != ''
      GROUP BY property_type
      ORDER BY count DESC`;

    const leaseTrendSQL = `
      SELECT
        to_char(date_trunc('quarter', lease_date::date), 'YYYY-MM') AS period,
        ROUND(AVG(rate::numeric)::numeric, 2) AS avg_rate,
        COUNT(*) AS count
      FROM (
        SELECT lease_date::text AS lease_date, lease_rate::numeric AS rate
        FROM buildout_lease_comps
        WHERE lease_date IS NOT NULL AND lease_date != ''
          AND lease_date::date BETWEEN '${dateFrom}' AND '${dateTo}'
          AND lease_rate::numeric > 0 AND lease_rate::numeric < 500
        UNION ALL
        SELECT commencement_date::text AS lease_date, effective_rate::numeric AS rate
        FROM dealius_lease_comps
        WHERE commencement_date IS NOT NULL AND commencement_date != ''
          AND commencement_date::date BETWEEN '${dateFrom}' AND '${dateTo}'
          AND effective_rate::numeric > 0
      ) t
      GROUP BY period
      ORDER BY period`;

    const ppsfSQL = `
      SELECT
        city,
        ROUND(AVG(sale_price::numeric / NULLIF(building_sf::numeric, 0))::numeric, 2) AS avg_ppsf,
        COUNT(*) AS count
      FROM (
        SELECT city::text, sale_price::numeric, building_sf::numeric
        FROM buildout_sale_comps WHERE sale_price::numeric > 0 AND building_sf::numeric > 0
        UNION ALL
        SELECT city::text, sale_price::numeric, building_sf::numeric
        FROM dealius_sale_comps WHERE sale_price::numeric > 0 AND building_sf::numeric > 0
        UNION ALL
        SELECT city::text, sale_price::numeric, size_sf::numeric AS building_sf
        FROM elifin_sale_comps WHERE sale_price::numeric > 0 AND size_sf::numeric > 0
      ) t
      WHERE city IS NOT NULL AND city != ''
      GROUP BY city
      HAVING COUNT(*) >= 3
      ORDER BY avg_ppsf DESC
      LIMIT 15`;

    const [priceTrend, volume, leaseTrend, ppsf] = await Promise.all([
      supabase.rpc('run_query', { query: priceTrendSQL }),
      supabase.rpc('run_query', { query: volumeSQL }),
      supabase.rpc('run_query', { query: leaseTrendSQL }),
      supabase.rpc('run_query', { query: ppsfSQL }),
    ]);

    res.json({
      priceTrend: priceTrend.data || [],
      volume:     volume.data     || [],
      leaseTrend: leaseTrend.data || [],
      ppsf:       ppsf.data       || [],
    });

  } catch (err) {
    console.error('Charts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── MARKETS DATA ──────────────────────────────────────────────────────────────
app.get('/api/markets', async (req, res) => {
  try {
    const sql = `
      SELECT
        city,
        COUNT(*) AS total_sales,
        ROUND(AVG(sale_price::numeric)) AS avg_sale_price,
        ROUND(SUM(sale_price::numeric)) AS total_volume,
        ROUND(AVG(sale_price::numeric / NULLIF(building_sf::numeric,0))::numeric, 2) AS avg_ppsf,
        MIN(sale_date::text) AS earliest_sale,
        MAX(sale_date::text) AS latest_sale
      FROM (
        SELECT city::text, sale_price::numeric, building_sf::numeric, sale_date::text
        FROM buildout_sale_comps WHERE sale_price::numeric > 0 AND city IS NOT NULL
        UNION ALL
        SELECT city::text, sale_price::numeric, building_sf::numeric, close_date::text
        FROM dealius_sale_comps WHERE sale_price::numeric > 0 AND city IS NOT NULL
        UNION ALL
        SELECT city::text, sale_price::numeric, size_sf::numeric, sale_date::text
        FROM elifin_sale_comps WHERE sale_price::numeric > 0 AND city IS NOT NULL
      ) t
      GROUP BY city
      HAVING COUNT(*) >= 3
      ORDER BY total_sales DESC
      LIMIT 20`;

    const { data, error } = await supabase.rpc('run_query', { query: sql });
    if (error) throw new Error(error.message);
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── RECENT ACTIVITY ───────────────────────────────────────────────────────────
app.get('/api/recent', async (req, res) => {
  try {
    const sql = `
      SELECT * FROM (
        SELECT
          'Sale' AS comp_type, 'Buildout' AS source_name,
          COALESCE(property_name, address) AS name,
          address, city, state, property_type,
          sale_price::numeric AS price, NULL::numeric AS rate,
          sale_date AS date
        FROM buildout_sale_comps
        WHERE sale_date IS NOT NULL AND sale_date != ''
        ORDER BY sale_date DESC LIMIT 4
      ) a
      UNION ALL
      SELECT * FROM (
        SELECT
          'Sale' AS comp_type, 'Dealius' AS source_name,
          COALESCE(property_name, address) AS name,
          address, city, state, property_type,
          sale_price::numeric AS price, NULL::numeric AS rate,
          close_date AS date
        FROM dealius_sale_comps
        WHERE close_date IS NOT NULL AND close_date != ''
        ORDER BY close_date DESC LIMIT 3
      ) b
      UNION ALL
      SELECT * FROM (
        SELECT
          'Lease' AS comp_type, 'Buildout' AS source_name,
          address AS name, address, city, state, property_type,
          NULL::numeric AS price, lease_rate::numeric AS rate,
          lease_date AS date
        FROM buildout_lease_comps
        WHERE lease_date IS NOT NULL AND lease_date != ''
        ORDER BY lease_date DESC LIMIT 3
      ) c
      ORDER BY date DESC
      LIMIT 10`;

    const { data, error } = await supabase.rpc('run_query', { query: sql });
    if (error) throw new Error(error.message);
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CRE Dashboard server running on http://localhost:${PORT}`);
});