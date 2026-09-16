import { createServer } from "node:http";

const port = Number(process.env.PORT || 8080);
const token = process.env.TELEGRAM_BOT_TOKEN;
const telegramApi = token ? `https://api.telegram.org/bot${token}` : null;
const subscribers = new Set();
const trackCache = new Map();
let polling = true;
let lastTelegramError = null;
let knownReleaseIds = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esc = (value = "") =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const short = (value, max = 36) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...init.headers },
  });
  if (!response.ok) throw new Error(`Provider returned ${response.status}`);
  return response.json();
}

async function telegram(method, body) {
  if (!telegramApi) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`${telegramApi}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    const error = new Error(`Telegram ${method} failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data.result;
}

async function sendMessage(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

function keyboard(tracks) {
  return {
    inline_keyboard: tracks.slice(0, 8).map((track) => {
      trackCache.set(track.id, track);
      return [{
        text: `${track.previewUrl ? "▶ " : "↗ "}${short(track.title)} — ${short(track.artist, 24)}`,
        callback_data: `track:${track.id}`.slice(0, 64),
      }];
    }),
  };
}

function mapItunes(item) {
  if (!item.trackName || !item.artistName || !item.trackViewUrl) return null;
  return {
    id: `itunes:${item.trackId || `${item.artistName}-${item.trackName}`}`,
    title: item.trackName,
    artist: item.artistName,
    album: item.collectionName || "Apple Music",
    coverUrl: item.artworkUrl100?.replace("100x100", "600x600"),
    previewUrl: item.previewUrl,
    sourceUrl: item.trackViewUrl,
    provider: "Apple Music",
    rightsNote: "Официальное 30-секундное превью",
  };
}

async function searchApple(query) {
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", query);
  url.searchParams.set("media", "music");
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", "8");
  const data = await jsonFetch(url);
  return (data.results || []).map(mapItunes).filter(Boolean);
}

async function searchSpotify(query) {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return [];
  const auth = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!auth.ok) throw new Error(`Spotify auth returned ${auth.status}`);
  const authData = await auth.json();
  const url = new URL("https://api.spotify.com/v1/search");
  url.searchParams.set("q", query);
  url.searchParams.set("type", "track");
  url.searchParams.set("limit", "8");
  const data = await jsonFetch(url, {
    headers: { Authorization: `Bearer ${authData.access_token}` },
  });
  return (data.tracks?.items || []).map((item) => ({
    id: `spotify:${item.id}`,
    title: item.name,
    artist: item.artists?.[0]?.name || "Неизвестный исполнитель",
    album: item.album?.name || "Spotify",
    coverUrl: item.album?.images?.[0]?.url,
    previewUrl: item.preview_url || undefined,
    sourceUrl: item.external_urls?.spotify || `https://open.spotify.com/search/${encodeURIComponent(query)}`,
    provider: "Spotify",
    rightsNote: item.preview_url ? "Официальное превью Spotify" : "Полный трек доступен в Spotify",
  }));
}

async function searchYouTube(query) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("q", query);
  url.searchParams.set("type", "video");
  url.searchParams.set("videoCategoryId", "10");
  url.searchParams.set("maxResults", "8");
  url.searchParams.set("key", apiKey);
  const data = await jsonFetch(url);
  return (data.items || []).filter((item) => item.id?.videoId).map((item) => ({
    id: `youtube:${item.id.videoId}`,
    title: item.snippet?.title || "Видео",
    artist: item.snippet?.channelTitle || "YouTube",
    album: "YouTube Music",
    coverUrl: item.snippet?.thumbnails?.medium?.url,
    sourceUrl: `https://www.youtube.com/watch?v=${item.id.videoId}`,
    provider: "YouTube",
    rightsNote: "Слушать на YouTube",
  }));
}

