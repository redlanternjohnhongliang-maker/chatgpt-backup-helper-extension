"use strict";

const BRIDGE_REQUEST_TYPE = "CHATGPT_BACKUP_BRIDGE_REQUEST";
const BRIDGE_RESPONSE_TYPE = "CHATGPT_BACKUP_BRIDGE_RESPONSE";
const TOAST_ID = "chatgpt-backup-extension-toast";
const PANEL_ID = "chatgpt-backup-extension-panel";
const pendingBridgeRequests = new Map();
let bridgeInjected = false;
let actionInFlight = false;

init();

function init() {
  injectBridge();
  injectUiShell();
  ensureFloatingPanel();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "chatgpt-backup-action") {
      return false;
    }

    handleAction(message.action)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

    return true;
  });

  window.addEventListener("message", handleBridgeResponse);
  window.addEventListener("load", ensureFloatingPanel);

  const observer = new MutationObserver(() => {
    ensureFloatingPanel();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

async function handleAction(action) {
  if (actionInFlight) {
    throw new Error("Another export is already running. Please wait.");
  }

  actionInFlight = true;
  refreshFloatingPanelState();

  try {
    switch (action) {
      case "export-current":
        return await exportCurrentChat();
      case "export-all":
        return await exportAllChats();
      default:
        throw new Error(`Unsupported action: ${action}`);
    }
  } finally {
    actionInFlight = false;
    refreshFloatingPanelState();
  }
}

async function exportCurrentChat() {
  showToast("Preparing current chat export...");

  const conversationId = getConversationId();
  if (!conversationId && isProjectPage()) {
    throw new Error("Project page detected. Open a specific chat thread for current chat export.");
  }

  let payload = null;

  if (conversationId) {
    try {
      const detail = await bridgeRequest("fetch-conversation-detail", { conversationId });
      payload = normalizeConversationDetail(detail, {
        fallbackId: conversationId,
        fallbackUrl: location.href,
        fallbackTitle: getConversationTitle()
      });
    } catch (_error) {
      payload = null;
    }
  }

  if (!payload) {
    payload = buildDomConversationPayload();
  }

  payload = mergeDomRenderDataIntoPayload(payload);

  if (!payload.messages.length) {
    throw new Error("No messages found. Open a conversation first.");
  }

  const packageSummary = await exportCurrentChatPackage(payload);
  if (packageSummary.totalCount > 0) {
    showToast(
      `Current chat packaged with ${packageSummary.downloadedCount}/${packageSummary.totalCount} local attachment file(s).`
    );
  } else {
    showToast(`Current chat exported: ${payload.title}`);
  }

  return {
    title: payload.title,
    conversationId: payload.conversationId,
    messageCount: payload.messages.length,
    attachmentCount: packageSummary.totalCount,
    downloadableAttachmentCount: packageSummary.downloadableCount,
    downloadedAttachmentCount: packageSummary.downloadedCount,
    packageFileName: packageSummary.zipFileName
  };
}

async function exportAllChats() {
  showToast("Loading conversation list...");

  const summaries = await fetchAllConversationSummaries();
  if (!summaries.length) {
    throw new Error("No conversations returned by the API.");
  }

  const exported = [];
  const failed = [];
  let completed = 0;
  const concurrency = 4;

  await runWithConcurrency(summaries, concurrency, async (summary) => {
    try {
      const detail = await bridgeRequest("fetch-conversation-detail", {
        conversationId: summary.id
      });

      exported.push(
        normalizeConversationDetail(detail, {
          fallbackId: summary.id,
          fallbackUrl: buildConversationUrl(summary.id),
          fallbackTitle: summary.title
        })
      );
    } catch (error) {
      failed.push({
        id: summary.id,
        title: summary.title || "",
        error: error.message || String(error)
      });
    } finally {
      completed += 1;
      showToast(`Exporting ${completed}/${summaries.length} chats...`);
    }
  });

  const timestamp = new Date().toISOString();
  const archive = {
    exportedAt: timestamp,
    workspaceUrl: location.origin,
    totalConversationsFound: summaries.length,
    exportedCount: exported.length,
    failedCount: failed.length,
    failed,
    conversations: exported
  };
  const attachmentArchive = buildBulkAttachmentArchive(exported, timestamp);

  const stamp = timestamp.replace(/[:.]/g, "-");
  downloadText(
    `chatgpt-all-conversations-${stamp}.json`,
    JSON.stringify(archive, null, 2),
    "application/json;charset=utf-8"
  );

  downloadText(
    `chatgpt-all-conversations-index-${stamp}.md`,
    buildArchiveIndexMarkdown(archive),
    "text/markdown;charset=utf-8"
  );

  if (attachmentArchive.totalAttachments > 0) {
    downloadText(
      `chatgpt-all-conversations-attachments-${stamp}.json`,
      JSON.stringify(attachmentArchive, null, 2),
      "application/json;charset=utf-8"
    );
  }

  showToast(
    attachmentArchive.totalAttachments > 0
      ? `Bulk export finished. Exported ${exported.length} chats and indexed ${attachmentArchive.totalAttachments} attachment reference(s).`
      : `Bulk export finished. Exported ${exported.length} chats.`
  );

  return {
    exportedCount: exported.length,
    failedCount: failed.length,
    attachmentCount: attachmentArchive.totalAttachments
  };
}

async function runWithConcurrency(items, concurrency, worker) {
  let index = 0;

  async function runWorker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runWorker()
  );

  await Promise.all(workers);
}

async function fetchAllConversationSummaries() {
  const limit = 100;
  const conversations = [];
  const seenIds = new Set();

  for (let offset = 0; offset < 10000; offset += limit) {
    const rawPage = await bridgeRequest("fetch-conversation-list", { offset, limit });
    const pageItems = normalizeConversationSummaries(rawPage);

    if (!pageItems.length) {
      break;
    }

    for (const item of pageItems) {
      if (!item.id || seenIds.has(item.id)) {
        continue;
      }

      seenIds.add(item.id);
      conversations.push(item);
    }

    if (pageItems.length < limit) {
      break;
    }
  }

  return conversations;
}

function normalizeConversationSummaries(raw) {
  const items = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.items)
      ? raw.items
      : Array.isArray(raw?.conversations)
        ? raw.conversations
        : Array.isArray(raw?.data)
          ? raw.data
          : [];

  return items
    .map((item) => ({
      id: item?.id || item?.conversation_id || item?.conversationId || "",
      title: normalizeWhitespace(item?.title || item?.name || ""),
      updateTime: item?.update_time || item?.updateTime || item?.updated_at || null,
      createTime: item?.create_time || item?.createTime || item?.created_at || null
    }))
    .filter((item) => item.id);
}

function normalizeConversationDetail(raw, options = {}) {
  const conversationId = raw?.conversation_id || raw?.id || options.fallbackId || "unknown";
  const title = normalizeWhitespace(raw?.title || options.fallbackTitle || `conversation-${conversationId}`);
  const currentNodeId = raw?.current_node || raw?.currentNode || null;
  const mapping = raw?.mapping || {};
  let orderedNodes = [];

  if (currentNodeId && mapping[currentNodeId]) {
    orderedNodes = buildCurrentPathNodes(mapping, currentNodeId);
  } else {
    orderedNodes = Object.values(mapping)
      .filter((node) => node?.message)
      .sort((a, b) => {
        const left = Number(a?.message?.create_time || a?.message?.createTime || 0);
        const right = Number(b?.message?.create_time || b?.message?.createTime || 0);
        return left - right;
      });
  }

  const rawMessages = orderedNodes
    .map((node, index) => normalizeMessageNode(node, index))
    .filter((message) => message && message.text);

  const messages = rawMessages
    .map((message) => toVisibleExportMessage(message))
    .filter(Boolean)
    .map((message, index) => ({
      ...message,
      index: index + 1
    }));

  return {
    source: "chatgpt-internal-api",
    exportedAt: new Date().toISOString(),
    title,
    url: options.fallbackUrl || buildConversationUrl(conversationId),
    conversationId,
    currentNodeId,
    rawMessageCount: rawMessages.length,
    messageCount: messages.length,
    messages,
    rawMeta: {
      createTime: raw?.create_time || raw?.createTime || null,
      updateTime: raw?.update_time || raw?.updateTime || null
    }
  };
}

