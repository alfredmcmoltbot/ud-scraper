// Required for Zyte proxy (MITM SSL)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

// Lazy-load Kalshi module to prevent crash on import
let scrapeKalshi = null;
try {
  scrapeKalshi = require('./kalshi').scrapeKalshi;
  console.log('[BOOT] Kalshi module loaded successfully');
} catch (err) {
  console.error('[BOOT] Failed to load Kalshi module:', err.message);
}

// Lazy-load DraftKings module
let dkHydrate = null;
try {
  dkHydrate = require('./draftkings').hydrate;
  console.log('[BOOT] DraftKings module loaded successfully');
} catch (err) {
  console.error('[BOOT] Failed to load DraftKings module:', err.message);
}

// Lazy-load PrizePicks module
let ppHydrate = null;
try {
  ppHydrate = require('./prizepicks').hydrate;
  console.log('[BOOT] PrizePicks module loaded successfully');
} catch (err) {
  console.error('[BOOT] Failed to load PrizePicks module:', err.message);
}

// Config
const PUSHER_URL = 'wss://ws-mt1.pusher.com/app/d65207c183930ff953dc?protocol=7&client=js&version=8.3.0&flash=false';
const UNDERDOG_API = 'https://api.underdogfantasy.com/beta/v6/over_under_lines';
const SPORTS = ['NBA', 'CBB', 'NHL', 'PGA', 'MMA', 'UNRIVALED'];
const PING_INTERVAL_MS = 90000; // 90s (timeout is 120s)
const RECONNECT_BASE_MS = 5000;
const HYDRATION_INTERVAL_MS = 300000; // Re-hydrate every 5 min as safety net

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

let ws = null;
let pingTimer = null;
let reconnectAttempts = 0;
let propsCache = new Map(); // prop_id -> current state
let stats = { swaps: 0, removes: 0, hydrations: 0, errors: 0, lastEvent: null };

// ─── Logging ───
function log(level, msg, data) {
  const ts = new Date().toISOString();
  const extra = data ? ` ${JSON.stringify(data)}` : '';
  console.log(`[${ts}] [${level}] ${msg}${extra}`);
}

