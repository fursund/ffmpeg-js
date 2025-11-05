import { test, expect, Page } from '@playwright/test';

test.describe('FFmpeg Load Debug Test', () => {
  test('load FFmpeg and capture all errors and logs', async ({ browser }) => {
    const page = await browser.newPage();

    // Capture all console messages
    const consoleMessages: Array<{ type: string; text: string }> = [];
    page.on('console', (msg) => {
      consoleMessages.push({ type: msg.type(), text: msg.text() });
    });

    // Capture all errors
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message + '\n' + error.stack);
    });

    // Capture network failures
    const networkFailures: string[] = [];
    page.on('requestfailed', (request) => {
      networkFailures.push(`${request.method()} ${request.url()} - ${request.failure()?.errorText}`);
    });

    await page.goto('http://localhost:5173/');

    // Check if SharedArrayBuffer is available
    const hasSharedArrayBuffer = await page.evaluate(() => {
      return typeof SharedArrayBuffer !== 'undefined';
    });
    console.log(`\n=== SharedArrayBuffer Available: ${hasSharedArrayBuffer} ===`);

    // Wait for FFmpeg to load or timeout
    const loadResult = await page.evaluate(async () => {
      const logs: string[] = [];
      const errors: string[] = [];

      // Capture logs
      const originalLog = console.log;
      const originalError = console.error;
      console.log = (...args: any[]) => {
        logs.push('[LOG] ' + args.map(a => String(a)).join(' '));
        originalLog.apply(console, args);
      };
      console.error = (...args: any[]) => {
        errors.push('[ERROR] ' + args.map(a => String(a)).join(' '));
        originalError.apply(console, args);
      };

      try {
        // Check if ffmpeg exists
        if (typeof (window as any).ffmpeg === 'undefined') {
          return {
            success: false,
            error: 'ffmpeg is not defined on window',
            logs,
            errors,
          };
        }

        const ffmpeg = (window as any).ffmpeg;

        // Wait for ready with timeout
        const ready = await Promise.race([
          new Promise<boolean>((resolve) => {
            if (ffmpeg.isReady) {
              resolve(true);
            } else {
              ffmpeg.whenReady(() => resolve(true));
            }
          }),
          new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(false), 15000);
          }),
        ]);

        if (!ready) {
          return {
            success: false,
            error: 'Timeout waiting for FFmpeg to be ready',
            isReady: ffmpeg.isReady,
            logs,
            errors,
          };
        }

        // Try a simple exec
        try {
          await ffmpeg.exec(['-version']);
        } catch (execError: any) {
          return {
            success: false,
            error: 'Exec failed: ' + (execError?.message || String(execError)),
            errorStack: execError?.stack,
            isReady: ffmpeg.isReady,
            logs,
            errors,
          };
        }
        
        // Try a more complex exec that would use threading
        try {
          // First fetch and write the input file
          const response = await fetch('http://localhost:5173/samples/audio.ogg');
          const blob = await response.blob();
          await ffmpeg.writeFile('input.ogg', blob);
          
          // Then execute FFmpeg
          await ffmpeg.exec(['-i', 'input.ogg', '-f', 'wav', 'output.wav']);
        } catch (execError: any) {
          return {
            success: false,
            error: 'Complex exec failed: ' + (execError?.message || String(execError)),
            errorStack: execError?.stack,
            isReady: ffmpeg.isReady,
            logs,
            errors,
          };
        }

        return {
          success: true,
          isReady: ffmpeg.isReady,
          logs,
          errors,
        };
      } catch (error: any) {
        return {
          success: false,
          error: error?.message || String(error),
          logs,
          errors,
        };
      }
    });

    // Output all captured information
    console.log('\n=== CONSOLE MESSAGES ===');
    consoleMessages.forEach((msg) => {
      console.log(`[${msg.type}] ${msg.text}`);
    });

    console.log('\n=== PAGE ERRORS ===');
    errors.forEach((err) => {
      console.log(err);
    });

    console.log('\n=== NETWORK FAILURES ===');
    networkFailures.forEach((fail) => {
      console.log(fail);
    });

    console.log('\n=== LOAD RESULT ===');
    console.log(JSON.stringify(loadResult, null, 2));
    
    if (loadResult.errorStack) {
      console.log('\n=== ERROR STACK ===');
      console.log(loadResult.errorStack);
    }

    // Output logs and errors from the page
    if (loadResult.logs && loadResult.logs.length > 0) {
      console.log('\n=== PAGE LOGS ===');
      loadResult.logs.forEach((log) => console.log(log));
    }

    if (loadResult.errors && loadResult.errors.length > 0) {
      console.log('\n=== PAGE ERRORS (from eval) ===');
      loadResult.errors.forEach((err) => console.log(err));
    }

    // Fail the test if loading failed
    expect(loadResult.success).toBe(true);

    await page.close();
  });
});