function buildCurrentPathNodes(mapping, currentNodeId) {
  const chain = [];
  const seen = new Set();
  let pointer = currentNodeId;

  while (pointer && mapping[pointer] && !seen.has(pointer)) {
    const node = mapping[pointer];
    seen.add(pointer);
    if (node?.message) {
      chain.push(node);
    }
    pointer = node?.parent || null;
  }

  return chain.reverse();
}

function normalizeMessageNode(node, index) {
  const message = node?.message;
  if (!message) {
    return null;
  }

  const role = normalizeRole(message?.author?.role || message?.author?.name || "unknown");
  const text = extractTextFromContent(message?.content);
  const attachments = extractAttachmentsFromMessage(message);

  return {
    index: index + 1,
    id: message?.id || node?.id || "",
    role,
    createTime: message?.create_time || message?.createTime || null,
    text,
    attachments
  };
}

function toVisibleExportMessage(message) {
  const cleanedText = cleanExportMessageText(message.role, message.text);
  if (!cleanedText) {
    return null;
  }

  if (!isVisibleExportMessage(message.role, cleanedText)) {
    return null;
  }

  return {
    ...message,
    text: cleanedText,
    attachments: normalizeAttachmentList(message.attachments || [])
  };
}

function cleanExportMessageText(role, text) {
  let cleaned = normalizeWhitespace(text);

  if (role === "user") {
    cleaned = summarizeUserAttachments(cleaned);
  }

  return normalizeWhitespace(cleaned);
}

function summarizeUserAttachments(text) {
  const lines = normalizeLineEndings(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.some((line) => line === "image_asset_pointer" || line.startsWith("sediment://file_"))) {
    return text;
  }

  let attachmentCount = 0;
  const keptLines = [];

  for (const line of lines) {
    if (line === "image_asset_pointer") {
      continue;
    }

    if (line.startsWith("sediment://file_")) {
      attachmentCount += 1;
      continue;
    }

    keptLines.push(line);
  }

  if (attachmentCount > 0) {
    keptLines.unshift(`[${attachmentCount} attachment(s)]`);
  }

  return keptLines.join("\n");
}

function isVisibleExportMessage(role, text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return false;
  }

  if (normalized === "model_editable_context") {
    return false;
  }

  if (/^thoughts(?:\n|$)/i.test(normalized)) {
    return false;
  }

  if (/^Thought for /i.test(normalized)) {
    return false;
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized)) {
    return false;
  }

  if (isToolPayload(normalized)) {
    return false;
  }

  return role === "user" || role === "assistant";
}

function isToolPayload(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmed);
    const keys = Object.keys(parsed);
    const toolKeys = new Set([
      "search_query",
      "image_query",
      "open",
      "click",
      "find",
      "screenshot",
      "sports",
      "finance",
      "weather",
      "time",
      "response_length"
    ]);

    return keys.some((key) => toolKeys.has(key));
  } catch (_error) {
    return false;
  }
}

function extractAttachmentsFromMessage(message) {
  const results = [];
  const seen = new Set();
  const roots = [
    { value: message?.content, path: ["content"] },
    { value: message?.metadata, path: ["metadata"] },
    { value: message?.attachments, path: ["attachments"] }
  ];

  roots.forEach((root) => {
    collectAttachmentCandidates(root.value, root.path, results, seen, 0);
  });

  return normalizeAttachmentList(results);
}

function collectAttachmentCandidates(value, path, results, seen, depth) {
  if (value == null || depth > 8) {
    return;
  }

  if (typeof value === "string") {
    const fromString = buildAttachmentFromString(value, path);
    if (fromString) {
      pushAttachmentCandidate(fromString, results, seen);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectAttachmentCandidates(item, [...path, String(index)], results, seen, depth + 1);
    });
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const fromObject = buildAttachmentFromObject(value, path);
  if (fromObject) {
    pushAttachmentCandidate(fromObject, results, seen);
  }

  Object.entries(value).forEach(([key, child]) => {
    collectAttachmentCandidates(child, [...path, key], results, seen, depth + 1);
  });
}

function buildAttachmentFromObject(objectValue, path) {
  const pointer =
    stringOrEmpty(objectValue.asset_pointer) ||
    stringOrEmpty(objectValue.assetPointer) ||
    stringOrEmpty(objectValue.file_pointer) ||
    stringOrEmpty(objectValue.filePointer);

  const downloadUrl =
    firstDownloadLikeString([
      objectValue.download_url,
      objectValue.downloadUrl,
      objectValue.url,
      objectValue.href,
      objectValue.link
    ]) || "";

  const fileId =
    stringOrEmpty(objectValue.file_id) ||
    stringOrEmpty(objectValue.fileId) ||
    extractFileIdFromPointer(pointer) ||
    extractFileIdFromDownloadUrl(downloadUrl);

  const name =
    stringOrEmpty(objectValue.file_name) ||
    stringOrEmpty(objectValue.filename) ||
    stringOrEmpty(objectValue.name) ||
    stringOrEmpty(objectValue.title) ||
    "";

  const mimeType =
    stringOrEmpty(objectValue.mime_type) ||
    stringOrEmpty(objectValue.mimeType) ||
    "";

  const sizeBytes = toFiniteNumber(objectValue.size_bytes ?? objectValue.sizeBytes ?? objectValue.size);
  const looksLikeAttachment =
    Boolean(pointer || downloadUrl || fileId) ||
    path.some((segment) => /attachment|asset|file|upload|image/i.test(segment));

  if (!looksLikeAttachment) {
    return null;
  }

  return {
    source: "api",
    sourcePath: path.join("."),
    pointer,
    downloadUrl,
    fileId,
    name,
    mimeType,
    sizeBytes
  };
}

function buildAttachmentFromString(stringValue, path) {
  const trimmed = String(stringValue || "").trim();
  if (!trimmed) {
    return null;
  }

  const looksRelevant = path.some((segment) => /attachment|asset|file|upload|image|url|href|link/i.test(segment));
  const isPointer =
    trimmed.startsWith("sediment://file_") ||
    trimmed.startsWith("file-service://") ||
    trimmed.startsWith("file://");
  const isDownloadLike =
    /^https?:\/\//i.test(trimmed) ||
    /^blob:/i.test(trimmed) ||
    /^data:/i.test(trimmed);

  if (!isPointer && !isDownloadLike && !looksRelevant) {
    return null;
  }

  if (!isPointer && !isDownloadLike) {
    return null;
  }

  return {
    source: "api",
    sourcePath: path.join("."),
    pointer: isPointer ? trimmed : "",
    downloadUrl: isDownloadLike ? trimmed : "",
    fileId: extractFileIdFromPointer(trimmed) || extractFileIdFromDownloadUrl(trimmed),
    name: "",
    mimeType: ""
  };
}

function normalizeAttachmentList(attachments) {
  const seen = new Set();
  const results = [];

  for (const attachment of attachments || []) {
    if (!attachment) {
      continue;
    }

    const normalized = {
      source: attachment.source || "unknown",
      sourcePath: attachment.sourcePath || "",
      role: stringOrEmpty(attachment.role),
      messageIndex: Number.isFinite(Number(attachment.messageIndex)) ? Number(attachment.messageIndex) : null,
      pointer: stringOrEmpty(attachment.pointer),
      fileId: stringOrEmpty(attachment.fileId) || extractFileIdFromPointer(attachment.pointer) || extractFileIdFromDownloadUrl(attachment.downloadUrl),
      name: stringOrEmpty(attachment.name),
      mimeType: stringOrEmpty(attachment.mimeType),
      sizeBytes: toFiniteNumber(attachment.sizeBytes),
      localPath: stringOrEmpty(attachment.localPath),
      downloadStatus: stringOrEmpty(attachment.downloadStatus)
    };

    normalized.downloadUrl = firstDownloadLikeString([attachment.downloadUrl]) || "";
    normalized.downloadCandidates = uniqueDownloadCandidates([
      ...(Array.isArray(attachment.downloadCandidates) ? attachment.downloadCandidates : []),
      normalized.downloadUrl,
      ...buildFallbackAttachmentDownloadCandidates(normalized.fileId)
    ]);

    if (!normalized.pointer && !normalized.downloadUrl && !normalized.fileId) {
      continue;
    }

    if (!normalized.name) {
      normalized.name = buildAttachmentName(normalized);
    }

    const fingerprint = [
      normalized.pointer,
      normalized.downloadUrl,
      normalized.fileId,
      normalized.name
    ].join("|");

    if (seen.has(fingerprint)) {
      continue;
    }

    seen.add(fingerprint);
    results.push(normalized);
  }

  return results;
}

