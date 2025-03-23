// run.js

require("dotenv").config();
const fetch = require("node-fetch");
const cheerio = require("cheerio");

const RADARR_URL = process.env.RADARR_URL;
const RADARR_API_KEY = process.env.RADARR_API_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const letterboxdUsers = process.env.LETTERBOXD_USERS.split(",");

async function fetchLetterboxdWatchlist(username) {
  const url = `https://letterboxd.com/${username}/watchlist/`;
  const res = await fetch(url);
  const html = await res.text();
  const $ = cheerio.load(html);
  const slugs = [];

  $(".poster-list .film-poster").each((i, el) => {
    const slug = $(el).attr("data-film-slug");
    if (slug) slugs.push(slug.replace(/-/g, " "));
  });

  return slugs;
}

async function searchTmdb(title) {
  const res = await fetch(
    `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`
  );
  const json = await res.json();
  return json.results?.[0] || null;
}

async function getExistingRadarrMovies() {
  const res = await fetch(`${RADARR_URL}/api/v3/movie`, {
    headers: {
      "X-Api-Key": RADARR_API_KEY,
    },
  });

  const data = await res.json();
  return data.map((movie) => movie.tmdbId);
}

async function addToRadarr(movie) {
  const res = await fetch(`${RADARR_URL}/api/v3/movie`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": RADARR_API_KEY,
    },
    body: JSON.stringify({
      title: movie.title,
      tmdbId: movie.id,
      qualityProfileId: 1, // Adjust based on your Radarr setup
      rootFolderPath: "/movies", // Adjust based on your system
      monitored: true,
      addOptions: { searchForMovie: true },
    }),
  });

  if (!res.ok) {
    console.error(`Failed to add ${movie.title}: ${res.statusText}`);
  } else {
    console.log(`✅ Added: ${movie.title}`);
  }
}

(async () => {
  const existingTmdbIds = await getExistingRadarrMovies();

  for (const user of letterboxdUsers) {
    console.log(`Fetching watchlist for ${user}...`);
    const titles = await fetchLetterboxdWatchlist(user);
    for (const title of titles) {
      const movie = await searchTmdb(title);
      if (movie) {
        if (!existingTmdbIds.includes(movie.id)) {
          await addToRadarr(movie);
        } else {
          console.log(`🔁 Already in Radarr: ${movie.title}`);
        }
      } else {
        console.warn(`❌ Not found on TMDB: ${title}`);
      }
    }
  }
})();
