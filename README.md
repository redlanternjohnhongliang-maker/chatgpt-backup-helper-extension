# ChatGPT Backup Helper

Chrome extension for exporting ChatGPT conversations from a signed-in browser
session.

This project was built for one practical use case:

- keep local backups of important chats
- especially useful when using a shared `Business / Team` workspace
- export both the current thread and the full visible conversation history

This is an unofficial tool. It is not affiliated with OpenAI.

## Features

- Export current chat to `Markdown + JSON`
- Export all chats to `JSON archive + Markdown index`
- Floating in-page backup panel on ChatGPT pages
- Popup action for quick access from the browser toolbar
- Current-chat API export with DOM fallback when needed
- Filters out most internal tool calls and reasoning traces from clean exports

## Why this exists

OpenAI's Help Center currently states:

- personal ChatGPT workspaces can export data from `Settings > Data Controls`
- ChatGPT Business workspaces do not support export
- if personal data is merged into a Business workspace and access is later lost,
  the migrated data is lost with that workspace

That makes local browser-side backup useful for users working inside a shared
workspace.

References:

- https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data
- https://help.openai.com/en/articles/8801890-can-i-migrate-or-merge-my-chatgpt-free-or-plus-workspace-over-to-my-chatgpt-team-workspace

## How it works

The extension runs entirely in the browser:

1. `popup.js` sends commands to the active ChatGPT tab
2. `content.js` manages export flow, UI, and downloads
3. `page-bridge.js` is injected into the page and uses the current logged-in
   same-site session to request conversation data from ChatGPT page endpoints
4. when a current-thread API fetch fails, the extension falls back to DOM-based
   extraction

No separate server is used.

## What gets exported

### Current chat

- one `Markdown` file for readability
- one `JSON` file for structured backup

### All chats

- one full `JSON` archive
- one `Markdown` index file with conversation list

## Current limitations

- this is not an official OpenAI export API
- it depends on ChatGPT's current page structure and internal same-site
  endpoints
- uploaded attachments are not fully downloaded as binary files yet
- if ChatGPT changes its internal page data model, some extraction logic may
  need updating
- keep the ChatGPT tab open while bulk export is running

## Install

1. Open `chrome://extensions` in Chrome or Edge
2. Turn on `Developer mode`
3. Click `Load unpacked`
4. Select this folder:

```text
g:\lianghua\tools\chatgpt_backup_extension
```

5. Reload your ChatGPT tab

## Usage

### Option 1: floating panel

On ChatGPT pages, the extension shows a floating panel in the bottom-right
corner:

- `Export current chat`
- `Export all chats`

### Option 2: browser toolbar popup

Click the extension icon and use the popup buttons:

- `Export Current Chat`
- `Export All Chats`

## Project-page behavior

If you are on a project page like:

```text
https://chatgpt.com/g/.../project
```

then:

- `Export all chats` can still work
- `Export current chat` requires opening a specific thread first

## File structure

- `manifest.json`: extension manifest
- `popup.html`: popup UI
- `popup.css`: popup styles
- `popup.js`: popup action logic
- `content.js`: main export logic, in-page floating panel, downloads
- `page-bridge.js`: same-page bridge for conversation fetches

## Privacy model

- runs locally in your browser
- does not upload chat data to a separate server
- reads content only on `chatgpt.com` and `chat.openai.com`
- generated export files are downloaded directly by the browser

## Roadmap

- attachment/image binary download
- optional raw export mode
- optional zip packaging
- Chrome Web Store packaging polish

## Disclaimer

This tool is provided as-is for local backup convenience. Use it only on
accounts and workspaces you are authorized to access.