function pushAttachmentCandidate(candidate, results, seen) {
  const normalizedList = normalizeAttachmentList([candidate]);
  normalizedList.forEach((normalized) => {
    const fingerprint = [
      normalized.pointer,
      normalized.downloadUrl,
      normalized.fileId,
      normalized.name
    ].join("|");

    if (seen.has(fingerprint)) {
      return;
    }

    seen.add(fingerprint);
    results.push(normalized);
  });
}

async function exportCurrentChatAttachments(payload) {
  return buildCurrentChatAttachmentBundle(payload);
}

async function exportCurrentChatPackage(payload) {
  ensureZipSupport();

  const preparedPayload = await enrichPayloadAttachmentCandidates(payload);
  const attachmentBundle = await buildCurrentChatAttachmentBundle(preparedPayload);
  const packagedPayload = attachmentBundle.payload;
  const exportStamp = createExportStamp();
  const zip = new globalThis.JSZip();
  const assetLookup = buildPackagedAssetLookup(attachmentBundle.assets);

  zip.file(
    buildConversationFilename(packagedPayload, "md", exportStamp),
    buildConversationMarkdown(packagedPayload, assetLookup)
  );
  zip.file(
    buildConversationFilename(packagedPayload, "html", exportStamp),
    buildConversationHtml(packagedPayload, assetLookup)
  );
  zip.file(
    buildConversationFilename(packagedPayload, "json", exportStamp),
    JSON.stringify(packagedPayload, null, 2)
  );

  if (attachmentBundle.totalCount > 0) {
    zip.file(
      buildConversationExtraFilename(packagedPayload, "attachments", "json", exportStamp),
      JSON.stringify(attachmentBundle.manifest, null, 2)
    );
  }

  attachmentBundle.assets.forEach((asset) => {
    zip.file(asset.localPath, asset.bytes);
  });

  const zipFileName = buildConversationFilename(packagedPayload, "zip", exportStamp);
  const zipBlob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: {
      level: 6
    }
  });

  downloadBlob(zipFileName, zipBlob, "application/zip");

  return {
    totalCount: attachmentBundle.totalCount,
    downloadableCount: attachmentBundle.downloadableCount,
    downloadedCount: attachmentBundle.downloadedCount,
    zipFileName
  };
}

async function buildCurrentChatAttachmentBundle(payload) {
  const flattened = flattenPayloadAttachments(payload);
  const downloadable = flattened.filter((attachment) => isDownloadableAttachment(attachment));

  if (!flattened.length) {
    return {
      payload,
      manifest: buildCurrentChatAttachmentManifest(payload, []),
      assets: [],
      totalCount: 0,
      downloadableCount: 0,
      downloadedCount: 0
    };
  }

  const assets = await downloadAttachmentsForPackage(flattened);
  const assetPathMap = new Map(assets.map((asset) => [asset.matchKey, asset]));
  const packagedPayload = applyAttachmentPackageAssets(payload, assetPathMap);
  const packagedAttachments = flattenPayloadAttachments(packagedPayload);

  return {
    payload: packagedPayload,
    manifest: buildCurrentChatAttachmentManifest(packagedPayload, packagedAttachments),
    assets,
    totalCount: packagedAttachments.length,
    downloadableCount: downloadable.length,
    downloadedCount: assets.length
  };
}

function buildCurrentChatAttachmentManifest(payload, attachments) {
  return {
    exportedAt: new Date().toISOString(),
    conversationId: payload.conversationId,
    conversationTitle: payload.title,
    totalAttachments: attachments.length,
    downloadableCount: attachments.filter((attachment) => isDownloadableAttachment(attachment)).length,
    downloadedCount: attachments.filter((attachment) => attachment.localPath).length,
    attachments
  };
}

async function enrichPayloadAttachmentCandidates(payload) {
  const flattened = flattenPayloadAttachments(payload);
  const enriched = await enrichAttachmentsWithDownloadCandidates(flattened);
  const attachmentsByMessageIndex = groupAttachmentsByMessageIndex(enriched);

  return {
    ...payload,
    messages: (payload.messages || []).map((message) => ({
      ...message,
      attachments: normalizeAttachmentList(attachmentsByMessageIndex.get(message.index) || [])
    }))
  };
}

function flattenPayloadAttachments(payload) {
  return (payload.messages || []).flatMap((message) =>
    normalizeAttachmentList(message.attachments || []).map((attachment) => ({
      ...attachment,
      messageIndex: message.index,
      role: message.role
    }))
  );
}

function groupAttachmentsByMessageIndex(attachments) {
  const grouped = new Map();

  (attachments || []).forEach((attachment) => {
    const messageIndex = Number.isFinite(Number(attachment?.messageIndex))
      ? Number(attachment.messageIndex)
      : null;
    if (!messageIndex) {
      return;
    }

    const existing = grouped.get(messageIndex) || [];
    existing.push(attachment);
    grouped.set(messageIndex, existing);
  });

  return grouped;
}

async function downloadAttachmentsForPackage(attachments) {
  const assets = [];

  await runWithConcurrency(attachments, 3, async (attachment, index) => {
    const asset = await downloadSingleAttachmentAsset(attachment, index + 1);
    if (asset) {
      assets.push(asset);
    }
  });

  return assets.sort((left, right) => left.order - right.order);
}

async function downloadSingleAttachmentAsset(attachment, order) {
  const candidates = uniqueDownloadCandidates([
    getPreferredAttachmentDownloadUrl(attachment),
    ...(Array.isArray(attachment?.downloadCandidates) ? attachment.downloadCandidates : [])
  ]);

  if (!candidates.length) {
    return null;
  }

  try {
    const resource = await bridgeRequest("fetch-binary-resource", {
      url: candidates[0],
      candidates
    });

    const bytes = resource?.bytes;
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) {
      return null;
    }

    const enrichedAttachment = {
      ...attachment,
      mimeType: stringOrEmpty(resource.contentType) || attachment.mimeType,
      name: stringOrEmpty(resource.fileName) || attachment.name
    };

    return {
      order,
      matchKey: buildAttachmentMatchKey(attachment),
      localPath: buildAttachmentLocalPath(enrichedAttachment, order),
      bytes,
      sourceUrl: stringOrEmpty(resource.finalUrl) || candidates[0],
      mimeType: stringOrEmpty(resource.contentType) || attachment.mimeType,
      fileName: stringOrEmpty(resource.fileName) || buildAttachmentName(enrichedAttachment, order)
    };
  } catch (_error) {
    return null;
  }
}

function applyAttachmentPackageAssets(payload, assetPathMap) {
  return {
    ...payload,
    messages: (payload.messages || []).map((message) => ({
      ...message,
      attachments: normalizeAttachmentList((message.attachments || []).map((attachment) => {
        const enrichedAttachment = {
          ...attachment,
          messageIndex: message.index,
          role: message.role
        };
        const asset = assetPathMap.get(buildAttachmentMatchKey(enrichedAttachment));
        if (!asset) {
          return enrichedAttachment;
        }

        return {
          ...enrichedAttachment,
          localPath: asset.localPath,
          downloadStatus: "downloaded",
          mimeType: asset.mimeType || enrichedAttachment.mimeType,
          name: asset.fileName || enrichedAttachment.name,
          downloadUrl: asset.sourceUrl || enrichedAttachment.downloadUrl
        };
      }))
    }))
  };
}

