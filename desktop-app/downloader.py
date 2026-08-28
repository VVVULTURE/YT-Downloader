# File: downloader.py
import os
import sys
import json
import threading
import queue
import time # Import time for better thread control/sleep simulation if needed
import urllib.request
import importlib.machinery
from difflib import SequenceMatcher
from tkinter import filedialog, messagebox

import customtkinter as ctk


# ── yt-dlp AUTO-UPDATER ──────────────────────────────────────────────────────
# YouTube changes its internals constantly. A yt-dlp build that is only a few
# weeks old commonly starts failing EVERY download with:
#     ERROR: unable to download video data: HTTP Error 403: Forbidden
# The compiled .exe bundles whatever yt-dlp was current on build day, so it
# goes stale on its own. To stay working with no rebuild, we keep our own copy
# of yt-dlp's official zipapp in %LOCALAPPDATA%\YT-Downloader and refresh it
# from GitHub's "latest release". That cached copy is wired into the import
# system *before* `import yt_dlp` below, so it always wins over any stale
# bundled copy (in the .exe) or older pip install (from source).

_YTDLP_LATEST_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest"
_YTDLP_ZIPAPP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
_YTDLP_RECHECK_SECONDS = 6 * 3600  # ask GitHub for a newer release at most this often


def _ytdlp_cache_dir():
    base = os.getenv("LOCALAPPDATA") or os.path.expanduser("~")
    d = os.path.join(base, "YT-Downloader")
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return d


_YTDLP_CACHE_DIR = _ytdlp_cache_dir()
_YTDLP_ZIPAPP_PATH = os.path.join(_YTDLP_CACHE_DIR, "yt-dlp.pyz")
_YTDLP_VERSION_PATH = os.path.join(_YTDLP_CACHE_DIR, "yt-dlp.version")
_YTDLP_CHECK_PATH = os.path.join(_YTDLP_CACHE_DIR, "yt-dlp.lastcheck")