// ─── REST Hydration ───
async function hydrateFromREST() {
  const startTime = Date.now();
  log('INFO', 'Starting REST hydration...');

  try {
    const resp = await fetch(UNDERDOG_API);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    const lines = data.over_under_lines || [];
    const appearances = data.appearances || [];
    const players = data.players || [];
    const games = [...(data.games || []), ...(data.solo_games || [])];

    // Build lookup maps
    const playerMap = new Map(players.map(p => [p.id, p]));
    const appearanceMap = new Map(appearances.map(a => [a.id, a]));
    const gameMap = new Map(games.map(g => [String(g.id), g]));

    // Upsert players
    if (players.length > 0) {
      const playerRows = players.map(p => ({
        id: p.id,
        first_name: p.first_name,
        last_name: p.last_name,
        sport_id: p.sport_id,
        team_id: p.team?.id || null,
        team_name: p.team?.abbr || p.team?.name || null,
        position: p.position_name || null,
        image_url: p.image_url || null,
        updated_at: new Date().toISOString()
      }));
      // Batch in chunks of 500
      for (let i = 0; i < playerRows.length; i += 500) {
        const chunk = playerRows.slice(i, i + 500);
        const { error } = await supabase.from('ud_players').upsert(chunk, { onConflict: 'id' });
        if (error) log('ERROR', 'Player upsert error', { error: error.message, chunk: i });
      }
    }

    // Upsert games
    if (games.length > 0) {
      const gameRows = games.map(g => ({
        id: String(g.id),
        sport_id: g.sport_id || null,
        title: g.title || g.name || null,
        scheduled_at: g.scheduled_at || null,
        status: g.status || null,
        home_team: g.home_team?.abbr || g.home_team?.name || null,
        away_team: g.away_team?.abbr || g.away_team?.name || null,
        updated_at: new Date().toISOString()
      }));
      for (let i = 0; i < gameRows.length; i += 500) {
        const chunk = gameRows.slice(i, i + 500);
        const { error } = await supabase.from('ud_games').upsert(chunk, { onConflict: 'id' });
        if (error) log('ERROR', 'Game upsert error', { error: error.message });
      }
    }

    // Process lines into props
    let propsCount = 0;
    let historyRows = [];
    const propRows = [];

    for (const line of lines) {
      const appearanceId = line.over_under?.appearance_stat?.appearance_id;
      const appearance = appearanceMap.get(appearanceId);
      if (!appearance) continue;

      const player = playerMap.get(appearance.player_id);
      const matchId = String(appearance.match_id);
      const game = gameMap.get(matchId) || gameMap.get(appearance.match_id);
      const statType = line.over_under?.appearance_stat?.display_stat || 'unknown';
      const statDisplay = line.over_under?.appearance_stat?.display_stat || statType;

      const options = line.options || [];
      const higher = options.find(o => o.choice === 'higher' || o.choice === 'home' || o.choice === 'competitor');
      const lower = options.find(o => o.choice === 'lower' || o.choice === 'away');

      const propId = line.id;
      const statValue = line.stat_value != null ? parseFloat(line.stat_value) : null;

      const prop = {
        id: propId,
        source: 'underdog',
        appearance_id: appearanceId || null,
        player_id: appearance.player_id || null,
        game_id: matchId || null,
        sport_id: player?.sport_id || appearance.sport_id || 'unknown',
        stat_type: statType,
        stat_display: statDisplay,
        stat_value: statValue,
        over_price: higher?.american_price || null,
        under_price: lower?.american_price || null,
        over_decimal: higher?.decimal_price ? parseFloat(higher.decimal_price) : null,
        under_decimal: lower?.decimal_price ? parseFloat(lower.decimal_price) : null,
        line_type: line.line_type || 'balanced',
        status: 'active',
        choice_display: higher?.choice_display || null,
        player_name: player ? `${player.first_name} ${player.last_name}` : (higher?.selection_header || higher?.choice_display || null),
        team_abbr: player?.team?.abbr || appearance?.team_id || null,
        game_display: game?.title || null,
        updated_at: new Date().toISOString()
      };

      propRows.push(prop);
      propsCache.set(propId, prop);
      propsCount++;

      // Record initial state in history
      historyRows.push({
        prop_id: propId,
        appearance_id: prop.appearance_id,
        stat_value: statValue,
        over_price: prop.over_price,
        under_price: prop.under_price,
        over_decimal: prop.over_decimal,
        under_decimal: prop.under_decimal,
        event_type: 'hydration',
        recorded_at: new Date().toISOString()
      });
    }

    // Batch upsert props
    for (let i = 0; i < propRows.length; i += 500) {
      const chunk = propRows.slice(i, i + 500);
      const { error } = await supabase.from('ud_props').upsert(chunk, { onConflict: 'id' });
      if (error) log('ERROR', 'Props upsert error', { error: error.message, chunk: i });
    }

    // Only insert history on first hydration (not every 5 min)
    if (stats.hydrations === 0 && historyRows.length > 0) {
      for (let i = 0; i < historyRows.length; i += 500) {
        const chunk = historyRows.slice(i, i + 500);
        const { error } = await supabase.from('ud_line_history').insert(chunk);
        if (error) log('ERROR', 'History insert error', { error: error.message });
      }
    }

    const duration = Date.now() - startTime;
    stats.hydrations++;

    // Log scrape run
    await supabase.from('ud_scrape_runs').insert({
      run_type: 'hydration',
      props_count: propsCount,
      changes_count: propsCount,
      duration_ms: duration,
      status: 'success',
      started_at: new Date().toISOString()
    });

    log('INFO', `Hydration complete`, { props: propsCount, players: players.length, games: games.length, duration: `${duration}ms` });
  } catch (err) {
    stats.errors++;
    log('ERROR', 'Hydration failed', { error: err.message });
    await supabase.from('ud_scrape_runs').insert({
      run_type: 'hydration',
      status: 'error',
      error: err.message,
      started_at: new Date().toISOString()
    });
  }
}

