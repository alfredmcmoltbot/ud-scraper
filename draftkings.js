// DraftKings Scraper Module — adapted from winfantasy/workers
// Uses Zyte proxy to bypass DK blocking

const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

const DK_API_BASE = 'https://sportsbook.draftkings.com/sites/US-NJ-SB/api/v6';

const SPORT_GROUPS = {
  NBA: '42648',
  NFL: '88808',
  CBB: '92483',   // College basketball
  NHL: '42133',
  MLB: '84240',
};

// DK stat type IDs → normalized stat names
const STAT_ID_MAPPING = {
  1000: 'Points',
  1001: 'Rebounds',
  1002: 'Assists',
  1003: 'Steals',
  1004: 'Blocks',
  1005: 'Three Pointers Made',
  1006: 'Turnovers',
  1007: 'Pts + Reb + Ast',
  1008: 'Pts + Reb',
  1009: 'Pts + Ast',
  10010: 'Ast + Reb',
  10011: 'Pts + Reb + Ast',
  10012: 'Pts + Reb',
  10013: 'Pts + Ast',
};

// NBA player prop categories — offerCategoryId/subcategoryId/type
const NBA_PLAYER_PROPS = [
  { subcategoryId: 16477, offerCategoryId: 1215, type: 1000 }, // Points
  { subcategoryId: 12488, offerCategoryId: 1215, type: 1000 }, // Points O/U
  { subcategoryId: 16479, offerCategoryId: 1216, type: 1001 }, // Rebounds
  { subcategoryId: 12489, offerCategoryId: 1216, type: 1001 }, // Rebounds O/U
  { subcategoryId: 16478, offerCategoryId: 1217, type: 1002 }, // Assists
  { subcategoryId: 12495, offerCategoryId: 1217, type: 1002 }, // Assists O/U
  { subcategoryId: 16485, offerCategoryId: 1293, type: 1003 }, // Steals
  { subcategoryId: 13508, offerCategoryId: 1293, type: 1003 }, // Steals O/U
  { subcategoryId: 16484, offerCategoryId: 1293, type: 1004 }, // Blocks
  { subcategoryId: 13780, offerCategoryId: 1293, type: 1004 }, // Blocks O/U
  { subcategoryId: 13782, offerCategoryId: 1293, type: 1006 }, // Turnovers O/U
  { subcategoryId: 9514, offerCategoryId: 1218, type: 1005 },  // Three Pointers Made
  { subcategoryId: 12497, offerCategoryId: 1218, type: 1005 }, // Three Pointers Made O/U
  // Combos
  { subcategoryId: 16483, offerCategoryId: 583, type: 1007 },  // Pts + Reb + Ast
  { subcategoryId: 16482, offerCategoryId: 583, type: 1008 },  // Pts + Reb
  { subcategoryId: 16481, offerCategoryId: 583, type: 1009 },  // Pts + Ast
  { subcategoryId: 9974, offerCategoryId: 583, type: 10010 },  // Ast + Reb O/U
  { subcategoryId: 5001, offerCategoryId: 583, type: 10011 },  // Pts + Reb + Ast O/U
  { subcategoryId: 9976, offerCategoryId: 583, type: 10012 },  // Pts + Reb O/U
  { subcategoryId: 9973, offerCategoryId: 583, type: 10013 },  // Pts + Ast O/U
];

// NBA game lines
const NBA_GAME_LINES = { categoryId: 487, subcategoryId: 4511 };

function getProxyAgent() {
  const key = process.env.ZYTE_API_KEY;
  if (!key) throw new Error('ZYTE_API_KEY not set');
  return new HttpsProxyAgent(`http://${key}:@api.zyte.com:8011`, {
    rejectUnauthorized: false,
  });
}

