# Programmatic Integration

The viewer exposes a JavaScript API so any app or page can load trip data directly into the map without manual file upload. This works from Android WebViews, iOS WKWebView, Electron, iframes, or any context where you control a browser instance.

## How it works

1. Open the viewer URL with `?embedded` (`https://darknessbot.ried.no/?embedded`)
2. The `?embedded` parameter hides the upload UI immediately — no flash of the file picker
3. After the page finishes loading, call `window.loadDbbFromBase64()` to inject trip data
4. The viewer parses the data client-side and displays it on the map

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

**Behavior:**
- Always replaces any existing tracks (never appends)
- Does not save to recent files or session cache

## Embedded mode (`?embedded`)

Adding `?embedded` to the URL puts the viewer in embedded mode:
- The upload overlay (file picker, drag-drop, recent files) is hidden on load
- The page shows only the map, ready to receive data via `loadDbbFromBase64()`
- Normal browser usage (without `?embedded`) is unaffected

## Examples

### Android (Kotlin)

```kotlin
val bytes = file.readBytes()
val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)

// After WebView finishes loading the viewer page
webView.evaluateJavascript(
    "window.loadDbbFromBase64('$base64', '${file.name}')", null
)
```

### iOS (Swift)

```swift
let base64 = fileData.base64EncodedString()
webView.evaluateJavaScript(
    "window.loadDbbFromBase64('\(base64)', '\(fileName)')"
)
```

### iframe / browser

```javascript
const iframe = document.getElementById("viewer");
iframe.contentWindow.loadDbbFromBase64(base64String, "trip.dbb");
```

For large files, the base64 string is passed inline — ensure single quotes inside the data are escaped.

## Notes

- The viewer page must fully load before calling the API. In a WebView, use the page-loaded callback with a short delay, and guard against multiple calls (the callback can fire more than once).
- Programmatic loads do not persist to IndexedDB or localStorage, so the user's manual upload history stays clean.