// ─── WebSocket Event Handlers ───
async function handleSwap(channel, payload) {
  const items = Array.isArray(payload) ? payload : [payload];
  const sport = channel.replace('over_under_lines-', '').replace('-balanced', '');

  for (const item of items) {
    try {
      const newLine = item.new_line || item;
      const propId = newLine.id;
      if (!propId) continue;

      const options = newLine.options || [];
      const higher = options.find(o => o.choice === 'higher' || o.choice === 'home' || o.choice === 'competitor');
      const lower = options.find(o => o.choice === 'lower' || o.choice === 'away');

      const statValue = newLine.stat_value != null ? parseFloat(newLine.stat_value) : null;
      const overPrice = higher?.american_price || null;
      const underPrice = lower?.american_price || null;
      const overDecimal = higher?.decimal_price ? parseFloat(higher.decimal_price) : null;
      const underDecimal = lower?.decimal_price ? parseFloat(lower.decimal_price) : null;

      // Check if anything actually changed
      const cached = propsCache.get(propId);
      const changed = !cached ||
        cached.stat_value !== statValue ||
        cached.over_price !== overPrice ||
        cached.under_price !== underPrice;

      const now = new Date().toISOString();

      // Always update the prop
      const propUpdate = {
        id: propId,
        source: 'underdog',
        appearance_id: item.appearance_id || cached?.appearance_id || null,
        sport_id: sport,
        stat_value: statValue,
        over_price: overPrice,
        under_price: underPrice,
        over_decimal: overDecimal,
        under_decimal: underDecimal,
        status: 'active',
        player_name: higher?.choice_display || cached?.player_name || null,
        choice_display: higher?.choice_display || cached?.choice_display || null,
        stat_type: cached?.stat_type || 'unknown',
        stat_display: cached?.stat_display || null,
        player_id: cached?.player_id || null,
        game_id: cached?.game_id || null,
        team_abbr: cached?.team_abbr || null,
        game_display: cached?.game_display || null,
        updated_at: now
      };

      const { error: propError } = await supabase.from('ud_props').upsert(propUpdate, { onConflict: 'id' });
      if (propError) log('ERROR', 'Prop upsert error', { propId, error: propError.message });

      // Record history only if changed
      if (changed) {
        const { error: histError } = await supabase.from('ud_line_history').insert({
          prop_id: propId,
          appearance_id: item.appearance_id || null,
          stat_value: statValue,
          over_price: overPrice,
          under_price: underPrice,
          over_decimal: overDecimal,
          under_decimal: underDecimal,
          event_type: 'swap',
          source: 'underdog',
          recorded_at: now
        });
        if (histError) log('ERROR', 'History insert error', { propId, error: histError.message });
      }

      // Update cache
      propsCache.set(propId, { ...cached, ...propUpdate });
      stats.swaps++;
      stats.lastEvent = now;

      if (changed) {
        log('SWAP', `${sport} | ${propUpdate.player_name || propId} | ${propUpdate.stat_type} ${statValue} | O:${overPrice} U:${underPrice}`);
      }
    } catch (err) {
      stats.errors++;
      log('ERROR', 'Swap handler error', { error: err.message });
    }
  }
}

async function handleRemove(channel, payload) {
  const sport = channel.replace('over_under_lines-', '').replace('-balanced', '');
  const now = new Date().toISOString();

  // remove_v2 payload is typically an array of objects with appearance_id + line info
  const items = Array.isArray(payload) ? payload : [payload];

  for (const item of items) {
    try {
      const lineId = item.id || item.line_id;
      if (lineId) {
        await supabase.from('ud_props').update({ status: 'removed', updated_at: now }).eq('id', lineId);
        await supabase.from('ud_line_history').insert({
          prop_id: lineId,
          event_type: 'remove',
          recorded_at: now
        });
        propsCache.delete(lineId);
      } else if (item.appearance_id) {
        await supabase.from('ud_props').update({ status: 'removed', updated_at: now }).eq('appearance_id', item.appearance_id);
      }
      stats.removes++;
    } catch (err) {
      stats.errors++;
      log('ERROR', 'Remove handler error', { error: err.message });
    }
  }
  stats.lastEvent = now;
  log('REMOVE', `${sport} | ${items.length} lines removed`);
}

