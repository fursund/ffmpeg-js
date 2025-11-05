# Testing ffmpeg.wasm 0.12 Compatibility

## Quick Test

### 1. Start the Dev Server

```bash
npm run dev
```

This starts Vite on `http://localhost:5173` with the required CORS headers for SharedArrayBuffer.

### 2. Run Automated Tests

In a separate terminal:

```bash
npm test
```

This runs Playwright tests that will:
- Load FFmpeg from `public/ffmpeg-core.js`
- Test basic functionality
- Verify exec commands work
- Test file operations

### 3. Manual Browser Testing (Recommended for Threading Tests)

**Note:** Some threading operations may fail in Playwright but work in a real browser.

1. Start the dev server: `npm run dev`
2. Open `http://localhost:5173` in Chrome/Edge (SharedArrayBuffer support required)
3. Open the browser console (F12)
4. FFmpeg should be available as `window.ffmpeg`

Try these commands:

```javascript
// Check if FFmpeg is ready
console.log('Ready:', ffmpeg.isReady);

// Wait for ready if needed
await new Promise(resolve => ffmpeg.whenReady(resolve));

// Test version command
await ffmpeg.exec(['-version']);

// Test file operations
const response = await fetch('/samples/audio.ogg');
const blob = await response.blob();
await ffmpeg.writeFile('test.ogg', blob);

// Test a simple conversion (uses threading)
await ffmpeg.exec(['-i', 'test.ogg', '-f', 'wav', 'output.wav']);
const data = ffmpeg.readFile('output.wav');
console.log('Output size:', data.length);
```

**See `BROWSER_TESTING.md` for comprehensive browser testing guide.**

## Testing with GPL-Extended

To test with the GPL-extended build, update `tests/main.ts`:

```typescript
import { FFmpeg } from '../src';

window.ffmpeg = new FFmpeg({ config: 'gpl-extended' });
```

Then restart the dev server and run tests again.

## What to Look For

### ✅ Success Indicators:
- FFmpeg loads without errors
- `ffmpeg.isReady` becomes `true`
- `exec()` commands complete successfully
- No errors about `cwrap` or `proxy_main`
- File operations (writeFile/readFile) work

### ❌ Failure Indicators:
- Errors about `cwrap is not a function`
- Errors about `proxy_main is not defined`
- `Module.exec is not a function`
- FFmpeg fails to initialize
- Commands hang or timeout

## Debug Test

There's a dedicated debug test that captures all errors:

```bash
npx playwright test tests/load-debug.spec.ts --project=chromium
```

This will output detailed logs and errors to help diagnose any issues.

## Verify Core Files

Make sure you have the 0.12 UMD files in `public/`:
- `public/ffmpeg-core.js` (should export `createFFmpegCore`)
- `public/ffmpeg-core.wasm`
- `public/ffmpeg-core.worker.js`

You can verify the core exports by checking the console:

```javascript
// In browser console after loading
console.log(typeof createFFmpegCore); // Should be 'function'
```

