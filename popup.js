"use strict";

const statusNode = document.getElementById("status");
const currentButton = document.getElementById("export-current");
const allButton = document.getElementById("export-all");

currentButton.addEventListener("click", () => runAction("export-current"));
allButton.addEventListener("click", () => runAction("export-all"));

async function runAction(action) {
  setBusy(true);
  setStatus(action === "export-current" ? "Exporting current chat..." : "Bulk export started. Keep the ChatGPT tab open.");

  try {
    const tab = await getActiveTab();
    if (!tab?.id) {
      throw new Error("No active tab found.");
    }

    if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || "")) {
      throw new Error("Open a ChatGPT tab first, then run the export.");
    }

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "chatgpt-backup-action",
      action
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Export failed.");
    }

    if (action === "export-current") {
      setStatus(`Done. Downloaded current chat: ${response.result.title}`);
    } else {
      setStatus(`Done. Exported ${response.result.exportedCount} chats.${response.result.failedCount ? ` Failed: ${response.result.failedCount}.` : ""}`);
    }
  } catch (error) {
    setStatus(error.message || "Unexpected error.");
  } finally {
    setBusy(false);
  }
}

function getActiveTab() {
  return chrome.tabs
    .query({ active: true, currentWindow: true })
    .then((tabs) => tabs[0]);
}

function setBusy(isBusy) {
  currentButton.disabled = isBusy;
  allButton.disabled = isBusy;
}

function setStatus(message) {
  statusNode.textContent = message;
}