function buildAttachmentMatchKey(attachment) {
  return [
    Number.isFinite(Number(attachment?.messageIndex)) ? Number(attachment.messageIndex) : "",
    stringOrEmpty(attachment?.pointer),
    stringOrEmpty(attachment?.fileId),
    sanitizeFileName(attachment?.name || ""),
    extractFilenameFromUrl(getPreferredAttachmentDownloadUrl(attachment) || "")
  ].join("|");
}

function buildBulkAttachmentArchive(conversations, exportedAt) {
  const attachments = [];

  (conversations || []).forEach((conversation) => {
    (conversation.messages || []).forEach((message) => {
      normalizeAttachmentList(message.attachments || []).forEach((attachment) => {
        attachments.push({
          conversationId: conversation.conversationId,
          conversationTitle: conversation.title,
          messageIndex: message.index,
          role: message.role,
          ...attachment
        });
      });
    });
  });

  return {
    exportedAt,
    workspaceUrl: location.origin,
    totalConversations: (conversations || []).length,
    totalAttachments: attachments.length,
    downloadableCount: attachments.filter((attachment) => isDownloadableAttachment(attachment)).length,
    attachments
  };
}

async function enrichAttachmentsWithDownloadCandidates(attachments) {
  const normalized = normalizeAttachmentList(attachments);
  const unresolvedFileIds = Array.from(
    new Set(
      normalized
        .filter((attachment) => attachment.fileId && !attachment.downloadUrl)
        .map((attachment) => attachment.fileId)
    )
  );

  let resolvedByFileId = {};
  if (unresolvedFileIds.length) {
    try {
      resolvedByFileId = await bridgeRequest("resolve-file-download-urls", {
        fileIds: unresolvedFileIds
      });
    } catch (_error) {
      resolvedByFileId = {};
    }
  }

  return normalizeAttachmentList(
    normalized.map((attachment) => {
      const resolved = attachment.fileId ? resolvedByFileId?.[attachment.fileId] : null;
      return {
        ...attachment,
        downloadCandidates: [
          ...(attachment.downloadCandidates || []),
          ...(Array.isArray(resolved?.candidates) ? resolved.candidates : []),
          resolved?.url || ""
        ]
      };
    })
  );
}

function collectDomAttachments(nodes = Array.from(document.querySelectorAll("main article"))) {
  const results = [];
  const seen = new Set();
  const articles = Array.from(nodes || []);

  articles.forEach((article, articleIndex) => {
    article.querySelectorAll("img").forEach((image, imageIndex) => {
      const src = image.currentSrc || image.src || "";
      const looksDownloadable = /^https?:\/\//i.test(src) || /^blob:/i.test(src) || /^data:/i.test(src);
      const largeEnough =
        Number(image.naturalWidth || image.width || 0) >= 96 ||
        Number(image.naturalHeight || image.height || 0) >= 96;

      if (!looksDownloadable || !largeEnough) {
        return;
      }

      const candidate = normalizeAttachmentList([
        {
          source: "dom",
          sourcePath: `article.${articleIndex}.img.${imageIndex}`,
          downloadUrl: src,
          name: image.getAttribute("alt") || ""
        }
      ])[0];

      if (!candidate) {
        return;
      }

      const fingerprint = `${candidate.downloadUrl}|${candidate.name}`;
      if (seen.has(fingerprint)) {
        return;
      }

      seen.add(fingerprint);
      results.push({
        ...candidate,
        articleIndex
      });
    });

    article.querySelectorAll("a[href]").forEach((anchor, anchorIndex) => {
      const href = anchor.href || "";
      const likelyFile =
        /files\.oaiusercontent\.com/i.test(href) ||
        /\/backend-api\/files\//i.test(href) ||
        /\.(png|jpg|jpeg|gif|webp|pdf|txt|csv|json|zip|docx?|xlsx?|pptx?)($|\?)/i.test(href) ||
        anchor.hasAttribute("download");

      if (!likelyFile) {
        return;
      }

      const candidate = normalizeAttachmentList([
        {
          source: "dom",
          sourcePath: `article.${articleIndex}.a.${anchorIndex}`,
          downloadUrl: href,
          name: anchor.getAttribute("download") || anchor.textContent || ""
        }
      ])[0];

      if (!candidate) {
        return;
      }

      const fingerprint = `${candidate.downloadUrl}|${candidate.name}`;
      if (seen.has(fingerprint)) {
        return;
      }

      seen.add(fingerprint);
      results.push({
        ...candidate,
        articleIndex
      });
    });
  });

  return results;
}

function isDownloadableAttachment(attachment) {
  const url = getPreferredAttachmentDownloadUrl(attachment);
  return /^https?:\/\//i.test(url) || /^blob:/i.test(url) || /^data:/i.test(url);
}

function triggerAttachmentDownload(attachment, index) {
  const href = getPreferredAttachmentDownloadUrl(attachment);
  if (!href) {
    return;
  }

  const filename = buildAttachmentName(attachment, index + 1);

  window.setTimeout(() => {
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, index * 250);
}

function buildAttachmentName(attachment, fallbackIndex = 1) {
  const explicitName = sanitizeFileName(attachment?.name || "");
  if (explicitName) {
    return ensureAttachmentFileExtension(explicitName, attachment);
  }

  const fromUrl = extractFilenameFromUrl(attachment?.downloadUrl || "");
  if (fromUrl) {
    return ensureAttachmentFileExtension(sanitizeFileName(fromUrl), attachment);
  }

  const fileId = stringOrEmpty(attachment?.fileId || extractFileIdFromPointer(attachment?.pointer || ""));
  if (fileId) {
    return ensureAttachmentFileExtension(`attachment-${fileId}`, attachment);
  }

  return ensureAttachmentFileExtension(`attachment-${fallbackIndex}`, attachment);
}

function getPreferredAttachmentDownloadUrl(attachment) {
  return firstDownloadLikeString([
    attachment?.downloadUrl,
    ...(Array.isArray(attachment?.downloadCandidates) ? attachment.downloadCandidates : [])
  ]);
}

function buildAttachmentLocalPath(attachment, fallbackIndex = 1) {
  const messageIndex = Number.isFinite(Number(attachment?.messageIndex))
    ? Number(attachment.messageIndex)
    : fallbackIndex;
  const folder = `assets/message-${String(messageIndex).padStart(3, "0")}-${slugify(attachment?.role || "attachment")}`;
  const fileName = ensureAttachmentFileExtension(buildAttachmentName(attachment, fallbackIndex), attachment);
  return `${folder}/${String(fallbackIndex).padStart(2, "0")}-${fileName}`;
}

function ensureAttachmentFileExtension(fileName, attachment) {
  const safeName = sanitizeFileName(fileName || "");
  if (!safeName) {
    return "attachment.bin";
  }

  if (/\.[a-z0-9]{1,8}$/i.test(safeName)) {
    return safeName;
  }

  const extension = inferAttachmentExtension(attachment);
  return extension ? `${safeName}.${extension}` : safeName;
}

function inferAttachmentExtension(attachment) {
  const mime = String(attachment?.mimeType || "").toLowerCase().split(";")[0].trim();
  const mimeToExtension = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "text/csv": "csv",
    "application/json": "json",
    "application/zip": "zip",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx"
  };

  if (mimeToExtension[mime]) {
    return mimeToExtension[mime];
  }

  const candidates = [
    attachment?.name || "",
    attachment?.downloadUrl || "",
    getPreferredAttachmentDownloadUrl(attachment) || ""
  ];

  for (const candidate of candidates) {
    const match = String(candidate || "").match(/\.([a-z0-9]{1,8})(?:$|\?)/i);
    if (match) {
      return match[1].toLowerCase();
    }
  }

  if (mime.startsWith("image/")) {
    return mime.slice("image/".length) || "png";
  }

  return "";
}

function isLikelyImageAttachment(attachment) {
  const mime = String(attachment?.mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) {
    return true;
  }

  return /\.(png|jpg|jpeg|gif|webp|svg)(?:$|\?)/i.test(
    `${attachment?.name || ""} ${attachment?.downloadUrl || ""} ${attachment?.localPath || ""}`
  );
}

function buildConversationExtraFilename(payload, label, extension, stamp = createExportStamp()) {
  return `${buildConversationFileBase(payload, stamp)}-${label}.${extension}`;
}

