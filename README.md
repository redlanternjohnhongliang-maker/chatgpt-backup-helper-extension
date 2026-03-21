# ChatGPT Backup Helper

Chrome extension for exporting ChatGPT conversations from the browser you are
already signed into.

This project is aimed at one practical problem: keeping your own local backups
when important chats live inside a shared `Business / Team` workspace.

This is an unofficial tool and is not affiliated with OpenAI.

## What it can do

- Export the current chat as a single local package zip with `Markdown + JSON + assets/`
- Use topic-title-based filenames with local export time stamps
- Export all visible conversations as a bulk `JSON archive + Markdown index`
- Export a separate attachment manifest for the current chat
- Build a bulk attachment index for all exported conversations
- Keep attachments attached to their original message positions inside exported
  chat files
- Preserve visible message hyperlinks as clickable absolute links in exported
  Markdown when the page DOM exposes them
- Show a floating export panel directly on ChatGPT pages
- Provide the same actions from the browser toolbar popup
- Filter out most internal tool-call traces and reasoning noise from clean
  exports

## Attachment handling

Attachment export is best effort.

What works today:

- attachment metadata is stored inside each message in exported `JSON`
- exported `Markdown` places attachment references directly under the message
  they came from
- current-chat export writes an extra `attachments.json` manifest
- current-chat export packages downloaded attachment/image binaries into a local
  zip when ChatGPT still exposes retrievable file URLs
- packaged current-chat Markdown rewrites attachment links to local relative
  paths when the files were successfully captured instead of embedding giant
  `data:` URLs
- current-chat export also includes a cleaner self-contained `HTML` reading view
  with a `Print / Save as PDF` button
- the bundled `HTML` view now renders common Markdown structure and LaTeX-style
  formulas more faithfully than the raw Markdown file, with offline KaTeX CSS
  and fonts packaged into the export folder
- current-chat zip now extracts into one top-level folder instead of scattering
  files directly into the destination
- for `file_id` style references, the extension also records fallback download
  candidates from ChatGPT's same-site endpoints
- duplicated attachment metadata and visible image entries are merged when they
  point to the same uploaded file, which keeps exports cleaner

What is still limited:

- some ChatGPT uploads only expose opaque pointers such as `sediment://file_...`
- signed URLs may expire
- bulk export indexes attachment metadata, but it does not mass-download every
  binary asset for every chat
- if ChatGPT changes its internal data model or file endpoints, attachment
  resolution may need an update

## Why this exists

OpenAI's Help Center currently says:

- personal ChatGPT workspaces can export data from `Settings > Data Controls`
- ChatGPT Business workspaces do not support the same export flow
- migrated data can become inaccessible if workspace access is later lost

That makes browser-side local backup useful for people working inside shared
workspaces.

Reference articles:

- https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data
- https://help.openai.com/en/articles/8801890-can-i-migrate-or-merge-my-chatgpt-free-or-plus-workspace-over-to-my-chatgpt-team-workspace

## How it works

1. `popup.js` sends an export command to the active ChatGPT tab
2. `content.js` manages UI, export flow, DOM fallback, and downloads
3. `page-bridge.js` runs in the page context and uses the current signed-in
   same-site session to request conversation data from ChatGPT page endpoints
4. when current-thread API fetching is unavailable, the extension falls back to
   DOM extraction

No external server is used.

## Export outputs

### Current chat

- `<topic title> - <local time>.zip`
- zip contents include:
  - `<topic title> - <local time>.html`
  - `<topic title> - <local time>.md`
  - `<topic title> - <local time>.json`
  - `<topic title> - <local time> - attachments.json`
  - `assets/...`
  - `katex/...`

The bundled `html` file is the cleanest reading view and the easiest way to
save the conversation as PDF from your browser.

### All chats

- `chatgpt-all-conversations-...json`
- `chatgpt-all-conversations-index-...md`
- `chatgpt-all-conversations-attachments-...json`

## Project-page behavior

If you are on a project landing page such as:

```text
https://chatgpt.com/g/.../project
```

then:

- `Export all chats` can still run
- `Export current chat` requires opening a specific thread first

## Install

1. Open `chrome://extensions`
2. Turn on `Developer mode`
3. Click `Load unpacked`
4. Select this folder:

```text
g:\lianghua\tools\chatgpt_backup_extension
```

5. Reload your ChatGPT tab

## Privacy model

- runs locally in your browser
- does not upload your chat data to a separate server
- only requests access to `chatgpt.com` and `chat.openai.com`
- exported files are downloaded directly by the browser

## Packaging

This repository can be loaded unpacked for development, or zipped and used as a
release package for manual installation/testing.

## Files

- `manifest.json`: extension manifest
- `THIRD_PARTY_NOTICES.md`: bundled library notice information
- `vendor/jszip.min.js`: bundled zip library used for current-chat package export
- `vendor/katex.min.js`: bundled math renderer used while generating HTML previews
- `content.js`: export logic, DOM parsing, floating panel, downloads
- `page-bridge.js`: same-page bridge for ChatGPT requests
- `popup.html`: popup UI
- `popup.css`: popup styles
- `popup.js`: popup actions and status text

## License

MIT
