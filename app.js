const MATCHES_FILE = "./matches.json";
const API_ENDPOINT = "/.netlify/functions/github";
const USER_STORAGE_KEY = "psl_2026_username";
const FINISH_BUTTON_DELAY_MS = 3 * 60 * 60 * 1000;
const SYNC_INTERVAL_MS = 15000;

const POINTS = {
  winner: 2,
  man_of_match: 2,
  top_batsman: 2,
  top_bowler: 2,
};

const ui = {
  statusBar: document.getElementById("statusBar"),
  usernameForm: document.getElementById("usernameForm"),
  usernameInput: document.getElementById("usernameInput"),
  userSetupCard: document.getElementById("userSetupCard"),
  appView: document.getElementById("appView"),
  matchesContainer: document.getElementById("matchesContainer"),
  matchFilters: document.getElementById("matchFilters"),
  leaderboardBody: document.getElementById("leaderboardBody"),
  loadingText: document.getElementById("loadingText"),
  switchUserButton: document.getElementById("switchUserButton"),
};

let appState = {
  matches: [],
  store: {
    users: [],
    predictions: [],
    result_overrides: {},
  },
  currentUser: localStorage.getItem(USER_STORAGE_KEY) || "",
  activeFilter: "today",
};

let inFlightRequests = 0;
let syncTimer = null;

function parseTimeText(timeText) {
  const value = String(timeText || "").trim();
  const match = value.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) {
    return { hours: 0, minutes: 0 };
  }

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3].toUpperCase();

  if (meridiem === "PM" && hours !== 12) hours += 12;
  if (meridiem === "AM" && hours === 12) hours = 0;

  return { hours, minutes };
}

