require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const GOOGLE_KEY = process.env.GOOGLE_MAPS_KEY;

function geocode(address) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(address);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encoded}&key=${GOOGLE_KEY}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 'OK' && json.results.length > 0) {
            const loc = json.results[0].geometry.location;
            resolve({ lat: loc.lat, lng: loc.lng });
          } else {
            resolve(null);
          }
        } catch(e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function geocodeTable(tableName, addressCol, cityCol, stateCol, dateCol) {
  console.log(`\n=== Geocoding ${tableName} ===`);

  // Get records with no coordinates
  const { data, error } = await supabase
    .from(tableName)
    .select(`id, ${addressCol}, ${cityCol}, ${stateCol}`)
    .is('latitude', null)
    .limit(2000);

  if (error) {
    console.log(`Error reading ${tableName}:`, error.message);
    return;
  }

  console.log(`Found ${data.length} records without coordinates`);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const address = `${row[addressCol]}, ${row[cityCol]}, ${row[stateCol]}`;

    process.stdout.write(`${i+1}/${data.length} — ${address.substring(0,50)}... `);

    const coords = await geocode(address);

    if (coords) {
      const { error: updateError } = await supabase
        .from(tableName)
        .update({ latitude: coords.lat, longitude: coords.lng })
        .eq('id', row.id);

      if (updateError) {
        console.log(`❌ Update failed: ${updateError.message}`);
        failed++;
      } else {
        console.log(`✅ ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`);
        success++;
      }
    } else {
      console.log(`⚠️  Could not geocode`);
      failed++;
    }

    // Wait 50ms between requests to avoid hitting rate limits
    await sleep(50);
  }

  console.log(`\n${tableName} done: ${success} geocoded, ${failed} failed`);
}

async function main() {
  console.log('Starting geocoding...');
  console.log('This will add coordinates to Dealius and Elifin records.');
  console.log('Do not close this window until it finishes.\n');

  await geocodeTable('dealius_sale_comps',  'address', 'city', 'state');
  await geocodeTable('dealius_lease_comps', 'address', 'city', 'state');
  await geocodeTable('elifin_sale_comps',   'address', 'city', 'state');

  console.log('\n✅ All done! Refresh your dashboard to see all properties on the map.');
}

main().catch(console.error);