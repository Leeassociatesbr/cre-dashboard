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

STRICT SQL RULES:
1. Return ONLY the raw SQL query — no explanation, no markdown, no backticks, no intro text
2. Never end the query with a semicolon
3. Only SELECT statements — never INSERT, UPDATE, DELETE or DROP
4. For single table questions query only that one table
5. For UNION ALL cast every column to matching types: ::numeric or ::text, missing columns as NULL::numeric or NULL::text
6. Never compare text to numbers without casting: column::numeric
7. For NNN: dealius_lease_comps.lease_structure = 'NNN' or buildout_lease_comps.lease_type ILIKE '%NNN%'
8. For price per SF: sale_price::numeric / NULLIF(building_sf::numeric, 0)
9. City searches: ILIKE '%city%'
10. Always LIMIT 100 unless user asks for counts or totals
11. For buildout_lease_comps filter lease_rate < 500 to exclude monthly totals
`;

// ── AI CHAT (with conversation memory) ───────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { question, history } = req.body;
  if (!question) return res.status(400).json({ error: 'No question provided' });

  try {
    // Build conversation history for context
    const conversationMessages = [];
    
    // Add previous exchanges if they exist
    if (history && history.length > 0) {
      history.forEach(exchange => {
        conversationMessages.push({ role: 'user', content: exchange.question });
        conversationMessages.push({ role: 'assistant', content: exchange.sql });
      });
    }
    
    // Add current question
    conversationMessages.push({ role: 'user', content: question });

    // Step 1 — Generate SQL with conversation context
    const sqlResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
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

    // Step 2 — Run against Supabase
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

    const recordCount = Array.isArray(data) ? data.length : 0;

    // Step 3 — Build answer messages with history
    const answerMessages = [];
    if (history && history.length > 0) {
      history.forEach(exchange => {
        answerMessages.push({ role: 'user', content: exchange.question });
        answerMessages.push({ role: 'assistant', content: exchange.answer });
      });
    }
    answerMessages.push({
      role: 'user',
      content: `User asked: "${question}"\n\nDatabase returned ${recordCount} records:\n${JSON.stringify(data, null, 2)}\n\nAnswer in clean plain text. At the end add one line: "Based on X records from the database." where X is ${recordCount}.`
    });

    // Step 4 — Generate plain English answer
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
      data,
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

Answer based only on the properties listed above. End with "Based on ${properties.length} properties in the selected area."`
    });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: `You are a commercial real estate data assistant.
The user has selected a geographic area on a map and you have the properties inside that area.
Answer questions about these specific properties only.
Answer in clean plain text. No markdown, no ##, no **, no bullet points with -.
Write like a professional memo. Format dollars as $1,250,000. Format SF as 12,500 SF.
Keep answers brief and to the point.`,
      messages
    });

    res.json({ answer: response.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MAP DATA ──────────────────────────────────────────────────────────────────
app.get('/map-data', async (req, res) => {
  try {
    const [bSales, bLeases] = await Promise.all([
      supabase
        .from('buildout_sale_comps')
        .select('id, property_name, address, city, state, property_type, sale_price, sale_date, building_sf, latitude, longitude')
        .not('latitude', 'is', null)
        .not('longitude', 'is', null),
      supabase
        .from('buildout_lease_comps')
        .select('id, property_name, address, city, state, property_type, lease_rate, lease_date, building_sf, latitude, longitude')
        .not('latitude', 'is', null)
        .not('longitude', 'is', null),
    ]);

    const properties = [
      ...(bSales.data || []).map(p => ({ ...p, table: 'buildout_sale_comps', type: 'Sale' })),
      ...(bLeases.data || []).map(p => ({ ...p, table: 'buildout_lease_comps', type: 'Lease' })),
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
        SELECT property_type::text, sale_price::numeric AS sale_price FROM buildout_sale_comps WHERE sale_price::numeric > 0
        UNION ALL
        SELECT property_type::text, sale_price::numeric AS sale_price FROM dealius_sale_comps WHERE sale_price::numeric > 0
        UNION ALL
        SELECT property_type::text, sale_price::numeric AS sale_price FROM elifin_sale_comps WHERE sale_price::numeric > 0
      ) t
      WHERE property_type IS NOT NULL AND property_type != ''
      GROUP BY property_type
      ORDER BY count DESC`;

    const leaseTrendSQL = `
      SELECT
        to_char(date_trunc('quarter', lease_date::date), 'YYYY-MM') AS period,
        ROUND(AVG(lease_rate::numeric)::numeric, 2) AS avg_rate,
        COUNT(*) AS count
      FROM buildout_lease_comps
      WHERE lease_date IS NOT NULL AND lease_date != ''
        AND lease_date::date BETWEEN '${dateFrom}' AND '${dateTo}'
        AND lease_rate::numeric > 0 AND lease_rate::numeric < 500
      GROUP BY period
      ORDER BY period`;

    const ppsfSQL = `
      SELECT
        city,
        ROUND(AVG(sale_price::numeric / NULLIF(building_sf::numeric, 0))::numeric, 2) AS avg_ppsf,
        COUNT(*) AS count
      FROM (
        SELECT city::text, sale_price::numeric AS sale_price, building_sf::numeric AS building_sf
        FROM buildout_sale_comps
        WHERE sale_price::numeric > 0 AND building_sf::numeric > 0
        UNION ALL
        SELECT city::text, sale_price::numeric AS sale_price, building_sf::numeric AS building_sf
        FROM dealius_sale_comps
        WHERE sale_price::numeric > 0 AND building_sf::numeric > 0
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
          'Sale' AS comp_type,
          'Buildout' AS source_name,
          COALESCE(property_name, address) AS name,
          address, city, state,
          property_type,
          sale_price::numeric AS price,
          NULL::numeric AS rate,
          sale_date AS date
        FROM buildout_sale_comps
        WHERE sale_date IS NOT NULL AND sale_date != ''
        ORDER BY sale_date DESC
        LIMIT 5
      ) a
      UNION ALL
      SELECT * FROM (
        SELECT
          'Lease' AS comp_type,
          'Buildout' AS source_name,
          COALESCE(property_name, address) AS name,
          address, city, state,
          property_type,
          NULL::numeric AS price,
          lease_rate::numeric AS rate,
          lease_date AS date
        FROM buildout_lease_comps
        WHERE lease_date IS NOT NULL AND lease_date != ''
        ORDER BY lease_date DESC
        LIMIT 5
      ) b
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