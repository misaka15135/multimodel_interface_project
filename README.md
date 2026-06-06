# Eye Control Chrome Extension

This Chrome extension packages the browser control flow into a loadable extension folder.

## Load it

1. Open `chrome://extensions`
2. Turn on `Developer mode`
3. Click `Load unpacked`
4. Select the folder:

`C:\Users\lp150\Documents\Codex\2026-04-27\https-storage-googleapis-com-mediapipe-models\chrome-extension`

## Use it

1. Click the extension icon
2. Open the control window
3. Start the camera
4. Calibrate
5. Keep the control window visible, then return to the target web page and let the extension control hover, click, and scroll

## Notes

- The extension now vendors the MediaPipe runtime, wasm files, and `face_landmarker.task` model locally.
- Camera startup happens in a regular extension page instead of a sandbox page.
- The control UI opens in a popup window instead of a normal tab so Chrome does not throttle the tracking loop when you switch pages.
- This is suitable for local loading and packaging as an unpacked extension.
