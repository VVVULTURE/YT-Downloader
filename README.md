# YT Downloader Architecture & Usage

## How to Use this App
The application provides two distinct paths for getting content from YouTube:

1.  **Music Tab**: Designed for high-quality audio files. Enter the **Artist** and **Song Name**. If you want a 320kbps MP3, leave it on "MP3" (default); if you want to keep the video with the music track, select "MP4".
2.  **Video Tab**: Designed for general media content. Enter the **YouTube Creator / Channel** and an approximate **Video Title**. Choose your preferred resolution from the quality selector below the title field.

Once both fields are filled, click **Download**. The app will automatically find the best match based on our internal scoring engine; when complete, a success message appears, and the destination folder opens instantly in Windows Explorer.

---

## Architecture Overview
The system is divided into three distinct layers:

-   **Configuration Layer**: All constants are defined at the top — the output directory structure, scoring weights, and curated blacklist/whitelist for music determine how each mode behaves without cluttering the UI logic.
-   **Scoring Engine**: Instead of fragile string matching (which breaks on variations like "artist feat artist"), this layer uses Jaccard similarity to rank results; it heavily penalizes live recordings so that only official studio releases are returned in Music mode.
-   **GUI & Worker Layer**: Built with customtkinter, every network operation runs in a daemon thread; status updates flow through the progress queue rather than direct widget writes, keeping the UI responsive during long downloads.

## System Deep Dive

### Configuration & Defaults
The system uses declarative configuration instead of hardcoded values inside the widgets. The `OUTPUT_BASE` defines where files go — split into `/Music` and `/Videos` directories for clarity. A JSON-based scoring config stores blacklist terms (e.g., "live", "acoustic") used by the engine to filter out undesirable results before they reach the user.

### Heuristic Ranking Engine
Rather than simple substring matches, we use Jaccard similarity on word sets (`_sim`). This allows a query like "Lady Gaga Judas" to match titles containing extra words (e.g., "[OFFICIAL MUSIC VIDEO] JUDAS"). The scoring function applies penalties for blacklist terms and awards points for official markers; this ensures that the highest-ranking result is almost always the studio version, not a fan remake or live performance.

### Async Worker Dispatch
Every download operation runs in a dedicated worker thread to prevent blocking the main loop — long network calls from `yt_dlp` would otherwise freeze the GUI. The grader sends status updates through `progress_queue`; the main loop polls that queue with `.after(100)` and applies those messages directly to the UI widget, ensuring only one thread ever modifies a tkinter element at once.

## Summary of Design Choices
-   **Declarative Config**: All weights and rules are centralized for easy tuning.
-   **Heuristic Ranking**: Jaccard similarity + blacklist/whitelist scoring instead of fragile regex matching.
-   **Threaded Dispatch**: Worker threads handle all I/O; the UI thread only reads from a progress queue.

-   Install fmmpeg if needed here for windows: https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-06-21-13-34/ffmpeg-N-125146-gc6bb22dea0-win64-gpl.zip
