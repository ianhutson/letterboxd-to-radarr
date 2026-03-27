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
    },
    null,
    2
  )
);

const RADARR_URL = process.env.RADARR_URL;
const RADARR_API_KEY = process.env.RADARR_API_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const RADARR_ROOT = process.env.RADARR_ROOT;
const letterboxdUsers = process.env.LETTERBOXD_USERS.split(",");

function updateLog(section, entry) {
  let log = {
    timestamp: new Date().toISOString(),
    notFoundOnTmdb: [],
    radarrFailures: [],
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

async function fetchLetterboxdWatchlist(username) {
  console.log(`\n🎬 Fetching watchlist for ${username}...`);
  const baseUrl = `https://letterboxd.com/${username}/watchlist`;
  // Each item now stores { name, letterboxdFilmId, slug }
  const films = [];

  const firstRes = await fetch(`${baseUrl}/`);
  const firstHtml = await firstRes.text();
  const $first = cheerio.load(firstHtml);
  const lastPage = parseInt($first("li.paginate-page").last().text()) || 1;

  for (let page = 1; page <= lastPage; page++) {
    const url = `${baseUrl}/page/${page}/`;
    const res = await fetch(url);
    const html = await res.text();
    const $ = cheerio.load(html);

    $(".react-component[data-film-id]").each((_, el) => {
      const filmId = $(el).attr("data-film-id");
      const name = $(el).attr("data-item-name");
      const slug = $(el).attr("data-item-slug");
      if (filmId && name) {
        films.push({ name, letterboxdFilmId: filmId, slug });
      }
    });

    console.log(
      `📄 Page ${page}/${lastPage} — ${films.length} movies total so far`
    );
  }

  return films;
}

async function getTmdbIdFromLetterboxd(slug) {
  // Letterboxd film pages embed TMDB ID in their JSON endpoint
  try {
    const res = await fetch(`https://letterboxd.com/film/${slug}/json/`);
    const json = await res.json();
    // Look for tmdb link
    if (json.externalLinks) {
      const tmdbLink = json.externalLinks.find(
        (l) => l.type === "tmdb" || (l.url && l.url.includes("themoviedb"))
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
  // Strip year from title like "Drunken Master (1978)" -> "Drunken Master"
  const cleanTitle = title.replace(/\s*\(\d{4}\)\s*$/, "").trim();
  const res = await fetch(
    `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(
      cleanTitle
    )}`
  );
  const json = await res.json();
  return json.results?.[0] || null;
}

async function getTmdbMovie(film) {
  // First try to get TMDB ID from Letterboxd's JSON endpoint
  const tmdbId = await getTmdbIdFromLetterboxd(film.slug);
  if (tmdbId) {
    const res = await fetch(
      `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}`
    );
    if (res.ok) {
      const movie = await res.json();
      return movie;
    }
  }
  // Fall back to title search
  return await searchTmdbByTitle(film.name);
}

async function getRadarrMovies() {
  const res = await fetch(`${RADARR_URL}/api/v3/movie`, {
    headers: { "X-Api-Key": RADARR_API_KEY },
  });

  try {
    return await res.json();
  } catch (err) {
    console.error("❌ Failed to parse Radarr movies JSON:", err.message);
    return [];
  }
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

(async () => {
  const existing = await getRadarrMovies();
  const existingTmdbIds = new Set(existing.map((m) => m.tmdbId));

  for (const user of letterboxdUsers) {
    const films = await fetchLetterboxdWatchlist(user.trim());
    for (const film of films) {
      const movie = await getTmdbMovie(film);

      if (!movie) {
        console.warn(`⚠️ Not found on TMDB: ${film.name}`);
        if (!isCi) {
          updateLog("notFoundOnTmdb", film.name);
        }
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

  console.log("\n✅ Sync complete!");
})();