// ─── Pusher WebSocket ───
function connectPusher() {
  log('INFO', 'Connecting to Pusher WebSocket...');
  ws = new WebSocket(PUSHER_URL);

  ws.on('open', () => {
    log('INFO', 'Connected to Pusher');
    reconnectAttempts = 0;

    // Subscribe to sport-specific channels
    for (const sport of SPORTS) {
      ws.send(JSON.stringify({
        event: 'pusher:subscribe',
        data: { auth: '', channel: `over_under_lines-${sport}-balanced` }
      }));
      ws.send(JSON.stringify({
        event: 'pusher:subscribe',
        data: { auth: '', channel: `rival_lines-${sport}-balanced` }
      }));
    }

    // Start ping timer
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
      }
    }, PING_INTERVAL_MS);
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Skip internal Pusher events
      if (msg.event === 'pusher:connection_established' ||
          msg.event === 'pusher_internal:subscription_succeeded' ||
          msg.event === 'pusher:pong') {
        if (msg.event === 'pusher_internal:subscription_succeeded') {
          log('INFO', `Subscribed: ${msg.channel}`);
        }
        return;
      }

      if (msg.event === 'pusher:error') {
        log('ERROR', 'Pusher error', { data: msg.data });
        return;
      }

      // Parse data payload
      let payload;
      try {
        payload = JSON.parse(msg.data);
      } catch {
        payload = msg.data;
      }

      const channel = msg.channel || '';

      if (msg.event === 'swap') {
        await handleSwap(channel, payload);
      } else if (msg.event === 'remove_v2' || msg.event === 'remove') {
        await handleRemove(channel, payload);
      } else {
        log('INFO', `Unknown event: ${msg.event} on ${channel}`);
      }
    } catch (err) {
      stats.errors++;
      log('ERROR', 'Message handler error', { error: err.message });
    }
  });

  ws.on('error', (err) => {
    log('ERROR', 'WebSocket error', { error: err.message });
  });

  ws.on('close', (code, reason) => {
    log('WARN', `WebSocket closed: ${code} ${reason}`);
    if (pingTimer) clearInterval(pingTimer);
    reconnectAttempts++;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts - 1), 60000);
    log('INFO', `Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    setTimeout(connectPusher, delay);
  });
}

// ─── Stats endpoint (for health checks) ───
const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      wsState: ws?.readyState,
      propsInCache: propsCache.size,
      stats
    }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ─── Kalshi Hydration ───
const KALSHI_INTERVAL_MS = 120000; // Every 2 minutes (Kalshi updates less frequently)

async function hydrateKalshi() {
  if (!scrapeKalshi) {
    log('WARN', 'Kalshi module not loaded, skipping');
    return;
  }
  log('INFO', 'Starting Kalshi hydration...');
  const startTime = Date.now();

  try {
    const { props: kalshiProps, errors } = await scrapeKalshi();

    if (errors.length > 0) {
      log('WARN', `Kalshi scrape had ${errors.length} errors`, { errors: errors.slice(0, 5) });
    }

    if (kalshiProps.length === 0) {
      log('INFO', 'No active Kalshi props found');
      return;
    }

    // Upsert props
    for (let i = 0; i < kalshiProps.length; i += 500) {
      const chunk = kalshiProps.slice(i, i + 500);
      const { error } = await supabase.from('ud_props').upsert(chunk, { onConflict: 'id' });
      if (error) log('ERROR', 'Kalshi props upsert error', { error: error.message, chunk: i });
    }

    // Record history (only on first run or if values changed)
    const historyRows = kalshiProps.map(p => ({
      prop_id: p.id,
      appearance_id: null,
      stat_value: p.stat_value,
      over_price: p.over_price,
      under_price: p.under_price,
      over_decimal: p.over_decimal,
      under_decimal: p.under_decimal,
      event_type: 'hydration',
      source: 'kalshi',
      recorded_at: new Date().toISOString()
    }));

    // Only insert history entries that represent changes
    for (let i = 0; i < historyRows.length; i += 500) {
      const chunk = historyRows.slice(i, i + 500);
      const { error } = await supabase.from('ud_line_history').insert(chunk);
      if (error && !error.message.includes('duplicate')) {
        log('ERROR', 'Kalshi history insert error', { error: error.message });
      }
    }

    const duration = Date.now() - startTime;
    log('INFO', `Kalshi hydration complete`, { props: kalshiProps.length, errors: errors.length, duration: `${duration}ms` });

    await supabase.from('ud_scrape_runs').insert({
      run_type: 'kalshi_hydration',
      props_count: kalshiProps.length,
      changes_count: kalshiProps.length,
      duration_ms: duration,
      status: 'success',
      started_at: new Date().toISOString()
    });

  } catch (err) {
    const duration = Date.now() - startTime;
    log('ERROR', 'Kalshi hydration failed', { error: err.message, duration: `${duration}ms` });
    await supabase.from('ud_scrape_runs').insert({
      run_type: 'kalshi_hydration',
      status: 'error',
      error: err.message,
      started_at: new Date().toISOString()
    });
  }
}

// ─── DraftKings Hydration ───
const DK_INTERVAL_MS = 180000; // Every 3 minutes

async function hydrateDraftKings() {
  if (!dkHydrate) {
    log('WARN', 'DraftKings module not loaded, skipping');
    return;
  }
  log('INFO', 'Starting DraftKings hydration...');
  const startTime = Date.now();

  try {
    const dkProps = await dkHydrate((...args) => log('INFO', ...args));

    if (dkProps.length === 0) {
      log('INFO', 'No active DraftKings props found');
      await supabase.from('ud_scrape_runs').insert({
        run_type: 'dk_hydration', props_count: 0, changes_count: 0,
        duration_ms: Date.now() - startTime, status: 'success',
        started_at: new Date().toISOString()
      });
      return;
    }

    // Map to ud_props format
    const rows = dkProps.map(p => ({
      id: p.external_id,
      player_name: p.player_name,
      sport: p.sport,
      stat_type: p.stat_type,
      stat_value: p.line,
      over_price: p.over_price,
      under_price: p.under_price,
      over_decimal: p.over_price,
      under_decimal: p.under_price,
      game_name: p.game_name,
      game_start: p.game_start,
      source: 'draftkings',
      updated_at: new Date().toISOString()
    }));

    // Upsert in chunks
    let upserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await supabase.from('ud_props').upsert(chunk, { onConflict: 'id' });
      if (error) log('ERROR', 'DK props upsert error', { error: error.message, chunk: i });
      else upserted += chunk.length;
    }

    // Insert history
    const historyRows = rows.map(p => ({
      prop_id: p.id,
      appearance_id: null,
      stat_value: p.stat_value,
      over_price: p.over_price,
      under_price: p.under_price,
      over_decimal: p.over_decimal,
      under_decimal: p.under_decimal,
      event_type: 'hydration',
      source: 'draftkings',
      recorded_at: new Date().toISOString()
    }));

    for (let i = 0; i < historyRows.length; i += 500) {
      const chunk = historyRows.slice(i, i + 500);
      const { error } = await supabase.from('ud_line_history').insert(chunk);
      if (error && !error.message.includes('duplicate')) {
        log('ERROR', 'DK history insert error', { error: error.message });
      }
    }

    const duration = Date.now() - startTime;
    log('INFO', `DraftKings hydration complete`, { props: dkProps.length, upserted, duration: `${duration}ms` });

    await supabase.from('ud_scrape_runs').insert({
      run_type: 'dk_hydration', props_count: dkProps.length, changes_count: upserted,
      duration_ms: duration, status: 'success', started_at: new Date().toISOString()
    });
  } catch (err) {
    const duration = Date.now() - startTime;
    log('ERROR', 'DraftKings hydration failed', { error: err.message, duration: `${duration}ms` });
    await supabase.from('ud_scrape_runs').insert({
      run_type: 'dk_hydration', status: 'error', error: err.message,
      started_at: new Date().toISOString()
    });
  }
}

// ─── PrizePicks Hydration ───
const PP_INTERVAL_MS = 180000; // Every 3 minutes

async function hydratePrizePicks() {
  if (!ppHydrate) {
    log('WARN', 'PrizePicks module not loaded, skipping');
    return;
  }
  log('INFO', 'Starting PrizePicks hydration...');
  const startTime = Date.now();

  try {
    const ppProps = await ppHydrate((...args) => log('INFO', ...args));

    if (ppProps.length === 0) {
      log('INFO', 'No active PrizePicks props found');
      await supabase.from('ud_scrape_runs').insert({
        run_type: 'pp_hydration', props_count: 0, changes_count: 0,
        duration_ms: Date.now() - startTime, status: 'success',
        started_at: new Date().toISOString()
      });
      return;
    }

    // Upsert in chunks
    let upserted = 0;
    for (let i = 0; i < ppProps.length; i += 500) {
      const chunk = ppProps.slice(i, i + 500);
      const { error } = await supabase.from('ud_props').upsert(chunk, { onConflict: 'id' });
      if (error) log('ERROR', 'PP props upsert error', { error: error.message, chunk: i });
      else upserted += chunk.length;
    }

    // Insert history
    const historyRows = ppProps.map(p => ({
      prop_id: p.id,
      appearance_id: null,
      stat_value: p.stat_value,
      over_price: p.over_price,
      under_price: p.under_price,
      over_decimal: p.over_decimal,
      under_decimal: p.under_decimal,
      event_type: 'hydration',
      source: 'prizepicks',
      recorded_at: new Date().toISOString()
    }));

    for (let i = 0; i < historyRows.length; i += 500) {
      const chunk = historyRows.slice(i, i + 500);
      const { error } = await supabase.from('ud_line_history').insert(chunk);
      if (error && !error.message.includes('duplicate')) {
        log('ERROR', 'PP history insert error', { error: error.message });
      }
    }

    const duration = Date.now() - startTime;
    log('INFO', `PrizePicks hydration complete`, { props: ppProps.length, upserted, duration: `${duration}ms` });

    await supabase.from('ud_scrape_runs').insert({
      run_type: 'pp_hydration', props_count: ppProps.length, changes_count: upserted,
      duration_ms: duration, status: 'success', started_at: new Date().toISOString()
    });
  } catch (err) {
    const duration = Date.now() - startTime;
    log('ERROR', 'PrizePicks hydration failed', { error: err.message, duration: `${duration}ms` });
    await supabase.from('ud_scrape_runs').insert({
      run_type: 'pp_hydration', status: 'error', error: err.message,
      started_at: new Date().toISOString()
    });
  }
}

// ─── Main ───
async function main() {
  const port = process.env.PORT || 3001;
  server.listen(port, () => log('INFO', `Health server on port ${port}`));

  // Step 1: Hydrate from REST
  await hydrateFromREST();

  // Step 2: Connect WebSocket
  connectPusher();

  // Step 3: Periodic re-hydration as safety net
  setInterval(hydrateFromREST, HYDRATION_INTERVAL_MS);

  // Step 3b: Kalshi hydration (non-blocking — don't crash if Kalshi fails)
  try {
    await hydrateKalshi();
  } catch (err) {
    log('ERROR', 'Initial Kalshi hydration failed (non-fatal)', { error: err.message });
  }
  setInterval(async () => {
    try { await hydrateKalshi(); } catch (err) {
      log('ERROR', 'Periodic Kalshi hydration failed', { error: err.message });
    }
  }, KALSHI_INTERVAL_MS);

  // Step 4: DraftKings hydration (non-blocking)
  try {
    await hydrateDraftKings();
  } catch (err) {
    log('ERROR', 'Initial DraftKings hydration failed (non-fatal)', { error: err.message });
  }
  setInterval(async () => {
    try { await hydrateDraftKings(); } catch (err) {
      log('ERROR', 'Periodic DraftKings hydration failed', { error: err.message });
    }
  }, DK_INTERVAL_MS);

  // Step 5: PrizePicks hydration (non-blocking)
  try {
    await hydratePrizePicks();
  } catch (err) {
    log('ERROR', 'Initial PrizePicks hydration failed (non-fatal)', { error: err.message });
  }
  setInterval(async () => {
    try { await hydratePrizePicks(); } catch (err) {
      log('ERROR', 'Periodic PrizePicks hydration failed', { error: err.message });
    }
  }, PP_INTERVAL_MS);

  // Step 6: Log stats every 60s
  setInterval(() => {
    log('STATS', `swaps=${stats.swaps} removes=${stats.removes} hydrations=${stats.hydrations} errors=${stats.errors} cached=${propsCache.size} lastEvent=${stats.lastEvent || 'none'}`);
  }, 60000);
}

process.on('uncaughtException', (err) => {
  log('FATAL', 'Uncaught exception', { error: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  log('FATAL', 'Unhandled rejection', { reason: String(reason) });
});

main().catch(err => {
  log('FATAL', 'Main crashed', { error: err.message, stack: err.stack });
  process.exit(1);
});
// redeploy 1771002120