async function fetchDK(url, retries = 3) {
  const agent = getProxyAgent();
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        agent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        },
        timeout: 30000,
      });
      // (cert validation handled by NODE_TLS_REJECT_UNAUTHORIZED=0)
      if (!res.ok) throw new Error(`DK API ${res.status}: ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function getOffers(offerCategoryId, subcategoryId, sportGroup) {
  const url = `${DK_API_BASE}/eventgroups/${sportGroup}/categories/${offerCategoryId}/subcategories/${subcategoryId}?format=json`;
  try {
    const data = await fetchDK(url);
    if (!data?.eventGroup?.offerCategories) return { offers: [], events: [] };
    const events = data.eventGroup.events || [];
    const category = data.eventGroup.offerCategories.find(c => c.offerCategoryId === offerCategoryId);
    const sub = category?.offerSubcategoryDescriptors?.find(s => s.subcategoryId === subcategoryId);
    return {
      offers: sub?.offerSubcategory?.offers?.flat() || [],
      events,
    };
  } catch (err) {
    console.error(`[DK] Failed offers ${offerCategoryId}/${subcategoryId}:`, err.message);
    return { offers: [], events: [] };
  }
}

// Fetch all NBA player props
async function fetchNBAPlayerProps() {
  const props = [];
  const sportGroup = SPORT_GROUPS.NBA;

  // Fetch all categories (with some concurrency control)
  const batchSize = 3;
  for (let i = 0; i < NBA_PLAYER_PROPS.length; i += batchSize) {
    const batch = NBA_PLAYER_PROPS.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (cat) => {
        const { offers, events } = await getOffers(cat.offerCategoryId, cat.subcategoryId, sportGroup);
        return { offers, events, type: cat.type };
      })
    );

    for (const { offers, events, type } of results) {
      const statName = STAT_ID_MAPPING[type];
      if (!statName) continue;

      for (const offer of offers) {
        if (!offer.label) continue;
        const event = events.find(e => e.eventId === offer.eventId);
        if (!event) continue;

        // Group outcomes by player to get over/under pairs
        for (const outcome of offer.outcomes) {
          if (!outcome.participant) continue;

          const line = outcome.line != null ? outcome.line :
            (outcome.label?.includes('+') ? parseFloat(outcome.label.replace('+', '')) - 0.5 : null);
          if (line == null) continue;

          const overUnder = outcome.label?.toLowerCase().includes('under') ? 'Under' :
            outcome.label?.toLowerCase().includes('over') ? 'Over' : 'Over';

          props.push({
            player_name: outcome.participant,
            sport: 'NBA',
            stat_type: statName,
            line: line,
            over_under: overUnder,
            odds_american: outcome.oddsAmerican,
            event_name: event.name,
            event_start: event.startDate,
            event_id: String(offer.eventId),
            offer_id: String(offer.providerOfferId),
            outcome_id: String(outcome.providerOutcomeId || outcome.id || ''),
            is_open: offer.isOpen,
            is_suspended: offer.isSuspended || false,
          });
        }
      }
    }

    // Small delay between batches to be nice to Zyte quota
    if (i + batchSize < NBA_PLAYER_PROPS.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return props;
}

// Fetch NBA game lines (spread, total, moneyline)
async function fetchNBAGameLines() {
  const lines = [];
  const sportGroup = SPORT_GROUPS.NBA;
  const { offers, events } = await getOffers(NBA_GAME_LINES.categoryId, NBA_GAME_LINES.subcategoryId, sportGroup);

  for (const offer of offers) {
    if (!offer.label) continue;
    const event = events.find(e => e.eventId === offer.eventId);
    if (!event) continue;

    for (const outcome of offer.outcomes) {
      lines.push({
        label: offer.label,
        team: outcome.label || outcome.participant,
        line: outcome.line,
        odds_american: outcome.oddsAmerican,
        event_name: event.name,
        event_start: event.startDate,
        event_id: String(offer.eventId),
      });
    }
  }

  return lines;
}

// Main hydration function — returns normalized props for ud_props table
async function hydrate(log) {
  log = log || console.log;
  const allProps = [];

  try {
    log('[DK] Fetching NBA player props...');
    const nbaProps = await fetchNBAPlayerProps();
    log(`[DK] Got ${nbaProps.length} NBA player props`);

    // Normalize to ud_props format
    for (const p of nbaProps) {
      // We want one row per player+stat (the "over" line), matching UD format
      if (p.over_under !== 'Over') continue;

      allProps.push({
        external_id: `dk-${p.event_id}-${p.offer_id}-${p.player_name}-${p.stat_type}`,
        player_name: p.player_name,
        sport: p.sport,
        stat_type: p.stat_type,
        line: p.line,
        over_price: parseOdds(p.odds_american),
        under_price: null, // Will be filled if we find the under
        game_name: p.event_name,
        game_start: p.event_start,
        source: 'draftkings',
      });
    }

    // Fill in under prices by matching
    const underProps = nbaProps.filter(p => p.over_under === 'Under');
    for (const u of underProps) {
      const key = `dk-${u.event_id}-${u.offer_id}-${u.player_name}-${u.stat_type}`;
      const match = allProps.find(p => p.external_id === key);
      if (match) {
        match.under_price = parseOdds(u.odds_american);
      }
    }

    log(`[DK] Normalized to ${allProps.length} props for DB`);
  } catch (err) {
    log(`[DK] Error: ${err.message}`);
  }

  return allProps;
}

// Convert American odds string to decimal
function parseOdds(american) {
  if (!american) return null;
  const n = parseInt(american, 10);
  if (isNaN(n)) return null;
  return n > 0 ? (n / 100) + 1 : (100 / Math.abs(n)) + 1;
}

module.exports = { hydrate, fetchNBAPlayerProps, fetchNBAGameLines };