async function searchTracks(query) {
  const values = await Promise.allSettled([
    searchApple(query),
    searchSpotify(query),
    searchYouTube(query),
  ]);
  const seen = new Set();
  return values
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value)
    .filter((track) => {
      const key = `${track.artist.toLowerCase()}::${track.title.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function newReleases() {
  const data = await jsonFetch("https://itunes.apple.com/us/rss/topsongs/limit=10/json");
  return (data.feed?.entry || []).map((entry, index) => {
    const title = entry["im:name"]?.label;
    const artist = entry["im:artist"]?.label;
    const links = entry.link || [];
    const sourceUrl = links.find((link) => link.attributes?.rel === "alternate")?.attributes?.href || entry.id?.label;
    const previewUrl = links.find((link) => link.attributes?.rel === "enclosure")?.attributes?.href;
    if (!title || !artist || !sourceUrl) return null;
    return {
      id: `itunes:top:${index}:${artist}:${title}`,
      title,
      artist,
      album: "Топ Apple Music",
      coverUrl: entry["im:image"]?.at(-1)?.label,
      previewUrl,
      sourceUrl,
      provider: "Apple Music",
      durationSeconds: 30,
      rightsNote: previewUrl ? "Официальное 30-секундное превью" : "Открыть релиз в Apple Music",
    };
  }).filter(Boolean);
}

async function sendResults(chatId, query) {
  const tracks = await searchTracks(query);
  if (!tracks.length) {
    await sendMessage(chatId, `По запросу <b>${esc(query)}</b> ничего не найдено.`);
    return;
  }
  const providers = [...new Set(tracks.slice(0, 8).map((track) => track.provider))].join(", ");
  await sendMessage(
    chatId,
    `<b>Результаты поиска</b>\n${esc(query)}\n\nИсточники: ${esc(providers)}.\nНажми на трек — отправлю официальное превью или открою источник.`,
    { reply_markup: keyboard(tracks) },
  );
}

async function sendReleases(chatId) {
  const tracks = await newReleases();
  await sendMessage(chatId, "<b>Новинки и текущий топ</b>", { reply_markup: keyboard(tracks) });
}

async function sendTrack(callback, track) {
  const chatId = callback.message?.chat?.id;
  if (!chatId) return;
  await telegram("answerCallbackQuery", {
    callback_query_id: callback.id,
    text: track.previewUrl ? "Отправляю превью" : "Открываю официальный источник",
  });
  const caption = `<b>${esc(track.title)}</b>\n${esc(track.artist)} · ${esc(track.album)}\n\n${esc(track.rightsNote)}`;
  if (track.previewUrl) {
    try {
      await telegram("sendAudio", {
        chat_id: chatId,
        audio: track.previewUrl,
        title: track.title,
        performer: track.artist,
        caption,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "Открыть полный трек", url: track.sourceUrl }]] },
      });
      return;
    } catch {
      // Fall through to a source link when Telegram cannot fetch the preview.
    }
  }
  await sendMessage(chatId, `${caption}\n\n<a href="${esc(track.sourceUrl)}">Открыть официальный источник</a>`);
}

async function handleUpdate(update) {
  if (update.callback_query) {
    const id = update.callback_query.data?.startsWith("track:")
      ? update.callback_query.data.slice(6)
      : "";
    const track = trackCache.get(id);
    if (track) await sendTrack(update.callback_query, track);
    return;
  }
  const message = update.message;
  if (!message?.text) return;
  const chatId = message.chat.id;
  const input = message.text.trim();
  if (input === "/start" || input === "/help" || input === "Помощь") {
    await sendMessage(chatId, "<b>Привет.</b>\nНапиши название трека или исполнителя. Я отправлю официальное превью, если оно доступно.", {
      reply_markup: {
        keyboard: [
          [{ text: "Найти песню" }, { text: "Новинки" }],
          [{ text: "Запустить поток" }, { text: "Подборки" }],
          [{ text: "Остановить поток" }, { text: "Помощь" }],
        ],
        resize_keyboard: true,
      },
    });
    return;
  }
  if (input === "Найти песню") {
    await sendMessage(chatId, "Напиши название песни или исполнителя одним сообщением.");
    return;
  }
  if (input === "/new" || input === "Новинки") {
    await sendReleases(chatId);
    return;
  }
  if (input === "/stream" || input === "Запустить поток") {
    subscribers.add(chatId);
    await sendMessage(chatId, "<b>Поток включён.</b>\nПоказываю текущие новинки и буду присылать новые релизы автоматически.");
    await sendReleases(chatId);
    return;
  }
  if (input === "/stopstream" || input === "Остановить поток") {
    subscribers.delete(chatId);
    await sendMessage(chatId, "Поток новинок выключен.");
    return;
  }
  if (input === "Подборки") {
    await sendMessage(chatId, "<b>Подборки</b>\nИспользуй поиск или включи поток новинок. Сохранённые плейлисты добавим после подключения постоянного хранилища.");
    return;
  }
  const query = input.replace(/^\/search\s*/i, "").slice(0, 120).trim();
  if (!query) {
    await sendMessage(chatId, "Напиши запрос после /search, например: /search Daft Punk");
    return;
  }
  await sendMessage(chatId, "Ищу в доступных официальных каталогах…");
  await sendResults(chatId, query);
}

async function poll() {
  if (!token) {
    lastTelegramError = "TELEGRAM_BOT_TOKEN is not configured";
    return;
  }
  let offset = 0;
  while (polling) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (error) {
          console.error("Telegram update failed:", error.message);
        }
      }
    } catch (error) {
      if (error.status === 409) {
        lastTelegramError = "Telegram token is already used by another polling process or webhook";
        polling = false;
        break;
      }
      lastTelegramError = error.message;
      await sleep(5000);
    }
  }
}

async function checkFeed() {
  try {
    const tracks = await newReleases();
    const currentIds = new Set(tracks.map((track) => track.id));
    if (knownReleaseIds.size === 0) {
      knownReleaseIds = currentIds;
      return;
    }
    const fresh = tracks.filter((track) => !knownReleaseIds.has(track.id));
    knownReleaseIds = currentIds;
    if (!fresh.length) return;
    await Promise.allSettled([...subscribers].map((chatId) =>
      sendMessage(chatId, `<b>Новая музыка в потоке</b>\nПоявилось ${fresh.length} новых релизов.`, {
        reply_markup: keyboard(fresh),
      }),
    ));
  } catch (error) {
    console.error("New releases feed failed:", error.message);
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (url.pathname === "/api/healthz") {
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (url.pathname === "/api/music/status") {
    response.end(JSON.stringify({
      bot: {
        configured: Boolean(token),
        running: polling && Boolean(token),
        lastError: lastTelegramError,
        providers: {
          spotify: Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
          youtube: Boolean(process.env.YOUTUBE_API_KEY),
          appleMusicPreview: true,
        },
      },
      policy: { fullDownloads: false },
    }));
    return;
  }
  if (url.pathname === "/api/music/search") {
    const query = (url.searchParams.get("q") || "").trim().slice(0, 120);
    if (!query) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "Параметр q обязателен." }));
      return;
    }
    try {
      response.end(JSON.stringify({ query, tracks: await searchTracks(query) }));
    } catch {
      response.statusCode = 502;
      response.end(JSON.stringify({ error: "Музыкальные каталоги временно недоступны." }));
    }
    return;
  }
  if (url.pathname === "/api/music/new") {
    try {
      response.end(JSON.stringify({ tracks: await newReleases() }));
    } catch {
      response.statusCode = 502;
      response.end(JSON.stringify({ error: "Не удалось загрузить новинки." }));
    }
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "Not found" }));
});

server.listen(port, () => {
  console.log(`Telegram music bot listening on ${port}`);
  if (!token) console.warn("TELEGRAM_BOT_TOKEN is not configured");
  void poll();
  void checkFeed();
  setInterval(() => void checkFeed(), 30 * 60 * 1000);
});

const shutdown = () => {
  polling = false;
  server.close(() => process.exit(0));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);