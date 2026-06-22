import os
import json
import threading
import queue
from difflib import SequenceMatcher
from tkinter import filedialog, messagebox

import customtkinter as ctk
import yt_dlp


# ── CONFIGURATION ────────────────————————————————-----------------------------
OUTPUT_BASE = os.path.abspath(os.path.join(".", "Output"))
SETTINGS_FILE = os.path.join(os.getenv("USERPROFILE", ""), ".ytdl_app_settings.json")

scoring_config = json.loads("""
{
  "music": {
    "blacklist": ["live", "concert", "performance", "stage", "acoustic", "cover", "karaoke"],
    "whitelist": ["official music video", "official video", "music video"]
  }
}
""")


# ── SETTINGS HELPERS ────────────────————————————————---------------- ---------
def load_settings():
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return {"folder": SETTINGS_FILE}


def save_settings(s):
    with open(SETTINGS_FILE, "w") as f:
        json.dump(s, f)


# ── SCORING CORE ────────────────---------------------------------------------
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
        if b in title and len(title.split()) > 3:  # only penal if not a long compound name
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


# ── GUI COMPONENTS ────────────────---------------------------
class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.settings = load_settings()
        os.makedirs(self.settings["folder"], exist_ok=True)
        self.progress_queue = queue.Queue()

        self.title("YT Downloader")
        self.geometry("600x620")
        self._build()
        self._poll_updates()


    def _poll_updates(self):
        while not self.progress_queue.empty():
            message = self.progress_queue.get()
            if message["type"] == "update":
                widget, text, color = message["data"]
                if isinstance(widget, ctk.CTkProgressBar):
                    widget.set(message["pct"])
                else:
                    widget.configure(text=text, text_color=color)
            elif message["type"] == "finish":
                self._complete_operation(message["progress"], widget="m" or "v")

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


    def _send_progress(self, widget, text="", color="#ffffff", pct=None):
        if isinstance(widget, ctk.CTkProgressBar) and pct is None:
            pct = 0
        self.progress_queue.put({"type": "update", "data": (widget, text, color), "pct": pct})

    def _complete_operation(self, progress, widget):
        if isinstance(progress, str):
            os.startfile(progress)
        if widget == "m":
            self._send_progress(self.m_lbl, "Success!", "#2ecc71", 0.95)
        else:
            self._send_progress(self.v_lbl, "Success!", "#2ecc71", 0.95)

    def _perform_download(self, url, mode):
        folder = os.path.join(OUTPUT_BASE, "Music" if mode == "music" else "Videos")
        os.makedirs(folder, exist_ok=True)

        if mode == "music":
            dl_opts = {
                "format": "bestaudio/best",
                "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "320"}],
                "outtmpl": os.path.join(folder, "%(title)s.%(ext)s"),
                "quiet": True,
            }
        else:
            dl_opts = {
                "format": "bestvideo+bestaudio/best",
                "merge_output_format": "mp4",
                "outtmpl": os.path.join(folder, "%(title)s.%(ext)s"),
                "quiet": True,
            }

        with yt_dlp.YoutubeDL(dl_opts) as ydl:
            result = ydl.download([url])
            if isinstance(result, list):
                return result[0] # path to downloaded file
            else:
                os.startfile(folder)


    def _build_music(self):
        tab = self.tabs.tab("MUSIC")
        self.m_artist = ctk.CTkEntry(tab, placeholder_text="Artist")
        self.m_artist.pack()
        self.m_song = ctk.CTkEntry(tab, placeholder_text="Song Name")
        self.m_song.pack()

        self.m_fmt = ctk.CTkSegmentedButton(tab, values=["MP3", "MP4"])
        self.m_fmt.set("MP3")
        self.m_fmt.pack(pady=(10, 5))

        self.m_lbl = ctk.CTkLabel(tab, text="Waiting...")
        self.m_lbl.pack()

        ctk.CTkButton(tab, text="Download", command=lambda: self._start_music()).pack(pady=(10, 5))


    def _build_video(self):
        tab = self.tabs.tab("VIDEO")
        self.v_creator = ctk.CTkEntry(tab, placeholder_text="Creator")
        self.v_creator.pack()
        self.v_title = ctk.CTkEntry(tab, placeholder_text="Title")
        self.v_title.pack()

        self.v_qual = ctk.CTkSegmentedButton(tab, values=["Best", "1080p"], corner_radius=6)
        self.v_qual.set("1080p")
        self.v_qual.pack(pady=(5, 2))

        self.v_lbl = ctk.CTkLabel(tab, text="Waiting...")
        self.v_lbl.pack()

        ctk.CTkButton(tab, text="Download", command=lambda: self._start_video()).pack(pady=(10, 5))


    def _start_music(self):
        artist = self.m_artist.get()
        song = self.m_song.get()
        if not artist or not song:
            messagebox.showerror("Error", "Both fields are required.")
            return

        def worker():
            try:
                results = []
                with yt_dlp.YoutubeDL({"quiet": True, "extract_flat": True}) as ydl:
                    res = ydl.extract_info(f"ytsearch10:{artist} {song}", download=False)
                    entries = res.get("entries") or []

                if not entries:
                    self._send_progress(self.m_lbl, "No matching videos found", "#ef4444", 0)
                    return

                best_tuple = max([(score_music(e, artist, song), e) for e in entries], key=lambda x: x[0])
                best_entry = best_tuple[1]
                self._send_progress(self.m_lbl, "Found match", "#2ecc71", 0.25)

                mode = "music" if "MP3" in self.m_fmt.get() else "video"
                url = f"https://www.youtube.com/watch?v={best_entry['id']}"
                self._perform_download(url, mode)

            except Exception as err:
                messagebox.showerror("Download Error", str(err))
        threading.Thread(target=worker).start()


    def _start_video(self):
        creator = self.v_creator.get()
        title = self.v_title.get()

        def worker():
            try:
                results = []
                with yt_dlp.YoutubeDL({"quiet": True, "extract_flat": True}) as ydl:
                    res = ydl.extract_info(f"ytsearch20:{creator} {title}", download=False)

                if not res.get("entries"):
                    self._send_progress(self.v_lbl, "No matching videos found", "#ef4444", 0)
                    return

                best_tuple = max([(score_video(e, creator, title), e) for e in res.get("entries")], key=lambda x: x[0])
                best_entry = best_tuple[1]
                self._send_progress(self.v_lbl, "Match selected", "#2ecc71", 0.25)

                mode = "video"
                url = f"https://www.youtube.com/watch?v={best_entry['id']}"
                self._perform_download(url, mode)

            except Exception as err:
                messagebox.showerror("Error", str(err))
        threading.Thread(target=worker).start()


if __name__ == "__main__":
    app = App()
    app.mainloop()