def _read_text(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


def _write_text(path, text):
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(str(text))
    except Exception:
        pass


def _latest_ytdlp_tag(timeout=10):
    """Latest yt-dlp version string, via the /releases/latest redirect target
    (plain web request, so no GitHub API rate limiting). "" on any failure."""
    try:
        req = urllib.request.Request(
            _YTDLP_LATEST_URL, headers={"User-Agent": "YT-Downloader"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            final_url = resp.geturl()
        if "/tag/" in final_url:
            return final_url.rstrip("/").split("/tag/")[-1]
    except Exception:
        pass
    return ""


def _download_ytdlp_zipapp(timeout=60):
    """Fetch the official yt-dlp zipapp to the cache, atomically."""
    tmp = _YTDLP_ZIPAPP_PATH + ".tmp"
    req = urllib.request.Request(
        _YTDLP_ZIPAPP_URL, headers={"User-Agent": "YT-Downloader"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
    if len(data) < 500_000 or data[:2] not in (b"PK", b"#!"):
        raise RuntimeError("downloaded yt-dlp looks invalid")
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, _YTDLP_ZIPAPP_PATH)


def _refresh_ytdlp(force=False):
    """Update the cached yt-dlp if it is missing or GitHub has a newer release.
    Safe to call from a background thread. Returns True if a new copy landed."""
    have = os.path.isfile(_YTDLP_ZIPAPP_PATH)
    try:
        last_check = float(_read_text(_YTDLP_CHECK_PATH) or 0)
    except ValueError:
        last_check = 0.0

    if have and not force and (time.time() - last_check) < _YTDLP_RECHECK_SECONDS:
        return False

    latest = _latest_ytdlp_tag()
    _write_text(_YTDLP_CHECK_PATH, time.time())
    current = _read_text(_YTDLP_VERSION_PATH)

    if have and latest and latest == current:
        return False
    if not have and not latest:
        return False  # nothing cached and can't reach GitHub — nothing to do

    try:
        _download_ytdlp_zipapp()
        _write_text(_YTDLP_VERSION_PATH, latest or current)
        return True
    except Exception:
        return False


class _YtdlpFromZipapp:
    """Meta-path finder that makes `yt_dlp` (and every `yt_dlp.*` submodule)
    resolve to our downloaded zipapp. Needed because in the PyInstaller build,
    PyInstaller's own frozen importer sits ahead of sys.path and bundles every
    yt_dlp submodule, so it would otherwise keep serving the stale bundled copy
    no matter what we prepend to sys.path. Inserted at the front of
    sys.meta_path so it is consulted before the frozen importer."""

    def __init__(self, zip_path):
        self._paths = [zip_path]

    def find_spec(self, name, path=None, target=None):
        if name == "yt_dlp":
            return importlib.machinery.PathFinder.find_spec("yt_dlp", self._paths, target)
        if name.startswith("yt_dlp."):
            # `path` is the parent package's __path__, already inside the zip.
            return importlib.machinery.PathFinder.find_spec(name, path, target)
        return None


def _bootstrap_ytdlp():
    """Runs before `import yt_dlp`. Points the import system at the cached
    zipapp. Does a one-off blocking download only on first run (nothing cached
    yet), so a stale bundled yt-dlp can't 403 every single download."""
    try:
        if not os.path.isfile(_YTDLP_ZIPAPP_PATH):
            try:
                _download_ytdlp_zipapp(timeout=25)
                _write_text(_YTDLP_CHECK_PATH, time.time())
                _write_text(_YTDLP_VERSION_PATH, _latest_ytdlp_tag())
            except Exception:
                pass  # offline first run — fall back to the bundled copy
        if os.path.isfile(_YTDLP_ZIPAPP_PATH):
            sys.meta_path.insert(0, _YtdlpFromZipapp(_YTDLP_ZIPAPP_PATH))
            sys.path.insert(0, _YTDLP_ZIPAPP_PATH)
    except Exception:
        pass


_bootstrap_ytdlp()

import yt_dlp  # noqa: E402  — must come after _bootstrap_ytdlp()


# ── CONFIGURATION ────────────────────────────────-----------------------------
DEFAULT_MUSIC_DIR = os.path.join(os.path.expanduser("~"), "Music", "YT-Music")
DEFAULT_VIDEO_DIR = os.path.join(os.path.expanduser("~"), "Videos", "YT-Videos")
SETTINGS_FILE = os.path.join(os.getenv("USERPROFILE", os.path.expanduser("~")), ".ytdl_app_settings.json")


def _bundled_ffmpeg_dir():
    """Returns the folder containing bundled ffmpeg.exe/ffprobe.exe when
    running as a compiled PyInstaller exe (built via build_exe.bat), or
    None when running from source — in which case yt-dlp falls back to
    whatever ffmpeg is on the system PATH, same as before."""
    if getattr(sys, "frozen", False):
        base = getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
        candidate = os.path.join(base, "ffmpeg")
        if os.path.isfile(os.path.join(candidate, "ffmpeg.exe")):
            return candidate
    return None


FFMPEG_LOCATION = _bundled_ffmpeg_dir()


def _asset_path(name):
    """Path to a file in assets/, whether running from source or as the
    PyInstaller build (where assets/ is bundled next to the code)."""
    if getattr(sys, "frozen", False):
        base = getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "assets", name)


APP_ICON_ICO = _asset_path("YT-Downloader.ico")
APP_ICON_PNG = _asset_path("YT-Downloader.png")

scoring_config = json.loads("""
{
  "music": {
    "blacklist": ["live", "concert", "performance", "stage", "acoustic", "cover", "karaoke"],
    "whitelist": ["official music video", "official video", "music video"]
  }
}
""")



# ── SETTINGS HELPERS ──────────────────────────────────────────────── ---------
def load_settings():
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r") as f:
                data = json.load(f)
            if "music_folder" in data and "video_folder" in data:
                return data
        except Exception:
            pass
    return {"music_folder": DEFAULT_MUSIC_DIR, "video_folder": DEFAULT_VIDEO_DIR}


def save_settings(s):
    try:
        with open(SETTINGS_FILE, "w") as f:
            json.dump(s, f)
    except Exception:
        pass


# ── SCORING CORE ────────────────────────────────────────────────-------------
def _sim(a, b):
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()

def score_music(entry, artist, song):
    score = 0.0
    title = (entry["title"] or "").lower()
    channel = (entry["channel"] or entry["uploader"] or "").lower()

    if _sim(song, title) > 0:
        score += int(_sim(song, title) * 40)

    if artist.lower() in channel:
        score += 25
    if "vevo" in channel:
        score += 10

    for b in scoring_config["music"]["blacklist"]:
        if b in title and len(title.split()) > 3:
            score -= 20

    return score


def score_video(entry, creator, title_q):
    score = 15
    channel = (entry["channel"] or entry["uploader"] or "").lower()
    creator = creator.strip().lower()

    if creator in channel:
        score += 30
    title = (entry["title"] or "").lower()
    score += int(_sim(title_q, title) * 45)
    return score


# ── GUI COMPONENTS ────────────────────────────────-----------
class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.settings = load_settings()
        self.music_folder_var = ctk.StringVar(value=self.settings.get("music_folder", DEFAULT_MUSIC_DIR))
        self.video_folder_var = ctk.StringVar(value=self.settings.get("video_folder", DEFAULT_VIDEO_DIR))
        os.makedirs(self.music_folder_var.get(), exist_ok=True)
        os.makedirs(self.video_folder_var.get(), exist_ok=True)
        self.progress_queue = queue.Queue()

        self.title("YT Downloader")
        self.geometry("660x900")
        self._apply_icon()
        self._build()
        self._poll_updates()

        # Keep yt-dlp current in the background so YouTube changes don't break
        # downloads. A newer copy is picked up on the next launch.
        threading.Thread(target=self._background_ytdlp_refresh, daemon=True).start()


    def _apply_icon(self):
        """Set the window / taskbar icon from assets/. The multi-size .ico via
        iconbitmap is what Windows actually uses; the PhotoImage fallback covers
        other platforms / the Alt-Tab switcher."""
        try:
            if os.path.isfile(APP_ICON_ICO):
                self.iconbitmap(APP_ICON_ICO)
        except Exception:
            pass
        try:
            if os.path.isfile(APP_ICON_PNG):
                import tkinter as tk
                img = tk.PhotoImage(file=APP_ICON_PNG)
                # 1024px source -> ~64px is plenty for a window icon
                factor = max(1, img.width() // 64)
                if factor > 1:
                    img = img.subsample(factor, factor)
                self._icon_photo = img  # keep a reference so Tk doesn't GC it
                self.iconphoto(True, img)
        except Exception:
            pass


    def _background_ytdlp_refresh(self):
        try:
            if _refresh_ytdlp():
                self._send_progress(
                    None,
                    "Downloader core updated — restart the app to apply.",
                    "#9aa0a6",
                )
        except Exception:
            pass


    def _poll_updates(self):
        while not self.progress_queue.empty():
            message = self.progress_queue.get()
            if message["type"] == "update":
                widget, text, color = message["data"]

                # Defensive check against None widget (Fix applied here)
                if widget is None:
                    continue

                try:
                    if isinstance(widget, ctk.CTkProgressBar):
                        widget.set(message["pct"])
                    else:
                        widget.configure(text=text, text_color=color)
                except AttributeError as e:
                    print(f"Caught internal error during update poll: {e}") # Log the error instead of crashing

            elif message["type"] == "finish":
                self._complete_operation(message["progress"], widget="m" or "v")

        # Schedule the next check
        self.after(100, self._poll_updates)


    def _build(self):
        bar = ctk.CTkFrame(self, height=52, corner_radius=0)
        bar.pack(fill="x")

        ctk.CTkLabel(bar, text="YT Downloader", font=("Segoe UI", 16, "bold")).pack(side="left", padx=15)

        self.tabs = ctk.CTkTabview(self, corner_radius=10)
        self.tabs.pack(fill="both", expand=True, padx=20, pady=10)
        self.tabs.add("MUSIC")
        self.tabs.add("VIDEO")

        self._build_music()
        self._build_video()
        self._build_folder_settings()


    def _build_folder_settings(self):
        """Two output-folder pickers shown below the tabs/download buttons,
        one for Music downloads and one for Video downloads."""
        frame = ctk.CTkFrame(self, corner_radius=10)
        frame.pack(fill="x", padx=20, pady=(0, 15))
        frame.grid_columnconfigure(0, weight=1)

        # Video Output Folder
        ctk.CTkLabel(frame, text="Video Output Folder:", font=("Segoe UI", 12, "bold")).grid(
            row=0, column=0, sticky="w", padx=(15, 5), pady=(12, 0))
        ctk.CTkButton(frame, text="Browse", width=70, command=self._browse_video_folder).grid(
            row=0, column=1, padx=(5, 5), pady=(12, 0))
        ctk.CTkButton(frame, text="Open", width=70, command=self._open_video_folder).grid(
            row=0, column=2, padx=(0, 15), pady=(12, 0))
        ctk.CTkLabel(frame, textvariable=self.video_folder_var, text_color="#9aa0a6", anchor="w").grid(
            row=1, column=0, columnspan=3, sticky="w", padx=15, pady=(0, 10))

        # Music Output Folder
        ctk.CTkLabel(frame, text="Music Output Folder:", font=("Segoe UI", 12, "bold")).grid(
            row=2, column=0, sticky="w", padx=(15, 5), pady=(0, 0))
        ctk.CTkButton(frame, text="Browse", width=70, command=self._browse_music_folder).grid(
            row=2, column=1, padx=(5, 5))
        ctk.CTkButton(frame, text="Open", width=70, command=self._open_music_folder).grid(
            row=2, column=2, padx=(0, 15))
        ctk.CTkLabel(frame, textvariable=self.music_folder_var, text_color="#9aa0a6", anchor="w").grid(
            row=3, column=0, columnspan=3, sticky="w", padx=15, pady=(0, 12))


    def _save_folder_settings(self):
        save_settings({
            "music_folder": self.music_folder_var.get(),
            "video_folder": self.video_folder_var.get(),
        })

    def _browse_music_folder(self):
        path = filedialog.askdirectory(initialdir=self.music_folder_var.get() or DEFAULT_MUSIC_DIR)
        if path:
            self.music_folder_var.set(path)
            os.makedirs(path, exist_ok=True)
            self._save_folder_settings()

    def _browse_video_folder(self):
        path = filedialog.askdirectory(initialdir=self.video_folder_var.get() or DEFAULT_VIDEO_DIR)
        if path:
            self.video_folder_var.set(path)
            os.makedirs(path, exist_ok=True)
            self._save_folder_settings()

    def _open_music_folder(self):
        path = self.music_folder_var.get()
        os.makedirs(path, exist_ok=True)
        try:
            os.startfile(path)
        except Exception as e:
            messagebox.showwarning("System Warning", f"Could not open folder (Check permissions?): {e}")

    def _open_video_folder(self):
        path = self.video_folder_var.get()
        os.makedirs(path, exist_ok=True)
        try:
            os.startfile(path)
        except Exception as e:
            messagebox.showwarning("System Warning", f"Could not open folder (Check permissions?): {e}")


    def _send_progress(self, widget, text="", color="#ffffff", pct=None):
        """Sends progress updates to the queue."""
        # Pass None for the widget if it's a general message (like "Starting download...")
        self.progress_queue.put({"type": "update", "data": (widget, text, color), "pct": pct})

    def _complete_operation(self, progress, widget):
        if isinstance(progress, str):
            try:
                os.startfile(progress)
            except Exception as e:
                 messagebox.showwarning("System Warning", f"Could not open folder (Check permissions?): {e}")

        # We use a fixed completion status for better user feedback on successful download/search failure
        success_text = "Download Finished!" if widget == "v" else "Download Finished!"
        self._send_progress(None, success_text, "#2ecc71", 1.0)


    def _perform_download(self, url, mode, download_playlist=False, label=None,
                          audio_kbps=None, video_max_mbps=None):
        """Performs the download for a given URL and mode.

        download_playlist: if False (default), only the single requested
        video/track is downloaded even if the URL is part of a playlist or
        YouTube "radio mix" (list=... param). If True, and the URL is part
        of a playlist, the entire playlist is downloaded.

        label: the status label widget (m_lbl or v_lbl) to update once
        everything for this request has finished downloading.

        audio_kbps: target MP3 bitrate for music downloads (default 320).
        video_max_mbps: cap on video bitrate in Mbit/s for video downloads;
        None means no cap (best available), which is the default.
        """
        folder = self.music_folder_var.get() if mode == "music" else self.video_folder_var.get()
        os.makedirs(folder, exist_ok=True)

        # 1. Define progress hook function
        def progress_hook(d):
            if d['status'] == 'downloading':
                progress = d.get('_percent_str', '0%')
                self._send_progress(None, f"Downloading: {progress}...", "#ffcc00", float("".join(filter(str.isdigit, progress))) / 100)
            elif d['status'] == 'finished':
                 # Trigger a general "downloading" message when done
                self._send_progress(None, f"Post-processing files...", "#ffcc00", 1.0)


        try:
            if mode == "music":
                mp3_quality = str(int(audio_kbps)) if audio_kbps else "320"
                dl_opts = {
                    "format": "bestaudio/best",
                    "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": mp3_quality}],
                    "outtmpl": os.path.join(folder, "%(title)s-%(id)s.%(ext)s"),
                    "quiet": True,
                    "noplaylist": not download_playlist,
                }
            else: # Video mode
                if video_max_mbps:
                    # Cap video bitrate. `vbr`/`tbr` filters are in KBit/s.
                    # Each clause falls back to the next so a video whose
                    # formats don't report a bitrate still downloads.
                    cap = int(float(video_max_mbps) * 1000)
                    video_format = (
                        f"bestvideo[vbr<={cap}]+bestaudio/"
                        f"bestvideo[tbr<={cap}]+bestaudio/"
                        f"best[tbr<={cap}]/"
                        f"bestvideo+bestaudio/best"
                    )
                else:
                    video_format = "bestvideo+bestaudio/best"
                dl_opts = {
                    "format": video_format,
                    "merge_output_format": "mp4",
                    "outtmpl": os.path.join(folder, "%(title)s-%(id)s.%(ext)s"),
                    "quiet": True,
                    "noplaylist": not download_playlist,
                }

            # Point yt-dlp at the bundled ffmpeg when running as the compiled
            # exe, so the app works with no separate ffmpeg install needed.
            if FFMPEG_LOCATION:
                dl_opts["ffmpeg_location"] = FFMPEG_LOCATION

            # Add the progress hook to pass real-time status updates
            dl_opts['progress_hooks'] = [progress_hook]
            dl_opts.setdefault("retries", 5)
            dl_opts.setdefault("fragment_retries", 10)

            # YouTube periodically 403s whichever "player client" yt-dlp picks
            # by default. If that happens, retry the same download forcing a
            # different client before giving up. yt-dlp's own current default
            # order is tried first (client=None).
            client_fallbacks = [None, ["tv"], ["web_safari"], ["ios"], ["android"], ["mweb"]]
            last_err = None
            for client in client_fallbacks:
                opts = dict(dl_opts)
                if client:
                    opts["extractor_args"] = {"youtube": {"player_client": client}}
                try:
                    with yt_dlp.YoutubeDL(opts) as ydl:
                        ydl.download([url])
                    self._send_progress(label, "Finished", "#2ecc71", 1.0)
                    return folder
                except yt_dlp.DownloadError as e:
                    last_err = e
                    msg = str(e).lower()
                    # Only a forbidden / client-ish failure is worth retrying
                    # with another client. A genuinely private/removed video
                    # fails the same way on every client, so we still surface
                    # it after the loop.
                    if "403" in msg or "forbidden" in msg or "player" in msg or "sign in" in msg:
                        continue
                    raise
            raise last_err

        except yt_dlp.DownloadError as e:
            error_text = str(e)
            messagebox.showerror(
                "Download Error",
                "The video or music appears to be unavailable, private, or does not exist.\n\n"
                f"Details:\n{error_text}"
            )
            self._send_progress(label, "ERROR: Content Not Found/Unavailable.", "#ef4444", 0)
            return None
        except Exception as e:
             error_text = str(e)
             messagebox.showerror(
                 "Download Error",
                 "An unexpected system error occurred during download (Check FFmpeg and internet connection).\n\n"
                 f"Details:\n{error_text}"
             )
             self._send_progress(label, "SYSTEM ERROR.", "#ef4444", 0)
             return None


    def _bitrate_slider(self, parent, title, values, default, fmt):
        """A labelled discrete slider. `values` is the ordered list of
        selectable settings, `default` one of them, `fmt` renders one for
        display. Returns a zero-arg callable giving the current selection."""
        wrap = ctk.CTkFrame(parent, fg_color="transparent")
        wrap.pack(fill="x", padx=20, pady=(8, 0))

        ctk.CTkLabel(wrap, text=title, font=("Segoe UI", 12, "bold")).pack(anchor="w")
        value_lbl = ctk.CTkLabel(wrap, text=fmt(default), text_color="#9aa0a6")
        value_lbl.pack(anchor="w")

        state = {"i": values.index(default)}

        def on_move(v):
            state["i"] = int(round(float(v)))
            value_lbl.configure(text=fmt(values[state["i"]]))

        slider = ctk.CTkSlider(
            wrap, from_=0, to=len(values) - 1,
            number_of_steps=len(values) - 1, command=on_move,
        )
        slider.set(state["i"])
        slider.pack(fill="x", pady=(2, 0))

        return lambda: values[state["i"]]


    def _build_music(self):
        tab = self.tabs.tab("MUSIC")

        ctk.CTkLabel(tab, text="YouTube URL / Search Term:").pack(pady=(5, 0))
        self.m_link = ctk.CTkEntry(tab, placeholder_text="Paste YouTube Video URL or 'Artist Song Title'")
        self.m_link.pack(fill='x', padx=20)

        ctk.CTkLabel(tab, text="Artist Name:").pack(pady=(10, 0))
        self.m_artist = ctk.CTkEntry(tab, placeholder_text="Artist")
        self.m_artist.pack(fill='x', padx=20)

        ctk.CTkLabel(tab, text="Song Name:").pack(pady=(5, 0))
        self.m_song = ctk.CTkEntry(tab, placeholder_text="Song Name")
        self.m_song.pack(fill='x', padx=20)

        self.m_fmt = ctk.CTkSegmentedButton(tab, values=["MP3", "MP4"])
        self.m_fmt.set("MP3")
        self.m_fmt.pack(pady=(10, 5))

        # Audio bitrate for MP3 downloads. Default 320 = the previous behaviour.
        self.m_bitrate = self._bitrate_slider(
            tab, "Audio Bitrate (MP3)",
            [128, 160, 192, 256, 320], 320,
            lambda v: f"{v} kbps" + ("  (default)" if v == 320 else ""),
        )

        self.m_playlist_var = ctk.BooleanVar(value=False)
        ctk.CTkCheckBox(
            tab,
            text="If Video has list, Download everything",
            variable=self.m_playlist_var,
            onvalue=True,
            offvalue=False,
        ).pack(pady=(10, 5))

        self.m_lbl = ctk.CTkLabel(tab, text="Waiting for request")
        self.m_lbl.pack()

        ctk.CTkButton(tab, text="Download", command=lambda: self._start_music()).pack(pady=(20, 10))


    def _build_video(self):
        tab = self.tabs.tab("VIDEO")

        ctk.CTkLabel(tab, text="YouTube URL / Search Term:").pack(pady=(5, 0))
        self.v_link = ctk.CTkEntry(tab, placeholder_text="Paste YouTube Video URL or 'Creator Title'")
        self.v_link.pack(fill='x', padx=20)

        ctk.CTkLabel(tab, text="Creator Name:").pack(pady=(10, 0))
        self.v_creator = ctk.CTkEntry(tab, placeholder_text="Creator")
        self.v_creator.pack(fill='x', padx=20)

        ctk.CTkLabel(tab, text="Title:").pack(pady=(5, 0))
        self.v_title = ctk.CTkEntry(tab, placeholder_text="Title")
        self.v_title.pack(fill='x', padx=20)


        self.v_qual = ctk.CTkSegmentedButton(tab, values=["Best", "1080p"], corner_radius=6)
        self.v_qual.set("1080p")
        self.v_qual.pack(pady=(5, 2))

        # Video bitrate cap. "Max" (default) = the previous behaviour: take the
        # best available stream with no bitrate limit.
        self.v_bitrate = self._bitrate_slider(
            tab, "Max Video Bitrate",
            [2, 4, 6, 8, 12, 16, 20, None], None,
            lambda v: "Max — best available  (default)" if v is None else f"≤ {v} Mbps",
        )

        self.v_playlist_var = ctk.BooleanVar(value=False)
        ctk.CTkCheckBox(
            tab,
            text="If Video has list, Download everything",
            variable=self.v_playlist_var,
            onvalue=True,
            offvalue=False,
        ).pack(pady=(10, 5))

        self.v_lbl = ctk.CTkLabel(tab, text="Waiting for request")
        self.v_lbl.pack()

        ctk.CTkButton(tab, text="Download", command=lambda: self._start_video()).pack(pady=(20, 10))


    def _start_music(self):
        artist = self.m_artist.get()
        song = self.m_song.get()
        link = self.m_link.get().strip()

        if not link and not artist and not song:
            messagebox.showerror("Error", "Please provide at least a URL or search terms.")
            return

        audio_kbps = self.m_bitrate()

        def worker():
            try:
                # 1. Link Download (Direct download attempt) - Highest Priority
                if link:
                    url = link
                    mode = "music"
                    self._send_progress(self.m_lbl, f"Attempting direct download from URL...", "#ffcc00", 0)
                    # The progress tracking now happens inside _perform_download
                    return self._perform_download(url, mode, download_playlist=self.m_playlist_var.get(), label=self.m_lbl, audio_kbps=audio_kbps)

                # 2. Search Fallback
                if not artist and not song:
                    messagebox.showerror("Error", "Please enter both Artist and Song Name for search.")
                    return

                # --- Search Phase (Metadata Extraction) ---
                self._send_progress(self.m_lbl, "Searching YouTube...", "#ffcc00", 0)

                with yt_dlp.YoutubeDL({"quiet": True, "extract_flat": True}) as ydl:
                    query = ""
                    if artist and song:
                        query = f"{artist} {song}"
                    elif artist:
                         query = f"'{artist}' official music video"
                    else:
                         query = f"'{song}' song official"

                    res = ydl.extract_info(f"ytsearch10:{query}", download=False)
                    entries = res.get("entries") or []

                if not entries:
                    self._send_progress(self.m_lbl, "No matching videos found via search", "#ef4444", 0)
                    return None # Indicate failure to find content

                best_tuple = max([(score_music(e, artist, song), e) for e in entries], key=lambda x: x[0])
                best_entry = best_tuple[1]
                self._send_progress(self.m_lbl, "Match selected via search", "#2ecc71", 0.25)

                mode = "music" if self.m_fmt.get() == "MP3" else "video"
                url = f"https://www.youtube.com/watch?v={best_entry['id']}"

                # --- Download Phase ---
                return self._perform_download(url, mode, download_playlist=self.m_playlist_var.get(), label=self.m_lbl, audio_kbps=audio_kbps)

            except yt_dlp.DownloadError:
                messagebox.showerror("Download Error", "The searched content appears to be unavailable or does not exist.")
                self._send_progress(self.m_lbl, "ERROR: Content Not Found/Unavailable.", "#ef4444", 0)
            except Exception as err:
                messagebox.showerror("Error", f"An unexpected error occurred: {err}")


        threading.Thread(target=worker).start()


    def _start_video(self):
        creator = self.v_creator.get()
        title = self.v_title.get()
        link = self.v_link.get().strip()

        if not link and not creator and not title:
            messagebox.showerror("Error", "Please provide at least a URL or search terms.")
            return

        video_max_mbps = self.v_bitrate()

        def worker():
            try:
                # 1. Link Download (Direct download attempt) - Highest Priority
                if link:
                    url = link
                    mode = "video"
                    self._send_progress(self.v_lbl, f"Attempting direct download from URL...", "#ffcc00", 0)
                    return self._perform_download(url, mode, download_playlist=self.v_playlist_var.get(), label=self.v_lbl, video_max_mbps=video_max_mbps)

                # 2. Search Fallback
                if not creator and not title:
                    messagebox.showerror("Error", "Please enter both Creator Name and Title for search.")
                    return

                # --- Search Phase (Metadata Extraction) ---
                self._send_progress(self.v_lbl, "Searching YouTube...", "#ffcc00", 0)

                with yt_dlp.YoutubeDL({"quiet": True, "extract_flat": True}) as ydl:
                    query = ""
                    if creator and title:
                        query = f"{creator} {title}"
                    elif creator:
                         query = f"'{creator}' official videos"
                    else:
                         query = f"'{title}' video official"

                    res = ydl.extract_info(f"ytsearch20:{query}", download=False)

                if not res.get("entries"):
                    self._send_progress(self.v_lbl, "No matching videos found via search", "#ef4444", 0)
                    return None

                best_tuple = max([(score_video(e, creator, title), e) for e in res.get("entries")], key=lambda x: x[0])
                best_entry = best_tuple[1]
                self._send_progress(self.v_lbl, "Match selected via search", "#2ecc71", 0.25)

                mode = "video"
                url = f"https://www.youtube.com/watch?v={best_entry['id']}"

                # --- Download Phase ---
                return self._perform_download(url, mode, download_playlist=self.v_playlist_var.get(), label=self.v_lbl, video_max_mbps=video_max_mbps)

            except yt_dlp.DownloadError:
                 messagebox.showerror("Download Error", "The searched content appears to be unavailable or does not exist.")
                 self._send_progress(self.v_lbl, "ERROR: Content Not Found/Unavailable.", "#ef4444", 0)
            except Exception as err:
                messagebox.showerror("Error", f"An unexpected error occurred: {err}")


        threading.Thread(target=worker).start()


if __name__ == "__main__":
    app = App()
    app.mainloop()