function extractFilenameFromUrl(url) {
  if (!url) {
    return "";
  }

  try {
    if (/^data:/i.test(url) || /^blob:/i.test(url)) {
      return "";
    }

    const parsed = new URL(url, location.origin);
    const pathname = parsed.pathname || "";
    const lastSegment = pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(lastSegment);
  } catch (_error) {
    return "";
  }
}

function extractFileIdFromPointer(pointer) {
  const match = String(pointer || "").match(/file[_-][A-Za-z0-9_-]+/);
  return match ? match[0] : "";
}

function extractFileIdFromDownloadUrl(url) {
  const match = String(url || "").match(/file[-_][A-Za-z0-9_-]+/i);
  return match ? match[0] : "";
}

function buildFallbackAttachmentDownloadCandidates(fileId) {
  const normalizedFileId = stringOrEmpty(fileId);
  if (!normalizedFileId) {
    return [];
  }

  const encoded = encodeURIComponent(normalizedFileId);
  return [
    `${location.origin}/backend-api/files/${encoded}/download`,
    `${location.origin}/backend-api/files/${encoded}?download=true`
  ];
}

function uniqueDownloadCandidates(values) {
  const results = [];
  const seen = new Set();

  for (const value of values || []) {
    const candidate = String(value || "").trim();
    if (!candidate) {
      continue;
    }

    if (!/^https?:\/\//i.test(candidate) && !/^blob:/i.test(candidate) && !/^data:/i.test(candidate)) {
      continue;
    }

    if (seen.has(candidate)) {
      continue;
    }

    seen.add(candidate);
    results.push(candidate);
  }

  return results;
}

