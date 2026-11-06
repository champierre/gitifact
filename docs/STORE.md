# Chrome Web Store checklist

## 1. Package

```sh
npm ci
npm test && npm run build && npm run test:e2e
npm run zip            # → gitifact-<version>.zip (contents of dist/)
```

Bump `version` in `package.json` first; the build copies it into `manifest.json`.

## 2. Developer dashboard

1. Register at <https://chrome.google.com/webstore/devconsole> (one-time fee).
2. **New item** → upload the zip.
3. Fill in the listing (suggested text below) and upload:
   - icon: `public/icons/icon-128.png`
   - screenshots (1280×800 or 640×400): crop from `docs/screenshots/*.png` or regenerate with
     `SCREENSHOTS=1 npx playwright test screenshots`
   - small promo tile 440×280 (optional)

### Listing text

- **Name**: Gitifact
- **Summary** (132 chars max): Turn GitHub HTML files into live artifacts. Preview HTML on GitHub without deploying.
- **Description**:

  > Gitifact adds a "Preview" tab to HTML files on GitHub. Click it to see the file rendered as a real
  > web page, right inside GitHub — no download, no GitHub Pages deployment.
  >
  > • Resolves relative CSS, images, fonts and scripts from the same repository and ref
  > • Works with branches (including names containing "/"), tags and commits
  > • Runs the page's JavaScript and loads CDN resources, so interactive pages just work
  > • Rendering happens in a sandboxed frame with a strict Content Security Policy
  > • Resizable height, reload, open in a new tab
  > • Matches GitHub's light and dark themes
  >
  > Works with private repositories when you are signed in to GitHub. Source: https://github.com/champierre/gitifact

- **Category**: Developer Tools
- **Language**: English

## 3. Privacy tab

- **Single purpose**: Preview HTML files stored in GitHub repositories inside the GitHub UI.
- **Permission justifications**:
  - `host_permissions: https://raw.githubusercontent.com/*` — fetches the HTML file and the CSS,
    JavaScript, image and font files it references, from the public raw-content host, without
    credentials.
  - `host_permissions: https://github.com/*` — for private repositories, fetches the same files via
    `github.com/{owner}/{repo}/raw/…` using the user's existing GitHub session, so that no access
    token has to be entered or stored.
  - Content script on `https://github.com/*` — adds the Preview tab to file pages and embeds the
    preview. It reads only the page URL, the branch picker text and the page title to determine the
    repository, ref and path.
  - No `storage`, `tabs`, `scripting`, `cookies` or other permissions are requested.
- **Remote code**: No. All code ships in the package; repository scripts run only inside a sandboxed
  frame with an opaque origin, isolated from GitHub and from the extension.
- **Data usage**: The extension does not collect, transmit or store any user data. Requests go only to
  `raw.githubusercontent.com` for files the user explicitly previews. The height preference is
  stored locally in the extension page's localStorage.
- Certify the data-usage disclosures accordingly (no data collected).

## 4. Privacy policy

Host `docs/PRIVACY.md` (for example via the repository or GitHub Pages) and link it in the listing.

## 5. Review tips

- Mention in the reviewer notes that repository content is rendered in a Manifest V3 sandbox page
  with an opaque origin and a strict Content Security Policy.
- Provide a test URL: <https://github.com/mdn/beginner-html-site-styled/blob/main/index.html>.
- Keep `minimum_chrome_version` (120) in sync with the esbuild `target`.
