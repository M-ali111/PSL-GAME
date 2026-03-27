const DEFAULT_DATA = {
  users: [],
  predictions: [],
  result_overrides: {},
};

const responseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

function makeResponse(statusCode, body) {
  return {
    statusCode,
    headers: responseHeaders,
    body: JSON.stringify(body),
  };
}

function getConfig() {
  return {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    branch: process.env.GITHUB_BRANCH || "main",
    dataPath: process.env.GITHUB_DATA_PATH || "shared-data.json",
  };
}

function getContentsUrl(config) {
  return `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.dataPath}`;
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch (_) {
    return {};
  }
}

function normalizeData(data) {
  if (!data || typeof data !== "object") {
    return { ...DEFAULT_DATA };
  }

  return {
    users: Array.isArray(data.users) ? data.users : [],
    predictions: Array.isArray(data.predictions) ? data.predictions : [],
    result_overrides:
      data.result_overrides && typeof data.result_overrides === "object"
        ? data.result_overrides
        : {},
  };
}

async function githubFetch(url, config, options = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${config.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(options.headers || {}),
  };

  return fetch(url, {
    ...options,
    headers,
  });
}

async function getGithubFile(config) {
  const url = `${getContentsUrl(config)}?ref=${encodeURIComponent(config.branch)}`;
  const res = await githubFetch(url, config);

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    const failure = await res.json().catch(() => ({}));
    throw new Error(failure.message || "GitHub GET failed");
  }

  const payload = await res.json();
  const decoded = Buffer.from(payload.content || "", "base64").toString("utf8");

  let parsed = DEFAULT_DATA;
  try {
    parsed = normalizeData(JSON.parse(decoded));
  } catch (_) {
    parsed = { ...DEFAULT_DATA };
  }

  return {
    sha: payload.sha,
    data: parsed,
  };
}

async function putGithubFile(config, data, sha, message) {
  const url = getContentsUrl(config);
  const encoded = Buffer.from(JSON.stringify(normalizeData(data), null, 2)).toString(
    "base64"
  );

  const body = {
    message,
    content: encoded,
    branch: config.branch,
  };

  if (sha) {
    body.sha = sha;
  }

  const res = await githubFetch(url, config, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const failure = await res.json().catch(() => ({}));
    throw new Error(failure.message || "GitHub PUT failed");
  }

  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: responseHeaders,
      body: "",
    };
  }

  const config = getConfig();
  if (!config.token || !config.owner || !config.repo) {
    return makeResponse(500, {
      ok: false,
      error:
        "Missing backend env vars. Set GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO.",
    });
  }

  const body = parseBody(event);
  const action = body.action || event.queryStringParameters?.action || "get";

  try {
    if (event.httpMethod === "GET" || action === "get") {
      const file = await getGithubFile(config);
      if (!file) {
        await putGithubFile(config, DEFAULT_DATA, null, "Initialize shared-data.json");
        return makeResponse(200, { ok: true, data: DEFAULT_DATA });
      }

      return makeResponse(200, { ok: true, data: file.data });
    }

    if (event.httpMethod === "POST" || action === "update") {
      const nextData = normalizeData(body.data);
      const existing = await getGithubFile(config);
      await putGithubFile(
        config,
        nextData,
        existing?.sha,
        body.message || "Update PSL shared data"
      );

      return makeResponse(200, { ok: true, data: nextData });
    }

    return makeResponse(405, {
      ok: false,
      error: "Method not allowed",
    });
  } catch (error) {
    return makeResponse(500, {
      ok: false,
      error: error.message || "Unexpected server error",
    });
  }
};