function firstDownloadLikeString(values) {
  for (const value of values || []) {
    const candidate = String(value || "").trim();
    if (/^https?:\/\//i.test(candidate) || /^blob:/i.test(candidate) || /^data:/i.test(candidate)) {
      return candidate;
    }
  }

  return "";
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toFiniteNumber(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function sanitizeFileName(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function extractTextFromContent(content) {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return normalizeWhitespace(content);
  }

  if (Array.isArray(content)) {
    return normalizeWhitespace(content.map(extractTextFromContent).filter(Boolean).join("\n"));
  }

  if (Array.isArray(content.parts)) {
    return normalizeWhitespace(content.parts.map(extractTextFromContent).filter(Boolean).join("\n"));
  }

  if (typeof content.text === "string") {
    return normalizeWhitespace(content.text);
  }

  if (typeof content.result === "string") {
    return normalizeWhitespace(content.result);
  }

  if (typeof content.content === "string") {
    return normalizeWhitespace(content.content);
  }

  if (typeof content === "object") {
    const flattened = Object.values(content)
      .map(extractTextFromContent)
      .filter(Boolean)
      .join("\n");
    return normalizeWhitespace(flattened);
  }

  return "";
}

function buildDomConversationPayload() {
  const entries = extractDomMessageEntries();
  const attachmentsByArticleIndex = groupAttachmentsByArticleIndex(
    collectDomAttachments(entries.map((entry) => entry.node))
  );
  const messages = entries.map((entry, index) => ({
    index: index + 1,
    role: entry.role,
    text: entry.text,
    attachments: normalizeAttachmentList(attachmentsByArticleIndex.get(entry.articleIndex) || [])
  }));
  const title = getConversationTitle();
  const conversationId = getConversationId() || "current";

  return {
    source: "dom-fallback",
    exportedAt: new Date().toISOString(),
    title,
    url: location.href,
    conversationId,
    messageCount: messages.length,
    messages
  };
}

function extractDomMessages() {
  return extractDomMessageEntries().map((entry, index) => ({
    index: index + 1,
    role: entry.role,
    text: entry.text,
    attachments: []
  }));
}

function extractDomMessageEntries() {
  const nodes = findMessageNodes();
  const fingerprints = new Set();
  const messages = [];

  nodes.forEach((node, index) => {
    const role = inferRole(node, index);
    const text = extractDomMessageText(node);
    const fingerprint = `${role}::${text.slice(0, 300)}`;

    if (!text || fingerprints.has(fingerprint)) {
      return;
    }

    fingerprints.add(fingerprint);
    messages.push({
      role,
      text,
      articleIndex: index,
      node
    });
  });

  return messages;
}

function groupAttachmentsByArticleIndex(attachments) {
  const grouped = new Map();

  (attachments || []).forEach((attachment) => {
    if (!Number.isInteger(attachment?.articleIndex)) {
      return;
    }

    const existing = grouped.get(attachment.articleIndex) || [];
    existing.push(attachment);
    grouped.set(attachment.articleIndex, existing);
  });

  return grouped;
}

function mergeDomRenderDataIntoPayload(payload) {
  if (!payload?.messages?.length) {
    return payload;
  }

  const entries = extractDomMessageEntries();
  if (!entries.length || entries.length !== payload.messages.length) {
    return payload;
  }

  const attachmentsByArticleIndex = groupAttachmentsByArticleIndex(
    collectDomAttachments(entries.map((entry) => entry.node))
  );

  const mergedMessages = payload.messages.map((message, index) => {
    const entry = entries[index];
    if (!entry || entry.role !== message.role) {
      return message;
    }

    const domAttachments = attachmentsByArticleIndex.get(entry.articleIndex) || [];
    const mergedText = choosePreferredExportText(message.text, entry.text);

    if (!domAttachments.length && mergedText === message.text) {
      return message;
    }

    return {
      ...message,
      text: mergedText,
      attachments: normalizeAttachmentList([...(message.attachments || []), ...domAttachments])
    };
  });

  return {
    ...payload,
    messages: mergedMessages
  };
}

function choosePreferredExportText(apiText, domText) {
  const normalizedApi = normalizeWhitespace(apiText || "");
  const normalizedDom = normalizeWhitespace(domText || "");

  if (!normalizedDom) {
    return normalizedApi;
  }

  if (!normalizedApi) {
    return normalizedDom;
  }

  const apiHasLinks = containsExportableLinkText(normalizedApi);
  const domHasLinks = containsExportableLinkText(normalizedDom);

  if (domHasLinks && !apiHasLinks && areCompatibleMessageTexts(normalizedApi, normalizedDom)) {
    return normalizedDom;
  }

  return normalizedApi;
}

function containsExportableLinkText(text) {
  return /\[[^\]]+\]\((?:https?:\/\/|mailto:)/i.test(text) || /https?:\/\/\S+/i.test(text);
}

function areCompatibleMessageTexts(left, right) {
  const normalizedLeft = normalizeComparableMessageText(left);
  const normalizedRight = normalizeComparableMessageText(right);

  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  if (normalizedLeft === normalizedRight) {
    return true;
  }

  const shorter = normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = normalizedLeft.length <= normalizedRight.length ? normalizedRight : normalizedLeft;

  if (shorter.length >= 60 && longer.includes(shorter)) {
    return true;
  }

  const probeLength = Math.min(120, shorter.length);
  return probeLength >= 30 && longer.includes(shorter.slice(0, probeLength));
}

function normalizeComparableMessageText(text) {
  return normalizeWhitespace(text || "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/mailto:\S+/gi, " ")
    .replace(/[`*_>#]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function findMessageNodes() {
  const roleNodes = Array.from(document.querySelectorAll("[data-message-author-role]"))
    .map((node) => node.closest("article") || node);
  const articles = Array.from(document.querySelectorAll("main article"));
  const combined = dedupeNodes([...roleNodes, ...articles]).filter(Boolean);

  if (combined.length) {
    return combined;
  }

  return Array.from(document.querySelectorAll("main section, main div"))
    .filter((node) => (node.innerText || "").trim().length > 80)
    .slice(0, 60);
}

function inferRole(node, index) {
  const directRole =
    node.getAttribute?.("data-message-author-role") ||
    node.querySelector?.("[data-message-author-role]")?.getAttribute("data-message-author-role");

  if (directRole) {
    return normalizeRole(directRole);
  }

  const hint = `${node.getAttribute?.("aria-label") || ""} ${node.innerText || ""}`.toLowerCase();

  if (hint.includes("assistant") || hint.includes("chatgpt")) {
    return "assistant";
  }
  if (hint.includes("user") || hint.includes("you")) {
    return "user";
  }

  return index % 2 === 0 ? "user" : "assistant";
}

function normalizeRole(role) {
  const lowered = String(role || "").toLowerCase();

  if (lowered.includes("assistant") || lowered.includes("chatgpt")) {
    return "assistant";
  }
  if (lowered.includes("user")) {
    return "user";
  }
  if (lowered.includes("tool")) {
    return "tool";
  }

  return lowered || "unknown";
}

function extractDomMessageText(root) {
  const clone = root.cloneNode(true);

  clone
    .querySelectorAll("button, nav, svg, img, form, textarea, input, footer, aside")
    .forEach((node) => node.remove());

  clone.querySelectorAll("pre").forEach((pre) => {
    const code = pre.querySelector("code");
    const language = getLanguageFromCodeBlock(code);
    const text = normalizeLineEndings(pre.innerText || "");
    const replacement = document.createElement("div");
    replacement.textContent = `\n\`\`\`${language}\n${text}\n\`\`\`\n`;
    pre.replaceWith(replacement);
  });

  clone.querySelectorAll("code").forEach((code) => {
    if (code.closest("pre")) {
      return;
    }
    const replacement = document.createElement("span");
    replacement.textContent = `\`${code.innerText || ""}\``;
    code.replaceWith(replacement);
  });

  clone.querySelectorAll("a[href]").forEach((anchor) => {
    if (anchor.closest("pre")) {
      return;
    }

    const href = normalizeExportHref(anchor.getAttribute("href") || anchor.href || "");
    const label = normalizeWhitespace(anchor.innerText || anchor.textContent || "");

    if (!href) {
      return;
    }

    const replacement = document.createElement("span");
    replacement.textContent = label ? `[${label}](${href})` : href;
    anchor.replaceWith(replacement);
  });

  return normalizeWhitespace(clone.innerText || "");
}

function normalizeExportHref(href) {
  const value = String(href || "").trim();
  if (!value) {
    return "";
  }

  try {
    const parsed = new URL(value, location.href);
    if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) {
      return "";
    }
    return parsed.href;
  } catch (_error) {
    return "";
  }
}

function getLanguageFromCodeBlock(code) {
  if (!code) {
    return "";
  }

  const className = code.className || "";
  const match = className.match(/language-([a-z0-9_-]+)/i);
  return match ? match[1] : "";
}

function getConversationId() {
  const match = location.pathname.match(/\/c\/([^/?#]+)/);
  return match ? match[1] : "";
}

function isProjectPage() {
  return /\/project(?:[/?#]|$)/.test(location.pathname);
}

function getConversationTitle() {
  const candidates = [
    document.querySelector("main h1"),
    document.querySelector("h1"),
    document.querySelector("main h2"),
    document.querySelector("header h1")
  ];

  for (const candidate of candidates) {
    const text = normalizeWhitespace(candidate?.textContent || "");
    if (text) {
      return text;
    }
  }

  const fallback = document.title
    .replace(/\s*-\s*ChatGPT.*$/i, "")
    .replace(/\s*\|\s*ChatGPT.*$/i, "");

  return normalizeWhitespace(fallback) || "chatgpt-conversation";
}

function buildConversationUrl(conversationId) {
  return `${location.origin}/c/${conversationId}`;
}

function buildConversationFilename(payload, extension, stamp = createExportStamp()) {
  return `${buildConversationFileBase(payload, stamp)}.${extension}`;
}

function buildConversationFileBase(payload, stamp = createExportStamp()) {
  const title = slugify(payload.title || "chat");
  return `chatgpt-${title}-${payload.conversationId}-${stamp}`;
}

function createExportStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function buildConversationMarkdown(payload, assetLookup = null) {
  const lines = [
    `# ${payload.title}`,
    "",
    "> Note: If local images do not load in your Markdown viewer, open the bundled HTML export or extract the ZIP first.",
    "",
    `- Exported at: ${payload.exportedAt}`,
    `- Source: ${payload.source}`,
    `- URL: ${payload.url}`,
    `- Conversation ID: ${payload.conversationId}`,
    `- Message count: ${payload.messageCount}`,
    ""
  ];

  for (const message of payload.messages) {
    lines.push(`## ${formatRole(message.role)} ${message.index}`);
    lines.push("");
    lines.push(message.text || "_empty_");
    lines.push("");

    const attachmentLines = buildMessageAttachmentMarkdownLines(message.attachments || [], assetLookup);
    if (attachmentLines.length) {
      lines.push(...attachmentLines);
      lines.push("");
    }
  }

  return lines.join("\n");
}

function buildConversationHtml(payload, assetLookup) {
  const sections = (payload.messages || [])
    .map((message) => buildConversationHtmlSection(message, assetLookup))
    .join("\n");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(payload.title || "ChatGPT Export")}</title>`,
    "<style>",
    "body{font-family:Segoe UI,Arial,sans-serif;margin:32px auto;max-width:980px;padding:0 20px;color:#0f172a;background:#f8fafc;line-height:1.6;}",
    "h1,h2{margin:0 0 12px;}",
    ".meta{background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:18px 20px;margin-bottom:24px;}",
    ".message{background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:20px;margin:0 0 18px;box-shadow:0 8px 24px rgba(15,23,42,0.04);}",
    ".message pre{white-space:pre-wrap;word-break:break-word;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;overflow:auto;}",
    ".message p{margin:0 0 12px;}",
    ".attachments{margin-top:16px;padding-top:12px;border-top:1px solid #e2e8f0;}",
    ".attachments ul{margin:8px 0 0 22px;padding:0;}",
    ".attachments li{margin:8px 0;}",
    ".attachment-preview{display:block;max-width:100%;height:auto;margin-top:10px;border:1px solid #cbd5e1;border-radius:10px;background:#ffffff;}",
    ".note{color:#475569;font-size:14px;margin-bottom:16px;}",
    "a{color:#2563eb;text-decoration:none;}a:hover{text-decoration:underline;}",
    "code{font-family:Consolas,Menlo,monospace;background:#eff6ff;border-radius:6px;padding:1px 5px;}",
    "</style>",
    "</head>",
    "<body>",
    `<h1>${escapeHtml(payload.title || "ChatGPT Export")}</h1>`,
    '<div class="meta">',
    '<div class="note">This HTML preview is self-contained and is the safest way to view images when opening an export directly from inside a ZIP file.</div>',
    `<ul><li>Exported at: ${escapeHtml(payload.exportedAt || "")}</li><li>Source: ${escapeHtml(payload.source || "")}</li><li>URL: <a href="${formatHtmlHref(payload.url || "")}">${escapeHtml(payload.url || "")}</a></li><li>Conversation ID: ${escapeHtml(payload.conversationId || "")}</li><li>Message count: ${escapeHtml(String(payload.messageCount || 0))}</li></ul>`,
    "</div>",
    sections,
    "</body>",
    "</html>"
  ].join("\n");
}

function buildConversationHtmlSection(message, assetLookup) {
  const heading = `${formatRole(message.role)} ${message.index}`;
  const bodyHtml = renderConversationMessageTextHtml(message.text || "");
  const attachmentsHtml = buildMessageAttachmentHtml(message.attachments || [], assetLookup);

  return [
    '<section class="message">',
    `<h2>${escapeHtml(heading)}</h2>`,
    bodyHtml || "<p><em>empty</em></p>",
    attachmentsHtml,
    "</section>"
  ].join("\n");
}

function renderConversationMessageTextHtml(text) {
  const value = String(text || "");
  if (!value.trim()) {
    return "";
  }

  const segments = [];
  const parts = value.split(/```/);

  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      segments.push(`<pre>${escapeHtml(part.replace(/^\n+|\n+$/g, ""))}</pre>`);
      return;
    }

    const paragraphs = part
      .split(/\n{2,}/)
      .map((chunk) => chunk.trim())
      .filter(Boolean);

    paragraphs.forEach((paragraph) => {
      segments.push(`<p>${renderInlineConversationHtml(paragraph).replace(/\n/g, "<br>")}</p>`);
    });
  });

  return segments.join("\n");
}

function renderInlineConversationHtml(text) {
  const source = String(text || "");
  let result = "";
  let cursor = 0;
  const markdownLinkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match = markdownLinkPattern.exec(source);

  while (match) {
    result += linkifyPlainText(source.slice(cursor, match.index));
    result += `<a href="${formatHtmlHref(match[2])}">${escapeHtml(match[1])}</a>`;
    cursor = match.index + match[0].length;
    match = markdownLinkPattern.exec(source);
  }

  result += linkifyPlainText(source.slice(cursor));
  return result;
}

function buildMessageAttachmentHtml(attachments, assetLookup) {
  const normalized = normalizeAttachmentList(attachments);
  if (!normalized.length) {
    return "";
  }

  const items = normalized.map((attachment, index) =>
    buildSingleAttachmentHtml(attachment, assetLookup, index + 1)
  );

  return [
    '<div class="attachments">',
    "<strong>Attachments</strong>",
    "<ul>",
    items.join("\n"),
    "</ul>",
    "</div>"
  ].join("\n");
}

function buildSingleAttachmentHtml(attachment, assetLookup, fallbackIndex) {
  const label = buildAttachmentMarkdownLabel(attachment, fallbackIndex);
  const href = resolveAttachmentHtmlHref(attachment, assetLookup);
  const preview = buildAttachmentPreviewHtml(attachment, assetLookup, label);
  const meta = attachment.localPath
    ? ` <code>${escapeHtml(attachment.localPath)}</code>`
    : attachment.pointer
      ? ` <code>${escapeHtml(attachment.pointer)}</code>`
      : attachment.fileId
        ? ` <code>${escapeHtml(attachment.fileId)}</code>`
        : "";

  if (href) {
    return `<li><a href="${href}" target="_blank" rel="noopener">${escapeHtml(label)}</a>${meta}${preview}</li>`;
  }

  return `<li>${escapeHtml(label)}${meta}${preview}</li>`;
}

function buildAttachmentPreviewHtml(attachment, assetLookup, label) {
  if (!isLikelyImageAttachment(attachment)) {
    return "";
  }

  const dataUri = resolveAttachmentPreviewDataUri(attachment, assetLookup);
  if (!dataUri) {
    return "";
  }

  return `<img class="attachment-preview" alt="${escapeHtml(label)}" src="${dataUri}">`;
}

function buildMessageAttachmentMarkdownLines(attachments, assetLookup = null) {
  const normalized = normalizeAttachmentList(attachments);
  if (!normalized.length) {
    return [];
  }

  const lines = ["Attachments:"];
  normalized.forEach((attachment, index) => {
    const label = buildAttachmentMarkdownLabel(attachment, index + 1);
    const localTarget = formatMarkdownLinkTarget(attachment.localPath);
    const preferredUrl = formatMarkdownLinkTarget(getPreferredAttachmentDownloadUrl(attachment));
    const previewTarget = resolveAttachmentMarkdownPreviewTarget(attachment, assetLookup);

    if (localTarget) {
      lines.push(`- [${label}](${localTarget})`);
      if (isLikelyImageAttachment(attachment)) {
        lines.push(`![${label}](${previewTarget || localTarget})`);
      }
    } else if (preferredUrl) {
      lines.push(`- [${label}](${preferredUrl})`);
    } else if (attachment.pointer) {
      lines.push(`- ${label} | ${attachment.pointer}`);
    } else if (attachment.fileId) {
      lines.push(`- ${label} | ${attachment.fileId}`);
    } else {
      lines.push(`- ${label}`);
    }
  });

  return lines;
}

function resolveAttachmentMarkdownPreviewTarget(attachment, assetLookup) {
  if (!isLikelyImageAttachment(attachment)) {
    return "";
  }

  if (attachment?.localPath) {
    const asset = assetLookup?.get(attachment.localPath);
    if (asset?.dataUri) {
      return asset.dataUri;
    }
  }

  return formatMarkdownLinkTarget(attachment.localPath || getPreferredAttachmentDownloadUrl(attachment));
}

function buildAttachmentMarkdownLabel(attachment, fallbackIndex) {
  const preferredName =
    sanitizeFileName(attachment?.name || "") ||
    buildAttachmentName(attachment, fallbackIndex);

  if (attachment?.mimeType) {
    return `${preferredName} (${attachment.mimeType})`;
  }

  return preferredName;
}

function formatMarkdownLinkTarget(value) {
  const target = String(value || "").trim();
  if (!target) {
    return "";
  }

  if (/^data:/i.test(target)) {
    return target;
  }

  if (/^(?:https?:\/\/|mailto:)/i.test(target)) {
    return target.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
  }

  return encodeURI(target)
    .replace(/#/g, "%23")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

function buildPackagedAssetLookup(assets) {
  const lookup = new Map();

  (assets || []).forEach((asset) => {
    lookup.set(asset.localPath, {
      ...asset,
      dataUri: shouldInlineHtmlAsset(asset) ? buildAssetDataUri(asset) : ""
    });
  });

  return lookup;
}

function shouldInlineHtmlAsset(asset) {
  if (!asset) {
    return false;
  }

  if (String(asset.mimeType || "").toLowerCase().startsWith("image/")) {
    return true;
  }

  const bytesLength = asset.bytes instanceof ArrayBuffer ? asset.bytes.byteLength : 0;
  return bytesLength > 0 && bytesLength <= 512 * 1024;
}

function buildAssetDataUri(asset) {
  if (!asset?.bytes || !(asset.bytes instanceof ArrayBuffer)) {
    return "";
  }

  const mimeType = String(asset.mimeType || "").trim() || "application/octet-stream";
  return `data:${mimeType};base64,${arrayBufferToBase64(asset.bytes)}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function resolveAttachmentHtmlHref(attachment, assetLookup) {
  if (attachment?.localPath) {
    const asset = assetLookup?.get(attachment.localPath);
    if (asset?.dataUri) {
      return asset.dataUri;
    }

    return formatHtmlHref(attachment.localPath);
  }

  const remoteTarget = getPreferredAttachmentDownloadUrl(attachment);
  return remoteTarget ? formatHtmlHref(remoteTarget) : "";
}

function resolveAttachmentPreviewDataUri(attachment, assetLookup) {
  if (attachment?.localPath) {
    return assetLookup?.get(attachment.localPath)?.dataUri || "";
  }

  return "";
}

function formatHtmlHref(value) {
  const target = String(value || "").trim();
  if (!target) {
    return "";
  }

  if (/^data:/i.test(target)) {
    return target;
  }

  if (/^(?:https?:\/\/|mailto:)/i.test(target)) {
    return escapeHtmlAttribute(target.replace(/ /g, "%20"));
  }

  return escapeHtmlAttribute(
    encodeURI(target)
      .replace(/#/g, "%23")
      .replace(/\(/g, "%28")
      .replace(/\)/g, "%29")
  );
}

function linkifyPlainText(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(
    /(https?:\/\/[^\s<]+|mailto:[^\s<]+)/gi,
    (match) => `<a href="${formatHtmlHref(match)}">${escapeHtml(match)}</a>`
  );
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value);
}

function buildArchiveIndexMarkdown(archive) {
  const lines = [
    "# ChatGPT Bulk Export Index",
    "",
    `- Exported at: ${archive.exportedAt}`,
    `- Workspace URL: ${archive.workspaceUrl}`,
    `- Conversations exported: ${archive.exportedCount}`,
    `- Failed: ${archive.failedCount}`,
    "",
    "## Conversations",
    ""
  ];

  archive.conversations.forEach((conversation, index) => {
    lines.push(`${index + 1}. ${conversation.title} | ${conversation.conversationId} | ${conversation.messageCount} messages`);
  });

  if (archive.failed.length) {
    lines.push("");
    lines.push("## Failed");
    lines.push("");
    archive.failed.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.title || item.id} | ${item.error}`);
    });
  }

  lines.push("");
  return lines.join("\n");
}

