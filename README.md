# QIF to OFX

A static web page that converts QIF bank statements (for example Wise exports) to OFX 1.0.2.
The conversion runs in the browser. Files are not uploaded anywhere.

## Features

- Reads `!Type:Bank` and `!Type:CCard` QIF files. Skips `!Account` blocks.
- Detects the date order (day/month or month/day). The default is day first when every date is ambiguous.
- Reads amounts such as `-12.50`, `1,250.00` and `1.250,00`.
- Makes a stable transaction ID (FITID) from date, amount, payee and memo. Importing the same file twice gives no duplicates. Identical transactions on the same day stay separate.
- Options: currency, account type, date format, account ID, closing balance.

## Run locally

```bash
npm start
```

Then open the URL that the command prints. Any static file server works. ES modules do not load from `file://`.

## Test

```bash
npm test
```

## Deploy to GitHub Pages

1. Push this repository to GitHub, on the `main` branch.
2. In the repository, open **Settings → Pages**.
3. Set **Source** to **GitHub Actions**.
4. Push to `main`. The workflow in `.github/workflows/pages.yml` runs the tests and publishes the `site/` folder.

The page is then at `https://<user>.github.io/<repository>/`.

## Layout

| Path | Content |
| --- | --- |
| `site/qif2ofx.js` | Converter (pure functions, no DOM) |
| `site/app.js` | Browser UI |
| `site/index.html`, `site/style.css` | Page and styles |
| `test/` | Node tests and a sample Wise QIF |
