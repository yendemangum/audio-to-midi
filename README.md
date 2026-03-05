# Speech to MIDI

Convert speech audio into a MIDI file that you can import into any DAW. Play the MIDI with a piano (or “tines”) patch to get a high-fidelity **talking piano** effect—the piano “says” what the speaker said.

## How to run

```bash
npm install
npm run dev
```

Open **http://localhost:5173/** in your browser.

## How to use

1. **Import audio** – Drag and drop an audio file (WAV, MP3, OGG, M4A, etc.) or click to browse. Speech or singing both work.
2. **Choose style** (default: **Speaking piano**):
   - **Speaking piano (spectral)** – Multiple piano notes at once, following the full spectrum of the voice so the piano “says” the words (similar to [Peter Ablinger](https://www.youtube.com/watch?v=BBsXovEWBGo) / Chopstix-style talking pianos). Use **Spectral threshold**: lower = denser chords, more speech-like.
   - **Melody (single note)** – One note at a time following the main pitch; simpler, more melodic.
3. **Adjust settings** (optional):
   - **Pitch range (MIDI)** – Lowest and highest MIDI note (default 36–72). For spectral, a wider range (e.g. 28–80) can sound more “word-like.”
   - **Sensitivity / dynamics** – Affects how loud/quiet parts map to velocity.
   - **Spectral threshold** (spectral mode) – Lower = more notes per chord; higher = sparser. (Very low values are capped per frame to keep playback length correct and avoid errors.)
   - **Min note length** and **Pitch smoothing** (melody mode only) – Tune the single-note follow.
   - **Reduce background noise** – High-pass (80 Hz), subtracts a noise profile from the first 0.5 s, and gates quiet frames so hiss and rumble are less likely to become notes.
4. **Convert to MIDI** – Click the button and wait for processing.
5. **Download MIDI file** – Save the `.mid` file and import it into your DAW.

## Using the MIDI in a DAW

- **Import** – Drag the MIDI file onto a track, or use your DAW’s “Import MIDI” (e.g. File → Import → MIDI).
- **Instrument** – Assign a **piano** or **electric piano / tines** patch to that track. Acoustic grand (or similar) gives the clearest “talking” effect.
- **Tuning** – The MIDI is generated at 120 BPM. You can leave it or time-stretch the track to match your project.
- **Editing** – You can edit notes, change velocities, or transpose the MIDI as usual.

## How it works

**Speaking piano (spectral)** – Short overlapping windows are pre-emphasized, then an **FFT** gives the magnitude spectrum and maps it to **MIDI notes** with band aggregation, pre-emphasis, F0 boost, and formant-peak emphasis; the speech band (200–4200 Hz) is weighted. Hop size is 512 samples (coarser resolution) to keep event count safe and avoid call-stack overflow. The piano approximates the spectral shape of speech, giving the “piano saying words” effect similar to [Peter Ablinger’s Speaking Piano](https://www.youtube.com/watch?v=BBsXovEWBGo) or Chopstix-style demos.

**Melody (single note)** – Uses **YIN pitch detection** to track the fundamental frequency (F0), merges consecutive same-pitch segments, and outputs one note at a time with velocity from amplitude.

Both modes write a single-track MIDI file with **Acoustic Grand Piano** (program 0), ready for any DAW.

## Tech

- **Frontend:** HTML, CSS, JavaScript (Vite)
- **Pitch detection:** [pitchfinder](https://github.com/peterkhayes/pitchfinder) (YIN algorithm)
- **MIDI export:** [MidiWriterJS](https://github.com/grimmdude/MidiWriterJS)
- **Audio:** Web Audio API (decode, mono mix, buffer)

No backend or uploads—everything runs in the browser.

## Deploy

The app is static (HTML/JS/CSS). Build once and host the output anywhere.

**Build:**
```bash
npm install
npm run build
```

Output goes to **`dist/`**. Serve that folder as static files.

### Option 1: Vercel
- Push the project to GitHub, then [vercel.com](https://vercel.com) → Import repository.
- Vercel detects Vite; build command `npm run build`, output `dist`. Deploy.
- Or from the repo root: `npx vercel` and follow the prompts.

### Option 2: Netlify
- Push to GitHub, then [netlify.com](https://netlify.com) → Add new site → Import from Git.
- Build command: `npm run build`. Publish directory: `dist`. Deploy.
- Or drag-and-drop the `dist` folder in Netlify’s “Deploy manually” zone.

### Option 3: GitHub Pages
- In the repo: **Settings → Pages → Source**: GitHub Actions (or “Deploy from a branch”; then choose branch and `/dist` if you build on your machine and push `dist`).
- If the site URL will be `https://<user>.github.io/<repo>/`, set the base in `vite.config.js` so assets load:
  ```js
  export default defineConfig({
    base: '/<repo>/',  // e.g. base: '/audio-to-midi/',
    root: '.',
    publicDir: 'public',
  });
  ```
- Then run `npm run build` and push the contents of `dist` to the `gh-pages` branch, or use the [peaceiris/actions-gh-pages](https://github.com/peaceiris/actions-gh-pages) workflow to build and deploy on push.

### Option 4: Any static host
Upload the contents of `dist/` to S3, Cloudflare Pages, Firebase Hosting, or any server that serves static files. No environment variables or server config needed.