function formatRole(role) {
  switch (role) {
    case "assistant":
      return "Assistant";
    case "user":
      return "User";
    case "tool":
      return "Tool";
    default:
      return "Unknown";
  }
}

function slugify(input) {
  const slug = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug || "chat";
}

function downloadText(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  downloadBlob(filename, blob, mimeType);
}

function downloadBlob(filename, blob, _mimeType) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ensureZipSupport() {
  if (!globalThis.JSZip) {
    throw new Error("JSZip failed to load. Reload the extension and try again.");
  }
}

function bridgeRequest(action, payload = {}) {
  injectBridge();

  return new Promise((resolve, reject) => {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timeoutMs = action === "fetch-binary-resource" ? 120000 : 30000;
    const timeoutId = window.setTimeout(() => {
      pendingBridgeRequests.delete(requestId);
      reject(new Error("Bridge request timed out."));
    }, timeoutMs);

    pendingBridgeRequests.set(requestId, { resolve, reject, timeoutId });
    window.postMessage({ type: BRIDGE_REQUEST_TYPE, requestId, action, payload }, "*");
  });
}

function handleBridgeResponse(event) {
  if (event.source !== window || !event.data || event.data.type !== BRIDGE_RESPONSE_TYPE) {
    return;
  }

  const request = pendingBridgeRequests.get(event.data.requestId);
  if (!request) {
    return;
  }

  pendingBridgeRequests.delete(event.data.requestId);
  clearTimeout(request.timeoutId);

  if (event.data.ok) {
    request.resolve(event.data.result);
  } else {
    request.reject(new Error(event.data.error || "Bridge request failed."));
  }
}

