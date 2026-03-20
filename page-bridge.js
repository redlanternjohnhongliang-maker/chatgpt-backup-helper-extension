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
    let response = await fetch(url, {
      credentials: "include",
      headers: await buildHeaders()
    });

    if (response.status === 401 || response.status === 403) {
      cachedAccessToken = null;
      response = await fetch(url, {
        credentials: "include",
        headers: await buildHeaders()
      });
    }

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async function buildHeaders() {
    const headers = {
      Accept: "application/json"
    };

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