function getMatchStartDate(match) {
  if (!match.date) return null;

  const [yearText, monthText, dayText] = String(match.date).split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  if (!year || !month || !day) return null;

  const { hours, minutes } = parseTimeText(match.time);
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

function canFinishMatch(match) {
  if (match.status === "finished") return false;
  const startDate = getMatchStartDate(match);
  if (!startDate || Number.isNaN(startDate.getTime())) return false;
  return Date.now() >= startDate.getTime() + FINISH_BUTTON_DELAY_MS;
}

function getFinishWindowText(match) {
  const startDate = getMatchStartDate(match);
  if (!startDate || Number.isNaN(startDate.getTime())) {
    return "Finish button needs a valid match date and time.";
  }

  const unlockDate = new Date(startDate.getTime() + FINISH_BUTTON_DELAY_MS);
  if (Date.now() >= unlockDate.getTime()) {
    return "You can finish this match now.";
  }

  return `Finish button appears after ${unlockDate.toLocaleString([], {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function normalizeStore(value) {
  if (!value || typeof value !== "object") {
    return { users: [], predictions: [], result_overrides: {} };
  }

  return {
    users: Array.isArray(value.users) ? value.users : [],
    predictions: Array.isArray(value.predictions) ? value.predictions : [],
    result_overrides:
      value.result_overrides && typeof value.result_overrides === "object"
        ? value.result_overrides
        : {},
  };
}

function getStoreFromResponse(payload) {
  if (payload && payload.data && typeof payload.data === "object") {
    return normalizeStore(payload.data);
  }
  return normalizeStore(payload);
}

async function apiGetStore() {
  const response = await fetch(`${API_ENDPOINT}?action=get`);
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || "Failed to fetch shared data");
  }
  return getStoreFromResponse(payload);
}

async function apiUpdateStore(nextStore, message = "Update shared data") {
  const response = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "update",
      data: nextStore,
      message,
    }),
  });

  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || "Failed to update shared data");
  }
  return getStoreFromResponse(payload);
}

function setStatus(message, type = "info") {
  ui.statusBar.textContent = message;
  ui.statusBar.classList.remove("hidden", "error");
  if (type === "error") {
    ui.statusBar.classList.add("error");
  } else {
    ui.statusBar.classList.remove("error");
  }
}

function clearStatus() {
  ui.statusBar.classList.add("hidden");
  ui.statusBar.textContent = "";
  ui.statusBar.classList.remove("error");
}

function setLoading(isLoading, message = "Loading...") {
  inFlightRequests = isLoading
    ? inFlightRequests + 1
    : Math.max(0, inFlightRequests - 1);

  ui.loadingText.textContent = inFlightRequests > 0 ? message : "Idle";
}

async function loadMatches() {
  const response = await fetch(MATCHES_FILE, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Could not load matches.json");
  }

  const payload = await response.json();
  const matches = Array.isArray(payload.matches) ? payload.matches : [];
  const overrides = normalizeStore(appState.store).result_overrides;

  appState.matches = matches.map((match) => {
    const id = Number(match.id);
    const override = overrides[String(id)] || {};

    return {
      id,
      team1: String(match.team1 || ""),
      team2: String(match.team2 || ""),
      date: String(match.date || ""),
      venue: String(match.venue || ""),
      time: String(match.time || ""),
      status: String(override.status || match.status || "upcoming").toLowerCase(),
      result: {
        winner: String(override.result?.winner || match.result?.winner || ""),
        man_of_match: String(
          override.result?.man_of_match || match.result?.man_of_match || ""
        ),
        top_batsman: String(
          override.result?.top_batsman || match.result?.top_batsman || ""
        ),
        top_bowler: String(override.result?.top_bowler || match.result?.top_bowler || ""),
      },
    };
  });
}

function findUser(username) {
  return appState.store.users.find(
    (user) => user.username.toLowerCase() === username.toLowerCase()
  );
}

function showSetupView() {
  ui.userSetupCard.classList.remove("hidden");
  ui.appView.classList.add("hidden");
}

function showAppView() {
  ui.userSetupCard.classList.add("hidden");
  ui.appView.classList.remove("hidden");
}

function formatMatchDate(dateText) {
  const parsed = new Date(dateText);
  if (Number.isNaN(parsed.getTime())) return dateText || "Unknown date";
  return parsed.toLocaleDateString([], {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function getDateKey(dateText) {
  const parsed = new Date(dateText);
  if (Number.isNaN(parsed.getTime())) return dateText;

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getTodayKey() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function matchesActiveFilter(match) {
  if (appState.activeFilter === "all") return true;
  if (appState.activeFilter === "today") return getDateKey(match.date) === getTodayKey();
  return match.status === appState.activeFilter;
}

function formatSectionDate(dateText) {
  const parsed = new Date(dateText);
  if (Number.isNaN(parsed.getTime())) return dateText || "Unknown date";

  const isToday = getDateKey(dateText) === getTodayKey();
  const formatted = parsed.toLocaleDateString([], {
    weekday: "long",
    day: "2-digit",
    month: "short",
  });
  return isToday ? `Today · ${formatted}` : formatted;
}

function getPredictionForUser(matchId, username) {
  return appState.store.predictions.find(
    (prediction) =>
      prediction.match_id === matchId &&
      prediction.username.toLowerCase() === username.toLowerCase()
  );
}

function isPredictionLocked(match, prediction) {
  return match.status === "finished" || Boolean(prediction);
}

function scorePrediction(prediction, result) {
  const parts = {
    winner: prediction.winner === result.winner,
    man_of_match: prediction.man_of_match === result.man_of_match,
    top_batsman: prediction.top_batsman === result.top_batsman,
    top_bowler: prediction.top_bowler === result.top_bowler,
  };

  const total =
    (parts.winner ? POINTS.winner : 0) +
    (parts.man_of_match ? POINTS.man_of_match : 0) +
    (parts.top_batsman ? POINTS.top_batsman : 0) +
    (parts.top_bowler ? POINTS.top_bowler : 0);

  return { total, parts };
}

function showCorrectPredictions(match, prediction) {
  if (match.status !== "finished" || !prediction) return "";

  const score = scorePrediction(prediction, match.result);
  return `
    <div class="chip-row">
      <span class="chip ${score.parts.winner ? "correct" : "incorrect"}">Winner</span>
      <span class="chip ${score.parts.man_of_match ? "correct" : "incorrect"}">MOM</span>
      <span class="chip ${score.parts.top_batsman ? "correct" : "incorrect"}">Batsman</span>
      <span class="chip ${score.parts.top_bowler ? "correct" : "incorrect"}">Bowler</span>
      <span class="chip ${score.total ? "correct" : "incorrect"}">${score.total} pts</span>
    </div>
  `;
}

function renderMatchCard(match) {
  const prediction = getPredictionForUser(match.id, appState.currentUser);
  const locked = isPredictionLocked(match, prediction);
  const finished = match.status === "finished";
  const lockMessage = finished
    ? "Prediction Locked"
    : prediction
      ? "Prediction already submitted"
      : "One prediction only";

  return `
    <article class="card match-card ${finished ? "finished" : ""}">
      <div>
        <h3>${match.team1} vs ${match.team2}</h3>
        <div class="match-meta">
          <span>${formatMatchDate(match.date)}</span>
          <span class="badge ${match.status}">${match.status}</span>
        </div>
      </div>

      <div class="meta-strip">
        <div class="meta-pill">Venue: ${match.venue || "TBD"}</div>
        <div class="meta-pill">Time: ${match.time || "TBD"}</div>
      </div>

      ${
        finished
          ? `<div class="score-box">Result: ${match.result.winner || "TBD"} | MOM: ${match.result.man_of_match || "TBD"}</div>`
          : `<div class="lock-box">${lockMessage}</div>`
      }

      ${
        finished
          ? ""
          : canFinishMatch(match)
            ? `
              <form class="admin-result-form prediction-grid" data-match-id="${match.id}">
                <select name="winner" required>
                  <option value="">Select winner</option>
                  <option value="${match.team1}">${match.team1}</option>
                  <option value="${match.team2}">${match.team2}</option>
                </select>
                <input name="man_of_match" placeholder="Final man of the match" required />
                <input name="top_batsman" placeholder="Final top batsman" required />
                <input name="top_bowler" placeholder="Final top bowler" required />
                <button class="btn-ghost" type="submit">Finish Match</button>
              </form>
            `
            : `<p class="prediction-note">${getFinishWindowText(match)}</p>`
      }

      <form class="prediction-form prediction-grid ${locked ? "locked" : ""}" data-match-id="${match.id}">
        <select name="winner" ${locked ? "disabled" : ""} required>
          <option value="">Pick winner</option>
          <option value="${match.team1}">${match.team1}</option>
          <option value="${match.team2}">${match.team2}</option>
        </select>
        <input name="man_of_match" placeholder="Man of the Match" ${locked ? "disabled" : ""} required />
        <input name="top_batsman" placeholder="Top batsman" ${locked ? "disabled" : ""} required />
        <input name="top_bowler" placeholder="Top bowler" ${locked ? "disabled" : ""} required />
        <button class="btn-primary" type="submit" ${locked ? "disabled" : ""}>
          ${finished ? "Prediction Locked" : prediction ? "Prediction Submitted" : "Save Prediction"}
        </button>
      </form>

      ${
        prediction
          ? `<p class="prediction-note">Your pick: ${prediction.winner}</p>`
          : ""
      }

      ${showCorrectPredictions(match, prediction)}
    </article>
  `;
}

function renderMatches() {
  if (!appState.matches.length) {
    ui.matchesContainer.innerHTML = '<div class="card empty-state">No matches available.</div>';
    return;
  }

  const sortedMatches = [...appState.matches]
    .filter(matchesActiveFilter)
    .sort((a, b) => {
    return new Date(a.date).getTime() - new Date(b.date).getTime();
  });

  if (!sortedMatches.length) {
    ui.matchesContainer.innerHTML =
      '<div class="card empty-state">No matches found for this filter.</div>';
    return;
  }

  const groups = sortedMatches.reduce((accumulator, match) => {
    const key = getDateKey(match.date);
    if (!accumulator[key]) {
      accumulator[key] = [];
    }
    accumulator[key].push(match);
    return accumulator;
  }, {});

  ui.matchesContainer.innerHTML = Object.entries(groups)
    .map(
      ([dateKey, matches]) => `
        <section class="match-day-group">
          <div class="match-day-header">
            <h3 class="match-day-title">${formatSectionDate(dateKey)}</h3>
            <span class="match-day-count">${matches.length} match${matches.length > 1 ? "es" : ""}</span>
          </div>
          <div class="match-grid">
            ${matches.map(renderMatchCard).join("")}
          </div>
        </section>
      `
    )
    .join("");
}

function updateFilterButtons() {
  if (!ui.matchFilters) return;

  const buttons = ui.matchFilters.querySelectorAll("[data-filter]");
  for (const button of buttons) {
    const isActive = button.dataset.filter === appState.activeFilter;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  }
}

function buildLeaderboard() {
  const results = appState.store.users.map((user) => ({
    username: user.username,
    points: 0,
    total_predictions: 0,
  }));

  const resultMap = new Map(results.map((item) => [item.username.toLowerCase(), item]));

  for (const prediction of appState.store.predictions) {
    const key = prediction.username.toLowerCase();
    if (!resultMap.has(key)) {
      resultMap.set(key, {
        username: prediction.username,
        points: 0,
        total_predictions: 0,
      });
    }

    const row = resultMap.get(key);
    row.total_predictions += 1;

    const match = appState.matches.find((item) => item.id === prediction.match_id);
    if (!match || match.status !== "finished") continue;

    row.points += scorePrediction(prediction, match.result).total;
  }

  return [...resultMap.values()].sort((a, b) => b.points - a.points || a.username.localeCompare(b.username));
}

function renderLeaderboard() {
  const leaderboard = buildLeaderboard();

  ui.leaderboardBody.innerHTML = leaderboard.length
    ? leaderboard
        .map(
          (entry, index) => `
            <tr>
              <td>${index + 1}</td>
              <td>${entry.username}</td>
              <td>${entry.points}</td>
              <td>${entry.total_predictions}</td>
            </tr>
          `
        )
        .join("")
    : '<tr><td colspan="4">No predictions yet</td></tr>';
}

function renderApp() {
  updateFilterButtons();
  renderMatches();
  renderLeaderboard();
}

async function syncSharedStateSilently() {
  try {
    appState.store = await apiGetStore();
    await loadMatches();
    renderApp();
  } catch (_) {
    // Silent sync failures are ignored to avoid noisy UI.
  }
}

function startSyncLoop() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(syncSharedStateSilently, SYNC_INTERVAL_MS);
}

function handleFilterClick(event) {
  const button = event.target.closest("[data-filter]");
  if (!button) return;

  appState.activeFilter = button.dataset.filter || "today";
  renderApp();
}

async function loginOrCreateUser(username) {
  const latest = normalizeStore(await apiGetStore());
  const exists = latest.users.some(
    (user) => user.username.toLowerCase() === username.toLowerCase()
  );

  if (!exists) {
    latest.users.push({
      username,
      created_at: new Date().toISOString(),
    });
    appState.store = await apiUpdateStore(latest, `Create user ${username}`);
  } else {
    appState.store = latest;
  }

  appState.currentUser = username;
  localStorage.setItem(USER_STORAGE_KEY, username);
}

async function handleUsernameSubmit(event) {
  event.preventDefault();

  const username = ui.usernameInput.value.trim().replace(/\s+/g, " ");

  if (username.length < 3) {
    setStatus("Username must be at least 3 characters.", "error");
    return;
  }

  try {
    setLoading(true, "Signing in...");
    await loginOrCreateUser(username);
    await loadMatches();
    clearStatus();
    showAppView();
    renderApp();
  } catch (error) {
    setStatus(error.message || "Could not save user", "error");
  } finally {
    setLoading(false);
  }
}

function handleSwitchUser() {
  localStorage.removeItem(USER_STORAGE_KEY);
  appState.currentUser = "";
  ui.usernameInput.value = "";
  showSetupView();
  clearStatus();
}

async function handlePredictionSubmit(event) {
  const form = event.target;
  if (!form.classList.contains("prediction-form")) return;

  event.preventDefault();

  const matchId = Number(form.dataset.matchId);
  const match = appState.matches.find((item) => item.id === matchId);
  const existingPrediction = getPredictionForUser(matchId, appState.currentUser);

  if (!match || isPredictionLocked(match, existingPrediction)) {
    setStatus("Prediction Locked", "error");
    return;
  }

  const formData = new FormData(form);
  const prediction = {
    username: appState.currentUser,
    match_id: matchId,
    winner: String(formData.get("winner") || "").trim(),
    man_of_match: String(formData.get("man_of_match") || "").trim(),
    top_batsman: String(formData.get("top_batsman") || "").trim(),
    top_bowler: String(formData.get("top_bowler") || "").trim(),
    created_at: new Date().toISOString(),
  };

  if (
    !prediction.winner ||
    !prediction.man_of_match ||
    !prediction.top_batsman ||
    !prediction.top_bowler
  ) {
    setStatus("Please fill all prediction fields.", "error");
    return;
  }

  try {
    setLoading(true, "Saving prediction...");
    const latest = normalizeStore(await apiGetStore());
    const already = latest.predictions.some(
      (item) =>
        item.match_id === matchId &&
        item.username.toLowerCase() === appState.currentUser.toLowerCase()
    );
    if (already) {
      setStatus("Prediction already submitted for this match.", "error");
      return;
    }

    latest.predictions.push(prediction);
    appState.store = await apiUpdateStore(
      latest,
      `Prediction by ${appState.currentUser} for match ${matchId}`
    );
    await loadMatches();
    setStatus("Prediction saved.");
    renderApp();
  } catch (error) {
    setStatus(error.message || "Could not save prediction", "error");
  } finally {
    setLoading(false);
  }
}

async function handleAdminResultSubmit(event) {
  const form = event.target;
  if (!form.classList.contains("admin-result-form")) return;

  event.preventDefault();

  const matchId = Number(form.dataset.matchId);
  const match = appState.matches.find((item) => item.id === matchId);

  if (!match || !canFinishMatch(match)) {
    setStatus("Finish Match becomes available 3 hours after match start.", "error");
    return;
  }

  const formData = new FormData(form);
  const result = {
    winner: String(formData.get("winner") || "").trim(),
    man_of_match: String(formData.get("man_of_match") || "").trim(),
    top_batsman: String(formData.get("top_batsman") || "").trim(),
    top_bowler: String(formData.get("top_bowler") || "").trim(),
  };

  if (!result.winner || !result.man_of_match || !result.top_batsman || !result.top_bowler) {
    setStatus("Fill all final result fields before finishing the match.", "error");
    return;
  }

  try {
    setLoading(true, "Publishing match result...");
    const latest = normalizeStore(await apiGetStore());
    latest.result_overrides[String(matchId)] = {
      status: "finished",
      result,
      updated_at: new Date().toISOString(),
      updated_by: appState.currentUser,
    };

    appState.store = await apiUpdateStore(
      latest,
      `Finish match ${matchId} by ${appState.currentUser}`
    );
    await loadMatches();
    setStatus("Match marked as finished for all players.");
    renderApp();
  } catch (error) {
    setStatus(error.message || "Could not finish match", "error");
  } finally {
    setLoading(false);
  }
}

async function bootstrap() {
  ui.usernameForm.addEventListener("submit", handleUsernameSubmit);
  ui.matchesContainer.addEventListener("submit", handlePredictionSubmit);
  ui.matchesContainer.addEventListener("submit", handleAdminResultSubmit);
  ui.switchUserButton.addEventListener("click", handleSwitchUser);
  ui.matchFilters.addEventListener("click", handleFilterClick);

  setLoading(true, "Loading shared data...");

  try {
    appState.store = await apiGetStore();
    await loadMatches();
    clearStatus();
  } catch (error) {
    setStatus(
      `${error.message || "Could not load shared data"}. Set backend env vars and deploy on Netlify.`,
      "error"
    );
  } finally {
    setLoading(false);
  }

  if (appState.currentUser) {
    const knownUser = findUser(appState.currentUser);
    if (knownUser) {
      showAppView();
      renderApp();
      startSyncLoop();
      return;
    }

    localStorage.removeItem(USER_STORAGE_KEY);
    appState.currentUser = "";
  }

  showSetupView();
  startSyncLoop();
}

bootstrap();
