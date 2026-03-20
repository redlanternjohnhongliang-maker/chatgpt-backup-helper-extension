"use strict";

(function () {
  const REQUEST_TYPE = "CHATGPT_BACKUP_BRIDGE_REQUEST";
  const RESPONSE_TYPE = "CHATGPT_BACKUP_BRIDGE_RESPONSE";
  let cachedAccessToken = null;

  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data || event.data.type !== REQUEST_TYPE) {
      return;
    }

    const { requestId, action, payload } = event.data;

    try {
      const result = await handleAction(action, payload || {});
      window.postMessage({ type: RESPONSE_TYPE, requestId, ok: true, result }, "*");
    } catch (error) {
      window.postMessage(
        {
          type: RESPONSE_TYPE,
          requestId,
          ok: false,
          error: error?.message || String(error)
        },
        "*"
      );
    }
  });

  async function handleAction(action, payload) {
    switch (action) {
      case "fetch-conversation-list":
        return fetchConversationList(payload);
      case "fetch-conversation-detail":
        return fetchConversationDetail(payload);
      case "resolve-file-download-urls":
        return resolveFileDownloadUrls(payload);
      default:
        throw new Error(`Unsupported action: ${action}`);
    }
  }

  async function fetchConversationList(payload) {
    const offset = Number(payload.offset || 0);
    const limit = Number(payload.limit || 100);
    const candidates = [
      `${location.origin}/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`,
      `${location.origin}/backend-api/conversations?offset=${offset}&limit=${limit}`
    ];

    return fetchJsonFromCandidates(candidates);
  }

  async function fetchConversationDetail(payload) {
    if (!payload.conversationId) {
      throw new Error("conversationId is required.");
    }

    const conversationId = encodeURIComponent(payload.conversationId);
    const candidates = [
      `${location.origin}/backend-api/conversation/${conversationId}`,
      `${location.origin}/backend-api/conversation/${conversationId}?history_and_training_disabled=false`
    ];

    return fetchJsonFromCandidates(candidates);
  }

  async function fetchJsonFromCandidates(urls) {
    let lastError = null;

    for (const url of urls) {
      try {
        return await fetchJson(url);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("All API candidates failed.");
  }

  async function fetchJson(url) {
    const response = await fetchWithAuth(url, {
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async function resolveFileDownloadUrls(payload) {
    const fileIds = Array.from(
      new Set(
        (payload?.fileIds || [])
          .map((fileId) => String(fileId || "").trim())
          .filter(Boolean)
      )
    ).slice(0, 64);

    const results = {};
    for (const fileId of fileIds) {
      results[fileId] = await resolveSingleFileDownloadUrl(fileId);
    }

    return results;
  }

  async function resolveSingleFileDownloadUrl(fileId) {
    const encoded = encodeURIComponent(fileId);
    const metadataUrl = `${location.origin}/backend-api/files/${encoded}`;
    const fallbackCandidates = [
      `${location.origin}/backend-api/files/${encoded}/download`,
      `${location.origin}/backend-api/files/${encoded}?download=true`
    ];

    try {
      const metadata = await fetchJson(metadataUrl);
      const extractedUrls = extractDownloadLikeStrings(metadata);
      const candidates = uniqueStrings([...extractedUrls, ...fallbackCandidates]);
      if (candidates.length) {
        return {
          fileId,
          url: candidates[0],
          candidates,
          source: "metadata"
        };
      }
    } catch (_error) {
      // Fall through to direct endpoint probing.
    }

    try {
      const response = await fetchWithAuth(fallbackCandidates[0], {
        method: "HEAD",
        headers: {
          Accept: "*/*"
        }
      });

      if (response.ok) {
        return {
          fileId,
          url: fallbackCandidates[0],
          candidates: fallbackCandidates,
          source: "head-probe"
        };
      }
    } catch (_error) {
      // Keep best-effort fallback candidates below.
    }

    return {
      fileId,
      url: "",
      candidates: fallbackCandidates,
      source: "fallback"
    };
  }

  function extractDownloadLikeStrings(value, results = [], seen = new Set(), depth = 0) {
    if (value == null || depth > 8) {
      return results;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (/^https?:\/\//i.test(trimmed) || /^blob:/i.test(trimmed) || /^data:/i.test(trimmed)) {
        if (!seen.has(trimmed)) {
          seen.add(trimmed);
          results.push(trimmed);
        }
      }
      return results;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => extractDownloadLikeStrings(item, results, seen, depth + 1));
      return results;
    }

    if (typeof value !== "object") {
      return results;
    }

    Object.values(value).forEach((child) => {
      extractDownloadLikeStrings(child, results, seen, depth + 1);
    });

    return results;
  }

  function uniqueStrings(values) {
    return Array.from(
      new Set(
        (values || [])
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      )
    );
  }

  async function fetchWithAuth(url, init = {}) {
    let response = await fetch(url, {
      credentials: "include",
      ...init,
      headers: await buildHeaders(init.headers || {})
    });

    if (response.status === 401 || response.status === 403) {
      cachedAccessToken = null;
      response = await fetch(url, {
        credentials: "include",
        ...init,
        headers: await buildHeaders(init.headers || {})
      });
    }

    return response;
  }

  async function buildHeaders(extraHeaders = {}) {
    const headers = { ...extraHeaders };

    if (!Object.keys(headers).some((key) => key.toLowerCase() === "accept")) {
      headers.Accept = "application/json";
    }

    const token = await getAccessToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    return headers;
  }

  async function getAccessToken() {
    if (cachedAccessToken) {
      return cachedAccessToken;
    }

    const sessionUrl = `${location.origin}/api/auth/session`;
    const response = await fetch(sessionUrl, {
      credentials: "include",
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      return null;
    }

    const session = await response.json();
    cachedAccessToken = session?.accessToken || null;
    return cachedAccessToken;
  }
})();
