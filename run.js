require("dotenv").config();
const { fetch } = require("undici");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "sync-log.json");
const isCi = process.env.CI || process.env.AZURE_HTTP_USER_AGENT;

// Reset log file at start
fs.writeFileSync(
  LOG_FILE,
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      notFoundOnTmdb: [],
      radarrFailures: [],
      removedFromRadarr: [],
    },
    null,
    2,
  ),
);

const RADARR_URL = process.env.RADARR_URL;
const RADARR_API_KEY = process.env.RADARR_API_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const RADARR_ROOT = process.env.RADARR_ROOT;

// Only these watchlists are synced. Anything in Radarr that isn't on one of
// them gets removed (along with its files), unless protected (see below).
const LETTERBOXD_USERS = ["ayygux", "yanhut"];

// Safety switches
// DRY_RUN=true        -> log what would be removed, delete nothing
// MAX_DELETIONS=N     -> refuse to delete if more than N movies would go (default 25)
// RADARR_KEEP_TAG=xyz -> movies with this Radarr tag are never removed (default "keep")
const DRY_RUN = process.env.DRY_RUN === "true";
const MAX_DELETIONS = 2000
const KEEP_TAG = (process.env.RADARR_KEEP_TAG || "keep").toLowerCase();

function updateLog(section, entry) {
  let log = {
    timestamp: new Date().toISOString(),
    notFoundOnTmdb: [],
    radarrFailures: [],
    removedFromRadarr: [],
  };

  try {
    if (fs.existsSync(LOG_FILE)) {
      const data = fs.readFileSync(LOG_FILE, "utf-8");
      log = JSON.parse(data);
    }
  } catch (err) {
    console.warn("⚠️ Failed to read log file:", err.message);
  }

  if (!Array.isArray(log[section])) {
    log[section] = [];
  }

  log[section].push(entry);

  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  } catch (err) {
    console.warn("⚠️ Failed to write to log file:", err.message);
  }
}

// ---------- Title matching (second safety net before deleting) ----------

function normalizeTitle(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}

function titleKeysFromLetterboxdName(name) {
  // "Drunken Master (1978)" -> ["drunkenmaster|1978"], "Heat" -> ["heat"]
  const match = name.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (match) return [`${normalizeTitle(match[1])}|${match[2]}`];
  return [normalizeTitle(name)];
}

function radarrMovieMatchesTitleKeys(movie, keys) {
  const titles = [movie.title, movie.originalTitle].filter(Boolean);
  return titles.some((t) => {
    const n = normalizeTitle(t);
    return keys.has(`${n}|${movie.year}`) || keys.has(n);
  });
}

// ---------- Letterboxd ----------

async function fetchLetterboxdWatchlist(username) {
  console.log(`\n🎬 Fetching watchlist for ${username}...`);
  const baseUrl = `https://letterboxd.com/${username}/watchlist`;
  const films = [];

  const firstRes = await fetch(`${baseUrl}/`);
  if (!firstRes.ok) {
    throw new Error(`Letterboxd returned ${firstRes.status} for ${username}`);
  }
  const firstHtml = await firstRes.text();
  const $first = cheerio.load(firstHtml);
  const lastPage = parseInt($first("li.paginate-page").last().text()) || 1;

  for (let page = 1; page <= lastPage; page++) {
    const url = `${baseUrl}/page/${page}/`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Letterboxd returned ${res.status} for ${url}`);
    }
    const html = await res.text();
    const $ = cheerio.load(html);

    $(
      '.react-component[data-component-class="LazyPoster"][data-item-slug]',
    ).each((_, el) => {
      const name = $(el).attr("data-item-name");
      const slug = $(el).attr("data-item-slug");

      let filmId = null;
      const identifierJson = $(el).attr("data-postered-identifier");
      if (identifierJson) {
        try {
          const parsed = JSON.parse(identifierJson);
          if (parsed.uid && parsed.uid.startsWith("film:")) {
            filmId = parsed.uid.split(":")[1];
          }
        } catch {}
      }

      if (name && slug) {
        films.push({ name, letterboxdFilmId: filmId, slug });
      }
    });

    console.log(
      `📄 Page ${page}/${lastPage} — ${films.length} movies total so far`,
    );
  }

  return films;
}

// ---------- TMDB ----------

async function getTmdbIdFromLetterboxd(slug) {
  try {
    const res = await fetch(`https://letterboxd.com/film/${slug}/json/`);
    const json = await res.json();
    if (json.externalLinks) {
      const tmdbLink = json.externalLinks.find(
        (l) => l.type === "tmdb" || (l.url && l.url.includes("themoviedb")),
      );
      if (tmdbLink) {
        const match = tmdbLink.url.match(/movie\/(\d+)/);
        if (match) return parseInt(match[1]);
      }
    }
  } catch (err) {
    // fall through to title search
  }
  return null;
}

