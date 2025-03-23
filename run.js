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
  const slugs = [];

  const firstRes = await fetch(`${baseUrl}/`);
  const firstHtml = await firstRes.text();
  const $first = cheerio.load(firstHtml);

  const lastPage = parseInt($first("li.paginate-page").last().text()) || 1;

  for (let page = 1; page <= lastPage; page++) {
    const url = `${baseUrl}/page/${page}/`;
    const res = await fetch(url);
    const html = await res.text();
    const $ = cheerio.load(html);

    $(".poster-list .film-poster").each((_, el) => {
      const slug = $(el).attr("data-film-slug");
      if (slug) slugs.push(slug.replace(/-/g, " "));
    });

    console.log(
      `📄 Page ${page}/${lastPage} — ${slugs.length} movies total so far`
    );
  }

  return slugs;
}

function cleanTitle(rawTitle) {
  return rawTitle
    .replace(/\b(19|20)\d{2}\b/g, "") // remove 4-digit years
    .replace(/\b\d{1,2}\b/g, "") // remove single or double-digit numbers
    .replace(/\s+/g, " ") // collapse multiple spaces
    .trim(); // remove leading/trailing space
}

async function searchTmdb(title) {
  const res = await fetch(
    `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(
      title
    )}`
  );
  const json = await res.json();
  return json.results?.[0] || null;
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
      // Don’t log already-added movies
      return;
    }
    if (!isCi) {
      updateLog("radarrFailures", {
        title: movie.title,
        tmdbId: movie.id,
        status: res.status,
        error: errorText,
      });
    }
  }
}

(async () => {
  const existing = await getRadarrMovies();

  for (const user of letterboxdUsers) {
    const titles = await fetchLetterboxdWatchlist(user);
    for (const title of titles) {
      if (existing.some((m) => m.title.toLowerCase() === title.toLowerCase())) {
        continue;
      }

      const cleanedTitle = cleanTitle(title);
      const movie = await searchTmdb(cleanedTitle);

      if (movie) {
        await addToRadarr(movie);
      } else if (!isCi) {
        {
          updateLog(
            "notFoundOnTmdb",
            `${title} (cleaned as "${cleanedTitle}")`
          );
        }
      }
    }
  }
})();
