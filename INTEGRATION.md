# Android Integration

The viewer exposes a JavaScript API so Android apps can load trip data directly into the map without manual file upload.

## How it works

1. The Android app opens the viewer URL in a WebView (`https://darknessbot.ried.no/`)
2. After the page finishes loading, the app calls `window.loadDbbFromBase64()` via `evaluateJavascript`
3. The viewer parses the data client-side and displays it on the map

## File formats

- **`.dbb`** — a ZIP archive containing one or more `.csv` files. Each CSV becomes a separate trip on the map.
- **`.csv`** — a single trip log with columns: `Date, Speed, Voltage, Temperature, Battery level, Altitude, Latitude, Longitude, Total mileage`. Both DarknessBot (European date `DD.MM.YYYY HH:mm:ss`) and EUC World (ISO `YYYY-MM-DDTHH:mm:ss`) formats are supported.

## JavaScript API

```javascript
// Load a base64-encoded .dbb or .csv into the viewer
// Returns { success: true } or { success: false, error: "..." }
await window.loadDbbFromBase64(base64String, filename)
```

**Parameters:**
- `base64String` — the file contents encoded as base64 (no line breaks, no data URI prefix)
- `filename` — display name with extension, e.g. `"my_trip.dbb"` or `"ride.csv"`. The extension determines how the file is parsed.

**Behavior when called programmatically:**
- Always replaces any existing tracks (never appends)
- Does not save to recent files or session cache
- Hides the recent files UI

## Android example (Kotlin)

```kotlin
// 1. Convert a CSV or ZIP file to base64
val bytes = file.readBytes()
val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)

// 2. After WebView finishes loading the viewer page
webView.evaluateJavascript(
    "window.loadDbbFromBase64('$base64', '${file.name}')",
    null
)
```

For large files, avoid string concatenation in the JS call. The base64 string is passed inline, so ensure single quotes inside the data are escaped.

## Notes

- The viewer page must fully load before calling the API. Use `WebViewClient.onPageFinished()` with a short delay, and guard against multiple calls (the callback can fire more than once).
- The API is read-only from the viewer's perspective: programmatic loads do not persist to IndexedDB or localStorage, so the user's manual upload history stays clean.