async function searchTmdbByTitle(title) {
  const cleanTitle = title.replace(/\s*\(\d{4}\)\s*$/, "").trim();
  const res = await fetch(
    `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(
      cleanTitle,
    )}`,
  );
  const json = await res.json();
  return json.results?.[0] || null;
}

async function getTmdbMovie(film) {
  const tmdbId = await getTmdbIdFromLetterboxd(film.slug);
  if (tmdbId) {
    const res = await fetch(
      `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}`,
    );
    if (res.ok) {
      return await res.json();
    }
  }
  return await searchTmdbByTitle(film.name);
}

// ---------- Radarr ----------

async function radarrGetJson(pathname) {
  const res = await fetch(`${RADARR_URL}${pathname}`, {
    headers: { "X-Api-Key": RADARR_API_KEY },
  });
  if (!res.ok) {
    throw new Error(
      `Radarr GET ${pathname} failed: ${res.status} ${await res.text()}`,
    );
  }
  return res.json();
}

async function addToRadarr(movie) {
  let year;
  if (movie.release_date) {
    const y = new Date(movie.release_date).getFullYear();
    if (!isNaN(y)) year = y;
  }
  const payload = {
    title: movie.title,
    tmdbId: movie.id,
    year: year,
    qualityProfileId: 1,
    rootFolderPath: RADARR_ROOT,
    monitored: true,
    addOptions: {
      searchForMovie: true,
    },
  };

  const res = await fetch(`${RADARR_URL}/api/v3/movie`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": RADARR_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorText = await res.text();

    let errorParsed;
    try {
      errorParsed = JSON.parse(errorText);
    } catch {
      errorParsed = null;
    }

    const isDuplicate =
      Array.isArray(errorParsed) &&
      errorParsed.some((e) => e.errorCode === "MovieExistsValidator");

    if (isDuplicate) {
      return;
    }

    console.error(`❌ Failed to add "${movie.title}": ${errorText}`);

    if (!isCi) {
      updateLog("radarrFailures", {
        title: movie.title,
        tmdbId: movie.id,
        status: res.status,
        error: errorText,
      });
    }
  } else {
    console.log(`✅ Added "${movie.title}" to Radarr`);
  }
}

// Cancels queue items in Radarr AND removes the torrent + partial data from
// qBittorrent. Deleting a movie alone leaves its download running.
async function removeQueueItems(queueItems) {
  let removed = 0;
  for (const item of queueItems) {
    const res = await fetch(
      `${RADARR_URL}/api/v3/queue/${item.id}?removeFromClient=true&blocklist=false`,
      {
        method: "DELETE",
        headers: { "X-Api-Key": RADARR_API_KEY },
      },
    );
    if (res.ok) {
      removed++;
    } else {
      console.error(
        `❌ Failed to cancel download "${item.title}": ${res.status} ${await res.text()}`,
      );
    }
  }
  return removed;
}

// Downloads still in the queue that no longer belong to any Radarr movie,
// e.g. left behind by movies deleted before this cleanup existed.
async function getOrphanedQueueItems() {
  const queue = await radarrGetJson(
    "/api/v3/queue?pageSize=5000&includeUnknownMovieItems=true",
  );
  return (queue.records || []).filter((item) => !item.movieId);
}

async function removeFromRadarr(movie) {
  // Cancel this movie's active downloads first, while Radarr can still link
  // them to the movie.
  try {
    const queueItems = await radarrGetJson(
      `/api/v3/queue/details?movieId=${movie.id}`,
    );
    if (queueItems.length > 0) {
      const n = await removeQueueItems(queueItems);
      console.log(`   ⛔ Cancelled ${n} download(s) for "${movie.title}"`);
    }
  } catch (err) {
    console.warn(
      `⚠️ Couldn't check downloads for "${movie.title}": ${err.message}`,
    );
  }

  const res = await fetch(
    `${RADARR_URL}/api/v3/movie/${movie.id}?deleteFiles=true&addImportExclusion=false`,
    {
      method: "DELETE",
      headers: { "X-Api-Key": RADARR_API_KEY },
    },
  );

  if (!res.ok) {
    console.error(
      `❌ Failed to remove "${movie.title}": ${res.status} ${await res.text()}`,
    );
    return false;
  }

  console.log(`🗑️ Removed "${movie.title} (${movie.year})" and its files`);
  if (!isCi) {
    updateLog("removedFromRadarr", {
      title: movie.title,
      year: movie.year,
      tmdbId: movie.tmdbId,
    });
  }
  return true;
}

// ---------- Main ----------

