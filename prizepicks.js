// PrizePicks Scraper Module
// Uses Zyte proxy to fetch projections from PrizePicks API

const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

const PP_API = 'https://api.prizepicks.com/projections';
const STATE_CODE = 'CA';

function getAgent() {
  const key = process.env.ZYTE_API_KEY;
  if (!key) throw new Error('ZYTE_API_KEY not set');
  return new HttpsProxyAgent(`http://${key}:@api.zyte.com:8011`, { rejectUnauthorized: false });
}

async function fetchAllProjections(log) {
  log = log || console.log;
  const agent = getAgent();

  // PrizePicks returns all projections in one page (up to 10k)
  const url = `${PP_API}?per_page=10000&state_code=${STATE_CODE}&single_stat=true&game_mode=pickem`;
  
  const res = await fetch(url, {
    agent,
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    timeout: 60000,
  });

  if (!res.ok) throw new Error(`PrizePicks API ${res.status}: ${res.statusText}`);
  const data = await res.json();

  const projections = data.data || [];
  const included = data.included || [];

  // Build lookup maps from included resources
  const players = new Map();
  const games = new Map();
  const leagues = new Map();
  const statTypes = new Map();

  for (const item of included) {
    switch (item.type) {
      case 'new_player':
        players.set(item.id, item.attributes);
        break;
      case 'game':
        games.set(item.id, item.attributes);
        break;
      case 'league':
        leagues.set(item.id, item.attributes);
        break;
      case 'stat_type':
        statTypes.set(item.id, item.attributes);
        break;
    }
  }

  log(`[PP] Fetched ${projections.length} projections, ${players.size} players, ${games.size} games`);

  return { projections, players, games, leagues, statTypes };
}

// Normalize sport names to match our DB convention
function normalizeSport(leagueName) {
  const map = {
    'NBA': 'NBA', 'CBB': 'CBB', 'NHL': 'NHL', 'NFL': 'NFL', 'MLB': 'MLB',
    'PGA': 'PGA', 'MMA': 'MMA', 'SOCCER': 'SOCCER', 'TENNIS': 'TENNIS',
    'WCBB': 'WCBB', 'UNR': 'UNRIVALED', 'NFLSZN': 'NFL', 'MLBSZN': 'MLB',
    'CBB1H': 'CBB', 'OLYMPICS': 'OLYMPICS',
  };
  return map[leagueName] || leagueName;
}

// Main hydration function — returns normalized props for ud_props table
async function hydrate(log) {
  log = log || console.log;

  const { projections, players, games, leagues, statTypes } = await fetchAllProjections(log);

  const props = [];

  for (const proj of projections) {
    const attrs = proj.attributes;
    const playerId = proj.relationships?.new_player?.data?.id;
    const gameId = proj.relationships?.game?.data?.id;
    const leagueId = proj.relationships?.league?.data?.id;

    const player = players.get(playerId) || {};
    const game = games.get(gameId) || {};
    const league = leagues.get(leagueId) || {};

    const sport = normalizeSport(league.name || '');
    const playerName = player.display_name || player.name || 'Unknown';
    const statType = attrs.stat_type || attrs.stat_display_name || 'Unknown';
    const line = attrs.line_score;

    if (line == null) continue;

    const oddsType = attrs.odds_type || 'standard'; // standard, goblin, or demon

    // Build game name from game description or player's team info
    const gameName = attrs.description || game.name || `${player.team || ''} Game`;
    const gameStart = attrs.start_time || game.start_time;

    props.push({
      id: `pp-${proj.id}`,
      player_name: playerName,
      sport_id: sport,
      stat_type: statType,
      stat_value: line,
      over_price: null,  // PrizePicks doesn't expose traditional odds
      under_price: null,
      over_decimal: null,
      under_decimal: null,
      game_display: gameName,
      source: 'prizepicks',
      odds_type: oddsType,
      updated_at: new Date().toISOString(),
    });
  }

  const std = props.filter(p => p.odds_type === 'standard').length;
  log(`[PP] Normalized ${props.length} props (${std} standard, ${props.length - std} goblin/demon)`);
  return props;
}

module.exports = { hydrate, fetchAllProjections };