function injectBridge() {
  if (bridgeInjected) {
    return;
  }

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page-bridge.js");
  script.dataset.chatgptBackupBridge = "true";
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
  bridgeInjected = true;
}

function injectToastStyles() {
  if (document.getElementById("chatgpt-backup-extension-style")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "chatgpt-backup-extension-style";
  style.textContent = `
    #${PANEL_ID} {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2147483647;
      width: 188px;
      border-radius: 16px;
      background: rgba(15, 23, 42, 0.94);
      color: #ffffff;
      box-shadow: 0 14px 40px rgba(0, 0, 0, 0.28);
      border: 1px solid rgba(148, 163, 184, 0.18);
      backdrop-filter: blur(8px);
      font: 12px/1.45 "Segoe UI", Arial, sans-serif;
      overflow: hidden;
    }
    #${PANEL_ID}[data-minimized="true"] .chatgpt-backup-extension-body {
      display: none;
    }
    #${PANEL_ID} .chatgpt-backup-extension-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.12);
    }
    #${PANEL_ID} .chatgpt-backup-extension-title {
      font-weight: 600;
      font-size: 12px;
    }
    #${PANEL_ID} .chatgpt-backup-extension-mini {
      border: 0;
      background: transparent;
      color: #cbd5e1;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      padding: 0;
    }
    #${PANEL_ID} .chatgpt-backup-extension-body {
      padding: 10px 12px 12px;
    }
    #${PANEL_ID} .chatgpt-backup-extension-desc {
      margin: 0 0 10px;
      color: #cbd5e1;
      font-size: 11px;
    }
    #${PANEL_ID} .chatgpt-backup-extension-btn {
      width: 100%;
      margin: 0 0 8px;
      padding: 9px 10px;
      border-radius: 10px;
      border: 1px solid rgba(148, 163, 184, 0.18);
      background: rgba(30, 41, 59, 0.92);
      color: #ffffff;
      cursor: pointer;
      font-size: 12px;
      text-align: left;
    }
    #${PANEL_ID} .chatgpt-backup-extension-btn:last-of-type {
      margin-bottom: 0;
    }
    #${PANEL_ID} .chatgpt-backup-extension-btn:hover {
      background: rgba(51, 65, 85, 0.96);
    }
    #${PANEL_ID} .chatgpt-backup-extension-btn:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    #${TOAST_ID} {
      position: fixed;
      right: 16px;
      bottom: 190px;
      z-index: 2147483647;
      max-width: 340px;
      padding: 10px 12px;
      border-radius: 12px;
      background: rgba(15, 23, 42, 0.95);
      color: #ffffff;
      font: 12px/1.45 "Segoe UI", Arial, sans-serif;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
      display: none;
    }
  `;
  document.head.appendChild(style);
}

function injectUiShell() {
  injectToastStyles();

  if (!document.getElementById(TOAST_ID) && document.body) {
    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    document.body.appendChild(toast);
  }
}

function ensureFloatingPanel() {
  if (!document.body) {
    return;
  }

  if (!document.getElementById(PANEL_ID)) {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.dataset.minimized = "false";
    panel.innerHTML = `
      <div class="chatgpt-backup-extension-head">
        <div class="chatgpt-backup-extension-title">Chat Backup</div>
        <button class="chatgpt-backup-extension-mini" type="button" aria-label="Minimize">-</button>
      </div>
      <div class="chatgpt-backup-extension-body">
        <p class="chatgpt-backup-extension-desc">Business 工作区本地备份</p>
        <button class="chatgpt-backup-extension-btn" data-action="export-current" type="button">导出当前聊天</button>
        <button class="chatgpt-backup-extension-btn" data-action="export-all" type="button">导出全部聊天</button>
      </div>
    `;

    panel.querySelector("[data-action='export-current']").addEventListener("click", async () => {
      try {
        await handleAction("export-current");
      } catch (error) {
        showToast(error.message || "Current chat export failed.");
      }
    });

    panel.querySelector("[data-action='export-all']").addEventListener("click", async () => {
      try {
        await handleAction("export-all");
      } catch (error) {
        showToast(error.message || "Bulk export failed.");
      }
    });

    panel.querySelector(".chatgpt-backup-extension-mini").addEventListener("click", () => {
      panel.dataset.minimized = panel.dataset.minimized === "true" ? "false" : "true";
      panel.querySelector(".chatgpt-backup-extension-mini").textContent =
        panel.dataset.minimized === "true" ? "+" : "-";
    });

    document.body.appendChild(panel);
  }

  refreshFloatingPanelState();
}

function refreshFloatingPanelState() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) {
    return;
  }

  const titleNode = panel.querySelector(".chatgpt-backup-extension-title");
  if (titleNode) {
    titleNode.textContent = "Chat Backup";
  }

  const currentButton = panel.querySelector("[data-action='export-current']");
  if (currentButton) {
    currentButton.textContent = "Export current chat";
    currentButton.disabled = actionInFlight;
  }

  const allButton = panel.querySelector("[data-action='export-all']");
  if (allButton) {
    allButton.textContent = "Export all chats";
    allButton.disabled = actionInFlight;
  }

  const description = panel.querySelector(".chatgpt-backup-extension-desc");
  if (!description) {
    return;
  }

  if (actionInFlight) {
    description.textContent = "Export running. Keep this tab open.";
  } else if (!getConversationId()) {
    description.textContent = "Project page detected. Export all works here. Open a thread for current chat export.";
  } else {
    description.textContent = "Current thread and full workspace export are available.";
  }
}

function updatePanelState() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) {
    return;
  }

  panel.querySelectorAll(".chatgpt-backup-extension-btn").forEach((button) => {
    button.disabled = actionInFlight;
  });

  const description = panel.querySelector(".chatgpt-backup-extension-desc");
  if (!description) {
    return;
  }

  if (actionInFlight) {
    description.textContent = "正在导出，请保持此标签页打开";
  } else if (!getConversationId()) {
    description.textContent = "当前是项目页，可导出全部；当前聊天需先点进线程";
  } else {
    description.textContent = "当前线程和全部聊天都可导出";
  }
}

function showToast(message) {
  const toast = document.getElementById(TOAST_ID);
  if (!toast) {
    return;
  }

  toast.textContent = message;
  toast.style.display = "block";

  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => {
    toast.style.display = "none";
  }, 2400);
}

function dedupeNodes(nodes) {
  const seen = new Set();
  const result = [];

  for (const node of nodes) {
    if (!node || seen.has(node)) {
      continue;
    }

    seen.add(node);
    result.push(node);
  }

  return result;
}

function normalizeWhitespace(text) {
  return normalizeLineEndings(String(text || ""))
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeLineEndings(text) {
  return String(text || "").replace(/\r\n/g, "\n");
}