(async () => {
  // These throw if Radarr is unreachable, so we never act on partial data.
  const existing = await radarrGetJson("/api/v3/movie");
  const exclusions = await radarrGetJson("/api/v3/exclusions");
  const tags = await radarrGetJson("/api/v3/tag");

  const existingTmdbIds = new Set(existing.map((m) => m.tmdbId));
  const excludedTmdbIds = new Set(exclusions.map((e) => e.tmdbId));
  const keepTagId =
    tags.find((t) => (t.label || "").toLowerCase() === KEEP_TAG)?.id ?? null;

  const watchlistTmdbIds = new Set();
  const watchlistTitleKeys = new Set();
  let watchlistsComplete = true;

  for (const user of LETTERBOXD_USERS) {
    let films;
    try {
      films = await fetchLetterboxdWatchlist(user);
    } catch (err) {
      console.error(`❌ Couldn't fetch watchlist for ${user}: ${err.message}`);
      watchlistsComplete = false;
      continue;
    }

    if (films.length === 0) {
      console.warn(`⚠️ Watchlist for ${user} came back empty`);
      watchlistsComplete = false;
      continue;
    }

    for (const film of films) {
      titleKeysFromLetterboxdName(film.name).forEach((k) =>
        watchlistTitleKeys.add(k),
      );

      const movie = await getTmdbMovie(film);

      if (!movie) {
        console.warn(`⚠️ Not found on TMDB: ${film.name}`);
        if (!isCi) {
          updateLog("notFoundOnTmdb", film.name);
        }
        continue;
      }

      watchlistTmdbIds.add(movie.id);

      if (excludedTmdbIds.has(movie.id)) {
        console.log(`🚫 Skipping (removed on purpose): ${movie.title}`);
        continue;
      }

      if (existingTmdbIds.has(movie.id)) {
        console.log(`⏭️ Already in Radarr: ${movie.title}`);
        continue;
      }

      await addToRadarr(movie);
      existingTmdbIds.add(movie.id);
    }
  }

  // ----- Removals -----

  console.log("\n🧹 Checking for movies no longer on any watchlist...");

  if (!watchlistsComplete) {
    console.warn(
      "⚠️ At least one watchlist failed to load, so skipping removals this run.",
    );
    console.log("\n✅ Sync complete (adds only).");
    return;
  }

  const candidates = existing.filter((m) => !watchlistTmdbIds.has(m.tmdbId));

  const toRemove = [];
  for (const m of candidates) {
    if (keepTagId !== null && (m.tags || []).includes(keepTagId)) {
      console.log(`🔒 Keeping (tagged "${KEEP_TAG}"): ${m.title} (${m.year})`);
      continue;
    }
    if (radarrMovieMatchesTitleKeys(m, watchlistTitleKeys)) {
      // TMDB ID didn't match but the title/year does. Probably a bad TMDB
      // lookup, so don't delete it.
      console.warn(
        `⚠️ Keeping (title matches a watchlist entry, TMDB ID didn't): ${m.title} (${m.year})`,
      );
      continue;
    }
    toRemove.push(m);
  }

  if (DRY_RUN) {
    console.log(`\n🧪 DRY RUN: would remove ${toRemove.length} movie(s):`);
    toRemove.forEach((m) => console.log(`   - ${m.title} (${m.year})`));
    const orphans = await getOrphanedQueueItems();
    console.log(
      `🧪 DRY RUN: would also cancel ${orphans.length} orphaned download(s):`,
    );
    orphans.forEach((o) => console.log(`   - ${o.title}`));
    console.log("\n✅ Sync complete (dry run, nothing deleted).");
    return;
  }

  if (toRemove.length > MAX_DELETIONS) {
    console.error(
      `\n🛑 ${toRemove.length} movies would be removed, which is over the limit of ${MAX_DELETIONS}. Deleting nothing.`,
    );
    toRemove.forEach((m) => console.error(`   - ${m.title} (${m.year})`));
    console.error(
      "If this is expected, re-run with a higher MAX_DELETIONS for one run.",
    );
    process.exitCode = 1;
    return;
  }

  if (toRemove.length === 0) {
    console.log("No movies to remove.");
  }
  for (const m of toRemove) {
    await removeFromRadarr(m);
  }

  // Clean up downloads whose movie is already gone from Radarr.
  console.log("\n🧹 Checking for orphaned downloads...");
  const orphans = await getOrphanedQueueItems();
  if (orphans.length === 0) {
    console.log("No orphaned downloads.");
  } else {
    const n = await removeQueueItems(orphans);
    console.log(`⛔ Cancelled ${n} orphaned download(s)`);
  }

  console.log("\n✅ Sync complete!");
})().catch((err) => {
  console.error("❌ Sync failed:", err);
  process.exit(1);
});